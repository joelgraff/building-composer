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

  it('must reach the corner, stand wholly outside the walls, and take a hip roof', () => {
    const codes = (fields) => build([porch(fields)]).result.roofStructures.map((entry) => entry.errors.map((e) => e.code));
    assert.deepEqual(codes({ offset: 1 }), [['wrap-not-at-corner'], ['wrap-incomplete']]);
    assert.deepEqual(codes({ depth: 3 }), [['wrap-depth'], ['wrap-incomplete']]);
    assert.deepEqual(codes({ roofType: 'shed' }), [['wrap-roof'], ['wrap-roof']]);
    assert.deepEqual(codes({ setback: 0, depth: 2.4 }), [['wrap-not-porch']]);
  });

  it('keeps its wrap in the record', () => {
    assert.deepEqual(normalizeRoofStructure(porch()).wrap, { end: 'right', length: 4 });
    assert.equal(normalizeRoofStructure(porch({ wrap: { end: 'up', length: 4 } })).wrap, null);
    assert.equal(normalizeRoofStructure(porch({ wrap: { end: 'left', length: 0 } })).wrap, null);
  });
});
