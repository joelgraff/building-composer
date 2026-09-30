import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import { computeFacadeLayout, decomposeIntoVolumes } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';

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

/**
 * Reads the axis a roof mesh's ridge runs along straight off its geometry:
 * finds the highest vertices (the ridge, or a hip's apex) and compares how
 * far apart they are in x vs. z.
 */
function ridgeAxisFromRoofMesh(mesh) {
  const pos = mesh.geometry.attributes.position;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i += 1) {
    maxY = Math.max(maxY, pos.getY(i));
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pos.count; i += 1) {
    if (Math.abs(pos.getY(i) - maxY) < 1e-3) {
      minX = Math.min(minX, pos.getX(i));
      maxX = Math.max(maxX, pos.getX(i));
      minZ = Math.min(minZ, pos.getZ(i));
      maxZ = Math.max(maxZ, pos.getZ(i));
    }
  }
  return (maxZ - minZ) > (maxX - minX) ? 'z' : 'x';
}

describe('Wall roles agree with the roof as built', () => {
  it('gable x-min: eaves are the walls parallel to the built ridge (running along z)', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable', roofDirection: 'x-min', roofPitchRise: 3 });
    const { building } = createBuildingFromFootprint(norm, {
      roofType: 'gable', roofDirection: 'x-min', roofPitchRise: 3, volumes: layout.volumes, facadeLayout: layout,
    });
    const roofMesh = building.children.find((child) => child.userData?.roofType);
    assert.equal(ridgeAxisFromRoofMesh(roofMesh), 'z');

    layout.wallRuns.forEach((run) => {
      const runsAlongZ = Math.abs(run.start[0] - run.end[0]) < 1e-6;
      assert.equal(run.role, runsAlongZ ? 'eave' : 'rake');
    });
  });

  it('gable z-min: eaves are the walls parallel to the built ridge (running along x)', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable', roofDirection: 'z-min', roofPitchRise: 3 });
    const { building } = createBuildingFromFootprint(norm, {
      roofType: 'gable', roofDirection: 'z-min', roofPitchRise: 3, volumes: layout.volumes, facadeLayout: layout,
    });
    const roofMesh = building.children.find((child) => child.userData?.roofType);
    assert.equal(ridgeAxisFromRoofMesh(roofMesh), 'x');

    layout.wallRuns.forEach((run) => {
      const runsAlongX = Math.abs(run.start[1] - run.end[1]) < 1e-6;
      assert.equal(run.role, runsAlongX ? 'eave' : 'rake');
    });
  });

  it('hip: every wall is an eave, and the built ridge still follows roofDirection', () => {
    const norm = normalizeFootprint(sampleFootprint);
    // Default pitch/height (roofPitchRise 6:12, roofHeight 2) keeps the ridge
    // shorter than the footprint's half-span, so it doesn't collapse to a
    // single apex point the way a steeper pitch or taller height would.
    const layout = computeFacadeLayout(norm, { roofType: 'hip', roofDirection: 'x-min' });
    const { building } = createBuildingFromFootprint(norm, {
      roofType: 'hip', roofDirection: 'x-min', volumes: layout.volumes, facadeLayout: layout,
    });
    const roofMesh = building.children.find((child) => child.userData?.roofType);
    assert.equal(ridgeAxisFromRoofMesh(roofMesh), 'z');

    layout.wallRuns.forEach((run) => assert.equal(run.role, 'eave'));
  });

  it('L-shape gable: each volume\'s eaves are parallel to that volume\'s own built ridge', () => {
    const norm = normalizeFootprint(lFootprint);
    const volumes = decomposeIntoVolumes(norm);
    const config = {
      roofType: 'gable',
      roofPitchRise: 3,
      volumes,
      // Force createMultiVolumeBuilding, which renders one roof mesh per
      // volume (tagged with volumeId), so each volume's own ridge can be
      // read back independently instead of one merged assembly mesh.
      volumeStoryOverrides: { [volumes[0].id]: 1 },
      storyCount: 2,
    };
    const layout = computeFacadeLayout(norm, config);
    const { building } = createBuildingFromFootprint(norm, { ...config, facadeLayout: layout });

    volumes.forEach((volume) => {
      const roofMesh = building.children.find((child) => child.userData?.roofType && child.userData.volumeId === volume.id);
      assert.ok(roofMesh, `expected a roof mesh for ${volume.id}`);
      const ridgeAxis = ridgeAxisFromRoofMesh(roofMesh);

      layout.wallRuns.filter((run) => run.volumeId === volume.id).forEach((run) => {
        const runsAlongRidge = ridgeAxis === 'z'
          ? Math.abs(run.start[0] - run.end[0]) < 1e-6
          : Math.abs(run.start[1] - run.end[1]) < 1e-6;
        assert.equal(run.role, runsAlongRidge ? 'eave' : 'rake');
      });
    });
  });
});
