import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState } from '../js/facade.js';
import { createBuildingFromFootprint, volumeWallHeight, volumeFoundationHeight } from '../js/extrusion.js';
import { meshTriangles, uncoveredEdges } from './helpers/mesh.js';

const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message ?? ''} expected ${b}, got ${a}`);

// a main block (x 0..10, z 0..8) with a wing behind it (x 0..6, z 8..14)
const L = [[0, 0], [10, 0], [10, 8], [6, 8], [6, 14], [0, 14]];
const VOLUMES = computeFacadeLayout(L, {}).volumes;
const MAIN = VOLUMES.find((volume) => volume.maxX - volume.minX > 9);
const WING = VOLUMES.find((volume) => volume !== MAIN);

function build(config = {}) {
  return createBuildingFromFootprint(L, {
    storyCount: 2, storyHeight: 3.6, foundationDepth: 0.7, roofType: 'gable', roofPitchRise: 8, roofPitchRun: 12, roofEaveDepth: 0.35,
    volumes: VOLUMES, roofStructures: [], ...config,
  });
}

function assertWatertight(result, label) {
  const tris = [];
  result.building.traverse((child) => {
    if (child.isMesh && !child.userData?.editorOnly) {
      meshTriangles(child).forEach((tri) => tris.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3));
  assert.deepEqual(uncoveredEdges(tris).filter((edge) => !lift(edge)), [], `${label}: see-through edges`);
}

describe('story height and floor level by volume', () => {
  it('a volume can have its own story height and its own floor above grade', () => {
    const config = { storyCount: 2, storyHeight: 3.6, foundationDepth: 0.7, volumeStoryHeights: { w: 2.6 }, volumeFoundationHeights: { g: 0 } };
    near(volumeWallHeight(null, config), 7.2);
    near(volumeWallHeight('w', config), 5.2);
    near(volumeFoundationHeight(null, config), 0.7);
    near(volumeFoundationHeight('g', config), 0, 'a slab at grade');
    near(volumeFoundationHeight('w', config), 0.7);
  });

  it('a rear kitchen wing with lower ceilings behind a tall main block', () => {
    const result = build({ volumeStoryOverrides: { [WING.id]: 1 }, volumeStoryHeights: { [WING.id]: 2.6 } });
    const zone = (id) => result.roofZones.find((candidate) => candidate.volumeId === id);
    near(zone(MAIN.id).wallTopY, 0.7 + 7.2);
    near(zone(WING.id).wallTopY, 0.7 + 2.6);
    assertWatertight(result, 'kitchen wing');
  });

  it('a garage on a slab at grade beside a raised house', () => {
    const result = build({
      storyCount: 1, storyHeight: 2.7, volumeFoundationHeights: { [WING.id]: 0 }, volumeStoryHeights: { [WING.id]: 2.7 },
    });
    const garage = result.roofZones.find((zone) => zone.volumeId === WING.id);
    near(garage.foundationTopY, 0);
    near(garage.wallTopY, 2.7);
    const foundations = [];
    result.building.traverse((child) => {
      if (child.isMesh && child.userData?.volumeId === WING.id && !child.userData.bodyPart && !child.userData.roofType) {
        foundations.push(child);
      }
    });
    assert.equal(foundations.length, 0, 'no foundation wall under the slab');
    assertWatertight(result, 'garage at grade');
  });

  it('a floor-level difference alone gives the volumes their own roofs', () => {
    const result = build({ storyCount: 1, volumeFoundationHeights: { [WING.id]: 0 } });
    assert.equal(result.roofZones.length, 2);
    assert.ok(result.building.userData.multiVolume);
  });

  it('a garage at grade with taller walls, level at the plate, shares the house\'s one roof', () => {
    const result = build({
      storyCount: 1, storyHeight: 2.7, volumeFoundationHeights: { [WING.id]: 0 }, volumeStoryHeights: { [WING.id]: 3.4 },
    });
    assert.ok(!result.building.userData.multiVolume, 'one roof');
    const garage = result.roofZones.find((zone) => zone.volumeId === WING.id);
    const house = result.roofZones.find((zone) => zone.volumeId === MAIN.id);
    near(garage.foundationTopY, 0, 'the garage floor');
    near(house.foundationTopY, 0.7, 'the house floor');
    near(garage.wallTopY, house.wallTopY, 'one plate');
    // the garage's walls stand on the slab, with no foundation wall under them
    const walls = [];
    result.building.traverse((child) => {
      if (child.isMesh && child.userData?.bodyPart === 'walls' && child.userData.volumeId === WING.id) {
        meshTriangles(child).forEach((tri) => walls.push(...tri.map(([, y]) => y + child.position.y)));
      }
    });
    assert.ok(walls.length > 0, 'the garage has its own walls');
    near(Math.min(...walls), 0, 'down to grade');
    assertWatertight(result, 'garage level at the plate');
  });

  it('is saved with the project', () => {
    const layout = computeFacadeLayout(L, {});
    const saved = serializeBuildingState(layout, {
      foundationDepth: 0.9, volumeStoryHeights: { [WING.id]: 2.6 }, volumeFoundationHeights: { [WING.id]: 0 },
    });
    const { state } = deserializeBuildingState(saved);
    assert.equal(state.foundationDepth, 0.9);
    assert.deepEqual(state.volumeStoryHeights, { [WING.id]: 2.6 });
    assert.deepEqual(state.volumeFoundationHeights, { [WING.id]: 0 });
  });
});
