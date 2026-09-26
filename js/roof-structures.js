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

import { computeVolumeEavePlanes, evalPlaneHeight, evalZoneHeight } from './roof-planes.js';

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
 * clipped against each other. Overhangs are not part of the solid.
 *
 * @param {{ bounds: { minX: number, maxX: number, minZ: number, maxZ: number }, baseY: number, planes: Array<object>, slabThickness?: number }} zone
 *   A resolved roof zone descriptor (`roofZones` from createBuildingFromFootprint).
 * @param {{ floorY?: number }} [options]
 * @returns {Array<{ normal: number[], offset: number }>}
 */
export function volumeSolid(zone, { floorY = 0 } = {}) {
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

export const STRUCTURE_KINDS = ['dormer', 'wall-dormer', 'porch'];
export const STRUCTURE_WALLS = ['front', 'left', 'right', 'back'];
const SIDES = ['minX', 'maxX', 'minZ', 'maxZ'];
const ROOF_TYPES = ['flat', 'gable', 'hip', 'shed'];
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
 * - `baseHeight`: null to rise out of the host roof, or a floor level above
 *   the host plate.
 * - `openSides`: walls left open (`front`, `back`, and `left`/`right` as
 *   seen from outside, facing the front wall).
 *
 * @returns {object|null}
 */
export function normalizeRoofStructure(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.hostVolumeId !== 'string' || !SIDES.includes(raw.hostSide)) {
    return null;
  }
  const kind = STRUCTURE_KINDS.includes(raw.kind) ? raw.kind : 'dormer';
  const preset = STRUCTURE_PRESETS[kind];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : null,
    kind,
    hostVolumeId: raw.hostVolumeId,
    hostSide: raw.hostSide,
    offset: finite(raw.offset, 0),
    width: finite(raw.width, preset.width),
    setback: finite(raw.setback, preset.setback),
    depth: raw.depth === null ? null : finite(raw.depth, preset.depth),
    wallHeight: finite(raw.wallHeight, preset.wallHeight),
    baseHeight: raw.baseHeight === null ? null : finite(raw.baseHeight, preset.baseHeight),
    openSides: Array.isArray(raw.openSides)
      ? STRUCTURE_WALLS.filter((wall) => raw.openSides.includes(wall))
      : [...preset.openSides],
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
  const face = hostFacePlane(host, structure.hostSide);
  if (!face && !standing) {
    return fail('side-not-sloped', `The ${structure.hostSide} side of ${host.volumeId} is not a roof slope (a gable end or a shed's high or rake side).`);
  }
  const sloped = Boolean(face) && !('constantHeight' in face);
  if (structure.setback < -GEOMETRY_EPSILON && structure.baseHeight === null) {
    return fail('needs-base', 'A structure projecting past the host wall needs a base height.');
  }

  const frame = structureFrame(structure.hostSide);
  const [alongMinKey, alongMaxKey] = axisKeys(frame.along);
  const [inwardMinKey, inwardMaxKey] = axisKeys(frame.inward);
  const hostAlong = [host.bounds[alongMinKey], host.bounds[alongMaxKey]];
  const alongCenter = (hostAlong[0] + hostAlong[1]) / 2 + structure.offset;
  const along = [alongCenter - structure.width / 2, alongCenter + structure.width / 2];
  if (along[0] < hostAlong[0] - GEOMETRY_EPSILON || along[1] > hostAlong[1] + GEOMETRY_EPSILON) {
    return fail('outside-host', `The structure runs past the ends of ${host.volumeId}'s ${structure.hostSide} wall.`);
  }

  const wall = host.bounds[structure.hostSide];
  const front = wall + frame.sign * structure.setback;
  let back;
  if (structure.depth !== null) {
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
  const sillY = structure.baseHeight !== null
    ? host.baseY + structure.baseHeight
    : hostFaceY(pointOn(frame, alongCenter, front));
  const plateY = sillY + structure.wallHeight;

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
  if (sloped && !standing) {
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
  const removedRoof = standing
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

  if (hostContact.length < 3 && structure.baseHeight === null) {
    return fail('no-contact', 'The structure does not meet the host roof.');
  }
  if (sloped && !standing && hostContact.some(([x, z]) => evalPlaneHeight(face, x, z) > evalZoneHeight(host.planes, x, z) + GEOMETRY_EPSILON)) {
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
      hostContact: hostContact.length >= 3 && !standing ? hostContact : [],
      removedRoof,
      // the front wall stands on the host wall line: it carries the wall up through the eave
      flush: Math.abs(structure.setback) <= GEOMETRY_EPSILON,
      // its front wall is out past the host wall (a projecting porch)
      projecting: structure.setback < -GEOMETRY_EPSILON,
      standing,
      openSides: structure.openSides,
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
  return [...resolved.removedRoof, outside].filter((polygon) => polygon.length >= 3);
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
 * rejected).
 *
 * @returns {Array<{ id: string, structure: object, resolved: object|null, errors: Array<object>, warnings: Array<object> }>}
 */
export function validateRoofStructures(structures, roofZones, config = {}) {
  const zones = new Map((roofZones ?? []).map((zone) => [zone.volumeId, zone]));
  const accepted = [];
  return (structures ?? []).map((structure) => {
    const result = resolveRoofStructure(structure, zones.get(structure.hostVolumeId), config);
    if (result.resolved) {
      const host = zones.get(structure.hostVolumeId);
      const plan = occupiedPlan(result.resolved, host);
      const clash = accepted.find((other) => other.hostVolumeId === result.resolved.hostVolumeId
        && other.plan.some((piece) => plan.some((mine) => convexOverlap(piece, mine))));
      if (clash) {
        result.errors.push(error('overlap', `Overlaps ${clash.id} on the same roof.`));
        result.resolved = null;
      } else {
        accepted.push({ ...result.resolved, plan });
      }
    }
    return { id: structure.id, structure, ...result };
  });
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
 *   fascia, with a flat or roof-parallel soffit.
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
  if (!face) {
    const [x, z] = side === 'minX' || side === 'maxX' ? [wall, along] : [along, wall];
    const height = evalZoneHeight(host.planes, x, z);
    const bottom = host.eaves?.rakeSoffit === 'flat'
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
