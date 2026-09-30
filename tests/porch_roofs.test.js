import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout, withStructureFacades } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';
import { meshTriangles, uncoveredEdges } from './helpers/mesh.js';

// a 10 x 8 two-story house; porches project from its +Z front
const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const VOLUMES = computeFacadeLayout(RECT, {}).volumes;
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message ?? ''} expected ${b}, got ${a}`);

function build(structures, config = {}) {
  return createBuildingFromFootprint(RECT, {
    storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
    roofEaveDepth: 0.35, volumes: VOLUMES, ...config, roofStructures: normalizeRoofStructures(structures),
  });
}

function trianglesOf(result, predicate) {
  const out = [];
  result.building.traverse((child) => {
    if (child.isMesh && predicate(child.userData ?? {})) {
      meshTriangles(child).forEach((tri) => out.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  return out;
}

/** The highest surface among `triangles` over a plan point, or -Infinity. */
function heightAt(triangles, [x, z]) {
  let best = -Infinity;
  triangles.forEach(([a, b, c]) => {
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

/** No see-through edges, but the roof lift at the plate and the openings on open sides (`openPlanes`: [axis index, value]). */
function assertWatertight(result, label, openPlanes = []) {
  const tris = trianglesOf(result, (data) => !data.editorOnly);
  const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3));
  const opening = (edge) => openPlanes.some(([k, value]) => edge.every((p) => Math.abs(p[k] - value) < 1e-3));
  assert.deepEqual(uncoveredEdges(tris).filter((edge) => !lift(edge) && !opening(edge)), [], `${label}: see-through edges`);
}

// 6 m wide, projecting 2.4 m, 4:12
const hipPorch = (fields = {}) => ({
  id: 'p', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', width: 6, setback: -2.4, depth: 2.4, baseHeight: 'ground', wallHeight: 2.8,
  roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'], ...fields,
});

describe('hip porch roofs', () => {
  it('run level along the house wall and hip down at the front and ends, with no slope back to the wall', () => {
    const result = build([hipPorch()]);
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, []);
    const roof = trianglesOf(result, (data) => data.structureId === 'p' && data.structurePart === 'roof');
    const slope = 4 / 12;
    // along the wall, from end hip to end hip, at its full height
    [-0.5, 0, 0.5].forEach((x) => near(heightAt(roof, [x, 4.001]), resolved.plateY + slope * 2.399, `level along the wall at x = ${x}`));
    // rising toward the wall: no back slope
    assert.ok(heightAt(roof, [0, 4.5]) > heightAt(roof, [0, 5.5]), 'higher near the wall');
    // the ends hip down
    near(heightAt(roof, [2.9, 4.5]), resolved.plateY + slope * 0.1, 'the end hip');
    near(resolved.roofHeight, slope * 2.4);
    assertWatertight(result, 'hip porch');
  });

  it('a narrow one peaks in a ridge running back into the wall', () => {
    const result = build([hipPorch({ width: 2 })]);
    const roof = trianglesOf(result, (data) => data.structureId === 'p' && data.structurePart === 'roof');
    const { plateY } = result.roofStructures[0].resolved;
    // the end hips meet 1 m in; from there the ridge runs level to the wall
    near(heightAt(roof, [0, 4.1]), plateY + 1 / 3);
    near(heightAt(roof, [0, 5.3]), plateY + 1 / 3);
    assertWatertight(result, 'narrow hip porch');
  });

  it('an upper porch on posts breaks the same way', () => {
    const result = build([hipPorch({ baseHeight: -3, wallHeight: 2.4, support: 'posts' })]);
    assert.deepEqual(result.roofStructures[0].errors, []);
    const { resolved } = result.roofStructures[0];
    assert.deepEqual(resolved.eaveRoof.eaveSides.sort(), ['maxX', 'maxZ', 'minX']);
    // (its floor is a sheet on posts, open at its edges; the roof is closed)
    const tris = trianglesOf(result, (data) => !data.editorOnly);
    const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3));
    assert.deepEqual(uncoveredEdges(tris).filter((edge) => !lift(edge) && edge.some((p) => p[1] > resolved.sillY + 1e-3)), []);
  });

  it('one standing on a roof, with nothing behind it, keeps its full hip', () => {
    const result = build([{
      kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'minZ', setback: 0, width: 4, depth: 4, baseHeight: 0, wallHeight: 2.4, roofType: 'hip', openSides: [],
    }], { roofType: 'flat' });
    assert.equal(result.roofStructures[0].resolved.eaveRoof, null);
  });
});

describe('a porch roof rising through the host eave', () => {
  // a story-and-a-half Cape Cod: plate at 0.6 + 2.6 + 0.6, 12:12, a 0.2 m eave; an entry porch 2 m wide on its +Z front
  const cape = (structures) => build(structures, {
    storyCount: 1, storyHeight: 2.6, kneeWallHeight: 0.6, roofPitchRise: 12, roofEaveDepth: 0.2, roofRakeDepth: 0.1,
  });
  const entry = {
    id: 'e', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', width: 2, setback: -1.2, depth: 1.2, baseHeight: 'ground', wallHeight: 2.3,
    roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 12 }, openSides: ['front', 'left', 'right'],
  };

  it('meets the host roof in valleys, the host eave running on either side, with no notch', () => {
    const result = cape([entry]);
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, []);
    const zone = result.roofZones[0];
    assert.ok(resolved.plateY + resolved.roofHeight > zone.baseY, 'the porch ridge is above the host eave');
    assert.equal(trianglesOf(result, (data) => data.structurePart === 'eave-caps').length, 0, 'no caps');
    const hostRoof = trianglesOf(result, (data) => Boolean(data.roofType));
    // over the eave (between the wall and its edge): gone under the porch ridge, still there beside its low eaves
    assert.equal(heightAt(hostRoof, [0, 4.1]), -Infinity, 'cut where the porch roof is above it');
    assert.ok(heightAt(hostRoof, [0.95, 4.1]) > -Infinity, 'kept beside it, above the porch eave');
    assert.ok(heightAt(hostRoof, [1.5, 4.1]) > -Infinity, 'kept past it');
    assertWatertight(result, 'entry porch', [[2, 5.2], [0, -1], [0, 1]]);
  });

  it('is flagged: builders usually keep a porch roof below the eave', () => {
    assert.deepEqual(cape([entry]).roofStructures[0].warnings.map((w) => w.code), ['above-eave']);
    const tucked = cape([{ ...entry, wallHeight: 2.1, roofShape: { mode: 'slope', pitchRise: 8 } }]).roofStructures[0];
    assert.deepEqual(tucked.warnings, [], 'one kept below the eave');
  });
});

describe('entry hoods', () => {
  const hood = (fields = {}) => ({ id: 'h', kind: 'hood', hostVolumeId: 'volume-0', hostSide: 'maxZ', ...fields });

  it('are a roof on brackets over the door: no floor, posts, walls, or railings', () => {
    const result = build([hood()]);
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, []);
    assert.equal(resolved.support, 'brackets');
    const part = (name) => trianglesOf(result, (data) => data.structureId === 'h' && data.structurePart === name);
    assert.equal(part('floor').length, 0);
    assert.equal(part('walls').length, 0);
    assert.ok(part('roof').length > 0);
    assert.ok(part('ceiling').length > 0, 'a ceiling under it');
    // the brackets hang from its plate down the wall
    const brackets = part('posts').flat();
    assert.ok(brackets.length > 0);
    assert.ok(Math.max(...brackets.map(([, y]) => y)) <= resolved.plateY + 1e-6, 'from the plate');
    assert.ok(Math.min(...brackets.map(([, y]) => y)) >= resolved.plateY - 0.9 - 1e-6, 'down the wall');
    assert.ok(brackets.every(([, , z]) => z >= 4 - 1e-6 && z <= 4.9 + 1e-6), 'between the wall and the front');
    near(resolved.plateY, 0.6 + 2.4, 'its roof 2.4 m above the floor');
    const layout = withStructureFacades(computeFacadeLayout(RECT, {}), result.structureFacades);
    assert.deepEqual(layout.railRuns, []);
    assert.deepEqual(layout.structureWallRuns, []);
    assertWatertight(result, 'entry hood', [[2, 4.9]]);
  });

  it('must project from its wall, no further than brackets carry', () => {
    const code = (fields) => build([hood(fields)]).roofStructures[0].errors.map((e) => e.code);
    assert.deepEqual(code({ setback: 0 }), ['hood-placement']);
    assert.deepEqual(code({ setback: -2, depth: 2 }), ['brackets-too-deep']);
    assert.deepEqual(code({ roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 4 } }), []);
  });
});


describe('porches on a flat roof over several volumes', () => {
  it('have a host on every volume and side (the flat roof reports a zone per volume)', () => {
    // the app's "narrow rear lean-to" footprint, flat roofed (the app's default)
    const leanTo = [[-10, -7], [10, -7], [10, 3], [4, 3], [4, 10], [-4, 10], [-4, 3], [-10, 3]];
    const volumes = computeFacadeLayout(leanTo, { volumeSplit: 'auto' }).volumes;
    assert.equal(volumes.length, 2);
    const porch = (hostVolumeId, hostSide) => ({
      id: 'p', kind: 'porch', hostVolumeId, hostSide, offset: 0, width: 3, setback: -2, depth: 2, baseHeight: 'ground', wallHeight: 2.6, roofType: 'shed',
    });
    const result = (structure) => createBuildingFromFootprint(leanTo, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.7, roofType: 'flat', volumes, roofStructures: normalizeRoofStructures([structure]),
    });
    assert.equal(result(porch('volume-0', 'minZ')).roofZones.length, 2);
    volumes.forEach((volume) => ['minX', 'maxX', 'maxZ'].forEach((side) => {
      if (volume.id === 'volume-0' && side === 'maxZ') {
        return; // the main block's rear, behind the lean-to
      }
      assert.deepEqual(result(porch(volume.id, side)).roofStructures[0].errors, [], `${volume.id} ${side}`);
    }));
  });
});
