/**
 * Gutters along the eaves, and downspouts down the walls from them.
 *
 * A gutter hangs at the roof's edge: out from the wall by the eave's depth,
 * its top just under the edge (both measured by js/extrusion.js on the built
 * roof, which also tells an eave, level along its wall, from a rake), swept
 * along the eave with js/trim.js's sweepCourse so it miters round a corner
 * where eaves meet (a hip) and ends square where they don't.
 * Past a gable wall it runs on as far as it overhangs the eave. Downspouts
 * drop from each free end of a run of gutter, or, where the gutter goes all
 * the way round, from two opposite corners.
 *
 * Plain data: rings for sweepCourse and parts (plan rectangles stood from
 * `bottom` to `top`, as js/chimneys.js builds them).
 */

/** A gutter's section: out from the fascia, down from its top (an open-topped box, flaring a little). */
export const GUTTER_PROFILE = Object.freeze([[0, -0.12], [0.12, -0.12], [0.14, 0], [0, 0]]);
const GUTTER_DROP = 0.02;
const DOWNSPOUT = Object.freeze({ size: 0.08, off: 0.06, back: 0.25, foot: 0.05 });

/** Where two offset lines (a run's line moved out `e` along its normal) meet, from the corner `p` they share. */
function meet(p, n1, e1, n2, e2) {
  const det = n1[0] * n2[1] - n1[1] * n2[0];
  if (Math.abs(det) < 1e-9) {
    return [p[0] + n1[0] * e1, p[1] + n1[1] * e1];
  }
  // solve n1 . q = e1, n2 . q = e2 for the offset q from p
  return [p[0] + (e1 * n2[1] - e2 * n1[1]) / det, p[1] + (n1[0] * e2 - n2[0] * e1) / det];
}

/**
 * A ring for sweepCourse from the footprint's wall runs in order, each with
 * its eave (`eave`: { depth, y }, the edge's distance out and height) or
 * null where it has none: each eave's line moved out to its edge, running
 * from where it meets its neighbors' (a neighbor with no eave taken at the
 * same depth, so the gutter runs on past a gable wall as far as the eave
 * overhangs), at the edge's height less a little. Each keeps its wall's own
 * line (`wall`) for its downspouts.
 */
export function gutterRing(runs) {
  const n = runs.length;
  return runs.map((run, i) => {
    const prev = runs[(i + n - 1) % n];
    const next = runs[(i + 1) % n];
    const wall = { start: run.start, end: run.end };
    if (!run.eave) {
      return {
        start: run.start, end: run.end, normal: run.normal, y: null, wall,
      };
    }
    const e = run.eave.depth;
    const start = meet(run.start, prev.normal, prev.eave ? prev.eave.depth : e, run.normal, e);
    const end = meet(run.end, run.normal, e, next.normal, next.eave ? next.eave.depth : e);
    return {
      start, end, normal: run.normal, y: run.eave.y - GUTTER_DROP, depth: e, wall,
    };
  });
}

/**
 * The downspouts for a gutter ring: one at each free end of a run of gutter
 * (where the next wall has none, or hangs it at another height), or two at
 * opposite corners where it goes all the way round; each a pipe down the
 * wall a little back from the corner, and a leader across under the soffit
 * out to the gutter.
 */
export function downspoutParts(ring) {
  const n = ring.length;
  const has = (run) => Number.isFinite(run.y);
  const joined = (a, b) => has(a) && has(b) && Math.abs(a.y - b.y) < 1e-6;
  const ends = [];
  ring.forEach((run, i) => {
    if (!has(run)) {
      return;
    }
    if (!joined(ring[(i + n - 1) % n], run)) {
      ends.push({ run, atStart: true });
    }
    if (!joined(run, ring[(i + 1) % n])) {
      ends.push({ run, atStart: false });
    }
  });
  if (!ends.length && ring.every(has)) {
    ends.push({ run: ring[0], atStart: true }, { run: ring[Math.floor(n / 2)], atStart: true });
  }
  return ends.flatMap(({ run, atStart }) => {
    const { start, end } = run.wall;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const along = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
    const back = Math.min(DOWNSPOUT.back, length / 2);
    const u = atStart ? back : length - back;
    const s = DOWNSPOUT.size / 2;
    const [nx, nz] = run.normal;
    // a square across the pipe: along the wall `s` either side, out from `d0` to `d1`
    const square = (d0, d1) => [[-s, d0], [s, d0], [s, d1], [-s, d1]].map(([du, d]) => [
      start[0] + along[0] * (u + du) + nx * d, start[1] + along[1] * (u + du) + nz * d,
    ]);
    const gutterBottom = run.y - 0.12;
    const leaderTop = gutterBottom;
    const leaderBottom = gutterBottom - DOWNSPOUT.size;
    return [
      { part: 'downspout', plan: square(DOWNSPOUT.off, DOWNSPOUT.off + DOWNSPOUT.size), bottom: DOWNSPOUT.foot, top: leaderTop },
      { part: 'leader', plan: square(DOWNSPOUT.off + DOWNSPOUT.size, Math.max(DOWNSPOUT.off + DOWNSPOUT.size, run.depth + 0.06)), bottom: leaderBottom, top: leaderTop },
    ].filter((part) => part.top - part.bottom > 1e-6 && Math.hypot(part.plan[2][0] - part.plan[1][0], part.plan[2][1] - part.plan[1][1]) > 1e-6);
  });
}
