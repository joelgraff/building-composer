import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';
import { buildGameFile, gameMaterial } from '../js/game-export.js';

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
    assert.equal(gameMaterial({ role: 'roof' }, [0, -1, 0]), 'siding_white');
    assert.equal(gameMaterial({ role: 'roof', part: 'floor' }, [0, 1, 0]), 'trim_dark');
  });
});
