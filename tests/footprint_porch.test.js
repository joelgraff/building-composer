import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findBump, cutPart, porchStructures } from '../js/footprint-porch.js';
import { addBump, footprintProblems, moveWall, footprintWalls } from '../js/footprint-editor.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures, normalizeRoofStructure } from '../js/roof-structures.js';
import { computeFootprintMetrics } from '../js/footprint.js';

const near = (a, b, message = '') => assert.ok(Math.abs(a - b) < 1e-6, `${message} expected ${b}, got ${a}`);
const area = (ring) => computeFootprintMetrics(ring).area;

// 10 x 8, counter-clockwise; +z is the front
const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];

/** The same outline, whatever corner it starts from. */
function sameOutline(actual, expected) {
  assert.equal(actual.length, expected.length, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const start = actual.findIndex(([x, z]) => Math.abs(x - expected[0][0]) < 1e-6 && Math.abs(z - expected[0][1]) < 1e-6);
  assert.ok(start >= 0, `${JSON.stringify(actual)} doesn't have ${JSON.stringify(expected[0])}`);
  expected.forEach(([x, z], i) => {
    const [ax, az] = actual[(start + i) % actual.length];
    near(ax, x, `corner ${i} x:`);
    near(az, z, `corner ${i} z:`);
  });
}

/** Builds the house on `footprint` with the porches as records, and returns each structure's build errors. */
function buildErrors(footprint, structures) {
  const records = normalizeRoofStructures(structures);
  const { volumes } = computeFacadeLayout(footprint, {});
  const result = createBuildingFromFootprint(footprint, {
    storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
    roofEaveDepth: 0.35, volumes, roofStructures: records,
  });
  return result.roofStructures.map((entry) => entry.errors.map((problem) => problem.message));
}

describe('findBump', () => {
  it('finds the rectangle of a traced bump from its outer wall', () => {
    const bumped = addBump(RECT, 2, { start: 3, width: 4, depth: 2.4 });
    const face = footprintWalls(bumped).findIndex((wall) => Math.abs(wall.start[1] - 6.4) < 1e-9 && wall.axis === 'x');
    assert.deepEqual(findBump(bumped, face), {
      minX: -2, maxX: 2, minZ: 4, maxZ: 6.4,
    });
  });

  it('finds nothing on a plain wall or a notch', () => {
    assert.equal(findBump(RECT, 0), null);
    const notched = addBump(RECT, 2, { start: 3, width: 4, depth: -2 });
    const face = footprintWalls(notched).findIndex((wall) => Math.abs(wall.start[1] - 2) < 1e-9 && wall.axis === 'x');
    assert.equal(findBump(notched, face), null);
  });
});

describe('cutPart', () => {
  it('cuts a traced porch off the front, leaving the wall straight', () => {
    const traced = addBump(RECT, 2, { start: 3, width: 4, depth: 2.4 });
    const { footprint, porch } = cutPart(traced, { minX: -2, maxX: 2, minZ: 4, maxZ: 6.4 });
    sameOutline(footprint, RECT);
    assert.equal(porch.type, 'projecting');
    assert.equal(porch.side, 'maxZ');
    assert.deepEqual(footprintProblems(footprint), []);
  });

  it('cuts a porch traced across the whole front, the rectangle drawn past the outline', () => {
    const { footprint, porch } = cutPart(RECT, { minX: -6, maxX: 6, minZ: 1.6, maxZ: 5 });
    sameOutline(footprint, [[-5, -4], [5, -4], [5, 1.6], [-5, 1.6]]);
    assert.deepEqual(porch.rect, {
      minX: -5, maxX: 5, minZ: 1.6, maxZ: 4,
    });
  });

  it('keeps the footprint for a recessed porch traced as solid', () => {
    const { footprint, porch } = cutPart(RECT, { minX: -2, maxX: 2, minZ: 1.6, maxZ: 4.5 });
    sameOutline(footprint, RECT);
    assert.equal(porch.type, 'recess');
    assert.equal(porch.side, 'maxZ');
    assert.deepEqual(porch.openSides, ['front']);
  });

  it('opens a corner recess on its two outside faces, facing the longer one', () => {
    const { porch } = cutPart(RECT, { minX: 2, maxX: 5.5, minZ: 1.6, maxZ: 4.5 });
    assert.equal(porch.type, 'recess');
    assert.equal(porch.side, 'maxZ');
    assert.equal(porch.openSides.length, 2);
  });

  it('cuts a porch off an outline with an angled wall, keeping that wall', () => {
    // a clipped back corner, and a porch traced on the front
    const clipped = [[-5, -4], [3, -4], [5, -2], [5, 4], [-5, 4]];
    const traced = addBump(clipped, 3, { start: 3, width: 4, depth: 2.4 });
    const { footprint, porch } = cutPart(traced, { minX: -2, maxX: 2, minZ: 4, maxZ: 6.4 });
    sameOutline(footprint, clipped);
    assert.equal(porch.type, 'projecting');
    assert.equal(porch.side, 'maxZ');
    const { structures } = porchStructures(footprint, [porch]);
    assert.equal(structures.length, 1);
    assert.deepEqual(buildErrors(footprint, structures), [[]]);
  });

  it('says why when the part cannot be a porch', () => {
    assert.throws(() => cutPart(RECT, { minX: 6, maxX: 8, minZ: 0, maxZ: 2 }), /doesn't cover/);
    assert.throws(() => cutPart(RECT, { minX: -6, maxX: 6, minZ: -1, maxZ: 1 }), /in two/);
    assert.throws(() => cutPart(RECT, { minX: -1, maxX: 1, minZ: -1, maxZ: 1 }), /inside the building/);
    assert.throws(() => cutPart(RECT, { minX: -6, maxX: 6, minZ: -5, maxZ: 5 }), /whole building/);
    const withBump = addBump(RECT, 2, { start: 3, width: 4, depth: 2.4 });
    assert.throws(() => cutPart(withBump, { minX: 1, maxX: 3, minZ: 3, maxZ: 7 }), /rectangular/);
  });
});

describe('porchStructures', () => {
  it('makes a projecting porch where the part was, which the builder accepts', () => {
    const traced = addBump(RECT, 2, { start: 3, width: 4, depth: 2.4 });
    const { footprint, porch } = cutPart(traced, findBump(traced, footprintWalls(traced).findIndex((wall) => Math.abs(wall.start[1] - 6.4) < 1e-9)));
    const { structures, problems } = porchStructures(footprint, [porch]);
    assert.deepEqual(problems, []);
    assert.equal(structures.length, 1);
    const [record] = structures;
    assert.equal(record.hostVolumeId, 'volume-0');
    assert.equal(record.hostSide, 'maxZ');
    near(record.width, 4);
    near(record.depth, 2.4);
    near(record.setback, -2.4);
    near(record.offset, 0);
    assert.equal(record.fromFootprint, true);
    assert.deepEqual(buildErrors(footprint, structures), [[]]);
  });

  it('places a porch off center along its wall', () => {
    const traced = addBump(RECT, 2, { start: 1, width: 3, depth: 2 });
    const { footprint, porch } = cutPart(traced, { minX: 1, maxX: 4, minZ: 4, maxZ: 6 });
    const [record] = porchStructures(footprint, [porch]).structures;
    near(record.offset, 2.5);
    assert.deepEqual(buildErrors(footprint, [record]), [[]]);
  });

  it('makes a recessed porch that the builder accepts', () => {
    const { footprint, porch } = cutPart(RECT, { minX: -2, maxX: 2, minZ: 1.6, maxZ: 4.5 });
    const { structures } = porchStructures(footprint, [porch]);
    const [record] = structures;
    assert.equal(record.mount, 'recess');
    near(record.depth, 2.4);
    near(record.width, 4);
    assert.deepEqual(buildErrors(footprint, structures), [[]]);
  });

  it('joins porches cut one leg at a time round a corner into one wraparound', () => {
    // a 10 x 8 house traced with a 2.4 m porch across its front and 4 m down its right side
    const traced = [[-5, -4], [5, -4], [5, 0], [7.4, 0], [7.4, 6.4], [-5, 6.4]];
    const front = cutPart(traced, { minX: -6, maxX: 8, minZ: 4, maxZ: 7 });
    assert.equal(front.porch.side, 'maxZ');
    const side = cutPart(front.footprint, { minX: 5, maxX: 8, minZ: -1, maxZ: 4.5 });
    assert.equal(side.porch.side, 'maxX');
    sameOutline(side.footprint, RECT);
    const { structures, problems } = porchStructures(side.footprint, [front.porch, side.porch]);
    assert.deepEqual(problems, []);
    assert.equal(structures.length, 1);
    const [wrap] = structures;
    assert.deepEqual(wrap.wrap.walls, ['maxZ', 'maxX']);
    near(wrap.wrap.startLength, 10);
    near(wrap.wrap.endLength, 4);
    near(wrap.depth, 2.4);
    buildErrors(side.footprint, structures).forEach((errors) => assert.deepEqual(errors, []));
  });

  it('joins three legs round two corners into one wraparound, cut front, side, then back', () => {
    // a 10 x 8 house traced with a 2.4 m porch across the front, down the right side, and across the back
    const traced = [[-5, -6.4], [7.4, -6.4], [7.4, 6.4], [-5, 6.4]];
    const front = cutPart(traced, { minX: -6, maxX: 8, minZ: 4, maxZ: 7 });
    const side = cutPart(front.footprint, { minX: 5, maxX: 8, minZ: -7, maxZ: 4.5 });
    const back = cutPart(side.footprint, { minX: -6, maxX: 5.5, minZ: -7, maxZ: -4 });
    assert.deepEqual([front, side, back].map(({ porch }) => porch.side), ['maxZ', 'maxX', 'minZ']);
    sameOutline(back.footprint, RECT);
    const { structures, problems } = porchStructures(back.footprint, [front.porch, side.porch, back.porch]);
    assert.deepEqual(problems, []);
    assert.equal(structures.length, 1);
    const [wrap] = structures;
    assert.deepEqual(wrap.wrap.walls, ['maxZ', 'maxX', 'minZ']);
    near(wrap.wrap.startLength, 10);
    near(wrap.wrap.endLength, 10);
    buildErrors(back.footprint, structures).forEach((errors) => assert.deepEqual(errors, []));
  });

  it('leaves out a porch whose wall has since moved', () => {
    const traced = addBump(RECT, 2, { start: 3, width: 4, depth: 2.4 });
    const { footprint, porch } = cutPart(traced, { minX: -2, maxX: 2, minZ: 4, maxZ: 6.4 });
    const moved = moveWall(footprint, 2, -1);
    const { structures, problems } = porchStructures(moved, [porch]);
    assert.equal(structures.length, 0);
    assert.match(problems[0], /no longer stands against a wall/);
  });

  it('keeps the made-from-the-footprint mark through normalizing', () => {
    const { footprint, porch } = cutPart(RECT, { minX: -6, maxX: 6, minZ: 1.6, maxZ: 5 });
    const [record] = porchStructures(footprint, [porch]).structures;
    assert.equal(normalizeRoofStructure({ ...record, id: 'p' }).fromFootprint, true);
    assert.equal(normalizeRoofStructure({ ...record, id: 'p', fromFootprint: undefined }).fromFootprint, undefined);
    near(area(footprint), 80 - 24);
  });
});
