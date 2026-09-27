import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { volumeSolid, isInsideSolid } from '../js/roof-structures.js';
import { meshTriangles, uncoveredEdges } from './helpers/mesh.js';

// an upright-and-wing: an 18 x 30 ft two-story upright (x -6.4..-0.9) and a lower wing (x -0.9..6.4)
const UPRIGHT_AND_WING = [[-6.4, -4.6], [6.4, -4.6], [6.4, 2.4], [-0.9, 2.4], [-0.9, 4.6], [-6.4, 4.6]];
const VOLUMES = computeFacadeLayout(UPRIGHT_AND_WING, { volumeSplit: 'x' }).volumes;
const [UPRIGHT, WING] = VOLUMES;
const EAVE = 0.35;

function build(config = {}) {
  return createBuildingFromFootprint(UPRIGHT_AND_WING, {
    storyCount: 2, storyHeight: 2.9, foundationDepth: 0.6, roofType: 'gable', roofPitchRise: 10, roofPitchRun: 12, roofEaveDepth: EAVE,
    volumes: VOLUMES, volumeStoryOverrides: { [WING.id]: 1 }, volumeRidgeDirections: { [UPRIGHT.id]: 'x-min', [WING.id]: 'z-min' },
    roofStructures: [], ...config,
  });
}

function roofOf(result, volumeId) {
  const out = [];
  result.building.traverse((child) => {
    if (child.isMesh && child.userData?.roofType && child.userData.volumeId === volumeId) {
      meshTriangles(child).forEach((tri) => out.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  return out;
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

describe('an upper roof over a lower neighbor', () => {
  it('keeps its eave along the shared side, cut only where the lower roof passes through it', () => {
    [0, 0.9].forEach((knee) => {
      const result = build({ volumeKneeWalls: { [WING.id]: knee } });
      const roof = roofOf(result, UPRIGHT.id);
      // the eave runs out over the wing along the whole shared wall
      const xs = roof.flat().map(([x]) => x);
      assert.ok(Math.abs(Math.max(...xs) - (UPRIGHT.maxX + EAVE)) < 1e-6, `knee ${knee}: eave out to ${Math.max(...xs)}`);
      const overWing = roof.filter((tri) => tri.every(([x, , z]) => x > UPRIGHT.maxX - 1e-6 && z < WING.maxZ + 1e-6));
      assert.ok(overWing.length > 0, `knee ${knee}: eave over the wing`);
      // and none of it is inside the wing
      const wing = volumeSolid(result.roofZones.find((zone) => zone.volumeId === WING.id));
      roof.forEach((tri) => {
        const centroid = [0, 1, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
        assert.ok(!isInsideSolid(centroid, wing, -1e-6), `knee ${knee}: eave inside the wing at ${centroid.map((v) => v.toFixed(2))}`);
      });
      assertWatertight(result, `knee ${knee}`);
    });
  });

  it('a neighbor as tall shares the side, which has no eave', () => {
    const result = build({ volumeStoryOverrides: {} , volumeKneeWalls: {} , volumeRidgeDirections: { [UPRIGHT.id]: 'x-min', [WING.id]: 'z-min' } });
    const xs = roofOf(result, UPRIGHT.id).flat().map(([x]) => x);
    assert.ok(Math.max(...xs) <= UPRIGHT.maxX + 1e-6, 'no eave over an equal neighbor');
  });
});

describe('a gable end meeting a neighbor\'s roof', () => {
  // an I-house (36 x 18 ft, ridge along x) with a two-story rear ell (ridge along z) whose gable end meets its rear eave
  const FARMHOUSE = [[-5.5, -6], [-0.5, -6], [-0.5, 0], [5.5, 0], [5.5, 5.5], [-5.5, 5.5]];
  const layout = computeFacadeLayout(FARMHOUSE, { volumeSplit: 'auto' });
  const main = layout.volumes.find((volume) => volume.maxX - volume.minX > 10);
  const ell = layout.volumes.find((volume) => volume !== main);
  const buildFarmhouse = (config = {}) => createBuildingFromFootprint(FARMHOUSE, {
    storyCount: 2, storyHeight: 2.9, foundationDepth: 0.6, roofType: 'gable', roofPitchRise: 10, roofPitchRun: 12, roofEaveDepth: 0.35,
    volumes: layout.volumes, volumeRidgeDirections: { [main.id]: 'z-min', [ell.id]: 'x-min' }, roofStructures: [], ...config,
  });

  // the roof's height over the main block, on the ell's ridge line a metre past the shared wall
  const roofHeightThere = (result) => {
    const [x, z] = [(ell.minX + ell.maxX) / 2, main.minZ + 1];
    let best = -Infinity;
    result.building.traverse((child) => {
      if (!child.isMesh || !child.userData?.roofType) return;
      meshTriangles(child).forEach(([a, b, c]) => {
        const d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
        if (Math.abs(d) < 1e-12) return;
        const u = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / d;
        const v = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / d;
        if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) {
          best = Math.max(best, a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]));
        }
      });
    });
    return best;
  };
  const ellRidge = ((ell.maxX - ell.minX) / 2) * (10 / 12);

  it('merges into it by default: the ell\'s ridge runs on into the main roof, one closed shell', () => {
    const result = buildFarmhouse();
    assert.ok(Math.abs(roofHeightThere(result) - ellRidge) < 1e-6, `the ell's ridge over the main roof: ${roofHeightThere(result)}`);
    assertWatertight(result, 'merged ell');
  });

  it('stays a standalone gable when chosen', () => {
    const result = buildFarmhouse({ volumeRoofConnections: { [ell.id]: 'standalone' } });
    assert.ok(Math.abs(roofHeightThere(result) - 10 / 12) < 1e-6, `the main roof's own slope: ${roofHeightThere(result)}`);
  });
});

