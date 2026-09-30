/**
 * Railings along a railing run (a porch's open side, a widow's walk's edge;
 * see structureFacade and roofWalkFacade in js/roof-structures.js): a top
 * rail and a bottom rail with a filling between them in one of several
 * styles, and newel posts where a run ends free (a walk's corners, either
 * side of a porch's steps).
 *
 * Plain data: parts, and their triangles, in the run's own frame (u along it
 * from its start, c across it from its center line, y up from its floor);
 * js/extrusion.js places them.
 */

import { subtractIntervals } from './trim.js';

export const TOP_RAIL = Object.freeze({ width: 0.07, height: 0.06 });
export const BOTTOM_RAIL = Object.freeze({ width: 0.05, height: 0.05, lift: 0.08 });
export const NEWEL = Object.freeze({ width: 0.1, cap: 0.05 });
/** A stretch of railing shorter than this is left out. */
export const MIN_RAIL_PIECE = 0.2;

/**
 * The filling between the rails:
 * - `square`: square balusters;
 * - `turned`: lathe-turned balusters, with a vase below the middle;
 * - `flat`: flat sawn boards, broad along the run;
 * - `panel`: one solid panel;
 * - `bars`: horizontal bars, `spacing` apart up the railing.
 */
export const RAILING_STYLES = Object.freeze(['square', 'turned', 'flat', 'panel', 'bars']);

export const RAILING_DEFAULTS = Object.freeze({
  enabled: true, style: 'square', height: 1, spacing: 0.13,
});
export const RAILING_HEIGHT_RANGE = Object.freeze([0.5, 1.5]);
export const RAILING_SPACING_RANGE = Object.freeze([0.06, 0.5]);

export const SQUARE_WIDTH = 0.035;
export const TURNED_RADIUS = 0.024;
export const FLAT_BOARD = Object.freeze({ width: 0.09, thickness: 0.022 });
export const PANEL_THICKNESS = 0.03;
export const BAR_SIZE = 0.025;
const TURNED_SEGMENTS = 8;
// a turned baluster's radius (a fraction of TURNED_RADIUS) up its height: full at the ends, a vase below the middle
const TURNED_PROFILE = Object.freeze([
  [0, 1], [0.12, 1], [0.17, 0.55], [0.32, 0.85], [0.45, 1.05], [0.6, 0.55], [0.78, 0.5], [0.86, 0.8], [0.9, 1], [1, 1],
]);

/**
 * A railing's settings from partial or older input (a porch's plain
 * true/false before railings could be styled): `enabled`, `style` (one of
 * RAILING_STYLES), `height` of the top rail above the floor, and `spacing`
 * (balusters' center to center, or bars' up the railing).
 */
export function normalizeRailing(raw) {
  const source = raw === false ? { enabled: false } : raw && typeof raw === 'object' ? raw : {};
  const inRange = (value, [min, max], fallback) => (Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback);
  return {
    enabled: source.enabled !== false,
    style: RAILING_STYLES.includes(source.style) ? source.style : RAILING_DEFAULTS.style,
    height: inRange(source.height, RAILING_HEIGHT_RANGE, RAILING_DEFAULTS.height),
    spacing: inRange(source.spacing, RAILING_SPACING_RANGE, RAILING_DEFAULTS.spacing),
  };
}

/**
 * The parts of a railing (settings as normalizeRailing gives them, its top
 * rail at `height`, the settings' own unless lower) along a run `length`
 * long, left out across `gaps` ([from, to] along the run), with newel posts
 * at `posts` and just outside each gap. Rails and balusters stop at the
 * faces of every post: its newels, and `obstacles` ([from, to] along the
 * run) standing there already (a porch's own posts). A part is a box ({ u0,
 * u1, c0, c1, y0, y1 }) or a turned baluster ({ turned: true, u, y0, y1 });
 * `part` names which piece of the railing it is.
 */
export function railingParts(length, settings, {
  height = settings.height, gaps = [], posts = [], obstacles = [],
} = {}) {
  const parts = [];
  const box = (part, u0, u1, width, y0, y1) => parts.push({
    part, u0, u1, c0: -width / 2, c1: width / 2, y0, y1,
  });
  const railBottom = height - TOP_RAIL.height;
  const lowTop = BOTTOM_RAIL.lift + BOTTOM_RAIL.height;
  // a gap's newels stand just outside it
  const newels = [...new Set([...posts, ...gaps.flatMap(([from, to]) => [from - NEWEL.width / 2, to + NEWEL.width / 2])]
    .filter((u) => u >= -1e-6 && u <= length + 1e-6)
    .map((u) => Math.min(Math.max(u, NEWEL.width / 2), length - NEWEL.width / 2).toFixed(6)))].map(Number);
  const blocked = [...gaps, ...obstacles, ...newels.map((u) => [u - NEWEL.width / 2, u + NEWEL.width / 2])];
  subtractIntervals(length, blocked, MIN_RAIL_PIECE).forEach(([a, b]) => {
    box('rail', a, b, TOP_RAIL.width, railBottom, height);
    box('rail', a, b, BOTTOM_RAIL.width, BOTTOM_RAIL.lift, lowTop);
    if (railBottom - lowTop < 0.02) {
      return;
    }
    if (settings.style === 'panel') {
      box('panel', a, b, PANEL_THICKNESS, lowTop, railBottom);
      return;
    }
    if (settings.style === 'bars') {
      const count = Math.max(1, Math.round((railBottom - lowTop) / settings.spacing) - 1);
      const step = (railBottom - lowTop) / (count + 1);
      for (let i = 1; i <= count; i += 1) {
        const y = lowTop + step * i;
        box('bar', a, b, BAR_SIZE, y - BAR_SIZE / 2, y + BAR_SIZE / 2);
      }
      return;
    }
    // balusters evenly spaced, the ends half a space in from each end
    const count = Math.floor((b - a) / settings.spacing);
    const space = (b - a) / Math.max(count, 1);
    for (let i = 0; i < count; i += 1) {
      const u = a + space * (i + 0.5);
      if (settings.style === 'turned') {
        parts.push({
          part: 'baluster', turned: true, u, y0: lowTop, y1: railBottom,
        });
      } else if (settings.style === 'flat') {
        parts.push({
          part: 'baluster', u0: u - FLAT_BOARD.width / 2, u1: u + FLAT_BOARD.width / 2, c0: -FLAT_BOARD.thickness / 2, c1: FLAT_BOARD.thickness / 2, y0: lowTop, y1: railBottom,
        });
      } else {
        box('baluster', u - SQUARE_WIDTH / 2, u + SQUARE_WIDTH / 2, SQUARE_WIDTH, lowTop, railBottom);
      }
    }
  });
  newels.forEach((u) => {
    box('newel', u - NEWEL.width / 2, u + NEWEL.width / 2, NEWEL.width, 0, height + NEWEL.cap);
  });
  return parts;
}

/** A part's triangles, as [u, c, y] points in the run's frame. */
export function partTriangles(part) {
  if (part.turned) {
    return turnedTriangles(part);
  }
  const {
    u0, u1, c0, c1, y0, y1,
  } = part;
  const corners = [
    [u0, c0, y0], [u1, c0, y0], [u1, c1, y0], [u0, c1, y0],
    [u0, c0, y1], [u1, c0, y1], [u1, c1, y1], [u0, c1, y1],
  ];
  const quad = (a, b, c, d) => [[corners[a], corners[b], corners[c]], [corners[a], corners[c], corners[d]]];
  return [
    ...quad(0, 1, 2, 3), ...quad(4, 7, 6, 5), ...quad(0, 4, 5, 1), ...quad(1, 5, 6, 2), ...quad(2, 6, 7, 3), ...quad(3, 7, 4, 0),
  ];
}

function turnedTriangles({ u, y0, y1 }) {
  const rings = TURNED_PROFILE.map(([t, r]) => {
    const y = y0 + (y1 - y0) * t;
    return Array.from({ length: TURNED_SEGMENTS }, (_, k) => {
      const angle = (2 * Math.PI * k) / TURNED_SEGMENTS;
      return [u + Math.cos(angle) * r * TURNED_RADIUS, Math.sin(angle) * r * TURNED_RADIUS, y];
    });
  });
  const triangles = [];
  for (let i = 0; i + 1 < rings.length; i += 1) {
    for (let k = 0; k < TURNED_SEGMENTS; k += 1) {
      const k2 = (k + 1) % TURNED_SEGMENTS;
      triangles.push([rings[i][k], rings[i][k2], rings[i + 1][k2]], [rings[i][k], rings[i + 1][k2], rings[i + 1][k]]);
    }
  }
  const cap = (ring, y) => ring.forEach((point, k) => triangles.push([[u, 0, y], ring[(k + 1) % TURNED_SEGMENTS], point]));
  cap(rings[0], y0);
  cap(rings[rings.length - 1], y1);
  return triangles;
}
