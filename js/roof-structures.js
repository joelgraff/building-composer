/**
 * Roof-borne structures (dormers, raised porches): shared solid geometry.
 *
 * Pure functions with no THREE dependency. Triangles are arrays of three
 * [x, y, z] points in absolute (building) coordinates.
 *
 * A roof structure relates to the building through two clips between convex
 * solids: its own walls and roof are kept *outside* the host volume's solid,
 * and the host's roof is kept outside the structure's solid. Both use
 * `clipOutsideConvexSolid`. A solid is a list of half-spaces
 * `{ normal: [nx, ny, nz], offset }` (unit normal), and a point p is inside
 * when `normal · p <= offset` for every one of them.
 */

import {
  computeVolumeEavePlanes, evalPlaneHeight, evalZoneHeight, makeEavePlane, makeEdgePlane, TWO_SLOPE_ROOF_TYPES,
} from './roof-planes.js';

/** Default tolerance: faces within this distance of a solid's boundary count as inside. */
export const SOLID_EPSILON = 1e-4;

/** Thickness of the slab a flat roof is built as (see createFlatRoofGeometry). */
export const FLAT_ROOF_THICKNESS = 0.08;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Sutherland-Hodgman clip of a polygon (array of points) to the half-space
 * where `distance(point) >= 0`.
 */
export function clipPolygon(polygon, distance) {
  const out = [];
  polygon.forEach((current, i) => {
    const previous = polygon[(i + polygon.length - 1) % polygon.length];
    const dCurrent = distance(current);
    const dPrevious = distance(previous);
    if ((dCurrent >= 0) !== (dPrevious >= 0)) {
      const t = dPrevious / (dPrevious - dCurrent);
      out.push(previous.map((value, k) => value + (current[k] - value) * t));
    }
    if (dCurrent >= 0) {
      out.push(current);
    }
  });
  return out;
}

const cross3 = (a, b, c) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
};

/** Twice the area below which a clipped sliver is dropped (about 1 mm²). */
const SLIVER_AREA = 1e-6;

/**
 * Fan-triangulates convex polygons, dropping any with fewer than 3 points
 * and any sliver triangles clipping leaves behind.
 */
export function polygonsToTriangles(polygons) {
  return polygons.flatMap((polygon) => (polygon.length < 3
    ? []
    : polygon.slice(1, -1).map((_, k) => [polygon[0], polygon[k + 1], polygon[k + 2]])))
    .filter((triangle) => triangle[0].length !== 3 || Math.hypot(...cross3(...triangle)) > SLIVER_AREA);
}

function normalizedHalfSpace(normal, offset) {
  const length = Math.hypot(...normal);
  return { normal: normal.map((value) => value / length), offset: offset / length };
}

/**
 * The parts of `triangles` that lie outside a convex solid. The difference
 * is split into convex pieces one face at a time: the piece beyond face i
 * that is still inside faces 0..i-1 is kept, and the remainder carries on to
 * the next face. What is left after the last face is inside and dropped.
 *
 * Cuts are made exactly on each face plane, so two solids clipped against
 * each other meet along the same lines and form one closed shell. `epsilon`
 * only decides what lies *on* a face: a piece no further than that beyond it
 * (a wall flush against another wall) counts as inside and is removed rather
 * than left to z-fight.
 *
 * @param {Array<Array<[number, number, number]>>} triangles
 * @param {Array<{ normal: number[], offset: number }>} halfSpaces
 * @param {number} [epsilon]
 * @returns {Array<Array<[number, number, number]>>} triangles
 */
export function clipOutsideConvexSolid(triangles, halfSpaces, epsilon = SOLID_EPSILON) {
  const kept = [];
  triangles.forEach((triangle) => {
    let remainder = triangle;
    for (const { normal, offset } of halfSpaces) {
      const beyond = (point) => dot(normal, point) - offset;
      const outside = clipPolygon(remainder, beyond);
      if (outside.length >= 3 && Math.max(...outside.map(beyond)) > epsilon) {
        kept.push(outside);
        remainder = clipPolygon(remainder, (point) => -beyond(point));
        if (remainder.length < 3) {
          return;
        }
      }
      // otherwise nothing lies meaningfully beyond this face: the remainder
      // is inside or on it, and carries on unchanged
    }
  });
  return polygonsToTriangles(kept);
}

/**
 * The parts of `triangles` inside a convex solid; faces lying on its
 * boundary (within `epsilon`) count as inside.
 */
export function clipInsideConvexSolid(triangles, halfSpaces, epsilon = SOLID_EPSILON) {
  return polygonsToTriangles(triangles.map((triangle) => halfSpaces.reduce((polygon, { normal, offset }) => {
    const beyond = (point) => dot(normal, point) - offset;
    // cut exactly on the face (so pieces kept here and by clipOutsideConvexSolid
    // meet along the same line); a polygon no further beyond it than epsilon
    // lies on the face and is kept whole
    return polygon.length < 3 || Math.max(...polygon.map(beyond)) <= epsilon
      ? polygon
      : clipPolygon(polygon, (point) => -beyond(point));
  }, triangle)));
}

/** The vertical prism over a convex plan polygon ([x, z] points), as half-spaces. */
export function planPrism(polygon) {
  const signedArea = polygon.reduce((sum, [x, z], i) => {
    const [nx, nz] = polygon[(i + 1) % polygon.length];
    return sum + x * nz - nx * z;
  }, 0);
  const turn = Math.sign(signedArea) || 1;
  // (a repeated point is a zero-length edge, which bounds nothing)
  return polygon.flatMap(([x, z], i) => {
    const [nx, nz] = polygon[(i + 1) % polygon.length];
    if (Math.hypot(nx - x, nz - z) < 1e-12) {
      return [];
    }
    // outward normal of edge (x, z) -> (nx, nz)
    const normal = [turn * (nz - z), 0, -turn * (nx - x)];
    return [normalizedHalfSpace(normal, normal[0] * x + normal[2] * z)];
  });
}

/** True when `point` is inside every half-space (within `epsilon`). */
export function isInsideSolid(point, halfSpaces, epsilon = SOLID_EPSILON) {
  return halfSpaces.every(({ normal, offset }) => dot(normal, point) <= offset + epsilon);
}

/**
 * Half-space form of one roof eave plane (see js/roof-planes.js), whose height above the plate is
 * `offset + slope * sign * (coord - constant)`: inside is below it, lifted
 * by the plate elevation `baseY`.
 */
function roofPlaneHalfSpace(plane, baseY) {
  if ('constantHeight' in plane) {
    return normalizedHalfSpace([0, 1, 0], baseY + plane.constantHeight);
  }
  if (plane.dir) {
    // y <= baseY + offset + slope * (dir . p - constant)
    const normal = [-plane.slope * plane.dir[0], 1, -plane.slope * plane.dir[1]];
    return normalizedHalfSpace(normal, baseY + (plane.offset ?? 0) - plane.slope * plane.constant);
  }
  const k = plane.slope * plane.sign;
  const normal = plane.axis === 'x' ? [-k, 1, 0] : [0, 1, -k];
  return normalizedHalfSpace(normal, baseY + (plane.offset ?? 0) - k * plane.constant);
}

/**
 * The convex solid a roof zone encloses: its wall box, from `floorY` up,
 * capped by its roof planes (a flat roof by the top of its slab). Heights are
 * absolute, so solids from different volumes (and different plates) can be
 * clipped against each other. Overhangs are not part of the solid. A
 * structure's solid starts at its floor (`zone.floorY`), a volume's at grade.
 *
 * @param {{ bounds: { minX: number, maxX: number, minZ: number, maxZ: number }, baseY: number, planes: Array<object>, slabThickness?: number }} zone
 *   A resolved roof zone descriptor (`roofZones` from createBuildingFromFootprint).
 * @param {{ floorY?: number }} [options]
 * @returns {Array<{ normal: number[], offset: number }>}
 */
export function volumeSolid(zone, { floorY = zone.floorY ?? 0 } = {}) {
  const { bounds, baseY } = zone;
  // a structure with a polygonal plan (see `plan`) is bounded by its outline
  const walls = zone.outline ? [...planPrism(zone.outline), normalizedHalfSpace([0, -1, 0], -floorY)] : [
    normalizedHalfSpace([-1, 0, 0], -bounds.minX),
    normalizedHalfSpace([1, 0, 0], bounds.maxX),
    normalizedHalfSpace([0, 0, -1], -bounds.minZ),
    normalizedHalfSpace([0, 0, 1], bounds.maxZ),
    normalizedHalfSpace([0, -1, 0], -floorY),
  ];
  const roof = zone.planes?.length
    ? zone.planes.map((plane) => roofPlaneHalfSpace(plane, baseY))
    : [normalizedHalfSpace([0, 1, 0], baseY + (zone.slabThickness ?? 0))];
  return [...walls, ...roof];
}

/**
 * The convex solids whose union is the space under a zone's roof. A zone
 * whose roof is the min of its planes is one solid (volumeSolid). A zone
 * cut from a larger roof (a volume under a continuous straight-skeleton hip)
 * lists its roof as convex plan pieces, each under one plane (`roofPieces`),
 * and gets a prism per piece, capped by that piece's plane.
 */
export function zoneSolids(zone, options = {}) {
  if (!zone.roofPieces?.length) {
    return [volumeSolid(zone, options)];
  }
  const floorY = options.floorY ?? zone.floorY ?? 0;
  return zone.roofPieces.map(({ polygon, plane }) => [
    ...planPrism(polygon),
    normalizedHalfSpace([0, -1, 0], -floorY),
    roofPlaneHalfSpace(plane, zone.baseY),
  ]);
}

/** Whether a plan point is inside a convex polygon (or on its edge). */
function insideConvex([x, z], polygon) {
  const turn = Math.sign(polygon.reduce((sum, [ax, az], k) => {
    const [bx, bz] = polygon[(k + 1) % polygon.length];
    return sum + ax * bz - bx * az;
  }, 0)) || 1;
  return polygon.every(([x0, z0], i) => {
    const [x1, z1] = polygon[(i + 1) % polygon.length];
    return turn * ((x1 - x0) * (z - z0) - (z1 - z0) * (x - x0)) >= -1e-9;
  });
}

/** A zone's roof height above its plate at a plan point. */
export function zoneRoofHeight(zone, point) {
  const piece = zone.roofPieces?.find(({ polygon }) => insideConvex(point, polygon));
  if (piece) {
    return evalPlaneHeight(piece.plane, point[0], point[1]);
  }
  return zone.planes?.length ? evalZoneHeight(zone.planes, point[0], point[1]) : zone.slabThickness ?? 0;
}

// ---------------------------------------------------------------------------
// Structure records: data model, placement, validation
// ---------------------------------------------------------------------------

export const STRUCTURE_KINDS = ['dormer', 'wall-dormer', 'recessed-porch', 'porch', 'cupola', 'hood'];
/**
 * How a structure meets the roof: joining one face (a dormer), rising
 * through it (a cupola), or recessed into the walls under it (an integral
 * porch, see resolveRecess).
 */
export const STRUCTURE_MOUNTS = ['join', 'through', 'recess'];
export const STRUCTURE_WALLS = ['front', 'left', 'right', 'back'];
/** What holds up the part of a structure projecting past its host wall (see resolveRoofStructure). */
export const STRUCTURE_SUPPORTS = ['auto', 'none', 'deck', 'posts', 'porch', 'brackets', 'enclosed'];
/** Brackets carry only a shallow projection. */
export const MAX_BRACKET_PROJECTION = 1.5;
const SIDES = ['minX', 'maxX', 'minZ', 'maxZ'];
const ROOF_TYPES = ['flat', 'gable', 'hip', 'shed'];
const GEOMETRY_EPSILON = 1e-6;
/** How near a wraparound's end must be to the corner, and its depth to its projection. */
const WRAP_TOLERANCE = 1e-3;

/**
 * Defaults per kind. The kind is only a starting point for the UI: every
 * structure is built the same way from its own fields. Lengths in meters.
 */
export const STRUCTURE_PRESETS = Object.freeze({
  // three walls standing above the roof plane
  dormer: Object.freeze({
    width: 2.4, setback: 0.9, depth: null, wallHeight: 1.4, baseHeight: null, openSides: [], roofType: 'gable',
  }),
  // front wall carries the main wall up through the eave
  'wall-dormer': Object.freeze({
    width: 2.4, setback: 0, depth: null, wallHeight: 1.2, baseHeight: null, openSides: [], roofType: 'gable',
  }),
  // a dormer set up the roof (a strip of roof and the eave run on below it) whose
  // front wall is set back, leaving an open porch under its roof
  'recessed-porch': Object.freeze({
    width: 3.6, setback: 1.2, depth: null, wallHeight: 2.2, baseHeight: null, openSides: [], roofType: 'gable', inset: 1.5,
  }),
  // a small square lookout rising through the roof at its center, with a pyramid roof
  cupola: Object.freeze({
    width: 1.6, setback: 'center', depth: 1.6, wallHeight: 1.2, baseHeight: null, openSides: [], roofType: 'hip', mount: 'through',
  }),
  // an entry hood: a small roof on brackets over a door, with no floor,
  // posts, or walls; its wall height is how high its roof sits above the floor
  hood: Object.freeze({
    width: 1.8, setback: -0.9, depth: 0.9, wallHeight: 2.4, baseHeight: 'ground', openSides: ['front', 'left', 'right', 'back'], roofType: 'gable',
  }),
  // a raised porch standing on its host's plate (e.g. over a one-story wing)
  porch: Object.freeze({
    width: 3.6, setback: 0, depth: 2.4, wallHeight: 2.4, baseHeight: 0, openSides: ['front', 'left', 'right'], roofType: 'shed',
  }),
});

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/** A structure's plan shape: null for a rectangle, a canted bay, or a regular polygon (an octagonal or round tower). */
function normalizePlan(plan) {
  if (plan?.shape === 'canted') {
    const angle = finite(plan.angle, 45);
    return { shape: 'canted', angle: Math.min(80, Math.max(15, angle)) };
  }
  if (plan?.shape === 'polygon') {
    return { shape: 'polygon', sides: Math.min(32, Math.max(5, Math.round(finite(plan.sides, 8)))) };
  }
  return null;
}
const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {});

function normalizeRoofShape(shape) {
  if (shape?.mode === 'slope' && Number.isFinite(shape.pitchRise)) {
    return { mode: 'slope', pitchRise: shape.pitchRise };
  }
  if (shape?.mode === 'height' && Number.isFinite(shape.height)) {
    return { mode: 'height', height: shape.height };
  }
  return null;
}

/**
 * A complete structure record from partial or untrusted input (a `.bld`
 * file, a UI preset), with the kind's preset filling anything missing.
 * Returns null when it cannot be placed at all (no host volume or side).
 *
 * Placement is in the host side's own frame (see `structureFrame`):
 * - `offset`: center along the side, from the side's midpoint.
 * - `setback`: front wall distance in from the host wall (0 = flush, < 0 projects past it).
 * - `depth`: front-to-back length, or null to run back to the host ridge
 *   (the structure's own roof ends it where it meets the host roof).
 * - `wallHeight`: plate height above the front sill.
 * - `baseHeight`: null to rise out of the host roof, a floor level above
 *   the host plate, or `'ground'` for a floor at the host's foundation top.
 * - `support`: what holds up a projecting structure: `deck` (a solid base),
 *   `posts` (to grade), `porch` (posts on a ground-level deck), `brackets`
 *   (back to the wall), `enclosed` (walls down to a foundation), or `none`;
 *   `auto` is a deck at ground level and posts above it.
 * - `hostStructureId`: stand on another structure instead of a volume (a
 *   sleeping porch on a ground porch's roof); its side frame is the host
 *   structure's rectangle.
 * - `openSides`: walls left open (`front`, `back`, and `left`/`right` as
 *   seen from outside, facing the front wall).
 * - `mount`: `join` (default) to join one roof face, as a dormer does, or
 *   `through` to rise through the roof without joining it (a cupola or
 *   belvedere): no single-face rule or ridge cap, wall height measured from
 *   the highest point of the roof under it, and the host roof left whole.
 * - `setback: 'center'` centers the structure across its host (on the ridge);
 *   it needs an explicit depth.
 * - `plan`: null for a rectangle; `{ shape: 'canted', angle }` for a bay
 *   whose sides run back to the wall at `angle` degrees (a canted bay
 *   window); `{ shape: 'polygon', sides }` for a regular polygon inscribed in
 *   the rectangle (an octagonal, or with many sides a round, tower). Only a
 *   structure standing on a base or rising through the roof can have one,
 *   with a hip (a polygonal hip, or a cone) or flat roof.
 * - `wrap`: `{ end: 'left'|'right', length }` turns a projecting porch around
 *   the host's corner at that end (a wraparound): it runs on past the corner
 *   and back along the adjacent wall for `length`, under one hip roof that
 *   turns the corner (see expandWraps). Its end must be at the corner.
 * - `inset`: how far the front wall is set back inside the structure,
 *   leaving an open porch (floor, side walls, and the structure's roof) in
 *   front of it; 0 for none. A recessed porch is a dormer with an inset,
 *   usually set up the roof so a strip of roof and the eave run on below it.
 *
 * @returns {object|null}
 */
export function normalizeRoofStructure(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const hostStructureId = typeof raw.hostStructureId === 'string' && raw.hostStructureId ? raw.hostStructureId : null;
  if (!SIDES.includes(raw.hostSide) || (typeof raw.hostVolumeId !== 'string' && !hostStructureId)) {
    return null;
  }
  // a widow's walk is the flat top of a hip roof (roofWalkHeight), not a structure
  if (raw.kind === 'widows-walk') {
    return null;
  }
  const kind = STRUCTURE_KINDS.includes(raw.kind) ? raw.kind : 'dormer';
  const preset = STRUCTURE_PRESETS[kind];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : null,
    kind,
    hostVolumeId: typeof raw.hostVolumeId === 'string' ? raw.hostVolumeId : null,
    hostStructureId,
    hostSide: raw.hostSide,
    offset: finite(raw.offset, 0),
    width: finite(raw.width, preset.width),
    setback: raw.setback === 'center' ? 'center' : finite(raw.setback, preset.setback),
    mount: STRUCTURE_MOUNTS.includes(raw.mount) ? raw.mount : (preset.mount ?? 'join'),
    depth: raw.depth === null ? null : finite(raw.depth, preset.depth),
    wallHeight: finite(raw.wallHeight, preset.wallHeight),
    baseHeight: raw.baseHeight === null || raw.baseHeight === 'ground' ? raw.baseHeight : finite(raw.baseHeight, preset.baseHeight),
    support: STRUCTURE_SUPPORTS.includes(raw.support) ? raw.support : 'auto',
    openSides: Array.isArray(raw.openSides)
      ? STRUCTURE_WALLS.filter((wall) => raw.openSides.includes(wall))
      : [...preset.openSides],
    inset: Math.max(0, finite(raw.inset, preset.inset ?? 0)),
    roofType: ROOF_TYPES.includes(raw.roofType) ? raw.roofType : preset.roofType,
    ridge: raw.ridge === 'parallel' ? 'parallel' : 'perpendicular',
    roofShape: normalizeRoofShape(raw.roofShape),
    join: raw.join === 'snap-ridge' ? 'snap-ridge' : 'auto',
    plan: normalizePlan(raw.plan),
    wrap: normalizeWrap(raw.wrap, raw.hostSide, finite(raw.width, preset.width)),
    eaves: plainObject(raw.eaves),
    materials: plainObject(raw.materials),
  };
}

/**
 * Normalizes a list of records, dropping unplaceable ones and giving every
 * structure a unique id (`structure-N`).
 */
/**
 * A wraparound's walls and the lengths of its end legs:
 * `{ walls, startLength, endLength }`. `walls` are two to four walls of its
 * volume in order around it, each beside the next (all four: the porch runs
 * all the way round). The first leg runs `startLength` back along its wall
 * from the corner it turns, the last `endLength` on from the corner it turns
 * onto its wall; legs between run their whole walls. Files from before
 * wraparounds could turn more than one corner (`{ end, length }`) keep
 * their porch's width as the first leg and `length` as the second.
 */
function normalizeWrap(raw, hostSide, width) {
  if (!raw || typeof raw !== 'object' || !SIDES.includes(hostSide)) {
    return null;
  }
  if (!Array.isArray(raw.walls)) {
    if (!['left', 'right'].includes(raw.end) || !(raw.length > GEOMETRY_EPSILON)) {
      return null;
    }
    return { walls: [hostSide, structureWallSides(structureFrame(hostSide))[raw.end]], startLength: width, endLength: raw.length };
  }
  const walls = raw.walls.filter((wall) => SIDES.includes(wall));
  const across = (a, b) => (a === 'minX' || a === 'maxX') !== (b === 'minX' || b === 'maxX');
  const chained = walls.every((wall, i) => i === 0 || across(walls[i - 1], wall));
  if (walls.length < 2 || walls.length > 4 || new Set(walls).size !== walls.length || !chained) {
    return null;
  }
  const length = (value, fallback) => (Number.isFinite(value) && value > GEOMETRY_EPSILON ? value : fallback);
  return { walls, startLength: length(raw.startLength, width), endLength: length(raw.endLength, 4) };
}

export function normalizeRoofStructures(list) {
  const structures = (Array.isArray(list) ? list : []).map(normalizeRoofStructure).filter(Boolean);
  const used = new Set();
  let next = 1;
  return structures.map((structure) => {
    let { id } = structure;
    if (!id || used.has(id)) {
      while (used.has(`structure-${next}`) || structures.some((other) => other.id === `structure-${next}`)) {
        next += 1;
      }
      id = `structure-${next}`;
    }
    used.add(id);
    return { ...structure, id };
  });
}

/** A new structure of `kind` on a host side, with an id unused by `existing`. */
export function createRoofStructure(kind, placement, existing = []) {
  const [created] = normalizeRoofStructures([...existing, { ...placement, kind, id: null }]).slice(-1);
  return created;
}

/**
 * The frame of a host side: `along` is the axis the side runs along,
 * `inward` the axis pointing into the host, and `sign` the inward direction
 * on that axis.
 */
export function structureFrame(side) {
  return {
    minZ: { along: 'x', inward: 'z', sign: 1 },
    maxZ: { along: 'x', inward: 'z', sign: -1 },
    minX: { along: 'z', inward: 'x', sign: 1 },
    maxX: { along: 'z', inward: 'x', sign: -1 },
  }[side];
}

const axisKeys = (axis) => (axis === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ']);
const pointOn = (frame, along, inward) => (frame.along === 'x' ? [along, inward] : [inward, along]);
const error = (code, message) => ({ code, message });

/**
 * The highest point of the host roof over a plan rectangle (within the host
 * walls), in absolute height. The roof is a min of planes, so it is linear on
 * each face's region and its highest point is a corner of one of those
 * pieces (on the ridge, or where a hip meets it).
 */
function highestHostRoof(host, bounds) {
  if (host.skeletonFaces) {
    // the skeleton faces themselves (x, height, z), clipped to the rectangle
    const within = [
      (v) => v[0] - Math.max(bounds.minX, host.bounds.minX), (v) => Math.min(bounds.maxX, host.bounds.maxX) - v[0],
      (v) => v[2] - Math.max(bounds.minZ, host.bounds.minZ), (v) => Math.min(bounds.maxZ, host.bounds.maxZ) - v[2],
    ];
    const heights = host.skeletonFaces.flatMap((face) => within.reduce((piece, distance) => clipPolygon(piece, distance), face).map((v) => v[1]));
    return host.baseY + Math.max(0, ...heights);
  }
  return host.baseY + roofPeak(hostRoofFaces(host), clipToHostWalls(bounds, host));
}

/** Whether a plan point is inside a polygon (even-odd). */
function insidePolygon([x, z], polygon) {
  let inside = false;
  polygon.forEach(([x1, z1], i) => {
    const [x2, z2] = polygon[(i + 1) % polygon.length];
    if ((z1 > z) !== (z2 > z) && x < x1 + ((z - z1) * (x2 - x1)) / (z2 - z1)) {
      inside = !inside;
    }
  });
  return inside;
}

/** Whether a plan point is on one of a skeleton face region's polygons (or its edge). */
function onFaceRegion(point, region) {
  const nudge = 1e-6;
  return region.some((polygon) => insidePolygon(point, polygon)
    || [[nudge, 0], [-nudge, 0], [0, nudge], [0, -nudge]].some(([dx, dz]) => insidePolygon([point[0] + dx, point[1] + dz], polygon)));
}

/**
 * The highest point of a min-of-planes roof over a convex plan polygon
 * (height above its plate). The roof is linear on each plane's region, so the
 * highest point is a corner of one of those regions (on a ridge, or where a
 * hip meets it).
 */
export function roofPeak(planes, polygon) {
  let highest = -Infinity;
  planes.forEach((plane, index) => {
    let piece = polygon;
    planes.forEach((other, k) => {
      if (k !== index && piece.length) {
        piece = clipPolygon(piece, ([x, z]) => evalPlaneHeight(other, x, z) - evalPlaneHeight(plane, x, z));
      }
    });
    piece.forEach(([x, z]) => {
      highest = Math.max(highest, evalPlaneHeight(plane, x, z));
    });
  });
  return highest;
}

/** Every face of a host roof as a plane (a flat roof: its slab top). */
function hostRoofFaces(host) {
  return host.planes?.length ? host.planes : [{ constantHeight: host.slabThickness ?? 0 }];
}

/** A plan rectangle as a polygon, clipped to within the host's walls. */
function clipToHostWalls(bounds, host) {
  return [
    ([x]) => x - host.bounds.minX, ([x]) => host.bounds.maxX - x,
    ([, z]) => z - host.bounds.minZ, ([, z]) => host.bounds.maxZ - z,
  ].reduce(
    (polygon, distance) => clipPolygon(polygon, distance),
    [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]]
  );
}

/** Each side and the one a quarter turn from it (the same end of the other axis). */
const TURNED_SIDE = Object.freeze({ minX: 'minZ', minZ: 'minX', maxX: 'maxZ', maxZ: 'maxX' });

/** The host roof plane a structure on `side` rises out of (flat roofs: the slab top). */
function hostFacePlane(host, side) {
  if (!host.planes?.length) {
    return host.roofType === 'flat' ? { constantHeight: host.slabThickness ?? 0 } : null;
  }
  return host.planes.find((plane) => plane.side === side) ?? null;
}

/**
 * Resolves one structure against its host's roof zone descriptor
 * (`roofZones` from createBuildingFromFootprint): its plan rectangle, sill
 * and plate elevations, its own roof planes, and where it meets the host
 * roof. The result has the zone descriptor shape (`bounds`, `baseY` at its
 * plate, `planes`, `slabThickness`), so `volumeSolid` accepts it.
 *
 * A dormer's roof never rises above the host ridge: with `join: 'auto'`
 * a taller roof is lowered to it (reported as a warning); with
 * `'snap-ridge'` it is always set to meet it. A shed dormer too steep to meet
 * the host plane before the ridge is snapped the same way. A structure
 * standing on a base (`baseHeight`, a porch) replaces the host roof inside
 * its footprint instead: it is not capped and may span several roof faces.
 *
 * When a structure doesn't fit (it crosses a hip or valley, rises above the
 * ridge, or runs past its face or wall), the error says what would: the
 * widest width, and failing that the tallest wall height, at which it
 * does (`fix: { width }` or `fix: { wallHeight }`, also in the message).
 *
 * @param {object} structure - a normalized record
 * @param {object|undefined} host - the host volume's roof zone descriptor
 * @param {object} [config] - building defaults (`roofPitchRise`, `roofPitchRun`)
 * @returns {{ resolved: object|null, errors: Array<{code: string, message: string, fix?: object}>, warnings: Array<{code: string, message: string}> }}
 */
export function resolveRoofStructure(structure, host, config = {}) {
  const result = resolveStructureOnce(structure, host, config);
  const [first] = result.errors;
  if (!first || !FIXABLE.includes(first.code)) {
    return result;
  }
  const fix = suggestFit(structure, host, config);
  if (fix) {
    const meters = (value) => `${value.toFixed(2)} m`;
    first.fix = fix;
    first.message += 'width' in fix
      ? ` It fits at ${meters(fix.width)} wide (${meters(structure.width - fix.width)} narrower).`
      : ` It fits with ${meters(fix.wallHeight)} walls (${meters(structure.wallHeight - fix.wallHeight)} lower).`;
  }
  return result;
}

/** The refusals a smaller structure can get past. */
const FIXABLE = ['crosses-face', 'above-ridge', 'outside-face', 'outside-host'];

/**
 * The largest structure like this one that fits, narrowing it about its
 * center first (in 5 cm steps) and failing that lowering its walls; null if
 * neither does.
 */
function suggestFit(structure, host, config) {
  const fits = (fields) => !resolveStructureOnce({ ...structure, ...fields }, host, config).errors.length;
  for (let width = structure.width - 0.05; width >= 0.3; width -= 0.05) {
    if (fits({ width })) {
      return { width: Math.round(width * 100) / 100 };
    }
  }
  for (let wallHeight = structure.wallHeight - 0.05; wallHeight >= 0.2; wallHeight -= 0.05) {
    if (fits({ wallHeight })) {
      return { wallHeight: Math.round(wallHeight * 100) / 100 };
    }
  }
  return null;
}

function resolveStructureOnce(structure, host, config = {}) {
  const errors = [];
  const warnings = [];
  const fail = (code, message) => {
    errors.push(error(code, message));
    return { resolved: null, errors, warnings };
  };
  if (!host) {
    return fail('host-missing', `Host volume ${structure.hostVolumeId} does not exist or has no analytic roof.`);
  }
  // A continuous (straight-skeleton) hip over several volumes is planar on
  // each face but not the min of one volume's planes everywhere, so it hosts
  // only what meets a single face (a dormer) or stands on it (a cupola).
  if (!host.exact && !host.roofPieces) {
    return fail('host-inexact', `Host volume ${host.volumeId} has a merged roof whose surface is not planar enough to host a structure.`);
  }
  if (!(structure.width > GEOMETRY_EPSILON) || !(structure.wallHeight > GEOMETRY_EPSILON)
    || (structure.depth !== null && !(structure.depth > GEOMETRY_EPSILON))) {
    return fail('invalid-dimensions', 'Width, wall height, and depth must be positive.');
  }
  // A structure standing on a base (a porch) sits on the plate and replaces
  // the host roof inside its footprint, so it can face any side; one rising
  // out of the roof (a dormer) needs a roof slope on its side to rise from.
  const standing = structure.baseHeight !== null;
  const through = structure.mount === 'through';
  if (through && standing) {
    return fail('mount-conflict', 'A structure rising through the roof takes its base from the roof; it cannot also have a base height.');
  }
  if (through && (structure.inset ?? 0) > GEOMETRY_EPSILON) {
    return fail('inset-not-supported', 'A structure rising through the roof cannot have an inset.');
  }
  // A dormer faces down its slope, so if the host ridge turns (a gable
  // end where the slope was) it follows to the slope turned the same way,
  // at the same offset along that wall.
  if (!standing && !through && !hostFacePlane(host, structure.hostSide) && hostFacePlane(host, TURNED_SIDE[structure.hostSide])) {
    warnings.push(error('side-turned', `${host.volumeId}'s ${structure.hostSide} side is not a roof slope; the dormer faces its ${TURNED_SIDE[structure.hostSide]} slope instead.`));
    structure = { ...structure, hostSide: TURNED_SIDE[structure.hostSide] };
  }
  const face = hostFacePlane(host, structure.hostSide);
  if (!face && !standing && !through) {
    return fail('side-not-sloped', `The ${structure.hostSide} side of ${host.volumeId} is not a roof slope (a gable end or a shed's high or rake side).`);
  }
  const sloped = Boolean(face) && !('constantHeight' in face);
  if (structure.setback === 'center' && structure.depth === null) {
    return fail('depth-required', 'A centered structure needs an explicit depth.');
  }
  if (structure.setback < -GEOMETRY_EPSILON && structure.baseHeight === null && !through) {
    return fail('needs-base', 'A structure projecting past the host wall needs a base height.');
  }

  const frame = structureFrame(structure.hostSide);
  const [alongMinKey, alongMaxKey] = axisKeys(frame.along);
  const [inwardMinKey, inwardMaxKey] = axisKeys(frame.inward);
  const hostAlong = [host.bounds[alongMinKey], host.bounds[alongMaxKey]];
  const alongCenter = (hostAlong[0] + hostAlong[1]) / 2 + structure.offset;
  const along = [alongCenter - structure.width / 2, alongCenter + structure.width / 2];
  // a tower may stand on the corner, past the end of its wall
  const planned = Boolean(structure.plan);
  if (!(planned && structure.baseHeight !== null)
    && (along[0] < hostAlong[0] - GEOMETRY_EPSILON || along[1] > hostAlong[1] + GEOMETRY_EPSILON)) {
    return fail('outside-host', `The structure runs past the ends of ${host.volumeId}'s ${structure.hostSide} wall.`);
  }
  // a wraparound's leg runs on past the corner it turns, by its projection
  if (structure.wrapExtend) {
    along[0] -= structure.wrapExtend.min ?? 0;
    along[1] += structure.wrapExtend.max ?? 0;
  }

  if (structure.wrap || structure.wrapSegment) {
    if (!(structure.baseHeight !== null && structure.setback < -GEOMETRY_EPSILON)) {
      return fail('wrap-not-porch', 'Only a porch projecting past its wall can wrap around a corner.');
    }
    if (structure.depth !== null && Math.abs(structure.depth + structure.setback) > WRAP_TOLERANCE) {
      return fail('wrap-depth', 'A wraparound stands wholly outside the walls: its depth must equal its projection.');
    }
    if (!['hip', 'shed'].includes(structure.roofType)) {
      return fail('wrap-roof', 'A wraparound takes a hip or shed roof, which turns the corner on a hip.');
    }
  }

  const wall = host.bounds[structure.hostSide];
  const setback = structure.setback === 'center'
    ? (host.bounds[inwardMaxKey] - host.bounds[inwardMinKey] - structure.depth) / 2
    : structure.setback;
  const front = wall + frame.sign * setback;
  let back;
  if (through && structure.depth === null) {
    return fail('depth-required', 'A structure rising through the roof needs an explicit depth.');
  } else if (structure.depth !== null) {
    back = front + frame.sign * structure.depth;
  } else if (!sloped) {
    return fail('depth-required', 'A structure needs an explicit depth on a flat roof or a gable end.');
  } else if (host.roofType === 'shed') {
    back = host.bounds[frame.sign > 0 ? inwardMaxKey : inwardMinKey];
  } else {
    back = (host.bounds[inwardMinKey] + host.bounds[inwardMaxKey]) / 2;
  }
  if (frame.sign * (back - front) <= GEOMETRY_EPSILON) {
    return fail('outside-face', 'The setback puts the front wall at or past the host ridge.');
  }
  const inward = [Math.min(front, back), Math.max(front, back)];
  const bounds = frame.along === 'x'
    ? { minX: along[0], maxX: along[1], minZ: inward[0], maxZ: inward[1] }
    : { minX: inward[0], maxX: inward[1], minZ: along[0], maxZ: along[1] };

  const hostFaceY = ([x, z]) => host.baseY + evalPlaneHeight(face ?? { constantHeight: 0 }, x, z);
  if (structure.baseHeight === 'ground' && !Number.isFinite(host.foundationTopY)) {
    return fail('host-missing', `Host ${host.volumeId} has no ground level to stand on.`);
  }
  if (through && [front, back].some((line) => frame.sign * (line - wall) < -GEOMETRY_EPSILON
    || frame.sign * (line - host.bounds[frame.sign > 0 ? inwardMaxKey : inwardMinKey]) > GEOMETRY_EPSILON)) {
    return fail('outside-host', `A structure rising through the roof must stand within ${host.volumeId}'s walls.`);
  }
  const sillY = structure.baseHeight === 'ground'
    ? host.foundationTopY
    : structure.baseHeight !== null
    ? host.baseY + structure.baseHeight
    : through
    ? highestHostRoof(host, bounds)
    : hostFaceY(pointOn(frame, alongCenter, front));
  const plateY = sillY + structure.wallHeight;
  if (structure.mount === 'recess') {
    return resolveRecess(structure, host, {
      frame, bounds, along, front, back, wall, setback, sillY, plateY, errors, warnings, fail,
    });
  }

  const projecting = setback < -GEOMETRY_EPSILON;
  const groundLevel = Number.isFinite(host.foundationTopY) && sillY <= host.foundationTopY + GEOMETRY_EPSILON;
  // an entry hood hangs on brackets from the wall over a door
  const hood = structure.kind === 'hood';
  if (hood && !(projecting && structure.baseHeight !== null)) {
    return fail('hood-placement', 'An entry hood projects from its wall, at a height above the floor.');
  }
  let support = hood ? 'brackets' : structure.support ?? 'auto';
  if (support === 'auto') {
    support = !projecting ? 'none' : (groundLevel ? 'deck' : 'posts');
  }
  if (support !== 'none' && !projecting) {
    return fail('support-not-projecting', `A ${support} support only holds up a structure projecting past its host wall.`);
  }
  if (support === 'brackets' && -setback > MAX_BRACKET_PROJECTION + GEOMETRY_EPSILON) {
    return fail('brackets-too-deep', `Brackets carry at most ${MAX_BRACKET_PROJECTION} m of projection.`);
  }
  if (support !== 'none' && !Number.isFinite(host.foundationTopY)) {
    return fail('host-missing', `Host ${host.volumeId} has no ground level for a ${support} support.`);
  }

  if (planned) {
    return resolvePlanned(structure, host, {
      frame, bounds, along, front, back, wall, setback, sillY, plateY, projecting, groundLevel, through, errors, warnings, fail, config,
    });
  }

  // The structure's own roof.
  const { roofType } = structure;
  // a dormer's ridge always runs into the roof, square to the host ridge
  const ridgeAxis = roofType === 'shed' || (structure.ridge === 'parallel' && (standing || through)) ? frame.along : frame.inward;
  const roofHighEdge = roofType === 'shed' ? `${frame.inward}-${frame.sign > 0 ? 'max' : 'min'}` : undefined;
  const acrossExtent = ridgeAxis === 'x' ? bounds.maxZ - bounds.minZ : bounds.maxX - bounds.minX;
  const span = roofType === 'shed' ? inward[1] - inward[0] : acrossExtent / 2;
  const shape = structure.roofShape ?? { mode: 'slope', pitchRise: config.roofPitchRise ?? 6 };
  const pitchRun = config.roofPitchRun ?? 12;
  let roofHeight = 0;
  let roofPitchRise = 0;
  let roofPitchRun = pitchRun;
  if (roofType !== 'flat') {
    if (shape.mode === 'height') {
      roofHeight = shape.height;
      [roofPitchRise, roofPitchRun] = [shape.height, span];
    } else {
      roofHeight = span * (shape.pitchRise / pitchRun);
      roofPitchRise = shape.pitchRise;
    }
  }

  // The ridge cap and the single-face rule below apply only to structures
  // rising out of the roof (dormers).
  if (sloped && !standing && !through) {
    const hostTopY = host.baseY + host.roofHeight;
    const topY = plateY + (roofType === 'flat' ? FLAT_ROOF_THICKNESS : roofHeight);
    if (roofType === 'flat' || plateY >= hostTopY - GEOMETRY_EPSILON) {
      if (topY > hostTopY + GEOMETRY_EPSILON) {
        return fail('above-ridge', `The structure's ${roofType === 'flat' ? 'roof' : 'plate'} is above the host ridge.`);
      }
    } else if (structure.join === 'snap-ridge' || topY > hostTopY + GEOMETRY_EPSILON) {
      if (structure.join !== 'snap-ridge') {
        warnings.push(error('ridge-capped', 'The structure\'s roof was lowered to meet the host ridge.'));
      }
      roofHeight = hostTopY - plateY;
      // keep the faces planar through the new peak
      [roofPitchRise, roofPitchRun] = [roofHeight, span];
    }
  }

  const planeConfig = {
    roofHeight, roofDirection: ridgeAxis, roofHighEdge, roofPitchRise, roofPitchRun,
  };
  let planes = computeVolumeEavePlanes(bounds, roofType, planeConfig);
  // A hip porch projecting from a wall is a hipped shed: it slopes from its
  // front and ends only, running level into the wall (no slope back down to
  // it). One standing on a roof, with nothing behind it, keeps its full hip.
  let eaveRoof = null;
  if (standing && roofType === 'hip' && setback < -GEOMETRY_EPSILON && roofPitchRun > 0) {
    const walls = structureWallSides(frame);
    const eaveSides = [walls.front, walls.left, walls.right];
    planes = eaveSides.map((side) => makeEavePlane(bounds, side, roofPitchRise / roofPitchRun));
    roofHeight = roofPeak(planes, [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]]);
    eaveRoof = { eaveSides };
  }
  const slabThickness = roofType === 'flat' ? FLAT_ROOF_THICKNESS : 0;
  // A porch whose roof rises through the host eave meets the host roof in
  // valleys; builders usually keep it below the eave instead (fewer joins,
  // less risk of a leak), so say so.
  if (standing && projecting && plateY < host.wallTopY - GEOMETRY_EPSILON) {
    const [x, z] = pointOn(frame, (along[0] + along[1]) / 2, wall);
    const roofAtWall = plateY + (planes.length ? evalZoneHeight(planes, x, z) : slabThickness);
    const profile = hostEaveProfile(host, structure.hostSide, (along[0] + along[1]) / 2);
    const atWall = profile?.outline.filter(([u]) => Math.abs(u - wall) < 1e-9).map(([, v]) => v) ?? [];
    if (atWall.length && roofAtWall > host.baseY + Math.min(...atWall) + GEOMETRY_EPSILON) {
      warnings.push(error('above-eave', 'The porch roof rises through the host eave. Porches are usually kept below it (a lower pitch or wall height), which avoids a valley and a likely leak.'));
    }
  }
  const topAt = planes.length
    ? (point) => plateY + evalZoneHeight(planes, point[0], point[1])
    : () => plateY + slabThickness;

  // Where the structure stands in the host roof: its rectangle, within the
  // host walls, where its own roof is above the host face. Each roof plane
  // minus the (linear) host face is linear, so this is an exact convex clip.
  let hostContact = [
    [bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ],
  ];
  const within = [
    ([x]) => x - host.bounds.minX, ([x]) => host.bounds.maxX - x,
    ([, z]) => z - host.bounds.minZ, ([, z]) => host.bounds.maxZ - z,
  ];
  const aboveHost = !face ? [] : planes.length
    ? planes.map((plane) => ([x, z]) => plateY + evalPlaneHeight(plane, x, z) - hostFaceY([x, z]))
    : [(point) => plateY + slabThickness - hostFaceY(point)];
  [...within, ...aboveHost].forEach((distance) => {
    hostContact = clipPolygon(hostContact, distance);
  });
  // on a skeleton hip the face is the roof only over its own region
  if (host.skeleton && face && !through && !standing
    && !hostContact.every((point) => onFaceRegion(point, host.faceRegions?.[structure.hostSide] ?? []))) {
    return fail('crosses-face', `The structure runs off ${host.volumeId}'s ${structure.hostSide} roof face into a hip or valley.`);
  }
  // The host roof the structure removes: where the host roof lies under the
  // structure's roof. The host roof is a union of convex pieces, each under
  // one plane: for a min of planes, each face's own region (where it is the
  // lowest plane); for a roof cut from a larger one, its `roofPieces`. The
  // removed roof is each piece where the structure's roof is above it. A
  // dormer stands on one face, so its piece is its `hostContact`.
  const hostPieces = host.roofPieces ?? hostRoofFaces(host).map((plane, index, faces) => ({
    plane,
    polygon: faces.reduce((piece, other, k) => (k === index || !piece.length
      ? piece
      : clipPolygon(piece, ([x, z]) => evalPlaneHeight(other, x, z) - evalPlaneHeight(plane, x, z))), clipToHostWalls(host.bounds, host)),
  }));
  // The host roof under the structure's roof, piece by host face: the face's
  // region within the structure's rectangle, where the structure's roof is
  // above that face.
  const piecesUnder = () => hostPieces.map(({ plane: hostFace, polygon }) => {
    let piece = [
      ([x]) => x - bounds.minX, ([x]) => bounds.maxX - x, ([, z]) => z - bounds.minZ, ([, z]) => bounds.maxZ - z,
    ].reduce((clipped, distance) => (clipped.length ? clipPolygon(clipped, distance) : clipped), polygon);
    const faceY = ([x, z]) => host.baseY + evalPlaneHeight(hostFace, x, z);
    (planes.length
      ? planes.map((plane) => ([x, z]) => plateY + evalPlaneHeight(plane, x, z) - faceY([x, z]))
      : [(point) => plateY + slabThickness - faceY(point)]
    ).forEach((distance) => {
      piece = clipPolygon(piece, distance);
    });
    return { plane: hostFace, piece };
  }).filter(({ piece }) => piece.length >= 3 && Math.abs(piece.reduce((sum, [x, z], i) => {
    const [nx, nz] = piece[(i + 1) % piece.length];
    return sum + x * nz - nx * z;
  }, 0)) > 1e-9);
  // A dormer on a mansard or gambrel may run up its side's lower slope and
  // on past the break into the upper slope (the full shed dormer of a Dutch
  // Colonial); it still may not cross a hip, ridge, or valley.
  let breakPieces = null;
  if (sloped && !standing && !through && TWO_SLOPE_ROOF_TYPES.includes(host.roofType)) {
    const under = piecesUnder();
    if (under.some(({ plane }) => plane.side !== structure.hostSide)) {
      return fail('crosses-face', 'The structure crosses a hip, ridge, or valley of the host roof; it must stand on one side of it.');
    }
    breakPieces = under.map(({ piece }) => piece);
    const lower = under.find(({ plane }) => plane.tier !== 'upper');
    if (lower) {
      hostContact = lower.piece;
    }
  }
  const removedRoof = through
    ? []
    : breakPieces
    ? breakPieces
    : standing
    ? hostPieces.map(({ plane: hostFace, polygon }) => {
      let piece = [
        ([x]) => x - bounds.minX, ([x]) => bounds.maxX - x, ([, z]) => z - bounds.minZ, ([, z]) => bounds.maxZ - z,
      ].reduce((clipped, distance) => (clipped.length ? clipPolygon(clipped, distance) : clipped), polygon);
      const faceY = ([x, z]) => host.baseY + evalPlaneHeight(hostFace, x, z);
      (planes.length
        ? planes.map((plane) => ([x, z]) => plateY + evalPlaneHeight(plane, x, z) - faceY([x, z]))
        : [(point) => plateY + slabThickness - faceY(point)]
      ).forEach((distance) => {
        piece = clipPolygon(piece, distance);
      });
      return piece;
    }).filter((piece) => piece.length >= 3)
    : [hostContact].filter((piece) => piece.length >= 3);

  // An inset front wall leaves an open porch in front of it. Its floor is
  // the sill, so the whole recess must be where the host roof is gone: for a
  // dormer, inside the part of the roof it replaces (its back corners inside
  // `hostContact`, which is convex and holds the front corners).
  const inset = structure.inset ?? 0;
  const inner = front + frame.sign * inset;
  if (inset > GEOMETRY_EPSILON) {
    if (frame.sign * (back - inner) <= GEOMETRY_EPSILON) {
      return fail('inset-too-deep', 'The inset puts the front wall at or past the back of the structure.');
    }
    if (!standing) {
      const corners = [pointOn(frame, along[0], inner), pointOn(frame, along[1], inner)];
      const insideContact = (point) => hostContact.length >= 3 && hostContact.every(([x0, z0], i) => {
        const [x1, z1] = hostContact[(i + 1) % hostContact.length];
        const area = hostContact.reduce((sum, [ax, az], k) => {
          const [bx, bz] = hostContact[(k + 1) % hostContact.length];
          return sum + ax * bz - bx * az;
        }, 0);
        return Math.sign(area) * ((x1 - x0) * (point[1] - z0) - (z1 - z0) * (point[0] - x0)) >= -1e-6;
      });
      if (!corners.every(insideContact)) {
        return fail('inset-too-deep', 'The recess runs back under the host roof; reduce the inset or raise the walls.');
      }
    }
  }

  if (hostContact.length < 3 && structure.baseHeight === null && !through) {
    return fail('no-contact', 'The structure does not meet the host roof.');
  }
  if (sloped && !standing && !through && !breakPieces && hostContact.some(([x, z]) => evalPlaneHeight(face, x, z) > evalZoneHeight(host.planes, x, z) + GEOMETRY_EPSILON)) {
    return fail('crosses-face', 'The structure crosses a hip, ridge, or valley of the host roof; it must stand on one roof face.');
  }

  return {
    resolved: {
      id: structure.id,
      kind: structure.kind,
      hostVolumeId: host.volumeId,
      hostSide: structure.hostSide,
      frame,
      bounds,
      along,
      front,
      back,
      sillY,
      plateY,
      baseY: plateY,
      roofType,
      ridgeAxis,
      roofHighEdge,
      roofHeight,
      roofPitchRise,
      roofPitchRun,
      planes,
      slabThickness,
      topY: topAt([(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2]),
      hostContact: hostContact.length >= 3 && !standing && !through ? hostContact : [],
      removedRoof,
      // the front wall stands on the host wall line: it carries the wall up through the eave
      flush: !through && Math.abs(setback) <= GEOMETRY_EPSILON,
      through,
      setback,
      // its front wall is out past the host wall (a projecting porch)
      projecting,
      support,
      wallLine: host.bounds[structure.hostSide],
      foundationTopY: host.foundationTopY,
      hostStructureId: structure.hostStructureId,
      standing,
      // an inset leaves the front open; the recess behind it has its own inner wall
      openSides: [...new Set([
        ...(inset > GEOMETRY_EPSILON ? ['front'] : []), ...structure.openSides, ...(structure.seamSides ?? []),
      ])],
      // where a wraparound's two segments meet (and its front segment's back): no wall, post, header, or railing
      seamSides: structure.seamSides ?? [],
      // an entry hood: its roof alone, on brackets, with a ceiling under it
      hood,
      // a roof rising from these eaves only (see eaveRoofTriangles)
      eaveRoof,
      // the record it was built from (a wraparound's side segment is part of its porch)
      recordId: structure.wrapOf ?? structure.id,
      wrapSegment: structure.wrapSegment ?? null,
      inset,
      innerLine: inner,
      eaves: structure.eaves,
      materials: structure.materials,
    },
    errors,
    warnings,
  };
}

/**
 * A structure with a polygonal plan (see `plan`: a canted bay window, an
 * octagonal or round tower): its outline in plan, and a hip roof rising
 * from its outer edges (for a bay against a wall; every edge for a tower,
 * giving a pyramid, or with many sides a cone) or a flat one. It is built by
 * its own path (see buildPlanned in js/extrusion.js): walls on each edge,
 * the roof face by face with its eave trim, and a foundation under one at
 * ground level.
 */
function resolvePlanned(structure, host, {
  frame, bounds, along, front, back, wall, setback, sillY, plateY, projecting, groundLevel, through, errors, warnings, fail, config,
}) {
  if (structure.baseHeight === null && !through) {
    return fail('plan-needs-base', 'A canted or polygonal structure stands on a base or rises through the roof; a dormer is rectangular.');
  }
  if (!['hip', 'flat'].includes(structure.roofType)) {
    return fail('plan-roof', 'A canted or polygonal structure takes a hip (or cone) or a flat roof.');
  }
  const at = (a, i) => pointOn(frame, a, i);
  const [a0, a1] = along;
  let outline;
  if (structure.plan.shape === 'canted') {
    // the sides run from the wall line out to the front at the angle
    const projection = Math.abs(front - wall);
    const inset = projection / Math.tan((structure.plan.angle * Math.PI) / 180);
    if (!projecting || 2 * inset >= a1 - a0 - GEOMETRY_EPSILON) {
      return fail('plan-canted', 'A canted bay projects past its wall, and is wider than its two angled sides.');
    }
    const points = [[a0, back], [a0, wall], [a0 + inset, front], [a1 - inset, front], [a1, wall], [a1, back]];
    outline = points.filter((point, i) => i === 0 || Math.hypot(point[0] - points[i - 1][0], point[1] - points[i - 1][1]) > GEOMETRY_EPSILON)
      .filter((point, i, list) => i < list.length - 1 || Math.hypot(point[0] - list[0][0], point[1] - list[0][1]) > GEOMETRY_EPSILON)
      .map(([a, i]) => at(a, i));
  } else {
    // a regular polygon inscribed in the rectangle, a side square to the front
    const { sides } = structure.plan;
    const center = [(a0 + a1) / 2, (front + back) / 2];
    const radii = [(a1 - a0) / 2, Math.abs(back - front) / 2];
    outline = Array.from({ length: sides }, (_, k) => {
      const theta = (2 * Math.PI * k) / sides + Math.PI / sides;
      return at(center[0] + radii[0] * Math.cos(theta), center[1] + radii[1] * Math.sin(theta));
    });
  }
  // counterclockwise in plan
  const signedArea = outline.reduce((sum, [x, z], i) => {
    const [nx, nz] = outline[(i + 1) % outline.length];
    return sum + x * nz - nx * z;
  }, 0);
  if (signedArea < 0) {
    outline.reverse();
  }
  const center = [outline.reduce((sum, [x]) => sum + x, 0) / outline.length, outline.reduce((sum, [, z]) => sum + z, 0) / outline.length];
  const outside = ([x, z]) => frame.sign * ((frame.inward === 'x' ? x : z) - wall) < -GEOMETRY_EPSILON;
  // a bay's roof slopes from its outer edges only; a tower's (standing clear of the wall line) from every edge
  const edges = outline.map((point, i) => [point, outline[(i + 1) % outline.length]]);
  const eaveEdges = structure.plan.shape === 'canted'
    ? edges.filter(([p, q]) => outside([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]))
    : edges;
  const shape = structure.roofShape ?? { mode: 'slope', pitchRise: config.roofPitchRise ?? 6 };
  const pitchRun = config.roofPitchRun ?? 12;
  const slope = shape.mode === 'height'
    ? shape.height / Math.max(GEOMETRY_EPSILON, Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2)
    : shape.pitchRise / pitchRun;
  const planes = structure.roofType === 'hip' ? eaveEdges.map(([p, q]) => makeEdgePlane(p, q, slope, center)) : [];
  const slabThickness = structure.roofType === 'flat' ? FLAT_ROOF_THICKNESS : 0;
  const roofHeight = planes.length ? roofPeak(planes, outline) : 0;
  const xs = outline.map(([x]) => x);
  const zs = outline.map(([, z]) => z);
  const outlineBounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  return {
    resolved: {
      id: structure.id,
      recordId: structure.id,
      kind: structure.kind,
      hostVolumeId: host.volumeId,
      hostSide: structure.hostSide,
      frame,
      bounds: outlineBounds,
      outline,
      eaveEdges: eaveEdges.map(([p]) => outline.indexOf(p)),
      planned: structure.plan.shape,
      along,
      front,
      back,
      sillY,
      plateY,
      baseY: plateY,
      roofType: structure.roofType,
      roofHeight,
      roofPitchRise: slope * pitchRun,
      roofPitchRun: pitchRun,
      planes,
      slabThickness,
      topY: plateY + (planes.length ? roofHeight : slabThickness),
      hostContact: [],
      removedRoof: [],
      flush: false,
      through,
      setback,
      projecting,
      // at ground level a foundation carries it; above, it is cantilevered
      // (an oriel), or carried on a corbel (a turret on brackets)
      support: projecting && groundLevel ? 'deck' : (!groundLevel && structure.support === 'brackets' ? 'brackets' : 'none'),
      wallLine: wall,
      foundationTopY: host.foundationTopY,
      hostStructureId: structure.hostStructureId,
      standing: structure.baseHeight !== null,
      openSides: [],
      seamSides: [],
      inset: 0,
      eaves: structure.eaves,
      materials: structure.materials,
    },
    errors,
    warnings,
  };
}

/**
 * A structure recessed into its host's walls under the host roof (an
 * integral porch, a recessed entry, an upper-story loggia): a box from its
 * floor to its ceiling, open at the host wall. The host's walls are cut away
 * across it and the host roof and eave run on over it; it adds its own back
 * and closed side walls, a ceiling, posts at its open corners, and a floor
 * when above the ground. It stands on a base (`baseHeight`), has an explicit
 * depth, no setback, and must fit inside the host below its wall top.
 */
function resolveRecess(structure, host, {
  frame, bounds, along, front, back, wall, setback, errors, warnings, fail, ...levels
}) {
  if (structure.baseHeight === null) {
    return fail('recess-needs-base', 'A recessed porch needs a floor level: the ground, or a height below the host plate.');
  }
  // a floor level inside the walls is measured from their top (the plate), not the lifted roof
  const sillY = structure.baseHeight === 'ground' || !Number.isFinite(host.wallTopY)
    ? levels.sillY
    : host.wallTopY + structure.baseHeight;
  const plateY = sillY + structure.wallHeight;
  if (structure.depth === null || Math.abs(setback) > GEOMETRY_EPSILON) {
    return fail('recess-placement', 'A recessed porch starts at the host wall (no setback) and needs an explicit depth.');
  }
  const [inwardMinKey, inwardMaxKey] = axisKeys(frame.inward);
  const farWall = host.bounds[frame.sign > 0 ? inwardMaxKey : inwardMinKey];
  if (frame.sign * (back - farWall) > GEOMETRY_EPSILON) {
    return fail('outside-host', `The recess runs past the far wall of ${host.volumeId}.`);
  }
  if (plateY > host.wallTopY + GEOMETRY_EPSILON) {
    return fail('recess-too-tall', `The recess's ceiling is above ${host.volumeId}'s wall top; it must stay under the roof.`);
  }
  if (Number.isFinite(host.foundationTopY) && sillY < host.foundationTopY - GEOMETRY_EPSILON) {
    return fail('recess-too-low', 'The recess\'s floor is below the host\'s ground floor.');
  }
  // the front is open; a side on the host's outside wall (a corner recess) may be too
  const openSides = [...new Set(['front', ...structure.openSides])];
  return {
    resolved: {
      id: structure.id,
      recordId: structure.id,
      kind: structure.kind,
      hostVolumeId: host.volumeId,
      hostSide: structure.hostSide,
      frame,
      bounds,
      along,
      front,
      back,
      sillY,
      plateY,
      baseY: plateY,
      roofType: 'flat',
      roofHeight: 0,
      planes: [],
      slabThickness: 0,
      topY: plateY,
      hostContact: [],
      removedRoof: [],
      flush: false,
      through: false,
      recess: true,
      setback: 0,
      projecting: false,
      support: 'none',
      wallLine: wall,
      foundationTopY: host.foundationTopY,
      hostStructureId: structure.hostStructureId,
      standing: true,
      openSides,
      seamSides: [],
      inset: 0,
      eaves: structure.eaves,
      materials: structure.materials,
    },
    errors,
    warnings,
  };
}

/**
 * Where a structure actually stands, in plan, as convex polygons: the host
 * roof it removes, plus any part projecting past the host wall. Its buried
 * back (running on under the host roof to the ridge) is clipped away when it
 * is built, so it does not count.
 */
function occupiedPlan(resolved, host) {
  if (resolved.recess) {
    // under the host roof, below anything standing on it
    return [];
  }
  const { frame, bounds } = resolved;
  const wall = host.bounds[resolved.hostSide];
  const rectangle = [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
  const outside = resolved.projecting
    ? clipPolygon(rectangle, ([x, z]) => frame.sign * (wall - (frame.inward === 'x' ? x : z)))
    : [];
  const through = resolved.through ? [clipToHostWalls(bounds, host)] : [];
  return [...resolved.removedRoof, outside, ...through].filter((polygon) => polygon.length >= 3);
}

/** Whether two convex plan polygons overlap by more than a sliver (separating axis test). */
function convexOverlap(a, b) {
  return ![a, b].some((polygon) => polygon.some(([x0, z0], i) => {
    const [x1, z1] = polygon[(i + 1) % polygon.length];
    const length = Math.hypot(x1 - x0, z1 - z0);
    if (length < GEOMETRY_EPSILON) {
      return false;
    }
    const axis = [(z0 - z1) / length, (x1 - x0) / length];
    const project = (points) => points.map(([x, z]) => x * axis[0] + z * axis[1]);
    const [pa, pb] = [project(a), project(b)];
    return Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= GEOMETRY_EPSILON;
  }));
}

/**
 * Resolves every structure against the building's roof zones and checks
 * them against each other: structures on the same host may not overlap where
 * they actually stand (see occupiedPlan; the later one in the list is
 * rejected). A structure standing on another (`hostStructureId`) is resolved
 * after its host, against the host's descriptor (see structureAsHost), and
 * gets `level` one above it. Results come back in list order, each with the
 * `host` descriptor it was resolved against.
 *
 * @returns {Array<{ id: string, structure: object, resolved: object|null, errors: Array<object>, warnings: Array<object> }>}
 */
export function validateRoofStructures(structures, roofZones, config = {}, { describeStructure } = {}) {
  const zones = new Map((roofZones ?? []).map((zone) => [zone.volumeId, zone]));
  const list = expandWraps(structures ?? [], zones);
  const results = new Map();
  const hosts = new Map(); // structure id -> its descriptor as a host
  const accepted = [];
  const resolveOne = (structure, chain = []) => {
    if (results.has(structure.id)) {
      return results.get(structure.id);
    }
    let host;
    let level = 0;
    if (structure.hostStructureId) {
      const hostStructure = list.find((candidate) => candidate.id === structure.hostStructureId);
      if (hostStructure && !chain.includes(hostStructure.id)) {
        const hostResult = resolveOne(hostStructure, [...chain, structure.id]);
        host = hosts.get(hostStructure.id);
        level = (hostResult.resolved?.level ?? 0) + 1;
      }
    } else {
      host = zones.get(structure.hostVolumeId);
    }
    const result = host || !structure.hostStructureId
      ? resolveRoofStructure(structure, host, config)
      : {
        resolved: null,
        errors: [error('host-missing', `Host structure ${structure.hostStructureId} does not exist, could not be built, or stands on this one.`)],
        warnings: [],
      };
    if (result.resolved?.recess) {
      // it opens onto the outside: not a wall shared with another volume
      const { frame, bounds, front, along } = result.resolved;
      const outside = (a) => (frame.inward === 'x' ? [front - frame.sign * 0.01, a] : [a, front - frame.sign * 0.01]);
      const probes = [along[0] + 0.01, (along[0] + along[1]) / 2, along[1] - 0.01].map(outside);
      const blocking = [...zones.values()].find((zone) => zone.volumeId !== structure.hostVolumeId && probes.some(([x, z]) => (
        x > zone.bounds.minX && x < zone.bounds.maxX && z > zone.bounds.minZ && z < zone.bounds.maxZ)));
      if (blocking) {
        result.errors.push(error('recess-not-outside', `The recess opens into ${blocking.volumeId}; it must open on an outside wall.`));
        result.resolved = null;
      }
    }
    if (result.resolved) {
      const hostId = structure.hostStructureId ?? structure.hostVolumeId;
      const plan = occupiedPlan(result.resolved, host);
      const clash = accepted.find((other) => other.hostId === hostId
        && other.plan.some((piece) => plan.some((mine) => convexOverlap(piece, mine))));
      if (clash) {
        result.errors.push(error('overlap', `Overlaps ${clash.id} on the same roof.`));
        result.resolved = null;
      } else {
        result.resolved = { ...result.resolved, level };
        accepted.push({ ...result.resolved, hostId, plan });
        hosts.set(structure.id, structureAsHost(result.resolved, host, describeStructure));
      }
    }
    const entry = { id: structure.id, structure, host, ...result };
    results.set(structure.id, entry);
    return entry;
  };
  const entries = list.map((structure) => resolveOne(structure));
  joinWrapRoofs(entries, [...zones.values()]);
  settleEaveRoofs(entries, [...zones.values()]);
  return entries;
}

/**
 * A wraparound porch (`wrap`, see normalizeWrap) as one rectangular leg per
 * wall. Each leg runs along its wall; where it turns a corner onto the next
 * wall it runs on past the corner by its projection (`wrapExtend`), so the
 * corner square is its, and the next leg starts at the corner. The first leg
 * keeps the porch's id, the others are `<id>-wrap`, `<id>-wrap-2`, ...; all
 * share the porch's projection, base, walls, and roof. Where legs meet, and
 * along the back of a leg running past a corner, are seams (`seamSides`).
 * The porch's front is every leg's front (and the outer side of each corner
 * square); its left and right are its two free ends.
 */
function expandWraps(structures, zones) {
  return structures.flatMap((structure) => {
    const host = zones.get(structure.hostVolumeId);
    if (!structure.wrap || structure.hostStructureId || !host) {
      return [structure];
    }
    const projection = Number.isFinite(structure.setback) ? -structure.setback : 0;
    if (!(projection > GEOMETRY_EPSILON)) {
      // nothing past the wall to turn the corner with: resolving says why
      return [{ ...structure, wrapSegment: 'leg', wrapOf: structure.id, wrapLeg: 0 }];
    }
    const { walls, startLength, endLength } = structure.wrap;
    const loop = walls.length === 4;
    const frontOpen = structure.openSides.includes('front');
    const endsOpen = structure.openSides.includes('left') || structure.openSides.includes('right');
    return walls.map((wall, i) => {
      const previous = i > 0 ? walls[i - 1] : (loop ? walls[walls.length - 1] : null);
      const next = i < walls.length - 1 ? walls[i + 1] : (loop ? walls[0] : null);
      const frame = structureFrame(wall);
      const [alongMin, alongMax] = axisKeys(frame.along);
      const names = structureWallSides(frame);
      const nameOf = (side) => ['left', 'right'].find((name) => names[name] === side);
      let [lo, hi] = [host.bounds[alongMin], host.bounds[alongMax]];
      const wrapExtend = {};
      const seamSides = [];
      const openSides = frontOpen ? ['front'] : [];
      if (next) {
        // on past the corner onto the next wall; its outer side is the porch's front
        wrapExtend[next === alongMax ? 'max' : 'min'] = projection;
        seamSides.push('back');
        if (frontOpen) {
          openSides.push(nameOf(next));
        }
      }
      if (previous) {
        seamSides.push(nameOf(previous));
      }
      if (!previous) {
        // the first leg's free end, `startLength` back from the corner it turns
        const cornerAtMax = next === alongMax;
        [lo, hi] = cornerAtMax ? [Math.max(lo, hi - startLength), hi] : [lo, Math.min(hi, lo + startLength)];
        if (endsOpen) {
          openSides.push(nameOf(cornerAtMax ? alongMin : alongMax));
        }
      }
      if (!next) {
        // the last leg's free end, `endLength` on from the corner it turns
        const cornerAtMax = previous === alongMax;
        [lo, hi] = cornerAtMax ? [Math.max(lo, hi - endLength), hi] : [lo, Math.min(hi, lo + endLength)];
        if (endsOpen) {
          openSides.push(nameOf(cornerAtMax ? alongMin : alongMax));
        }
      }
      return {
        ...structure,
        id: i === 0 ? structure.id : `${structure.id}-wrap${i === 1 ? '' : `-${i}`}`,
        wrap: i === 0 ? structure.wrap : null,
        wrapSegment: 'leg',
        wrapOf: structure.id,
        wrapLeg: i,
        wrapExtend,
        hostSide: wall,
        offset: (lo + hi) / 2 - (host.bounds[alongMin] + host.bounds[alongMax]) / 2,
        width: hi - lo,
        depth: projection,
        openSides,
        seamSides,
      };
    });
  });
}

/**
 * Whether a structure's side stands against a volume's wall: just outside it
 * is inside one of `zones` (a porch's end run up to a projection, or into
 * the inside corner of an L). A roof never slopes down onto such a side.
 */
function againstWall(resolved, side, zones) {
  const { bounds } = resolved;
  const acrossX = side === 'minX' || side === 'maxX';
  const out = bounds[side] + (side.startsWith('min') ? -0.01 : 0.01);
  const [lo, hi] = acrossX ? [bounds.minZ, bounds.maxZ] : [bounds.minX, bounds.maxX];
  return [0.25, 0.5, 0.75].some((t) => {
    const along = lo + (hi - lo) * t;
    const [x, z] = acrossX ? [out, along] : [along, out];
    return zones.some((zone) => x > zone.bounds.minX && x < zone.bounds.maxX && z > zone.bounds.minZ && z < zone.bounds.maxZ);
  });
}

/** Gives structures a roof rising from `eaveSides` (per structure) only, at `slope`: their shared planes and peak. */
function setEaveRoof(segments, eaveSides, slope) {
  const planes = segments.flatMap((resolved, k) => eaveSides[k].map((side) => makeEavePlane(resolved.bounds, side, slope)));
  const unique = planes.filter((plane, i) => planes.findIndex((other) => other.axis === plane.axis && other.sign === plane.sign
    && Math.abs(other.constant - plane.constant) < 1e-9) === i);
  segments.forEach((resolved, k) => {
    const { bounds } = resolved;
    const rectangle = [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
    Object.assign(resolved, {
      planes: unique,
      roofHeight: roofPeak(unique, rectangle),
      eaveRoof: { eaveSides: eaveSides[k] },
    });
    resolved.topY = resolved.plateY + resolved.roofHeight;
  });
}

/**
 * The legs of a wraparound share one roof: the planes rising from its outer
 * eaves (none from the walls), so it turns each corner on a hip that drains
 * away from the house and runs level into the walls. Every leg takes every
 * leg's front plane (each rises toward the house, so it is only the lowest
 * near its own leg and the corners beside it); a hip roof also slopes from
 * its two free ends, each only over its own leg, and a shed's ends are
 * plain. An end against a wall runs level into it.
 */
function joinWrapRoofs(entries, zones) {
  const porches = new Map();
  entries.filter((entry) => entry.structure.wrapOf).forEach((entry) => {
    porches.set(entry.structure.wrapOf, [...(porches.get(entry.structure.wrapOf) ?? []), entry]);
  });
  porches.forEach((legs) => {
    if (legs.length < 2) {
      return;
    }
    if (!legs.every((entry) => entry.resolved)) {
      // all or none: a half-built wraparound would leave a hole at a corner
      legs.filter((entry) => entry.resolved).forEach((entry) => {
        entry.errors.push(error('wrap-incomplete', 'Another leg of this wraparound could not be built.'));
        entry.resolved = null;
      });
      return;
    }
    const first = legs[0].resolved;
    const slope = first.roofPitchRun > 0 ? first.roofPitchRise / first.roofPitchRun : 0;
    const hipped = first.roofType === 'hip';
    const fronts = legs.map(({ resolved }) => makeEavePlane(resolved.bounds, structureWallSides(resolved.frame).front, slope));
    legs.forEach(({ structure, resolved }) => {
      const walls = structureWallSides(resolved.frame);
      // an end run on past a corner continues the next leg's front eave; a free end is hipped on a hip roof
      const pastCorner = Object.keys(structure.wrapExtend ?? {}).map((end) => resolved.frame.along === 'x'
        ? (end === 'max' ? 'maxX' : 'minX')
        : (end === 'max' ? 'maxZ' : 'minZ'));
      const ends = ['left', 'right'].map((name) => walls[name])
        .filter((side) => !resolved.seamSides.map((name) => walls[name]).includes(side))
        .filter((side) => pastCorner.includes(side) || hipped)
        .filter((side) => !againstWall(resolved, side, zones));
      const own = ends.filter((side) => !pastCorner.includes(side)).map((side) => makeEavePlane(resolved.bounds, side, slope));
      const planes = [...fronts, ...own];
      const unique = planes.filter((plane, i) => planes.findIndex((other) => other.axis === plane.axis && other.sign === plane.sign
        && Math.abs(other.constant - plane.constant) < 1e-9) === i);
      const { bounds } = resolved;
      const rectangle = [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
      Object.assign(resolved, {
        planes: unique,
        roofHeight: roofPeak(unique, rectangle),
        eaveRoof: { eaveSides: [walls.front, ...ends] },
      });
      resolved.topY = resolved.plateY + resolved.roofHeight;
    });
  });
}

/** A hipped porch roof (see resolveRoofStructure) runs level into any wall one of its ends stands against. */
function settleEaveRoofs(entries, zones) {
  entries.filter((entry) => entry.resolved?.eaveRoof && !entry.structure.wrapSegment).forEach(({ resolved }) => {
    const sides = resolved.eaveRoof.eaveSides.filter((side) => !againstWall(resolved, side, zones));
    if (sides.length < resolved.eaveRoof.eaveSides.length) {
      setEaveRoof([resolved], [sides], resolved.roofPitchRun > 0 ? resolved.roofPitchRise / resolved.roofPitchRun : 0);
    }
  });
}

/**
 * A resolved structure as a host for another standing on it: the zone
 * descriptor shape, with its plate as both roof base and wall top (a
 * structure's roof sits right on its walls) and its solid starting at its
 * floor. `describeStructure(resolved)` supplies its roof overhang and eave
 * settings (`{ overhang, eaves }`), which the builder computes.
 */
function structureAsHost(resolved, host, describeStructure) {
  return {
    volumeId: resolved.id,
    structureId: resolved.id,
    roofType: resolved.roofType,
    bounds: resolved.bounds,
    roofBounds: resolved.bounds,
    ridgeAxis: resolved.ridgeAxis,
    roofHighEdge: resolved.roofHighEdge,
    roofHeight: resolved.roofHeight,
    planes: resolved.planes,
    slabThickness: resolved.slabThickness,
    overhang: {},
    eaves: {},
    ...(describeStructure ? describeStructure(resolved) : {}),
    exact: true,
    // the host sides with no wall under the eave (a flush structure on one of these does not break it)
    openBoundsSides: resolved.openSides.map((wallName) => structureWallSides(resolved.frame)[wallName]),
    baseY: resolved.plateY,
    wallTopY: resolved.plateY,
    floorY: resolved.sillY,
    foundationTopY: host?.foundationTopY,
  };
}

// ---------------------------------------------------------------------------
// Structure walls
// ---------------------------------------------------------------------------

/**
 * The rectangle side each named wall of a structure is on. `left` and
 * `right` are as seen from outside, facing the front wall (looking inward).
 */
export function structureWallSides(frame) {
  const upper = (axis) => axis.toUpperCase();
  const inward = upper(frame.inward);
  const along = upper(frame.along);
  // facing direction f = inward * sign; right = f x up = (-f.z, 0, f.x)
  const rightIsMax = frame.along === 'x' ? frame.sign < 0 : frame.sign > 0;
  return {
    front: `${frame.sign > 0 ? 'min' : 'max'}${inward}`,
    back: `${frame.sign > 0 ? 'max' : 'min'}${inward}`,
    right: `${rightIsMax ? 'max' : 'min'}${along}`,
    left: `${rightIsMax ? 'min' : 'max'}${along}`,
  };
}

/**
 * The roof's height profile along the segment a -> b (plan points [x, z]):
 * `[t, height]` points, t in [0, 1], at the ends and wherever the profile
 * bends (where the governing plane changes, e.g. a ridge crossing). The
 * min of planes is concave, so these points trace it exactly.
 */
export function roofProfile(planes, a, b) {
  const heightAt = (t) => evalZoneHeight(planes, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
  if (!planes?.length) {
    return [[0, 0], [1, 0]];
  }
  const lines = planes.map((plane) => {
    const h0 = evalPlaneHeight(plane, a[0], a[1]);
    return [h0, evalPlaneHeight(plane, b[0], b[1]) - h0];
  });
  const ts = [0, 1];
  lines.forEach(([h0, dh], i) => {
    lines.slice(i + 1).forEach(([k0, dk]) => {
      if (Math.abs(dh - dk) > 1e-12) {
        const t = (k0 - h0) / (dh - dk);
        if (t > 1e-9 && t < 1 - 1e-9) {
          ts.push(t);
        }
      }
    });
  });
  // (several pairs of planes can cross at one point: keep it once)
  const sorted = ts.sort((x, y) => x - y).filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-9);
  if (1 - sorted[sorted.length - 1] < 1e-9) {
    sorted[sorted.length - 1] = 1;
  }
  const points = sorted.map((t) => [t, heightAt(t)]);
  // keep only the ends and real bends
  const kept = [points[0]];
  points.slice(1).forEach((point, i) => {
    const next = points[i + 2];
    if (!next) {
      kept.push(point);
      return;
    }
    const [t0, h0] = kept[kept.length - 1];
    const [t2, h2] = next;
    const expected = h0 + ((h2 - h0) * (point[0] - t0)) / (t2 - t0);
    if (Math.abs(point[1] - expected) > 1e-9) {
      kept.push(point);
    }
  });
  return kept;
}

/**
 * The outline of each closed wall of a resolved structure: a vertical
 * polygon of [x, y, z] points from `bottomY` up to its roof (a gable end
 * runs up to the ridge, a flat roof's walls to the top of its slab). Open sides get no wall. The polygons
 * are convex; clipping them outside the host solid leaves the part that
 * stands above the host roof.
 *
 * @returns {Array<{ wall: string, side: string, polygon: Array<[number, number, number]> }>}
 */
export function structureWallPolygons(resolved, bottomY) {
  const sides = structureWallSides(resolved.frame);
  const { bounds } = resolved;
  const roofPlanes = resolved.roofType === 'flat' ? [] : resolved.planes;
  // a flat roof's slab sits on the walls; they run up to its top, where the structure's solid ends
  const plateY = resolved.plateY + (resolved.roofType === 'flat' ? resolved.slabThickness : 0);
  return STRUCTURE_WALLS.filter((wall) => !resolved.openSides.includes(wall)).map((wall) => {
    const side = sides[wall];
    const [a, b] = side === 'minX' || side === 'maxX'
      ? [[bounds[side], bounds.minZ], [bounds[side], bounds.maxZ]]
      : [[bounds.minX, bounds[side]], [bounds.maxX, bounds[side]]];
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const top = roofProfile(roofPlanes, a, b).reverse().map(([t, height]) => {
      const [x, z] = at(t);
      return [x, plateY + height, z];
    });
    return {
      wall,
      side,
      polygon: [[a[0], bottomY, a[1]], [b[0], bottomY, b[1]], ...top],
    };
  });
}

/**
 * The floor of a structure standing on a base: its rectangle at the sill,
 * as [x, y, z] points. It is the porch deck, and the underside of any part
 * projecting past the host wall.
 */
export function structureFloorPolygon(resolved) {
  const { bounds, sillY } = resolved;
  return [
    [bounds.minX, sillY, bounds.minZ], [bounds.maxX, sillY, bounds.minZ],
    [bounds.maxX, sillY, bounds.maxZ], [bounds.minX, sillY, bounds.maxZ],
  ];
}

/** A stud wall's typical thickness, shown at an otherwise knife-edge wall end (e.g. a recess's open jambs); see `structureRecess`. */
export const WALL_END_CAP_DEPTH = 0.1524; // six inches

/**
 * The recess an inset leaves at the front of a structure: its plan rectangle
 * (front line to inner line, across the structure's width), its floor at the
 * sill, the inner wall across its back, from the sill up to the roof, and
 * the two open jambs where the side walls are cut off at the front line.
 * Without this, a jamb is a bare knife-edge, the wall plane simply ending in
 * open air; `jambs` gives each one a short return face `WALL_END_CAP_DEPTH`
 * deep, standing the wall's thickness the way a real stud wall would show it
 * in the opening. Null without an inset.
 *
 * @returns {{
 *   plan: Array<[number, number]>, floor: Array<[number, number, number]>,
 *   innerWall: Array<[number, number, number]>, jambs: Array<Array<[number, number, number]>>,
 * } | null}
 */
export function structureRecess(resolved) {
  if (!(resolved.inset > GEOMETRY_EPSILON)) {
    return null;
  }
  const { frame, sillY, plateY } = resolved;
  const [a0, a1] = resolved.along;
  const [front, inner] = [resolved.front, resolved.innerLine];
  const at = (along, inward) => pointOn(frame, along, inward);
  const plan = [at(a0, front), at(a1, front), at(a1, inner), at(a0, inner)];
  const roofPlanes = resolved.roofType === 'flat' ? [] : resolved.planes;
  const top = resolved.roofType === 'flat' ? resolved.slabThickness : 0;
  const [p0, p1] = [at(a0, inner), at(a1, inner)];
  const profile = roofProfile(roofPlanes, p0, p1).reverse().map(([t, height]) => {
    const [x, z] = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    return [x, plateY + height + top, z];
  });
  // A side wall's top follows the roof along whichever axis it runs (its own
  // face doesn't move along the other axis), so the jamb's height is the
  // same at both its ends: no need to interpolate across its own thin depth.
  const heightAt = (along) => {
    const [x, z] = at(along, front);
    const faceHeight = roofPlanes.length ? evalZoneHeight(roofPlanes, x, z) : top;
    return plateY + faceHeight;
  };
  // Capped at half the recess width so the two jambs (one from each end,
  // extending toward the middle) can never overlap on a narrow recess.
  const capDepth = Math.min(WALL_END_CAP_DEPTH, Math.abs(a1 - a0) / 2);
  const jamb = (edgeAlong, towardCenter) => {
    const h = heightAt(edgeAlong);
    const [x0, z0] = at(edgeAlong, front);
    const [x1, z1] = at(edgeAlong + towardCenter * capDepth, front);
    return [[x0, sillY, z0], [x1, sillY, z1], [x1, h, z1], [x0, h, z0]];
  };
  const jambs = capDepth > GEOMETRY_EPSILON ? [jamb(a0, 1), jamb(a1, -1)] : [];
  return {
    plan,
    floor: plan.map(([x, z]) => [x, sillY, z]),
    innerWall: [[p0[0], sillY, p0[1]], [p1[0], sillY, p1[1]], ...profile],
    jambs,
  };
}

// ---------------------------------------------------------------------------
// Host eaves
// ---------------------------------------------------------------------------

/**
 * The cross-section of a host roof's overhang on `side` at `along` (a
 * coordinate along the side), as built by the eave trim (js/eaves.js):
 * `[inward coordinate, height above the plate]` points from the wall at the
 * roof surface, out to the fascia, down it, and back to the wall along the
 * soffit.
 * - An eave (the slope meets the wall) drops along its slope, then down the
 *   fascia, with a flat or roof-parallel soffit; a mansard's or gambrel's is a
 *   cornice box at the plate.
 * - A rake (a gable end or a shed's side) is level across at the roof's
 *   height there, one fascia deep with a sloped rake soffit, or down to the
 *   flat soffit level with a flat one.
 * - A flat roof's overhang is the edge of its slab.
 * Null where the side has no overhang.
 *
 * @param {object} host - roof zone descriptor
 * @param {string} side
 * @param {number} [along]
 * @returns {{ depth: number, outline: Array<[number, number]> } | null}
 */
export function hostEaveProfile(host, side, along = 0) {
  const depth = host.overhang?.[side] > GEOMETRY_EPSILON
    ? host.overhang[side]
    : (host.eaves?.partial?.[side] ? host.eaves.eaveDepth ?? 0 : 0);
  if (!(depth > GEOMETRY_EPSILON)) {
    return null;
  }
  const wall = host.bounds[side];
  const out = wall + (side === 'minX' || side === 'minZ' ? -depth : depth);
  if (host.roofType === 'flat') {
    const top = host.slabThickness ?? FLAT_ROOF_THICKNESS;
    return { depth, outline: [[wall, 0], [wall, top], [out, top], [out, 0]] };
  }
  const fascia = host.eaves?.fasciaDepth ?? 0;
  const face = host.planes?.find((plane) => plane.side === side);
  const twoSlope = TWO_SLOPE_ROOF_TYPES.includes(host.roofType);
  if (face && twoSlope) {
    // a mansard's or gambrel's eave is a cornice box at the plate
    return { depth, outline: [[wall, 0], [out, 0], [out, -fascia], [wall, -fascia]] };
  }
  if (!face) {
    const [x, z] = side === 'minX' || side === 'maxX' ? [wall, along] : [along, wall];
    const height = evalZoneHeight(host.planes, x, z);
    const bottom = host.eaves?.rakeSoffit === 'flat' && !twoSlope
      ? Math.min(...host.planes.map((plane) => (host.overhang?.[plane.side] > GEOMETRY_EPSILON
        ? -plane.slope * host.overhang[plane.side] - fascia
        : -fascia)))
      : height - fascia;
    return { depth, outline: [[wall, height], [out, height], [out, bottom], [wall, bottom]] };
  }
  const drop = face.slope * depth;
  const soffitAtWall = host.eaves?.eaveSoffit === 'sloped' ? -fascia : -drop - fascia;
  return { depth, outline: [[wall, 0], [out, -drop], [out, -drop - fascia], [wall, soffitAtWall]] };
}

/** Whether the host's eave on `side` runs past `along` (a full eave, or a partial strip covering it). */
export function hostEaveCovers(host, side, along) {
  if (host.overhang?.[side] > GEOMETRY_EPSILON) {
    return true;
  }
  return (host.eaves?.partial?.[side] ?? []).some(({ a0, a1 }) => along > a0 + GEOMETRY_EPSILON && along < a1 - GEOMETRY_EPSILON);
}

// ---------------------------------------------------------------------------
// Facade surfaces
// ---------------------------------------------------------------------------

/** A railing's default height where the structure's own wall height is not its railing height. */
export const RAILING_HEIGHT = 1;

const OUTWARD = { minX: [-1, 0], maxX: [1, 0], minZ: [0, -1], maxZ: [0, 1] };

/**
 * The frame of a wall of a structure on one side of a rectangle (`side`, at
 * inward coordinate `at` if not the rectangle's own side): `start` and `end`
 * as seen from outside, facing the wall, left to right; `right` the unit
 * direction from start to end; `normal` outward.
 */
/** A wall frame for the plan edge a -> b, facing away from `inside`. */
export function edgeFrame(a, b, inside) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let normal = [(b[1] - a[1]) / length, -(b[0] - a[0]) / length];
  if (normal[0] * (inside[0] - a[0]) + normal[1] * (inside[1] - a[1]) > 0) {
    normal = [-normal[0], -normal[1]];
  }
  const right = [normal[1], -normal[0]];
  const along = (point) => point[0] * right[0] + point[1] * right[1];
  const [start, end] = along(a) <= along(b) ? [a, b] : [b, a];
  return { start, end, right, normal, length };
}

function wallFrame(bounds, side, at = bounds[side]) {
  const normal = OUTWARD[side];
  const right = [normal[1], -normal[0]];
  const ends = side === 'minX' || side === 'maxX'
    ? [[at, bounds.minZ], [at, bounds.maxZ]]
    : [[bounds.minX, at], [bounds.maxX, at]];
  const along = (point) => point[0] * right[0] + point[1] * right[1];
  const [start, end] = along(ends[0]) <= along(ends[1]) ? ends : [ends[1], ends[0]];
  return {
    start, end, right, normal, length: Math.hypot(end[0] - start[0], end[1] - start[1]),
  };
}

/**
 * One facade wall run from a wall's visible triangles: the triangles
 * projected into the wall's own (u, v) coordinates, u across it from the
 * left as seen from outside and v up from `baseY`. The pieces are the visible
 * surface (their union), which windows and trim are placed within.
 */
export function facadeWallRun(id, fields, frame, triangles, baseY) {
  const toUV = ([x, y, z]) => [
    (x - frame.start[0]) * frame.right[0] + (z - frame.start[1]) * frame.right[1],
    y - baseY,
  ];
  const pieces = triangles.map((triangle) => triangle.map(toUV));
  const us = pieces.flat().map(([u]) => u);
  const vs = pieces.flat().map(([, v]) => v);
  const area = pieces.reduce((sum, [a, b, c]) => sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2, 0);
  return {
    id,
    ...fields,
    start: frame.start,
    end: frame.end,
    normal: frame.normal,
    length: frame.length,
    baseY,
    pieces,
    extent: { minU: Math.min(...us), maxU: Math.max(...us), minV: Math.min(...vs), maxV: Math.max(...vs) },
    area,
  };
}

/** The parts of the segment a -> b ([x, y, z]) outside every solid, as [a, b] pieces. */
export function segmentOutside(a, b, solids) {
  let pieces = [[0, 1]];
  solids.forEach((solid) => {
    // the parameter interval where the segment is inside this convex solid
    let [t0, t1] = [0, 1];
    solid.forEach(({ normal, offset }) => {
      const start = dot(normal, a) - offset;
      const delta = dot(normal, b) - dot(normal, a);
      if (Math.abs(delta) < 1e-12) {
        if (start > SOLID_EPSILON) {
          [t0, t1] = [1, 0];
        }
      } else {
        const t = -start / delta;
        if (delta > 0) {
          t1 = Math.min(t1, t);
        } else {
          t0 = Math.max(t0, t);
        }
      }
    });
    if (t1 - t0 > 1e-9) {
      pieces = pieces.flatMap(([p0, p1]) => [[p0, Math.min(p1, t0)], [Math.max(p0, t1), p1]].filter(([q0, q1]) => q1 - q0 > 1e-9));
    }
  });
  const at = (t) => a.map((value, k) => value + (b[k] - value) * t);
  return pieces.map(([t0, t1]) => [at(t0), at(t1)]);
}

/**
 * A built structure's facade surfaces, for windows, doors, trim, and
 * railings (Tasks 6-7) to address the same way as footprint walls:
 * - `wallRuns`: `wall-run-<id>-<wall>` for each wall with a visible surface
 *   (`front`, `left`, `right`, `back`; `inner` for a recess's set-back wall;
 *   `base-<wall>` for an enclosed base), each with its visible `pieces` in
 *   wall-local (u, v) and its story.
 * - `stories`: `story-<id>-1` from the floor to the plate (the railing height
 *   and `story-<id>-base` under an enclosed base.
 * - `railRuns`: `rail-run-<id>-<wall>` along each open side at floor level,
 *   where it stands clear of the host and other volumes (`solids`), with the
 *   railing's height.
 *
 * @param {object} resolved - the resolved structure
 * @param {Map<string, Array>} wallFaces - visible wall triangles by wall name
 * @param {Array<[string, Array]>} skirts - an enclosed base's walls, by wall name
 * @param {Array} solids - what a railing may not run through
 */
export function structureFacade(resolved, wallFaces, skirts, solids) {
  const sides = structureWallSides(resolved.frame);
  const { id, bounds } = resolved;
  const storyId = `story-${id}-1`;
  const baseStoryId = `story-${id}-base`;
  const common = { structureId: id, hostVolumeId: resolved.hostVolumeId };
  const wallRuns = [];
  wallFaces.forEach((triangles, name) => {
    const side = name === 'inner' ? sides.front : sides[name];
    const frame = wallFrame(bounds, side, name === 'inner' ? resolved.innerLine : bounds[side]);
    wallRuns.push(facadeWallRun(`wall-run-${id}-${name}`, { ...common, wall: name, side, storyId }, frame, triangles, resolved.sillY));
  });
  skirts.filter(([, triangles]) => triangles.length).forEach(([name, triangles]) => {
    const frame = wallFrame(bounds, sides[name]);
    wallRuns.push(facadeWallRun(`wall-run-${id}-base-${name}`, {
      ...common, wall: `base-${name}`, side: sides[name], storyId: baseStoryId,
    }, frame, triangles, resolved.foundationTopY ?? 0));
  });

  const floorY = resolved.sillY;
  const railHeight = Math.min(RAILING_HEIGHT, resolved.plateY - resolved.sillY);
  // (an entry hood has no floor to rail)
  const railRuns = (resolved.hood ? [] : resolved.openSides).filter((name) => !resolved.seamSides?.includes(name)).flatMap((name) => {
    const side = sides[name];
    const frame = wallFrame(bounds, side);
    const a = [frame.start[0], floorY, frame.start[1]];
    const b = [frame.end[0], floorY, frame.end[1]];
    return segmentOutside(a, b, solids).map(([start, end], index, all) => ({
      id: all.length > 1 ? `rail-run-${id}-${name}-${index + 1}` : `rail-run-${id}-${name}`,
      ...common,
      wall: name,
      side,
      start,
      end,
      height: railHeight,
    }));
  });

  const stories = [{ id: storyId, structureId: id, minY: resolved.sillY, maxY: resolved.plateY }];
  if (skirts.some(([, triangles]) => triangles.length)) {
    stories.push({ id: baseStoryId, structureId: id, minY: resolved.foundationTopY ?? 0, maxY: resolved.sillY });
  }
  return { structureId: id, wallRuns, stories, railRuns };
}

/**
 * A widow's walk's facade surfaces: the flat top of a hip roof in place of
 * its ridge, where a deck and railings (facade modifiers) can go.
 * - `pieces`: the flat top in plan (convex or simple polygons of [x, z]) at
 *   elevation `y`, for a deck surface.
 * - `railRuns`: `rail-run-<walk id>-<n>` along each edge where the roof
 *   slopes away, clear of anything standing on the walk (`solids`: a cupola
 *   or belvedere), at the default railing height.
 *
 * @param {{ id: string, volumeIds: string[], y: number, pieces: Array, edges: Array<[[number, number], [number, number]]> }} walk
 * @param {Array} solids - convex solids a railing may not run through
 */
export function roofWalkFacade(walk, solids = []) {
  let n = 0;
  const railRuns = walk.edges.flatMap(([a, b]) => segmentOutside([a[0], walk.y, a[1]], [b[0], walk.y, b[1]], solids))
    .filter(([start, end]) => Math.hypot(end[0] - start[0], end[2] - start[2]) > GEOMETRY_EPSILON)
    .map(([start, end]) => {
      n += 1;
      return {
        id: `rail-run-${walk.id}-${n}`, roofWalkId: walk.id, volumeIds: walk.volumeIds, start, end, height: RAILING_HEIGHT,
      };
    });
  return {
    id: walk.id, volumeIds: walk.volumeIds, y: walk.y, pieces: walk.pieces, railRuns,
  };
}
