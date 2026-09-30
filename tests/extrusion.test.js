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

  it('gives a single-rectangle hip roof the same configured pitch on both slope pairs, whichever axis the ridge is set to', () => {
    // 16 x 8: non-square, so the two slope pairs only share a pitch if the
    // ridge is forced onto the longer (x) axis regardless of what's asked for.
    const rect = [[-8, -4], [8, -4], [8, 4], [-8, 4]];
    const volumes = computeFacadeLayout(rect, { volumeSplit: 'auto' }).volumes;

    const roofVerts = (roofDirection) => {
      const roofHeight = roofHeightFromPitch(rect, roofDirection, 6, 12, volumes, 'hip');
      const { building } = createBuildingFromFootprint(rect, {
        storyCount: 1, storyHeight: 3, foundationDepth: 0.6,
        roofType: 'hip', roofDirection, roofPitchRise: 6, roofPitchRun: 12, roofHeight,
        roofEaveDepth: 0, volumes,
      });
      const pos = [];
      building.traverse((mesh) => {
        if (mesh.isMesh && mesh.material?.userData?.role === 'roof') {
          const p = mesh.geometry.getAttribute('position');
          for (let i = 0; i < p.count; i += 1) pos.push([p.getX(i), p.getY(i), p.getZ(i)].map((v) => +v.toFixed(3)));
        }
      });
      const unique = [];
      pos.forEach((p) => { if (!unique.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-3)) unique.push(p); });
      return unique.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    };

    const alongLongAxis = roofVerts('x');
    const alongShortAxis = roofVerts('z');
    assert.deepEqual(alongShortAxis, alongLongAxis, 'a ridge asked to run the short way still builds the long-axis roof, not a mismatched-pitch pyramid');

    const peakY = Math.max(...alongLongAxis.map((p) => p[1]));
    assert.ok(Math.abs(peakY - 2) < 1e-6, 'peak height matches the configured 6:12 pitch over the short half-span');
    const ridgePoints = alongLongAxis.filter((p) => Math.abs(p[1] - peakY) < 1e-6);
    assert.equal(ridgePoints.length, 2, 'a real ridge line, not a pyramid apex, on a non-square footprint');
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

describe('a volume\'s own wall material', () => {
  const ell = [[-6, -4], [6, -4], [6, 0], [0, 0], [0, 4], [-6, 4]];
  const build = (config = {}) => {
    const layout = computeFacadeLayout(ell, { volumeSplit: 'auto' });
    return {
      layout,
      built: createBuildingFromFootprint(ell, {
        storyCount: 1, storyHeight: 3, foundationDepth: 0.7, roofType: 'gable', roofDirection: 'x', roofHeight: 2,
        volumes: layout.volumes, facadeLayout: layout, wallMaterial: 'wood', ...config,
      }),
    };
  };
  const wallPalettes = (built) => {
    const out = {};
    built.building.traverse((mesh) => {
      if (mesh.userData?.bodyPart === 'walls') out[mesh.userData.volumeId ?? 'all'] = mesh.material.userData.palette;
    });
    return out;
  };

  it('clads that volume\'s walls, the rest keeping the building\'s', () => {
    const { layout } = build();
    const [main, wing] = layout.volumes;
    const { built } = build({ volumeMaterials: { [wing.id]: 'brick' } });
    assert.deepEqual(wallPalettes(built), { [main.id]: 'wood', [wing.id]: 'brick' });
  });

  it('leaves one solid wall when no volume has its own', () => {
    assert.deepEqual(wallPalettes(build().built), { all: 'wood' });
    assert.deepEqual(wallPalettes(build({ volumeMaterials: { 'volume-99': 'brick' } }).built), { all: 'wood' });
  });

  it('holds with volumes on their own story counts too', () => {
    const { layout } = build();
    const [main, wing] = layout.volumes;
    const { built } = build({ volumeMaterials: { [wing.id]: 'stone' }, volumeStoryOverrides: { [main.id]: 2 } });
    assert.deepEqual(wallPalettes(built), { [main.id]: 'wood', [wing.id]: 'stone' });
  });

  it('frames a window left to default in its own volume\'s material', () => {
    const { layout } = build();
    const [, wing] = layout.volumes;
    const wall = layout.wallRuns.find((run) => run.volumeId === wing.id);
    const { built } = build({
      volumeMaterials: { [wing.id]: 'brick' },
      openings: [{ id: 'w', kind: 'window', hostWallRunId: wall.id, offset: 0, width: 0.8, height: 1, sillHeight: 0.9, materials: {} }],
    });
    let frame;
    built.building.traverse((mesh) => { if (mesh.userData?.bodyPart === 'opening-frame') frame = mesh; });
    assert.equal(frame.material.userData.palette, 'brick');
  });
});
