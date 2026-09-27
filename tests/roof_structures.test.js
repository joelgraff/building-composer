import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState } from '../js/facade.js';
import { createBuildingFromFootprint, evalZoneHeight } from '../js/extrusion.js';
import {
  clipOutsideConvexSolid, isInsideSolid, volumeSolid, FLAT_ROOF_THICKNESS,
  normalizeRoofStructure, normalizeRoofStructures, createRoofStructure, STRUCTURE_PRESETS,
  resolveRoofStructure, validateRoofStructures,
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

describe('roof structure records', () => {
  it('fill missing fields from the kind\'s preset and reject unplaceable input', () => {
    const dormer = normalizeRoofStructure({ hostVolumeId: 'volume-0', hostSide: 'minZ' });
    assert.equal(dormer.kind, 'dormer');
    assert.equal(dormer.width, STRUCTURE_PRESETS.dormer.width);
    assert.equal(dormer.depth, null);
    assert.equal(dormer.baseHeight, null);
    assert.equal(dormer.roofType, 'gable');
    assert.equal(dormer.join, 'auto');
    const porch = normalizeRoofStructure({ kind: 'porch', hostVolumeId: 'volume-1', hostSide: 'maxX', openSides: ['front', 'sideways', 'back'], roofType: 'dome' });
    assert.equal(porch.baseHeight, 0);
    assert.deepEqual(porch.openSides, ['front', 'back']);
    assert.equal(porch.roofType, 'shed', 'unknown roof types fall back to the preset');
    assert.equal(normalizeRoofStructure({ hostSide: 'minZ' }), null);
    assert.equal(normalizeRoofStructure({ hostVolumeId: 'volume-0', hostSide: 'north' }), null);
  });

  it('read supports, ground-level bases, and structure hosts', () => {
    const upper = normalizeRoofStructure({ hostStructureId: 'structure-1', hostSide: 'minZ', baseHeight: 'ground', support: 'posts' });
    assert.equal(upper.hostStructureId, 'structure-1');
    assert.equal(upper.hostVolumeId, null);
    assert.equal(upper.baseHeight, 'ground');
    assert.equal(upper.support, 'posts');
    assert.equal(normalizeRoofStructure({ hostVolumeId: 'volume-0', hostSide: 'minZ', support: 'stilts' }).support, 'auto');
  });

  it('read an inset, clamped to zero or more, with the recessed-porch preset', () => {
    assert.equal(normalizeRoofStructure({ hostVolumeId: 'volume-0', hostSide: 'minZ' }).inset, 0);
    assert.equal(normalizeRoofStructure({ hostVolumeId: 'volume-0', hostSide: 'minZ', inset: -2 }).inset, 0);
    const recessed = normalizeRoofStructure({ kind: 'recessed-porch', hostVolumeId: 'volume-0', hostSide: 'minZ' });
    assert.equal(recessed.inset, STRUCTURE_PRESETS['recessed-porch'].inset);
    assert.equal(recessed.setback, STRUCTURE_PRESETS['recessed-porch'].setback);
    assert.ok(recessed.setback > 0, 'set up the roof, above an intact strip of roof and eave');
  });

  it('read a mount and a centered setback, with the cupola preset', () => {
    const cupola = normalizeRoofStructure({ kind: 'cupola', hostVolumeId: 'volume-0', hostSide: 'minZ' });
    assert.equal(cupola.mount, 'through');
    assert.equal(cupola.setback, 'center');
    assert.equal(cupola.roofType, 'hip');
    assert.equal(normalizeRoofStructure({ hostVolumeId: 'volume-0', hostSide: 'minZ', mount: 'sideways' }).mount, 'join');
  });

  it('get unique ids, keeping valid ones', () => {
    const list = normalizeRoofStructures([
      { id: 'structure-2', hostVolumeId: 'volume-0', hostSide: 'minZ' },
      { hostVolumeId: 'volume-0', hostSide: 'maxZ' },
      { id: 'structure-2', hostVolumeId: 'volume-0', hostSide: 'minX' },
      null,
    ]);
    assert.deepEqual(list.map((structure) => structure.id), ['structure-2', 'structure-1', 'structure-3']);
    const created = createRoofStructure('wall-dormer', { hostVolumeId: 'volume-0', hostSide: 'minZ' }, list);
    assert.equal(created.id, 'structure-4');
    assert.equal(created.setback, 0);
  });
});

describe('resolveRoofStructure', () => {
  // 20 x 10 rectangle, plate at 0.6 + 3 + 0.02; gable ridge along x, 2.5 high (slope 0.5)
  const PLATE = 3.62;
  const zoneFor = (config) => createBuildingFromFootprint(RECT, {
    storyCount: 1, storyHeight: 3, foundationDepth: 0.6, roofHeight: 2.5, roofPitchRise: 6, roofPitchRun: 12, ...config,
  }).roofZones[0];
  const gableHost = zoneFor({ roofType: 'gable', roofDirection: 'x' });
  const hipHost = zoneFor({ roofType: 'hip', roofDirection: 'x' });
  const flatHost = zoneFor({ roofType: 'flat' });
  const building = { roofPitchRise: 6, roofPitchRun: 12 };
  const dormer = (fields, host = gableHost) => resolveRoofStructure(
    normalizeRoofStructure({ id: 'd', hostVolumeId: host.volumeId, hostSide: 'minZ', ...fields }),
    host,
    building
  );
  const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-9, `${message ?? ''} expected ${b}, got ${a}`);
  const polygonArea = (polygon) => Math.abs(polygon.reduce((sum, [x, z], i) => {
    const [nx, nz] = polygon[(i + 1) % polygon.length];
    return sum + x * nz - nx * z;
  }, 0)) / 2;

  it('places a gable dormer on the slope, sill on the roof, and finds where it meets the host', () => {
    const { resolved, errors, warnings } = dormer({});
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.deepEqual(resolved.bounds, { minX: -1.2, maxX: 1.2, minZ: -4.1, maxZ: 0 }, 'runs back to the host ridge line');
    near(resolved.sillY, PLATE + 0.45, 'sill: host roof 0.9 m in at slope 0.5');
    near(resolved.plateY, PLATE + 0.45 + 1.4);
    assert.equal(resolved.ridgeAxis, 'z', 'perpendicular ridge runs into the roof');
    near(resolved.roofHeight, 0.6, '1.2 m half span at 6:12');
    // eaves meet the host at z = -1.3, the ridge at z = -0.1 (same as the gable merge rule)
    near(polygonArea(resolved.hostContact), 2.4 * 2.8 + 0.5 * 2.4 * 1.2, 'contact pentagon area');
    const ridgeEnd = resolved.hostContact.reduce((best, point) => (point[1] > best[1] ? point : best));
    near(ridgeEnd[0], 0);
    near(ridgeEnd[1], -0.1);
  });

  it('works the same way from every side (frame)', () => {
    const zHost = zoneFor({ roofType: 'gable', roofDirection: 'z' });
    const cases = [
      [gableHost, 'minZ', { minX: 1.8, maxX: 4.2, minZ: -4.1, maxZ: 0 }],
      [gableHost, 'maxZ', { minX: 1.8, maxX: 4.2, minZ: 0, maxZ: 4.1 }],
      [zHost, 'minX', { minX: -9.1, maxX: 0, minZ: 1.8, maxZ: 4.2 }],
      [zHost, 'maxX', { minX: 0, maxX: 9.1, minZ: 1.8, maxZ: 4.2 }],
    ];
    cases.forEach(([host, hostSide, expected]) => {
      const { resolved, errors } = resolveRoofStructure(
        normalizeRoofStructure({ id: 'd', hostVolumeId: host.volumeId, hostSide, offset: 3 }),
        host,
        building
      );
      assert.deepEqual(errors, [], hostSide);
      Object.entries(expected).forEach(([key, value]) => near(resolved.bounds[key], value, `${hostSide} ${key}`));
      const slope = hostSide === 'minZ' || hostSide === 'maxZ' ? 0.5 : 0.25;
      near(resolved.sillY, PLATE + 0.9 * slope, `${hostSide} sill`);
    });
  });

  it('starts a wall dormer at the host plate', () => {
    const { resolved } = dormer({ kind: 'wall-dormer' });
    near(resolved.front, -5);
    near(resolved.sillY, PLATE);
    near(resolved.plateY, PLATE + 1.2);
  });

  it('lowers a roof that would rise above the host ridge, or snaps to it on request', () => {
    const capped = dormer({ wallHeight: 1.8 });
    assert.deepEqual(capped.warnings.map((w) => w.code), ['ridge-capped']);
    near(capped.resolved.topY, PLATE + 2.5, 'ridge lands on the host ridge');
    const snapped = dormer({ join: 'snap-ridge' });
    assert.deepEqual(snapped.warnings, []);
    near(snapped.resolved.roofHeight, 2.5 - 0.45 - 1.4, 'raised to the host ridge');
    assert.deepEqual(dormer({ wallHeight: 2.2 }).errors.map((e) => e.code), ['above-ridge']);
  });

  it('builds a shed dormer sloping up into the roof', () => {
    const { resolved, warnings } = dormer({ roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 1 } });
    assert.deepEqual(warnings, []);
    assert.equal(resolved.roofHighEdge, 'z-max');
    // 1.85 + (z + 4.1) / 12 = 0.5 (z + 5)
    const meet = (1.85 + 4.1 / 12 - 2.5) / (0.5 - 1 / 12);
    near(Math.max(...resolved.hostContact.map(([, z]) => z)), meet, 'ends where it meets the host plane');
    near(polygonArea(resolved.hostContact), 2.4 * (meet + 4.1));
    const steep = dormer({ roofType: 'shed' });
    assert.deepEqual(steep.warnings.map((w) => w.code), ['ridge-capped'], 'a shed steeper than the host snaps to the ridge');
  });

  it('allows a small dormer in a hip end but not one that crosses the hip lines', () => {
    const small = dormer({ hostSide: 'minX', width: 1, setback: 0.5, wallHeight: 0.6 }, hipHost);
    assert.deepEqual(small.errors, []);
    assert.deepEqual(dormer({ hostSide: 'minX' }, hipHost).errors, [], 'a standard dormer fits the 5 m deep hip end');
    assert.deepEqual(dormer({ hostSide: 'minX', width: 4 }, hipHost).errors.map((e) => e.code), ['crosses-face']);
  });

  it('turns a dormer on a gable end to the slope at the same end, with its ridge into the roof', () => {
    const turned = dormer({ hostSide: 'minX', offset: 2 });
    assert.deepEqual(turned.errors, []);
    assert.deepEqual(turned.warnings.map((w) => w.code), ['side-turned']);
    assert.equal(turned.resolved.hostSide, 'minZ');
    Object.entries({ minX: 0.8, maxX: 3.2, minZ: -4.1, maxZ: 0 }).forEach(([key, value]) => near(turned.resolved.bounds[key], value, key));
    const zHost = zoneFor({ roofType: 'gable', roofDirection: 'z' });
    assert.equal(dormer({ hostSide: 'maxZ' }, zHost).resolved.hostSide, 'maxX');
    // a dormer's ridge runs into the roof whatever the record says; a porch's may run along it
    assert.equal(dormer({ ridge: 'parallel' }).resolved.ridgeAxis, 'z');
    assert.equal(dormer({ kind: 'porch', ridge: 'parallel' }).resolved.ridgeAxis, 'x');
  });

  it('stands a structure on a flat roof at the slab top', () => {
    const { resolved, errors } = dormer({ depth: 3, roofType: 'flat' }, flatHost);
    assert.deepEqual(errors, []);
    near(resolved.sillY, PLATE + FLAT_ROOF_THICKNESS);
    assert.deepEqual(dormer({}, flatHost).errors.map((e) => e.code), ['depth-required']);
  });

  it('stands a porch on its base height', () => {
    const { resolved, errors } = dormer({ kind: 'porch' });
    assert.deepEqual(errors, []);
    near(resolved.sillY, PLATE);
    near(resolved.back - resolved.front, 2.4);
  });

  it('reports what makes a structure unplaceable', () => {
    const code = (fields, host) => dormer(fields, host).errors.map((e) => e.code);
    const shedHost = zoneFor({ roofType: 'shed', roofDirection: 'x' });
    const [shedSlope] = shedHost.planes.map((plane) => plane.side);
    const shedHigh = { minZ: 'maxZ', maxZ: 'minZ' }[shedSlope];
    assert.deepEqual(code({ hostSide: shedHigh }, shedHost), ['side-not-sloped'], 'a shed\'s high side (and the rake a quarter turn from it)');
    assert.deepEqual(code({ offset: 9.5 }), ['outside-host']);
    assert.deepEqual(code({ setback: -1 }), ['needs-base']);
    assert.deepEqual(code({ setback: 6 }), ['outside-face']);
    assert.deepEqual(code({ width: 0 }), ['invalid-dimensions']);
    assert.deepEqual(code({}, { ...gableHost, exact: false }), ['host-inexact']);
    assert.deepEqual(resolveRoofStructure(normalizeRoofStructure({ hostVolumeId: 'volume-9', hostSide: 'minZ' }), undefined).errors.map((e) => e.code), ['host-missing']);
  });

  it('says what would fit when a structure is refused', () => {
    // a 2.4 m hip dormer with 1.1 m walls on the 6:12 hip end runs into the hips
    const wide = dormer({ hostSide: 'minX', width: 4 }, hipHost);
    const [crossing] = wide.errors;
    assert.equal(crossing.code, 'crosses-face');
    assert.ok(crossing.fix.width < 4, 'a narrower width');
    assert.match(crossing.message, /It fits at \d+\.\d\d m wide/);
    assert.deepEqual(dormer({ hostSide: 'minX', width: crossing.fix.width }, hipHost).errors, [], 'and it does');
    // too tall for the ridge: narrowing doesn't help a flat roof's height, lowering the walls does
    const [tall] = dormer({ wallHeight: 2.2, roofType: 'flat', depth: 2 }).errors;
    assert.equal(tall.code, 'above-ridge');
    assert.ok(tall.fix.wallHeight < 2.2);
    assert.deepEqual(dormer({ wallHeight: tall.fix.wallHeight, roofType: 'flat', depth: 2 }).errors, []);
    // past the end of the wall: narrower about its center
    const [past] = dormer({ offset: 9 }).errors;
    assert.equal(past.code, 'outside-host');
    assert.ok(Math.abs(past.fix.width - 2) < 1e-9, `${past.fix.width}`);
    // nothing smaller helps a structure with no host
    assert.equal(resolveRoofStructure(normalizeRoofStructure({ hostVolumeId: 'volume-9', hostSide: 'minZ' }), undefined).errors[0].fix, undefined);
  });

  it('resolves to a solid (the zone descriptor shape)', () => {
    const { resolved } = dormer({});
    const solid = volumeSolid(resolved, { floorY: resolved.sillY });
    const ridge = resolved.plateY + resolved.roofHeight;
    assert.equal(isInsideSolid([0, ridge - 0.01, -3], solid), true);
    assert.equal(isInsideSolid([0, ridge + 0.01, -3], solid), false);
    assert.equal(isInsideSolid([1.1, ridge - 0.01, -3], solid), false, 'above the dormer slope near its eave');
  });
});

describe('validateRoofStructures', () => {
  const { roofZones } = createBuildingFromFootprint(RECT, {
    storyCount: 1, storyHeight: 3, roofType: 'gable', roofDirection: 'x', roofHeight: 2.5, roofPitchRise: 6, roofPitchRun: 12,
    volumes: computeFacadeLayout(RECT, {}).volumes,
  });
  const structures = normalizeRoofStructures([
    { hostVolumeId: 'volume-0', hostSide: 'minZ', offset: -4 },
    { hostVolumeId: 'volume-0', hostSide: 'minZ', offset: -3 },
    { hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: -4 },
    { hostVolumeId: 'volume-3', hostSide: 'maxZ' },
  ]);

  it('only compares where structures actually stand, not their buried backs', () => {
    const hip = createBuildingFromFootprint(RECT, {
      storyCount: 1, storyHeight: 3, roofType: 'hip', roofDirection: 'x', roofHeight: 2.5, roofPitchRise: 6, roofPitchRun: 12,
      volumes: computeFacadeLayout(RECT, {}).volumes,
    }).roofZones;
    // both rectangles run back to the middle of the roof, so they overlap there, buried
    const results = validateRoofStructures(normalizeRoofStructures([
      { hostVolumeId: 'volume-0', hostSide: 'minZ', offset: -3 },
      { hostVolumeId: 'volume-0', hostSide: 'minX', width: 1, setback: 0.5, wallHeight: 0.6 },
    ]), hip, { roofPitchRise: 6 });
    assert.deepEqual(results.map((result) => result.errors), [[], []]);
  });

  it('resolves each structure and rejects later overlaps on the same roof', () => {
    const results = validateRoofStructures(structures, roofZones, { roofPitchRise: 6 });
    assert.deepEqual(results.map((result) => result.errors.map((e) => e.code)), [[], ['overlap'], [], ['host-missing']]);
    assert.deepEqual(results.map((result) => Boolean(result.resolved)), [true, false, true, false]);
  });
});

describe('roof structure persistence', () => {
  const norm = normalizeFootprint(RECT);
  const layout = computeFacadeLayout(norm, {});
  const roofStructures = normalizeRoofStructures([
    { kind: 'dormer', hostVolumeId: 'volume-0', hostSide: 'minZ', offset: 2, roofType: 'hip', roofShape: { mode: 'height', height: 0.8 } },
    { kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', eaves: { eaveDepth: 0.2 } },
  ]);

  it('round-trips through .bld', () => {
    const saved = JSON.parse(JSON.stringify(serializeBuildingState(layout, { roofStructures })));
    const loaded = deserializeBuildingState(saved);
    assert.equal(loaded.valid, true);
    assert.deepEqual(loaded.warnings, []);
    assert.deepEqual(loaded.state.roofStructures, roofStructures);
  });

  it('drops structures whose host volume is gone, with a warning', () => {
    const saved = JSON.parse(JSON.stringify(serializeBuildingState(layout, {
      roofStructures: [...roofStructures, { id: 'structure-9', hostVolumeId: 'volume-4', hostSide: 'minX' }],
    })));
    const loaded = deserializeBuildingState(saved);
    assert.deepEqual(loaded.state.roofStructures.map((structure) => structure.id), ['structure-1', 'structure-2']);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /structure-9/);
  });

  it('keeps a structure standing on another, and drops it with its host', () => {
    const stacked = normalizeRoofStructures([
      { id: 'ground', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', setback: -2 },
      { id: 'upper', kind: 'porch', hostStructureId: 'ground', hostSide: 'maxZ' },
    ]);
    const kept = deserializeBuildingState(JSON.parse(JSON.stringify(serializeBuildingState(layout, { roofStructures: stacked }))));
    assert.deepEqual(kept.state.roofStructures.map((structure) => structure.id), ['ground', 'upper']);
    assert.deepEqual(kept.warnings, []);
    const orphaned = deserializeBuildingState(JSON.parse(JSON.stringify(serializeBuildingState(layout, {
      roofStructures: [{ ...stacked[0], hostVolumeId: 'volume-7' }, stacked[1]],
    }))));
    assert.deepEqual(orphaned.state.roofStructures, []);
    assert.equal(orphaned.warnings.length, 2);
  });

  it('loads older files without structures', () => {
    const saved = JSON.parse(JSON.stringify(serializeBuildingState(layout, {})));
    delete saved.roofStructures;
    assert.deepEqual(deserializeBuildingState(saved).state.roofStructures, []);
  });
});
