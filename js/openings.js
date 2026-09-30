/**
 * Windows and doors (Task 6): openings placed on a footprint wall run, or on
 * a roof structure's own wall (a dormer's face, a tower's side), the way
 * roof-structures.js places a structure on a volume side. Pure functions
 * with no THREE dependency — extrusion.js builds the actual geometry from
 * what this file resolves.
 */

export const OPENING_KINDS = ['window', 'door'];

/** Defaults per kind. Lengths in meters. */
export const OPENING_PRESETS = Object.freeze({
  window: Object.freeze({ width: 1.0, height: 1.4, sillHeight: 0.9 }),
  door: Object.freeze({ width: 0.9, height: 2.05, sillHeight: 0 }),
});

/** The smallest an opening's width or height can be. */
export const MIN_OPENING_SIZE = 0.3;
/** How far short of the wall's own edges (its ends, and its top) an opening must stay. */
export const OPENING_EDGE_MARGIN = 0.05;
/** Clearance kept between two openings on the same wall run. */
export const OPENING_GAP = 0.1;
/** The frame's casing width and depth, and how far a pane sits back from the outer face. */
export const FRAME_CASING_WIDTH = 0.09;
export const FRAME_DEPTH = 0.08;
export const PANE_RECESS = 0.03;
/** A door's sill is a threshold, not a window ledge: it stays near the floor. */
export const DOOR_SILL_MAX = 0.15;
/** Entry steps: the riser they aim for, each tread's depth, the landing at the door, and how far past the frame they run each side. */
export const STEP_RISER = 0.18;
export const STEP_TREAD = 0.28;
export const STEP_LANDING = 0.9;
export const STEP_SIDE_MARGIN = 0.15;
/** A threshold lower than this above grade needs no steps. */
export const STEP_MIN_RISE = 0.05;
/** What a flight's settings can be set to (meters; a count of steps). */
export const STEP_WIDTH_RANGE = Object.freeze([0.6, 8]);
export const STEP_TREAD_RANGE = Object.freeze([0.2, 0.6]);
export const STEP_RISER_RANGE = Object.freeze([0.1, 0.25]);
export const STEP_COUNT_RANGE = Object.freeze([1, 40]);
export const STEP_LANDING_RANGE = Object.freeze([0.6, 4]);
/** Which way a door's flight runs down from its landing: straight out, or along the wall to the left or right (as seen from outside). */
export const STEP_DIRECTIONS = Object.freeze(['front', 'left', 'right']);

import { normalizeRailing } from './railings.js';
import { normalizeDetails, openingPolygon } from './opening-details.js';

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {});

/**
 * A complete opening record from partial or untrusted input (a `.bld` file,
 * the Add button), with the kind's preset filling anything missing. Returns
 * null when it cannot be placed at all (no host wall).
 *
 * - `hostWallRunId`: a footprint wall run's own id (`wall-run-N`), or a
 *   structure's (`wall-run-<structure>-<wall>`) — not a volume+side pair, since the wall-selection UI already resolves a wall
 *   run by id (see findRun in main.js) and an opening should address that
 *   same id space directly.
 * - `offset`: center along the wall from its own midpoint, meters.
 * - `sillHeight`: the opening's bottom above the wall's floor line. A
 *   window's is a free height; a door's is clamped to a small threshold
 *   range (DOOR_SILL_MAX) rather than left editable like a window ledge.
 * - `steps` (a door's only): the flight of steps from its threshold down to
 *   grade (see normalizeSteps; on by default; built only on footprint walls).
 * - `details`: its sill, head, grille, shutters, and top (a window's), or
 *   its leaves, sidelights, transom, and head (a door's); see
 *   normalizeDetails in js/opening-details.js.
 * - `hinge` (a door's only): the jamb it's hung on, `'left'` or `'right'` as
 *   seen from outside; a door cut into a walk-in room stands open about it.
 *
 * @returns {object|null}
 */
export function normalizeOpening(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (typeof raw.hostWallRunId !== 'string' || !raw.hostWallRunId) {
    return null;
  }
  const kind = OPENING_KINDS.includes(raw.kind) ? raw.kind : 'window';
  const preset = OPENING_PRESETS[kind];
  const sillHeight = Math.max(0, finite(raw.sillHeight, preset.sillHeight));
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : null,
    kind,
    hostWallRunId: raw.hostWallRunId,
    offset: finite(raw.offset, 0),
    width: Math.max(MIN_OPENING_SIZE, finite(raw.width, preset.width)),
    height: Math.max(MIN_OPENING_SIZE, finite(raw.height, preset.height)),
    sillHeight: kind === 'door' ? Math.min(DOOR_SILL_MAX, sillHeight) : sillHeight,
    materials: plainObject(raw.materials),
    details: normalizeDetails(kind, raw.details),
    ...(kind === 'door' ? { steps: normalizeSteps(raw.steps), hinge: raw.hinge === 'right' ? 'right' : 'left' } : {}),
  };
}

/** Normalizes a list of records, dropping unplaceable ones and giving every opening a unique id (`opening-N`). */
export function normalizeOpenings(list) {
  const openings = (Array.isArray(list) ? list : []).map(normalizeOpening).filter(Boolean);
  const used = new Set();
  let next = 1;
  return openings.map((opening) => {
    let { id } = opening;
    if (!id || used.has(id)) {
      while (used.has(`opening-${next}`) || openings.some((other) => other.id === `opening-${next}`)) {
        next += 1;
      }
      id = `opening-${next}`;
    }
    used.add(id);
    return { ...opening, id };
  });
}

/** A new opening of `kind` on a host wall, with an id unused by `existing`. */
export function createOpening(kind, placement, existing = []) {
  const [created] = normalizeOpenings([...existing, { ...placement, kind, id: null }]).slice(-1);
  return created;
}

const error = (code, message) => ({ code, message });

/**
 * Resolves an opening against its host wall, in the wall's own (u, v) frame
 * (u along the wall from its midpoint, v up from its floor line) — mirrors
 * resolveRoofStructure's `{resolved, errors, warnings}` contract.
 *
 * @param {object} opening - a normalized record
 * @param {object|undefined} hostWallRun - the host wall run, augmented by
 *   the caller with `wallHeight` and `baseY` (openings.js has no THREE or
 *   extrusion.js dependency, so it never computes these itself — the caller
 *   already has volumeWallHeight/volumeFoundationHeight in scope)
 * @param {{ siblings?: Array<object>, stories?: Array<{minY:number,maxY:number}> }} [config]
 *   `siblings`: the building's other openings, to check against overlap on
 *   the same host wall. `stories`: for the crosses-story warning only.
 * @returns {{ resolved: object|null, errors: Array<{code,message}>, warnings: Array<{code,message}> }}
 */
export function resolveOpening(opening, hostWallRun, config = {}) {
  const errors = [];
  const warnings = [];
  if (!hostWallRun) {
    errors.push(error('no-host', "its host wall doesn't exist"));
    return { resolved: null, errors, warnings };
  }

  const halfWidth = opening.width / 2;
  const u0 = opening.offset - halfWidth;
  const u1 = opening.offset + halfWidth;
  const halfLength = hostWallRun.length / 2;
  if (u0 < -halfLength + OPENING_EDGE_MARGIN || u1 > halfLength - OPENING_EDGE_MARGIN) {
    errors.push(error('outside-wall', 'runs past the end of the wall'));
  }

  const v0 = opening.sillHeight;
  const v1 = opening.sillHeight + opening.height;
  if (v0 < -1e-6) {
    errors.push(error('below-wall', "sits below the wall's floor"));
  }
  const wallHeight = finite(hostWallRun.wallHeight, Infinity);
  if (v1 > wallHeight - OPENING_EDGE_MARGIN) {
    errors.push(error('above-wall', 'rises above the top of the wall'));
  }

  const siblings = (config.siblings ?? []).filter((other) => other.id !== opening.id && other.hostWallRunId === opening.hostWallRunId);
  // (overlapping across the wall and up it: a window over another, a story up, is clear of it)
  const overlapsSibling = siblings.some((raw) => {
    const other = normalizeOpening(raw) ?? raw;
    const otherHalf = other.width / 2;
    const otherU0 = other.offset - otherHalf - OPENING_GAP;
    const otherU1 = other.offset + otherHalf + OPENING_GAP;
    const otherV0 = other.sillHeight - OPENING_GAP;
    const otherV1 = other.sillHeight + other.height + OPENING_GAP;
    return u0 < otherU1 && otherU0 < u1 && v0 < otherV1 && otherV0 < v1;
  });
  if (overlapsSibling) {
    errors.push(error('overlap', 'overlaps another opening on the same wall'));
  }
  if (hostWallRun.shape && !errors.length) {
    const casing = FRAME_CASING_WIDTH;
    if (!rectInShape(u0 - casing, v0 - casing, u1 + casing, v1 + casing, hostWallRun.shape)) {
      errors.push(error('outside-shape', "runs past the wall's visible face (into the roof or past its edge)"));
    }
  }

  // The wall is one solid mass with no real per-story seam, so this is only
  // a heads-up that the opening may cross a facade-panel color boundary —
  // never a block.
  if (Array.isArray(config.stories)) {
    const crossesStory = config.stories.some((story) => v0 < story.maxY - 1e-6 && v1 > story.maxY + 1e-6 && story.maxY < wallHeight - 1e-6);
    if (crossesStory) {
      warnings.push(error('crosses-story', 'crosses a story boundary'));
    }
  }

  if (errors.length) {
    return { resolved: null, errors, warnings };
  }

  const resolved = {
    id: opening.id,
    kind: opening.kind,
    hostWallRunId: opening.hostWallRunId,
    u0,
    u1,
    v0,
    v1,
    width: opening.width,
    height: opening.height,
    sillHeight: opening.sillHeight,
    frame: {
      start: hostWallRun.start, end: hostWallRun.end, normal: hostWallRun.normal, right: hostWallRun.right, baseY: hostWallRun.baseY ?? 0,
    },
    materials: opening.materials,
    details: normalizeDetails(opening.kind, opening.details),
  };
  return { resolved, errors, warnings };
}

/**
 * A resolved opening's outer casing rectangle and inner opening rectangle,
 * as plain 2D (u, v) point arrays — extrusion.js is the only place this
 * becomes real geometry (a THREE.Shape with the inner rectangle as its
 * hole), per this feature's additive-appliqué design (see the Task 6 plan).
 */
export function openingOutline(resolved) {
  const casing = FRAME_CASING_WIDTH;
  // an arched window's casing follows its arch round
  const top = resolved.kind === 'window' ? resolved.details?.top : 'flat';
  return {
    outer: openingPolygon(resolved.u0 - casing, resolved.v0 - casing, resolved.u1 + casing, resolved.v1 + casing, top),
    inner: openingPolygon(resolved.u0, resolved.v0, resolved.u1, resolved.v1, top),
  };
}

/**
 * A roof structure's wall run (see facadeWallRun in roof-structures.js: u
 * from its start, v from the structure's floor, its visible surface as
 * `pieces`) as an opening host in the footprint walls' own frame: u from the
 * midpoint, and the same left-handed (right, up, outward) orientation
 * wallRunFrame gives a footprint wall — a structure wall's `right` runs the
 * other way, so its ends are swapped and u mirrored. `shape` is the visible
 * surface in that frame, which an opening's frame must stay inside; the
 * wall's height is its highest visible point (a gable's peak).
 */
export function structureOpeningHost(run) {
  const half = run.length / 2;
  return {
    ...run,
    start: run.end,
    end: run.start,
    right: [-run.normal[1], run.normal[0]],
    wallHeight: run.extent.maxV,
    shape: run.pieces.map((triangle) => triangle.map(([u, v]) => [half - u, v])),
  };
}

const SHAPE_EPSILON = 1e-4;

function inTriangle([x, y], [a, b, c]) {
  const side = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(area) < 1e-12) {
    return false;
  }
  const sign = area > 0 ? 1 : -1;
  const scale = (edge) => Math.hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]) * SHAPE_EPSILON;
  return [[a, b], [b, c], [c, a]].every((edge) => sign * side(edge[0], edge[1]) >= -scale(edge));
}

/** Whether (u, v) lies on a wall's visible surface (the union of its triangles). */
export function pointInShape(point, shape) {
  return shape.some((triangle) => inTriangle(point, triangle));
}

/**
 * Whether the rectangle lies within a wall's visible surface. The surface is
 * a wall's outline clipped by roofs — no holes — so the rectangle is inside
 * when its whole boundary is (checked every few centimeters) and its middle is.
 */
export function rectInShape(u0, v0, u1, v1, shape) {
  const step = 0.05;
  const points = [[(u0 + u1) / 2, (v0 + v1) / 2]];
  const edge = (a, b) => {
    const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let i = 0; i < count; i += 1) {
      points.push([a[0] + (b[0] - a[0]) * (i / count), a[1] + (b[1] - a[1]) * (i / count)]);
    }
  };
  edge([u0, v0], [u1, v0]);
  edge([u1, v0], [u1, v1]);
  edge([u1, v1], [u0, v1]);
  edge([u0, v1], [u0, v0]);
  return points.every((point) => pointInShape(point, shape));
}

/**
 * A new opening fitted onto a small or shaped wall (a dormer's face): kept at
 * its preset where that fits; otherwise centered, its sill (a window's) at
 * the lowest height a window fits, and its width and height cut down to the
 * largest that fit inside the visible surface, with the frame. Left as it
 * was if even the smallest opening won't fit (it then reports why).
 */
export function fitOpening(opening, host) {
  if (!host?.shape || resolveOpening(opening, host).resolved) {
    return opening;
  }
  const casing = FRAME_CASING_WIDTH;
  const vs = host.shape.flat().map(([, v]) => v);
  const floor = Math.max(0, Math.min(...vs));
  const top = Math.max(...vs);
  // a window's sill: from just above the lowest visible point up, until one fits
  // (a tower face half behind the house may only show above its roof); a door's stays put
  const sills = [];
  if (opening.kind === 'door') {
    sills.push(opening.sillHeight);
  } else {
    for (let sill = floor + casing + 0.1; sill + MIN_OPENING_SIZE + casing <= top; sill += 0.1) {
      sills.push(sill);
    }
  }
  for (const sillHeight of sills) {
    const fits = (width, height) => rectInShape(-width / 2 - casing, sillHeight - casing, width / 2 + casing, sillHeight + height + casing, host.shape);
    let width = Math.min(opening.width, Math.max(MIN_OPENING_SIZE, host.length * 0.6));
    while (width > MIN_OPENING_SIZE && !fits(width, MIN_OPENING_SIZE)) {
      width = Math.max(MIN_OPENING_SIZE, width - 0.05);
    }
    if (fits(width, MIN_OPENING_SIZE)) {
      let height = MIN_OPENING_SIZE;
      while (height + 0.05 <= opening.height && fits(width, height + 0.05)) {
        height += 0.05;
      }
      return {
        ...opening, offset: 0, width, height, sillHeight,
      };
    }
  }
  return opening;
}

/** Whether an opening's frame lies on its host's visible surface (always, for a host without a shape). */
export function openingFitsShape(opening, host) {
  if (!host?.shape) {
    return true;
  }
  const casing = FRAME_CASING_WIDTH;
  const halfWidth = opening.width / 2;
  return rectInShape(
    opening.offset - halfWidth - casing,
    opening.sillHeight - casing,
    opening.offset + halfWidth + casing,
    opening.sillHeight + opening.height + casing,
    host.shape
  );
}

/**
 * The furthest `field` can go from `from` toward `to` with the opening still
 * on its host's visible surface, every other field held (a bisection: the
 * surface is convex enough along any one field for the fitting values to be
 * one run). `from` itself when it doesn't fit.
 */
export function shapeLimit(opening, host, field, from, to) {
  const fits = (value) => openingFitsShape({ ...opening, [field]: value }, host);
  if (!fits(from)) {
    return from;
  }
  if (fits(to)) {
    return to;
  }
  let [good, bad] = [from, to];
  for (let i = 0; i < 30; i += 1) {
    const middle = (good + bad) / 2;
    if (fits(middle)) {
      good = middle;
    } else {
      bad = middle;
    }
  }
  return good;
}

/**
 * A flight of steps' settings, from partial or older input (a plain
 * true/false before they could be sized):
 * - `enabled`: whether it's built (on unless turned off).
 * - `width`: across the flight, or null to fit the door or porch it serves.
 * - `tread`: each step's depth.
 * - `riser`: the height each step aims for; the number of steps follows from
 *   the rise, rounded so every riser comes out the same.
 * - `count`: instead, this many steps exactly (null to size by `riser`).
 * - `offset`: a porch's steps' center along its front, from the front's
 *   middle, to the right as seen from outside (a door's steps stay centered
 *   on the door).
 * - `landing` (a door's): the landing's depth out from the wall, or null for
 *   STEP_LANDING; with a deep landing and a flight off its side, a stoop.
 * - `direction` (a door's): which way the flight runs from the landing, see
 *   STEP_DIRECTIONS.
 * - `railings`: railings up the flight's open sides and round a stoop's
 *   landing (see normalizeRailing in js/railings.js; off unless turned on).
 */
export function normalizeSteps(raw) {
  const source = raw === false ? { enabled: false } : raw && typeof raw === 'object' ? raw : {};
  const inRange = (value, [min, max]) => (Number.isFinite(value) ? Math.min(Math.max(value, min), max) : null);
  const count = inRange(source.count, STEP_COUNT_RANGE);
  return {
    enabled: source.enabled !== false,
    width: inRange(source.width, STEP_WIDTH_RANGE),
    tread: inRange(source.tread, STEP_TREAD_RANGE) ?? STEP_TREAD,
    riser: inRange(source.riser, STEP_RISER_RANGE) ?? STEP_RISER,
    count: count === null ? null : Math.round(count),
    offset: Number.isFinite(source.offset) ? source.offset : 0,
    landing: inRange(source.landing, STEP_LANDING_RANGE),
    direction: STEP_DIRECTIONS.includes(source.direction) ? source.direction : 'front',
    // railings up the flight's open sides (and round a stoop's landing): off unless turned on
    railings: normalizeRailing(source.railings ?? { enabled: false }),
  };
}

/**
 * A flight of steps from a floor or threshold `rise` above grade down to the
 * ground: `risers` even risers (`count` of them, or as many as bring each
 * near `riser`) and `tread`-deep treads. At a door the flight tops out in a
 * `landing` (STEP_LANDING) level with the threshold; with `landing: 0` the
 * floor it serves is its own top step (a porch deck), and the flight stops a
 * riser below it. `built` is how many steps that makes; `profile` is the
 * flight's side outline as [out, up] points — out from the wall or deck
 * edge, up from grade — swept across its width. Null when there is nothing
 * to climb.
 */
export function stepFlight(rise, {
  landing = STEP_LANDING, tread = STEP_TREAD, riser: target = STEP_RISER, count = null,
} = {}) {
  if (!(rise >= STEP_MIN_RISE)) {
    return null;
  }
  const risers = Number.isFinite(count) && count >= 1 ? Math.round(count) : Math.max(1, Math.round(rise / target));
  const riser = rise / risers;
  const built = landing > 0 ? risers : risers - 1;
  if (built < 1) {
    return null;
  }
  const depth = landing + (risers - 1) * tread;
  const profile = [[0, 0], [depth, 0]];
  for (let k = 1; k <= built; k += 1) {
    const out = depth - (k - 1) * tread;
    profile.push([out, k * riser], [out - tread, k * riser]);
  }
  // the top: a landing level with the threshold back to the wall, or the last tread meeting the deck's edge
  if (landing > 0) {
    profile.splice(profile.length - 2, 2, [landing, rise], [0, rise]);
  }
  return {
    count: risers, built, riser, depth, profile,
  };
}

/**
 * The stepFlight a set of steps (normalizeSteps) makes up to a floor `rise`
 * above grade, `count` being the steps built: a door's with its landing, a
 * porch's (`deck`) with the deck as the top step, so one riser more than it
 * has steps.
 */
export function flightFor(steps, rise, { deck = false } = {}) {
  return stepFlight(rise, {
    landing: deck ? 0 : steps.landing ?? STEP_LANDING,
    tread: steps.tread,
    riser: steps.riser,
    count: steps.count === null ? null : steps.count + (deck ? 1 : 0),
  });
}

/**
 * A door's steps as plan pieces around the door, `width` wide at the door and
 * `rise` up to its threshold: in the door's frame, u across the wall from the
 * door's center (+u to the left as seen from outside) and d out from the
 * wall. A flight straight out is one piece (its profile includes the
 * landing); a flight to either side is a landing (a flat block) and a flight
 * off its side whose top step is the landing, running along the wall and
 * as wide as the landing is deep. Each piece: its side `profile` ([out, up]
 * from where it starts), where it starts (`at`, [u, d]), which way it runs
 * (`toward`, [du, dd]), and how wide it is (`width`, across it from `at`
 * along [dd, -du]). Null when there is nothing to climb.
 */
export function doorStepPieces(steps, rise, width) {
  if (steps.direction === 'front') {
    const flight = flightFor(steps, rise);
    return flight && {
      flight,
      pieces: [{ profile: flight.profile, at: [-width / 2, 0], toward: [0, 1], width }],
    };
  }
  const landing = steps.landing ?? STEP_LANDING;
  const flight = flightFor(steps, rise, { deck: true });
  if (!(rise >= STEP_MIN_RISE)) {
    return null;
  }
  const block = { profile: [[0, 0], [landing, 0], [landing, rise], [0, rise]], at: [-width / 2, 0], toward: [0, 1], width };
  if (!flight) {
    return { flight: { depth: landing }, pieces: [block] };
  }
  // left (as seen from outside) is +u; the flight's width runs from the wall out
  const side = steps.direction === 'left' ? 1 : -1;
  const run = side > 0
    ? { profile: flight.profile, at: [width / 2, landing], toward: [1, 0], width: landing }
    : { profile: flight.profile, at: [-width / 2, 0], toward: [-1, 0], width: landing };
  return { flight: { ...flight, depth: landing }, pieces: [block, run] };
}

/** How far a flight's railings stand in from its edges. */
export const STEP_RAIL_INSET = 0.05;

/**
 * The railing runs for a door's steps (doorStepPieces), in the door's frame
 * as for the pieces: [u, y, d] points (y above grade), each with whether it
 * slopes down a flight (`stair`, which gets newels at both ends; a level run
 * along a landing gets none). A straight flight has a railing up each side,
 * level along the landing and sloping down the flight parallel to its
 * nosings; a stoop has one along its landing's open front and far side, and
 * one down its flight's outer side (its inner side is the wall).
 */
export function doorStepRails(steps, rise, width, layout) {
  const flight = layout.flight;
  const e = STEP_RAIL_INSET;
  const half = width / 2 - e;
  if (!flight?.riser) {
    return [];
  }
  if (steps.direction === 'front') {
    const landing = steps.landing ?? STEP_LANDING;
    return [-half, half].flatMap((u) => [
      { start: [u, rise, 0], end: [u, rise, landing], stair: false },
      { start: [u, rise, landing], end: [u, flight.riser, flight.depth], stair: true },
    ]);
  }
  const landing = flight.depth;
  const run = (flight.count - 1) * steps.tread;
  const side = steps.direction === 'left' ? 1 : -1;
  const edge = landing - e;
  return [
    { start: [-side * half, rise, edge], end: [side * width / 2, rise, edge], stair: false },
    { start: [-side * half, rise, 0], end: [-side * half, rise, edge], stair: false },
    { start: [side * width / 2, rise, edge], end: [side * (width / 2 + run), flight.riser, edge], stair: true },
  ];
}

/** How far the windows filling a wall keep clear of its ends. */
export const FILL_MARGIN = 0.4;
/** Room kept over a window's head, under the next floor. */
const HEAD_CLEARANCE = 0.3;

/**
 * Windows filling a wall: `count` to a story, in equal bays along the wall
 * (FILL_MARGIN clear of its ends), the same bays on every story in `stories`
 * ({ base, height }: the story's floor above the wall's floor line, and its
 * height), so they line up floor to floor. Each sits at the preset's sill
 * above its story's floor, no taller than leaves HEAD_CLEARANCE under the
 * next, and no wider than its bay. A position that would overlap an opening
 * in `keep` (the wall's doors), or that doesn't fit the wall (a dormer's
 * gable), is left out. Records without ids: the caller gives them theirs.
 */
export function windowGrid(host, {
  count, stories, keep = [], preset = OPENING_PRESETS.window,
}) {
  const usable = host.length - 2 * FILL_MARGIN;
  if (!(count >= 1) || usable < MIN_OPENING_SIZE) {
    return [];
  }
  const bay = usable / count;
  const width = Math.min(preset.width, bay - 2 * (FRAME_CASING_WIDTH + OPENING_GAP));
  if (width < MIN_OPENING_SIZE) {
    return [];
  }
  const placed = [];
  stories.forEach(({ base, height: storyHeight }) => {
    const height = Math.min(preset.height, storyHeight - preset.sillHeight - HEAD_CLEARANCE);
    if (height < MIN_OPENING_SIZE) {
      return;
    }
    for (let i = 0; i < count; i += 1) {
      const candidate = normalizeOpening({
        id: `fill-${placed.length}-${i}`,
        kind: 'window',
        hostWallRunId: host.id,
        offset: -host.length / 2 + FILL_MARGIN + bay * (i + 0.5),
        width,
        height,
        sillHeight: base + preset.sillHeight,
      });
      if (resolveOpening(candidate, host, { siblings: [...keep, ...placed] }).resolved) {
        placed.push(candidate);
      }
    }
  });
  return placed.map(({ id, ...opening }) => ({ ...opening, id: null }));
}

/** A wall's stories, as windowGrid takes them: `count` of them, each `height` tall, from its floor line. */
export function wallStories(count, height) {
  return Array.from({ length: Math.max(0, count) }, (_, k) => ({ base: k * height, height }));
}
