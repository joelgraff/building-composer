/**
 * Turn into a porch (docs/FOOTPRINT_EDITING_PLAN.md, phase 4): a part of a
 * traced outline that is really a porch (OSM often traces an open porch as
 * part of the building) is cut out of the footprint and becomes a porch
 * structure. Pure functions with no DOM or THREE dependency.
 *
 * The part is an axis-aligned rectangle in Composer's frame (drawn across a
 * wall, or a traced bump: findBump); the outline's other walls may be at any
 * angle. What it becomes depends on how it
 * touches the rest of the building:
 * - on one side: a porch projecting from that wall, standing on the ground,
 *   and the part is cut out of the footprint, leaving the wall straight;
 * - on two or more sides (it sits inside the wall line, a recessed porch
 *   traced as solid): a recessed porch (`mount: 'recess'`), and the
 *   footprint stays as it is.
 * A wraparound is turned one leg at a time: projecting porches on adjacent
 * walls of one mass, with the same depth, meeting at its corner, become one
 * wraparound porch when the footprint is used (porchStructures).
 *
 * The editor keeps these as pending porches, `{ type, side, rect,
 * openSides }`, and makes the structure records only when the footprint is
 * used (porchStructures), from the final outline and its masses.
 */
import { computeFacadeLayout } from './facade.js';
import { validateFootprint } from './footprint.js';
import { structureFrame, structureWallSides } from './roof-structures.js';
import { openRing, footprintWalls, MIN_WALL } from './footprint-editor.js';

const EPS = 1e-6;
/** Tolerance for a porch meeting a wall, a corner, or another porch (meters). */
const MEET = 0.02;
const SIDES = ['minX', 'maxX', 'minZ', 'maxZ'];
const OPPOSITE = {
  minX: 'maxX', maxX: 'minX', minZ: 'maxZ', maxZ: 'minZ',
};

/** A porch's roof and walls, by what it became (the Add menu's ground, wraparound, and integral porches). */
const PORCH_FIELDS = {
  projecting: {
    kind: 'porch', baseHeight: 'ground', wallHeight: 2.6, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 },
  },
  wraparound: {
    kind: 'porch', baseHeight: 'ground', wallHeight: 2.8, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 },
  },
  recess: {
    kind: 'porch', mount: 'recess', setback: 0, baseHeight: 'ground', wallHeight: 2.4, roofType: 'flat',
  },
};

/**
 * The rectangle of a traced bump whose outer wall is `wallIndex`: the wall
 * and the two walls either side of it turning back, square, to one wall
 * line. Null when the wall isn't the face of a bump standing out.
 */
export function findBump(footprint, wallIndex) {
  const ring = openRing(footprint);
  const n = ring.length;
  if (n < 6) {
    return null;
  }
  const walls = footprintWalls(ring);
  const face = walls[wallIndex];
  const before = walls[(wallIndex - 1 + n) % n];
  const after = walls[(wallIndex + 1) % n];
  if (!face?.axis || !before.axis || !after.axis || before.axis === face.axis || after.axis === face.axis) {
    return null;
  }
  // the sides run out from one wall line and back to it
  const start = ring[(wallIndex - 1 + n) % n];
  const end = ring[(wallIndex + 2) % n];
  const across = face.axis === 'x' ? 1 : 0;
  if (Math.abs(start[across] - end[across]) > MEET) {
    return null;
  }
  // and the face stands outside that line
  const out = (face.start[across] - start[across]) * face.normal[across];
  if (!(out > MIN_WALL)) {
    return null;
  }
  const corners = [start, face.start, face.end, end];
  return rectOf(corners);
}

/**
 * Cuts `rect` out of the footprint as a porch, or finds it's a recessed
 * porch. Throws a RangeError saying why when it can't. Works on the outline
 * itself, so angled walls elsewhere are kept as they are.
 *
 * @returns {{ footprint: Array<[number, number]>, porch: { type: 'projecting'|'recess', side: string, rect: object, openSides: string[] } }}
 *   `side` is the side of the house the porch faces out of (its host side).
 */
export function cutPart(footprint, rect) {
  const ring = openRing(footprint);
  const box = normalizeRect(rect);
  if (box.maxX - box.minX < MIN_WALL || box.maxZ - box.minZ < MIN_WALL) {
    throw new RangeError('Draw a rectangle over the porch, at least a few inches each way.');
  }
  // the part of the building under the rectangle
  // (clipping a concave outline can leave zero-width slivers along the box's edge: dropped)
  const raw = clipToBox(ring, box);
  const clipped = raw.length >= 3 ? dropAt(raw, new Set(raw)) : raw;
  const partArea = clipped.length >= 3 ? Math.abs(signedArea(clipped)) : 0;
  if (partArea < 1e-4) {
    throw new RangeError("The rectangle doesn't cover any of the building.");
  }
  if (partArea > Math.abs(signedArea(ring)) - 1e-4) {
    throw new RangeError('That would take the whole building.');
  }
  const part = rectOf(clipped);
  if (Math.abs((part.maxX - part.minX) * (part.maxZ - part.minZ) - partArea) > 1e-4) {
    throw new RangeError('Only a rectangular part can become a porch: draw the rectangle over just the porch (turn a wraparound one leg at a time).');
  }
  const faces = partFaces(ring, part);
  const house = SIDES.filter((side) => faces[side].rest > 0);
  const open = SIDES.filter((side) => faces[side].outside > 0);
  if (!open.length) {
    throw new RangeError("That part is inside the building: draw the rectangle across an outside wall.");
  }
  if (!house.length) {
    throw new RangeError("That part doesn't touch the rest of the building.");
  }
  // open on two facing sides with the house on the other two: a strip right across the building
  const openAt = (side) => faces[side].rest === 0;
  const houseAt = (side) => faces[side].rest > 0;
  if ((openAt('minX') && openAt('maxX') && houseAt('minZ') && houseAt('maxZ'))
    || (openAt('minZ') && openAt('maxZ') && houseAt('minX') && houseAt('maxX'))) {
    throw new RangeError('That would cut the building in two.');
  }
  if (house.length === 1) {
    // standing out from one wall: cut it off, and a porch stands where it was
    const back = house[0];
    return {
      footprint: spliceOff(ring, part, back),
      porch: { type: 'projecting', side: OPPOSITE[back], rect: part, openSides: ['front', 'left', 'right'] },
    };
  }
  // inside the wall line: a recessed porch, open where it faces outside, the footprint kept
  const fronts = SIDES.filter((side) => faces[side].rest === 0 && house.includes(OPPOSITE[side]));
  if (!fronts.length) {
    throw new RangeError('That part has the house on facing sides with nothing to open onto: it can\'t be a porch.');
  }
  const length = (side) => (side === 'minX' || side === 'maxX' ? part.maxZ - part.minZ : part.maxX - part.minX);
  const side = fronts.reduce((best, candidate) => (length(candidate) > length(best) + EPS ? candidate : best));
  const names = structureWallSides(structureFrame(side));
  const openSides = ['front', 'left', 'right'].filter((name) => faces[names[name]].rest === 0);
  return { footprint: ring, porch: { type: 'recess', side, rect: part, openSides } };
}

// --- Cutting on the outline itself -------------------------------------------

/** Samples along each face of the part, just outside it: how many lie in the rest of the building, and how many outside. */
const FACE_SAMPLES = 64;
const FACE_OFFSET = 1e-4;

function partFaces(ring, part) {
  const tally = Object.fromEntries(SIDES.map((side) => [side, { rest: 0, outside: 0 }]));
  SIDES.forEach((side) => {
    const acrossX = side === 'minX' || side === 'maxX';
    const [lo, hi] = acrossX ? [part.minZ, part.maxZ] : [part.minX, part.maxX];
    const at = part[side] + (side.startsWith('max') ? FACE_OFFSET : -FACE_OFFSET);
    for (let i = 0; i < FACE_SAMPLES; i += 1) {
      const t = lo + ((i + 0.5) / FACE_SAMPLES) * (hi - lo);
      const point = acrossX ? [at, t] : [t, at];
      tally[side][pointInPolygon(point, ring) ? 'rest' : 'outside'] += 1;
    }
  });
  return tally;
}

/**
 * The outline with a part standing out from its back face cut off: the run
 * of corners beyond the back line within the part is replaced by the two
 * points where the outline crosses that line, and corners left repeated or in
 * line there are dropped. Other corners, angled walls among them, stay.
 */
function spliceOff(ring, part, back) {
  const axis = back === 'minX' || back === 'maxX' ? 0 : 1;
  const along = 1 - axis;
  const line = part[back];
  const outward = back.startsWith('min') ? 1 : -1;
  const [lo, hi] = along === 0 ? [part.minX, part.maxX] : [part.minZ, part.maxZ];
  const beyond = (point) => (point[axis] - line) * outward > EPS && point[along] > lo - EPS && point[along] < hi + EPS;
  const n = ring.length;
  const marks = ring.map(beyond);
  // the run must be one stretch of the ring (it wraps round the start)
  const starts = marks.map((marked, i) => marked && !marks[(i - 1 + n) % n]).filter(Boolean).length;
  if (starts !== 1) {
    throw new RangeError(starts ? 'That would cut the building in two.' : 'That part has no corners to cut off: draw the rectangle over a part standing out.');
  }
  const first = marks.findIndex((marked, i) => marked && !marks[(i - 1 + n) % n]);
  let last = first;
  while (marks[(last + 1) % n]) {
    last = (last + 1) % n;
  }
  const previous = ring[(first - 1 + n) % n];
  const next = ring[(last + 1) % n];
  const entry = at(previous, ring[first], axis, line);
  const exit = at(ring[last], next, axis, line);
  // the outline in its own order (walls are numbered from it), the run replaced where it stood
  const result = [];
  ring.forEach((point, i) => {
    if (!marks[i]) {
      result.push(point);
    } else if (i === first) {
      result.push(entry, exit);
    }
  });
  const cleaned = dropAt(result, new Set([previous, next, entry, exit]));
  const { errors } = validateFootprint(cleaned, { expectedWinding: signedArea(ring) > 0 ? 'CCW' : 'CW' });
  if (errors.length) {
    throw new RangeError("That cut doesn't leave a clean outline.");
  }
  return cleaned;
}

/** Drops the given corners (by reference) where they repeat a neighbor or stand in line with both. */
function dropAt(ring, loose) {
  const result = [...ring];
  for (let changed = true; changed && result.length > 3;) {
    changed = false;
    for (let i = 0; i < result.length && result.length > 3; i += 1) {
      if (!loose.has(result[i])) {
        continue;
      }
      const previous = result[(i - 1 + result.length) % result.length];
      const point = result[i];
      const next = result[(i + 1) % result.length];
      const repeated = Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1e-6 || Math.hypot(next[0] - point[0], next[1] - point[1]) < 1e-6;
      const inLine = Math.abs((point[0] - previous[0]) * (next[1] - point[1]) - (point[1] - previous[1]) * (next[0] - point[0])) < 1e-6;
      if (repeated || inLine) {
        result.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return result.map((point) => [...point]);
}

/** The polygon clipped to an axis-aligned box (Sutherland-Hodgman; the box is convex). */
function clipToBox(ring, box) {
  const edges = [
    [(p) => p[0] >= box.minX, (a, b) => at(a, b, 0, box.minX)],
    [(p) => p[0] <= box.maxX, (a, b) => at(a, b, 0, box.maxX)],
    [(p) => p[1] >= box.minZ, (a, b) => at(a, b, 1, box.minZ)],
    [(p) => p[1] <= box.maxZ, (a, b) => at(a, b, 1, box.maxZ)],
  ];
  return edges.reduce((points, [inside, cut]) => {
    const out = [];
    points.forEach((point, i) => {
      const previous = points[(i - 1 + points.length) % points.length];
      if (inside(point)) {
        if (!inside(previous)) {
          out.push(cut(previous, point));
        }
        out.push(point);
      } else if (inside(previous)) {
        out.push(cut(previous, point));
      }
    });
    return out;
  }, ring);
}

/** Where segment a-b crosses the line where `axis` equals `value` (exactly on it). */
function at(a, b, axis, value) {
  const t = (value - a[axis]) / (b[axis] - a[axis]);
  const point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  point[axis] = value;
  return point;
}

function signedArea(points) {
  return points.reduce((sum, [x, z], i) => {
    const [nx, nz] = points[(i + 1) % points.length];
    return sum + x * nz - nx * z;
  }, 0) / 2;
}

/**
 * The structure records for an outline's pending porches (from cutPart), on
 * its masses as Composer will cut them (`volumeSplit`, see
 * computeFacadeLayout). Projecting porches that meet at a mass's corner
 * with the same depth become one wraparound. A porch that no longer stands
 * against a wall (the outline was edited after) is left out, with a problem
 * saying so.
 *
 * @returns {{ structures: object[], problems: string[] }} records to pass
 *   to createRoofStructure (each marked `fromFootprint`)
 */
export function porchStructures(footprint, porches, { volumeSplit = 'auto' } = {}) {
  const ring = openRing(footprint);
  const { volumes } = computeFacadeLayout(ring, { volumeSplit });
  const problems = [];
  const placed = [];
  porches.forEach((porch, index) => {
    const found = porch.type === 'recess' ? hostForRecess(porch, volumes) : hostForProjecting(porch, volumes);
    if (!found) {
      problems.push(`Porch ${index + 1} no longer stands against a wall of the building, so it wasn't added.`);
      return;
    }
    placed.push({ ...porch, ...found });
  });

  const structures = [];
  placed.filter((porch) => porch.type === 'recess').forEach((porch) => {
    structures.push({
      ...PORCH_FIELDS.recess,
      hostVolumeId: porch.volume.id,
      hostSide: porch.side,
      offset: porch.center - porch.volumeMiddle,
      width: porch.length,
      depth: porch.depth,
      openSides: porch.openSides,
      fromFootprint: true,
    });
  });
  const projecting = placed.filter((porch) => porch.type === 'projecting');
  chainWraps(projecting).forEach((chain) => {
    if (chain.length === 1) {
      const [porch] = chain;
      structures.push({
        ...PORCH_FIELDS.projecting,
        hostVolumeId: porch.volume.id,
        hostSide: porch.side,
        offset: porch.center - porch.volumeMiddle,
        width: porch.length,
        setback: -porch.depth,
        depth: porch.depth,
        openSides: porch.openSides,
        fromFootprint: true,
      });
      return;
    }
    const [first] = chain;
    const last = chain[chain.length - 1];
    const loop = chain.length === 4 && chain.loop;
    structures.push({
      ...PORCH_FIELDS.wraparound,
      hostVolumeId: first.volume.id,
      hostSide: first.side,
      offset: first.center - first.volumeMiddle,
      width: first.houseLength,
      setback: -first.depth,
      depth: first.depth,
      openSides: ['front', 'left', 'right'],
      wrap: {
        walls: chain.map((porch) => porch.side),
        startLength: loop ? first.wallLength : first.houseLength,
        endLength: loop ? last.wallLength : last.houseLength,
      },
      fromFootprint: true,
    });
  });
  return { structures, problems };
}

// --- Hosts and wraparounds ---------------------------------------------------

/** A side's axis along it, and the coordinate across it. */
function sideAxes(side) {
  return side === 'minX' || side === 'maxX' ? { along: 'Z', across: 'X' } : { along: 'X', across: 'Z' };
}

/** The mass a projecting porch stands against (its back on the mass's side, overlapping most), with its placement along that side. */
function hostForProjecting(porch, volumes) {
  const { along, across } = sideAxes(porch.side);
  const back = porch.rect[OPPOSITE[porch.side]];
  const [lo, hi] = [porch.rect[`min${along}`], porch.rect[`max${along}`]];
  let best = null;
  volumes.forEach((volume) => {
    if (Math.abs(volume[porch.side] - back) > MEET) {
      return;
    }
    const overlap = Math.min(hi, volume[`max${along}`]) - Math.max(lo, volume[`min${along}`]);
    if (overlap > EPS && (!best || overlap > best.overlap)) {
      best = { volume, overlap };
    }
  });
  if (!best) {
    return null;
  }
  const { volume } = best;
  const [vlo, vhi] = [volume[`min${along}`], volume[`max${along}`]];
  const depth = Math.abs(porch.rect[porch.side] - back);
  return {
    volume,
    along,
    across,
    lo,
    hi,
    vlo,
    vhi,
    depth,
    center: (lo + hi) / 2,
    length: hi - lo,
    volumeMiddle: (vlo + vhi) / 2,
    // the stretch along the house (a leg's length in a wraparound), and the whole wall
    houseLength: Math.min(hi, vhi) - Math.max(lo, vlo),
    wallLength: vhi - vlo,
  };
}

/** The mass a recessed porch is cut into (the one holding it, its front on the mass's side). */
function hostForRecess(porch, volumes) {
  const { along } = sideAxes(porch.side);
  const middle = [(porch.rect.minX + porch.rect.maxX) / 2, (porch.rect.minZ + porch.rect.maxZ) / 2];
  const volume = volumes.find((candidate) => middle[0] > candidate.minX - EPS && middle[0] < candidate.maxX + EPS
    && middle[1] > candidate.minZ - EPS && middle[1] < candidate.maxZ + EPS
    && Math.abs(candidate[porch.side] - porch.rect[porch.side]) < MEET);
  if (!volume) {
    return null;
  }
  const [lo, hi] = [porch.rect[`min${along}`], porch.rect[`max${along}`]];
  return {
    volume,
    center: (lo + hi) / 2,
    length: hi - lo,
    depth: porch.side === 'minX' || porch.side === 'maxX' ? porch.rect.maxX - porch.rect.minX : porch.rect.maxZ - porch.rect.minZ,
    volumeMiddle: (volume[`min${along}`] + volume[`max${along}`]) / 2,
  };
}

/**
 * Groups projecting porches into wraparound chains: a porch that runs on
 * past its mass's corner by its depth (the corner square is its), and a
 * porch of the same depth on the mass's next wall starting at that corner,
 * are one wraparound, in that order. A leg between two others must run its
 * whole wall. Porches that don't chain stay on their own.
 */
function chainWraps(porches) {
  const nextOf = new Map();
  porches.forEach((porch) => {
    const ownsMax = Math.abs(porch.hi - (porch.vhi + porch.depth)) < MEET;
    const ownsMin = Math.abs(porch.lo - (porch.vlo - porch.depth)) < MEET;
    [[ownsMax, `max${porch.along}`], [ownsMin, `min${porch.along}`]].forEach(([owns, turnsOnto]) => {
      if (!owns || nextOf.has(porch)) {
        return;
      }
      // the next leg: on the wall round the corner, same mass and depth, reaching the corner
      const cornerAt = porch.volume[porch.side];
      const next = porches.find((other) => other !== porch && other.volume === porch.volume && other.side === turnsOnto
        && Math.abs(other.depth - porch.depth) < MEET
        && (porch.side.startsWith('max') ? Math.abs(other.hi - cornerAt) < MEET : Math.abs(other.lo - cornerAt) < MEET));
      if (next) {
        nextOf.set(porch, next);
      }
    });
  });
  const hasPrevious = new Set(nextOf.values());
  const chains = [];
  const used = new Set();
  const follow = (start) => {
    const chain = [start];
    used.add(start);
    let current = start;
    while (nextOf.has(current) && !used.has(nextOf.get(current))) {
      current = nextOf.get(current);
      chain.push(current);
      used.add(current);
    }
    chain.loop = nextOf.get(current) === start;
    return chain;
  };
  porches.filter((porch) => !hasPrevious.has(porch)).forEach((porch) => chains.push(follow(porch)));
  // what's left is a loop all the way round
  porches.filter((porch) => !used.has(porch)).forEach((porch) => chains.push(follow(porch)));
  // a leg between two others runs its whole wall; otherwise the chain stays as separate porches
  return chains.flatMap((chain) => {
    if (chain.length < 2) {
      return [chain];
    }
    const middles = chain.loop ? chain : chain.slice(1, -1);
    const whole = middles.every((porch) => Math.abs(porch.houseLength - porch.wallLength) < MEET);
    return whole && chain.length <= 4 ? [chain] : chain.map((porch) => [porch]);
  });
}

function pointInPolygon([x, z], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}




function normalizeRect(rect) {
  return {
    minX: Math.min(rect.minX, rect.maxX), maxX: Math.max(rect.minX, rect.maxX), minZ: Math.min(rect.minZ, rect.maxZ), maxZ: Math.max(rect.minZ, rect.maxZ),
  };
}

function rectOf(points) {
  const xs = points.map(([x]) => x);
  const zs = points.map(([, z]) => z);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

