import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout, withStructureFacades } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures, normalizeRoofStructure } from '../js/roof-structures.js';
import { meshTriangles, totalArea, uncoveredEdges } from './helpers/mesh.js';

// a 12 x 10 one-story house (plate at 0.6 + 2.9), gable along x, 0.5 m eaves; the recess opens on its +Z front
const RECT = [[-6, -5], [6, -5], [6, 5], [-6, 5]];
const LAYOUT = computeFacadeLayout(RECT, {});
const FOUNDATION = 0.6;
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message ?? ''} expected ${b}, got ${a}`);

const recess = (fields = {}) => ({
  id: 'r', kind: 'porch', mount: 'recess', hostVolumeId: 'volume-0', hostSide: 'maxZ', setback: 0, depth: 2.4, width: 3, offset: 0,
  baseHeight: 'ground', wallHeight: 2.6, roofType: 'flat', openSides: ['front'], ...fields,
});
// at the right-hand (+X) corner, open on the front and the side
const corner = { width: 4, offset: 4, openSides: ['front', 'right'] };

function build(structures, config = {}) {
  const result = createBuildingFromFootprint(RECT, {
    storyCount: 1, storyHeight: 2.9, foundationDepth: FOUNDATION, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
    roofEaveDepth: 0.5, volumes: LAYOUT.volumes, facadeLayout: LAYOUT, ...config, roofStructures: normalizeRoofStructures(structures),
  });
  return { result, layout: withStructureFacades(LAYOUT, result.structureFacades) };
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

function assertWatertight(result, label) {
  // facade panels sit proud of the walls as a skin; the shell is the rest
  const tris = trianglesOf(result, (data) => data.bodyPart !== 'facade-panel' && !data.editorOnly);
  const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3 || Math.abs(p[1] - zone.wallTopY) < 1e-3));
  assert.deepEqual(uncoveredEdges(tris).filter((edge) => !lift(edge)), [], `${label}: see-through edges`);
}

describe('porches recessed into the house', () => {
  it('cut the host walls and facade panels away across the opening, leaving the roof whole', () => {
    const plain = build([]).result;
    const { result } = build([recess()]);
    const [entry] = result.roofStructures;
    assert.deepEqual(entry.errors, []);
    const { resolved } = entry;
    assert.deepEqual(resolved.bounds, { minX: -1.5, maxX: 1.5, minZ: 2.6, maxZ: 5 });
    // sample the opening: no host wall or facade panel covers any point of it (the porch's own railing stands in it)
    const hostBody = trianglesOf(result, (data) => Boolean(data.bodyPart) && data.bodyPart !== 'railing');
    const covers = ([a, b, c], [x, y]) => {
      if (![a, b, c].every((p) => Math.abs(p[2] - 5) < 0.1)) return false;
      const d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (Math.abs(d) < 1e-12) return false;
      const u = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / d;
      const v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / d;
      return u > 1e-9 && v > 1e-9 && u + v < 1 - 1e-9;
    };
    [-1.2, 0, 1.2].forEach((x) => [resolved.sillY + 0.3, resolved.sillY + 1.3, resolved.plateY - 0.2].forEach((y) => {
      assert.ok(!hostBody.some((tri) => covers(tri, [x, y])), `the host still covers (${x}, ${y.toFixed(2)}) of the opening`);
    }));
    assert.ok(hostBody.some((tri) => covers(tri, [-4, resolved.sillY + 1])), 'the wall beside it stays');
    const roofArea = (r) => totalArea(trianglesOf(r, (data) => Boolean(data.roofType)));
    near(roofArea(result), roofArea(plain), 'the roof');
    assertWatertight(result, 'mid-wall recess');
  });

  it('has its back and side walls as facade surfaces, a ceiling, and a railing across the front', () => {
    const { result, layout } = build([recess()]);
    const { resolved } = result.roofStructures[0];
    assert.deepEqual(layout.structureWallRuns.map((run) => run.wall).sort(), ['back', 'left', 'right']);
    const back = layout.structureWallRuns.find((run) => run.wall === 'back');
    near(back.area, 3 * 2.6, 'the back wall, where the door goes');
    const ceiling = trianglesOf(result, (data) => data.structurePart === 'ceiling');
    near(totalArea(ceiling), 3 * 2.4);
    ceiling.flat().forEach(([, y]) => near(y, resolved.plateY));
    assert.deepEqual(layout.railRuns.map((rail) => rail.wall), ['front']);
    assert.equal(trianglesOf(result, (data) => data.structurePart === 'posts').length, 0, 'no post mid-wall: the walls either side hold it');
    assert.equal(trianglesOf(result, (data) => data.structurePart === 'floor').length, 0, 'the foundation top is the floor');
  });

  it('at a corner, is open on both walls with a post at the corner', () => {
    const { result, layout } = build([recess(corner)]);
    assert.deepEqual(result.roofStructures[0].errors, []);
    assert.deepEqual(layout.structureWallRuns.map((run) => run.wall).sort(), ['back', 'left']);
    assert.deepEqual(layout.railRuns.map((rail) => rail.wall).sort(), ['front', 'right']);
    const posts = trianglesOf(result, (data) => data.structurePart === 'posts').flat();
    assert.ok(posts.length > 0);
    // along the open sides (a 4 m front takes one midway), and one at the corner
    posts.forEach(([x, , z]) => assert.ok(x >= 6 - 0.21 || z >= 5 - 0.21, `post on an open side, not (${x}, ${z})`));
    assert.ok(posts.some(([x, , z]) => x >= 6 - 0.21 && z >= 5 - 0.21), 'a post at the corner');
    assertWatertight(result, 'corner recess');
    assertWatertight(build([recess(corner)], { storyCount: 2 }).result, 'corner recess under a second story');
  });

  it('closes the host wall down to the eave soffit where the ceiling is above it', () => {
    const { result } = build([recess({ wallHeight: 2.85 })]);
    const header = trianglesOf(result, (data) => data.structurePart === 'header');
    assert.ok(header.length > 0);
    header.flat().forEach(([, , z]) => near(z, 5, 'on the wall line'));
    assert.equal(trianglesOf(build([recess({ wallHeight: 2 })]).result, (data) => data.structurePart === 'header').length, 0, 'none below the soffit');
    assertWatertight(result, 'ceiling above the soffit');
  });

  it('can be an upper-story loggia, with its own floor', () => {
    const { result } = build([recess({ baseHeight: -2.9, wallHeight: 2.5 })], { storyCount: 2 });
    const [entry] = result.roofStructures;
    assert.deepEqual(entry.errors, []);
    near(entry.resolved.sillY, FOUNDATION + 2.9);
    const floor = trianglesOf(result, (data) => data.structurePart === 'floor');
    near(totalArea(floor), 3 * 2.4);
    assertWatertight(result, 'loggia');
  });

  it('reports what makes a recess unplaceable', () => {
    const code = (fields) => build([recess(fields)]).result.roofStructures[0].errors.map((e) => e.code);
    assert.deepEqual(code({ wallHeight: 4 }), ['recess-too-tall']);
    assert.deepEqual(code({ setback: 0.5 }), ['recess-placement']);
    assert.deepEqual(code({ depth: 11 }), ['outside-host']);
    assert.deepEqual(code({ baseHeight: null }), ['recess-needs-base']);
    assert.equal(normalizeRoofStructure(recess()).mount, 'recess');
    // on an L, the stretch of wall shared with the other volume is inside the house
    const L = [[0, 0], [12, 0], [12, 8], [6, 8], [6, 14], [0, 14]];
    const volumes = computeFacadeLayout(L, {}).volumes;
    const main = volumes.find((volume) => volume.maxZ - volume.minZ < 9);
    const onL = (offset) => createBuildingFromFootprint(L, {
      storyCount: 1, storyHeight: 2.9, roofType: 'gable', roofPitchRise: 8, volumes,
      roofStructures: normalizeRoofStructures([recess({ hostVolumeId: main.id, offset })]),
    }).roofStructures[0].errors.map((e) => e.code);
    assert.deepEqual(onL(-3), ['recess-not-outside'], 'opening into the wing');
    assert.deepEqual(onL(3), [], 'on the outside stretch');
  });
});
