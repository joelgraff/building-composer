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
 * Half-space form of one roof eave plane (see computeVolumeEavePlanes in
 * js/extrusion.js), whose height above the plate is
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
