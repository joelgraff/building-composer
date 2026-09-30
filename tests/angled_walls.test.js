import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { computeFacadeLayout, decomposeIntoVolumes, angledWallProblem } from '../js/facade.js';
import { createBuildingFromFootprint, setStraightSkeletonBuilder } from '../js/extrusion.js';
import { roofProfile, volumeSolid, isInsideSolid } from '../js/roof-structures.js';
import { meshTriangles, uncoveredEdges } from './helpers/mesh.js';

// the browser build of the skeleton library, as index.html loads it
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
const { SkeletonBuilder } = createRequire(import.meta.url)('../node_modules/straight-skeleton/dist/index.js');

const SHAPES = {
  // a clipped corner, a wedge-shaped lot, an angled end, a parallelogram
  chamfer: [[-6, -5], [6, -5], [6, 3], [4, 5], [-6, 5]],
  wedge: [[-6, -5], [6, -4], [6, 5], [-6, 5]],
  trapezoid: [[-6, -5], [6, -5], [4, 5], [-6, 5]],
  parallelogram: [[-6, -5], [6, -5], [8, 5], [-4, 5]],
  // an L with its outer corner clipped, one with its inner corner clipped, and a block with a faceted apse
  outerL: [[0, 0], [10, 0], [10, 6], [8, 8], [6, 8], [6, 14], [0, 14]],
  innerL: [[0, 0], [10, 0], [10, 4], [6, 8], [6, 14], [0, 14]],
  apse: [[-6, -5], [6, -5], [6, -2], [8, -1], [9, 0], [8, 1], [6, 2], [6, 5], [-6, 5]],
};
const ROOFS = ['flat', 'gable', 'hip', 'shed', 'gambrel', 'mansard'];

function build(footprint, config = {}) {
  const volumes = computeFacadeLayout(footprint, { volumeSplit: 'auto' }).volumes;
  return createBuildingFromFootprint(footprint, {
    storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofPitchRise: 8, roofPitchRun: 12, roofHeight: 3, roofEaveDepth: 0.35,
    roofDirection: 'x', volumes, roofStructures: [], ...config,
  });
}

/** Edges only one triangle uses, less those in the gap roofs are lifted by above their walls. */
function openEdges(result) {
  const tris = [];
  result.building.traverse((child) => {
    if (child.isMesh && !child.userData?.editorOnly) {
      meshTriangles(child).forEach((tri) => tris.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3
    || (p[1] > zone.wallTopY - 1e-3 && p[1] < zone.baseY + 1e-3)));
  return uncoveredEdges(tris).filter((edge) => !lift(edge));
}

describe('volumes of a footprint with angled walls', () => {
  it('are its rectangles squared out, cut back by the angled walls', () => {
    const [volume] = decomposeIntoVolumes(SHAPES.chamfer, { split: 'auto' });
    assert.deepEqual([volume.minX, volume.maxX, volume.minZ, volume.maxZ], [-6, 6, -5, 5]);
    assert.equal(volume.cuts.length, 1);
    assert.equal(volume.outline.length, 5, 'the rectangle less the clipped corner');
    const parallelogram = decomposeIntoVolumes(SHAPES.parallelogram, { split: 'auto' });
    assert.equal(parallelogram.length, 1, 'a parallelogram squares out to one rectangle');
    assert.equal(parallelogram[0].cuts.length, 2);
  });

  it('an apse of several facets is one cut, on its own volume', () => {
    const volumes = decomposeIntoVolumes(SHAPES.apse, { split: 'auto' });
    assert.equal(volumes.length, 2);
    const apse = volumes.find((volume) => volume.cuts);
    assert.deepEqual([apse.minX, apse.maxX, apse.minZ, apse.maxZ], [6, 9, -2, 2]);
    assert.equal(apse.cuts.length, 4);
  });

  it('refuses, saying why, an angled wall whose corner reaches past another part of the building', () => {
    const u = [[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10], [0, 6], [2, 2]];
    assert.match(angledWallProblem(u), /reaches past another part/);
    assert.equal(angledWallProblem(SHAPES.innerL), null);
  });

  it('a long block with a shallow projection along its front stays whole', () => {
    // Dixon 1013603036: 18.8 x 9.9 m with a 2.5 m deep projection, its corners clipped
    const house = [[3.514, -6.664], [3.959, -4.14], [9.637, -4.14], [9.637, 5.713], [-9.174, 5.713], [-9.174, -2.853], [-6.253, -6.664]];
    const volumes = decomposeIntoVolumes(house, { split: 'auto' });
    assert.ok(volumes.some((volume) => volume.minX === -9.174 && volume.maxX === 9.637), 'the block runs the full length');
  });

  it('angled wall runs belong to the volume they cut, with the role its roof gives them', () => {
    const run = (footprint, config) => computeFacadeLayout(footprint, { volumeSplit: 'auto', ...config }).wallRuns.filter((r) => r.orientation === 'diagonal');
    assert.deepEqual(run(SHAPES.chamfer, { roofType: 'gable', roofDirection: 'x' }).map((r) => r.role), ['eave'], 'a clipped corner is an eave');
    assert.deepEqual(run(SHAPES.trapezoid, { roofType: 'gable', roofDirection: 'x' }).map((r) => r.role), ['rake'], 'an angled end is a gable end');
    const apseRuns = run(SHAPES.apse, { roofType: 'hip' });
    assert.ok(apseRuns.every((r) => r.volumeId === 'volume-1' && r.role === 'eave'));
  });
});

describe('roofs over angled walls', () => {
  before(async () => {
    await SkeletonBuilder.init();
    setStraightSkeletonBuilder(SkeletonBuilder);
  });

  it('close up over every shape, with every roof type', () => {
    Object.entries(SHAPES).forEach(([name, footprint]) => ROOFS.forEach((roofType) => {
      const roofDirection = roofType === 'shed' ? 'x-min' : 'x';
      assert.deepEqual(openEdges(build(footprint, { roofType, roofDirection })), [], `${name} ${roofType}`);
    }));
  });

  it('close up where a volume has its own height or floor', () => {
    ['outerL', 'innerL', 'apse'].forEach((name) => {
      const volumes = computeFacadeLayout(SHAPES[name], { volumeSplit: 'auto' }).volumes;
      const last = volumes[volumes.length - 1].id;
      [{ volumeStoryOverrides: { [last]: 1 } }, { volumeFoundationHeights: { [last]: 0 } }].forEach((levels) => {
        assert.deepEqual(openEdges(build(SHAPES[name], { roofType: 'gable', ...levels })), [], `${name} ${JSON.stringify(levels)}`);
      });
    });
  });

  it('a clipped corner on a gable gets its own facet, rising from a level eave', () => {
    const result = build(SHAPES.chamfer, { roofType: 'gable' });
    const [zone] = result.roofZones;
    assert.equal(zone.planes.length, 3, 'two slopes and the facet');
    const facet = zone.planes.find((plane) => plane.dir);
    // level along the angled wall, at the plate
    [[6, 3], [5, 4], [4, 5]].forEach(([x, z]) => assert.ok(Math.abs(facet.slope * (facet.dir[0] * x + facet.dir[1] * z - facet.constant)) < 1e-9));
    assert.deepEqual(zone.outline, computeFacadeLayout(SHAPES.chamfer, { volumeSplit: 'auto' }).volumes[0].outline);
  });

  it('an angled end on a gable is a skewed gable: the slopes run on to the wall, which rises to meet them', () => {
    const result = build(SHAPES.trapezoid, { roofType: 'gable' });
    assert.equal(result.roofZones[0].planes.length, 2);
    // the ridge runs level to the angled end wall (x = 5 at the ridge line z = 0)
    const ridge = roofProfile(result.roofZones[0].planes, [4, 0], [5, 0]);
    assert.ok(Math.abs(ridge[0][1] - ridge[ridge.length - 1][1]) < 1e-9);
  });

  it('a hip slopes up from every wall, angled or not, as one skeleton over an L', () => {
    const result = build(SHAPES.outerL, { roofType: 'hip' });
    assert.ok(result.roofZones.every((zone) => zone.skeleton), 'the continuous hip');
    const cut = result.roofZones.find((zone) => zone.outline);
    assert.ok(cut.planes.some((plane) => plane.dir), 'the clipped corner\'s face');
  });

  it('the outside stretch of a wall shared in part with a neighbor keeps its eave', () => {
    // the L's main block meets the wing along z = 8 from x = 0 to 6; from 6 to 8 the wall is outside
    const result = build(SHAPES.outerL, { roofType: 'gable' });
    let eave = 0;
    result.building.traverse((child) => {
      if (child.isMesh) {
        meshTriangles(child).forEach((tri) => {
          const [x, z] = [tri.reduce((sum, p) => sum + p[0], 0) / 3, tri.reduce((sum, p) => sum + p[2], 0) / 3];
          eave += x > 6.05 && x < 7.95 && z > 8.01 && z < 8.5 ? 1 : 0;
        });
      }
    });
    assert.ok(eave > 0, 'roof, fascia, and soffit over the stretch');
  });

  it('the space under a cut roof stops at the angled wall', () => {
    const result = build(SHAPES.chamfer, { roofType: 'gable' });
    const solid = volumeSolid(result.roofZones[0]);
    const y = result.roofZones[0].baseY - 1;
    assert.ok(isInsideSolid([5.4, y, 3.4], solid), 'inside, by the clipped corner');
    assert.ok(!isInsideSolid([5.8, y, 4.8], solid), 'the corner that is cut away');
  });
});

describe('roof profiles', () => {
  it('keep a bend where several pairs of planes cross at one point', () => {
    // a gambrel over a clipped corner: its lower slopes and its upper slopes
    // each meet the corner's facets on one line, so two pairs of planes
    // cross at the ridge (within rounding) along the gable end
    const dir = [-Math.SQRT1_2, -Math.SQRT1_2];
    const planes = [
      { axis: 'x', sign: 1, constant: -6, slope: 5 / 3, tier: 'lower' }, { axis: 'x', sign: -1, constant: 6, slope: 5 / 3, tier: 'lower' },
      { dir, constant: -9 * Math.SQRT1_2, slope: 5 / 3, tier: 'lower' },
      { axis: 'x', sign: 1, constant: -6, slope: 0.5, offset: 1.68, tier: 'upper' }, { axis: 'x', sign: -1, constant: 6, slope: 0.5, offset: 1.68, tier: 'upper' },
      { dir, constant: -9 * Math.SQRT1_2, slope: 0.5, offset: 1.68, tier: 'upper' },
    ];
    const [a, b] = [[4.145, 5.35], [-6.35, 5.35]];
    const profile = roofProfile(planes, a, b);
    const peak = Math.max(...profile.map(([, height]) => height));
    // the highest point along the gable end: where the upper slope and upper facet meet
    const top = (t) => Math.min(...planes.map((plane) => {
      const [x, z] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      return plane.dir ? (plane.offset ?? 0) + plane.slope * (plane.dir[0] * x + plane.dir[1] * z - plane.constant)
        : (plane.offset ?? 0) + plane.slope * plane.sign * (x - plane.constant);
    }));
    const sampled = Math.max(...Array.from({ length: 2001 }, (_, k) => top(k / 2000)));
    assert.ok(peak >= sampled - 1e-9 && peak - sampled < 0.01, `peak ${peak} vs ${sampled}`);
  });
});
