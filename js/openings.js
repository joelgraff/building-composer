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
 * - `steps` (a door's only): whether a flight of steps runs from its
 *   threshold down to grade (on by default; built only on footprint walls).
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
    ...(kind === 'door' ? { steps: raw.steps !== false } : {}),
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
  const overlapsSibling = siblings.some((other) => {
    const otherHalf = other.width / 2;
    const otherU0 = other.offset - otherHalf - OPENING_GAP;
    const otherU1 = other.offset + otherHalf + OPENING_GAP;
    return u0 < otherU1 && otherU0 < u1;
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
  };
  return { resolved, errors, warnings };
}

const rect = (u0, v0, u1, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];

/**
 * A resolved opening's outer casing rectangle and inner opening rectangle,
 * as plain 2D (u, v) point arrays — extrusion.js is the only place this
 * becomes real geometry (a THREE.Shape with the inner rectangle as its
 * hole), per this feature's additive-appliqué design (see the Task 6 plan).
 */
export function openingOutline(resolved) {
  const casing = FRAME_CASING_WIDTH;
  return {
    outer: rect(resolved.u0 - casing, resolved.v0 - casing, resolved.u1 + casing, resolved.v1 + casing),
    inner: rect(resolved.u0, resolved.v0, resolved.u1, resolved.v1),
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
 * A flight of entry steps from a door's threshold, `rise` above grade, down
 * to the ground: even risers near STEP_RISER, STEP_TREAD treads, and a
 * STEP_LANDING landing at the door. `profile` is the flight's side outline as
 * [out, up] points — out from the wall face, up from grade — which is swept
 * across the door's width. Null when the threshold is at grade.
 */
export function stepFlight(rise) {
  if (!(rise >= STEP_MIN_RISE)) {
    return null;
  }
  const count = Math.max(1, Math.round(rise / STEP_RISER));
  const riser = rise / count;
  const depth = STEP_LANDING + (count - 1) * STEP_TREAD;
  const profile = [[0, 0], [depth, 0]];
  for (let k = 1; k <= count; k += 1) {
    const out = depth - (k - 1) * STEP_TREAD;
    profile.push([out, k * riser]);
    if (k < count) {
      profile.push([out - STEP_TREAD, k * riser]);
    }
  }
  profile[profile.length - 1] = [STEP_LANDING, rise];
  profile.push([0, rise]);
  return {
    count, riser, depth, profile,
  };
}
