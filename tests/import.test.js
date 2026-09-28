import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { squareFootprint, importDixonFootprint, settingsFromHints } from '../js/import.js';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState } from '../js/facade.js';

const near = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) < tolerance, `${message ?? ''} expected ${b}, got ${a}`);
const rotate = ([x, z], angle) => [x * Math.cos(angle) - z * Math.sin(angle), x * Math.sin(angle) + z * Math.cos(angle)];
// game point = center + R(rotation) * Composer point
const toGame = (point, { rotation, center }) => {
  const [x, z] = rotate(point, rotation);
  return [center[0] + x, center[1] + z];
};

// building 115768678 as the Dixon building editor exports it: a 15 x 24 m
// house turned 3.4 degrees off the grid, closed
const DIXON = {
  format: 'dixon-footprint',
  version: 1,
  source: 'dixon_dem',
  id: '115768678',
  footprint: [
    [508.108497196343, -212.66817373503], [523.094637260889, -213.555096043274], [524.530218404601, -189.453476924449],
    [509.544028454926, -188.566549813375], [508.108497196343, -212.66817373503],
  ],
  ground_y_min: 16.92,
  ground_y_max: 17.14,
  height_m: 10,
  hints: {
    form: 'front_gable', storeys: 1.5, roof: 'gable', roof_axis: 'front', material: 'clapboard',
  },
};

describe('squaring up a traced footprint', () => {
  it('turns a house square to the axes, centered, and remembers how to put it back', () => {
    const result = importDixonFootprint(DIXON);
    assert.deepEqual(result.warnings, []);
    const xs = result.footprint.map(([x]) => x);
    const zs = result.footprint.map(([, z]) => z);
    assert.equal(result.footprint.length, 4, 'no closing point');
    near(Math.max(...xs) - Math.min(...xs), 15.01, 0.02, 'width');
    near(Math.max(...zs) - Math.min(...zs), 24.14, 0.02, 'depth');
    near(Math.max(...xs) + Math.min(...xs), 0, 1e-6, 'centered in x');
    // each corner goes back to where it was traced
    result.footprint.forEach((corner) => {
      const back = toGame(corner, result.placement);
      const traced = Math.min(...DIXON.footprint.map((point) => Math.hypot(point[0] - back[0], point[1] - back[1])));
      assert.ok(traced < 0.01, `corner ${corner} is ${traced} m from the traced outline`);
    });
    assert.equal(result.placement.id, '115768678');
    assert.equal(result.placement.groundY, 16.92);
  });

  it('an L with a slightly crooked, jogged trace comes out a clean L', () => {
    const L = [[0, 0], [10, 0.05], [10, 8], [6.02, 8], [6.1, 8.08], [6, 14], [0, 14.03]];
    const turned = L.map((point) => rotate(point, 0.6)).map(([x, z]) => [x + 100, z - 40]);
    const result = squareFootprint(turned);
    assert.ok(!result.error, result.error);
    assert.equal(result.footprint.length, 6, 'the 0.1 m jog is dropped');
    result.footprint.forEach((corner, i) => {
      const next = result.footprint[(i + 1) % result.footprint.length];
      assert.ok(Math.abs(corner[0] - next[0]) < 1e-9 || Math.abs(corner[1] - next[1]) < 1e-9, 'every side along an axis');
    });
    assert.equal(computeFacadeLayout(result.footprint, { volumeSplit: 'auto' }).volumes.length, 2);
  });

  it('keeps a wall well off square as an angled wall, squaring the rest', () => {
    // a clipped corner, the whole outline traced 2 degrees off the grid
    const traced = [[0, 0], [10, 0.1], [10, 6], [8, 8], [0, 8]].map((point) => rotate(point, 0.035));
    const result = squareFootprint(traced);
    assert.ok(!result.error, result.error);
    assert.equal(result.angled, 1);
    assert.equal(result.footprint.length, 5);
    const angled = result.footprint.filter((corner, i) => {
      const next = result.footprint[(i + 1) % result.footprint.length];
      return Math.abs(corner[0] - next[0]) > 1e-9 && Math.abs(corner[1] - next[1]) > 1e-9;
    });
    assert.equal(angled.length, 1, 'one wall off the axes');
  });

  it('squares a short wall a few centimeters off, and puts one wall line traced twice on one line', () => {
    // a 1.1 m return 5.2 degrees off square (10 cm), and its wall line traced again 2 cm off beyond the wing
    const traced = [[0, 0], [10, 0], [10.1, 1.1], [16, 1.1], [16, 6], [10.07, 6], [10.07, 8], [0, 8]];
    const result = squareFootprint(traced);
    assert.equal(result.angled, 0);
    const xs = [...new Set(result.footprint.map(([x]) => x))];
    assert.equal(xs.length, 3, 'x at the two ends and one line through the wing\'s side');
  });

  it('refuses a footprint the angled walls cannot be followed on, saying why', () => {
    const u = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10], [0, 6], [2, 2]];
    assert.match(importDixonFootprint({ ...DIXON, footprint: u }).error, /^Building 115768678: An angled wall reaches past/);
    assert.match(importDixonFootprint({ footprint: [] }).error, /Not a footprint/);
  });
});

describe('hints from the game', () => {
  it('a story and a half is one story with a knee wall; roofs and materials map to Composer\'s', () => {
    assert.deepEqual(settingsFromHints(DIXON.hints), {
      storyCount: 1, kneeWallHeight: 0.9, roofType: 'gable', wallMaterial: 'wood',
    });
    assert.deepEqual(settingsFromHints({ storeys: 2, roof: 'pyramidal', material: 'limestone' }), {
      storyCount: 2, kneeWallHeight: undefined, roofType: 'hip', wallMaterial: 'stone',
    });
    assert.equal(settingsFromHints({ roof: 'flat_parapet' }).roofType, 'flat');
  });

  it('the placement is saved with the project', () => {
    const { footprint, placement } = importDixonFootprint(DIXON);
    const saved = serializeBuildingState(computeFacadeLayout(footprint, {}), { placement });
    assert.deepEqual(deserializeBuildingState(JSON.parse(JSON.stringify(saved))).state.placement, placement);
    const plain = serializeBuildingState(computeFacadeLayout(footprint, {}), {});
    assert.equal(deserializeBuildingState(plain).state.placement, undefined);
  });
});
