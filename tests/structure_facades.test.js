import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFacadeLayout, withStructureFacades, serializeBuildingState,
} from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures, DECK_THICKNESS } from '../js/roof-structures.js';
import { MATERIAL_PALETTE } from '../js/materials.js';

const RECT = [[-10, -5], [10, -5], [10, 5], [-10, 5]];
// one story on the 20 x 10 rectangle; gable ridge along x, 2.5 high (slope 0.5); plate 0.6 + 3 + 0.02
const PLATE = 3.62;

function build(structures, config = {}) {
  const result = createBuildingFromFootprint(RECT, {
    storyCount: 1,
    storyHeight: 3,
    foundationDepth: 0.6,
    roofType: 'gable',
    roofDirection: 'x',
    roofHeight: 2.5,
    roofPitchRise: 6,
    roofPitchRun: 12,
    roofEaveDepth: 0.3,
    volumes: computeFacadeLayout(RECT, {}).volumes,
    ...config,
    roofStructures: normalizeRoofStructures(structures),
  });
  return { result, layout: withStructureFacades(computeFacadeLayout(RECT, {}), result.structureFacades) };
}

const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-5, `${message ?? ''} expected ${b}, got ${a}`);
const run = (layout, id) => {
  const found = layout.structureWallRuns.find((candidate) => candidate.id === id);
  assert.ok(found, `wall run ${id}`);
  return found;
};

describe('roof structure facade surfaces', () => {
  it('a dormer\'s walls are wall runs with their visible shapes, addressed by structure and wall', () => {
    const { layout } = build([{ id: 'd', hostVolumeId: 'volume-0', hostSide: 'minZ' }]);
    assert.deepEqual(layout.structureWallRuns.map((entry) => entry.id).sort(), ['wall-run-d-front', 'wall-run-d-left', 'wall-run-d-right'], 'the buried back has none');
    const front = run(layout, 'wall-run-d-front');
    assert.equal(front.structureId, 'd');
    assert.equal(front.hostVolumeId, 'volume-0');
    assert.equal(front.storyId, 'story-d-1');
    // 2.4 m wide, 1.4 m to the plate, and a gable 0.6 m high
    near(front.area, 2.4 * 1.4 + 0.5 * 2.4 * 0.6, 'front');
    near(front.extent.minV, 0, 'from the sill');
    near(front.extent.maxV, 1.4 + 0.6, 'to the ridge');
    // each cheek: from the plate down to the roof, 1.4 m at the front to nothing 2.8 m back
    near(run(layout, 'wall-run-d-left').area, 0.5 * 2.8 * 1.4, 'left cheek');
    near(run(layout, 'wall-run-d-right').area, 0.5 * 2.8 * 1.4, 'right cheek');
    const [story] = layout.structureStories;
    assert.equal(story.id, 'story-d-1');
    near(story.minY, PLATE + 0.45);
    near(story.maxY, PLATE + 0.45 + 1.4);
  });

  it('measures across each wall left to right as seen from outside', () => {
    const { layout } = build([{ id: 'd', hostVolumeId: 'volume-0', hostSide: 'minZ' }]);
    const front = run(layout, 'wall-run-d-front');
    // facing the front (from -z, looking +z), left is +x
    assert.deepEqual(front.start, [1.2, -4.1]);
    assert.deepEqual(front.end, [-1.2, -4.1]);
    assert.deepEqual(front.normal, [0, -1]);
    // on the +x cheek (from +x, looking -x), left is the back of the dormer: the visible part is toward the front
    const left = run(layout, 'wall-run-d-left');
    assert.equal(left.side, 'maxX');
    near(left.extent.minU, 4.1 - 2.8);
    near(left.extent.maxU, 4.1);
  });

  it('a wall dormer\'s front carries down to the host wall top', () => {
    const { layout } = build([{ id: 'w', kind: 'wall-dormer', hostVolumeId: 'volume-0', hostSide: 'minZ' }]);
    near(run(layout, 'wall-run-w-front').extent.minV, -0.02);
  });

  it('a recessed porch\'s set-back wall is its inner run, with a railing across its open front', () => {
    const { layout } = build([{ id: 'r', kind: 'recessed-porch', hostVolumeId: 'volume-0', hostSide: 'minZ' }], { roofHeight: 5, roofPitchRise: 12 });
    assert.deepEqual(layout.structureWallRuns.map((entry) => entry.wall).sort(), ['inner', 'left', 'right']);
    const inner = run(layout, 'wall-run-r-inner');
    near(inner.extent.minV, 0, 'from the floor');
    assert.deepEqual(layout.railRuns.map((entry) => entry.id), ['rail-run-r-front']);
    const [rail] = layout.railRuns;
    near(rail.start[1], layout.structureStories[0].minY, 'at floor level');
    near(Math.abs(rail.start[0] - rail.end[0]), 3.6);
    near(rail.height, 1);
  });

  it('an open ground porch has railing runs on its open sides, stopping at the host wall', () => {
    const { layout } = build([{
      id: 'g', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'minZ', setback: -2.4, depth: 2.4, width: 6,
      baseHeight: 'ground', wallHeight: 2.6, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 }, openSides: ['front', 'left', 'right'],
    }], { storyCount: 2 });
    assert.deepEqual(layout.railRuns.map((entry) => entry.id).sort(), ['rail-run-g-front', 'rail-run-g-left', 'rail-run-g-right']);
    const left = layout.railRuns.find((entry) => entry.wall === 'left');
    near(Math.abs(left.start[2] - left.end[2]), 2.4, 'from the front to the wall');
    left.start.concat(left.end).filter((_, k) => k % 3 === 1).forEach((y) => near(y, 0.6, 'on the deck'));
    assert.equal(layout.structureWallRuns.length, 0, 'the back is the host wall');
    // one whose rectangle runs on into the house: its side railings still stop at the wall
    const deep = build([{
      id: 'g', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'minZ', setback: -2.4, depth: null, width: 6,
      baseHeight: 'ground', wallHeight: 2.6, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 1 }, openSides: ['front', 'left', 'right'],
    }], { storyCount: 2 }).layout;
    const deepLeft = deep.railRuns.find((entry) => entry.wall === 'left');
    near(Math.abs(deepLeft.start[2] - deepLeft.end[2]), 2.4, 'clipped at the host wall');
  });

  it('an enclosed base has its own wall runs and story under the structure', () => {
    const { layout } = build([{
      id: 'b', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'minZ', setback: -1.8, depth: 1.8, width: 3.6,
      baseHeight: -3, wallHeight: 2.4, roofType: 'hip', openSides: [], support: 'enclosed',
    }], { storyCount: 2 });
    const base = run(layout, 'wall-run-b-base-front');
    assert.equal(base.storyId, 'story-b-base');
    near(base.area, 3.6 * (PLATE + 3 - 3 - 0.6), 'from the foundation top to the floor');
    assert.deepEqual(layout.structureStories.map((story) => story.id), ['story-b-1', 'story-b-base']);
  });

  it('a widow\'s walk is four railing runs around its deck, at its railing height', () => {
    const { layout } = build([{ id: 'ww', kind: 'widows-walk', hostVolumeId: 'volume-0', hostSide: 'minZ' }], { roofType: 'hip', roofDeckHeight: 1.5 });
    assert.equal(layout.structureWallRuns.length, 0);
    assert.equal(layout.railRuns.length, 4);
    layout.railRuns.forEach((rail) => {
      near(rail.start[1], PLATE + 1.5 + DECK_THICKNESS, 'on the deck');
      near(rail.height, 1);
    });
    const [story] = layout.structureStories;
    near(story.maxY - story.minY, DECK_THICKNESS + 1, 'deck and railing');
  });

  it('a cupola\'s walls run down to the roof, below its sill at the ridge', () => {
    const { layout } = build([{ id: 'c', kind: 'cupola', hostVolumeId: 'volume-0', hostSide: 'minZ' }]);
    assert.equal(layout.structureWallRuns.length, 4);
    const front = run(layout, 'wall-run-c-front');
    near(front.extent.minV, -0.4, '0.8 m off the ridge at 6:12');
    near(front.area, 1.6 * 1.6);
    near(run(layout, 'wall-run-c-left').area, 1.6 * 1.2 + 2 * 0.5 * 0.8 * 0.4, 'following the ridge');
  });
});

describe('structure facades in the layout and materials', () => {
  it('stay beside the footprint\'s own wall runs, which still define the saved footprint', () => {
    const { layout } = build([{ id: 'd', hostVolumeId: 'volume-0', hostSide: 'minZ' }]);
    assert.equal(layout.wallRuns.length, 4);
    assert.deepEqual(serializeBuildingState(layout, {}).footprint, RECT);
    const empty = withStructureFacades(computeFacadeLayout(RECT, {}));
    assert.deepEqual([empty.structureWallRuns, empty.structureStories, empty.railRuns], [[], [], []]);
  });

  it('a structure\'s own materials override the building\'s', () => {
    const { result } = build([{ id: 'd', hostVolumeId: 'volume-0', hostSide: 'minZ', materials: { wall: 'brick', roof: 'metal' } }]);
    const colors = {};
    result.building.traverse((child) => {
      if (child.userData?.structureId) {
        colors[child.userData.structurePart] = child.material.color.getHex();
      }
    });
    assert.equal(colors.walls, MATERIAL_PALETTE.brick.color);
    assert.equal(colors.roof, MATERIAL_PALETTE.metal.color);
    const plain = build([{ id: 'd', hostVolumeId: 'volume-0', hostSide: 'minZ', materials: { wall: 'not-a-material' } }]).result;
    plain.building.traverse((child) => {
      if (child.userData?.structurePart === 'walls') {
        assert.equal(child.material.color.getHex(), MATERIAL_PALETTE.wood.color, 'the building default');
      }
    });
  });
});
