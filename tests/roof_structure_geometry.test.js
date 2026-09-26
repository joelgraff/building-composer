import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures, volumeSolid, isInsideSolid } from '../js/roof-structures.js';
import { meshTriangles, openTriangleEdges, totalArea, uncoveredEdges } from './helpers/mesh.js';

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

describe('wall dormers', () => {
  const E = 0.3; // eave depth
  const F = 0.15; // fascia depth
  // host roofs, each with its own surface height (absolute) for the slope the dormer is on
  const hosts = {
    gable: { config: { roofType: 'gable', roofDirection: 'x' }, surface: ([, , z]) => PLATE + 0.5 * (5 - Math.abs(z)), drop: 0.5 * E },
    hip: { config: { roofType: 'hip', roofDirection: 'x' }, surface: ([, , z]) => PLATE + 0.5 * (5 - Math.abs(z)), drop: 0.5 * E },
    shed: { config: { roofType: 'shed', roofDirection: 'z-max' }, surface: ([, , z]) => PLATE + 0.25 * (z + 5), drop: 0.25 * E },
    flat: { config: { roofType: 'flat' }, surface: () => PLATE + 0.08, drop: 0 },
  };
  const wallDormer = (hostType, fields = {}) => build(
    [{ kind: 'wall-dormer', hostVolumeId: 'volume-0', hostSide: 'minZ', depth: hostType === 'flat' ? 3 : undefined, ...fields }],
    { ...hosts[hostType].config, roofEaveDepth: E, roofFasciaDepth: F, eaveSoffit: fields.eaveSoffit ?? 'flat' }
  );
  const eaveCaps = (result) => trianglesOf(result.building, (data) => data.structurePart === 'eave-caps');

  Object.entries(hosts).forEach(([hostType, { surface }]) => {
    it(`on a ${hostType} roof: breaks the eave and joins the host as one closed shell`, () => {
      const result = wallDormer(hostType);
      const [{ resolved, errors }] = result.roofStructures;
      assert.deepEqual(errors, []);
      assert.equal(resolved.flush, true);
      const tris = [...trianglesOf(result.building, isHostRoof), ...trianglesOf(result.building, isStructure)];
      const { bounds } = resolved;
      const wallPlanes = ['minX', 'maxX', 'minZ', 'maxZ'].map((side) => [side === 'minX' || side === 'maxX' ? 0 : 2, bounds[side]]);
      const insidePlan = ([x, , z]) => x >= bounds.minX - 1e-3 && x <= bounds.maxX + 1e-3 && z >= bounds.minZ - 1e-3 && z <= bounds.maxZ + 1e-3;
      openTriangleEdges(tris).forEach((edge) => {
        const mid = [0, 1, 2].map((k) => (edge[0][k] + edge[1][k]) / 2);
        const onHostWall = edge.every((p) => Math.abs(Math.abs(p[0]) - 10) < 1e-3)
          || edge.every((p) => Math.abs(Math.abs(p[2]) - 5) < 1e-3);
        const onStructureWall = wallPlanes.some(([k, value]) => edge.every((p) => Math.abs(p[k] - value) < 1e-3))
          && mid[1] > surface(mid) + 1e-3;
        const onHostOutsideHole = edge.every((p) => Math.abs(p[1] - surface(p)) < 2e-3)
          && signedDistance(resolved.hostContact, [mid[0], mid[2]]) > 1e-3;
        // a flat roof is a slab: the hole through it opens into the dormer
        const throughSlab = hostType === 'flat' && edge.every((p) => insidePlan(p) && p[1] >= PLATE - 1e-3 && p[1] <= PLATE + 0.08 + 1e-3);
        assert.ok(onHostWall || onStructureWall || onHostOutsideHole || throughSlab, `${hostType}: open edge ${JSON.stringify(edge)}`);
      });
    });

    it(`on a ${hostType} roof: removes the eave across its width and caps both ends`, () => {
      const without = planArea(trianglesOf(build([], { ...hosts[hostType].config, roofEaveDepth: E, roofFasciaDepth: F }).building, isHostRoof));
      const result = wallDormer(hostType);
      const { resolved } = result.roofStructures[0];
      const removed = without - planArea(trianglesOf(result.building, isHostRoof));
      const width = resolved.along[1] - resolved.along[0];
      // eave top and soffit in plan; a flat slab loses its top and underside over the whole hole
      const expected = hostType === 'flat'
        ? 2 * (polygonArea(resolved.hostContact) + E * width)
        : polygonArea(resolved.hostContact) + 2 * E * width;
      assert.ok(Math.abs(removed - expected) < 1e-4, `removed ${removed}, expected ${expected}`);
      // each cap is the eave's cross-section: out along the roof, down the fascia, back along a flat soffit
      const { drop } = hosts[hostType];
      const capArea = hostType === 'flat' ? E * 0.08 : E * ((drop + F) + F) / 2;
      const caps = eaveCaps(result);
      [resolved.along[0], resolved.along[1]].forEach((x) => {
        const cap = caps.filter((tri) => tri.every((v) => Math.abs(v[0] - x) < 1e-6));
        assert.ok(Math.abs(totalArea(cap) - capArea) < 1e-6, `${hostType} cap at x=${x}: ${totalArea(cap)} vs ${capArea}`);
      });
    });
  });

  it('keeps the eave everywhere else', () => {
    const result = wallDormer('gable');
    const fascia = trianglesOf(result.building, isHostRoof).filter((tri) => tri.every((v) => Math.abs(v[2] - -(5 + E)) < 1e-6));
    const xs = fascia.flat().map((v) => v[0]);
    assert.ok(xs.some((x) => x < -1.2 - 1) && xs.some((x) => x > 1.2 + 1), 'fascia on both sides of the dormer');
    assert.equal(fascia.some((tri) => tri.every((v) => Math.abs(v[0]) < 1.2 - 1e-6)), false, 'none in front of it');
  });

  it('carries the front wall down to the host wall top', () => {
    const result = wallDormer('gable');
    const front = trianglesOf(result.building, (data) => data.structurePart === 'walls')
      .filter((tri) => tri.every((v) => Math.abs(v[2] - -5) < 1e-6));
    assert.ok(Math.abs(Math.min(...front.flat().map((v) => v[1])) - (PLATE - 0.02)) < 1e-6);
  });

  it('works with sloped soffits', () => {
    const result = wallDormer('gable', { eaveSoffit: 'sloped' });
    const caps = eaveCaps(result);
    const capArea = E * F; // a sloped soffit runs parallel to the roof: a parallelogram one fascia deep
    assert.ok(Math.abs(totalArea(caps.filter((tri) => tri.every((v) => Math.abs(v[0] - 1.2) < 1e-6))) - capArea) < 1e-6);
  });

  it('a dormer set back from the wall leaves the eave alone', () => {
    const result = build([{ hostVolumeId: 'volume-0', hostSide: 'minZ', setback: 0.1 }], { roofEaveDepth: E });
    assert.equal(result.roofStructures[0].resolved.flush, false);
    assert.equal(eaveCaps(result).length, 0);
  });
});

describe('porches', () => {
  const leanTo = normalizeFootprint(JSON.parse(readFileSync('./data/footprint_narrow_lean_to.json', 'utf8')));
  const twoStory = { storyCount: 2, storyHeight: 3 }; // plate at 0.6 + 6 + 0.02
  const PLATE2 = 6.62;
  const projecting = (fields = {}) => ({
    kind: 'porch',
    hostVolumeId: 'volume-0',
    hostSide: 'minZ',
    setback: -2.4,
    width: 3.6,
    depth: null,
    baseHeight: -3, // one story below the plate: a second-floor porch
    wallHeight: 2.4,
    roofType: 'shed',
    openSides: [],
    ...fields,
  });
  const onWing = (fields = {}) => createBuildingFromFootprint(leanTo, {
    storyCount: 1, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12,
    roofEaveDepth: 0.3, roofRakeDepth: 0.2,
    volumes: computeFacadeLayout(leanTo, {}).volumes,
    volumeStoryOverrides: { 'volume-0': 2 },
    roofStructures: normalizeRoofStructures([{
      kind: 'porch', hostVolumeId: 'volume-1', hostSide: 'maxZ', setback: 0, width: 6, depth: 11.8,
      baseHeight: 0, wallHeight: 2.4, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 }, openSides: [], ...fields,
    }]),
  });

  /**
   * Nothing to see through: every open edge in the whole building lies on
   * another surface, except where a volume's roof sits its ROOF_LIFT above
   * its own wall top (as every roof does), and along a structure's open
   * sides (`openPlanes`: [axis index, coordinate]).
   */
  function assertWatertight(result, label, openPlanes = []) {
    const tris = trianglesOf(result.building, () => true);
    const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3
      && ['minX', 'maxX', 'minZ', 'maxZ'].some((side) => Math.abs(p[side === 'minX' || side === 'maxX' ? 0 : 2] - zone.bounds[side]) < 1e-3)));
    const opening = (edge) => openPlanes.some(([k, value]) => edge.every((p) => Math.abs(p[k] - value) < 1e-3));
    const gaps = uncoveredEdges(tris).filter((edge) => !lift(edge) && !opening(edge));
    assert.deepEqual(gaps, [], `${label}: see-through edges`);
  }

  const partOf = (result, part) => trianglesOf(result.building, (data) => data.structurePart === part);

  it('a second-floor porch projecting from the wall, rising through the eave, is watertight', () => {
    const result = build([projecting({ roofShape: { mode: 'slope', pitchRise: 4 } })], twoStory);
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, []);
    assert.equal(resolved.projecting, true);
    assertWatertight(result, 'projecting');
    // its floor closes the underside outside the host only
    const floor = partOf(result, 'floor');
    assert.ok(floor.length > 0);
    floor.flat().forEach((v) => assert.ok(v[2] <= -5 + 1e-6 && Math.abs(v[1] - (PLATE2 - 3)) < 1e-6));
    assert.ok(Math.abs(planArea(floor) - 3.6 * 2.4) < 1e-6);
    // it breaks the eave; its own side walls close the cut ends, so no caps
    assert.equal(partOf(result, 'eave-caps').length, 0);
    const fasciaInFront = trianglesOf(result.building, isHostRoof)
      .filter((tri) => tri.every((v) => Math.abs(v[2] - -5.3) < 1e-6 && Math.abs(v[0]) < 1.8 - 1e-6));
    assert.equal(fasciaInFront.length, 0);
  });

  it('a porch tucked under the eave leaves the host roof alone', () => {
    const without = planArea(trianglesOf(build([], twoStory).building, isHostRoof));
    const result = build([projecting({ roofShape: { mode: 'slope', pitchRise: 1 } })], twoStory);
    assert.deepEqual(result.roofStructures[0].errors, []);
    assert.ok(Math.abs(planArea(trianglesOf(result.building, isHostRoof)) - without) < 1e-6);
    assertWatertight(result, 'tucked');
  });

  it('an open porch has no walls on its open sides, a header under each open eave, and caps on the broken eave', () => {
    const result = build([projecting({ roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'] })], twoStory);
    const { resolved } = result.roofStructures[0];
    const inPlane = (k, value) => (tri) => tri.every((v) => Math.abs(v[k] - value) < 1e-6);
    // (inside the host a knee wall still closes the attic under the host roof beyond an open side)
    const walls = partOf(result, 'walls').filter((tri) => tri.some((v) => v[2] < -5 - 1e-6));
    [[0, -1.8], [0, 1.8], [2, -7.4]].forEach(([k, value]) => {
      assert.equal(walls.some(inPlane(k, value)), false, `no wall at ${k}=${value}`);
    });
    // a header closes the front eave across the porch, from its flat soffit
    // (one eave drop, 4:12 over 0.3 m, plus the fascia below the plate) up to the plate
    const header = partOf(result, 'roof').filter((tri) => inPlane(2, -7.4)(tri) && tri.every((v) => Math.abs(v[0]) <= 1.8 + 1e-6));
    assert.ok(Math.abs(totalArea(header) - 3.6 * ((4 / 12) * 0.3 + 0.1524)) < 1e-6, `header area ${totalArea(header)}`);
    assert.ok(header.flat().every((v) => v[1] <= resolved.plateY + 1e-6));
    assert.equal(partOf(result, 'eave-caps').length, 4, 'two caps, one each side');
    assertWatertight(result, 'open', [[0, -1.8], [0, 1.8], [2, -7.4]]);
  });

  it('a porch on a one-story wing runs into the two-story main block and merges with it', () => {
    const result = onWing();
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, []);
    assert.equal(resolved.standing, true);
    assertWatertight(result, 'wing porch');
    const main = result.roofZones.find((zone) => zone.volumeId === 'volume-0');
    const wing = result.roofZones.find((zone) => zone.volumeId === 'volume-1');
    const mainSolid = volumeSolid(main);
    const wingBody = volumeSolid({ ...wing, planes: [], slabThickness: 0, baseY: wing.wallTopY });
    trianglesOf(result.building, isStructure).forEach((tri) => {
      const centroid = [0, 1, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
      assert.equal(isInsideSolid(centroid, mainSolid, -1e-4), false, `inside the main block at ${JSON.stringify(centroid)}`);
      assert.equal(isInsideSolid(centroid, wingBody, -1e-4), false, `inside the wing at ${JSON.stringify(centroid)}`);
    });
    // its roof carries on up into the main roof, which is cut to meet it
    const mainRoof = (res) => planArea(trianglesOf(res.building, (data) => data.volumeId === 'volume-0' && Boolean(data.roofType)));
    const plain = createBuildingFromFootprint(leanTo, {
      storyCount: 1, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12,
      roofEaveDepth: 0.3, roofRakeDepth: 0.2, volumes: computeFacadeLayout(leanTo, {}).volumes, volumeStoryOverrides: { 'volume-0': 2 },
    });
    assert.ok(mainRoof(plain) - mainRoof(result) > 1, 'part of the main roof is removed under the porch roof');
  });

  it('a porch on a gable end is allowed; a dormer there is not', () => {
    const result = onWing();
    assert.deepEqual(result.roofStructures[0].errors, [], 'the wing\'s rear side is a gable end');
    const dormer = onWing({ baseHeight: null, depth: null });
    assert.deepEqual(dormer.roofStructures[0].errors.map((e) => e.code), ['side-not-sloped']);
  });

  it('a porch spanning its host\'s ridge removes the roof on both slopes with no wall across the ridge', () => {
    const result = build([{
      kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'minZ', setback: 0, width: 4, depth: 10,
      baseHeight: 0, wallHeight: 2.8, roofType: 'gable', openSides: [],
    }]);
    const { resolved } = result.roofStructures[0];
    assert.equal(resolved.removedRoof.length, 2, 'one piece on each slope');
    assertWatertight(result, 'across the ridge');
    const acrossRidge = partOf(result, 'walls').filter((tri) => tri.every((v) => Math.abs(v[2]) < 1e-6 && Math.abs(v[0]) < 2 - 1e-6));
    assert.equal(acrossRidge.length, 0);
  });

  it('a porch whose roof meets the host roof partway up closes off the attic with a knee wall', () => {
    const result = build([projecting({ roofShape: { mode: 'slope', pitchRise: 4 } })], twoStory);
    const { resolved } = result.roofStructures[0];
    // the porch roof meets the host slope where 6.02 + (z + 7.4) / 3 = 6.62 + (z + 5) / 2
    const meet = -3.8;
    near(Math.max(...resolved.removedRoof[0].map(([, z]) => z)), meet);
    const knee = partOf(result, 'walls').filter((tri) => tri.every((v) => Math.abs(v[2] - meet) < 1e-6));
    assert.ok(Math.abs(totalArea(knee) - 3.6 * (PLATE2 + 0.5 * 1.2 - (PLATE2 - 0.02))) < 1e-6, 'from the wall top up to the valley, across the porch');
  });

  it('a porch on a flat roof is watertight', () => {
    const result = build([{
      kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'minZ', setback: 0, width: 4, depth: 4, baseHeight: 0, wallHeight: 2.4, roofType: 'hip', openSides: [],
    }], { roofType: 'flat' });
    assert.deepEqual(result.roofStructures[0].errors, []);
    assertWatertight(result, 'flat host');
  });
});

function near(a, b, message) {
  assert.ok(Math.abs(a - b) < 1e-6, `${message ?? ''} expected ${b}, got ${a}`);
}
