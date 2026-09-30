/**
 * Angled walls: footprint edges that run along neither axis (a clipped
 * street corner, a wedge-shaped lot, a church apse).
 *
 * Composer's massing is built from axis-aligned rectangles (volumes), and
 * its roofs from planes over them. An angled wall does not change that: the
 * footprint is first squared out to its rectilinear hull, each angled run of
 * walls replaced by the corner outside it, and cut into volumes as before.
 * The angled walls then come back as cuts: each volume keeps the angled
 * walls that cross it (`cuts`) and its true plan (`outline`, its rectangle
 * less what the cuts take off). Its roof is built over the rectangle and cut
 * the same way (see js/extrusion.js).
 *
 * Pure functions; no DOM or THREE dependency.
 */
import { clipPolygon } from './roof-structures.js';

const EPSILON = 1e-6;

/** Whether the edge from a to b runs along an axis. */
export function isAxisAligned(a, b) {
  return Math.abs(b[0] - a[0]) < EPSILON || Math.abs(b[1] - a[1]) < EPSILON;
}

/** Whether a footprint has any angled wall. */
export function hasAngledWalls(footprint) {
  const ring = openRing(footprint);
  return ring.some((point, i) => !isAxisAligned(point, ring[(i + 1) % ring.length]));
}

/**
 * The footprint squared out: each run of angled walls replaced by the corner
 * outside it. A run is consecutive angled walls heading into one quadrant
 * and turning outward (a convex arc, such as the facets of an apse); a run
 * that turns inward is split, so that each cut is convex.
 *
 * @param {Array<[number, number]>} footprint - open or closed, either winding
 * @returns {{ hull: Array<[number, number]>, cuts: Array<{ a: [number, number], b: [number, number] }> }}
 *   `cuts` are the angled walls, each from a to b with the building to its
 *   left in the footprint's own winding (see cutDistance).
 */
export function rectilinearHull(footprint) {
  const ring = openRing(footprint);
  const turn = Math.sign(signedArea(ring)) || 1;
  const n = ring.length;
  const angled = ring.map((point, i) => !isAxisAligned(point, ring[(i + 1) % n]));
  if (!angled.some(Boolean)) {
    return { hull: ring, cuts: [] };
  }
  // start just after an axis-aligned wall, so no run wraps past the start
  const start = angled.every(Boolean) ? 0 : (angled.findIndex((isAngled, i) => !isAngled && angled[(i + 1) % n]) + 1) % n;
  const quadrant = (a, b) => `${Math.sign(b[0] - a[0])},${Math.sign(b[1] - a[1])}`;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const hull = [];
  const cuts = [];
  let run = null;
  const closeRun = () => {
    if (!run) {
      return;
    }
    const [p, q] = [run[0], run[run.length - 1]];
    // of the two corners of the run's box, the one outside the building
    const corner = [[q[0], p[1]], [p[0], q[1]]].find((c) => Math.sign(cross(p, q, c)) === -turn) ?? [q[0], p[1]];
    hull.push(corner, q);
    run.slice(0, -1).forEach((a, k) => cuts.push(turn > 0 ? { a, b: run[k + 1] } : { a: run[k + 1], b: a }));
    run = null;
  };
  for (let k = 0; k < n; k += 1) {
    const i = (start + k) % n;
    const [point, next] = [ring[i], ring[(i + 1) % n]];
    if (!angled[i]) {
      closeRun();
      hull.push(next);
      continue;
    }
    if (run) {
      const previous = run[run.length - 2];
      const sameQuadrant = quadrant(previous, point) === quadrant(point, next);
      const outward = Math.sign(cross(previous, point, next)) === turn;
      if (!(sameQuadrant && outward)) {
        closeRun();
      }
    }
    if (!run) {
      if (hull.length === 0 || !samePoint(hull[hull.length - 1], point)) {
        hull.push(point);
      }
      run = [point];
    }
    run.push(next);
  }
  closeRun();
  // the start point was pushed last (as the end of the final wall), and may repeat
  return { hull: dedupe(hull), cuts };
}

/**
 * How far a plan point is inside an angled wall: positive on the building's
 * side of its line.
 */
export function cutDistance(cut, [x, z]) {
  const [dx, dz] = [cut.b[0] - cut.a[0], cut.b[1] - cut.a[1]];
  const length = Math.hypot(dx, dz) || 1;
  return (dx * (z - cut.a[1]) - dz * (x - cut.a[0])) / length;
}

/**
 * The volumes of the squared-out footprint cut back to the real one: each
 * keeps the angled walls that cross its rectangle (`cuts`) and its real plan
 * (`outline`); a volume the cuts take away entirely is dropped. Returns null
 * when the volumes do not cover the footprint exactly (an angled wall whose
 * corner reaches past another part of the building).
 */
export function cutVolumes(volumes, cuts, footprint) {
  const kept = [];
  volumes.forEach((volume) => {
    const rectangle = [[volume.minX, volume.minZ], [volume.maxX, volume.minZ], [volume.maxX, volume.maxZ], [volume.minX, volume.maxZ]];
    const own = cuts.filter((cut) => crossesRectangle(cut, volume));
    const outline = own.reduce((polygon, cut) => (polygon.length >= 3 ? clipPolygon(polygon, (point) => cutDistance(cut, point)) : polygon), rectangle);
    if (outline.length < 3 || Math.abs(signedArea(outline)) < EPSILON) {
      return;
    }
    kept.push(own.length ? { ...volume, cuts: own, outline: dedupe(outline) } : volume);
  });
  const covered = kept.reduce((sum, volume) => sum + Math.abs(signedArea(volume.outline ?? [
    [volume.minX, volume.minZ], [volume.maxX, volume.minZ], [volume.maxX, volume.maxZ], [volume.minX, volume.maxZ],
  ])), 0);
  const area = Math.abs(signedArea(openRing(footprint)));
  if (Math.abs(covered - area) > 1e-6 * Math.max(1, area)) {
    return null;
  }
  // each outline broken where another volume's corner meets it, so that a
  // wall shared along part of its length is two walls (see js/cut-roofs.js)
  return kept.map((volume, index) => ({
    ...volume,
    id: `volume-${index}`,
    ...(volume.outline ? { outline: withCornersOf(kept.filter((other) => other !== volume), volume.outline) } : {}),
  }));
}

/** An outline with the rectangle corners of `others` that lie inside its edges added as points. */
function withCornersOf(others, outline) {
  const corners = others.flatMap((v) => [[v.minX, v.minZ], [v.maxX, v.minZ], [v.maxX, v.maxZ], [v.minX, v.maxZ]]);
  return outline.flatMap((a, i) => {
    const b = outline[(i + 1) % outline.length];
    const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
    const length2 = dx * dx + dz * dz;
    const inside = corners
      .map((c) => ({ c, t: ((c[0] - a[0]) * dx + (c[1] - a[1]) * dz) / length2 }))
      .filter(({ c, t }) => t > EPSILON && t < 1 - EPSILON && Math.abs(dx * (c[1] - a[1]) - dz * (c[0] - a[0])) / Math.sqrt(length2) < EPSILON)
      .sort((p, q) => p.t - q.t)
      .map(({ c }) => c);
    return [a, ...dedupe(inside).filter((c, k, all) => k === 0 || !samePoint(c, all[k - 1]))];
  });
}

/** Whether a wall segment passes through a rectangle's interior. */
function crossesRectangle(cut, rect) {
  // clip the segment to the rectangle (Liang-Barsky) and see what is left
  let [t0, t1] = [0, 1];
  const [dx, dz] = [cut.b[0] - cut.a[0], cut.b[1] - cut.a[1]];
  const limits = [[-dx, cut.a[0] - rect.minX], [dx, rect.maxX - cut.a[0]], [-dz, cut.a[1] - rect.minZ], [dz, rect.maxZ - cut.a[1]]];
  for (const [p, q] of limits) {
    if (Math.abs(p) < 1e-12) {
      if (q < EPSILON) {
        return false;
      }
    } else {
      const t = q / p;
      if (p < 0) {
        t0 = Math.max(t0, t);
      } else {
        t1 = Math.min(t1, t);
      }
    }
  }
  return (t1 - t0) * Math.hypot(dx, dz) > EPSILON;
}

function openRing(footprint) {
  const ring = footprint.map(([x, z]) => [Number(x), Number(z)]);
  return ring.length > 1 && samePoint(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring;
}

function dedupe(ring) {
  return ring.filter((point, i) => !samePoint(point, ring[(i + 1) % ring.length]));
}

function samePoint(a, b) {
  return Math.abs(a[0] - b[0]) < EPSILON && Math.abs(a[1] - b[1]) < EPSILON;
}

function signedArea(ring) {
  return ring.reduce((sum, [x, z], i) => {
    const [nx, nz] = ring[(i + 1) % ring.length];
    return sum + x * nz - nx * z;
  }, 0) / 2;
}
