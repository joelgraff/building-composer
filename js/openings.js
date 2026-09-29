/**
 * Windows and doors (Task 6): openings placed on a footprint wall run, the
 * way roof-structures.js places a structure on a volume side. Pure functions
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

const finite = (value, fallback) => (Number.isFinite(value) ? value : fallback);
const plainObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {});

/**
 * A complete opening record from partial or untrusted input (a `.bld` file,
 * the Add button), with the kind's preset filling anything missing. Returns
 * null when it cannot be placed at all (no host wall).
 *
 * - `hostWallRunId`: a footprint wall run's own id (`wall-run-N`) — not a
 *   volume+side pair, since the wall-selection UI already resolves a wall
 *   run by id (see findRun in main.js) and an opening should address that
 *   same id space directly.
 * - `offset`: center along the wall from its own midpoint, meters.
 * - `sillHeight`: the opening's bottom above the wall's floor line. A
 *   window's is a free height; a door's is clamped to a small threshold
 *   range (DOOR_SILL_MAX) rather than left editable like a window ledge.
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
