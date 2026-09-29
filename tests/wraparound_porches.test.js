import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout, withStructureFacades } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures, normalizeRoofStructure } from '../js/roof-structures.js';
import { meshTriangles, uncoveredEdges } from './helpers/mesh.js';

// a 10 x 8 two-story house; the porch runs along its +Z front
const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const VOLUMES = computeFacadeLayout(RECT, {}).volumes;
const SLOPE = 4 / 12;
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message ?? ''} expected ${b}, got ${a}`);

// 6 m along the front with its right (+X) end at the corner, projecting 2.4 m
const porch = (fields = {}) => ({
  id: 'p', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', width: 6, offset: 2, setback: -2.4, depth: 2.4,
  baseHeight: 'ground', wallHeight: 2.8, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'],
  wrap: { end: 'right', length: 4 }, ...fields,
});

function build(structures) {
  const result = createBuildingFromFootprint(RECT, {
    storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
    roofEaveDepth: 0.35, volumes: VOLUMES, roofStructures: normalizeRoofStructures(structures),
  });
  return { result, layout: withStructureFacades(computeFacadeLayout(RECT, {}), result.structureFacades) };
}

const partOf = (result, id, part) => {
  const out = [];
  result.building.traverse((child) => {
    if (child.isMesh && child.userData?.structureId === id && child.userData.structurePart === part) {
      meshTriangles(child).forEach((tri) => out.push(tri));
    }
  });
  return out;
};

/** The highest roof surface of a structure over a plan point. */
function roofHeightAt(result, id, [x, z]) {
  let best = -Infinity;
  partOf(result, id, 'roof').forEach(([a, b, c]) => {
    const d = (b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2]);
    if (Math.abs(d) < 1e-12) return;
    const u = ((x - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (z - a[2])) / d;
    const v = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / d;
    if (u >= -1e-9 && v >= -1e-9 && u + v <= 1 + 1e-9) {
      best = Math.max(best, a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]));
    }
  });
  return best;
}

/** The whole building is one closed shell (roofs sit ROOF_LIFT above their walls). */
function assertClosed(result, label) {
  const tris = [];
  result.building.traverse((child) => {
    if (child.isMesh && !child.userData?.editorOnly) {
      meshTriangles(child).forEach((tri) => tris.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3));
  assert.deepEqual(uncoveredEdges(tris).filter((edge) => !lift(edge)), [], `${label}: see-through edges`);
}

describe('wraparound porches', () => {
  it('run on past the corner and back along the side wall, as two segments', () => {
    const [front, side] = build([porch()]).result.roofStructures;
    assert.deepEqual([front.id, side.id], ['p', 'p-wrap']);
    assert.deepEqual([front.errors, side.errors], [[], []]);
    assert.deepEqual(front.resolved.bounds, { minX: -1, maxX: 7.4, minZ: 4, maxZ: 6.4 }, 'past the corner by its projection');
    assert.deepEqual(side.resolved.bounds, { minX: 5, maxX: 7.4, minZ: 0, maxZ: 4 }, 'from the front wall line back 4 m');
    const [, left] = build([porch({ offset: -2, wrap: { end: 'left', length: 4 } })]).result.roofStructures;
    assert.deepEqual(left.resolved.bounds, { minX: -7.4, maxX: -5, minZ: 0, maxZ: 4 });
  });

  it('share one roof: level into the walls, hipped at the corner and the far ends, continuous across the seam', () => {
    const { result } = build([porch()]);
    const [front] = result.roofStructures;
    const plate = front.resolved.plateY;
    // against the front wall, 2.4 m in from the front eave line
    near(roofHeightAt(result, 'p', [2, 4.001]), plate + SLOPE * (2.4 - 0.001), 'level into the wall');
    // on the corner square's diagonal, both slopes give the same height (the hip)
    near(roofHeightAt(result, 'p', [6.2, 5.2]), plate + SLOPE * 1.2, 'the corner hip');
    // either side of the seam at the front wall line
    near(roofHeightAt(result, 'p', [6.8, 4.001]), roofHeightAt(result, 'p-wrap', [6.8, 3.999]), 'across the seam');
    near(roofHeightAt(result, 'p-wrap', [6.8, 2]), plate + SLOPE * 0.6, 'the side slope');
  });

  it('is one closed shell, with posts and railings along the outside only', () => {
    const { result, layout } = build([porch()]);
    const tris = [];
    result.building.traverse((child) => {
      if (child.isMesh && !child.userData?.editorOnly) {
        meshTriangles(child).forEach((tri) => tris.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
      }
    });
    const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3));
    assert.deepEqual(uncoveredEdges(tris).filter((edge) => !lift(edge)), []);
    assert.deepEqual(layout.railRuns.map((rail) => rail.id).sort(), [
      'rail-run-p-front', 'rail-run-p-left', 'rail-run-p-right', 'rail-run-p-wrap-front', 'rail-run-p-wrap-right',
    ]);
    // one post where the two outer runs meet, not two
    const postsNearSeam = [...partOf(result, 'p', 'posts'), ...partOf(result, 'p-wrap', 'posts')]
      .flat().filter(([x, , z]) => x > 7 && z > 3.5 && z < 4.5);
    const zs = [...new Set(postsNearSeam.map(([, , z]) => +z.toFixed(3)))];
    assert.ok(zs.every((z) => z >= 4 - 1e-6) || zs.every((z) => z <= 4 + 1e-6), `posts on one side of the seam: ${zs}`);
    assert.equal(layout.structureWallRuns.length, 0, 'open all round');
  });

  it('puts no posts along the seams, however deep the porch', () => {
    // 3.6 m deep: posts every 3 m or less would otherwise stand mid-seam
    const { result } = build([porch({ setback: -3.6, depth: 3.6 })]);
    const [front, side] = result.roofStructures.map((entry) => entry.resolved);
    const outerLines = [
      ([, z]) => Math.abs(z - front.bounds.maxZ) < 0.21, ([x]) => Math.abs(x - front.bounds.maxX) < 0.21,
      ([x]) => Math.abs(x - front.bounds.minX) < 0.21, ([, z]) => Math.abs(z - side.bounds.minZ) < 0.21,
    ];
    [...partOf(result, 'p', 'posts'), ...partOf(result, 'p-wrap', 'posts')].forEach((tri) => {
      const [cx, cz] = [0, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
      assert.ok(outerLines.some((onLine) => onLine([cx, cz])), `a post at (${cx.toFixed(2)}, ${cz.toFixed(2)}) is off the outer lines`);
    });
  });

  it('stands wholly outside the walls and takes a hip or shed roof', () => {
    const codes = (fields) => build([porch(fields)]).result.roofStructures.map((entry) => entry.errors.map((e) => e.code));
    assert.deepEqual(codes({ roofType: 'gable' }), [['wrap-roof'], ['wrap-roof']]);
    assert.deepEqual(codes({ setback: 0, depth: 2.4 }), [['wrap-not-porch']]);
  });

  it('keeps its walls and end legs in the record, converting the older one-corner form', () => {
    // the older form: the porch's width is its first leg, `length` its second
    assert.deepEqual(normalizeRoofStructure(porch()).wrap, { walls: ['maxZ', 'maxX'], startLength: 6, endLength: 4 });
    assert.deepEqual(normalizeRoofStructure(porch({ wrap: { end: 'left', length: 3 } })).wrap, { walls: ['maxZ', 'minX'], startLength: 6, endLength: 3 });
    assert.equal(normalizeRoofStructure(porch({ wrap: { end: 'up', length: 4 } })).wrap, null);
    assert.equal(normalizeRoofStructure(porch({ wrap: { end: 'left', length: 0 } })).wrap, null);
    const walls = (list) => normalizeRoofStructure(porch({ wrap: { walls: list, startLength: 3, endLength: 3 } })).wrap?.walls ?? null;
    assert.deepEqual(walls(['minX', 'maxZ', 'maxX']), ['minX', 'maxZ', 'maxX']);
    assert.equal(walls(['maxZ', 'minZ']), null, 'opposite walls do not meet');
    assert.equal(walls(['maxZ']), null, 'one wall is a porch, not a wraparound');
  });

  it('a shed wraparound turns the corner on a hip and has plain far ends', () => {
    const { result } = build([porch({ roofType: 'shed' })]);
    const [front, side] = result.roofStructures;
    assert.deepEqual([front.errors, side.errors], [[], []]);
    assert.deepEqual(front.resolved.eaveRoof.eaveSides.sort(), ['maxX', 'maxZ']);
    assert.deepEqual(side.resolved.eaveRoof.eaveSides, ['maxX']);
    const plate = front.resolved.plateY;
    // near the far end the front slope carries straight on (no hip there)
    near(roofHeightAt(result, 'p', [-0.9, 5.2]), plate + SLOPE * 1.2, 'no hip at the far end');
    near(roofHeightAt(result, 'p', [6.2, 5.2]), plate + SLOPE * 1.2, 'the corner hip');
    const tris = [];
    result.building.traverse((child) => {
      if (child.isMesh && !child.userData?.editorOnly) {
        meshTriangles(child).forEach((tri) => tris.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
      }
    });
    const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3));
    // the open far ends (x = -1 and z = 0) are openings under their plain end faces
    // (within the porch: out over the eave, the eave's end must be capped)
    const opening = (edge) => edge.every(([x, , z]) => (Math.abs(x + 1) < 1e-3 && z <= 6.4 + 1e-3) || (Math.abs(z) < 1e-3 && x <= 7.4 + 1e-3));
    assert.deepEqual(uncoveredEdges(tris).filter((edge) => !lift(edge) && !opening(edge)), []);
  });

  it('runs level into a wall its end stands against, instead of draining a hip toward the house', () => {
    // a main block (x -5..5, z -4..4) with a projection on its +X side (z -3..1): the side segment runs back to it
    const footprint = [[-5, -4], [5, -4], [5, -3], [7.4, -3], [7.4, 1], [5, 1], [5, 4], [-5, 4]];
    const volumes = computeFacadeLayout(footprint, { volumeSplit: 'auto' }).volumes;
    const main = volumes.find((volume) => volume.maxZ - volume.minZ > 7);
    const result = createBuildingFromFootprint(footprint, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofPitchRise: 8, roofPitchRun: 12, roofEaveDepth: 0.35, volumes,
      roofStructures: normalizeRoofStructures([porch({ hostVolumeId: main.id, wrap: { end: 'right', length: 3 } })]),
    });
    const [front, side] = result.roofStructures;
    assert.deepEqual([front.errors, side.errors], [[], []]);
    assert.deepEqual(side.resolved.bounds, { minX: 5, maxX: 7.4, minZ: 1, maxZ: 4 });
    assert.ok(!side.resolved.eaveRoof.eaveSides.includes('minZ'), 'no eave against the projection');
    // beside the projection's wall the roof is at the outer eave's slope, not dropping toward the wall
    near(roofHeightAt(result, 'p-wrap', [6.8, 1.05]), side.resolved.plateY + SLOPE * 0.6);
  });

  it('a hip porch in the inside corner of an L runs level into the wing', () => {
    const L = [[-5, -4], [5, -4], [5, 4], [1, 4], [1, 8], [-5, 8]];
    const volumes = computeFacadeLayout(L, { volumeSplit: 'auto' }).volumes;
    const main = volumes.find((volume) => volume.maxX - volume.minX > 9);
    // on the main block's +Z wall, from the wing (x = 1) to the corner (x = 5)
    const result = createBuildingFromFootprint(L, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofPitchRise: 8, roofPitchRun: 12, roofEaveDepth: 0.35, volumes,
      roofStructures: normalizeRoofStructures([porch({ hostVolumeId: main.id, wrap: null, width: 4, offset: 3 })]),
    });
    const [entry] = result.roofStructures;
    assert.deepEqual(entry.errors, []);
    assert.deepEqual(entry.resolved.eaveRoof.eaveSides.sort(), ['maxX', 'maxZ'], 'no hip against the wing at x = 1');
  });

  it('turns two corners: legs on three walls, both end legs adjustable', () => {
    const { result } = build([porch({ wrap: { walls: ['minX', 'maxZ', 'maxX'], startLength: 3, endLength: 5 } })]);
    const [a, b, c] = result.roofStructures;
    assert.deepEqual([a.id, b.id, c.id], ['p', 'p-wrap', 'p-wrap-2']);
    assert.deepEqual([a.errors, b.errors, c.errors], [[], [], []]);
    assert.deepEqual(a.resolved.bounds, { minX: -7.4, maxX: -5, minZ: 1, maxZ: 6.4 }, 'the first leg: 3 m back from its corner, and past it');
    assert.deepEqual(b.resolved.bounds, { minX: -5, maxX: 7.4, minZ: 4, maxZ: 6.4 }, 'the middle leg: the whole wall, and past its far corner');
    assert.deepEqual(c.resolved.bounds, { minX: 5, maxX: 7.4, minZ: -1, maxZ: 4 }, 'the last leg: 5 m on from its corner');
    // one roof, continuous across both seams
    const plate = a.resolved.plateY;
    near(roofHeightAt(result, 'p', [-5.2, 6.399 - 1e-3]), roofHeightAt(result, 'p-wrap', [-4.999, 6.399 - 1e-3]), 'across the first seam');
    near(roofHeightAt(result, 'p-wrap', [6.8, 4.001]), roofHeightAt(result, 'p-wrap-2', [6.8, 3.999]), 'across the second seam');
    near(roofHeightAt(result, 'p-wrap-2', [6.8, 1]), plate + SLOPE * 0.6, 'the last leg\'s slope');
    assertClosed(result, 'three walls');
  });

  it('runs all the way round on four walls, with no ends', () => {
    const { result } = build([porch({ wrap: { walls: ['maxZ', 'maxX', 'minZ', 'minX'], startLength: 3, endLength: 3 } })]);
    assert.equal(result.roofStructures.length, 4);
    result.roofStructures.forEach((entry) => assert.deepEqual(entry.errors, [], entry.id));
    const along = result.roofStructures.map((entry) => entry.resolved.bounds);
    // every wall's leg runs its whole wall, and on past one corner
    assert.deepEqual(along[0], { minX: -5, maxX: 7.4, minZ: 4, maxZ: 6.4 });
    assert.deepEqual(along[2], { minX: -7.4, maxX: 5, minZ: -6.4, maxZ: -4 });
    near(roofHeightAt(result, 'p-wrap', [6.8, 3.999]), roofHeightAt(result, 'p', [6.8, 4.001]), 'across a seam');
    near(roofHeightAt(result, 'p-wrap-3', [-5.001, 5]), roofHeightAt(result, 'p', [-4.999, 5]), 'closing the loop');
    assertClosed(result, 'all the way round');
  });
});
