import { describe, it } from 'node:test';
import * as THREE from '../node_modules/three/build/three.module.js';
import assert from 'node:assert/strict';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';
import { buildGameFile, gameMaterial } from '../js/game-export.js';
import { segmentHits } from './helpers/mesh.js';

const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const ELL = [[-6, -4], [6, -4], [6, 0], [0, 0], [0, 4], [-6, 4]];

function build(footprint, config = {}, structures = []) {
  const volumes = computeFacadeLayout(footprint, { volumeSplit: 'auto' }).volumes;
  const { building } = createBuildingFromFootprint(footprint, {
    storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
    roofEaveDepth: 0.35, volumes, roofStructures: normalizeRoofStructures(structures), ...config,
  });
  return building;
}

const PORCH = {
  id: 'p', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', width: 6, offset: 2, setback: -2.4, depth: 2.4,
  baseHeight: 'ground', wallHeight: 2.8, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'],
};

const cases = {
  'a gabled box': () => build(RECT),
  'a hipped box': () => build(RECT, { roofType: 'hip' }),
  'a flat-roofed box': () => build(RECT, { roofType: 'flat' }),
  'an L': () => build(ELL, { roofType: 'hip' }),
  'a house with a porch': () => build(RECT, {}, [PORCH]),
};

describe('the file for the game', () => {
  Object.entries(cases).forEach(([name, make]) => {
    it(`${name}: roofs are shingled facing up, whatever way the model wound them`, () => {
      const file = buildGameFile(make(), { rotation: 0, center: [0, 0], id: 'x' });
      assert.ok(file.near.shingles_dark || file.near.roof_membrane, `roof groups in ${Object.keys(file.near)}`);
      Object.entries(file.near).forEach(([key, { verts }]) => {
        if (key === 'shingles_dark') {
          verts.forEach((v) => assert.ok(v[4] > 0.4, `a shingle facing ${v.slice(3, 6)}`));
        }
      });
    });
  });

  it('exports a gable end as its wall, and the soffits under the eaves as trim, not flat roof', () => {
    const file = buildGameFile(build(RECT), { rotation: 0, center: [0, 0], id: 'x' });
    assert.equal(file.near.roof_membrane, undefined, 'a gabled roof has no flat roof');
    // the gable ends: the walls at x = +-5, above the plate (2 stories of 3 m on a 0.6 m floor)
    const gable = file.near.siding_white.verts.filter((v) => Math.abs(Math.abs(v[0]) - 5) < 1e-3 && v[1] > 6.7);
    assert.ok(gable.length >= 2, 'gable corners in the wall group');
    assert.equal(file.near.trim_white.verts.filter((v) => Math.abs(Math.abs(v[0]) - 5) < 1e-3 && v[1] > 7).length, 0, 'no gable in the trim');
  });

  it("gives a gable end the wall's game finish", () => {
    const building = build(RECT, { wallMaterial: 'brick', gameFinishes: { wall: 'brick_buff' } });
    const file = buildGameFile(building, { rotation: 0, center: [0, 0], id: 'x' });
    assert.ok(file.near.brick_buff.verts.some((v) => Math.abs(Math.abs(v[0]) - 5) < 1e-3 && v[1] > 7.5), 'the gable peak is buff brick');
  });

  it('writes walk-in collision for a building sent inside the editor\'s scene group', () => {
    const layout = computeFacadeLayout(RECT, { volumeSplit: 'auto' });
    const { building } = createBuildingFromFootprint(RECT, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
      volumes: layout.volumes, facadeLayout: layout, interior: { enabled: true, wallThickness: 0.2 },
    });
    const group = new THREE.Group();
    group.add(building);
    const file = buildGameFile(group, { rotation: 0, center: [0, 0], id: 'x' });
    assert.equal(file.version, 2);
    assert.ok(file.collision.faces.length > 0);
  });

  it('exports a chosen roof finish: brown shingles on a pitched roof, metal on a flat one', () => {
    const pitched = buildGameFile(build(RECT, { gameFinishes: { roof: 'shingles_brown' } }), { rotation: 0, center: [0, 0], id: 'x' });
    assert.ok(pitched.near.shingles_brown && !pitched.near.shingles_dark, `roof groups ${Object.keys(pitched.near)}`);
    const flat = buildGameFile(build(RECT, { roofType: 'flat', gameFinishes: { flatRoof: 'roof_metal' } }), { rotation: 0, center: [0, 0], id: 'x' });
    assert.ok(flat.near.roof_metal && !flat.near.roof_membrane, `roof groups ${Object.keys(flat.near)}`);
  });

  it('keeps a flat roof as flat roof', () => {
    const file = buildGameFile(build(RECT, { roofType: 'flat' }), { rotation: 0, center: [0, 0], id: 'x' });
    assert.ok(file.near.roof_membrane, 'a flat roof is membrane');
  });

  it('puts every triangle in the game\'s winding with an outward normal and a material', () => {
    const placement = { rotation: 0.3, center: [500, -200], id: '42', groundY: 17 };
    const file = buildGameFile(build(RECT), placement, { format: 'building-composer' });
    assert.equal(file.format, 'dixon-composed');
    assert.equal(file.id, '42');
    assert.deepEqual(file.project, { format: 'building-composer' });
    const names = Object.keys(file.near);
    ['siding_white', 'stone_foundation', 'shingles_dark'].forEach((name) => assert.ok(names.includes(name), `${name} in ${names}`));
    Object.values(file.near).forEach(({ verts, indices }) => {
      assert.equal(indices.length % 3, 0);
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => verts[indices[i + k]]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const shading = a.slice(3, 6);
        assert.ok(n[0] * shading[0] + n[1] * shading[1] + n[2] * shading[2] < 0, 'right-hand normal points into the building');
      }
    });
  });

  it('places the building where the game traced it, with heights left relative to the ground', () => {
    const placement = { rotation: 0.3, center: [500, -200], id: '42' };
    const file = buildGameFile(build(RECT), placement);
    const xs = file.hull.map(([x]) => x);
    const zs = file.hull.map(([, z]) => z);
    const back = file.hull.map(([x, z]) => {
      const dx = x - 500;
      const dz = z + 200;
      return [dx * Math.cos(-0.3) - dz * Math.sin(-0.3), dx * Math.sin(-0.3) + dz * Math.cos(-0.3)];
    });
    assert.ok(Math.min(...back.map(([x]) => x)) < -5 && Math.max(...back.map(([x]) => x)) > 5, 'the eave reaches past the walls');
    assert.ok(Math.max(...xs) > 495 && Math.min(...zs) < -190);
    assert.ok(file.y0 <= 0 && file.y1 > 6);
  });

  it('maps materials: palette walls, flat roofs, undersides', () => {
    assert.equal(gameMaterial({ role: 'wall', palette: 'brick' }, [1, 0, 0]), 'brick_red');
    assert.equal(gameMaterial({ role: 'wall', palette: 'stone' }, [1, 0, 0]), 'limestone');
    assert.equal(gameMaterial({ role: 'roof' }, [0, 1, 0]), 'roof_membrane');
    assert.equal(gameMaterial({ role: 'roof' }, [0, 0.8, 0.6]), 'shingles_dark');
    assert.equal(gameMaterial({ role: 'roof', palette: 'metal' }, [0, 0.8, 0.6]), 'roof_metal');
    assert.equal(gameMaterial({ role: 'roof' }, [0, -1, 0]), 'trim_white');
    assert.equal(gameMaterial({ role: 'roof', part: 'floor' }, [0, 1, 0]), 'trim_dark');
  });

  it('maps a window/door opening: glazing regardless of palette, a door by its own palette', () => {
    assert.equal(gameMaterial({ role: 'glass' }, [1, 0, 0]), 'window_lit');
    assert.equal(gameMaterial({ role: 'glass', palette: 'glass' }, [0, 1, 0]), 'window_lit');
    assert.equal(gameMaterial({ role: 'door', palette: 'wood' }, [1, 0, 0]), 'door_wood');
    assert.equal(gameMaterial({ role: 'door', palette: 'brick' }, [1, 0, 0]), 'brick_red');
    assert.equal(gameMaterial({ role: 'door' }, [1, 0, 0]), 'door_wood', 'no palette falls back to wood');
  });
});

describe('a walk-in building for the game', () => {
  const door = { id: 'd', kind: 'door', hostWallRunId: 'wall-run-0', offset: 1, width: 0.9, height: 2.05, sillHeight: 0, materials: {}, steps: { enabled: false } };
  // (the door needs the walls' layout to hang on)
  const walkIn = (interior = { enabled: true }) => build(RECT, {
    storyCount: 1, interior, openings: [door], facadeLayout: computeFacadeLayout(RECT, { volumeSplit: 'auto' }),
  });
  const placement = { rotation: 0, center: [0, 0], id: 'w' };

  it('a solid building\'s file is unchanged: version 1, collide with the hull', () => {
    const file = buildGameFile(walkIn({ enabled: false }), placement);
    assert.equal(file.version, 1);
    assert.equal('collision' in file, false);
    assert.equal('interior' in file, false);
  });

  it('carries its surfaces to collide with: the floor and walls in, the open door leaf out', () => {
    const file = buildGameFile(walkIn(), placement);
    assert.equal(file.version, 2);
    assert.equal(file.interior, true);
    const faces = file.collision.faces;
    assert.equal(faces.length % 9, 0);
    const triangles = [];
    for (let i = 0; i < faces.length; i += 9) {
      triangles.push([faces.slice(i, i + 3), faces.slice(i + 3, i + 6), faces.slice(i + 6, i + 9)]);
    }
    // the room's floor, at the foundation top (0.6), inside the walls
    assert.ok(triangles.some((tri) => tri.every(([x, y, z]) => Math.abs(y - 0.6) < 1e-3 && Math.abs(x) < 4.9 && Math.abs(z) < 3.9)));
    // no leaf: nothing stands in the room beside the hinge jamb (x from 1.36 to 1.405, z from -3.8 in)
    assert.ok(!triangles.some((tri) => tri.every(([x, y, z]) => x > 1.35 && x < 1.41 && z > -3.79 && y > 0.7 && y < 2.6)));
    // and straight in through the doorway's middle, from outside into the room, nothing to collide with
    const through = segmentHits(triangles, [1, 1.6, -6], [1, 1.6, 0]);
    assert.deepEqual(through, []);
  });

  it('faces the room\'s walls into the room', () => {
    const file = buildGameFile(walkIn(), placement);
    const inner = file.near.plaster_white;
    assert.ok(inner && inner.verts.length);
    // the room is round the origin: its walls' inner faces (0.2 in from the footprint) face toward it
    // (the door's jambs, lined in the same plaster, face into the doorway instead)
    const onInnerFace = ([x, , z, nx, , nz]) => (Math.abs(Math.abs(x) - 4.8) < 1e-3 && Math.abs(nx) > 0.5)
      || (Math.abs(Math.abs(z) - 3.8) < 1e-3 && Math.abs(nz) > 0.5);
    const checked = inner.verts.filter(onInnerFace);
    assert.ok(checked.length > 0);
    checked.forEach((v) => {
      const [x, , z, nx, , nz] = v;
      assert.ok(nx * x + nz * z < 0, `${v}`);
    });
  });
});
