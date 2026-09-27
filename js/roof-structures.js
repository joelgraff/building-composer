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
  computeVolumeEavePlanes, evalPlaneHeight, evalZoneHeight, TWO_SLOPE_ROOF_TYPES,
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
  return polygon.map(([x, z], i) => {
    const [nx, nz] = polygon[(i + 1) % polygon.length];
    // outward normal of edge (x, z) -> (nx, nz)
    const normal = [turn * (nz - z), 0, -turn * (nx - x)];
    return normalizedHalfSpace(normal, normal[0] * x + normal[2] * z);
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
  const walls = [
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

// ---------------------------------------------------------------------------
// Structure records: data model, placement, validation
// ---------------------------------------------------------------------------

export const STRUCTURE_KINDS = ['dormer', 'wall-dormer', 'recessed-porch', 'porch', 'cupola', 'widows-walk'];
/** How a structure meets the roof: joining one face (a dormer), or rising through it (a cupola). */
export const STRUCTURE_MOUNTS = ['join', 'through'];
export const STRUCTURE_WALLS = ['front', 'left', 'right', 'back'];
/** What holds up the part of a structure projecting past its host wall (see resolveRoofStructure). */
export const STRUCTURE_SUPPORTS = ['auto', 'none', 'deck', 'posts', 'porch', 'brackets', 'enclosed'];
/** Brackets carry only a shallow projection. */
export const MAX_BRACKET_PROJECTION = 1.5;
const SIDES = ['minX', 'maxX', 'minZ', 'maxZ'];
const ROOF_TYPES = ['flat', 'gable', 'hip', 'shed', 'none'];
/** A roofless platform's deck thickness (a widow's walk). */
export const DECK_THICKNESS = 0.08;
const GEOMETRY_EPSILON = 1e-6;

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
  // a deck on a flat roof top, filling it less a margin; its railing is a facade
  // element, and its wall height is the railing's height
  'widows-walk': Object.freeze({
    width: 3, setback: 'center', depth: 3, wallHeight: 1, baseHeight: null, openSides: ['front', 'back', 'left', 'right'],
    roofType: 'none', mount: 'through', fill: true, fillMargin: 0.3,
  }),
  // a raised porch standing on its host's plate (e.g. over a one-story wing)
  porch: Object.freeze({
    width: 3.6, setback: 0, depth: 2.4, wallHeight: 2.4, baseHeight: 0, openSides: ['front', 'left', 'right'], roofType: 'shed',
  }),
});

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
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
 * - `fill`: size and place the structure to cover the host roof's flat top,
 *   less `fillMargin` on every side (a widow's walk); its width, offset,
 *   setback, and depth are then ignored.
 * - `roofType: 'none'`: no roof at all (a widow's walk's deck; its wall height
 *   is then its railing's height).
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
    fill: typeof raw.fill === 'boolean' ? raw.fill : Boolean(preset.fill),
    fillMargin: Math.max(0, finite(raw.fillMargin, preset.fillMargin ?? 0.3)),
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
    eaves: plainObject(raw.eaves),
    materials: plainObject(raw.materials),
  };
}

/**
 * Normalizes a list of records, dropping unplaceable ones and giving every
 * structure a unique id (`structure-N`).
 */
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
  return host.baseY + roofPeak(hostRoofFaces(host), clipToHostWalls(bounds, host));
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

/**
 * Where a `fill` structure goes, in its host side's frame: over the largest
 * level part of the host roof (a flat roof, a hip's deck, a flat-topped
 * mansard), less the structure's `fillMargin` on every side. Null when the
 * roof has no level part.
 */
function fillPlacement(structure, host, frame) {
  const faces = hostRoofFaces(host);
  const level = (plane) => 'constantHeight' in plane || Math.abs(plane.slope) < GEOMETRY_EPSILON;
  const whole = clipToHostWalls(host.bounds, host);
  let best = null;
  let bestArea = 0;
  faces.forEach((plane, index) => {
    if (!level(plane)) {
      return;
    }
    let region = whole;
    faces.forEach((other, k) => {
      if (k !== index && region.length) {
        region = clipPolygon(region, ([x, z]) => evalPlaneHeight(other, x, z) - evalPlaneHeight(plane, x, z));
      }
    });
    const area = region.length < 3 ? 0 : Math.abs(region.reduce((sum, [x, z], i) => {
      const [nx, nz] = region[(i + 1) % region.length];
      return sum + x * nz - nx * z;
    }, 0)) / 2;
    if (area > bestArea + GEOMETRY_EPSILON) {
      [best, bestArea] = [region, area];
    }
  });
  if (!best) {
    return null;
  }
  const m = structure.fillMargin ?? 0;
  const coord = (axis) => best.map(([x, z]) => (axis === 'x' ? x : z));
  const [a0, a1] = [Math.min(...coord(frame.along)) + m, Math.max(...coord(frame.along)) - m];
  const [i0, i1] = [Math.min(...coord(frame.inward)) + m, Math.max(...coord(frame.inward)) - m];
  const [alongMinKey, alongMaxKey] = axisKeys(frame.along);
  const hostCenter = (host.bounds[alongMinKey] + host.bounds[alongMaxKey]) / 2;
  const wall = host.bounds[structure.hostSide];
  return {
    width: a1 - a0,
    offset: (a0 + a1) / 2 - hostCenter,
    setback: frame.sign > 0 ? i0 - wall : wall - i1,
    depth: i1 - i0,
  };
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
 * @param {object} structure - a normalized record
 * @param {object|undefined} host - the host volume's roof zone descriptor
 * @param {object} [config] - building defaults (`roofPitchRise`, `roofPitchRun`)
 * @returns {{ resolved: object|null, errors: Array<{code: string, message: string}>, warnings: Array<{code: string, message: string}> }}
 */
export function resolveRoofStructure(structure, host, config = {}) {
  const errors = [];
  const warnings = [];
  const fail = (code, message) => {
    errors.push(error(code, message));
    return { resolved: null, errors, warnings };
  };
  if (!host) {
    return fail('host-missing', `Host volume ${structure.hostVolumeId} does not exist or has no analytic roof.`);
  }
  if (!host.exact) {
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
  const place = structure.fill ? fillPlacement(structure, host, frame) : structure;
  if (!place) {
    return fail('not-level', `${host.volumeId}'s roof has no flat top to fill.`);
  }
  const alongCenter = (hostAlong[0] + hostAlong[1]) / 2 + place.offset;
  const along = [alongCenter - place.width / 2, alongCenter + place.width / 2];
  if (structure.fill && (!(place.width > GEOMETRY_EPSILON) || !(place.depth > GEOMETRY_EPSILON))) {
    return fail('invalid-dimensions', 'The flat top is too small for the margin.');
  }
  if (along[0] < hostAlong[0] - GEOMETRY_EPSILON || along[1] > hostAlong[1] + GEOMETRY_EPSILON) {
    return fail('outside-host', `The structure runs past the ends of ${host.volumeId}'s ${structure.hostSide} wall.`);
  }

  const wall = host.bounds[structure.hostSide];
  const setback = place.setback === 'center'
    ? (host.bounds[inwardMaxKey] - host.bounds[inwardMinKey] - place.depth) / 2
    : place.setback;
  const front = wall + frame.sign * setback;
  let back;
  if (through && place.depth === null) {
    return fail('depth-required', 'A structure rising through the roof needs an explicit depth.');
  } else if (place.depth !== null) {
    back = front + frame.sign * place.depth;
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

  const projecting = setback < -GEOMETRY_EPSILON;
  const groundLevel = Number.isFinite(host.foundationTopY) && sillY <= host.foundationTopY + GEOMETRY_EPSILON;
  let support = structure.support ?? 'auto';
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

  // The structure's own roof.
  const { roofType } = structure;
  const ridgeAxis = roofType === 'shed' || structure.ridge === 'parallel' ? frame.along : frame.inward;
  const roofHighEdge = roofType === 'shed' ? `${frame.inward}-${frame.sign > 0 ? 'max' : 'min'}` : undefined;
  const acrossExtent = ridgeAxis === 'x' ? bounds.maxZ - bounds.minZ : bounds.maxX - bounds.minX;
  const span = roofType === 'shed' ? inward[1] - inward[0] : acrossExtent / 2;
  const shape = structure.roofShape ?? { mode: 'slope', pitchRise: config.roofPitchRise ?? 6 };
  const pitchRun = config.roofPitchRun ?? 12;
  let roofHeight = 0;
  let roofPitchRise = 0;
  let roofPitchRun = pitchRun;
  if (roofType !== 'flat' && roofType !== 'none') {
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

  // a roofless platform (a widow's walk) stands on a flat part of the roof
  if (through && roofType === 'none') {
    const footprint = clipToHostWalls(bounds, host);
    const lowest = Math.min(...footprint.map(([x, z]) => evalZoneHeight(hostRoofFaces(host), x, z)));
    if (host.baseY + lowest < sillY - 1e-6) {
      return fail('not-level', 'A widow\'s walk must stand on a flat part of the roof.');
    }
  }

  const planeConfig = {
    roofHeight, roofDirection: ridgeAxis, roofHighEdge, roofPitchRise, roofPitchRun,
  };
  const planes = computeVolumeEavePlanes(bounds, roofType, planeConfig);
  const slabThickness = roofType === 'flat' ? FLAT_ROOF_THICKNESS : 0;
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
  // The host roof the structure removes: where the host roof lies under the
  // structure's roof. Host roof height is a min of planes, so this is a union
  // of convex pieces, one per host face: the face's own region (where it is
  // the lowest plane) where the structure's roof is above that face. A dormer
  // stands on one face, so its piece is its `hostContact`.
  const removedRoof = through
    ? []
    : standing
    ? hostRoofFaces(host).map((hostFace, index, faces) => {
      let piece = clipToHostWalls(bounds, host);
      faces.forEach((other, k) => {
        if (k !== index) {
          piece = clipPolygon(piece, ([x, z]) => evalPlaneHeight(other, x, z) - evalPlaneHeight(hostFace, x, z));
        }
      });
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
  if (sloped && !standing && !through && hostContact.some(([x, z]) => evalPlaneHeight(face, x, z) > evalZoneHeight(host.planes, x, z) + GEOMETRY_EPSILON)) {
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
      openSides: inset > GEOMETRY_EPSILON && !structure.openSides.includes('front')
        ? ['front', ...structure.openSides]
        : structure.openSides,
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
 * Where a structure actually stands, in plan, as convex polygons: the host
 * roof it removes, plus any part projecting past the host wall. Its buried
 * back (running on under the host roof to the ridge) is clipped away when it
 * is built, so it does not count.
 */
function occupiedPlan(resolved, host) {
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
  const list = structures ?? [];
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
  return list.map((structure) => resolveOne(structure));
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
  const points = [...new Set(ts)].sort((x, y) => x - y).map((t) => [t, heightAt(t)]);
  // keep only the ends and real bends
  return points.filter((point, i) => {
    if (i === 0 || i === points.length - 1) {
      return true;
    }
    const [t0, h0] = points[i - 1];
    const [t2, h2] = points[i + 1];
    const expected = h0 + ((h2 - h0) * (point[0] - t0)) / (t2 - t0);
    return Math.abs(point[1] - expected) > 1e-9;
  });
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

/**
 * The recess an inset leaves at the front of a structure: its plan rectangle
 * (front line to inner line, across the structure's width), its floor at the
 * sill, and the inner wall across its back, from the sill up to the roof.
 * Null without an inset.
 *
 * @returns {{ plan: Array<[number, number]>, floor: Array<[number, number, number]>, innerWall: Array<[number, number, number]> } | null}
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
  return {
    plan,
    floor: plan.map(([x, z]) => [x, sillY, z]),
    innerWall: [[p0[0], sillY, p0[1]], [p1[0], sillY, p1[1]], ...profile],
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
function facadeWallRun(id, fields, frame, triangles, baseY) {
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
function segmentOutside(a, b, solids) {
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
 *   for a roofless platform), and `story-<id>-base` under an enclosed base.
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

  const roofless = resolved.roofType === 'none';
  const floorY = resolved.sillY + (roofless ? DECK_THICKNESS : 0);
  const railHeight = roofless ? resolved.plateY - resolved.sillY : Math.min(RAILING_HEIGHT, resolved.plateY - resolved.sillY);
  const railRuns = resolved.openSides.flatMap((name) => {
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

  const stories = [{ id: storyId, structureId: id, minY: resolved.sillY, maxY: roofless ? floorY + railHeight : resolved.plateY }];
  if (skirts.some(([, triangles]) => triangles.length)) {
    stories.push({ id: baseStoryId, structureId: id, minY: resolved.foundationTopY ?? 0, maxY: resolved.sillY });
  }
  return { structureId: id, wallRuns, stories, railRuns };
}
