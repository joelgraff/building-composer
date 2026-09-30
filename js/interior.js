/**
 * Walk-in interiors: a building's masses as hollow shells a character can
 * walk into through the doors, instead of solid blocks. Each volume (a
 * rectangle, or a convex outline where an angled wall cuts it) becomes
 * - an outer skin on the footprint line, from its floor to its wall top,
 *   with a top cap at the wall top;
 * - an inner skin `wallThickness` in from it, from the floor to the ceiling;
 * - a ceiling at the ground story's height (the first floor line; the wall
 *   top for a one-story volume), solid above it up to the wall top (upper
 *   stories wait for stairs);
 * - a bottom ring under the wall, and a floor over the room.
 * Doors are cut through the wall (an aperture: a box through the wall's
 * thickness) and the cut closed by reveals, so the shell stays closed; the
 * door leaf stands swung open into the room.
 *
 * Plain geometry: triangles of [x, y, z] points, every face wound so its
 * normal points from the mass into the air (into the room, or out to the
 * world); js/extrusion.js makes meshes of them.
 */

import { miterVector } from './trim.js';

export const INTERIOR_DEFAULTS = Object.freeze({ enabled: false, wallThickness: 0.2 });
export const WALL_THICKNESS_RANGE = Object.freeze([0.1, 0.4]);
/** The narrowest room left inside a volume's walls. */
export const MIN_ROOM = 0.6;
/** A one-story volume's ceiling sits this far under its wall top, so the wall ring closes over it. */
export const CEILING_BAND = 0.05;
/** How thick a swung-open door leaf is. */
export const DOOR_LEAF_THICKNESS = 0.045;

/** Interior settings from partial or older input (a project saved before interiors: off). */
export function normalizeInterior(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const thickness = Number.isFinite(source.wallThickness)
    ? Math.min(Math.max(source.wallThickness, WALL_THICKNESS_RANGE[0]), WALL_THICKNESS_RANGE[1])
    : INTERIOR_DEFAULTS.wallThickness;
  return { enabled: source.enabled === true, wallThickness: thickness };
}

const signedArea = (polygon) => polygon.reduce((sum, [x, z], i) => {
  const [nx, nz] = polygon[(i + 1) % polygon.length];
  return sum + (x * nz - nx * z);
}, 0) / 2;

/** Each edge's outward normal (in plan) for a polygon of either winding. */
export function outwardNormals(polygon) {
  const turn = Math.sign(signedArea(polygon)) || 1;
  return polygon.map(([x, z], i) => {
    const [nx, nz] = polygon[(i + 1) % polygon.length];
    const length = Math.hypot(nx - x, nz - z) || 1;
    return [turn * (nz - z) / length, -turn * (nx - x) / length];
  });
}

/**
 * A convex outline moved in `t` on every side (each corner along its
 * miter), or null where the walls would leave less than MIN_ROOM between
 * them (or turn an edge back on itself).
 */
export function insetOutline(outline, t) {
  const normals = outwardNormals(outline);
  const n = outline.length;
  const inset = outline.map(([x, z], i) => {
    const [mx, mz] = miterVector(normals[(i + n - 1) % n], normals[i]);
    return [x - t * mx, z - t * mz];
  });
  const area = signedArea(outline);
  const keepsDirection = outline.every(([x, z], i) => {
    const [nx, nz] = outline[(i + 1) % n];
    const [ix, iz] = inset[i];
    const [jx, jz] = inset[(i + 1) % n];
    return (nx - x) * (jx - ix) + (nz - z) * (jz - iz) > 1e-9;
  });
  if (!keepsDirection || Math.sign(signedArea(inset)) !== Math.sign(area)) {
    return null;
  }
  // every inset edge at least MIN_ROOM from the opposite side: its width across each edge's normal
  const narrow = normals.some(([nx, nz]) => {
    const across = inset.map(([x, z]) => x * nx + z * nz);
    return Math.max(...across) - Math.min(...across) < MIN_ROOM;
  });
  return narrow ? null : inset;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A triangle wound so its normal points along `toward`. */
export function facing(triangle, toward) {
  const [a, b, c] = triangle;
  return dot(cross(sub(b, a), sub(c, a)), toward) >= 0 ? triangle : [a, c, b];
}

/** A convex polygon (3D points, in order) as triangles facing `toward`. */
function fan(polygon, toward) {
  return polygon.slice(1, -1).map((_, k) => facing([polygon[0], polygon[k + 1], polygon[k + 2]], toward));
}

/** A quad (in order round it) as two triangles facing `toward`. */
function quad(a, b, c, d, toward) {
  return [facing([a, b, c], toward), facing([a, c, d], toward)];
}

/**
 * A volume's hollow shell, as triangles grouped by what they are: `outer`
 * (the outer skin, the top cap over the whole outline, and the ring under the
 * wall between its skins), `inner` (the inner skin, facing the room), and
 * `floor` and `ceiling` (the room's, facing into it). Above the ceiling the
 * volume is solid up to the top cap, so the inner skin, ceiling, and ring
 * close the wall and what stands over the room as one solid.
 *
 * @param {{ outline: number[][], inset: number[][], floorY: number, ceilingY: number, topY: number }} shell
 */
export function shellTriangles({
  outline, inset, floorY, ceilingY, topY,
}) {
  const normals = outwardNormals(outline);
  const n = outline.length;
  const at = ([x, z], y) => [x, y, z];
  const outer = [];
  const inner = [];
  outline.forEach((point, i) => {
    const next = outline[(i + 1) % n];
    const [nx, nz] = normals[i];
    const a = inset[i];
    const b = inset[(i + 1) % n];
    outer.push(...quad(at(point, floorY), at(next, floorY), at(next, topY), at(point, topY), [nx, 0, nz]));
    outer.push(...quad(at(point, floorY), at(next, floorY), at(b, floorY), at(a, floorY), [0, -1, 0]));
    inner.push(...quad(at(a, floorY), at(b, floorY), at(b, ceilingY), at(a, ceilingY), [-nx, 0, -nz]));
  });
  outer.push(...fan(outline.map((p) => at(p, topY)), [0, 1, 0]));
  return {
    outer,
    inner,
    floor: fan(inset.map((p) => at(p, floorY)), [0, 1, 0]),
    ceiling: fan(inset.map((p) => at(p, ceilingY)), [0, -1, 0]),
  };
}

/**
 * An aperture through a wall: the box across the wall's run from u0 to u1
 * (along `right` from the run's midpoint), y0 to y1, and d0 to d1 out from
 * the wall's line (along `normal`), as half-spaces (a point is inside when
 * normal · p <= offset for every one).
 */
export function apertureSolid({ start, end, normal, right }, {
  u0, u1, y0, y1, d0, d1,
}) {
  const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  const along = mid[0] * right[0] + mid[1] * right[1];
  const out = mid[0] * normal[0] + mid[1] * normal[1];
  return [
    { normal: [right[0], 0, right[1]], offset: along + u1 },
    { normal: [-right[0], 0, -right[1]], offset: -(along + u0) },
    { normal: [normal[0], 0, normal[1]], offset: out + d1 },
    { normal: [-normal[0], 0, -normal[1]], offset: -(out + d0) },
    { normal: [0, 1, 0], offset: y1 },
    { normal: [0, -1, 0], offset: -y0 },
  ];
}

/** A point on a wall run: `u` along it from its midpoint, `d` out from its line, at height `y`. */
function onWall({ start, end, normal, right }, u, y, d) {
  const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  return [mid[0] + right[0] * u + normal[0] * d, y, mid[1] + right[1] * u + normal[1] * d];
}

/**
 * The faces lining an aperture cut through a wall `t` thick (from its line
 * in to the inner skin): the two jambs, the head, and the threshold, each
 * facing into the opening.
 */
export function apertureReveals(frame, {
  u0, u1, y0, y1,
}, t) {
  const p = (u, y, d) => onWall(frame, u, y, d);
  const right = [frame.right[0], 0, frame.right[1]];
  const left = right.map((c) => -c);
  return [
    ...quad(p(u0, y0, 0), p(u0, y0, -t), p(u0, y1, -t), p(u0, y1, 0), right),
    ...quad(p(u1, y0, 0), p(u1, y0, -t), p(u1, y1, -t), p(u1, y1, 0), left),
    ...quad(p(u0, y1, 0), p(u1, y1, 0), p(u1, y1, -t), p(u0, y1, -t), [0, -1, 0]),
    ...quad(p(u0, y0, 0), p(u1, y0, 0), p(u1, y0, -t), p(u0, y0, -t), [0, 1, 0]),
  ];
}

/**
 * A door's leaf swung 90° into the room about its hinge jamb (`hinge`,
 * 'left' or 'right' as seen from outside; +u is the left seen from outside),
 * standing against the inner face of the wall `t` thick, as a closed box.
 */
export function doorLeaf(frame, {
  u0, u1, y0, y1,
}, t, hinge = 'left') {
  const width = u1 - u0;
  const [a, b] = hinge === 'right' ? [u0, u0 + DOOR_LEAF_THICKNESS] : [u1 - DOOR_LEAF_THICKNESS, u1];
  const p = (u, y, d) => onWall(frame, u, y, d);
  const into = [-frame.normal[0], 0, -frame.normal[1]];
  const out = [frame.normal[0], 0, frame.normal[1]];
  const right = [frame.right[0], 0, frame.right[1]];
  const left = right.map((c) => -c);
  const [dNear, dFar] = [-t, -t - width];
  return [
    ...quad(p(a, y0, dNear), p(b, y0, dNear), p(b, y1, dNear), p(a, y1, dNear), out),
    ...quad(p(a, y0, dFar), p(b, y0, dFar), p(b, y1, dFar), p(a, y1, dFar), into),
    ...quad(p(a, y0, dNear), p(a, y0, dFar), p(a, y1, dFar), p(a, y1, dNear), left),
    ...quad(p(b, y0, dNear), p(b, y0, dFar), p(b, y1, dFar), p(b, y1, dNear), right),
    ...quad(p(a, y1, dNear), p(b, y1, dNear), p(b, y1, dFar), p(a, y1, dFar), [0, 1, 0]),
    ...quad(p(a, y0, dNear), p(b, y0, dNear), p(b, y0, dFar), p(a, y0, dFar), [0, -1, 0]),
  ];
}
