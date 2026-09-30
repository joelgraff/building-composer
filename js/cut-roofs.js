/**
 * The roof of a volume cut by angled walls (see js/angled-walls.js).
 *
 * The roof is the min of planes, as a rectangle's is: the planes of the
 * volume's rectangle (computeVolumeEavePlanes), plus one for each angled wall
 * that takes an eave. Which walls do depends on the roof:
 *
 * - a hip or mansard slopes up from every wall, so each angled wall gets its
 *   own facet, rising at the roof's pitch from a level eave;
 * - a gable or gambrel does that on an angled wall running nearer its ridge
 *   (an eave side, such as a clipped corner); an angled wall across the
 *   ridge is a skewed gable end, the wall rising to meet both slopes;
 * - a shed gives a facet to an angled wall on its low side running nearer
 *   its eave, and otherwise runs on to the wall like its rakes;
 * - a flat roof is only cut to the outline.
 *
 * The roof covers the wall outline pushed out by each wall's overhang (its
 * eave or rake depth; nothing where it meets another volume). Each wall rises
 * to the roof above it, which makes the gable ends, skewed or not; each
 * edge of the overhang gets a fascia under the roof's edge and a soffit back
 * to the wall: flat under a level eave (or sloped, per `eaveSoffit`), and
 * following the roof under a rake.
 *
 * Plan polygons are [x, z]; triangles are [x, y, z] with y the height above
 * the plate. Pure functions; no THREE dependency.
 */
import { computeVolumeEavePlanes, evalPlaneHeight, evalZoneHeight, makeEdgePlane } from './roof-planes.js';
import { clipPolygon, polygonsToTriangles, roofProfile, FLAT_ROOF_THICKNESS } from './roof-structures.js';
import { cutDistance } from './angled-walls.js';
import { sideOverhangs } from './eaves.js';

const EPSILON = 1e-9;

/** What an angled wall does under a roof: 'eave' (its own facet) or 'rake' (the roof runs on to it). */
export function cutRole(cut, roofType, { ridgeAxis, roofHighEdge, bounds }) {
  const [dx, dz] = [cut.b[0] - cut.a[0], cut.b[1] - cut.a[1]];
  const alongX = Math.abs(dx) >= Math.abs(dz);
  if (roofType === 'hip' || roofType === 'mansard') {
    return 'eave';
  }
  if (roofType === 'gable' || roofType === 'gambrel') {
    // nearer the ridge (a 45-degree wall counts as nearer)
    return Math.abs(Math.abs(dx) - Math.abs(dz)) < 1e-9 || alongX === (ridgeAxis === 'x') ? 'eave' : 'rake';
  }
  if (roofType === 'shed') {
    const low = { 'x-min': 'maxX', 'x-max': 'minX', 'z-min': 'maxZ', 'z-max': 'minZ' }[roofHighEdge] ?? 'maxX';
    const lowAlongX = low === 'minZ' || low === 'maxZ';
    const middle = [(cut.a[0] + cut.b[0]) / 2, (cut.a[1] + cut.b[1]) / 2];
    const center = low === 'minX' || low === 'maxX' ? (bounds.minX + bounds.maxX) / 2 : (bounds.minZ + bounds.maxZ) / 2;
    const coord = low === 'minX' || low === 'maxX' ? middle[0] : middle[1];
    const onLowSide = low.startsWith('min') ? coord < center : coord > center;
    return alongX === lowAlongX && onLowSide ? 'eave' : 'rake';
  }
  return 'rake';
}

/**
 * The planes of a cut volume's roof: its rectangle's, and a facet for each
 * angled wall with an eave (a lower and an upper one on a two-slope roof).
 */
export function cutRoofPlanes(volume, roofType, roofConfig) {
  const bounds = rectangleOf(volume);
  // a side the cuts take away entirely has no wall to rise from
  const outline = volume.outline ?? rectanglePolygon(bounds);
  const standing = new Set(outline.map((a, i) => rectangleSide(a, outline[(i + 1) % outline.length], bounds)).filter(Boolean));
  const planes = computeVolumeEavePlanes(bounds, roofType, roofConfig).filter((plane) => !plane.side || standing.has(plane.side));
  if (!planes.length) {
    return planes;
  }
  const lower = planes.find((plane) => plane.tier === 'lower' || (!plane.tier && !('constantHeight' in plane)));
  const upper = planes.find((plane) => plane.tier === 'upper');
  const facets = [];
  (volume.cuts ?? []).forEach((cut) => {
    if (cutRole(cut, roofType, { ridgeAxis: roofConfig.roofDirection, roofHighEdge: roofConfig.roofHighEdge, bounds }) !== 'eave') {
      return;
    }
    const inside = insidePoint(cut);
    if (lower) {
      facets.push({ ...makeEdgePlane(cut.a, cut.b, lower.slope, inside), ...(lower.tier ? { tier: 'lower' } : {}) });
    }
    if (upper) {
      // the upper slope meets the lower one at the break, as on the rectangle's sides
      facets.push({ ...makeEdgePlane(cut.a, cut.b, upper.slope, inside), offset: upper.offset, tier: 'upper' });
    }
  });
  // lower tiers first, as computeVolumeEavePlanes orders them
  return [...planes.filter((plane) => plane.tier !== 'upper'), ...facets.filter((plane) => plane.tier !== 'upper'),
    ...planes.filter((plane) => plane.tier === 'upper'), ...facets.filter((plane) => plane.tier === 'upper')];
}

/**
 * A cut volume's roof as triangles (see the file comment).
 *
 * @param {object} volume - with `cuts` and `outline` (js/angled-walls.js)
 * @param {string} roofType
 * @param {object} roofConfig - as for the rectangle builders: roofDirection, roofHighEdge, roofHeight, pitch, overhang (by side), eaves
 * @param {{ sharedEdge?: (a, b) => boolean }} [options] - walls shared with another volume: no overhang
 * @returns {{ triangles: Array, planes: Array, region: Array<[number, number]> }}
 */
export function buildCutRoof(volume, roofType, roofConfig, { sharedEdge = () => false } = {}) {
  const bounds = rectangleOf(volume);
  const outline = simplify(orientCCW(volume.outline ?? rectanglePolygon(bounds)));
  const planes = roofType === 'flat' ? [] : cutRoofPlanes(volume, roofType, roofConfig);
  const eaves = roofConfig.eaves ?? {};
  const ov = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, ...(roofConfig.overhang ?? {}) };
  // a side shared with a neighbor along part of its length gets no overhang
  // from the eave setup; the stretch of it that is outside gets its own
  const full = sideOverhangs(roofType, { ridgeAxis: roofConfig.roofDirection, roofHighEdge: roofConfig.roofHighEdge }, {
    eaveDepth: eaves.eaveDepth ?? 0, rakeDepth: eaves.rakeDepth ?? 0,
  }).overhang;
  const f = roofConfig.eaves ? eaves.fasciaDepth ?? 0 : 0;

  // each wall's overhang
  const depths = outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length];
    if (sharedEdge(a, b)) {
      return 0;
    }
    const side = rectangleSide(a, b, bounds);
    if (side) {
      return ov[side] > 1e-9 ? ov[side] : full[side];
    }
    const cut = (volume.cuts ?? []).find((candidate) => onLine(candidate, a) && onLine(candidate, b));
    if (roofType === 'hip') {
      return Math.min(ov.minX, ov.maxX, ov.minZ, ov.maxZ);
    }
    if (roofType === 'flat' || !cut) {
      return eaves.eaveDepth ?? 0;
    }
    return cutRole(cut, roofType, { ridgeAxis: roofConfig.roofDirection, roofHighEdge: roofConfig.roofHighEdge, bounds }) === 'eave'
      ? eaves.eaveDepth ?? 0
      : eaves.rakeDepth ?? 0;
  });
  const region = offsetPolygon(outline, depths);
  const lift = (polygon, y = (x, z) => evalZoneHeight(planes, x, z)) => polygon.map(([x, z]) => [x, y(x, z), z]);
  const triangles = [];

  if (roofType === 'flat' || !planes.length) {
    const t = FLAT_ROOF_THICKNESS;
    triangles.push(...polygonsToTriangles([lift(region, () => t), lift(region, () => 0).reverse()]));
    region.forEach((a, i) => {
      const b = region[(i + 1) % region.length];
      triangles.push(...quad([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], t, b[1]], [a[0], t, a[1]]));
    });
    return { triangles, planes, region };
  }

  // the roof faces
  triangles.push(...minOfPlanesOver(region, planes));

  // each wall up to the roof over it (a gable end; against another volume,
  // the caller clips away what is inside it)
  outline.forEach((a, i) => {
    const b = outline[(i + 1) % outline.length];
    const top = profilePoints(planes, a, b);
    if (Math.max(...top.map(([, y]) => y)) > 1e-6) {
      triangles.push(...polygonsToTriangles([[[a[0], 0, a[1]], [b[0], 0, b[1]], ...top.reverse()]]));
    }
  });

  if (!roofConfig.eaves) {
    return { triangles, planes, region };
  }
  // how the soffit under the overhang of wall i runs: flat under a level eave, else under the roof
  const level = region.map((a, i) => {
    const heights = profilePoints(planes, a, region[(i + 1) % region.length]).map(([, y]) => y);
    return Math.max(...heights) - Math.min(...heights) < 1e-6;
  });
  const flatSoffit = (i) => level[i] && (eaves.eaveSoffit ?? 'flat') === 'flat';
  const eaveHeight = (i) => evalZoneHeight(planes, region[i][0], region[i][1]);
  const soffitAt = (i, [x, z]) => (flatSoffit(i) ? eaveHeight(i) - f : evalZoneHeight(planes, x, z) - f);

  outline.forEach((wallA, i) => {
    if (!(depths[i] > 1e-9)) {
      return;
    }
    const next = (i + 1) % outline.length;
    const [wallB, edgeA, edgeB] = [outline[next], region[i], region[next]];
    // the fascia, under the roof's edge
    const top = profilePoints(planes, edgeA, edgeB);
    top.slice(0, -1).forEach((p, k) => {
      const q = top[k + 1];
      triangles.push(...quad(p, q, [q[0], q[1] - f, q[2]], [p[0], p[1] - f, p[2]]));
    });
    // the soffit, from the fascia's foot back to the wall (facing down)
    const strip = [wallA, wallB, edgeB, edgeA];
    if (flatSoffit(i)) {
      triangles.push(...polygonsToTriangles([lift(strip, () => eaveHeight(i) - f).reverse()]));
    } else {
      triangles.push(...minOfPlanesOver(strip, planes).map((triangle) => triangle.map(([x, y, z]) => [x, y - f, z]).reverse()));
    }
  });

  // at each corner, close the gap between the two soffits (or cap an
  // overhang whose neighbor has none) along the line from the wall corner
  // out to the corner of the roof's edge
  outline.forEach((wall, i) => {
    const previous = (i + outline.length - 1) % outline.length;
    const edge = region[i];
    if (Math.hypot(edge[0] - wall[0], edge[1] - wall[1]) < 1e-9) {
      return;
    }
    const tops = profilePoints(planes, wall, edge);
    const bottom = (k) => (depths[k] > 1e-9
      ? tops.map(([x, , z]) => [x, soffitAt(k, [x, z]), z])
      : tops);
    const [before, after] = [bottom(previous), bottom(i)];
    before.slice(0, -1).forEach((p, k) => {
      const [q, r, s] = [before[k + 1], after[k + 1], after[k]];
      const gap = [p, q, r, s].filter((point, n, all) => {
        const other = all[(n + 1) % all.length];
        return Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]) > 1e-9;
      });
      if (gap.length >= 3) {
        triangles.push(...polygonsToTriangles([gap]));
      }
    });
  });
  return { triangles, planes, region };
}

/**
 * The faces of a min-of-planes roof over a convex plan polygon: each plane
 * over the part of it where that plane is the lowest.
 */
export function minOfPlanesOver(polygon, planes) {
  const triangles = [];
  planes.forEach((plane, i) => {
    let face = polygon;
    planes.forEach((other, k) => {
      if (k !== i && face.length >= 3) {
        // identical planes belong to the first of them
        const bias = k < i ? 1e-9 : 0;
        face = clipPolygon(face, ([x, z]) => evalPlaneHeight(other, x, z) - evalPlaneHeight(plane, x, z) - bias);
      }
    });
    if (face.length >= 3) {
      triangles.push(...polygonsToTriangles([face.map(([x, z]) => [x, evalPlaneHeight(plane, x, z), z])]));
    }
  });
  return triangles;
}

/**
 * A convex polygon (counter-clockwise, in the x-z sense of the shoelace
 * sum) with edge i pushed out by `depths[i]`.
 */
export function offsetPolygon(polygon, depths) {
  const n = polygon.length;
  const lines = polygon.map((a, i) => {
    const b = polygon[(i + 1) % n];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const direction = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    // outward is to the right of travel on a counter-clockwise ring
    const outward = [direction[1], -direction[0]];
    return { point: [a[0] + outward[0] * depths[i], a[1] + outward[1] * depths[i]], direction };
  });
  return polygon.map((corner, i) => {
    const [l1, l2] = [lines[(i + n - 1) % n], lines[i]];
    const denominator = l1.direction[0] * l2.direction[1] - l1.direction[1] * l2.direction[0];
    if (Math.abs(denominator) < 1e-12) {
      // one straight wall with two overhangs: the deeper one reaches the corner
      const previous = polygon[(i + n - 1) % n];
      return depths[i] >= depths[(i + n - 1) % n]
        ? l2.point
        : [corner[0] + l1.point[0] - previous[0], corner[1] + l1.point[1] - previous[1]];
    }
    const t = ((l2.point[0] - l1.point[0]) * l2.direction[1] - (l2.point[1] - l1.point[1]) * l2.direction[0]) / denominator;
    return [l1.point[0] + l1.direction[0] * t, l1.point[1] + l1.direction[1] * t];
  });
}

/** The roof's edge above the segment a-b, as [x, y, z] points at its bends. */
function profilePoints(planes, a, b) {
  return roofProfile(planes, a, b).map(([t, y]) => [a[0] + (b[0] - a[0]) * t, y, a[1] + (b[1] - a[1]) * t]);
}

function quad(a, b, c, d) {
  return polygonsToTriangles([[a, b, c, d]]);
}

function rectangleOf(volume) {
  return { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };
}

function rectanglePolygon(bounds) {
  return [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ], [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]];
}

/** The side of the rectangle a wall lies on, if it lies on one. */
function rectangleSide(a, b, bounds) {
  const on = (value, target) => Math.abs(value - target) < 1e-6;
  if (on(a[0], b[0])) {
    return on(a[0], bounds.minX) ? 'minX' : on(a[0], bounds.maxX) ? 'maxX' : null;
  }
  if (on(a[1], b[1])) {
    return on(a[1], bounds.minZ) ? 'minZ' : on(a[1], bounds.maxZ) ? 'maxZ' : null;
  }
  return null;
}

function onLine(cut, point) {
  return Math.abs(cutDistance(cut, point)) < 1e-6;
}

function insidePoint(cut) {
  const [dx, dz] = [cut.b[0] - cut.a[0], cut.b[1] - cut.a[1]];
  const length = Math.hypot(dx, dz) || 1;
  // the building is on the positive side of cutDistance: to the left of a -> b
  return [(cut.a[0] + cut.b[0]) / 2 - dz / length, (cut.a[1] + cut.b[1]) / 2 + dx / length];
}

function orientCCW(polygon) {
  const area = polygon.reduce((sum, [x, z], i) => {
    const [nx, nz] = polygon[(i + 1) % polygon.length];
    return sum + x * nz - nx * z;
  }, 0);
  return area < 0 ? [...polygon].reverse() : polygon;
}

/** Drops repeated points (a point in the middle of a straight wall stays: a neighbor's wall begins there). */
function simplify(polygon) {
  return polygon.filter((point, i) => {
    const next = polygon[(i + 1) % polygon.length];
    return Math.hypot(next[0] - point[0], next[1] - point[1]) > 1e-9;
  });
}
