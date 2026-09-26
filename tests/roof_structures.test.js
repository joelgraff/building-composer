import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint, evalZoneHeight } from '../js/extrusion.js';
import {
  clipOutsideConvexSolid, isInsideSolid, volumeSolid, FLAT_ROOF_THICKNESS,
} from '../js/roof-structures.js';
import { meshTriangles, totalArea, openTriangleEdges } from './helpers/mesh.js';

const uFootprint = JSON.parse(readFileSync('./data/footprint_u.json', 'utf8'));
const RECT = [[-10, -5], [10, -5], [10, 5], [-10, 5]];

/** Axis-aligned box as half-spaces (unit normals). */
function boxSolid([x0, y0, z0], [x1, y1, z1]) {
  return [
    { normal: [-1, 0, 0], offset: -x0 }, { normal: [1, 0, 0], offset: x1 },
    { normal: [0, -1, 0], offset: -y0 }, { normal: [0, 1, 0], offset: y1 },
    { normal: [0, 0, -1], offset: -z0 }, { normal: [0, 0, 1], offset: z1 },
  ];
}

/** Closed surface of an axis-aligned box, 12 triangles. */
function boxTriangles([x0, y0, z0], [x1, y1, z1]) {
  const p = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return faces.flatMap(([a, b, c, d]) => [[p(a), p(b), p(c)], [p(a), p(c), p(d)]]);
}

const horizontalQuad = (x0, x1, z0, z1, y) => [
  [[x0, y, z0], [x1, y, z0], [x1, y, z1]],
  [[x0, y, z0], [x1, y, z1], [x0, y, z1]],
];

describe('clipOutsideConvexSolid', () => {
  const cube = boxSolid([0, 0, 0], [1, 1, 1]);

  it('keeps exactly the part of a surface outside the solid', () => {
    const kept = clipOutsideConvexSolid(horizontalQuad(-1, 2, -1, 2, 0.5), cube);
    assert.ok(Math.abs(totalArea(kept) - 8) < 1e-9, `3x3 quad minus the 1x1 hole = 8, got ${totalArea(kept)}`);
    assert.ok(kept.flat(2).every(Number.isFinite));
    kept.forEach((tri) => {
      const centroid = [0, 1, 2].map((k) => (tri[0][k] + tri[1][k] + tri[2][k]) / 3);
      assert.equal(isInsideSolid(centroid, cube, -1e-9), false, 'no kept piece lies inside');
    });
  });

  it('drops surfaces inside the solid and leaves ones outside untouched', () => {
    assert.deepEqual(clipOutsideConvexSolid(horizontalQuad(0.2, 0.8, 0.2, 0.8, 0.5), cube), []);
    const outside = horizontalQuad(3, 4, 3, 4, 0.5);
    assert.ok(Math.abs(totalArea(clipOutsideConvexSolid(outside, cube)) - 1) < 1e-9);
  });

  it('treats a face lying on the boundary as inside, so flush faces do not z-fight', () => {
    assert.deepEqual(clipOutsideConvexSolid(horizontalQuad(0, 1, 0, 1, 1), cube), []);
    const lifted = clipOutsideConvexSolid(horizontalQuad(0, 1, 0, 1, 1.01), cube);
    assert.ok(Math.abs(totalArea(lifted) - 1) < 1e-9);
  });

  it('two overlapping closed solids, each clipped outside the other, form one closed shell', () => {
    const a = [[0, 0, 0], [1, 1, 1]];
    const b = [[0.5, 0.3, 0.2], [1.5, 1.3, 1.2]];
    const union = [
      ...clipOutsideConvexSolid(boxTriangles(...a), boxSolid(...b)),
      ...clipOutsideConvexSolid(boxTriangles(...b), boxSolid(...a)),
    ];
    assert.deepEqual(openTriangleEdges(union), []);
    // each box loses exactly the part of its surface inside the other
    const boxArea = ([x, y, z]) => 2 * (x * y + y * z + z * x);
    const aInsideB = 0.5 * 0.7 + 0.5 * 0.8 + 0.7 * 0.8; // A's three faces at its max corner, clipped to the overlap
    const bInsideA = aInsideB; // the overlap is a box, B's three min-corner faces mirror A's
    const expected = 2 * boxArea([1, 1, 1]) - aInsideB - bInsideA;
    assert.ok(Math.abs(totalArea(union) - expected) < 1e-9, `union area ${totalArea(union)} vs ${expected}`);
  });
});

/** Every roof triangle of the building, in absolute coordinates, with its volume id. */
function roofTriangles(building) {
  const out = [];
  building.traverse((child) => {
    if (child.isMesh && child.userData?.roofType) {
      meshTriangles(child).forEach((tri) => out.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  return out;
}

/** Heights at which the roof surface crosses the vertical line through (x, z). */
function surfaceHeightsAt(tris, x, z) {
  const heights = [];
  tris.forEach(([a, b, c]) => {
    const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(det) < 1e-12) {
      return; // vertical face
    }
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
    const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) {
      heights.push(l1 * a[1] + l2 * b[1] + l3 * c[1]);
    }
  });
  return heights;
}

/**
 * The descriptor must agree with what was rendered: across the zone's wall
 * rectangle, its planes give a height the roof mesh actually has there.
 */
function assertZoneMatchesRoof(zone, tris) {
  const { minX, maxX, minZ, maxZ } = zone.bounds;
  const top = zone.planes.length ? null : zone.baseY + zone.slabThickness;
  for (let i = 1; i < 8; i += 1) {
    for (let j = 1; j < 8; j += 1) {
      const x = minX + ((maxX - minX) * i) / 8;
      const z = minZ + ((maxZ - minZ) * j) / 8;
      const expected = top ?? zone.baseY + evalZoneHeight(zone.planes, x, z);
      const heights = surfaceHeightsAt(tris, x, z);
      assert.ok(
        heights.some((h) => Math.abs(h - expected) < 1e-4),
        `${zone.volumeId} at (${x.toFixed(2)}, ${z.toFixed(2)}): expected ${expected.toFixed(4)}, roof has ${heights.map((h) => h.toFixed(4)).join(', ')}`
      );
    }
  }
}

describe('resolved roof zone descriptors', () => {
  const rect = (config) => createBuildingFromFootprint(RECT, {
    storyCount: 1, storyHeight: 3, foundationDepth: 0.6, roofHeight: 2.5, roofPitchRise: 6, roofPitchRun: 12, roofEaveDepth: 0.4, ...config,
  });

  ['gable', 'hip', 'shed', 'flat'].forEach((roofType) => {
    it(`describe a rectangular ${roofType} roof as rendered`, () => {
      const { building, roofZones } = rect({ roofType, roofDirection: roofType === 'shed' ? 'x-min' : 'x' });
      assert.equal(roofZones.length, 1);
      const [zone] = roofZones;
      assert.deepEqual(zone.bounds, { minX: -10, maxX: 10, minZ: -5, maxZ: 5 });
      assert.ok(Math.abs(zone.baseY - (0.6 + 3 + 0.02)) < 1e-9);
      assert.equal(zone.exact, true);
      if (roofType === 'flat') {
        assert.deepEqual(zone.planes, []);
        assert.equal(zone.slabThickness, FLAT_ROOF_THICKNESS);
      }
      assertZoneMatchesRoof(zone, roofTriangles(building));
    });
  });

  it('describe each volume of a U gable assembly', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const { building, roofZones } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: 3, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
    });
    assert.deepEqual(roofZones.map((zone) => zone.volumeId).sort(), layout.volumes.map((volume) => volume.id).sort());
    const tris = roofTriangles(building);
    roofZones.forEach((zone) => assertZoneMatchesRoof(zone, tris));
  });

  it('carry a merged shed\'s extended bounds and final slope', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const leg = layout.volumes[1];
    const { building, roofZones } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: 3, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
      volumeRoofTypes: { [leg.id]: 'shed' },
      volumeRidgeDirections: { [leg.id]: 'z-min' },
      volumeRoofConnections: { [leg.id]: 'merge-plane' },
    });
    const zone = roofZones.find((candidate) => candidate.volumeId === leg.id);
    assert.notDeepEqual(zone.roofBounds, zone.bounds, 'the merged shed runs past its wall into the neighbor');
    const tris = roofTriangles(building);
    roofZones.forEach((candidate) => assertZoneMatchesRoof(candidate, tris));
  });

  it('describe every volume on its own plate when story counts differ', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const legs = layout.volumes.slice(1).map((volume) => volume.id);
    const { building, roofZones } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: 3, roofType: 'gable', roofPitchRise: 12, roofPitchRun: 12, volumes: layout.volumes,
      volumeStoryOverrides: { 'volume-0': 2 },
      volumeRoofConnections: Object.fromEntries(legs.map((id) => [id, 'merge-plane'])),
    });
    assert.equal(roofZones.length, 3);
    const plates = Object.fromEntries(roofZones.map((zone) => [zone.volumeId, zone.baseY]));
    legs.forEach((id) => assert.ok(plates['volume-0'] - plates[id] > 2.9, 'legs sit one story below the base'));
    const tris = roofTriangles(building);
    roofZones.forEach((zone) => assertZoneMatchesRoof(zone, tris));
  });

  it('carry a merged gable\'s lowered ridge, not its configured one', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const legs = layout.volumes.slice(1).map((volume) => volume.id);
    const { building, roofZones } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: 3, roofType: 'gable', roofPitchRise: 12, roofPitchRun: 12, volumes: layout.volumes,
      volumeRoofShapes: { 'volume-0': { mode: 'slope', pitchRise: 4 } },
      volumeRoofConnections: Object.fromEntries(legs.map((id) => [id, 'merge-plane'])),
    });
    const base = roofZones.find((zone) => zone.volumeId === 'volume-0');
    legs.forEach((id) => {
      const leg = roofZones.find((zone) => zone.volumeId === id);
      assert.ok(leg.roofHeight < 3 - 1e-6, `a 12:12 leg over a 6 m span would peak at 3; ${id} is capped`);
      assert.ok(Math.abs(leg.roofHeight - base.roofHeight) < 1e-9, 'capped at the base ridge');
    });
    const tris = roofTriangles(building);
    roofZones.forEach((zone) => assertZoneMatchesRoof(zone, tris));
  });

  it('are absent for roofs without per-volume planes (sampled hip field)', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'hip' });
    const { roofZones } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: 3, roofType: 'hip', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
    });
    assert.deepEqual(roofZones, []);
  });
});

describe('volumeSolid', () => {
  const { roofZones } = createBuildingFromFootprint(RECT, {
    storyCount: 1, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofHeight: 2.5, roofPitchRise: 6, roofPitchRun: 12,
  });
  const [zone] = roofZones;
  const solid = volumeSolid(zone);
  const ridgeY = zone.baseY + 2.5;

  it('is the wall box capped by the roof planes, in absolute heights', () => {
    assert.equal(isInsideSolid([0, ridgeY - 0.01, 0], solid), true, 'just under the ridge');
    assert.equal(isInsideSolid([0, ridgeY + 0.01, 0], solid), false, 'just over the ridge');
    assert.equal(isInsideSolid([9.9, zone.baseY + 0.01, 4.9], solid), true, 'at the plate by a corner');
    assert.equal(isInsideSolid([0, zone.baseY + 0.3, 4.9], solid), false, 'above the slope near the eave');
    assert.equal(isInsideSolid([10.5, 1, 0], solid), false, 'outside the walls');
    assert.equal(isInsideSolid([0, -0.1, 0], solid), false, 'below grade');
  });

  it('removes the roof slopes that bound it', () => {
    // one side of the ridge only, so each triangle lies in a single roof plane
    const eaveSide = horizontalQuad(-9, 9, 0.5, 4, 0).map((tri) => tri.map(([x, , z]) => [x, zone.baseY + evalZoneHeight(zone.planes, x, z), z]));
    assert.deepEqual(clipOutsideConvexSolid(eaveSide, solid), []);
  });

  it('caps a flat roof at the top of its slab', () => {
    const flat = createBuildingFromFootprint(RECT, { storyCount: 1, storyHeight: 3, foundationDepth: 0.6, roofType: 'flat' }).roofZones[0];
    const flatSolid = volumeSolid(flat);
    assert.equal(isInsideSolid([0, flat.baseY + FLAT_ROOF_THICKNESS - 0.001, 0], flatSolid), true);
    assert.equal(isInsideSolid([0, flat.baseY + FLAT_ROOF_THICKNESS + 0.01, 0], flatSolid), false);
  });
});
