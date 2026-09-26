import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';
import { meshTriangles, openTriangleEdges } from './helpers/mesh.js';

const uFootprint = JSON.parse(readFileSync('./data/footprint_u.json', 'utf8'));
const RECT = [[-10, -5], [10, -5], [10, 5], [-10, 5]];
const RECT_VOLUMES = computeFacadeLayout(RECT, {}).volumes;
// gable host: ridge along x, 2.5 high over a 5 m half span (slope 0.5), plate at 0.6 + 3 + 0.02
const PLATE = 3.62;
const hostY = ([, , z]) => PLATE + 0.5 * (5 - Math.abs(z));

function build(structures, config = {}) {
  return createBuildingFromFootprint(RECT, {
    storyCount: 1,
    storyHeight: 3,
    foundationDepth: 0.6,
    roofType: 'gable',
    roofDirection: 'x',
    roofHeight: 2.5,
    roofPitchRise: 6,
    roofPitchRun: 12,
    roofEaveDepth: 0.3,
    roofRakeDepth: 0.2,
    volumes: RECT_VOLUMES,
    roofStructures: normalizeRoofStructures(structures),
    ...config,
  });
}

/** Absolute-coordinate triangles of the meshes matching `predicate`. */
function trianglesOf(building, predicate) {
  const out = [];
  building.traverse((child) => {
    if (child.isMesh && predicate(child.userData ?? {})) {
      meshTriangles(child).forEach((tri) => out.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  return out;
}
const isHostRoof = (data) => Boolean(data.roofType);
const isStructure = (data) => Boolean(data.structureId);

/** Plan (XZ) area of a set of triangles. */
const planArea = (tris) => tris.reduce((sum, [a, b, c]) => sum
  + Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2, 0);

const polygonArea = (polygon) => Math.abs(polygon.reduce((sum, [x, z], i) => {
  const [nx, nz] = polygon[(i + 1) % polygon.length];
  return sum + x * nz - nx * z;
}, 0)) / 2;

/** Distance from a plan point to a convex polygon's boundary, negative inside. */
function signedDistance(polygon, [x, z]) {
  let inside = true;
  let nearest = Infinity;
  const area = polygon.reduce((sum, [ax, az], i) => {
    const [bx, bz] = polygon[(i + 1) % polygon.length];
    return sum + ax * bz - bx * az;
  }, 0);
  polygon.forEach(([ax, az], i) => {
    const [bx, bz] = polygon[(i + 1) % polygon.length];
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
    if (cross * area < 0) {
      inside = false;
    }
    const len2 = (bx - ax) ** 2 + (bz - az) ** 2;
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / len2));
    nearest = Math.min(nearest, Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az)));
  });
  return inside ? -nearest : nearest;
}

/**
 * The host roof and a structure must form one shell. Edges may only be open
 * where either roof meets its own walls (the host at its plate, the
 * structure's roof trim and wall tops in its wall planes, above the host
 * roof), or where the structure's eave trim dips into the host roof outside
 * the hole (the host roof is intact there and covers it). The seam around
 * the hole must be closed.
 */
function assertOneShell(result, label) {
  const [{ resolved }] = result.roofStructures;
  const tris = [...trianglesOf(result.building, isHostRoof), ...trianglesOf(result.building, isStructure)];
  const { bounds } = resolved;
  const wallPlanes = ['minX', 'maxX', 'minZ', 'maxZ'].map((side) => [side === 'minX' || side === 'maxX' ? 0 : 2, bounds[side]]);
  openTriangleEdges(tris).forEach((edge) => {
    const mid = [0, 1, 2].map((k) => (edge[0][k] + edge[1][k]) / 2);
    const onHostWall = edge.every((p) => Math.abs(Math.abs(p[0]) - 10) < 1e-3)
      || edge.every((p) => Math.abs(Math.abs(p[2]) - 5) < 1e-3);
    const onStructureWall = wallPlanes.some(([k, value]) => edge.every((p) => Math.abs(p[k] - value) < 1e-3))
      && mid[1] > hostY(mid) + 1e-3;
    const onHostOutsideHole = edge.every((p) => Math.abs(p[1] - hostY(p)) < 2e-3)
      && signedDistance(resolved.hostContact, [mid[0], mid[2]]) > 1e-3;
    assert.ok(onHostWall || onStructureWall || onHostOutsideHole, `${label}: open edge ${JSON.stringify(edge)}`);
  });
}

describe('roof dormers', () => {
  ['gable', 'hip', 'shed', 'flat'].forEach((roofType) => {
    const structure = {
      hostVolumeId: 'volume-0',
      hostSide: 'minZ',
      roofType,
      roofShape: roofType === 'shed' ? { mode: 'slope', pitchRise: 1 } : undefined,
    };

    it(`a ${roofType} dormer is built and joins the host roof as one closed shell`, () => {
      const result = build([structure]);
      assert.deepEqual(result.roofStructures[0].errors, []);
      assert.ok(trianglesOf(result.building, (data) => data.structurePart === 'walls').length > 0, 'has walls');
      assert.ok(trianglesOf(result.building, (data) => data.structurePart === 'roof').length > 0, 'has a roof');
      trianglesOf(result.building, () => true).flat(2).forEach((value) => assert.ok(Number.isFinite(value)));
      assertOneShell(result, roofType);
    });

    it(`a ${roofType} dormer cuts exactly its contact outline out of the host roof`, () => {
      const without = planArea(trianglesOf(build([]).building, isHostRoof));
      const result = build([structure]);
      const removed = without - planArea(trianglesOf(result.building, isHostRoof));
      const expected = polygonArea(result.roofStructures[0].resolved.hostContact);
      assert.ok(Math.abs(removed - expected) < 1e-4, `removed ${removed}, contact ${expected}`);
    });

    it(`a ${roofType} dormer keeps nothing below the host roof`, () => {
      const result = build([structure]);
      trianglesOf(result.building, isStructure).forEach((tri) => {
        const centroid = [0, 1, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
        assert.ok(centroid[1] >= hostY(centroid) - 1e-3, `${roofType}: piece below the host roof at ${JSON.stringify(centroid)}`);
      });
    });
  });

  it('a gable dormer ridge ends where it meets the host plane', () => {
    const result = build([{ hostVolumeId: 'volume-0', hostSide: 'minZ' }]);
    const { resolved } = result.roofStructures[0];
    const ridgeY = resolved.plateY + resolved.roofHeight;
    const ridge = trianglesOf(result.building, (data) => data.structurePart === 'roof').flat()
      .filter((v) => Math.abs(v[1] - ridgeY) < 1e-4);
    const end = ridge.reduce((best, v) => (v[2] > best[2] ? v : best));
    assert.ok(Math.abs(end[0]) < 1e-4 && Math.abs(end[2] - -0.1) < 1e-4, `ridge end ${JSON.stringify(end)}`);
  });

  it('a gable end is wall, not roof', () => {
    const result = build([{ hostVolumeId: 'volume-0', hostSide: 'minZ' }]);
    const { resolved } = result.roofStructures[0];
    // in the front wall plane and reaching up into the gable
    const inGable = (tri) => tri.every((v) => Math.abs(v[2] - resolved.front) < 1e-5)
      && tri.some((v) => v[1] > resolved.plateY + 0.1);
    assert.ok(trianglesOf(result.building, (data) => data.structurePart === 'walls').some(inGable));
    assert.equal(trianglesOf(result.building, (data) => data.structurePart === 'roof').some(inGable), false);
  });

  it('an open side has no wall and keeps the roof\'s gable face', () => {
    const result = build([{ hostVolumeId: 'volume-0', hostSide: 'minZ', openSides: ['front'] }]);
    const { resolved } = result.roofStructures[0];
    const inFront = (tri) => tri.every((v) => Math.abs(v[2] - resolved.front) < 1e-5);
    assert.equal(trianglesOf(result.building, (data) => data.structurePart === 'walls').some(inFront), false);
    assert.ok(trianglesOf(result.building, (data) => data.structurePart === 'roof').some(inFront));
  });

  it('several dormers on both slopes each cut their own hole', () => {
    const structures = [
      { hostVolumeId: 'volume-0', hostSide: 'minZ', offset: -5 },
      { hostVolumeId: 'volume-0', hostSide: 'minZ', offset: 5, roofType: 'hip' },
      { hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: 0, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 1 } },
    ];
    const result = build(structures);
    assert.deepEqual(result.roofStructures.map((entry) => entry.errors), [[], [], []]);
    const without = planArea(trianglesOf(build([]).building, isHostRoof));
    const removed = without - planArea(trianglesOf(result.building, isHostRoof));
    const expected = result.roofStructures.reduce((sum, entry) => sum + polygonArea(entry.resolved.hostContact), 0);
    assert.ok(Math.abs(removed - expected) < 1e-4);
    const built = new Set();
    result.building.traverse((child) => { if (child.userData?.structureId) { built.add(child.userData.structureId); } });
    assert.equal(built.size, 3);
  });

  it('builds nothing for an invalid structure and reports why', () => {
    const result = build([{ hostVolumeId: 'volume-0', hostSide: 'minX' }]);
    assert.deepEqual(result.roofStructures[0].errors.map((e) => e.code), ['side-not-sloped']);
    assert.equal(trianglesOf(result.building, isStructure).length, 0);
    const without = planArea(trianglesOf(build([]).building, isHostRoof));
    assert.ok(Math.abs(planArea(trianglesOf(result.building, isHostRoof)) - without) < 1e-9, 'host roof untouched');
  });

  it('works on a volume of a multi-volume building with its own story count', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const config = {
      storyCount: 1, storyHeight: 3, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, roofEaveDepth: 0.3,
      volumes: layout.volumes, volumeStoryOverrides: { 'volume-0': 2 },
    };
    const structures = normalizeRoofStructures([{ hostVolumeId: 'volume-0', hostSide: 'minZ', offset: 4 }]);
    const before = createBuildingFromFootprint(norm, config);
    const after = createBuildingFromFootprint(norm, { ...config, roofStructures: structures });
    assert.deepEqual(after.roofStructures[0].errors, []);
    const { resolved } = after.roofStructures[0];
    assert.ok(resolved.sillY > 6, 'sits on the two-story base roof');
    const hostOf = (data) => data.volumeId === 'volume-0' && Boolean(data.roofType);
    const removed = planArea(trianglesOf(before.building, hostOf)) - planArea(trianglesOf(after.building, hostOf));
    assert.ok(Math.abs(removed - polygonArea(resolved.hostContact)) < 1e-4);
    const legRoofs = (result) => planArea(trianglesOf(result.building, (data) => data.volumeId !== 'volume-0' && Boolean(data.roofType)));
    assert.ok(Math.abs(legRoofs(before) - legRoofs(after)) < 1e-9, 'other volumes untouched');
  });
});
