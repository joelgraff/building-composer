import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint, setStraightSkeletonBuilder } from '../js/extrusion.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';
import { meshTriangles, totalArea, uncoveredEdges } from './helpers/mesh.js';

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

/** No see-through edges, but the roof lift at the plate and the porches' open sides (`openPlanes`: [axis index, value]). */
function assertWatertight(result, label, openPlanes = []) {
  const tris = [];
  result.building.traverse((child) => {
    if (child.isMesh && !child.userData?.editorOnly) {
      meshTriangles(child).forEach((tri) => tris.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3));
  const opening = (edge) => openPlanes.some(([k, value]) => edge.every((p) => Math.abs(p[k] - value) < 1e-3));
  assert.deepEqual(uncoveredEdges(tris).filter((edge) => !lift(edge) && !opening(edge)), [], `${label}: see-through edges`);
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

  it('refuses a dormer running off its face into a hip or valley', () => {
    const [offFace] = build([{ ...dormer, offset: -8.5 }]).roofStructures;
    assert.deepEqual(offFace.errors.map((e) => e.code), ['crosses-face']);
    // volume-0's back wall is inside the L short of x = 8, where the roof is volume-1's side face
    const [overValley] = build([{ ...dormer, hostSide: 'maxZ', offset: -4 }]).roofStructures;
    assert.deepEqual(overValley.errors.map((e) => e.code), ['crosses-face']);
    const [besideValley] = build([{ ...dormer, hostSide: 'maxZ', offset: 3 }]).roofStructures;
    assert.deepEqual(besideValley.errors, []);
  });

  describe('porches', () => {
    const porch = (fields) => ({
      id: 'p', kind: 'porch', hostVolumeId: 'volume-0', roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 2 }, ...fields,
    });
    const twoStory = (structures) => build(structures, { storyCount: 2 });

    it('a ground porch and a porch on posts stand against the wall and meet the roof above them', () => {
      const ground = twoStory([porch({
        hostSide: 'minZ', setback: -2.4, depth: 2.4, width: 4.8, baseHeight: 'ground', wallHeight: 2.6, openSides: ['front', 'left', 'right'],
      })]);
      assert.deepEqual(ground.roofStructures[0].errors, []);
      assertWatertight(ground, 'ground porch', [[2, -2.4], [0, 7.6], [0, 12.4]]);
      const upper = twoStory([porch({
        hostSide: 'minZ', setback: -2.4, depth: 2.4, width: 3.6, baseHeight: -3, wallHeight: 2.4, openSides: ['front', 'left', 'right'], support: 'posts',
      })]);
      assert.deepEqual(upper.roofStructures[0].errors, []);
      assert.equal(upper.roofStructures[0].resolved.support, 'posts');
      assertWatertight(upper, 'upper porch', [[2, -2.4], [0, 8.2], [0, 11.8]]);
    });

    it('a porch standing on the plate across the valley replaces the roof on every face under it', () => {
      // on volume-0's inner (maxZ) side short of x = 8, astride the valley from (8, 8) to (4, 4)
      const result = build([porch({
        hostSide: 'maxZ', offset: -4, setback: 0, depth: 3, width: 4, baseHeight: 0, wallHeight: 2.4, openSides: [],
      })]);
      const [entry] = result.roofStructures;
      assert.deepEqual(entry.errors, []);
      assert.ok(entry.resolved.removedRoof.length >= 2, 'more than one roof face');
      assertWatertight(result, 'porch across the valley');
    });

    it('a gable porch on the plate with an open front', () => {
      const result = build([porch({
        hostSide: 'minZ', offset: 3, setback: 0, depth: 3, width: 4, baseHeight: 0, wallHeight: 2.4, roofType: 'gable', roofShape: null, openSides: ['front'],
      })]);
      assert.deepEqual(result.roofStructures[0].errors, []);
      assertWatertight(result, 'gable porch', [[2, 0]]);
    });
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

  it('has eaves all round: the roof carried out past the walls, a fascia, and a soffit back to the walls', () => {
    const eave = 0.5;
    const result = build([], { roofEaveDepth: eave });
    const tris = [];
    result.building.traverse((child) => {
      if (child.isMesh && child.userData?.roofType) {
        meshTriangles(child).forEach((tri) => tris.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
      }
    });
    const xs = tris.flat().map(([x]) => x);
    const zs = tris.flat().map(([, , z]) => z);
    assert.ok(Math.abs(Math.min(...xs) + eave) < 1e-6 && Math.abs(Math.max(...xs) - (20 + eave)) < 1e-6, 'out past the walls in x');
    assert.ok(Math.abs(Math.min(...zs) + eave) < 1e-6 && Math.abs(Math.max(...zs) - (20 + eave)) < 1e-6, 'and in z');
    // the eave line is below the plate by the pitch over the overhang, the fascia below that
    const ys = tris.flat().map(([, y]) => y);
    const eaveY = PLATE - 0.5 * eave;
    assert.ok(Math.abs(Math.min(...ys) - (eaveY - 0.1524)) < 1e-6, `down to the fascia's foot: ${Math.min(...ys)}`);
    // the zones know the eave, along the outside stretches of each side
    const [main, arm] = result.roofZones;
    assert.equal(main.overhang.minZ, eave);
    assert.deepEqual(main.eaves.partial.maxZ.map(({ a0, a1 }) => [a0, a1]), [[8, 20]], 'only past the arm');
    assert.equal(arm.overhang.maxZ, eave);
    // one closed shell
    const all = [];
    result.building.traverse((child) => {
      if (child.isMesh) meshTriangles(child).forEach((tri) => all.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    });
    const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3));
    assert.deepEqual(uncoveredEdges(all).filter((edge) => !lift(edge)), []);
    // and the walk and structures still work on it
    const walked = build([], { roofEaveDepth: eave, roofWalkHeight: 1 });
    assert.equal(walked.roofWalks.length, 1);
  });
});

