/**
 * Footprints from other tools, squared up for Composer. Pure functions with
 * no DOM or THREE dependency.
 *
 * The Dixon Godot project (dixon_dem) exports a building from its in-game
 * building editor (X) as `{ format: 'dixon-footprint', id, footprint:
 * [[x, z], ...], ground_y_min, height_m, hints }`, in the game's local space
 * (x east, z south, meters). Real footprints are turned to the street grid
 * and traced a degree or two off square, and Composer builds along its axes.
 * So the import turns the outline square to the axes, snaps each wall near
 * one to the average line of its points (keeping walls well off square as
 * angled walls, see js/angled-walls.js), and drops tracing jogs, and records
 * where it came from (`placement`), so the composed building can be put back
 * exactly: game point = center + R(rotation) * Composer point.
 */
import { angledWallProblem } from './facade.js';

/** A wall within this of the building's main axes (or within MIN_EDGE of square) is squared to them; one further off is kept angled. */
export const MAX_SKEW_DEGREES = 5;
/** Tracing jogs shorter than this are dropped. */
export const MIN_EDGE = 0.15;
/** Walls along one axis closer than this are one wall line (a trace is not more accurate than this). */
export const ALIGN = 0.3;
/** Squaring up that moves a corner further than this is reported. */
export const MAX_SHIFT = 0.3;

const EPSILON = 1e-9;

/**
 * Squares up a traced footprint. Walls within MAX_SKEW_DEGREES of the
 * building's main axes are squared to them; walls further off are real
 * angled walls (a clipped corner, a wedge-shaped lot) and are kept, each on
 * the line through its traced points.
 *
 * @param {Array<[number, number]>} points - the outline, in any winding, closed or not
 * @returns {{ footprint: Array<[number, number]>, rotation: number, center: [number, number], maxShift: number, angled: number } | { error: string }}
 *   `footprint` in Composer's frame, centered on its centroid; `rotation`
 *   (radians) and `center` take it back to the source's frame; `angled`
 *   counts the angled walls kept.
 */
export function squareFootprint(points) {
  let ring = points.map(([x, z]) => [Number(x), Number(z)]);
  if (ring.length > 1 && distance(ring[0], ring[ring.length - 1]) < EPSILON) {
    ring = ring.slice(0, -1);
  }
  ring = ring.filter((point, i) => distance(point, ring[(i + 1) % ring.length]) > EPSILON);
  if (ring.length < 3) {
    return { error: 'A footprint needs at least three corners.' };
  }

  // the main direction: the length-weighted mean of the walls' directions,
  // modulo a right angle; then again over the walls near it, so that angled
  // walls do not pull it off
  const mainDirection = (weight) => {
    let [c4, s4] = [0, 0];
    ring.forEach((point, i) => {
      const next = ring[(i + 1) % ring.length];
      const angle = Math.atan2(next[1] - point[1], next[0] - point[0]);
      const w = weight(angle) * distance(point, next);
      c4 += w * Math.cos(4 * angle);
      s4 += w * Math.sin(4 * angle);
    });
    return Math.atan2(s4, c4) / 4;
  };
  const rough = mainDirection(() => 1);
  const rotation = mainDirection((angle) => (skewOf(angle - rough) <= MAX_SKEW_DEGREES ? 1 : 0));
  const origin = [ring.reduce((sum, [x]) => sum + x, 0) / ring.length, ring.reduce((sum, [, z]) => sum + z, 0) / ring.length];
  const turned = ring.map((point) => rotate([point[0] - origin[0], point[1] - origin[1]], -rotation));

  // each wall along x, along z, or angled; consecutive walls of one kind
  // (angled ones heading the same way) are one side
  let sides = mergeSides(turned.map((point, i) => {
    const next = turned[(i + 1) % turned.length];
    const [dx, dz] = [next[0] - point[0], next[1] - point[1]];
    const skew = skewOf(Math.atan2(dz, dx));
    // off square by a few degrees, or by only a few centimeters on a short wall
    const square = skew <= MAX_SKEW_DEGREES || Math.min(Math.abs(dx), Math.abs(dz)) <= MIN_EDGE;
    const kind = !square ? 'angled' : Math.abs(dx) >= Math.abs(dz) ? 'x' : 'z';
    return side(kind, [point, next]);
  }));
  // put wall lines traced twice on one line, and drop tracing jogs (short
  // sides, merging the sides either side of each), until nothing changes
  for (let guard = 0; guard < 200; guard += 1) {
    sides = alignSides(sides);
    const corners = cornersOf(sides);
    const short = sides.findIndex((_, i) => distance(corners[(i + sides.length - 1) % sides.length], corners[i]) < MIN_EDGE);
    if (short < 0 || sides.length <= 3) {
      break;
    }
    sides = mergeSides(sides.filter((_, i) => i !== short));
  }
  const squared = cornersOf(sides);
  if (sides.length < 3 || squared.some((corner) => !corner.every(Number.isFinite)) || Math.abs(polygonArea(squared)) < 1) {
    return { error: 'The footprint could not be squared up.' };
  }
  // how far squaring moved the outline: the furthest either outline's
  // corners lie from the other outline
  const maxShift = Math.max(
    ...turned.map((point) => boundaryDistance(point, squared)),
    ...squared.map((corner) => boundaryDistance(corner, turned)),
  );

  // centered on its centroid, as Composer keeps footprints
  const centroid = polygonCentroid(squared);
  const footprint = squared.map(([x, z]) => [round(x - centroid[0]), round(z - centroid[1])]);
  const back = rotate(centroid, rotation);
  return {
    footprint,
    rotation,
    center: [origin[0] + back[0], origin[1] + back[1]],
    maxShift,
    angled: sides.filter((s) => s.kind === 'angled').length,
  };
}

/**
 * Sides along one axis that lie within ALIGN of each other are one wall line
 * traced twice (the two ends of a wall broken by a wing): each group is put
 * on its length-weighted mean line.
 */
function alignSides(sides) {
  const aligned = sides.map((s) => ({ ...s }));
  ['x', 'z'].forEach((kind) => {
    const group = aligned.filter((s) => s.kind === kind).sort((a, b) => a.at - b.at);
    const clusters = [];
    group.forEach((s) => {
      const last = clusters[clusters.length - 1];
      if (last && s.at - last[last.length - 1].at < ALIGN) {
        last.push(s);
      } else {
        clusters.push([s]);
      }
    });
    clusters.filter((cluster) => cluster.length > 1).forEach((cluster) => {
      const weight = (s) => s.points.slice(1).reduce((sum, point, i) => sum + Math.max(distance(s.points[i], point), EPSILON), 0);
      const total = cluster.reduce((sum, s) => sum + weight(s), 0);
      const at = cluster.reduce((sum, s) => sum + s.at * weight(s), 0) / total;
      cluster.forEach((s) => { s.at = at; });
    });
  });
  return aligned;
}

/** How far (degrees) a direction is off the nearer axis. */
function skewOf(angle) {
  const quarter = Math.PI / 2;
  const off = Math.abs(((angle % quarter) + quarter) % quarter);
  return (Math.min(off, quarter - off) * 180) / Math.PI;
}

/**
 * One side of the squared outline: along x (at a z, the length-weighted mean
 * of its walls'), along z (at an x), or angled (the line through its first
 * and last traced points).
 */
function side(kind, points) {
  const walls = points.slice(0, -1).map((point, i) => [point, points[i + 1]]);
  const weight = walls.reduce((sum, [a, b]) => sum + Math.max(distance(a, b), EPSILON), 0);
  const k = kind === 'x' ? 1 : 0;
  const at = kind === 'angled' ? 0 : walls.reduce((sum, [a, b]) => sum + ((a[k] + b[k]) / 2) * Math.max(distance(a, b), EPSILON), 0) / weight;
  const [first, last] = [points[0], points[points.length - 1]];
  return { kind, points, at, from: first, direction: normalize([last[0] - first[0], last[1] - first[1]]) };
}

/** Joins consecutive sides of one kind (angled ones within MAX_SKEW_DEGREES of each other); the ring wraps round. */
function mergeSides(sides) {
  const same = (a, b) => a.kind === b.kind && (a.kind !== 'angled'
    || (Math.acos(Math.min(1, a.direction[0] * b.direction[0] + a.direction[1] * b.direction[1])) * 180) / Math.PI <= MAX_SKEW_DEGREES);
  const join = (a, b) => side(a.kind, [...a.points, ...b.points.slice(1)]);
  const merged = [];
  sides.forEach((s) => {
    const last = merged[merged.length - 1];
    if (last && same(last, s) && samePoint(last.points[last.points.length - 1], s.points[0])) {
      merged[merged.length - 1] = join(last, s);
    } else if (last && same(last, s)) {
      // (a jog between them was dropped)
      merged[merged.length - 1] = join(last, { ...s, points: [last.points[last.points.length - 1], ...s.points] });
    } else {
      merged.push(s);
    }
  });
  if (merged.length > 1 && same(merged[0], merged[merged.length - 1])) {
    const last = merged.pop();
    merged[0] = join(last, { ...merged[0], points: [last.points[last.points.length - 1], ...merged[0].points] });
  }
  return merged;
}

/** Where each side meets the next. */
function cornersOf(sides) {
  return sides.map((s, i) => intersect(s, sides[(i + 1) % sides.length]));
}

/** A side as a line: a point on it and its direction. */
function lineOf(s) {
  if (s.kind === 'x') {
    return { point: [0, s.at], direction: [1, 0] };
  }
  if (s.kind === 'z') {
    return { point: [s.at, 0], direction: [0, 1] };
  }
  return { point: s.from, direction: s.direction };
}

function intersect(a, b) {
  const [p, q] = [lineOf(a), lineOf(b)];
  const denominator = p.direction[0] * q.direction[1] - p.direction[1] * q.direction[0];
  if (Math.abs(denominator) < 1e-9) {
    // parallel (a dropped jog between two runs the same way): meet halfway
    const end = a.points[a.points.length - 1];
    return end;
  }
  const t = ((q.point[0] - p.point[0]) * q.direction[1] - (q.point[1] - p.point[1]) * q.direction[0]) / denominator;
  return [p.point[0] + p.direction[0] * t, p.point[1] + p.direction[1] * t];
}

/** How far a point is from the nearest edge of a polygon. */
function boundaryDistance(point, polygon) {
  return Math.min(...polygon.map((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    return distance(point, [a[0] + dx * t, a[1] + dz * t]);
  }));
}

function normalize([x, z]) {
  const length = Math.hypot(x, z) || 1;
  return [x / length, z / length];
}

function samePoint(a, b) {
  return distance(a, b) < EPSILON;
}

function polygonArea(polygon) {
  return polygon.reduce((sum, [x, z], i) => {
    const [nx, nz] = polygon[(i + 1) % polygon.length];
    return sum + x * nz - nx * z;
  }, 0) / 2;
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
  const problem = angledWallProblem(squared.footprint);
  if (problem) {
    return { error: `Building ${payload.id}: ${problem}` };
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
