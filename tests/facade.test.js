import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import {
  computeFacadeLayout, decomposeIntoVolumes, serializeBuildingState, deserializeBuildingState,
} from '../js/facade.js';

const sampleFootprint = JSON.parse(readFileSync('./data/sample_footprint.json', 'utf8'));
const uFootprint = JSON.parse(readFileSync('./data/footprint_u.json', 'utf8'));
const lFootprint = JSON.parse(readFileSync('./data/footprint_l.json', 'utf8'));
const leanToFootprint = JSON.parse(readFileSync('./data/footprint_narrow_lean_to.json', 'utf8'));
const wideWingFootprint = JSON.parse(readFileSync('./data/footprint_wide_wing.json', 'utf8'));

describe('Facade Subdivision & Volume Decomposition', () => {
  it('computes facade layout for rectangular footprint', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const layout = computeFacadeLayout(norm, {
      storyCount: 2,
      storyHeight: 3.0,
      panelsPerRun: 2,
    });

    assert.equal(layout.storyCount, 2);
    assert.equal(layout.storyHeight, 3.0);
    assert.equal(layout.totalHeight, 6.0);
    assert.equal(layout.stories.length, 2);
    assert.equal(layout.wallRuns.length, 4);
    assert.equal(layout.facadePanels.length, 8); // 4 wall runs * 2 panels
  });

  it('decomposes rectangular footprint into 1 volume', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const volumes = decomposeIntoVolumes(norm);
    assert.equal(volumes.length, 1);
  });

  it('decomposes U-shaped footprint into 3 volumes (base + 2 legs)', () => {
    const norm = normalizeFootprint(uFootprint);
    const volumes = decomposeIntoVolumes(norm);
    assert.equal(volumes.length, 3);
  });

  it('decomposes L-shaped footprint into 2 volumes', () => {
    const norm = normalizeFootprint(lFootprint);
    const volumes = decomposeIntoVolumes(norm);
    assert.equal(volumes.length, 2);
  });

  it('decomposes lean-to and wide-wing footprints into 2 volumes', () => {
    const leanToVolumes = decomposeIntoVolumes(normalizeFootprint(leanToFootprint));
    assert.equal(leanToVolumes.length, 2);

    const wideWingVolumes = decomposeIntoVolumes(normalizeFootprint(wideWingFootprint));
    assert.equal(wideWingVolumes.length, 2);
  });
});

describe('cutting a footprint into volumes that follow its massing', () => {
  const size = (volume) => [+(volume.maxX - volume.minX).toFixed(3), +(volume.maxZ - volume.minZ).toFixed(3)];
  // an upright-and-wing: an 18 x 30 ft gable-front upright, and a wing set back from its front
  const uprightAndWing = [[-6.4, -4.6], [6.4, -4.6], [6.4, 2.4], [-0.9, 2.4], [-0.9, 4.6], [-6.4, 4.6]];
  // a main block with a projection in the middle of one side
  const sideProjection = [[-3.65, -6.1], [3.65, -6.1], [3.65, -1], [6.1, -1], [6.1, 3], [3.65, 3], [3.65, 6.1], [-3.65, 6.1]];

  it('Z bands can cut against the massing; X bands and the automatic choice follow it', () => {
    assert.deepEqual(decomposeIntoVolumes(uprightAndWing).map(size), [[12.8, 7], [5.5, 2.2]], 'the upright\'s rear merged with the wing');
    const expected = [[5.5, 9.2], [7.3, 7]];
    assert.deepEqual(decomposeIntoVolumes(uprightAndWing, { split: 'x' }).map(size), expected);
    assert.deepEqual(decomposeIntoVolumes(uprightAndWing, { split: 'auto' }).map(size), expected);
  });

  it('keeps a main block whole rather than cutting it in three', () => {
    assert.equal(decomposeIntoVolumes(sideProjection).length, 3);
    assert.deepEqual(decomposeIntoVolumes(sideProjection, { split: 'auto' }).map(size), [[7.3, 12.2], [2.45, 4]]);
  });

  it('keeps the Z bands where both cuts are as good, so the samples don\'t change', () => {
    [sampleFootprint, uFootprint, lFootprint, leanToFootprint, wideWingFootprint].forEach((footprint) => {
      const norm = normalizeFootprint(footprint);
      assert.deepEqual(decomposeIntoVolumes(norm, { split: 'auto' }), decomposeIntoVolumes(norm));
    });
  });

  it('the layout cuts as its config says', () => {
    assert.equal(computeFacadeLayout(uprightAndWing, { volumeSplit: 'auto' }).volumes[0].maxX - computeFacadeLayout(uprightAndWing, { volumeSplit: 'auto' }).volumes[0].minX, 5.5);
    assert.equal(computeFacadeLayout(uprightAndWing, {}).volumes[0].maxX - computeFacadeLayout(uprightAndWing, {}).volumes[0].minX, 12.8);
  });

  it('a project saves its cut; older files keep the Z bands their volume ids came from', () => {
    const layout = computeFacadeLayout(uprightAndWing, { volumeSplit: 'x' });
    const saved = serializeBuildingState(layout, { volumeSplit: 'x' });
    assert.equal(saved.volumeSplit, 'x');
    assert.equal(deserializeBuildingState(saved).state.volumeSplit, 'x');
    const older = { format: 'building-composer', version: 1, footprint: uprightAndWing, roofStructures: [{ id: 'd', hostVolumeId: 'volume-1', hostSide: 'maxZ' }] };
    const { state, warnings } = deserializeBuildingState(older);
    assert.equal(state.volumeSplit, 'z');
    assert.deepEqual(warnings, [], 'volume-1 exists in the Z bands');
  });
});

describe('windows and doors round-trip through save/load', () => {
  const layout = computeFacadeLayout(sampleFootprint, {});

  it('a saved project keeps its openings, addressed by wall run id', () => {
    const modelConfig = { openings: [{ hostWallRunId: 'wall-run-0', kind: 'window', offset: 1 }] };
    const saved = serializeBuildingState(layout, modelConfig);
    assert.equal(saved.openings.length, 1);
    const { state } = deserializeBuildingState(saved);
    assert.equal(state.openings.length, 1);
    assert.equal(state.openings[0].hostWallRunId, 'wall-run-0');
    assert.equal(state.openings[0].offset, 1);
  });

  it('drops an opening whose host wall no longer exists, with a warning, rather than reattaching it', () => {
    const file = {
      format: 'building-composer',
      version: 1,
      footprint: sampleFootprint,
      openings: [
        { hostWallRunId: 'wall-run-0', kind: 'window' },
        { hostWallRunId: 'wall-run-99', kind: 'door' },
      ],
    };
    const { state, warnings } = deserializeBuildingState(file);
    assert.equal(state.openings.length, 1);
    assert.equal(state.openings[0].hostWallRunId, 'wall-run-0');
    assert.ok(warnings.some((w) => w.includes('wall-run-99')));
  });

  it('keeps its trim courses, and an older file loads with every course off', () => {
    const trim = { material: 'stone', cornice: { enabled: true, height: 0.4, projection: 0.25, dentils: true } };
    const { state } = deserializeBuildingState(serializeBuildingState(layout, { trim }));
    assert.equal(state.trim.material, 'stone');
    assert.deepEqual(state.trim.cornice, { enabled: true, height: 0.4, projection: 0.25, dentils: true });
    assert.equal(state.trim.waterTable.enabled, false);
    const old = deserializeBuildingState({ format: 'building-composer', version: 1, footprint: sampleFootprint }).state;
    assert.equal(['waterTable', 'beltCourse', 'cornice'].some((kind) => old.trim[kind].enabled), false);
  });

  it('an old file with no openings key loads with an empty list, not an error', () => {
    const file = { format: 'building-composer', version: 1, footprint: sampleFootprint };
    const { state, valid } = deserializeBuildingState(file);
    assert.equal(valid, true);
    assert.deepEqual(state.openings, []);
  });
});
