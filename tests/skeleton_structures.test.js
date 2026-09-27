import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint, setStraightSkeletonBuilder } from '../js/extrusion.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';
import { meshTriangles, totalArea } from './helpers/mesh.js';

// the browser build of the skeleton library, as index.html loads it
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
const { SkeletonBuilder } = createRequire(import.meta.url)('../node_modules/straight-skeleton/dist/index.js');

// an L: volume-0 is the 20 x 8 arm along x, volume-1 the 8 x 12 arm along z
const L = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]];
const VOLUMES = computeFacadeLayout(L, {}).volumes;
// one story, 6:12 hip (slope 0.5); plate at 0.6 + 3 + 0.02
const PLATE = 3.62;

function build(structures, config = {}) {
  return createBuildingFromFootprint(L, {
    storyCount: 1,
    storyHeight: 3,
    foundationDepth: 0.6,
    roofType: 'hip',
    roofPitchRise: 6,
    roofPitchRun: 12,
    volumes: VOLUMES,
    ...config,
    roofStructures: normalizeRoofStructures(structures),
  });
}

function roofArea(building) {
  let area = 0;
  building.traverse((child) => {
    if (child.isMesh && child.userData?.roofZoneId && !child.userData.structureId) {
      area += totalArea(meshTriangles(child));
    }
  });
  return area;
}

const dormer = { id: 'd', kind: 'dormer', hostVolumeId: 'volume-0', hostSide: 'minZ', offset: 2, width: 2.4, setback: 0.6 };

describe('roof structures on a continuous (straight-skeleton) hip', () => {
  before(async () => {
    await SkeletonBuilder.init();
    setStraightSkeletonBuilder(SkeletonBuilder);
  });
  after(() => setStraightSkeletonBuilder(null));

  it('describes each volume by the faces rising from its outside walls', () => {
    const zones = build([]).roofZones;
    assert.deepEqual(zones.map((zone) => zone.volumeId), ['volume-0', 'volume-1']);
    assert.ok(zones.every((zone) => zone.skeleton && !zone.exact));
    assert.deepEqual(zones[1].planes.map((plane) => plane.side).sort(), ['maxX', 'maxZ', 'minX'], 'volume-1\'s minZ side is inside the L');
    zones.forEach((zone) => assert.ok(Math.abs(zone.roofHeight - 2) < 1e-6, 'the hips over 8 m wide arms peak 2 m up'));
  });

  it('a dormer stands on its face, at the face\'s height, and cuts the roof under it', () => {
    const plain = roofArea(build([]).building);
    const { building, roofStructures } = build([dormer]);
    const [entry] = roofStructures;
    assert.deepEqual(entry.errors, []);
    const sill = entry.resolved.sillY;
    assert.ok(Math.abs(sill - (PLATE + 0.5 * 0.6)) < 1e-6, `sill ${sill}`);
    assert.ok(roofArea(building) < plain - 1, 'the roof under the dormer is removed');
  });

  it('refuses a dormer running off its face into a hip, and a porch replacing the roof', () => {
    const [offFace] = build([{ ...dormer, offset: -8.5 }]).roofStructures;
    assert.deepEqual(offFace.errors.map((e) => e.code), ['crosses-face']);
    // volume-0's back wall is inside the L short of x = 8, where the roof is volume-1's side face
    const [overValley] = build([{ ...dormer, hostSide: 'maxZ', offset: -4 }]).roofStructures;
    assert.deepEqual(overValley.errors.map((e) => e.code), ['crosses-face']);
    const [besideValley] = build([{ ...dormer, hostSide: 'maxZ', offset: 3 }]).roofStructures;
    assert.deepEqual(besideValley.errors, []);
    const [porch] = build([{
      id: 'p', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'minZ', setback: -2, depth: 2, width: 4, baseHeight: 'ground', wallHeight: 2.6,
    }]).roofStructures;
    assert.deepEqual(porch.errors.map((e) => e.code), ['host-inexact']);
  });

  it('a cupola rises through the roof from its highest point under it', () => {
    const [entry] = build([{ id: 'c', kind: 'cupola', hostVolumeId: 'volume-1', hostSide: 'maxZ', setback: 3.2, depth: 1.6, width: 1.6 }]).roofStructures;
    assert.deepEqual(entry.errors, []);
    // on the ridge of the 8 m arm, 2 m up
    assert.ok(Math.abs(entry.resolved.sillY - (PLATE + 2)) < 1e-6, `sill ${entry.resolved.sillY}`);
  });

  it('a widow\'s walk cuts the whole roof flat at one height: one L-shaped walk', () => {
    const { building, roofZones, roofWalks } = build([], { roofWalkHeight: 1 });
    roofZones.forEach((zone) => assert.ok(Math.abs(zone.roofHeight - 1) < 1e-6, zone.volumeId));
    assert.equal(roofWalks.length, 1);
    const [walk] = roofWalks;
    assert.deepEqual(walk.volumeIds, ['volume-0', 'volume-1']);
    assert.ok(Math.abs(walk.y - (PLATE + 1)) < 1e-6);
    // at 6:12 the walk is the L inset 2 m from every wall
    const area = (polygon) => Math.abs(polygon.reduce((sum, [x, z], i) => {
      const [nx, nz] = polygon[(i + 1) % polygon.length];
      return sum + x * nz - nx * z;
    }, 0)) / 2;
    assert.ok(Math.abs(walk.pieces.reduce((sum, piece) => sum + area(piece), 0) - (16 * 4 + 4 * 12)) < 1e-6, 'walk area');
    const railLength = walk.railRuns.reduce((sum, rail) => sum + Math.hypot(rail.end[0] - rail.start[0], rail.end[2] - rail.start[2]), 0);
    assert.ok(Math.abs(railLength - (16 + 4 + 12 + 12 + 4 + 16)) < 1e-6, `railing ${railLength}`);
    // the roof mesh has the same flat top, and nothing above it
    let flat = 0;
    let highest = -Infinity;
    building.traverse((child) => {
      if (child.isMesh && child.userData?.roofZoneId) {
        meshTriangles(child).forEach((tri) => {
          const ys = tri.map(([, y]) => y + child.position.y);
          highest = Math.max(highest, ...ys);
          if (ys.every((y) => Math.abs(y - (PLATE + 1)) < 1e-4)) {
            flat += area(tri.map(([x, , z]) => [x, z]));
          }
        });
      }
    });
    assert.ok(Math.abs(flat - 112) < 1e-3, `flat roof ${flat}`);
    assert.ok(highest < PLATE + 1 + 1e-4);
    // a cupola stands on it
    const [cupola] = build([{ id: 'c', kind: 'cupola', hostVolumeId: 'volume-1', hostSide: 'maxZ', setback: 3.2, depth: 1.6, width: 1.6 }], { roofWalkHeight: 1 }).roofStructures;
    assert.ok(Math.abs(cupola.resolved.sillY - (PLATE + 1)) < 1e-6);
  });
});
