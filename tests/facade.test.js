import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import { computeFacadeLayout, decomposeIntoVolumes } from '../js/facade.js';

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
