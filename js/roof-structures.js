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

/** Fan-triangulates convex polygons, dropping any with fewer than 3 points. */
export function polygonsToTriangles(polygons) {
  return polygons.flatMap((polygon) => (polygon.length < 3
    ? []
    : polygon.slice(1, -1).map((_, k) => [polygon[0], polygon[k + 1], polygon[k + 2]])));
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
 * A structure's roof never rises above the host ridge: with `join: 'auto'`
 * a taller roof is lowered to it (reported as a warning); with
 * `'snap-ridge'` it is always set to meet it. A shed dormer too steep to meet
 * the host plane before the ridge is snapped the same way.
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
  const face = hostFacePlane(host, structure.hostSide);
  if (!face) {
    return fail('side-not-sloped', `The ${structure.hostSide} side of ${host.volumeId} is not a roof slope (a gable end or a shed's high or rake side).`);
  }
  const sloped = !('constantHeight' in face);
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
    return fail('depth-required', 'A structure on a flat roof needs an explicit depth.');
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

  const hostFaceY = ([x, z]) => host.baseY + evalPlaneHeight(face, x, z);
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

  if (sloped) {
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
  const aboveHost = planes.length
    ? planes.map((plane) => ([x, z]) => plateY + evalPlaneHeight(plane, x, z) - hostFaceY([x, z]))
    : [(point) => plateY + slabThickness - hostFaceY(point)];
  [...within, ...aboveHost].forEach((distance) => {
    hostContact = clipPolygon(hostContact, distance);
  });
  if (hostContact.length < 3 && structure.baseHeight === null) {
    return fail('no-contact', 'The structure does not meet the host roof.');
  }
  if (sloped && hostContact.some(([x, z]) => evalPlaneHeight(face, x, z) > evalZoneHeight(host.planes, x, z) + GEOMETRY_EPSILON)) {
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
      hostContact: hostContact.length >= 3 ? hostContact : [],
      openSides: structure.openSides,
    },
    errors,
    warnings,
  };
}

const rectanglesOverlap = (a, b) => Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > GEOMETRY_EPSILON
  && Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > GEOMETRY_EPSILON;

/**
 * Resolves every structure against the building's roof zones and checks
 * them against each other: structures on the same host may not overlap (the
 * later one in the list is rejected).
 *
 * @returns {Array<{ id: string, structure: object, resolved: object|null, errors: Array<object>, warnings: Array<object> }>}
 */
export function validateRoofStructures(structures, roofZones, config = {}) {
  const zones = new Map((roofZones ?? []).map((zone) => [zone.volumeId, zone]));
  const accepted = [];
  return (structures ?? []).map((structure) => {
    const result = resolveRoofStructure(structure, zones.get(structure.hostVolumeId), config);
    if (result.resolved) {
      const clash = accepted.find((other) => other.hostVolumeId === result.resolved.hostVolumeId
        && rectanglesOverlap(other.bounds, result.resolved.bounds));
      if (clash) {
        result.errors.push(error('overlap', `Overlaps ${clash.id} on the same roof.`));
        result.resolved = null;
      } else {
        accepted.push(result.resolved);
      }
    }
    return { id: structure.id, structure, ...result };
  });
}
