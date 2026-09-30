/**
 * Chimneys, each set on one of the house's footprint walls: either standing
 * outside against it from the ground up (an end chimney), or set in from it,
 * rising from the wall top through the roof. Either way it rises
 * `aboveRoof` over the highest roof within CHIMNEY_REACH of it (measured by
 * js/extrusion.js from the built roof), with a cap and a flue pot on top.
 *
 * Plain data: records, and the chimney's parts in world space, each a plan
 * rectangle (its four corners, [x, z], in order) stood from `bottom` to
 * `top`; js/extrusion.js builds them.
 */

export const CHIMNEY_DEFAULTS = Object.freeze({
  position: 'outside', offset: 0, width: 1.2, depth: 0.6, inset: 1, aboveRoof: 0.9, material: 'brick',
});
export const CHIMNEY_POSITIONS = Object.freeze(['outside', 'inside']);
export const CHIMNEY_WIDTH_RANGE = Object.freeze([0.4, 3]);
export const CHIMNEY_DEPTH_RANGE = Object.freeze([0.3, 1.5]);
export const CHIMNEY_ABOVE_RANGE = Object.freeze([0.3, 3]);
/** How far round a chimney it must clear the roof. */
export const CHIMNEY_REACH = 3;
const CAP = Object.freeze({ height: 0.1, overhang: 0.06 });
const FLUE = Object.freeze({ size: 0.25, height: 0.3 });

const inRange = (value, [min, max], fallback) => (Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback);

/** A chimney record from partial or untrusted input; null without a host wall. */
export function normalizeChimney(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.hostWallRunId !== 'string' || !raw.hostWallRunId) {
    return null;
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : null,
    hostWallRunId: raw.hostWallRunId,
    position: CHIMNEY_POSITIONS.includes(raw.position) ? raw.position : CHIMNEY_DEFAULTS.position,
    offset: Number.isFinite(raw.offset) ? raw.offset : 0,
    width: inRange(raw.width, CHIMNEY_WIDTH_RANGE, CHIMNEY_DEFAULTS.width),
    depth: inRange(raw.depth, CHIMNEY_DEPTH_RANGE, CHIMNEY_DEFAULTS.depth),
    inset: Math.max(0, Number.isFinite(raw.inset) ? raw.inset : CHIMNEY_DEFAULTS.inset),
    aboveRoof: inRange(raw.aboveRoof, CHIMNEY_ABOVE_RANGE, CHIMNEY_DEFAULTS.aboveRoof),
    material: typeof raw.material === 'string' && raw.material ? raw.material : CHIMNEY_DEFAULTS.material,
  };
}

/** Normalizes a list, dropping unplaceable ones and giving each a unique id (`chimney-N`). */
export function normalizeChimneys(list) {
  const chimneys = (Array.isArray(list) ? list : []).map(normalizeChimney).filter(Boolean);
  const used = new Set();
  let next = 1;
  return chimneys.map((chimney) => {
    let { id } = chimney;
    if (!id || used.has(id)) {
      while (used.has(`chimney-${next}`) || chimneys.some((other) => other.id === `chimney-${next}`)) {
        next += 1;
      }
      id = `chimney-${next}`;
    }
    used.add(id);
    return { ...chimney, id };
  });
}

/**
 * A chimney's plan: the four corners of its stack on its host wall run
 * (start, end, normal: outward), `offset` along the run from its midpoint.
 * Outside, it stands against the wall face; inside, `inset` in from it.
 */
export function chimneyPlan(chimney, run) {
  const length = Math.hypot(run.end[0] - run.start[0], run.end[1] - run.start[1]);
  const right = [(run.end[0] - run.start[0]) / length, (run.end[1] - run.start[1]) / length];
  const mid = [(run.start[0] + run.end[0]) / 2, (run.start[1] + run.end[1]) / 2];
  const [near, far] = chimney.position === 'inside' ? [-chimney.inset, -chimney.inset - chimney.depth] : [0, chimney.depth];
  const at = (u, d) => [mid[0] + right[0] * u + run.normal[0] * d, mid[1] + right[1] * u + run.normal[1] * d];
  const [u0, u1] = [chimney.offset - chimney.width / 2, chimney.offset + chimney.width / 2];
  return [at(u0, near), at(u1, near), at(u1, far), at(u0, far)];
}

/** A plan rectangle (four corners, in order) grown `by` on every side. */
function grown(plan, by) {
  const center = plan.reduce(([x, z], [px, pz]) => [x + px / 4, z + pz / 4], [0, 0]);
  const [a, b, , d] = plan;
  const along = [b[0] - a[0], b[1] - a[1]];
  const across = [d[0] - a[0], d[1] - a[1]];
  const unit = (v) => v.map((c) => c / Math.hypot(...v));
  const [ua, uc] = [unit(along), unit(across)];
  const halfA = Math.hypot(...along) / 2 + by;
  const halfC = Math.hypot(...across) / 2 + by;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sa, sc]) => [
    center[0] + ua[0] * sa * halfA + uc[0] * sc * halfC,
    center[1] + ua[1] * sa * halfA + uc[1] * sc * halfC,
  ]);
}

/**
 * A chimney's parts: its stack from `bottom` to `top`, then a cap wider than
 * it, and a flue pot in its middle.
 */
export function chimneyParts(plan, bottom, top) {
  const center = plan.reduce(([x, z], [px, pz]) => [x + px / 4, z + pz / 4], [0, 0]);
  // a square pot, turned with the stack
  const [a, b] = plan;
  const along = [b[0] - a[0], b[1] - a[1]].map((c) => c / Math.hypot(b[0] - a[0], b[1] - a[1]));
  const across = [-along[1], along[0]];
  const h = FLUE.size / 2;
  const flue = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sa, sc]) => [
    center[0] + along[0] * sa * h + across[0] * sc * h, center[1] + along[1] * sa * h + across[1] * sc * h,
  ]);
  return [
    { part: 'stack', plan, bottom, top },
    { part: 'cap', plan: grown(plan, CAP.overhang), bottom: top, top: top + CAP.height },
    { part: 'flue', plan: flue, bottom: top + CAP.height, top: top + CAP.height + FLUE.height },
  ];
}

/** A part (a plan rectangle stood from `bottom` to `top`) as a closed box of triangles. */
export function partTriangles({ plan, bottom, top }) {
  const at = ([x, z], y) => [x, y, z];
  const [a, b, c, d] = plan;
  const out = [
    [at(a, top), at(b, top), at(c, top)], [at(a, top), at(c, top), at(d, top)],
    [at(a, bottom), at(c, bottom), at(b, bottom)], [at(a, bottom), at(d, bottom), at(c, bottom)],
  ];
  plan.forEach((point, i) => {
    const next = plan[(i + 1) % 4];
    out.push([at(point, bottom), at(next, bottom), at(next, top)], [at(point, bottom), at(next, top), at(point, top)]);
  });
  return out;
}
