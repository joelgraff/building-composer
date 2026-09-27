import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState } from '../js/facade.js';
import { createBuildingFromFootprint, volumeWallHeight } from '../js/extrusion.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';

const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message ?? ''} expected ${b}, got ${a}`);

function build(footprint, config = {}) {
  return createBuildingFromFootprint(footprint, {
    storyCount: 1, storyHeight: 2.9, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 12, roofPitchRun: 12,
    volumes: computeFacadeLayout(footprint, {}).volumes, ...config,
    roofStructures: normalizeRoofStructures(config.roofStructures ?? []),
  });
}

describe('a story and a half', () => {
  it('the walls rise a knee wall above the full stories, by volume or for the building', () => {
    const config = { storyCount: 1, storyHeight: 2.9, kneeWallHeight: 0.9, volumeStoryOverrides: { a: 2 }, volumeKneeWalls: { b: 0.6, c: 0 } };
    near(volumeWallHeight(null, config), 3.8);
    near(volumeWallHeight('a', config), 6.7, 'two stories and the building\'s knee wall');
    near(volumeWallHeight('b', config), 3.5, 'its own knee wall');
    near(volumeWallHeight('c', config), 2.9, 'none for this volume');
    near(volumeWallHeight(null, { storyCount: 2, storyHeight: 3 }), 6, 'no half story');
  });

  it('raises the plate, and the roof with it', () => {
    const [plain] = build(RECT).roofZones;
    const [half] = build(RECT, { kneeWallHeight: 0.9 }).roofZones;
    near(plain.wallTopY, 0.6 + 2.9);
    near(half.wallTopY, 0.6 + 2.9 + 0.9);
    near(half.baseY - plain.baseY, 0.9);
  });

  it('adds a half story to the facade layout over the full ones', () => {
    const { stories, totalHeight } = computeFacadeLayout(RECT, { storyCount: 1, storyHeight: 2.9, kneeWallHeight: 0.9 });
    assert.deepEqual(stories.map((story) => [story.id, story.minY, +story.maxY.toFixed(6), Boolean(story.half)]), [
      ['story-1', 0, 2.9, false], ['story-2', 2.9, 3.8, true],
    ]);
    near(totalHeight, 3.8);
    assert.equal(computeFacadeLayout(RECT, { storyCount: 2 }).stories.length, 2, 'none without a knee wall');
  });

  it('a one-and-a-half-story wing beside a two-story upright', () => {
    const uprightAndWing = [[-6.4, -4.6], [6.4, -4.6], [6.4, 2.4], [-0.9, 2.4], [-0.9, 4.6], [-6.4, 4.6]];
    const volumes = computeFacadeLayout(uprightAndWing, { volumeSplit: 'x' }).volumes;
    const [upright, wing] = volumes;
    const zones = build(uprightAndWing, {
      storyCount: 2, volumes, volumeStoryOverrides: { [wing.id]: 1 }, volumeKneeWalls: { [wing.id]: 0.9 },
    }).roofZones;
    near(zones.find((zone) => zone.volumeId === upright.id).wallTopY, 0.6 + 5.8);
    near(zones.find((zone) => zone.volumeId === wing.id).wallTopY, 0.6 + 2.9 + 0.9);
    // a knee wall alone makes the volumes differ
    const kneeOnly = build(uprightAndWing, { storyCount: 1, volumes, volumeKneeWalls: { [wing.id]: 0.9 } }).roofZones;
    assert.notEqual(kneeOnly.find((zone) => zone.volumeId === upright.id).wallTopY, kneeOnly.find((zone) => zone.volumeId === wing.id).wallTopY);
  });

  it('dormers light the half story', () => {
    const { roofStructures } = build(RECT, {
      kneeWallHeight: 0.6,
      roofStructures: [{ id: 'd', hostVolumeId: 'volume-0', hostSide: 'maxZ', width: 1.5, setback: 0.8, wallHeight: 1.3 }],
    });
    assert.deepEqual(roofStructures[0].errors, []);
  });

  it('is saved with the project', () => {
    const layout = computeFacadeLayout(RECT, {});
    const saved = serializeBuildingState(layout, { kneeWallHeight: 0.9, volumeKneeWalls: { 'volume-0': 0.6 } });
    const { state } = deserializeBuildingState(saved);
    assert.equal(state.kneeWallHeight, 0.9);
    assert.deepEqual(state.volumeKneeWalls, { 'volume-0': 0.6 });
    assert.equal(deserializeBuildingState({ footprint: RECT }).state.kneeWallHeight, undefined);
  });
});
