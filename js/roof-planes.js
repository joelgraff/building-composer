/**
 * Roof planes: the infinite sloped "eave planes" a rectangular roof zone is
 * made of, and their heights. Pure functions with no THREE dependency, shared
 * by the roof builders (js/extrusion.js) and roof structures
 * (js/roof-structures.js).
 *
 * A plane rises from the eave on rectangle side `side` (on axis `axis`, the
 * wall at coordinate `constant`) with slope `slope`, and `sign` points
 * inward: its height above the plate is
 * `offset + slope * sign * (coord - constant)`. A `{ constantHeight }` plane
 * is level.
 */

export function defaultHighEdgeForAxis(axis) {
  return axis === 'x' ? 'z-min' : 'x-min';
}

export function makeEavePlane(bounds, side, slope) {
  const axis = side === 'minX' || side === 'maxX' ? 'x' : 'z';
  const sign = side === 'minX' || side === 'minZ' ? 1 : -1;
  return { side, axis, sign, constant: bounds[side], slope };
}

export function evalPlaneHeight(plane, x, z) {
  if ('constantHeight' in plane) {
    return plane.constantHeight;
  }
  const coord = plane.axis === 'x' ? x : z;
  return (plane.offset ?? 0) + plane.slope * plane.sign * (coord - plane.constant);
}

export function evalZoneHeight(planes, x, z) {
  if (!planes || planes.length === 0) {
    return 0;
  }
  return Math.min(...planes.map((plane) => evalPlaneHeight(plane, x, z)));
}

/**
 * Derives the infinite sloped "eave planes" that define a roof zone's own
 * surface height at any point in its rectangle, so a neighboring zone can
 * ask "how tall is your roof here" without needing that zone's finished
 * mesh. A zone's height at a point is the min across its own planes: for
 * hip, min-of-4-sides is exactly the classic hip profile (cross-slope
 * capped by the end-triangle slope); for gable, min-of-2-eave-sides gives
 * the ridge with flat gable ends; for shed, a single plane spans the whole
 * rectangle from its one low eave. Mirrors the exact height formulas
 * createGableRoofGeometry/createHipRoofGeometry/createShedRoofGeometry use,
 * so a neighbor's plane always agrees with what that neighbor actually
 * renders.
 */
export function computeVolumeEavePlanes(bounds, roofType, config) {
  if (TWO_SLOPE_ROOF_TYPES.includes(roofType)) {
    return twoSlopePlanes(bounds, roofType, config);
  }
  const roofHeight = config.roofHeight ?? 0;
  if (roofType === 'flat' || !(roofHeight > 0)) {
    return [];
  }

  if (roofType === 'hip') {
    const pitchRatio = (config.roofPitchRise ?? 0) / (config.roofPitchRun ?? 12);
    const planes = ['minX', 'maxX', 'minZ', 'maxZ'].map((side) => makeEavePlane(bounds, side, pitchRatio));
    // a hip cut flat at a widow's walk (a flat top in place of the ridge)
    const naturalPeak = pitchRatio * Math.min(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) / 2;
    if (config.walkHeight > 0 && config.walkHeight < naturalPeak - 1e-9) {
      planes.push({ constantHeight: config.walkHeight, tier: 'walk' });
    }
    return planes;
  }

  const ridgeAxis = config.roofDirection === 'x' ? 'x' : 'z';

  if (roofType === 'gable') {
    const halfSpan = ridgeAxis === 'x' ? (bounds.maxZ - bounds.minZ) / 2 : (bounds.maxX - bounds.minX) / 2;
    const slope = halfSpan > 0 ? roofHeight / halfSpan : 0;
    const sides = ridgeAxis === 'x' ? ['minZ', 'maxZ'] : ['minX', 'maxX'];
    return sides.map((side) => makeEavePlane(bounds, side, slope));
  }

  if (roofType === 'shed') {
    const highEdge = config.roofHighEdge ?? defaultHighEdgeForAxis(ridgeAxis);
    const lowSide = { 'x-min': 'maxX', 'x-max': 'minX', 'z-min': 'maxZ', 'z-max': 'minZ' }[highEdge];
    const span = lowSide === 'minX' || lowSide === 'maxX' ? bounds.maxX - bounds.minX : bounds.maxZ - bounds.minZ;
    const slope = span > 0 ? roofHeight / span : 0;
    return [makeEavePlane(bounds, lowSide, slope)];
  }

  return [];
}

/** Roof types made of two slopes per sloped side (a steep lower and a shallow upper plane). */
export const TWO_SLOPE_ROOF_TYPES = ['mansard', 'gambrel'];

/**
 * The sides a two-slope roof slopes on: a mansard on all four, a gambrel on
 * its two eave sides (parallel to its ridge), less any `unslopedSides` (sides
 * shared with a neighbor, closed with an end face instead).
 */
export function twoSlopeSides(roofType, ridgeAxis, unslopedSides = []) {
  const all = roofType === 'gambrel'
    ? (ridgeAxis === 'x' ? ['minZ', 'maxZ'] : ['minX', 'maxX'])
    : ['minX', 'maxX', 'minZ', 'maxZ'];
  return all.filter((side) => !unslopedSides.includes(side));
}

/**
 * A mansard's or gambrel's planes: on each sloped side a steep lower plane
 * (`lowerSlope`) from the eave, and a shallow upper plane (`upperSlope`) that
 * meets it at the break, `breakHeight` above the plate. The roof is their
 * min: below the break the steep plane is lower, above it the shallow one.
 * Steep planes come first, so the plane found for a side is its lower slope
 * (the one a dormer rises out of).
 */
function twoSlopePlanes(bounds, roofType, config) {
  const breakHeight = config.breakHeight ?? 0;
  const lowerSlope = config.lowerSlope ?? 0;
  const upperSlope = config.upperSlope ?? 0;
  if (!(breakHeight > 0) || !(lowerSlope > 0)) {
    return [];
  }
  const ridgeAxis = config.roofDirection === 'x' ? 'x' : 'z';
  const sides = twoSlopeSides(roofType, ridgeAxis, config.unslopedSides);
  const inset = breakHeight / lowerSlope;
  return [
    ...sides.map((side) => ({ ...makeEavePlane(bounds, side, lowerSlope), tier: 'lower' })),
    ...sides.map((side) => ({ ...makeEavePlane(bounds, side, upperSlope), offset: breakHeight - upperSlope * inset, tier: 'upper' })),
  ];
}
