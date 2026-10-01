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
import {
  FLAT, STEEP, GLASS, gameManifest, gameMaterialFor, unknownMaterials,
} from './game-materials.js';

export {
  GAME_WALLS, GAME_ROOFS, GAME_DOORS, GAME_INTERIOR,
} from './game-materials.js';

const MIN_AREA = 1e-8;
const round = (value) => Math.round(value * 1000) / 1000;

/**
 * The game material a piece of the model is made of (see gameMaterialFor in
 * js/game-materials.js): its Composer material's role and palette entry, the
 * structure part it is, the game finishes chosen for it, and its direction.
 */
export function gameMaterial({
  role, palette, part, finishes,
}, normal) {
  return gameMaterialFor({
    role, palette, part, finishes,
  }, normal);
}

/**
 * How the game's window shader shows a pane at night, as its vertex color
 * (lit, warmth, curtain, storefront), drawn as the game draws its own
 * buildings' (dixon_dem pipeline/buildings/facade.py window_unit): about a
 * third lit (a shopfront, nearly half), a warmth, and a curtain. The draw is
 * seeded by the building and the pane, so a building looks the same each
 * time it is sent.
 */
export function paneLight(buildingId, paneKey, shopfront = false) {
  const random = seededRandom(`${buildingId}|${paneKey}`);
  const lit = random() < (shopfront ? 0.45 : 0.35) ? 1 : 0;
  const warmth = random();
  const curtain = [0, 0, 0.35, 0.65, 0.9][Math.floor(random() * 5)];
  return [lit, round(warmth), curtain, shopfront ? 1 : 0];
}

/** A small seeded generator (FNV-1a of the key, then mulberry32). */
function seededRandom(key) {
  let seed = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    seed = Math.imul(seed ^ key.charCodeAt(i), 0x01000193) >>> 0;
  }
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What stops a game file being sent: surfaces whose material the game
 * doesn't have (it would draw them untextured).
 * @returns {string[]} one message per unknown material, empty when it can be sent
 */
export function gameFileProblems(file) {
  return unknownMaterials(Object.keys(file.near ?? {})).map((name) => {
    const count = file.near[name].indices.length / 3;
    return `${count} triangle${count === 1 ? '' : 's'} use "${name}", which the game doesn't have`;
  });
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
        finishes: mesh.userData?.gameFinishes ?? {},
        // a window's glass: which pane (the game lights each on its own)
        pane: mesh.userData?.bodyPart === 'opening-pane'
          ? { key: `${mesh.userData.openingId}:${mesh.userData.pane ?? 0}`, shopfront: mesh.userData.shopfront === true }
          : null,
        collides: collides(mesh),
        oriented: mesh.userData?.oriented === true,
        // which mesh it came from (refineRoofParts looks at a roof mesh as a whole)
        mesh: mesh.id,
      });
    }
  });
  return out;
}

/**
 * Roof triangles that are something else in the game. A roof mesh carries
 * its gable ends (the wall above the plate under a gable), which are wall:
 * a vertical roof triangle in the plane of one of the building's walls, just
 * above it, takes that wall's material and finishes. And it carries the
 * soffits and cornice ledges at its eaves, level strips at its bottom that
 * the outward test can't orient (they're tucked under the overhang), which
 * are trim (`part: 'soffit'`), not flat roof.
 */
// how far above a pitched roof's bottom a level face is still its eave (a soffit, a cornice's top)
const SOFFIT_REACH = 0.3;

export function refineRoofParts(triangles) {
  const normalOf = (tri) => unit(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
  const lowest = (tri) => Math.min(tri[0][1], tri[1][1], tri[2][1]);
  const highest = (tri) => Math.max(tri[0][1], tri[1][1], tri[2][1]);
  const walls = triangles.flatMap((entry) => {
    if (entry.role !== 'wall') {
      return [];
    }
    const n = normalOf(entry.tri);
    return Math.abs(n[1]) < 0.01 ? [{ n, d: dot(n, entry.tri[0]), top: highest(entry.tri), entry }] : [];
  });
  // each roof mesh's bottom, and whether it has any slope (a flat roof's level faces are roof)
  const roofs = new Map();
  triangles.forEach(({ role, tri, mesh }) => {
    if (role !== 'roof') {
      return;
    }
    const ny = Math.abs(normalOf(tri)[1]);
    const roof = roofs.get(mesh) ?? { bottom: Infinity, pitched: false };
    roof.bottom = Math.min(roof.bottom, lowest(tri));
    roof.pitched ||= ny > STEEP && ny < FLAT;
    roofs.set(mesh, roof);
  });
  return triangles.map((entry) => {
    if (entry.role !== 'roof') {
      return entry;
    }
    const n = normalOf(entry.tri);
    const ny = Math.abs(n[1]);
    if (ny < STEEP) {
      const wall = walls.find((candidate) => Math.abs(Math.abs(dot(candidate.n, n)) - 1) < 1e-4
        && entry.tri.every((p) => Math.abs(dot(candidate.n, p) - candidate.d) < 0.01)
        && Math.abs(candidate.top - lowest(entry.tri)) < 0.05);
      return wall ? { ...entry, role: 'wall', palette: wall.entry.palette, finishes: wall.entry.finishes } : entry;
    }
    const roof = roofs.get(entry.mesh);
    if (ny > FLAT && roof?.pitched && highest(entry.tri) - roof.bottom < SOFFIT_REACH) {
      return { ...entry, part: 'soffit' };
    }
    return entry;
  });
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
  const triangles = refineRoofParts(modelTriangles(root).filter(({ tri }) => {
    const n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
    return Math.hypot(...n) / 2 > MIN_AREA;
  }));
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
  const faced = triangles.map((entry, i) => {
    const corners = entry.tri.map(toGame);
    const n = unit(cross(sub(corners[1], corners[0]), sub(corners[2], corners[0])));
    const facing = outward[i] ? n : n.map((v) => -v);
    return {
      entry, corners, facing, key: gameMaterial(entry, facing),
    };
  });
  const panes = paneFrames(faced);
  faced.forEach(({
    entry, corners: [a, b, c], facing, key,
  }, i) => {
    if (!groups.has(key)) {
      groups.set(key, { verts: [], indices: [], seen: new Map() });
    }
    const group = groups.get(key);
    const frame = textureFrame(facing);
    // a lit window's glass runs 0-1 across its pane and carries the pane's light
    const pane = key === GLASS && entry.pane ? panes.get(entry.pane.key) : null;
    const light = pane ? paneLight(placement.id, entry.pane.key, entry.pane.shopfront) : [1, 1, 1, 1];
    const uv = pane
      ? (p) => [(dot(p, pane.u) - pane.u0) / pane.width, (dot(p, pane.v) - pane.v0) / pane.height]
      : (p) => [dot(p, frame.u), dot(p, frame.v)];
    // Godot faces a triangle whose right-hand normal points into the building
    const order = outward[i] ? [a, c, b] : [a, b, c];
    order.forEach((p) => {
      const [u, v] = uv(p);
      const row = [
        round(p[0]), round(p[1]), round(p[2]),
        round(facing[0]), round(facing[1]), round(facing[2]),
        round(u), round(v),
        ...light,
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
    materials_version: gameManifest().hash,
    id: placement.id,
    source: placement.source ?? 'building-composer',
    placement,
    y0: round(y0),
    y1: round(y1),
    hull: convexHull(outline).map(([x, z]) => [round(x), round(z)]),
    near,
    project,
  };
  if (hasInteriorRooms(root)) {
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

/**
 * Whether the model has walk-in rooms: recorded on the building
 * (`userData.interiorRooms`), which the editor sends wrapped in its scene
 * group, so anywhere under `root`.
 */
function hasInteriorRooms(root) {
  let found = false;
  root.traverse((node) => {
    found ||= Boolean(node.userData?.interiorRooms?.length);
  });
  return found;
}

/**
 * Each window pane's extent in its own plane, in game space: the texture
 * frame of its first glass triangle, and the pane's least U and V and its
 * width and height along them.
 */
function paneFrames(faced) {
  const panes = new Map();
  faced.forEach(({ entry, corners, facing, key }) => {
    if (key !== GLASS || !entry.pane) {
      return;
    }
    if (!panes.has(entry.pane.key)) {
      panes.set(entry.pane.key, { ...textureFrame(facing), us: [], vs: [] });
    }
    const pane = panes.get(entry.pane.key);
    corners.forEach((p) => {
      pane.us.push(dot(p, pane.u));
      pane.vs.push(dot(p, pane.v));
    });
  });
  panes.forEach((pane) => {
    pane.u0 = Math.min(...pane.us);
    pane.v0 = Math.min(...pane.vs);
    pane.width = Math.max(Math.max(...pane.us) - pane.u0, 1e-6);
    pane.height = Math.max(Math.max(...pane.vs) - pane.v0, 1e-6);
  });
  return panes;
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
