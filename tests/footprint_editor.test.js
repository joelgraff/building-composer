import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  openRing, footprintWalls, moveCorner, insertCorner, deleteCorner, moveWall, addBump, straightenWall, resquare,
  snapPoint, snapWallOffset, footprintProblems, createFootprintEditor, edit, undo, redo,
  toGameFrame, toComposerFrame, recenter, MIN_WALL, setWallLength, insetOutline, outlineDeviation,
} from '../js/footprint-editor.js';
import { normalizeFootprint, computeFootprintMetrics } from '../js/footprint.js';

const near = (a, b, tolerance = 1e-6, message = '') => assert.ok(Math.abs(a - b) < tolerance, `${message} expected ${b}, got ${a}`);
const samePoints = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  actual.forEach((point, i) => {
    near(point[0], expected[i][0], tolerance, `corner ${i} x:`);
    near(point[1], expected[i][1], tolerance, `corner ${i} z:`);
  });
};
const area = (ring) => computeFootprintMetrics(ring).area;

// 10 x 8, counter-clockwise as Composer expects (positive signed area)
const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
// an L: the rectangle with its +x, +z quarter taken out
const L = [[-5, -4], [5, -4], [5, 0], [0, 0], [0, 4], [-5, 4]];

describe('footprintWalls', () => {
  it('gives each wall its length, axis, and outward normal', () => {
    const walls = footprintWalls(RECT);
    assert.deepEqual(walls.map((wall) => wall.length), [10, 8, 10, 8]);
    assert.deepEqual(walls.map((wall) => wall.axis), ['x', 'z', 'x', 'z']);
    samePoints(walls.map((wall) => wall.normal), [[0, -1], [1, 0], [0, 1], [-1, 0]]);
  });

  it('points normals out for a clockwise outline too', () => {
    const walls = footprintWalls([...RECT].reverse());
    // the reversed ring's first wall is the top one, (-5, 4) to (5, 4): out is +z
    samePoints([walls[0].normal], [[0, 1]]);
  });

  it('marks an angled wall as on no axis', () => {
    const walls = footprintWalls([[-5, -4], [5, -4], [5, 4], [-3, 4], [-5, 2]]);
    assert.equal(walls[3].axis, null);
  });

  it('drops a closing corner that repeats the first', () => {
    assert.equal(openRing([...RECT, RECT[0]]).length, 4);
  });
});

describe('corner operations', () => {
  it('moves a corner and leaves its input alone', () => {
    const moved = moveCorner(RECT, 2, [6, 5]);
    samePoints(moved, [[-5, -4], [5, -4], [6, 5], [-5, 4]]);
    samePoints(RECT, [[-5, -4], [5, -4], [5, 4], [-5, 4]]);
  });

  it('inserts a corner on a wall at the nearest point, as the next corner', () => {
    const inserted = insertCorner(RECT, 0, [1, -3]);
    samePoints(inserted, [[-5, -4], [1, -4], [5, -4], [5, 4], [-5, 4]]);
  });

  it('keeps an inserted corner clear of the wall ends', () => {
    const inserted = insertCorner(RECT, 0, [-20, -4]);
    assert.ok(inserted[1][0] > -5);
  });

  it('deletes a corner, joining its walls, but keeps at least three', () => {
    samePoints(deleteCorner(RECT, 2), [[-5, -4], [5, -4], [-5, 4]]);
    assert.throws(() => deleteCorner([[0, 0], [1, 0], [0, 1]], 0), RangeError);
  });

  it('refuses a corner or wall that is not there', () => {
    assert.throws(() => moveCorner(RECT, 4, [0, 0]), RangeError);
    assert.throws(() => insertCorner(RECT, -1, [0, 0]), RangeError);
  });
});

describe('moveWall', () => {
  it('moves a wall out, its neighbors keeping their directions', () => {
    samePoints(moveWall(RECT, 1, 2), [[-5, -4], [7, -4], [7, 4], [-5, 4]]);
  });

  it('moves a wall in with a negative offset', () => {
    samePoints(moveWall(RECT, 0, -1), [[-5, -3], [5, -3], [5, 4], [-5, 4]]);
  });

  it('slides the corners of an L along the walls either side', () => {
    // the notch wall at z = 0, from (5, 0) to (0, 0), moved out (toward +z) by 1
    const moved = moveWall(L, 2, 1);
    samePoints(moved, [[-5, -4], [5, -4], [5, 1], [0, 1], [0, 4], [-5, 4]]);
    assert.deepEqual(footprintProblems(moved), []);
  });

  it('adds a joining wall where a neighbor runs in line with the moved wall', () => {
    // a corner put in the middle of the front wall: moving its left half out makes a step
    const split = insertCorner(RECT, 0, [0, -4]);
    const moved = moveWall(split, 0, 1);
    samePoints(moved, [[-5, -5], [0, -5], [0, -4], [5, -4], [5, 4], [-5, 4]]);
    near(area(moved), 80 + 5);
  });

  it('keeps an angled neighbor at its angle', () => {
    const clipped = [[-5, -4], [5, -4], [5, 2], [3, 4], [-5, 4]];
    const moved = moveWall(clipped, 1, 1);
    const walls = footprintWalls(moved);
    // the clipped corner's wall still runs at 135 degrees
    near(walls[2].angle, 135, 1e-6);
    near(moved[1][0], 6);
  });
});

describe('addBump', () => {
  it('adds a bump-out in the middle of a wall', () => {
    const bumped = addBump(RECT, 0, { start: 3, width: 4, depth: 2 });
    samePoints(bumped, [[-5, -4], [-2, -4], [-2, -6], [2, -6], [2, -4], [5, -4], [5, 4], [-5, 4]]);
    near(area(bumped), 80 + 8);
    assert.deepEqual(footprintProblems(bumped), []);
  });

  it('cuts a notch with a negative depth', () => {
    const notched = addBump(RECT, 2, { start: 2, width: 3, depth: -1.5 });
    near(area(notched), 80 - 4.5);
    assert.deepEqual(footprintProblems(notched), []);
  });

  it('joins a bump reaching the wall end to the wall beside it', () => {
    samePoints(addBump(RECT, 0, { start: 0, width: 4, depth: 2 }), [[-5, -6], [-1, -6], [-1, -4], [5, -4], [5, 4], [-5, 4]]);
    samePoints(addBump(RECT, 0, { start: 6, width: 4, depth: -2 }), [[-5, -4], [1, -4], [1, -2], [5, -2], [5, 4], [-5, 4]]);
  });

  it('moves the whole wall when the bump spans it', () => {
    samePoints(addBump(RECT, 0, { start: 0, width: 10, depth: 2 }), [[-5, -6], [5, -6], [5, 4], [-5, 4]]);
  });

  it('refuses a bump that does not fit or is too small', () => {
    assert.throws(() => addBump(RECT, 0, { start: 8, width: 4, depth: 1 }), RangeError);
    assert.throws(() => addBump(RECT, 0, { start: 1, width: MIN_WALL / 2, depth: 1 }), RangeError);
  });

  it('leaves corners it did not touch, even in a straight line', () => {
    const split = insertCorner(RECT, 2, [0, 4]);
    const bumped = addBump(split, 0, { start: 3, width: 4, depth: 1 });
    assert.ok(bumped.some(([x, z]) => Math.abs(x) < 1e-9 && Math.abs(z - 4) < 1e-9));
  });
});

describe('straightenWall', () => {
  it('turns a wall a little off square onto the axis through its middle', () => {
    const skewed = [[-5, -4], [5, -3.6], [5, 4], [-5, 4]];
    const straight = straightenWall(skewed, 0);
    samePoints(straight, [[-5, -3.8], [5, -3.8], [5, 4], [-5, 4]]);
    assert.equal(footprintWalls(straight)[0].axis, 'x');
  });
});

describe('resquare', () => {
  // a traced rectangle, a few centimeters and a degree off, with a 10 cm tracing jog
  const traced = [[-5.02, -4.01], [0, -3.99], [0, -3.89], [5.03, -3.92], [4.98, 4.02], [-4.97, 3.98]];

  it('squares a traced outline to the axes, where it was', () => {
    const squared = resquare(traced);
    assert.equal(squared.length, 4);
    footprintWalls(squared).forEach((wall) => assert.ok(wall.axis, `wall ${wall.index} is off square`));
    const before = computeFootprintMetrics(traced).centroid;
    const after = computeFootprintMetrics(squared).centroid;
    near(after.x, before.x, 0.05);
    near(after.z, before.z, 0.05);
  });

  it('keeps a jog the defaults drop, with a smaller minimum', () => {
    const keptJog = resquare(traced, { minEdge: 0.05, align: 0.05 });
    assert.equal(keptJog.length, 6);
  });

  it('keeps the winding', () => {
    assert.ok(computeFootprintMetrics(resquare(traced)).signedArea > 0);
  });
});

describe('snapPoint', () => {
  const neighbor = [[6, -4], [12, -4], [12, 4], [6, 4]];

  it('snaps to a neighbor corner first', () => {
    const { point, snaps } = snapPoint([6.1, 3.9], { neighbors: [neighbor] });
    samePoints([point], [[6, 4]]);
    assert.equal(snaps[0].kind, 'neighbor-corner');
  });

  it('snaps onto a neighbor wall (a party wall)', () => {
    const { point, snaps } = snapPoint([5.85, 1.3], { neighbors: [neighbor] });
    samePoints([point], [[6, 1.3]]);
    assert.equal(snaps[0].kind, 'neighbor-wall');
  });

  it('squares a dragged corner with the corners either side', () => {
    // corner 2 of the rectangle dragged near (5, 4): both walls come back square
    const { point, snaps } = snapPoint([5.12, 4.2], { footprint: RECT, corner: 2 });
    samePoints([point], [[5, 4]]);
    assert.deepEqual(snaps.map((snap) => snap.kind).sort(), ['square-x', 'square-z']);
  });

  it('puts a coordinate with nothing to square to on the grid', () => {
    const { point } = snapPoint([7.33, 4.02], { footprint: RECT, corner: 2 });
    samePoints([point], [[7.35, 4]]);
  });

  it('leaves the point alone with no grid and nothing near', () => {
    samePoints([snapPoint([7.33, 9.01], { grid: 0 }).point], [[7.33, 9.01]]);
  });
});

describe('snapWallOffset', () => {
  it('snaps a moved wall onto a parallel neighbor wall beside it', () => {
    const neighbor = [[6, -4], [12, -4], [12, 4], [6, 4]];
    const { offset, snaps } = snapWallOffset(RECT, 1, 0.8, { neighbors: [neighbor] });
    near(offset, 1);
    assert.equal(snaps[0].kind, 'neighbor-wall');
  });

  it('ignores a parallel wall that does not overlap it', () => {
    const faraway = [[6, 20], [12, 20], [12, 28], [6, 28]];
    const { offset, snaps } = snapWallOffset(RECT, 1, 0.83, { neighbors: [faraway] });
    near(offset, 0.85);
    assert.equal(snaps[0].kind, 'grid');
  });
});

describe('footprintProblems', () => {
  it('passes a good footprint', () => {
    assert.deepEqual(footprintProblems(RECT), []);
    assert.deepEqual(footprintProblems(L), []);
  });

  it('reports crossing walls', () => {
    assert.ok(footprintProblems([[-5, -4], [5, 4], [5, -4], [-5, 4]]).some((problem) => /self-intersection/.test(problem)));
  });

  it('reports the wrong winding', () => {
    assert.ok(footprintProblems([...RECT].reverse()).some((problem) => /counter-clockwise/.test(problem)));
    assert.deepEqual(footprintProblems([...RECT].reverse(), { expectedWinding: 'CW' }), []);
  });

  it('reports a wall shorter than the minimum', () => {
    const jog = [[-5, -4], [5, -4], [5, 0], [5.1, 0], [5.1, 4], [-5, 4]];
    assert.ok(footprintProblems(jog).some((problem) => /Wall 3 is 0\.10 m long/.test(problem)));
  });
});

describe('the editor', () => {
  it('records edits for undo and redo', () => {
    let editor = createFootprintEditor(RECT);
    editor = edit(editor, moveWall(editor.footprint, 1, 2));
    editor = edit(editor, addBump(editor.footprint, 0, { start: 3, width: 4, depth: 1 }));
    assert.equal(editor.past.length, 2);
    editor = undo(editor);
    samePoints(editor.footprint, [[-5, -4], [7, -4], [7, 4], [-5, 4]]);
    editor = undo(editor);
    samePoints(editor.footprint, RECT);
    assert.equal(undo(editor), editor);
    editor = redo(redo(editor));
    near(area(editor.footprint), 96 + 4);
    assert.equal(redo(editor), editor);
  });

  it('drops redo after a new edit, and adds no step for an edit that changes nothing', () => {
    let editor = edit(createFootprintEditor(RECT), moveWall(RECT, 1, 2));
    editor = undo(editor);
    editor = edit(editor, moveWall(editor.footprint, 0, -1));
    assert.equal(editor.future.length, 0);
    assert.equal(edit(editor, editor.footprint.map((point) => [...point])), editor);
  });

  it('keeps the current problems', () => {
    let editor = createFootprintEditor(RECT);
    editor = edit(editor, moveCorner(editor.footprint, 2, [-6, -6]));
    assert.ok(editor.problems.length > 0);
    editor = undo(editor);
    assert.deepEqual(editor.problems, []);
  });
});

describe('frames and placement', () => {
  const placement = { source: 'dixon_dem', id: '115768678', rotation: 0.3, center: [508.1, -212.7] };

  it('goes to the game frame and back', () => {
    const game = toGameFrame(L, placement);
    samePoints(toComposerFrame(game, placement), L);
  });

  it('keeps unmoved corners where they were in the game after an edit re-centers the footprint', () => {
    // move the +x wall out 3 m: the centroid shifts, and Composer re-centers on it
    const edited = moveWall(RECT, 1, 3);
    const { footprint, placement: moved } = recenter(edited, placement);
    near(computeFootprintMetrics(footprint).centroid.x, 0);
    near(computeFootprintMetrics(footprint).centroid.z, 0);
    // the -x wall's corners didn't move: they're at the same game points
    const before = toGameFrame([RECT[0], RECT[3]], placement);
    const after = toGameFrame([footprint[0], footprint[3]], moved);
    samePoints(after, before);
  });

  it('agrees with the re-centering Composer does on load', () => {
    const edited = addBump(RECT, 0, { start: 1, width: 3, depth: 2 });
    const { footprint } = recenter(edited, placement);
    const loaded = normalizeFootprint(edited);
    samePoints(footprint, openRing(loaded));
  });

  it('re-centers without a placement', () => {
    const { footprint, placement: none } = recenter(moveWall(RECT, 1, 3));
    assert.equal(none, undefined);
    near(computeFootprintMetrics(footprint).centroid.x, 0);
  });
});

describe('setWallLength', () => {
  it('lengthens a wall by moving the one after it', () => {
    samePoints(setWallLength(RECT, 0, 12), [[-5, -4], [7, -4], [7, 4], [-5, 4]]);
  });

  it('shortens one leg of an L, its neighbors keeping their directions', () => {
    // wall 1 is the 4 m wall from (5, -4) to (5, 0); at 3 m, the notch wall behind it moves in to z = -1
    const shorter = setWallLength(L, 1, 3);
    near(footprintWalls(shorter)[1].length, 3);
    assert.deepEqual(footprintProblems(shorter), []);
  });

  it('moves the end corner along the wall when the next wall is in line', () => {
    const split = insertCorner(RECT, 0, [0, -4]);
    samePoints(setWallLength(split, 0, 3), [[-5, -4], [-2, -4], [5, -4], [5, 4], [-5, 4]]);
  });
});

describe('insetOutline', () => {
  it('moves every wall in', () => {
    samePoints(insetOutline(RECT, 0.5), [[-4.5, -3.5], [4.5, -3.5], [4.5, 3.5], [-4.5, 3.5]]);
    samePoints(insetOutline(L, 1), [[-4, -3], [4, -3], [4, -1], [-1, -1], [-1, 3], [-4, 3]]);
  });
});

describe('outlineDeviation', () => {
  it('is zero for the same outline and the furthest shift otherwise', () => {
    near(outlineDeviation(RECT, RECT), 0);
    near(outlineDeviation(RECT, moveWall(RECT, 1, 0.4)), 0.4);
  });
});
