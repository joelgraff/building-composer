/**
 * Trim courses: horizontal moldings run around the building's walls (Task 7).
 *
 * - A water table caps the foundation, with a sloped drip on top.
 * - A belt course marks each floor line between stories.
 * - A cornice runs along the top of the walls, tucked under the soffit, with
 *   an optional row of dentils beneath it.
 *
 * Each course is a profile — a closed polygon in (d, y): d outward from the
 * wall face, y up from the course's anchor — swept along the footprint's wall
 * runs. Where two neighboring runs carry the same course at the same height
 * the sweep miters their corner; elsewhere (a volume at another height, a
 * window or door cutting the course) the course ends square with a cap.
 *
 * Like js/openings.js, this is plain data and plain triangles (arrays of
 * [x, y, z]), with no THREE dependency: js/extrusion.js measures where each
 * course sits on the built model and turns the triangles into meshes.
 */

export const TRIM_KINDS = Object.freeze(['waterTable', 'beltCourse', 'cornice']);

export const TRIM_DEFAULTS = Object.freeze({
  material: 'paint',
  waterTable: Object.freeze({ enabled: false, height: 0.25, projection: 0.06 }),
  beltCourse: Object.freeze({ enabled: false, height: 0.18, projection: 0.05 }),
  cornice: Object.freeze({
    enabled: false, height: 0.3, projection: 0.2, dentils: false,
  }),
  corners: Object.freeze({ style: 'none', width: 0.15, projection: 0.05 }),
  gutters: Object.freeze({ enabled: false, downspouts: true }),
});

/** What stands at the building's outside corners: nothing, a pair of corner boards, or quoins. */
export const CORNER_STYLES = Object.freeze(['none', 'boards', 'quoins']);
export const CORNER_WIDTH_RANGE = Object.freeze([0.08, 0.6]);
// (at least clear of the facade panels over the walls, 0.035 out, which would hide them)
export const CORNER_PROJECTION_RANGE = Object.freeze([0.045, 0.15]);

/** Allowed course sizes (meters). */
export const TRIM_HEIGHT_RANGE = Object.freeze([0.05, 1.2]);
export const TRIM_PROJECTION_RANGE = Object.freeze([0.01, 0.6]);

/** Dentil proportions, as fractions of the cornice's own height and projection. */
const DENTIL_HEIGHT = 0.4;
const DENTIL_DEPTH = 0.45;
const DENTIL_WIDTH = 0.28;

const clamp = (value, [min, max], fallback) => (Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback);

/** A trim record with every field present and in range; `raw` may be missing or partial (an older file). */
export function normalizeTrim(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const course = (kind) => {
    const defaults = TRIM_DEFAULTS[kind];
    const own = source[kind] && typeof source[kind] === 'object' ? source[kind] : {};
    const out = {
      enabled: own.enabled === true,
      height: clamp(own.height, TRIM_HEIGHT_RANGE, defaults.height),
      projection: clamp(own.projection, TRIM_PROJECTION_RANGE, defaults.projection),
    };
    if (kind === 'cornice') {
      out.dentils = own.dentils === true;
    }
    return out;
  };
  return {
    material: typeof source.material === 'string' && source.material ? source.material : TRIM_DEFAULTS.material,
    waterTable: course('waterTable'),
    beltCourse: course('beltCourse'),
    cornice: course('cornice'),
    corners: {
      style: CORNER_STYLES.includes(source.corners?.style) ? source.corners.style : 'none',
      width: clamp(source.corners?.width, CORNER_WIDTH_RANGE, TRIM_DEFAULTS.corners.width),
      projection: clamp(source.corners?.projection, CORNER_PROJECTION_RANGE, TRIM_DEFAULTS.corners.projection),
    },
    gutters: { enabled: source.gutters?.enabled === true, downspouts: source.gutters?.downspouts !== false },
  };
}

/** Whether any course, anything at the corners, or gutters, are switched on. */
export function hasTrim(trim) {
  return Boolean(trim) && (TRIM_KINDS.some((kind) => trim[kind]?.enabled) || (trim.corners?.style ?? 'none') !== 'none' || trim.gutters?.enabled === true);
}

/**
 * A course's profile: a closed polygon of [d, y] points, d outward from the
 * wall face (0 on it) and y from the course's anchor — the bottom of a water
 * table (the top of the foundation), the middle of a belt course (the floor
 * line), and the top of a cornice (the underside of the soffit).
 */
export function courseProfile(kind, { height: h, projection: p }) {
  if (kind === 'waterTable') {
    // a plain face with a drip sloping back up to the wall
    return [[0, 0], [p, 0], [p, h * 0.55], [0, h]];
  }
  if (kind === 'beltCourse') {
    return [[0, -h / 2], [p, -h / 2], [p, h * 0.3], [0, h / 2]];
  }
  // a cornice: a bed molding against the wall, a cove out to the corona, the corona's face
  return [[0, -h], [p * 0.3, -h], [p * 0.3, -h * 0.7], [p, -h * 0.3], [p, 0], [0, 0]];
}

/** The lowest and highest y of a profile, relative to its anchor. */
export function profileExtent(profile) {
  const ys = profile.map(([, y]) => y);
  return { min: Math.min(...ys), max: Math.max(...ys) };
}

/**
 * Parts of [0, length] left once `cuts` ([from, to] ranges along the run,
 * possibly overlapping or running past either end) are taken out; pieces
 * shorter than `minPiece` are dropped.
 */
export function subtractIntervals(length, cuts, minPiece = 0.02) {
  let pieces = [[0, length]];
  cuts.forEach(([from, to]) => {
    pieces = pieces.flatMap(([a, b]) => {
      if (to <= a || from >= b) {
        return [[a, b]];
      }
      return [[a, Math.max(a, from)], [Math.min(b, to), b]].filter(([x, y]) => y - x > 1e-9);
    });
  });
  return pieces.filter(([a, b]) => b - a >= minPiece);
}

/** Triangles for a simple polygon of [a, b] points (ear clipping; profiles are a handful of points). */
export function triangulatePolygon(points) {
  const area = points.reduce((sum, [x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length];
    return sum + (x * ny - nx * y);
  }, 0);
  const sign = area >= 0 ? 1 : -1;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inside = (p, a, b, c) => sign * cross(a, b, p) >= 0 && sign * cross(b, c, p) >= 0 && sign * cross(c, a, p) >= 0;
  const remaining = points.map((_, i) => i);
  const triangles = [];
  let guard = points.length * points.length;
  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    for (let i = 0; i < remaining.length; i += 1) {
      const [ia, ib, ic] = [remaining[(i + remaining.length - 1) % remaining.length], remaining[i], remaining[(i + 1) % remaining.length]];
      const [a, b, c] = [points[ia], points[ib], points[ic]];
      if (sign * cross(a, b, c) <= 1e-12) {
        continue;
      }
      if (remaining.some((j) => j !== ia && j !== ib && j !== ic && inside(points[j], a, b, c))) {
        continue;
      }
      triangles.push([ia, ib, ic]);
      remaining.splice(i, 1);
      break;
    }
  }
  if (remaining.length === 3) {
    triangles.push([...remaining]);
  }
  return triangles;
}

const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];

/**
 * The offset direction at a corner shared by two runs with outward normals
 * `n0` and `n1`: moving `d` along it keeps `d` off both walls (a miter).
 */
export function miterVector(n0, n1) {
  const denominator = 1 + dot2(n0, n1);
  if (denominator < 1e-6) {
    return n1;
  }
  return [(n0[0] + n1[0]) / denominator, (n0[1] + n1[1]) / denominator];
}

/**
 * The triangles of one course swept along a ring of wall runs.
 *
 * @param {Array<{start: number[], end: number[], normal: number[], y: number|null, pieces?: number[][]}>} ring
 *   Wall runs in order around a building or structure; a run's course is
 *   mitered into its neighbor's only where the two meet (the run's end is
 *   the next one's start), so a chain left open at the house wall ends
 *   square. Each has where the course's anchor sits on it (`y`, world
 *   height; null where the run doesn't carry this course) and the parts of
 *   the run it covers (`pieces`, [from, to] meters from the run's start;
 *   the whole run when omitted).
 * @param {number[][]} profile - See courseProfile.
 * @returns {number[][][]} Triangles of [x, y, z] points.
 */
export function sweepCourse(ring, profile) {
  const triangles = [];
  const capTriangles = triangulatePolygon(profile);
  const n = ring.length;
  ring.forEach((run, index) => {
    if (run.y === null || run.y === undefined || !Number.isFinite(run.y)) {
      return;
    }
    const length = Math.hypot(run.end[0] - run.start[0], run.end[1] - run.start[1]);
    if (length < 1e-6) {
      return;
    }
    const dir = [(run.end[0] - run.start[0]) / length, (run.end[1] - run.start[1]) / length];
    const prev = ring[(index + n - 1) % n];
    const next = ring[(index + 1) % n];
    const joins = (other) => Number.isFinite(other?.y) && Math.abs(other.y - run.y) < 1e-6;
    const pieces = run.pieces ?? [[0, length]];
    const touchesStart = (other) => (other.pieces ?? [[0, 1]]).some(([a]) => a < 1e-6);
    const touchesEnd = (other) => {
      const otherLength = Math.hypot(other.end[0] - other.start[0], other.end[1] - other.start[1]);
      return (other.pieces ?? [[0, otherLength]]).some(([, b]) => b > otherLength - 1e-6);
    };
    const meets = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
    const joinedStart = joins(prev) && touchesEnd(prev) && meets(prev.end, run.start);
    const joinedEnd = joins(next) && touchesStart(next) && meets(run.end, next.start);
    const startMiter = miterVector(prev.normal, run.normal);
    const endMiter = miterVector(run.normal, next.normal);

    pieces.forEach(([a, b]) => {
      const atStart = a < 1e-6 && joinedStart;
      const atEnd = b > length - 1e-6 && joinedEnd;
      const base = (t) => [run.start[0] + dir[0] * t, run.start[1] + dir[1] * t];
      const point = (t, miter, [d, y]) => {
        const [bx, bz] = base(t);
        const [ox, oz] = miter ?? run.normal;
        return [bx + ox * d, run.y + y, bz + oz * d];
      };
      const from = profile.map((p) => point(a, atStart ? startMiter : null, p));
      const to = profile.map((p) => point(b, atEnd ? endMiter : null, p));
      profile.forEach((p, k) => {
        const k2 = (k + 1) % profile.length;
        if (Math.abs(p[0]) < 1e-9 && Math.abs(profile[k2][0]) < 1e-9) {
          return; // against the wall
        }
        triangles.push([from[k], from[k2], to[k2]], [from[k], to[k2], to[k]]);
      });
      if (!atStart) {
        capTriangles.forEach(([i, j, k]) => triangles.push([from[i], from[j], from[k]]));
      }
      if (!atEnd) {
        capTriangles.forEach(([i, j, k]) => triangles.push([to[k], to[j], to[i]]));
      }
    });
  });
  return triangles;
}

/** Dentil block size for a cornice (meters). */
export function dentilSize(cornice) {
  return {
    height: cornice.height * DENTIL_HEIGHT,
    depth: cornice.projection * DENTIL_DEPTH,
    width: Math.max(0.02, cornice.height * DENTIL_WIDTH),
  };
}

/**
 * The triangles of a row of dentils hung under a cornice: small blocks,
 * evenly spaced along each piece of each run (a block's width apart), kept a
 * block's depth clear of every piece's ends so two walls' rows don't collide
 * at a corner.
 *
 * @param {Array<{start: number[], end: number[], normal: number[], y: number|null, pieces?: number[][]}>} ring
 *   As for sweepCourse, with `y` the underside of the cornice.
 */
export function dentilTriangles(ring, size) {
  const { height: h, depth: p, width: w } = size;
  const triangles = [];
  ring.forEach((run) => {
    if (!Number.isFinite(run.y)) {
      return;
    }
    const length = Math.hypot(run.end[0] - run.start[0], run.end[1] - run.start[1]);
    if (length < 1e-6) {
      return;
    }
    const dir = [(run.end[0] - run.start[0]) / length, (run.end[1] - run.start[1]) / length];
    const at = (t, d, y) => [run.start[0] + dir[0] * t + run.normal[0] * d, y, run.start[1] + dir[1] * t + run.normal[1] * d];
    (run.pieces ?? [[0, length]]).forEach(([a, b]) => {
      const from = a + p;
      const span = b - p - from;
      const count = Math.floor((span + w) / (2 * w));
      if (count < 1) {
        return;
      }
      const offset = from + (span - (count * 2 - 1) * w) / 2;
      const top = run.y;
      const bottom = run.y - h;
      for (let i = 0; i < count; i += 1) {
        const u0 = offset + i * 2 * w;
        const u1 = u0 + w;
        const quad = (q) => triangles.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
        quad([at(u0, p, bottom), at(u1, p, bottom), at(u1, p, top), at(u0, p, top)]); // face
        quad([at(u0, 0, bottom), at(u1, 0, bottom), at(u1, p, bottom), at(u0, p, bottom)]); // underside
        quad([at(u0, 0, bottom), at(u0, p, bottom), at(u0, p, top), at(u0, 0, top)]); // one side
        quad([at(u1, p, bottom), at(u1, 0, bottom), at(u1, 0, top), at(u1, p, top)]); // the other
      }
    });
  });
  return triangles;
}

/**
 * The floor lines a volume's belt courses follow, in meters above its
 * foundation: between each pair of its stories, and under its half story if
 * it has a knee wall.
 */
export function floorLines(storyCount, storyHeight, hasKneeWall = false) {
  const lines = [];
  const last = hasKneeWall ? storyCount : storyCount - 1;
  for (let k = 1; k <= last; k += 1) {
    lines.push(k * storyHeight);
  }
  return lines;
}

/**
 * Per-wall trim settings (`wallTrim` in a project), by wall run id (a
 * footprint wall's `wall-run-N`, or a structure's `wall-run-<structure>-<wall>`):
 * for each course, `'on'` or `'off'` in place of the building's setting.
 * Anything else is dropped.
 */
export function normalizeWallTrim(raw) {
  const out = {};
  Object.entries(raw && typeof raw === 'object' ? raw : {}).forEach(([wallId, own]) => {
    const kept = {};
    TRIM_KINDS.forEach((kind) => {
      if (own?.[kind] === 'on' || own?.[kind] === 'off') {
        kept[kind] = own[kind];
      }
    });
    if (typeof wallId === 'string' && wallId && Object.keys(kept).length) {
      out[wallId] = kept;
    }
  });
  return out;
}

/** Whether a course runs along a wall: its own setting, or the building's. */
export function courseOn(trim, wallTrim, wallId, kind) {
  const own = wallTrim?.[wallId]?.[kind];
  return own ? own === 'on' : Boolean(trim?.[kind]?.enabled);
}

/** A quoin's height, the gap between quoins, and how much longer a long quoin is than a short one along its face. */
const QUOIN = Object.freeze({ height: 0.3, gap: 0.03, long: 1.8 });
/** Corners turning less than this (a tower's facets) get nothing. */
const MIN_CORNER_TURN = Math.PI / 3;

/**
 * The triangles of what stands at each outside corner of a ring of wall runs
 * (as sweepCourse takes them, each with `y0` and `y1`, the heights its corner
 * pieces run between, or null for none): corner boards, a board `width` wide
 * on each face, `projection` out from it, running the corner's height; or
 * quoins, blocks stacked up it, long on one face and short on the other in
 * turn. Only a corner where two runs meet, turning out (convex) by at least
 * MIN_CORNER_TURN, gets them; it runs between the higher bottom and the lower
 * top of its two runs.
 */
export function cornerTriangles(ring, corners) {
  if (!corners || corners.style === 'none') {
    return [];
  }
  const triangles = [];
  const n = ring.length;
  ring.forEach((run, index) => {
    const next = ring[(index + 1) % n];
    if (!Number.isFinite(run.y0) || !Number.isFinite(next.y0) || Math.hypot(run.end[0] - next.start[0], run.end[1] - next.start[1]) > 1e-6) {
      return;
    }
    const direction = (r) => {
      const length = Math.hypot(r.end[0] - r.start[0], r.end[1] - r.start[1]);
      return [(r.end[0] - r.start[0]) / length, (r.end[1] - r.start[1]) / length];
    };
    const [da, db] = [direction(run), direction(next)];
    // convex: the next wall heads back from this one's face; and it turns enough to read as a corner
    const turn = Math.acos(Math.max(-1, Math.min(1, da[0] * db[0] + da[1] * db[1])));
    if (dot2(run.normal, db) >= -1e-9 || turn < MIN_CORNER_TURN) {
      return;
    }
    const y0 = Math.max(run.y0, next.y0);
    const y1 = Math.min(run.y1, next.y1);
    if (y1 - y0 < 0.05) {
      return;
    }
    const c = run.end;
    const p = corners.projection;
    const miter = miterVector(run.normal, next.normal);
    // an L round the corner: along this wall back from it `wa`, along the next `wb`
    const piece = (wa, wb, bottom, top) => {
      const plan = [
        [c[0] - da[0] * wa, c[1] - da[1] * wa],
        [c[0] - da[0] * wa + run.normal[0] * p, c[1] - da[1] * wa + run.normal[1] * p],
        [c[0] + miter[0] * p, c[1] + miter[1] * p],
        [c[0] + db[0] * wb + next.normal[0] * p, c[1] + db[1] * wb + next.normal[1] * p],
        [c[0] + db[0] * wb, c[1] + db[1] * wb],
        [c[0], c[1]],
      ];
      triangles.push(...prismTriangles(plan, bottom, top));
    };
    if (corners.style === 'boards') {
      piece(corners.width, corners.width, y0, y1);
      return;
    }
    const long = corners.width * QUOIN.long;
    for (let y = y0, k = 0; y + QUOIN.height <= y1 + 1e-9; y += QUOIN.height + QUOIN.gap, k += 1) {
      piece(k % 2 ? corners.width : long, k % 2 ? long : corners.width, y, y + QUOIN.height);
    }
  });
  return triangles;
}

/** A plan polygon ([x, z]) stood up from `bottom` to `top`, as triangles (its sides against the walls included: they're hidden). */
function prismTriangles(plan, bottom, top) {
  const at = ([x, z], y) => [x, y, z];
  const out = [];
  triangulatePolygon(plan).forEach(([i, j, k]) => {
    out.push([at(plan[i], top), at(plan[j], top), at(plan[k], top)]);
    out.push([at(plan[k], bottom), at(plan[j], bottom), at(plan[i], bottom)]);
  });
  plan.forEach((point, i) => {
    const next = plan[(i + 1) % plan.length];
    out.push([at(point, bottom), at(next, bottom), at(next, top)], [at(point, bottom), at(next, top), at(point, top)]);
  });
  return out;
}
