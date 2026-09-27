/**
 * Footprints from other tools, squared up for Composer. Pure functions with
 * no DOM or THREE dependency.
 *
 * The Dixon Godot project (dixon_dem) exports a building from its in-game
 * building editor (X) as `{ format: 'dixon-footprint', id, footprint:
 * [[x, z], ...], ground_y_min, height_m, hints }`, in the game's local space
 * (x east, z south, meters). Real footprints are turned to the street grid
 * and traced a degree or two off square; Composer builds rectilinear,
 * axis-aligned ones. So the import turns the outline square to the axes,
 * snaps each edge to the average line of its points, and drops tracing jogs,
 * and records where it came from (`placement`), so the composed building can
 * be put back exactly: game point = center + R(rotation) * Composer point.
 */

/** An edge more than this far off square is not squared up: the footprint is refused. */
export const MAX_SKEW_DEGREES = 5;
/** Tracing jogs shorter than this are dropped. */
export const MIN_EDGE = 0.15;
/** Squaring up that moves a corner further than this is reported. */
export const MAX_SHIFT = 0.3;

const EPSILON = 1e-9;

/**
 * Squares up a traced footprint.
 *
 * @param {Array<[number, number]>} points - the outline, in any winding, closed or not
 * @returns {{ footprint: Array<[number, number]>, rotation: number, center: [number, number], maxShift: number } | { error: string }}
 *   `footprint` in Composer's frame, centered on its centroid; `rotation`
 *   (radians) and `center` take it back to the source's frame.
 */
export function squareFootprint(points) {
  let ring = points.map(([x, z]) => [Number(x), Number(z)]);
  if (ring.length > 1 && distance(ring[0], ring[ring.length - 1]) < EPSILON) {
    ring = ring.slice(0, -1);
  }
  ring = ring.filter((point, i) => distance(point, ring[(i + 1) % ring.length]) > EPSILON);
  if (ring.length < 4) {
    return { error: 'A footprint needs at least four corners.' };
  }

  // the main direction: the length-weighted mean of the edges' directions, modulo a right angle
  let [c4, s4] = [0, 0];
  ring.forEach((point, i) => {
    const next = ring[(i + 1) % ring.length];
    const angle = Math.atan2(next[1] - point[1], next[0] - point[0]);
    const length = distance(point, next);
    c4 += length * Math.cos(4 * angle);
    s4 += length * Math.sin(4 * angle);
  });
  const rotation = Math.atan2(s4, c4) / 4;
  const origin = [ring.reduce((sum, [x]) => sum + x, 0) / ring.length, ring.reduce((sum, [, z]) => sum + z, 0) / ring.length];
  const turned = ring.map((point) => rotate([point[0] - origin[0], point[1] - origin[1]], -rotation));

  // each edge along x or z; refuse one too far off square
  const edges = turned.map((point, i) => {
    const next = turned[(i + 1) % turned.length];
    const [dx, dz] = [next[0] - point[0], next[1] - point[1]];
    const skew = (Math.atan2(Math.min(Math.abs(dx), Math.abs(dz)), Math.max(Math.abs(dx), Math.abs(dz))) * 180) / Math.PI;
    return {
      from: point, to: next, alongX: Math.abs(dx) >= Math.abs(dz), skew, length: Math.hypot(dx, dz),
    };
  });
  const worst = edges.reduce((max, edge) => (edge.length > MIN_EDGE && edge.skew > max.skew ? edge : max), { skew: 0 });
  if (worst.skew > MAX_SKEW_DEGREES) {
    return { error: `The footprint is not right-angled: an edge ${worst.length.toFixed(1)} m long is ${worst.skew.toFixed(1)} degrees off square (at most ${MAX_SKEW_DEGREES}).` };
  }

  // runs of edges along the same axis are one side; each side lies on the
  // length-weighted mean line of its points, and a corner is where two meet
  let runs = mergeRuns(edges.map((edge) => ({
    alongX: edge.alongX,
    // the side's line: z for one along x, x for one along z, weighted by length
    weight: Math.max(edge.length, EPSILON),
    sum: (edge.alongX ? (edge.from[1] + edge.to[1]) / 2 : (edge.from[0] + edge.to[0]) / 2) * Math.max(edge.length, EPSILON),
    points: [edge.from],
  })));
  const cornersOf = (sides) => sides.map((side, i) => {
    const next = sides[(i + 1) % sides.length];
    const line = side.sum / side.weight;
    const nextLine = next.sum / next.weight;
    return side.alongX ? [nextLine, line] : [line, nextLine];
  });
  // drop tracing jogs (short sides), merging the sides either side of each
  for (let guard = 0; guard < 100; guard += 1) {
    const corners = cornersOf(runs);
    const short = runs.findIndex((_, i) => distance(corners[(i + runs.length - 1) % runs.length], corners[i]) < MIN_EDGE);
    if (short < 0 || runs.length <= 4) {
      break;
    }
    const without = runs.filter((_, i) => i !== short);
    runs = mergeRuns(without);
  }
  if (runs.length < 4 || runs.length % 2 !== 0) {
    return { error: 'The footprint could not be squared up.' };
  }
  const squared = cornersOf(runs);
  // how far squaring moved the outline: each traced point from the sides it lies on
  const maxShift = Math.max(...runs.flatMap((side, i) => {
    const line = side.sum / side.weight;
    return side.points.map((point) => Math.abs((side.alongX ? point[1] : point[0]) - line));
  }), ...squared.map((corner) => Math.min(...turned.map((point) => distance(point, corner)))));

  // centered on its centroid, as Composer keeps footprints
  const centroid = polygonCentroid(squared);
  const footprint = squared.map(([x, z]) => [round(x - centroid[0]), round(z - centroid[1])]);
  const back = rotate(centroid, rotation);
  return {
    footprint,
    rotation,
    center: [origin[0] + back[0], origin[1] + back[1]],
    maxShift,
  };
}

/**
 * A Dixon export (see above) as a Composer starting point: the squared
 * footprint, its placement in the game, the settings its hints suggest, and
 * any warnings.
 *
 * @returns {{ footprint, placement, settings: object, warnings: string[] } | { error: string }}
 */
export function importDixonFootprint(payload) {
  if (!payload || payload.format !== 'dixon-footprint' || !Array.isArray(payload.footprint)) {
    return { error: 'Not a footprint exported from the Dixon project.' };
  }
  const squared = squareFootprint(payload.footprint);
  if (squared.error) {
    return { error: `Building ${payload.id}: ${squared.error}` };
  }
  const warnings = [];
  if (squared.maxShift > MAX_SHIFT) {
    warnings.push(`Squaring building ${payload.id} up moved its outline by up to ${squared.maxShift.toFixed(2)} m.`);
  }
  return {
    footprint: squared.footprint,
    placement: {
      source: payload.source ?? 'dixon_dem',
      id: String(payload.id),
      rotation: squared.rotation,
      center: squared.center,
      groundY: Number.isFinite(payload.ground_y_min) ? payload.ground_y_min : null,
    },
    settings: settingsFromHints(payload.hints ?? {}, payload),
    warnings,
  };
}

/**
 * Composer settings the game's building editor fields suggest: storeys (a
 * half is a knee wall), roof type, and wall material.
 */
export function settingsFromHints(hints, payload = {}) {
  const settings = {};
  const storeys = Number(hints.storeys ?? payload.tags?.levels);
  if (storeys > 0) {
    settings.storyCount = Math.max(1, Math.floor(storeys));
    settings.kneeWallHeight = storeys - Math.floor(storeys) >= 0.25 ? 0.9 : undefined;
  }
  const roof = {
    gable: 'gable', hip: 'hip', pyramidal: 'hip', gambrel: 'gambrel', flat_parapet: 'flat', flat: 'flat', mansard: 'mansard',
  }[hints.roof ?? payload.tags?.roof_shape];
  if (roof) {
    settings.roofType = roof;
  }
  const material = {
    clapboard: 'wood', siding: 'wood', wood: 'wood', brick: 'brick', limestone: 'stone', stone: 'stone', stucco: 'stucco',
  }[hints.material ?? payload.tags?.building_material];
  if (material) {
    settings.wallMaterial = material;
  }
  return settings;
}

/** Joins consecutive runs along the same axis (the ring wraps round). */
function mergeRuns(runs) {
  const merged = [];
  runs.forEach((run) => {
    const last = merged[merged.length - 1];
    if (last && last.alongX === run.alongX) {
      last.weight += run.weight;
      last.sum += run.sum;
      last.points.push(...run.points);
    } else {
      merged.push({ ...run, points: [...run.points] });
    }
  });
  if (merged.length > 1 && merged[0].alongX === merged[merged.length - 1].alongX) {
    const last = merged.pop();
    merged[0] = {
      ...merged[0], weight: merged[0].weight + last.weight, sum: merged[0].sum + last.sum, points: [...last.points, ...merged[0].points],
    };
  }
  return merged;
}

function polygonCentroid(polygon) {
  let [area, cx, cz] = [0, 0, 0];
  polygon.forEach(([x, z], i) => {
    const [nx, nz] = polygon[(i + 1) % polygon.length];
    const cross = x * nz - nx * z;
    area += cross;
    cx += (x + nx) * cross;
    cz += (z + nz) * cross;
  });
  return Math.abs(area) < EPSILON ? polygon[0] : [cx / (3 * area), cz / (3 * area)];
}

function rotate([x, z], angle) {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  return [x * c - z * s, x * s + z * c];
}

function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

// footprints are kept to the millimeter
function round(value) {
  return Math.round(value * 1000) / 1000;
}
