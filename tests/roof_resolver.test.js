import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import { computeFacadeLayout, roofAxisForDirection } from '../js/facade.js';
import {
  createBuildingFromFootprint,
  resolveRoofConnections,
  computeVolumeEavePlanes,
  evalZoneHeight,
  createShedRoofGeometry,
} from '../js/extrusion.js';

// resolveRoofConnections expects "directed" volumes (ridgeAxis/roofHighEdge
// already resolved from any volumeRidgeDirections override), matching what
// createVolumeRoofAssembly feeds it via applyVolumeRidgeDirections (not
// exported, since it's a small internal step) - replicate that transform
// here so tests exercise the same shape production code actually sees.
function directVolume(volume, highEdge) {
  if (!highEdge) {
    return volume;
  }
  return {
    ...volume,
    ridgeAxis: roofAxisForDirection(highEdge),
    roofHighEdge: highEdge,
    ridgeDirectionOverride: true,
  };
}

const uFootprint = JSON.parse(readFileSync('./data/footprint_u.json', 'utf8'));

function assertNoNaNs(building) {
  building.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const pos = child.geometry.getAttribute('position');
      if (pos) {
        for (let i = 0; i < pos.count * pos.itemSize; i += 1) {
          assert.equal(Number.isNaN(pos.array[i]), false, 'found NaN in roof geometry');
        }
      }
    }
  });
}

// A wide gable block (ridge running along Z, so its GABLE END - a genuinely
// sloped face - sits on the shared wall at z=0) with a narrow shed leg
// attached to that end face, centered near the ridge so neither shared-wall
// corner coincides with the gable's own zero-height outer corner.
const volumeA = {
  id: 'volume-a', minX: 0, maxX: 20, minZ: -10, maxZ: 0, ridgeAxis: 'z',
};
const volumeB = {
  id: 'volume-b', minX: 8, maxX: 12, minZ: 0, maxZ: 6, ridgeAxis: 'z', roofHighEdge: 'z-min',
};

describe('resolveRoofConnections / eave-plane model', () => {
  it('is opt-in: no volumeRoofConnections entry means standalone, even against a genuinely sloped gable end', () => {
    const config = {
      roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
      volumeRoofTypes: { [volumeB.id]: 'shed' },
    };
    const resolutions = resolveRoofConnections([volumeA, volumeB], config);
    assert.equal(Object.keys(resolutions.get(volumeB.id)).length, 0, 'merging must be explicitly requested via volumeRoofConnections');
  });

  it('marks a shed leg merged (coplanar, closure suppressed) into an adjacent gable end, with the correct neighbor plane', () => {
    const config = {
      roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
      volumeRoofTypes: { [volumeB.id]: 'shed' },
      volumeRoofConnections: { [volumeB.id]: 'merge-plane' },
    };
    const resolutions = resolveRoofConnections([volumeA, volumeB], config);
    const resolutionB = resolutions.get(volumeB.id);
    assert.equal(resolutionB.minZ?.mode, 'merged', 'expected volume B\'s minZ side (shared with the gable end) to merge');
    assert.equal(resolutionB.minZ.suppressClosure, true, 'a genuinely coplanar merge should suppress the closure face');

    const heightAtLeftCorner = evalZoneHeight(resolutionB.minZ.neighborPlanes, volumeB.minX, volumeB.minZ);
    const heightAtRightCorner = evalZoneHeight(resolutionB.minZ.neighborPlanes, volumeB.maxX, volumeB.minZ);
    assert.ok(Math.abs(heightAtLeftCorner - 4) < 1e-9, `expected neighbor gable-end height 4 at (8,0), got ${heightAtLeftCorner}`);
    assert.ok(Math.abs(heightAtRightCorner - 4) < 1e-9, `expected neighbor gable-end height 4 at (12,0), got ${heightAtRightCorner}`);
  });

  it('falls through to a ridge snap (footprint extended to the ridge, no closure needed) when the shed\'s own high edge faces the flat gable eave', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const base = layout.volumes[0];
    const legVolume = directVolume(layout.volumes[1], 'z-min');
    const config = {
      roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
      volumeRoofTypes: { [legVolume.id]: 'shed' },
      volumeRoofConnections: { [legVolume.id]: 'merge-plane' },
    };
    const resolutions = resolveRoofConnections([base, legVolume, layout.volumes[2]], config);
    const resolutionLeg = resolutions.get(legVolume.id);
    const mergedSide = Object.keys(resolutionLeg).find((side) => resolutionLeg[side]?.mode === 'merged');
    assert.ok(mergedSide, 'a flat eave has no plane to merge into, but the base still has a real ridge to snap to');
    assert.equal(resolutionLeg[mergedSide].override, true, 'a ridge snap deterministically overrides rather than clamps');
    assert.equal(resolutionLeg[mergedSide].suppressClosure, true, 'the boundary is relocated to the ridge itself, so there is no edge left to close');
    const baseRidgeZ = (base.minZ + base.maxZ) / 2;
    assert.ok(Math.abs(resolutionLeg[mergedSide].extendTo - baseRidgeZ) < 1e-9, 'the shed\'s boundary must be relocated to the base\'s actual ridge coordinate');
    const baseRidgeHeight = ((base.maxZ - base.minZ) / 2) * (6 / 12);
    assert.ok(Math.abs(resolutionLeg[mergedSide].height - baseRidgeHeight) < 1e-9, 'the target height at the extended boundary must equal the base\'s actual ridge height');
  });

  it('never merges into a hip neighbor, because every hip boundary edge is at eave height (falls through to a ridge snap instead)', () => {
    const hipVolumeA = { ...volumeA, ridgeAxis: 'x' };
    const config = {
      roofType: 'hip', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
      volumeRoofTypes: { [volumeB.id]: 'shed' },
      volumeRoofConnections: { [volumeB.id]: 'merge-plane' },
    };
    const hipPlanes = computeVolumeEavePlanes(
      { minX: hipVolumeA.minX, maxX: hipVolumeA.maxX, minZ: hipVolumeA.minZ, maxZ: hipVolumeA.maxZ },
      'hip',
      { roofPitchRise: 6, roofPitchRun: 12 }
    );
    assert.ok(Math.abs(evalZoneHeight(hipPlanes, 8, 0)) < 1e-9, 'a hip roof\'s own perimeter is always at eave height (0)');

    const resolutions = resolveRoofConnections([hipVolumeA, volumeB], config);
    const resolutionB = resolutions.get(volumeB.id);
    const mergedSide = Object.keys(resolutionB).find((side) => resolutionB[side]?.mode === 'merged');
    assert.ok(mergedSide, 'a hip has no sloped boundary to plane-merge into, but still has a real ridge to snap to');
    assert.equal(resolutionB[mergedSide].override, true);
  });
});

describe('Merge into adjacent roof: the default U-shape case (shed leg against a flat gable eave)', () => {
  it('falls through from plane-merge to a ridge snap that rebuilds the shed as one continuous slope through the gable\'s ridge (not just a height clamp at the wall)', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const base = layout.volumes[0];
    // Matches the reported scenario exactly: shed leg with an explicit
    // "High edge: Z-min" ridge-direction override, facing the base.
    const legVolume = directVolume(layout.volumes[1], 'z-min');
    const directedVolumes = [base, legVolume, layout.volumes[2]];

    const baseConfig = {
      roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
      volumeRoofTypes: { [legVolume.id]: 'shed' },
    };

    const automatic = resolveRoofConnections(directedVolumes, baseConfig);
    assert.equal(Object.keys(automatic.get(legVolume.id)).length, 0, 'no volumeRoofConnections entry at all means standalone (opt-in)');

    const mergeConfig = { ...baseConfig, volumeRoofConnections: { [legVolume.id]: 'merge-plane' } };
    const merged = resolveRoofConnections(directedVolumes, mergeConfig);
    const legResolution = merged.get(legVolume.id);
    const mergedSide = Object.keys(legResolution).find((side) => legResolution[side]?.mode === 'merged');
    assert.ok(mergedSide, 'expected "Merge into adjacent roof" to fall through to a ridge snap even though the shared wall is a flat eave');
    assert.equal(legResolution[mergedSide].override, true, 'a ridge snap should deterministically override, not just clamp');
    assert.equal(legResolution[mergedSide].suppressClosure, true, 'the shed\'s boundary relocates to the ridge itself, so there is no edge left to close (not a knee wall left in place)');

    // base: ridgeAxis 'x' (default), ridge sits at the center Z, halfSpan
    // (maxZ-minZ)/2 = 4, pitch 6/12 -> ridge height 2, ridge Z = -4.2857.
    const baseRidgeZ = (base.minZ + base.maxZ) / 2;
    const baseRidgeHeight = ((base.maxZ - base.minZ) / 2) * (6 / 12);
    assert.ok(Math.abs(legResolution[mergedSide].extendTo - baseRidgeZ) < 1e-9, 'the shed\'s footprint must extend all the way to the base\'s actual ridge coordinate, not stop at the original wall');
    assert.ok(Math.abs(legResolution[mergedSide].height - baseRidgeHeight) < 1e-9, 'the extended boundary\'s height must equal the base\'s actual ridge height');
    // The shed's own far (low) eave anchor is unchanged (its own maxZ, since
    // highEdge is z-min); connecting that point (height 0) straight through
    // the base's actual ridge point gives a single combined span, NOT just
    // "clamp to the ridge height at the wall".
    const combinedSpan = Math.abs(legVolume.maxZ - baseRidgeZ);
    const expectedWallHeight = baseRidgeHeight * (legVolume.maxZ - legVolume.minZ) / combinedSpan;
    // Sanity: this must be strictly less than the ridge height itself (the
    // wall sits partway between the ridge and the shed's own outer eave) —
    // this is exactly what the old, incorrect implementation got wrong by
    // always snapping straight to the full ridge height regardless of where
    // the wall actually sits along that combined span.
    assert.ok(expectedWallHeight < baseRidgeHeight, 'the wall height must be less than the full ridge height, since the wall sits before the ridge along the combined span');

    const snappedHeightAtMinX = evalZoneHeight(legResolution[mergedSide].neighborPlanes, legVolume.minX, legVolume.minZ);
    const snappedHeightAtMaxX = evalZoneHeight(legResolution[mergedSide].neighborPlanes, legVolume.maxX, legVolume.minZ);
    assert.ok(Math.abs(snappedHeightAtMinX - expectedWallHeight) < 1e-9, `expected ${expectedWallHeight}, got ${snappedHeightAtMinX}`);
    assert.equal(snappedHeightAtMinX, snappedHeightAtMaxX, 'the merged edge should be level (the base\'s ridge runs parallel to this wall)');

    // If you followed this same plane back from the shed's own far eave,
    // through the wall, it must pass exactly through the base's actual
    // ridge point — that is the literal "shed ridge matches the gable ridge"
    // requirement, not merely "shed reaches the gable's ridge height".
    const plane = legResolution[mergedSide].neighborPlanes[0];
    const heightAtRidgePoint = evalZoneHeight([plane], legVolume.minX, baseRidgeZ);
    assert.ok(Math.abs(heightAtRidgePoint - baseRidgeHeight) < 1e-9, `extending the shed's merged plane back to the base's ridge Z should give the base's ridge height; got ${heightAtRidgePoint}`);
  });

  it('builds the exact reported scenario end-to-end with "Merge into adjacent roof" with no NaNs', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const legVolume = layout.volumes[1];

    const res = createBuildingFromFootprint(norm, {
      storyCount: 1,
      storyHeight: 3,
      roofType: 'gable',
      roofPitchRise: 6,
      roofPitchRun: 12,
      volumes: layout.volumes,
      volumeRoofTypes: { [legVolume.id]: 'shed' },
      volumeRidgeDirections: { [legVolume.id]: 'z-min' },
      volumeRoofConnections: { [legVolume.id]: 'merge-plane' },
    });

    assertNoNaNs(res.building);
  });
});

describe('createShedRoofGeometry with connections', () => {
  it('clamps the merged edge to the neighbor plane and suppresses its closure face', () => {
    const gablePlanes = computeVolumeEavePlanes(
      { minX: volumeA.minX, maxX: volumeA.maxX, minZ: volumeA.minZ, maxZ: volumeA.maxZ },
      'gable',
      { roofDirection: 'z', roofHeight: 5 }
    );
    const connections = { minZ: { mode: 'merged', neighborPlanes: gablePlanes, suppressClosure: true } };
    const bounds = { minX: volumeB.minX, maxX: volumeB.maxX, minZ: volumeB.minZ, maxZ: volumeB.maxZ };

    const unmerged = createShedRoofGeometry(bounds, {
      roofOverhang: 0, roofDirection: 'z', roofHighEdge: 'z-min', roofHeight: 5,
    });
    const merged = createShedRoofGeometry(bounds, {
      roofOverhang: 0, roofDirection: 'z', roofHighEdge: 'z-min', roofHeight: 5, connections,
    });

    assert.equal(unmerged.getAttribute('position').count, 8);
    assert.equal(unmerged.index.count, 18, 'unmerged shed keeps its full 4-side closed-prism closure');
    assert.equal(merged.index.count, 12, 'the merged high-edge side loses its vertical-return closure (6 indices)');

    const mergedPositions = merged.getAttribute('position');
    // Corners 0 and 1 are the two high-edge corners (minZ side) for a
    // z-min-high shed; both should be clamped down from 5 to the neighbor's
    // gable-end height (4) at their respective X positions.
    assert.ok(Math.abs(mergedPositions.getY(0) - 4) < 1e-9, `expected corner 0 clamped to 4, got ${mergedPositions.getY(0)}`);
    assert.ok(Math.abs(mergedPositions.getY(1) - 4) < 1e-9, `expected corner 1 clamped to 4, got ${mergedPositions.getY(1)}`);

    const unmergedPositions = unmerged.getAttribute('position');
    assert.equal(unmergedPositions.getY(0), 5, 'the unmerged shed keeps its full configured peak height');
    assert.equal(unmergedPositions.getY(1), 5);
  });

  it('renders a ridge-snap connection with its footprint physically extended to the neighbor\'s ridge, and no closure at that edge', () => {
    // Reuse resolveRoofConnections' own output end-to-end, exactly as
    // createVolumeRoofAssembly does: extend the shed's bounds on the merged
    // side to `extendTo`, use `height` as roofHeight, and let its closure be
    // suppressed there.
    const config = {
      roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
      volumeRoofTypes: { [volumeB.id]: 'shed' },
      volumeRoofConnections: { [volumeB.id]: 'merge-plane' },
    };
    // ridgeAxis 'x' (unlike the top-level volumeA, which is 'z' for the
    // coplanar gable-end test above) puts volumeA's EAVE — not its sloped
    // end — on the wall shared with volumeB, forcing the ridge-snap path.
    const gableEaveFacingVolumeA = { ...volumeA, ridgeAxis: 'x' };
    const resolutions = resolveRoofConnections([gableEaveFacingVolumeA, volumeB], config);
    const resolutionB = resolutions.get(volumeB.id);
    const mergedSide = Object.keys(resolutionB).find((side) => resolutionB[side]?.mode === 'merged');
    assert.ok(mergedSide, 'expected a ridge-snap resolution');
    const resolution = resolutionB[mergedSide];
    assert.equal(resolution.suppressClosure, true);

    const extendedBounds = {
      minX: volumeB.minX, maxX: volumeB.maxX, minZ: volumeB.minZ, maxZ: volumeB.maxZ, [mergedSide]: resolution.extendTo,
    };
    const geometry = createShedRoofGeometry(extendedBounds, {
      roofOverhang: 0, roofDirection: 'z', roofHighEdge: 'z-min', roofHeight: resolution.height,
      connections: { [mergedSide]: resolution },
    });

    const positions = geometry.getAttribute('position');
    assert.equal(geometry.index.count, 12, 'the extended (ridge) edge needs no closure, same as any other merged edge (18 - 6)');
    // Corners 0 and 1 are the high-edge corners; their Z must be the
    // extended ridge coordinate, not volumeB's own original minZ (0).
    assert.ok(Math.abs(positions.getZ(0) - resolution.extendTo) < 1e-9, 'the high edge must sit at the extended ridge Z, not the original wall');
    assert.ok(Math.abs(positions.getY(0) - resolution.height) < 1e-9);
  });

  it('overrides the merged edge height for the no-ridge-line fallback (e.g. shed-to-shed) but keeps its closure face, since there is no ridge coordinate to extend the footprint to', () => {
    const bounds = { minX: volumeB.minX, maxX: volumeB.maxX, minZ: volumeB.minZ, maxZ: volumeB.maxZ };
    const connections = {
      minZ: {
        mode: 'merged', override: true, suppressClosure: false, neighborPlanes: [{ constantHeight: 2.5 }],
      },
    };
    const geometry = createShedRoofGeometry(bounds, {
      roofOverhang: 0, roofDirection: 'z', roofHighEdge: 'z-min', roofHeight: 5, connections,
    });
    const positions = geometry.getAttribute('position');
    assert.equal(positions.getY(0), 2.5, 'the high-edge corner should be overridden to the ridge-snap target, not the configured 5');
    assert.equal(positions.getY(1), 2.5);
    assert.equal(geometry.index.count, 18, 'a ridge-snap connection keeps its full closure (the vertical rise needs a real face), unlike a coplanar merge');
  });

  it('leaves a standalone shed (no connections) byte-identical to today\'s output', () => {
    const bounds = { minX: 0, maxX: 10, minZ: 0, maxZ: 8 };
    const geometry = createShedRoofGeometry(bounds, {
      roofOverhang: 0, roofDirection: 'z', roofHighEdge: 'z-min', roofHeight: 2.5,
    });
    assert.equal(geometry.getAttribute('position').count, 8, 'always 4 top + 4 base vertices');
    assert.equal(geometry.index.count, 18, 'always 2 top triangles + 3 closure faces (one quad, two triangles)');
  });
});

describe('End-to-end regression: multi-volume buildings with a shed volume still build cleanly', () => {
  it('builds the reported U-shape (shed leg + gable spanning volume) with no NaNs', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const legVolume = layout.volumes[1];

    const res = createBuildingFromFootprint(norm, {
      storyCount: 1,
      storyHeight: 3,
      roofType: 'gable',
      roofPitchRise: 6,
      roofPitchRun: 12,
      volumes: layout.volumes,
      volumeRoofTypes: { [legVolume.id]: 'shed' },
    });

    assertNoNaNs(res.building);
  });

  it('builds the U-shape with a shed leg + hip spanning volume with no NaNs', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'hip' });
    const legVolume = layout.volumes[1];

    const res = createBuildingFromFootprint(norm, {
      storyCount: 1,
      storyHeight: 3,
      roofType: 'hip',
      roofPitchRise: 6,
      roofPitchRun: 12,
      volumes: layout.volumes,
      volumeRoofTypes: { [legVolume.id]: 'shed' },
    });

    assertNoNaNs(res.building);
  });
});

describe('Merge with independent story counts (multi-volume path)', () => {
  function buildWithStories(overrides) {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const leg = layout.volumes[2];
    const res = createBuildingFromFootprint(norm, {
      storyCount: 1,
      storyHeight: 3,
      roofEaveDepth: 0,
      roofType: 'gable',
      roofPitchRise: 6,
      roofPitchRun: 12,
      volumes: layout.volumes,
      volumeStoryOverrides: overrides(layout.volumes),
      volumeRoofTypes: { [leg.id]: 'shed' },
      volumeRidgeDirections: { [leg.id]: 'z-min' },
      volumeRoofConnections: { [leg.id]: 'merge-plane' },
    });
    let shed = null;
    res.building.traverse((child) => {
      if (child.isMesh && child.userData?.volumeId === leg.id && child.userData?.roofType === 'shed') {
        shed = child;
      }
    });
    return { res, shed };
  }

  it('does not merge across differing plate heights, and renders the shed flat-shaded', () => {
    const { res, shed } = buildWithStories((volumes) => ({ [volumes[0].id]: 3 }));
    assertNoNaNs(res.building);
    assert.ok(shed);
    assert.equal(shed.geometry.index, null, 'roof faces must be unrolled so normals are per-face, not smoothed across the closure faces');
    assert.equal(shed.geometry.getAttribute('position').count, 18, 'standalone closed shed: 6 top + 12 closure vertices');
  });

  it('restores the merge when the shed volume matches the gable volume\'s story count', () => {
    const { res, shed } = buildWithStories((volumes) => ({ [volumes[0].id]: 3, [volumes[2].id]: 3 }));
    assertNoNaNs(res.building);
    assert.equal(shed.geometry.getAttribute('position').count, 12, 'merged shed drops the closure at its extended high edge');
  });

  it('resolveRoofConnections skips pairs whose plate heights differ', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const leg = directVolume(layout.volumes[2], 'z-min');
    const volumes = [layout.volumes[0], layout.volumes[1], leg];
    const config = {
      roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
      volumeRoofTypes: { [leg.id]: 'shed' },
      volumeRoofConnections: { [leg.id]: 'merge-plane' },
    };
    const differing = resolveRoofConnections(volumes, { ...config, volumePlateHeights: { 'volume-0': 9, 'volume-1': 3, 'volume-2': 3 } });
    assert.equal(Object.keys(differing.get(leg.id)).length, 0);
    const matching = resolveRoofConnections(volumes, { ...config, volumePlateHeights: { 'volume-0': 9, 'volume-1': 3, 'volume-2': 9 } });
    assert.ok(Object.keys(matching.get(leg.id)).length > 0);
  });
});

describe('Per-volume roof shape (pitch / rise overrides)', () => {
  const norm = normalizeFootprint(uFootprint);
  const layout = computeFacadeLayout(norm, { roofType: 'gable' });
  const baseConfig = {
    storyCount: 1, storyHeight: 3, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
  };

  function roofMaxY(config) {
    const { building } = createBuildingFromFootprint(norm, { ...baseConfig, ...config });
    let max = -Infinity;
    building.traverse((child) => {
      if (child.isMesh && child.userData?.roofType) {
        const pos = child.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i += 1) {
          max = Math.max(max, pos.getY(i));
        }
      }
    });
    return max;
  }

  it('one volume\'s pitch override changes only that volume (assembly path)', () => {
    const uniform = roofMaxY({});
    const steep = roofMaxY({ volumeRoofShapes: { 'volume-2': { mode: 'slope', pitchRise: 12 } } });
    assert.ok(steep > uniform + 0.5, `steep leg should raise the overall roof (${uniform} -> ${steep})`);
    // Overriding the base to a shallower pitch must not touch the legs' own heights.
    const legsOnly = roofMaxY({ volumeRoofShapes: { 'volume-0': { mode: 'slope', pitchRise: 1 } } });
    assert.ok(Math.abs(legsOnly - 3 * 0.5) < 1e-6, `legs keep the building pitch (expected 1.5, got ${legsOnly})`);
  });

  it('one volume\'s rise override changes only that volume (multi-volume path)', () => {
    const { building } = createBuildingFromFootprint(norm, {
      ...baseConfig,
      volumeStoryOverrides: { 'volume-0': 3 },
      volumeRoofShapes: { 'volume-2': { mode: 'height', height: 2.75 } },
    });
    const heights = {};
    building.traverse((child) => {
      if (child.isMesh && child.userData?.roofType) {
        heights[child.userData.volumeId] = child.userData.roofHeight;
      }
    });
    assert.equal(heights['volume-2'], 2.75);
    assert.ok(Math.abs(heights['volume-0'] - 2) < 1e-9);
    assert.ok(Math.abs(heights['volume-1'] - 1.5) < 1e-9);
  });
});

describe('Merge: shed slope below the ridge intersects the gable plane', () => {
  const norm = normalizeFootprint(uFootprint);
  const layout = computeFacadeLayout(norm, { roofType: 'gable' });
  const base = layout.volumes[0];
  const leg = directVolume(layout.volumes[2], 'z-min');
  const volumes = [base, layout.volumes[1], leg];
  const config = (shape) => ({
    roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
    volumeRoofTypes: { [leg.id]: 'shed' },
    volumeRoofConnections: { [leg.id]: 'merge-plane' },
    volumeRoofShapes: shape ? { [leg.id]: shape } : undefined,
  });
  const resolve = (shape) => {
    const res = resolveRoofConnections(volumes, config(shape)).get(leg.id);
    return res[Object.keys(res)[0]];
  };

  it('a shallow shed keeps its own slope and ends where it crosses the gable plane', () => {
    const resolution = resolve({ mode: 'slope', pitchRise: 2 });
    assert.equal(resolution.intersectsPlane, true);
    const ridgeZ = (base.minZ + base.maxZ) / 2;
    assert.ok(resolution.extendTo < leg.minZ && resolution.extendTo > ridgeZ, 'boundary lands between the wall and the ridge');
    const baseSlope = ((base.maxZ - base.minZ) / 2 * 0.5) / ((base.maxZ - base.minZ) / 2);
    const gableHeightThere = baseSlope * (leg.minZ - resolution.extendTo);
    assert.ok(Math.abs(resolution.height - gableHeightThere) < 1e-9, 'shed and gable surfaces are at the same height at the join');
    assert.ok(resolution.height < 2, 'the join is below the ridge');
    const ownSlope = (((leg.maxZ - leg.minZ) / 2) * (2 / 12)) / (leg.maxZ - leg.minZ);
    assert.ok(Math.abs(resolution.height - ownSlope * (leg.maxZ - resolution.extendTo)) < 1e-9, 'the shed keeps its own configured slope');
  });

  it('a steep shed that would project above the ridge still snaps to the ridge', () => {
    const resolution = resolve(null);
    assert.equal(resolution.intersectsPlane, undefined);
    assert.ok(Math.abs(resolution.extendTo - (base.minZ + base.maxZ) / 2) < 1e-9);
    assert.ok(Math.abs(resolution.height - 2) < 1e-9);
  });

  it('lowering the shed further moves the join lower, not back to the ridge', () => {
    const a = resolve({ mode: 'slope', pitchRise: 2 });
    const b = resolve({ mode: 'slope', pitchRise: 1 });
    assert.ok(b.height < a.height && a.height < 2);
  });
});

describe('Gable-to-gable merge (cross gable) is opt-in', () => {
  const norm = normalizeFootprint(uFootprint);
  const layout = computeFacadeLayout(norm, { roofType: 'gable' });
  const [base, leg] = layout.volumes;
  const volumes = [base, leg, layout.volumes[2]];
  const config = (extra = {}) => ({
    roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope', volumeRoofConnections: extra.connect ? { [leg.id]: 'merge-plane' } : undefined,
    volumeRoofShapes: extra.shape ? { [leg.id]: extra.shape } : undefined,
  });

  it('stays standalone unless the volume opts in', () => {
    const res = resolveRoofConnections(volumes, config());
    assert.equal(Object.keys(res.get(leg.id)).length, 0);
    const { building } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: 3, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
    });
    assertNoNaNs(building);
  });

  it('a lower leg ridge intersects the base plane below the base ridge and keeps its own height', () => {
    const res = resolveRoofConnections(volumes, config({ connect: true, shape: { mode: 'slope', pitchRise: 4 } })).get(leg.id);
    const merged = res[Object.keys(res)[0]];
    assert.equal(merged.kind, 'intersect');
    const baseRidgeHeight = ((base.maxZ - base.minZ) / 2) * (6 / 12);
    const legRidge = ((leg.maxX - leg.minX) / 2) * (4 / 12);
    assert.ok(Math.abs(merged.height - legRidge) < 1e-9 && merged.height < baseRidgeHeight);
    // ridge end sits where the base plane reaches the leg's ridge height
    const wall = leg.minZ;
    const baseSlope = baseRidgeHeight / ((base.maxZ - base.minZ) / 2);
    assert.ok(Math.abs((wall - merged.along) * baseSlope - legRidge) < 1e-9);
  });

  it('a taller leg ridge snaps up to the base ridge', () => {
    const res = resolveRoofConnections(volumes, config({ connect: true, shape: { mode: 'slope', pitchRise: 12 } })).get(leg.id);
    const merged = res[Object.keys(res)[0]];
    assert.equal(merged.kind, 'snap');
    assert.ok(Math.abs(merged.height - 2) < 1e-9);
    assert.ok(Math.abs(merged.along - (base.minZ + base.maxZ) / 2) < 1e-9);
  });

  it('changing the leg\'s height changes where it joins', () => {
    const a = resolveRoofConnections(volumes, config({ connect: true, shape: { mode: 'slope', pitchRise: 3 } })).get(leg.id);
    const b = resolveRoofConnections(volumes, config({ connect: true, shape: { mode: 'slope', pitchRise: 5 } })).get(leg.id);
    assert.ok(a[Object.keys(a)[0]].along > b[Object.keys(b)[0]].along - 1e-9 || a[Object.keys(a)[0]].along !== b[Object.keys(b)[0]].along);
  });
});

describe('Merged gable roof faces stay coplanar', () => {
  const norm = normalizeFootprint(uFootprint);
  const layout = computeFacadeLayout(norm, { roofType: 'gable' });
  const uniqueNormals = (pitchRise) => {
    const { building } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: 3, roofEaveDepth: 0, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
      volumeStoryOverrides: { 'volume-0': 3, 'volume-1': 3 },
      volumeRoofConnections: { 'volume-1': 'merge-plane' },
      volumeRoofShapes: { 'volume-1': { mode: 'slope', pitchRise } },
    });
    let mesh;
    building.traverse((c) => { if (c.isMesh && c.userData?.volumeId === 'volume-1' && c.userData?.roofType) { mesh = c; } });
    const pos = mesh.geometry.getAttribute('position');
    const normals = new Set();
    for (let i = 0; i < pos.count; i += 3) {
      const a = [0, 1, 2].map((k) => [pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)]);
      const u = a[1].map((v, k) => v - a[0][k]);
      const w = a[2].map((v, k) => v - a[0][k]);
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      const len = Math.hypot(...n);
      const unit = n.map((v) => v / len);
      if (unit[1] < 0) { unit.forEach((v, k) => { unit[k] = -v; }); }
      normals.add(unit.map((v) => v.toFixed(4)).join(','));
    }
    return {
      total: normals.size,
      sloped: [...normals].filter((n) => Math.abs(Number(n.split(',')[1])) > 0.1).length,
    };
  };

  it('a lower leg intersecting the base plane has exactly two sloped planes plus the far gable end', () => {
    assert.deepEqual(uniqueNormals(4), { total: 3, sloped: 2 });
  });

  it('a taller leg snapped to the base ridge still has exactly two sloped planes plus the far gable end', () => {
    assert.deepEqual(uniqueNormals(12), { total: 3, sloped: 2 });
  });
});

describe('Merge across different story counts (roof above the taller neighbor\'s eave)', () => {
  const norm = normalizeFootprint(uFootprint);
  const layout = computeFacadeLayout(norm, { roofType: 'gable' });
  const [base, leftLeg, rightLeg] = layout.volumes;
  const STORY = 3.2;
  const gapM = STORY; // 3-story base vs 2-story legs
  const volumes = [
    base,
    directVolume(leftLeg, 'x-min'),
    directVolume(rightLeg, 'x-min'),
  ];
  const shapes = {
    'volume-1': { mode: 'height', height: 4.907 },
    'volume-2': { mode: 'height', height: 3.93 },
  };
  const config = {
    roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
    volumeRoofTypes: { 'volume-2': 'shed' },
    volumeRoofShapes: shapes,
    volumeRoofConnections: { 'volume-1': 'merge-plane', 'volume-2': 'merge-plane' },
    volumePlateHeights: { 'volume-0': 3 * STORY, 'volume-1': 2 * STORY, 'volume-2': 2 * STORY },
  };
  const res = resolveRoofConnections(volumes, config);

  it('the gable leg above the base eave intersects the base plane (own height kept)', () => {
    const merged = Object.values(res.get('volume-1')).find((r) => r.gableEnd);
    assert.ok(merged, 'the 2-story gable rises above the 3-story eave, so it merges');
    assert.equal(merged.kind, 'intersect');
    assert.ok(Math.abs(merged.height - 4.907) < 1e-9);
    const baseSlope = 0.5;
    // ridge end reaches the base plane, measured from the base eave which sits `gap` above this plate
    assert.ok(Math.abs((leftLeg.minZ - merged.along) * baseSlope + gapM - merged.height) < 1e-9);
  });

  it('the side-sloping shed keeps its plane and adds a triangle to the valley', () => {
    const merged = Object.values(res.get('volume-2')).find((r) => r.rakeTriangle);
    assert.ok(merged, 'expected a rake merge for the shed whose slope runs along the shared wall');
    const [p1, p2, p3] = merged.rakeTriangle;
    assert.ok(Math.abs(p1[1] - gapM) < 1e-9, 'starts at the base eave height');
    assert.ok(Math.abs(p2[1] - 3.93) < 1e-9 && Math.abs(p3[1] - 3.93) < 1e-9, 'own plane peak, unchanged');
    // P3 lies on the base's roof plane: eave gap + slope * distance from the wall
    assert.ok(Math.abs(gapM + 0.5 * Math.abs(p3[2] - rightLeg.minZ) - 3.93) < 1e-9);
  });

  it('a roof that stays below the taller neighbor\'s eave stays standalone', () => {
    const low = resolveRoofConnections(volumes, {
      ...config, volumeRoofShapes: { 'volume-1': { mode: 'height', height: 2 }, 'volume-2': { mode: 'height', height: 2 } },
    });
    assert.equal(Object.keys(low.get('volume-1')).length, 0);
    assert.equal(Object.keys(low.get('volume-2')).length, 0);
  });

  it('builds end to end without NaNs', () => {
    const { building } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: STORY, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
      volumeStoryOverrides: { 'volume-0': 3, 'volume-1': 2, 'volume-2': 2 },
      volumeRoofTypes: { 'volume-2': 'shed' },
      volumeRidgeDirections: { 'volume-1': 'x-min', 'volume-2': 'x-min' },
      volumeRoofShapes: shapes,
      volumeRoofConnections: config.volumeRoofConnections,
    });
    assertNoNaNs(building);
  });
});

describe('Merge across different story counts, shed high edge z-min (facing the taller base)', () => {
  const norm = normalizeFootprint(uFootprint);
  const layout = computeFacadeLayout(norm, { roofType: 'gable' });
  const [base, , rightLeg] = layout.volumes;
  const STORY = 3.2;
  const leg = directVolume(rightLeg, 'z-min');
  const volumes = [base, layout.volumes[1], leg];
  const resolveFor = (height) => {
    const res = resolveRoofConnections(volumes, {
      roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofHeightMode: 'slope',
      volumeRoofTypes: { 'volume-2': 'shed' },
      volumeRoofShapes: { 'volume-2': { mode: 'height', height } },
      volumeRoofConnections: { 'volume-2': 'merge-plane' },
      volumePlateHeights: { 'volume-0': 3 * STORY, 'volume-1': 2 * STORY, 'volume-2': 2 * STORY },
    }).get('volume-2');
    return res[Object.keys(res)[0]];
  };

  it('stays standalone while the shed is below the base eave', () => {
    assert.equal(resolveFor(2.5), undefined);
  });

  it('crosses the base plane below the ridge when it only just clears the eave, keeping its slope', () => {
    const merged = resolveFor(3.4);
    assert.equal(merged.intersectsPlane, true);
    const ownSlope = 3.4 / (leg.maxZ - leg.minZ);
    // height measured on the shed plate: eave gap + base slope * run into the base == the shed plane there
    const run = leg.minZ - merged.extendTo;
    assert.ok(Math.abs(STORY + 0.5 * run - merged.height) < 1e-9);
    assert.ok(Math.abs(ownSlope * (leg.maxZ - merged.extendTo) - merged.height) < 1e-9);
    assert.ok(run < 4);
  });

  it('snaps to the base ridge (in the shed\'s own frame) when it would project above it', () => {
    const merged = resolveFor(3.93);
    assert.equal(merged.intersectsPlane, undefined);
    assert.ok(Math.abs(merged.extendTo - (base.minZ + base.maxZ) / 2) < 1e-9);
    assert.ok(Math.abs(merged.height - (STORY + 2)) < 1e-9);
  });
});

describe('Merged roofs are clipped where they would lie inside the taller neighbor\'s walls', () => {
  const norm = normalizeFootprint(uFootprint);
  const layout = computeFacadeLayout(norm, { roofType: 'gable' });
  const STORY = 3.2;

  it('nothing of a merged shed or gable lies past the shared wall below the neighbor eave', () => {
    const { building } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: STORY, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
      volumeStoryOverrides: { 'volume-0': 3, 'volume-1': 2, 'volume-2': 2 },
      volumeRoofTypes: { 'volume-2': 'shed' },
      volumeRidgeDirections: { 'volume-1': 'x-min', 'volume-2': 'z-min' },
      volumeRoofShapes: { 'volume-1': { mode: 'height', height: 4.907 }, 'volume-2': { mode: 'height', height: 3.93 } },
      volumeRoofConnections: { 'volume-1': 'merge-plane', 'volume-2': 'merge-plane' },
    });
    const wallZ = layout.volumes[2].minZ;
    let checked = 0;
    let extended = 0;
    building.traverse((child) => {
      if (child.isMesh && child.userData?.roofType && ['volume-1', 'volume-2'].includes(child.userData.volumeId)) {
        const pos = child.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i += 1) {
          checked += 1;
          if (pos.getZ(i) < wallZ - 1e-6) {
            extended += 1;
            assert.ok(pos.getY(i) >= STORY - 1e-6, `vertex at z=${pos.getZ(i)} y=${pos.getY(i)} is inside the base wall`);
          }
        }
      }
    });
    assert.ok(checked > 0 && extended > 0, 'expected merged roofs that extend past the wall');
  });
});
