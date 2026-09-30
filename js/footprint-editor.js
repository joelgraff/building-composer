/**
 * The footprint editor's core: edit operations on an outline, snapping,
 * validation, undo and redo, and keeping the building in place in the game
 * when an edit moves its centroid. Pure functions with no DOM or THREE
 * dependency, so all of it runs in node (see docs/FOOTPRINT_EDITING_PLAN.md).
 *
 * A footprint here is an open ring of [x, z] corners in Composer's frame
 * (square to the building's axes, centered on its centroid when loaded), in
 * the winding Composer expects. Wall `i` runs from corner `i` to corner
 * `i + 1` (the last wall back to corner 0). Every operation returns a new
 * footprint and leaves its input alone; one given an index or size it can't
 * use throws a RangeError. Operations don't refuse an outline that comes out
 * invalid (an edit can pass through one on the way to a good one):
 * footprintProblems says what's wrong, and the editor keeps it up to date.
 */
import { validateFootprint, computeFootprintMetrics } from './footprint.js';
import { angledWallProblem } from './facade.js';
import { squareFootprint, MAX_SKEW_DEGREES, MIN_EDGE, ALIGN } from './import.js';

/** The shortest wall a footprint may have (the same as a tracing jog the import drops). */
export const MIN_WALL = MIN_EDGE;
/** The snapping grid. */
export const GRID = 0.05;
/** How close a point has to come to something to snap to it. */
export const SNAP_REACH = 0.3;
/** Parallel within this (degrees), a neighbor's wall is one a moved wall can snap onto. */
const PARALLEL_DEGREES = 2;
/** How many edits undo reaches back. */
const HISTORY_LIMIT = 200;

const EPSILON = 1e-9;

// --- Geometry ---------------------------------------------------------------

/** The outline as an open ring of numbers (a closing corner repeating the first is dropped). */
export function openRing(points) {
  const ring = points.map(([x, z]) => [Number(x), Number(z)]);
  if (ring.length > 1 && distance(ring[0], ring[ring.length - 1]) < EPSILON) {
    ring.pop();
  }
  return ring;
}

/**
 * Each wall of a footprint: its corners, length, direction, outward normal,
 * angle (degrees from +x), and the axis it runs along ('x', 'z', or null
 * for an angled wall), for readouts and handles.
 */
export function footprintWalls(footprint) {
  const ring = openRing(footprint);
  const outward = windingSign(ring);
  return ring.map((start, index) => {
    const end = ring[(index + 1) % ring.length];
    const [dx, dz] = [end[0] - start[0], end[1] - start[1]];
    const length = Math.hypot(dx, dz);
    const direction = length > EPSILON ? [dx / length, dz / length] : [1, 0];
    const axis = Math.abs(dz) < 1e-6 ? 'x' : Math.abs(dx) < 1e-6 ? 'z' : null;
    return {
      index,
      start,
      end,
      length,
      direction,
      normal: [direction[1] * outward, -direction[0] * outward],
      angle: (Math.atan2(dz, dx) * 180) / Math.PI,
      axis,
    };
  });
}

// --- Operations -------------------------------------------------------------

/** Moves corner `index` to `point`. */
export function moveCorner(footprint, index, point) {
  const ring = openRing(footprint);
  checkIndex(ring, index, 'corner');
  ring[index] = [point[0], point[1]];
  return ring;
}

/**
 * Adds a corner on wall `wallIndex` at the point of the wall nearest
 * `point` (kept clear of its ends). The new corner is corner `wallIndex + 1`.
 */
export function insertCorner(footprint, wallIndex, point) {
  const ring = openRing(footprint);
  checkIndex(ring, wallIndex, 'wall');
  const a = ring[wallIndex];
  const b = ring[(wallIndex + 1) % ring.length];
  const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared < EPSILON) {
    throw new RangeError(`Wall ${wallIndex} has no length to put a corner on.`);
  }
  const t = Math.min(1 - 1e-3, Math.max(1e-3, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared));
  ring.splice(wallIndex + 1, 0, [a[0] + dx * t, a[1] + dz * t]);
  return ring;
}

/** Removes corner `index`; its two walls become one. A footprint keeps at least three corners. */
export function deleteCorner(footprint, index) {
  const ring = openRing(footprint);
  checkIndex(ring, index, 'corner');
  if (ring.length <= 3) {
    throw new RangeError('A footprint needs at least three corners.');
  }
  ring.splice(index, 1);
  return ring;
}

/**
 * Moves wall `wallIndex` out (positive `offset`) or in (negative) along its
 * normal. The walls either side keep their directions, so its corners slide
 * along them; where a neighbor runs the same way as the wall (one straight
 * line broken by a corner), a short wall is added to join them instead.
 */
export function moveWall(footprint, wallIndex, offset) {
  const ring = openRing(footprint);
  checkIndex(ring, wallIndex, 'wall');
  const n = ring.length;
  const wall = footprintWalls(ring)[wallIndex];
  const shift = [wall.normal[0] * offset, wall.normal[1] * offset];
  const moved = { point: [wall.start[0] + shift[0], wall.start[1] + shift[1]], direction: wall.direction };
  const previous = lineThrough(ring[(wallIndex - 1 + n) % n], wall.start);
  const next = lineThrough(wall.end, ring[(wallIndex + 2) % n]);
  const startCorner = intersectLines(previous, moved);
  const endCorner = intersectLines(moved, next);
  const shiftedStart = [wall.start[0] + shift[0], wall.start[1] + shift[1]];
  const shiftedEnd = [wall.end[0] + shift[0], wall.end[1] + shift[1]];
  // corner by corner: slid along its neighbor, or (a neighbor in line) kept, with a joining wall out to the moved one
  const startPoints = startCorner ? [startCorner] : [wall.start, shiftedStart];
  const endPoints = endCorner ? [endCorner] : [shiftedEnd, wall.end];
  const end = (wallIndex + 1) % n;
  const result = [];
  ring.forEach((corner, i) => {
    if (i === wallIndex) {
      result.push(...startPoints);
    } else if (i === end) {
      result.push(...endPoints);
    } else {
      result.push(corner);
    }
  });
  return dropDegenerate(result, new Set([...startPoints, ...endPoints]));
}

/**
 * Adds a rectangular bump-out (positive `depth`) or notch (negative) on
 * wall `wallIndex`: `start` from the wall's first corner along it, `width`
 * wide. A bump reaching a corner of the wall joins the wall beside it.
 */
export function addBump(footprint, wallIndex, { start, width, depth }) {
  const ring = openRing(footprint);
  checkIndex(ring, wallIndex, 'wall');
  const wall = footprintWalls(ring)[wallIndex];
  if (!(width > MIN_WALL) || !(Math.abs(depth) > MIN_WALL)) {
    throw new RangeError(`A bump needs a width and depth of at least ${MIN_WALL} m.`);
  }
  if (!(start >= -1e-6) || !(start + width <= wall.length + 1e-6)) {
    throw new RangeError(`A bump ${width.toFixed(2)} m wide from ${start.toFixed(2)} m doesn't fit on a ${wall.length.toFixed(2)} m wall.`);
  }
  const along = (t) => [wall.start[0] + wall.direction[0] * t, wall.start[1] + wall.direction[1] * t];
  const out = (point) => [point[0] + wall.normal[0] * depth, point[1] + wall.normal[1] * depth];
  const near = along(Math.max(0, start));
  const far = along(Math.min(wall.length, start + width));
  const added = [near, out(near), out(far), far];
  // (the ring's own corner arrays: footprintWalls hands back copies)
  const wallCorners = [ring[wallIndex], ring[(wallIndex + 1) % ring.length]];
  ring.splice(wallIndex + 1, 0, ...added);
  // a bump reaching a corner of the wall: that corner and the bump's own there can go
  return dropDegenerate(ring, new Set([...added, ...wallCorners]));
}

/**
 * Turns wall `wallIndex` onto the nearer axis through its middle. The walls
 * either side keep their directions (a neighbor that would run the same way
 * has the corner moved square onto the new line instead).
 */
export function straightenWall(footprint, wallIndex) {
  const ring = openRing(footprint);
  checkIndex(ring, wallIndex, 'wall');
  const n = ring.length;
  const wall = footprintWalls(ring)[wallIndex];
  const middle = [(wall.start[0] + wall.end[0]) / 2, (wall.start[1] + wall.end[1]) / 2];
  const alongX = Math.abs(wall.direction[0]) >= Math.abs(wall.direction[1]);
  const straight = { point: middle, direction: alongX ? [Math.sign(wall.direction[0]) || 1, 0] : [0, Math.sign(wall.direction[1]) || 1] };
  const onLine = (corner) => (alongX ? [corner[0], middle[1]] : [middle[0], corner[1]]);
  const startCorner = intersectLines(lineThrough(ring[(wallIndex - 1 + n) % n], wall.start), straight) ?? onLine(wall.start);
  const endCorner = intersectLines(straight, lineThrough(wall.end, ring[(wallIndex + 2) % n])) ?? onLine(wall.end);
  ring[wallIndex] = startCorner;
  ring[(wallIndex + 1) % n] = endCorner;
  return dropDegenerate(ring, new Set([startCorner, endCorner]));
}

/**
 * Squares the whole outline up again to Composer's axes, as the import
 * does, with its tolerances adjustable: `maxSkewDegrees` (walls this near
 * square are squared), `minEdge` (jogs shorter than this are dropped), and
 * `align` (wall lines this close are put on one line). Smaller values keep
 * more of the outline as it is.
 */
export function resquare(footprint, tolerances = {}) {
  const squared = squareFootprint(openRing(footprint), {
    maxSkewDegrees: tolerances.maxSkewDegrees ?? MAX_SKEW_DEGREES,
    minEdge: tolerances.minEdge ?? MIN_EDGE,
    align: tolerances.align ?? ALIGN,
    // Composer's axes are already the building's: square to them, not to a re-estimate
    rotation: 0,
  });
  if (squared.error) {
    throw new RangeError(squared.error);
  }
  // squareFootprint re-centers; put the outline back where it was
  return squared.footprint.map(([x, z]) => [x + squared.center[0], z + squared.center[1]]);
}

// --- Snapping ---------------------------------------------------------------

/**
 * Where a corner being dragged to `point` lands. In order of preference:
 * onto a neighbor's corner, onto a neighbor's wall (a party wall), and
 * otherwise each coordinate square with the corners either side of it
 * (making those walls run along an axis) or, failing that, onto the grid.
 * `snaps` says what it snapped to, for the UI to show.
 *
 * @param {[number, number]} point
 * @param {{ footprint?: Array<[number, number]>, corner?: number, neighbors?: Array<Array<[number, number]>>, grid?: number, reach?: number }} [options]
 *   `corner` is the index of the corner being moved in `footprint` (its
 *   neighbors are what it squares to); `neighbors` are other buildings'
 *   outlines in Composer's frame (see toComposerFrame).
 * @returns {{ point: [number, number], snaps: Array<{ kind: string, to?: [number, number] }> }}
 */
export function snapPoint(point, {
  footprint = null, corner = null, neighbors = [], grid = GRID, reach = SNAP_REACH,
} = {}) {
  const neighborCorner = nearest(neighbors.flatMap((outline) => openRing(outline)), (candidate) => distance(point, candidate), reach);
  if (neighborCorner) {
    return { point: [...neighborCorner], snaps: [{ kind: 'neighbor-corner', to: neighborCorner }] };
  }
  const onNeighborWall = nearest(
    neighbors.flatMap((outline) => {
      const ring = openRing(outline);
      return ring.map((a, i) => closestOnSegment(point, a, ring[(i + 1) % ring.length]));
    }),
    (candidate) => distance(point, candidate),
    reach,
  );
  if (onNeighborWall) {
    return { point: onNeighborWall, snaps: [{ kind: 'neighbor-wall', to: onNeighborWall }] };
  }
  const snaps = [];
  const adjacent = [];
  if (footprint && Number.isInteger(corner)) {
    const ring = openRing(footprint);
    adjacent.push(ring[(corner - 1 + ring.length) % ring.length], ring[(corner + 1) % ring.length]);
  }
  const snapped = [0, 1].map((axis) => {
    const square = nearest(adjacent, (candidate) => Math.abs(candidate[axis] - point[axis]), reach);
    if (square) {
      snaps.push({ kind: axis === 0 ? 'square-x' : 'square-z', to: square });
      return square[axis];
    }
    if (grid > 0) {
      snaps.push({ kind: axis === 0 ? 'grid-x' : 'grid-z' });
      return Math.round(point[axis] / grid) * grid;
    }
    return point[axis];
  });
  return { point: snapped, snaps };
}

/**
 * How far to move wall `wallIndex` (see moveWall) when dragged `offset`:
 * onto a neighbor's wall running the same way within reach (a party wall),
 * or else to the grid.
 */
export function snapWallOffset(footprint, wallIndex, offset, { neighbors = [], grid = GRID, reach = SNAP_REACH } = {}) {
  const wall = footprintWalls(footprint)[wallIndex];
  if (!wall) {
    throw new RangeError(`There is no wall ${wallIndex}.`);
  }
  const cosLimit = Math.cos((PARALLEL_DEGREES * Math.PI) / 180);
  // each parallel neighbor wall overlapping this one along its length: the offset that puts this wall on its line
  const candidates = neighbors.flatMap((outline) => footprintWalls(outline)
    .filter((other) => Math.abs(other.direction[0] * wall.direction[0] + other.direction[1] * wall.direction[1]) >= cosLimit)
    .filter((other) => overlapsAlong(wall, other))
    .map((other) => {
      const middle = [(other.start[0] + other.end[0]) / 2, (other.start[1] + other.end[1]) / 2];
      return (middle[0] - wall.start[0]) * wall.normal[0] + (middle[1] - wall.start[1]) * wall.normal[1];
    }));
  const party = nearest(candidates, (candidate) => Math.abs(candidate - offset), reach);
  if (party !== null) {
    return { offset: party, snaps: [{ kind: 'neighbor-wall' }] };
  }
  return grid > 0 ? { offset: Math.round(offset / grid) * grid, snaps: [{ kind: 'grid' }] } : { offset, snaps: [] };
}

// --- Validation -------------------------------------------------------------

/**
 * What stops a footprint being used, as messages (none when it's fine):
 * fewer than three corners, crossing walls, no area, the wrong winding, a
 * wall shorter than `minWall`, or an angled wall Composer can't cut volumes
 * around (angledWallProblem).
 */
export function footprintProblems(footprint, { expectedWinding = 'CCW', minWall = MIN_WALL } = {}) {
  const ring = openRing(footprint);
  const { errors } = validateFootprint(ring, { expectedWinding });
  const problems = [...errors];
  footprintWalls(ring).forEach((wall) => {
    if (wall.length < minWall) {
      problems.push(`Wall ${wall.index + 1} is ${wall.length.toFixed(2)} m long; walls must be at least ${minWall} m.`);
    }
  });
  if (!problems.length) {
    const angled = angledWallProblem(ring);
    if (angled) {
      problems.push(angled);
    }
  }
  return problems;
}

// --- Undo and redo ----------------------------------------------------------

/**
 * A footprint being edited: the current outline, what undo and redo go back
 * and forward to, and its problems (footprintProblems). Treat it as a value:
 * edit, undo, and redo each return a new one.
 */
export function createFootprintEditor(footprint, options = {}) {
  const ring = openRing(footprint);
  return {
    footprint: ring, past: [], future: [], problems: footprintProblems(ring, options), options,
  };
}

/** The editor after an edit: `footprint` is the outline an operation returned. An edit that changes nothing adds no undo step. */
export function edit(editor, footprint) {
  const ring = openRing(footprint);
  if (sameRing(ring, editor.footprint)) {
    return editor;
  }
  return {
    ...editor,
    footprint: ring,
    past: [...editor.past, editor.footprint].slice(-HISTORY_LIMIT),
    future: [],
    problems: footprintProblems(ring, editor.options),
  };
}

export function undo(editor) {
  if (!editor.past.length) {
    return editor;
  }
  const footprint = editor.past[editor.past.length - 1];
  return {
    ...editor,
    footprint,
    past: editor.past.slice(0, -1),
    future: [editor.footprint, ...editor.future],
    problems: footprintProblems(footprint, editor.options),
  };
}

export function redo(editor) {
  if (!editor.future.length) {
    return editor;
  }
  const [footprint, ...future] = editor.future;
  return {
    ...editor,
    footprint,
    past: [...editor.past, editor.footprint],
    future,
    problems: footprintProblems(footprint, editor.options),
  };
}

// --- Frames and placement ---------------------------------------------------

/** Points in Composer's frame as game points: game = center + R(rotation) · Composer (see js/import.js). */
export function toGameFrame(points, placement) {
  const { center = [0, 0], rotation = 0 } = placement ?? {};
  return points.map((point) => {
    const [x, z] = rotate(point, rotation);
    return [center[0] + x, center[1] + z];
  });
}

/** Game points (a neighbor's outline, a trace) in Composer's frame: the inverse of toGameFrame. */
export function toComposerFrame(points, placement) {
  const { center = [0, 0], rotation = 0 } = placement ?? {};
  return points.map(([x, z]) => rotate([x - center[0], z - center[1]], -rotation));
}

/**
 * An edited footprint re-centered on its centroid, as Composer keeps
 * footprints, with the placement moved to match, so the building stays
 * where it is in the game: the centroid's shift, turned into the game's
 * frame, is added to `placement.center`. Without a placement (a building
 * not from the game), only the footprint is re-centered.
 */
export function recenter(footprint, placement) {
  const ring = openRing(footprint);
  const { centroid } = computeFootprintMetrics(ring);
  const centered = ring.map(([x, z]) => [x - centroid.x, z - centroid.z]);
  if (!placement) {
    return { footprint: centered, placement };
  }
  const [shiftX, shiftZ] = rotate([centroid.x, centroid.z], placement.rotation ?? 0);
  const [cx, cz] = placement.center ?? [0, 0];
  return { footprint: centered, placement: { ...placement, center: [cx + shiftX, cz + shiftZ] } };
}

// --- Helpers ----------------------------------------------------------------

function checkIndex(ring, index, what) {
  if (!Number.isInteger(index) || index < 0 || index >= ring.length) {
    throw new RangeError(`There is no ${what} ${index}.`);
  }
}

/** +1 when the ring winds counter-clockwise (positive signed area), else -1: which side of a wall is out. */
function windingSign(ring) {
  const twiceArea = ring.reduce((sum, [x, z], i) => {
    const [nx, nz] = ring[(i + 1) % ring.length];
    return sum + x * nz - nx * z;
  }, 0);
  return twiceArea >= 0 ? 1 : -1;
}

function lineThrough(a, b) {
  const length = distance(a, b);
  return { point: a, direction: length > EPSILON ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length] : [1, 0] };
}

/** Where two lines meet, or null when they run the same way. */
function intersectLines(p, q) {
  const denominator = p.direction[0] * q.direction[1] - p.direction[1] * q.direction[0];
  if (Math.abs(denominator) < 1e-6) {
    return null;
  }
  const t = ((q.point[0] - p.point[0]) * q.direction[1] - (q.point[1] - p.point[1]) * q.direction[0]) / denominator;
  return [p.point[0] + p.direction[0] * t, p.point[1] + p.direction[1] * t];
}

/**
 * Drops corners an operation made or moved (`loose`, by reference) that
 * repeat a corner beside them, or stand in line with both of theirs (a
 * straight wall, or a spike doubling back), until none are left. Other corners stay, even in a straight line:
 * one may have been put there on purpose (insertCorner).
 */
function dropDegenerate(ring, loose) {
  const result = [...ring];
  for (let changed = true; changed && result.length > 3;) {
    changed = false;
    for (let i = 0; i < result.length && result.length > 3; i += 1) {
      if (!loose.has(result[i])) {
        continue;
      }
      const previous = result[(i - 1 + result.length) % result.length];
      const point = result[i];
      const next = result[(i + 1) % result.length];
      const repeated = distance(previous, point) < 1e-6 || distance(point, next) < 1e-6;
      const cross = (point[0] - previous[0]) * (next[1] - point[1]) - (point[1] - previous[1]) * (next[0] - point[0]);
      // in line with both: carrying straight on, or doubling back on itself (a spike with no width)
      const inLine = Math.abs(cross) < 1e-6;
      if (repeated || inLine) {
        result.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return result.map((point) => [...point]);
}

function closestOnSegment(point, a, b) {
  const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared < EPSILON ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dz) / lengthSquared));
  return [a[0] + dx * t, a[1] + dz * t];
}

/** Whether two parallel walls share some stretch along their direction. */
function overlapsAlong(wall, other) {
  const project = (point) => (point[0] - wall.start[0]) * wall.direction[0] + (point[1] - wall.start[1]) * wall.direction[1];
  const [lo, hi] = [project(other.start), project(other.end)].sort((a, b) => a - b);
  return hi > 1e-6 && lo < wall.length - 1e-6;
}

/** The candidate with the smallest `measure`, if it's within `reach`; else null. */
function nearest(candidates, measure, reach) {
  let best = null;
  let bestMeasure = reach;
  candidates.forEach((candidate) => {
    const value = measure(candidate);
    if (value <= bestMeasure) {
      best = candidate;
      bestMeasure = value;
    }
  });
  return best;
}

function sameRing(a, b) {
  return a.length === b.length && a.every((point, i) => distance(point, b[i]) < 1e-9);
}

function rotate([x, z], angle) {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  return [x * c - z * s, x * s + z * c];
}

function distance(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
