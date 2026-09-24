import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import { computeFacadeLayout } from '../js/facade.js';
import {
  createBuildingFromFootprint,
  roofHeightFromPitch,
  roofPitchFromHeight,
  roofPitchDegrees,
} from '../js/extrusion.js';

const sampleFootprint = JSON.parse(readFileSync('./data/sample_footprint.json', 'utf8'));
const uFootprint = JSON.parse(readFileSync('./data/footprint_u.json', 'utf8'));

describe('Extrusion & 3D Building Massing', () => {
  it('converts between roof pitch and height accurately', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const height = roofHeightFromPitch(norm, 'z', 6, 12);
    assert.ok(height > 0);
    const derivedPitch = roofPitchFromHeight(norm, 'z', height, 12);
    assert.ok(Math.abs(derivedPitch - 6) < 1e-6);

    const degrees = roofPitchDegrees(6, 12);
    assert.ok(Math.abs(degrees - 26.565) < 0.1);
  });

  it('generates single-volume building with all roof types without NaNs', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const layout = computeFacadeLayout(norm);

    ['flat', 'gable', 'hip', 'shed'].forEach((roofType) => {
      const res = createBuildingFromFootprint(norm, {
        storyCount: 2,
        storyHeight: 3.2,
        roofType,
        roofDirection: 'z',
        roofPitchRise: 6,
        roofPitchRun: 12,
        roofHeight: 2.5,
        roofEaveDepth: 0.35,
        facadeLayout: layout,
        volumes: layout.volumes,
      });

      assert.ok(res.building);
      assert.equal(res.foundationHeight, 0.6);
      assert.equal(res.totalHeight, 6.4);

      // Verify geometry has no NaN vertices
      res.building.traverse((child) => {
        if (child.isMesh && child.geometry) {
          const pos = child.geometry.getAttribute('position');
          assert.ok(pos, 'Mesh should have position attribute');
          for (let i = 0; i < pos.count * pos.itemSize; i++) {
            assert.equal(Number.isNaN(pos.array[i]), false, `Vertex coordinate at index ${i} is NaN in ${roofType} roof`);
          }
        }
      });
    });
  });

  it('generates multi-volume building with story and roof overrides without NaNs', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm);
    assert.equal(layout.volumes.length, 3);

    const res = createBuildingFromFootprint(norm, {
      storyCount: 2,
      storyHeight: 3.2,
      roofType: 'gable',
      volumes: layout.volumes,
      volumeStoryOverrides: {
        [layout.volumes[0].id]: 1,
        [layout.volumes[1].id]: 3,
      },
      volumeRoofTypes: {
        [layout.volumes[0].id]: 'shed',
        [layout.volumes[1].id]: 'gable',
      },
    });

    assert.ok(res.building);
    assert.equal(res.building.userData.multiVolume, true);
    assert.equal(res.totalHeight, 3 * 3.2);

    res.building.traverse((child) => {
      if (child.isMesh && child.geometry) {
        const pos = child.geometry.getAttribute('position');
        if (pos) {
          for (let i = 0; i < pos.count * pos.itemSize; i++) {
            assert.equal(Number.isNaN(pos.array[i]), false, 'Found NaN in multi-volume mesh');
          }
        }
      }
    });
  });
});
