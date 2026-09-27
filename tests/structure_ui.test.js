import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { STRUCTURE_UI_PRESETS, newRoofStructure, structureLabel } from '../js/structure-ui.js';

const RECT = [[-10, -5], [10, -5], [10, 5], [-10, 5]];

function buildWith(structures, config = {}) {
  return createBuildingFromFootprint(RECT, {
    storyCount: 2,
    storyHeight: 3.2,
    foundationDepth: 0.7,
    roofType: 'gable',
    roofDirection: 'x',
    roofHeight: 5 * (8 / 12),
    roofPitchRise: 8,
    roofPitchRun: 12,
    roofEaveDepth: 0.35,
    volumes: computeFacadeLayout(RECT, {}).volumes,
    ...config,
    roofStructures: structures,
  });
}

describe('roof structure UI presets', () => {
  const placement = { hostVolumeId: 'volume-0', hostSide: 'minZ', storyHeight: 3.2, wallLength: 20 };

  it('each builds without errors on a two-story house (on the roof it suits)', () => {
    const suits = {};
    STRUCTURE_UI_PRESETS.filter((preset) => !preset.onStructure).forEach((preset) => {
      const record = newRoofStructure(preset.key, placement);
      assert.ok(record, preset.key);
      const [entry] = buildWith([record], suits[preset.key] ?? {}).roofStructures;
      assert.deepEqual(entry.errors, [], `${preset.key}: ${entry.errors.map((e) => e.message)}`);
    });
  });

  it('a wraparound porch runs the whole wall and turns the corner at its right end', () => {
    const record = newRoofStructure('wraparound-porch', placement);
    assert.equal(record.width, 20);
    assert.deepEqual(record.wrap, { end: 'right', length: 4 });
    const entries = buildWith([record]).roofStructures;
    assert.deepEqual(entries.map((entry) => entry.id), [record.id, `${record.id}-wrap`]);
    assert.deepEqual(entries.map((entry) => entry.errors), [[], []]);
  });

  it('an upper porch stands one story down, on posts', () => {
    const record = newRoofStructure('upper-porch', placement);
    assert.equal(record.baseHeight, -3.2);
    assert.equal(record.support, 'posts');
  });

  it('a sleeping porch stands on the whole of the selected porch, facing the same way', () => {
    const ground = newRoofStructure('ground-porch', placement);
    const groundFlat = { ...ground, roofType: 'flat', wallHeight: 3.2 };
    const sleeping = newRoofStructure('sleeping-porch', { hostStructure: groundFlat }, [groundFlat]);
    assert.equal(sleeping.hostStructureId, ground.id);
    assert.equal(sleeping.hostSide, ground.hostSide);
    assert.equal(sleeping.width, ground.width);
    assert.equal(sleeping.depth, ground.depth);
    assert.notEqual(sleeping.id, ground.id);
    const entries = buildWith([groundFlat, sleeping]).roofStructures;
    assert.deepEqual(entries.map((entry) => entry.errors), [[], []]);
    assert.equal(newRoofStructure('sleeping-porch', {}), null, 'needs a porch to stand on');
    assert.equal(newRoofStructure('no-such-preset', placement), null);
  });

  it('gives each new structure its own id', () => {
    const first = newRoofStructure('gable-dormer', placement);
    const second = newRoofStructure('gable-dormer', placement, [first]);
    assert.notEqual(first.id, second.id);
  });

  it('labels structures by what they are and where', () => {
    assert.equal(structureLabel(newRoofStructure('gable-dormer', placement)), 'Dormer · volume 0, Z-min side');
    assert.equal(structureLabel(newRoofStructure('shed-dormer', placement)), 'Shed dormer · volume 0, Z-min side');
    assert.equal(structureLabel({ kind: 'porch', hostStructureId: 'structure-1', hostSide: 'minZ' }), 'Porch · on structure-1');
  });
});
