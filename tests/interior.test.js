import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInterior, insetOutline, shellTriangles, apertureSolid, apertureReveals, doorLeaf, outwardNormals, INTERIOR_DEFAULTS,
} from '../js/interior.js';
import { clipOutsideConvexSolid } from '../js/roof-structures.js';
import * as THREE from '../node_modules/three/build/three.module.js';
import { openTriangleEdges, meshTriangles, segmentHits } from './helpers/mesh.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';

const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

/** A foundation under an outline, open on top (the shell's floor and wall ring close it in interior mode). */
const openFoundation = (outline, top) => outline.flatMap(([x, z], i) => {
  const [nx, nz] = outline[(i + 1) % outline.length];
  return [[[x, 0, z], [nx, 0, nz], [nx, top, nz]], [[x, 0, z], [nx, top, nz], [x, top, z]]];
}).concat(outline.slice(1, -1).map((_, k) => [[outline[0][0], 0, outline[0][1]], [outline[k + 1][0], 0, outline[k + 1][1]], [outline[k + 2][0], 0, outline[k + 2][1]]]));

const normalOf = ([a, b, c]) => {
  const u = b.map((v, i) => v - a[i]);
  const w = c.map((v, i) => v - a[i]);
  return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
};

describe('interior settings', () => {
  it('off unless turned on; thickness kept in range', () => {
    assert.deepEqual(normalizeInterior(), INTERIOR_DEFAULTS);
    assert.deepEqual(normalizeInterior({ enabled: true, wallThickness: 2 }), { enabled: true, wallThickness: 0.4 });
    assert.deepEqual(normalizeInterior({ enabled: 'yes', wallThickness: 'x' }), INTERIOR_DEFAULTS);
  });
});

describe('insetting a volume\'s outline', () => {
  it('moves a rectangle in on every side, whichever way it winds', () => {
    assert.deepEqual(insetOutline(RECT, 0.2).map((p) => p.map((v) => +v.toFixed(9))), [[-4.8, -3.8], [4.8, -3.8], [4.8, 3.8], [-4.8, 3.8]]);
    const clockwise = [...RECT].reverse();
    assert.deepEqual(insetOutline(clockwise, 0.2).map((p) => p.map((v) => +v.toFixed(9))), [[-4.8, 3.8], [4.8, 3.8], [4.8, -3.8], [-4.8, -3.8]]);
  });

  it('keeps an angled wall parallel, the same thickness in from it', () => {
    const angled = [[-5, -4], [3, -4], [5, -2], [5, 4], [-5, 4]];
    const inset = insetOutline(angled, 0.2);
    const [nx, nz] = outwardNormals(angled)[1];
    const along = (p) => p[0] * nx + p[1] * nz;
    assert.ok(near(along(angled[1]) - along(inset[1]), 0.2) && near(along(angled[2]) - along(inset[2]), 0.2));
  });

  it('refuses a volume too narrow for a room between its walls', () => {
    assert.equal(insetOutline([[0, 0], [0.9, 0], [0.9, 5], [0, 5]], 0.2), null);
    assert.ok(insetOutline([[0, 0], [1.2, 0], [1.2, 5], [0, 5]], 0.2));
  });
});

describe('a volume\'s shell', () => {
  const shell = shellTriangles({
    outline: RECT, inset: insetOutline(RECT, 0.2), floorY: 0.7, ceilingY: 3.9, topY: 6.7,
  });
  const all = [...shell.outer, ...shell.inner, ...shell.floor, ...shell.ceiling];

  it('is closed, on its foundation or on its own', () => {
    assert.deepEqual(openTriangleEdges(all), []);
    assert.deepEqual(openTriangleEdges([...all, ...openFoundation(RECT, 0.7)]), []);
  });

  it('faces its room from the inner skin, floor, and ceiling, and the world from the outer skin', () => {
    // the room is round (0, y, 0): every inner face's normal points toward the axis, the outer skin's away
    shell.inner.forEach((tri) => {
      const [nx, , nz] = normalOf(tri);
      const [cx, , cz] = tri[0];
      assert.ok(nx * cx + nz * cz < 0);
    });
    shell.floor.forEach((tri) => assert.ok(normalOf(tri)[1] > 0));
    shell.ceiling.forEach((tri) => assert.ok(normalOf(tri)[1] < 0));
    assert.ok(shell.floor.every((tri) => tri.every(([, y]) => y === 0.7)));
    assert.ok(shell.ceiling.every((tri) => tri.every(([, y]) => y === 3.9)));
  });
});

describe('cutting a doorway through the wall', () => {
  const t = 0.2;
  // the z = -4 wall of RECT, facing -z; `right` from its start to its end
  const frame = {
    start: [-5, -4], end: [5, -4], normal: [0, -1], right: [1, 0],
  };
  const door = {
    u0: 0.5, u1: 1.4, y0: 0.7, y1: 2.75,
  };
  const shell = shellTriangles({
    outline: RECT, inset: insetOutline(RECT, t), floorY: 0.7, ceilingY: 3.9, topY: 6.7,
  });
  const solid = apertureSolid(frame, { ...door, d0: -t, d1: 0.2 });
  const wall = clipOutsideConvexSolid([...shell.outer, ...shell.inner], solid);
  const reveals = apertureReveals(frame, door, t);

  it('leaves the shell closed once the reveals line the opening', () => {
    // (the threshold's outer edge meets the foundation's side, as in the built model)
    assert.deepEqual(openTriangleEdges([...wall, ...reveals, ...shell.floor, ...shell.ceiling, ...openFoundation(RECT, 0.7)]), []);
  });

  it('opens a way straight through the wall', () => {
    // nothing of the wall is left across the doorway's middle
    const inDoorway = ([x, y, z]) => x > 0.6 && x < 1.3 && y > 0.8 && y < 2.6 && z > -4.1 && z < -3.7;
    assert.ok(!wall.some((tri) => tri.every(inDoorway)));
    // and a straight line through it from outside to the room crosses nothing
    const crosses = (tri) => {
      const [a, b, c] = tri;
      const n = normalOf(tri);
      const [p, q] = [[0.95, 1.7, -5], [0.95, 1.7, 0]];
      const side = (point) => n[0] * (point[0] - a[0]) + n[1] * (point[1] - a[1]) + n[2] * (point[2] - a[2]);
      const [sp, sq] = [side(p), side(q)];
      if (sp * sq > 0 || sp === sq) return false;
      const hit = p.map((v, i) => v + (q[i] - v) * (sp / (sp - sq)));
      const inside = (u, v, w) => {
        const e = u.map((x, i) => v[i] - x);
        const f = hit.map((x, i) => x - u[i]);
        const cr = [e[1] * f[2] - e[2] * f[1], e[2] * f[0] - e[0] * f[2], e[0] * f[1] - e[1] * f[0]];
        return cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] >= -1e-9;
      };
      return inside(a, b) && inside(b, c) && inside(c, a);
    };
    assert.equal([...wall, ...reveals].filter(crosses).length, 0);
  });

  it('stands the leaf open in the room beside its hinge jamb, clear of the wall', () => {
    const leaf = doorLeaf(frame, door, t, 'left');
    assert.deepEqual(openTriangleEdges(leaf), []);
    const zs = leaf.flat().map(([, , z]) => z);
    // in the room: from the inner face (z = -3.8) inward, as deep as the door is wide
    assert.ok(near(Math.min(...zs), -3.8) && near(Math.max(...zs), -3.8 + (door.u1 - door.u0)));
    // left seen from outside (looking toward +z) is +x, so hinged on the u1 jamb
    const xs = leaf.flat().map(([x]) => x);
    assert.ok(near(Math.max(...xs), 1.4) && near(Math.min(...xs), 1.4 - 0.045));
    const right = doorLeaf(frame, door, t, 'right').flat().map(([x]) => x);
    assert.ok(near(Math.min(...right), 0.5));
  });
});

describe('a built house with a walk-in interior', () => {
  // (mesh positions are 32-bit floats)
  const close = (a, b) => Math.abs(a - b) < 1e-5;
  const build = (footprint, config = {}) => {
    const layout = computeFacadeLayout(footprint, { volumeSplit: 'auto', storyCount: config.storyCount ?? 2, storyHeight: 3 });
    return createBuildingFromFootprint(footprint, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.7, roofType: 'gable', roofDirection: 'x', roofHeight: 2,
      volumes: layout.volumes, facadeLayout: layout, interior: { enabled: true, wallThickness: 0.2 }, ...config,
    });
  };
  // the house's body (walls, rooms, foundations), in the building's frame
  const bodyTriangles = (built, parts = ['walls', 'interior-wall', 'interior-floor', 'interior-ceiling', undefined]) => {
    const out = [];
    built.building.updateMatrixWorld(true);
    built.building.children.forEach((mesh) => {
      if (!mesh.isMesh || mesh.userData?.structureId || mesh.userData?.roofType || mesh.userData?.bodyPart === 'facade-panel') return;
      if (!parts.includes(mesh.userData?.bodyPart)) return;
      out.push(...meshTriangles(mesh).map((tri) => tri.map((p) => new THREE.Vector3(...p).applyMatrix4(mesh.matrixWorld).toArray())));
    });
    return out;
  };
  const partOf = (built, bodyPart) => built.building.children.filter((mesh) => mesh.userData?.bodyPart === bodyPart);

  it('hollows a two-story box: its floor on the foundation, its ceiling at the first floor line, closed all round', () => {
    const built = build(RECT);
    const floor = bodyTriangles(built, ['interior-floor']);
    const ceiling = bodyTriangles(built, ['interior-ceiling']);
    assert.ok(floor.length && floor.flat().every(([, y]) => close(y, 0.7)));
    assert.ok(ceiling.length && ceiling.flat().every(([, y]) => close(y, 3.7)));
    assert.deepEqual(openTriangleEdges(bodyTriangles(built)), []);
    const [room] = built.building.userData.interiorRooms;
    assert.ok(close(room.floorY, 0.7) && close(room.ceilingY, 3.7) && close(room.topY, 6.7));
  });

  it('keeps the outside where it was: the walls\' outer face on the footprint line, up to the same wall top', () => {
    const built = build(RECT);
    const walls = bodyTriangles(built, ['walls']).flat();
    assert.ok(close(Math.min(...walls.map(([x]) => x)), -5));
    assert.ok(close(Math.max(...walls.map(([, y]) => y)), 6.7));
  });

  it('puts a one-story room\'s ceiling just under its wall top', () => {
    const built = build(RECT, { storyCount: 1 });
    const [room] = built.building.userData.interiorRooms;
    assert.ok(close(room.ceilingY, room.topY - 0.05));
  });

  it('builds nothing different with the interior off', () => {
    const built = build(RECT, { interior: { enabled: false } });
    assert.equal(partOf(built, 'interior-floor').length, 0);
    assert.equal(built.building.userData.interiorRooms, undefined);
  });

  // an L: a 12 x 4 block along x, and a 6 x 4 wing off its +z side at the -x end
  const ELL = [[-6, -4], [6, -4], [6, 0], [0, 0], [0, 4], [-6, 4]];

  it('joins neighboring rooms at the same level with a passage, the house still closed', () => {
    const built = build(ELL, { storyCount: 1 });
    assert.equal(built.building.userData.interiorRooms.length, 2);
    const body = bodyTriangles(built);
    assert.deepEqual(openTriangleEdges(body), []);
    // from the middle of one room to the middle of the other, a meter off the floor
    const [roomA, roomB] = built.building.userData.interiorRooms;
    const middle = (room) => room.inset.reduce(([x, z], [px, pz]) => [x + px / room.inset.length, z + pz / room.inset.length], [0, 0]);
    const [ax, az] = middle(roomA);
    const [bx, bz] = middle(roomB);
    assert.deepEqual(segmentHits(body, [ax, 1.7, az], [bx, 1.7, bz]), []);
  });

  it('keeps a riser where a garage floor stands lower than the house\'s', () => {
    const layout = computeFacadeLayout(ELL, { volumeSplit: 'auto', storyCount: 1, storyHeight: 3 });
    const garage = layout.volumes[1];
    const built = build(ELL, { storyCount: 1, volumeFoundationHeights: { [garage.id]: 0 } });
    const rooms = built.building.userData.interiorRooms;
    const low = rooms.find((room) => room.volumeId === garage.id);
    const high = rooms.find((room) => room.volumeId !== garage.id);
    assert.ok(close(low.floorY, 0) && close(high.floorY, 0.7));
    assert.deepEqual(openTriangleEdges(bodyTriangles(built)), []);
    // across the passage at knee height, below the higher floor, the lower room's wall stands in the way
    const [lx, lz] = low.inset.reduce(([x, z], [px, pz]) => [x + px / 4, z + pz / 4], [0, 0]);
    const [hx, hz] = high.inset.reduce(([x, z], [px, pz]) => [x + px / 4, z + pz / 4], [0, 0]);
    assert.ok(segmentHits(bodyTriangles(built), [lx, 0.4, lz], [hx, 0.4, hz]).length > 0);
    assert.deepEqual(segmentHits(bodyTriangles(built), [lx, 1.9, lz], [hx, 1.9, hz]), [], 'and above it the way is open');
  });

  // RECT's wall-run-0 is the z = -4 wall, facing -z
  const door = { id: 'd', kind: 'door', hostWallRunId: 'wall-run-0', offset: 1, width: 0.9, height: 2.05, sillHeight: 0, materials: {}, steps: { enabled: false } };
  const everything = (built) => {
    const out = [];
    built.building.updateMatrixWorld(true);
    built.building.traverse((mesh) => {
      if (mesh.isMesh && !mesh.userData?.editorOnly) {
        out.push(...meshTriangles(mesh).map((tri) => tri.map((p) => new THREE.Vector3(...p).applyMatrix4(mesh.matrixWorld).toArray())));
      }
    });
    return out;
  };

  it('cuts a door through into the room: a clear way in, the leaf standing open inside, the house still closed', () => {
    const built = build(RECT, { openings: [door] });
    assert.deepEqual(built.openings[0].warnings, []);
    // straight in through the doorway's middle, from outside to the middle of the room
    assert.deepEqual(segmentHits(everything(built), [1, 1.7, -6], [1, 1.7, 0]), []);
    assert.deepEqual(openTriangleEdges(bodyTriangles(built)), []);
    const leaf = built.building.children.find((mesh) => mesh.userData?.bodyPart === 'door-leaf');
    assert.equal(leaf.userData.collides, false);
    const leafPoints = meshTriangles(leaf).flat();
    assert.ok(leafPoints.every(([, , z]) => z >= -3.8 - 1e-5), 'standing in the room');
    assert.equal(built.building.children.filter((mesh) => mesh.userData?.bodyPart === 'opening').flatMap((g) => g.children).some((mesh) => mesh.userData.bodyPart === 'opening-pane'), false, 'no closed door panel left in the way');
  });

  it('leaves a window uncut: the wall stands behind it', () => {
    const built = build(RECT, { openings: [{ id: 'w', kind: 'window', hostWallRunId: 'wall-run-0', offset: 1, width: 1, height: 1.2, sillHeight: 1, materials: {} }] });
    assert.ok(segmentHits(bodyTriangles(built), [1, 2.3, -6], [1, 2.3, 0]).length > 0);
  });

  it('does not cut a door taller than the room\'s ceiling, and says why', () => {
    // two low stories: the ground story's ceiling 2.2 m up, the wall tall enough for the door
    const built = build(RECT, { storyCount: 2, storyHeight: 2.2, openings: [{ ...door, height: 2.4 }] });
    assert.match(built.openings[0].warnings.find((w) => w.code === 'door-not-cut')?.message ?? '', /ceiling/);
    assert.equal(built.building.children.some((mesh) => mesh.userData?.bodyPart === 'door-leaf'), false);
  });

  it('hangs the leaf on the side asked for', () => {
    const leafX = (hinge) => {
      const built = build(RECT, { openings: [{ ...door, hinge }] });
      const leaf = built.building.children.find((mesh) => mesh.userData?.bodyPart === 'door-leaf');
      return meshTriangles(leaf).flat().map(([x]) => x);
    };
    // seen from outside the -z wall (looking toward +z), left is +x
    assert.ok(Math.max(...leafX('left')) > 1.4 && Math.min(...leafX('right')) < 0.6);
  });

  it('leaves a volume too narrow for a room solid, and says so', () => {
    const built = build([[-5, -0.4], [5, -0.4], [5, 0.4], [-5, 0.4]], { storyCount: 1 });
    assert.equal(partOf(built, 'interior-floor').length, 0);
    assert.equal(built.building.userData.interiorWarnings[0].code, 'interior-too-thin');
  });
});
