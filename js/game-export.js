/**
 * The building as the Dixon game wants it: a triangle soup grouped by the
 * game's material names, in the game's own space, so the game can drop it in
 * place of the building it generated. Also the project file (.bld) it was
 * made from, so the game can hand the design back to Composer.
 *
 * Game space is x east, z south, y up, meters, like Composer's, so a point
 * moves with the placement saved at import (game = center + R(rotation) *
 * Composer point) and its height stays relative to the ground; the game adds
 * the ground level under its building.
 *
 * Collision. A solid building (version 1) is a block: its `hull`, from `y0`
 * to `y1`. A walk-in building (version 2, `interior: true`; see
 * js/interior.js) also carries `collision.faces`: every triangle a character
 * should collide with, as flat [x, y, z, x, y, z, x, y, z, ...] in game space
 * (heights relative to the ground, as in `near`), meant to be used
 * double-sided (Godot: ConcavePolygonShape3D.set_faces). It leaves out what
 * a character passes through: open door leaves, window and door frames and
 * panes, and the skins over the walls (facade panels, trim). A loader should
 * collide with `collision` when it's there, and fall back to the hull.
 */

import * as THREE from '../node_modules/three/build/three.module.js';

/** The game material for a wall of each Composer palette entry. */
export const GAME_WALLS = Object.freeze({
  brick: 'brick_red', wood: 'siding_white', stucco: 'siding_butter', metal: 'roof_metal', stone: 'limestone', paint: 'siding_white', black: 'trim_dark',
});
/** ...and for a roof of each (a roof with no choice is shingled). */
export const GAME_ROOFS = Object.freeze({ metal: 'roof_metal', wood: 'shingles_brown' });
// Placeholder names, same as GAME_WALLS/GAME_ROOFS: confirm against the
// Dixon game's actual material vocabulary before relying on this export.
export const GAME_DOORS = Object.freeze({
  brick: 'brick_red', wood: 'door_wood', stucco: 'siding_butter', metal: 'roof_metal', stone: 'limestone',
});
const GLASS = 'glass_clear';
// Placeholders too: a walk-in interior's surfaces (see js/interior.js)
export const GAME_INTERIOR = Object.freeze({
  'interior-wall': 'plaster_white', 'interior-floor': 'floor_wood', 'interior-ceiling': 'plaster_ceiling',
});
const SHINGLES = 'shingles_dark';
const MEMBRANE = 'roof_membrane';
const FOUNDATION = 'stone_foundation';
const TRIM = 'siding_white';
const PORCH_FLOOR = 'trim_dark';

const MIN_AREA = 1e-8;
const FLAT = 0.98;
const round = (value) => Math.round(value * 1000) / 1000;

/**
 * The game material a piece of the model is made of: from its Composer
 * material's role (wall, foundation, roof) and palette entry, and its
 * direction (a roof laid flat is a membrane; the underside and edge of a
 * roof are trim).
 */
export function gameMaterial({ role, palette, part }, normal) {
  if (part === 'floor') {
    return PORCH_FLOOR;
  }
  if (role === 'foundation') {
    return FOUNDATION;
  }
  if (role === 'roof') {
    if (normal[1] < 0.5) {
      return TRIM;
    }
    if (normal[1] > FLAT) {
      return palette === 'metal' ? GAME_ROOFS.metal : MEMBRANE;
    }
    return GAME_ROOFS[palette] ?? SHINGLES;
  }
  if (role === 'glass') {
    return GLASS;
  }
  if (GAME_INTERIOR[role]) {
    return GAME_INTERIOR[role];
  }
  if (role === 'door') {
    return GAME_DOORS[palette] ?? GAME_DOORS.wood;
  }
  return GAME_WALLS[palette] ?? GAME_WALLS.wood;
}

/** What a character walks through rather than into: an open door's leaf, a window or door's frame, pane, and details (sill, shutters, grille), and skins over a wall (facade panels, trim). */
const PASSABLE = new Set(['door-leaf', 'opening-frame', 'opening-pane', 'opening-detail', 'facade-panel', 'trim']);

/** Whether a mesh goes into the game's collision mesh (see buildGameFile). */
function collides(mesh) {
  return mesh.userData?.collides !== false && !PASSABLE.has(mesh.userData?.bodyPart);
}

/** Whether the mesh or anything above it is only for the editor's eyes. */
function editorOnly(object, root) {
  for (let node = object; node; node = node.parent) {
    if (node.userData?.editorOnly || node.visible === false) {
      return true;
    }
    if (node === root) {
      break;
    }
  }
  return false;
}

/**
 * Every triangle of the building, in Composer space, with what it is made of.
 * Overlays that only repeat the wall beneath (a facade panel of the wall's own
 * material) are left out, and so are the editor's guides and pick targets.
 */
export function modelTriangles(root) {
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((mesh) => {
    const material = mesh.material;
    if (!mesh.isMesh || !material?.userData?.role || editorOnly(mesh, root)) {
      return;
    }
    if (mesh.userData?.bodyPart === 'facade-panel' && mesh.userData.material === materialOfWalls(root)) {
      return;
    }
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    const count = index ? index.count : position.count;
    const point = (i) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
    for (let i = 0; i < count; i += 3) {
      const tri = [point(i), point(i + 1), point(i + 2)].map((p) => [p.x, p.y, p.z]);
      out.push({
        tri,
        role: material.userData.role,
        palette: material.userData.palette,
        part: mesh.userData?.structurePart,
        collides: collides(mesh),
        oriented: mesh.userData?.oriented === true,
      });
    }
  });
  return out;
}

function materialOfWalls(root) {
  let found;
  root.traverse((mesh) => {
    if (found === undefined && mesh.isMesh && mesh.material?.userData?.role === 'wall' && mesh.userData?.bodyPart === 'walls') {
      found = mesh.material.userData.palette;
    }
  });
  return found;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v) => {
  const length = Math.hypot(...v);
  return length < 1e-12 ? [0, 1, 0] : [v[0] / length, v[1] / length, v[2] / length];
};

/**
 * For each triangle, whether the way its winding faces (right-hand rule) is
 * outward from the building. Composer's shell is not closed (a roof is one
 * sheet, walls have caps that end up inside it) and its winding is not kept
 * consistent, so parity will not do. Rays leave the face both ways; the side
 * that crosses fewer surfaces before escaping is outward. Three slightly
 * different rays each way keep one that grazes an edge from deciding it. A
 * face buried inside the building crosses as much either way and keeps its
 * winding; nothing sees it. A face marked `oriented` (built wound from the
 * mass into the air, as a walk-in room's are) is taken as it is.
 */
export function windingsPointOutward(triangles) {
  const flat = new Float64Array(triangles.length * 9);
  triangles.forEach(({ tri }, i) => tri.forEach((p, k) => flat.set(p, i * 9 + k * 3)));
  const crossings = (origin, direction, skip) => {
    let count = 0;
    for (let i = 0; i < triangles.length; i += 1) {
      if (i === skip) {
        continue;
      }
      const o = i * 9;
      const e1x = flat[o + 3] - flat[o];
      const e1y = flat[o + 4] - flat[o + 1];
      const e1z = flat[o + 5] - flat[o + 2];
      const e2x = flat[o + 6] - flat[o];
      const e2y = flat[o + 7] - flat[o + 1];
      const e2z = flat[o + 8] - flat[o + 2];
      const px = direction[1] * e2z - direction[2] * e2y;
      const py = direction[2] * e2x - direction[0] * e2z;
      const pz = direction[0] * e2y - direction[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-12) {
        continue;
      }
      const tx = origin[0] - flat[o];
      const ty = origin[1] - flat[o + 1];
      const tz = origin[2] - flat[o + 2];
      const u = (tx * px + ty * py + tz * pz) / det;
      if (u < 0 || u > 1) {
        continue;
      }
      const qx = ty * e1z - tz * e1y;
      const qy = tz * e1x - tx * e1z;
      const qz = tx * e1y - ty * e1x;
      const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) / det;
      if (v < 0 || u + v > 1) {
        continue;
      }
      if ((e2x * qx + e2y * qy + e2z * qz) / det > 1e-6) {
        count += 1;
      }
    }
    return count;
  };
  return triangles.map(({ tri, oriented }, i) => {
    // (a face built wound outward keeps its winding, and needs no rays)
    if (oriented) {
      return true;
    }
    const n = unit(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
    const centre = [0, 1, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
    const side = unit(cross(n, Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const back = cross(n, side);
    let along = 0;
    let against = 0;
    [[0, 0], [0.07, 0.03], [-0.03, 0.07]].forEach(([s, t]) => {
      const tilt = unit(n.map((v, k) => v + side[k] * s + back[k] * t));
      const away = tilt.map((v) => -v);
      along += crossings(centre.map((v, k) => v + n[k] * 1e-3), tilt, i);
      against += crossings(centre.map((v, k) => v - n[k] * 1e-3), away, i);
    });
    return along <= against;
  });
}

/**
 * A texture frame for a flat face, in meters: on a wall U runs along the wall
 * and V up it; on a roof V runs down the slope and U across it.
 */
function textureFrame(normal) {
  if (Math.abs(normal[1]) < 0.5) {
    const along = unit([normal[2], 0, -normal[0]]);
    return { u: along, v: [0, 1, 0] };
  }
  const up = [0, 1, 0];
  const uphill = unit(sub(up, normal.map((c) => c * normal[1])));
  const down = normal[1] > 0 ? uphill.map((c) => -c) : uphill;
  const downSlope = Math.hypot(...down) < 1e-9 ? [0, 0, 1] : down;
  return { u: unit(cross(normal, downSlope)), v: downSlope };
}

/**
 * The game file for a building: `near` groups (game material name -> the
 * `verts` and `indices` its chunk files use), the outline's convex hull and
 * height range for collision, and the project it came from.
 *
 * @param {THREE.Object3D} root - The built model (with editor overlays; they are skipped).
 * @param {{rotation: number, center: number[], id: string, source?: string, groundY?: number}} placement
 * @param {object} [project] - The serialized project (.bld) to keep beside the mesh.
 */
export function buildGameFile(root, placement, project) {
  const triangles = modelTriangles(root).filter(({ tri }) => {
    const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    return Math.hypot(...n) / 2 > MIN_AREA;
  });
  // faces built wound from the mass into the air (a walk-in shell's) keep their
  // winding; the ray test (which a room's inner walls would fool) orients the rest
  const outward = windingsPointOutward(triangles);
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  const toGame = ([x, y, z]) => [placement.center[0] + x * cos - z * sin, y, placement.center[1] + x * sin + z * cos];

  const groups = new Map();
  const outline = [];
  let y0 = Infinity;
  let y1 = -Infinity;
  triangles.forEach((entry, i) => {
    const [a, b, c] = entry.tri.map(toGame);
    const n = unit(cross(sub(b, a), sub(c, a)));
    const facing = outward[i] ? n : n.map((v) => -v);
    const key = gameMaterial({ role: entry.role, palette: entry.palette, part: entry.part }, facing);
    if (!groups.has(key)) {
      groups.set(key, { verts: [], indices: [], seen: new Map() });
    }
    const group = groups.get(key);
    const frame = textureFrame(facing);
    // Godot faces a triangle whose right-hand normal points into the building
    const order = outward[i] ? [a, c, b] : [a, b, c];
    order.forEach((p) => {
      const row = [
        round(p[0]), round(p[1]), round(p[2]),
        round(facing[0]), round(facing[1]), round(facing[2]),
        round(dot(p, frame.u)), round(dot(p, frame.v)),
        1, 1, 1, 1,
      ];
      const id = row.join(',');
      if (!group.seen.has(id)) {
        group.seen.set(id, group.verts.length);
        group.verts.push(row);
      }
      group.indices.push(group.seen.get(id));
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
      outline.push([p[0], p[2]]);
    });
  });

  const near = {};
  groups.forEach((group, key) => {
    near[key] = { verts: group.verts, indices: group.indices };
  });
  const file = {
    format: 'dixon-composed',
    version: 1,
    id: placement.id,
    source: placement.source ?? 'building-composer',
    placement,
    y0: round(y0),
    y1: round(y1),
    hull: convexHull(outline).map(([x, z]) => [round(x), round(z)]),
    near,
    project,
  };
  if (root.userData?.interiorRooms?.length) {
    // a walk-in building: collide with its surfaces, not its hull (see the file header)
    const faces = [];
    triangles.forEach((entry) => {
      if (entry.collides) {
        entry.tri.map(toGame).forEach((p) => faces.push(round(p[0]), round(p[1]), round(p[2])));
      }
    });
    Object.assign(file, { version: 2, interior: true, collision: { faces } });
  }
  return file;
}

/** The convex hull of plan points (Andrew's monotone chain). */
export function convexHull(points) {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (list) => {
    const out = [];
    list.forEach((p) => {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], p) <= 0) {
        out.pop();
      }
      out.push(p);
    });
    out.pop();
    return out;
  };
  return sorted.length < 3 ? sorted : [...chain(sorted), ...chain([...sorted].reverse())];
}
