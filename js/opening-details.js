/**
 * The details that make a window or door read as one: a window's sill, head
 * cap, grille (its sashes' muntins), shutters, and arched top; a door's
 * leaves (one or a pair), sidelights, transom, and head cap.
 *
 * Plain data, in the opening's own frame: u along the wall (from the wall's
 * midpoint, as the opening's u0/u1), v up from the wall's floor line (as
 * v0/v1), d out from the wall face. Boxes are { part, u0, u1, v0, v1, d0, d1,
 * material } ('frame' or 'shutter'); panes are { part, points, material }
 * ('glass' or 'panel') flat in the pane's plane. js/extrusion.js builds them.
 */

import { FRAME_CASING_WIDTH, FRAME_DEPTH, PANE_RECESS } from './openings.js';

/** A window's grille: its sashes (one, or two hung one over the other) and each sash's lights across and up. */
export const GRILLES = Object.freeze({
  none: null,
  '1/1': Object.freeze({ sashes: 2, cols: 1, rows: 1 }),
  '2/2': Object.freeze({ sashes: 2, cols: 2, rows: 1 }),
  '6/6': Object.freeze({ sashes: 2, cols: 3, rows: 2 }),
  '9/9': Object.freeze({ sashes: 2, cols: 3, rows: 3 }),
});
export const HEADS = Object.freeze(['none', 'cap']);
export const WINDOW_TOPS = Object.freeze(['flat', 'arch']);
/** The widest a door's sidelights, and the tallest its transom, can be. */
export const SIDELIGHT_RANGE = Object.freeze([0, 0.6]);
export const TRANSOM_RANGE = Object.freeze([0, 0.8]);
/** The narrowest and shortest a door's leaves can be left by its sidelights and transom. */
export const MIN_LEAF_WIDTH = 0.6;
export const MIN_LEAF_HEIGHT = 1.8;

const MULLION = 0.06;
const MUNTIN = 0.02;
const MEETING_RAIL = 0.04;
const SILL = Object.freeze({ drop: 0.05, overhang: 0.03, projection: 0.05 });
const CAP = Object.freeze({ height: 0.07, overhang: 0.04, projection: 0.04 });
const SHUTTER_DEPTH = 0.03;
const ARCH_SEGMENTS = 16;

const inRange = (value, [min, max], fallback) => (Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback);

/**
 * An opening's details, from partial or older input. A window: `sill` (on
 * unless turned off), `head` ('none' or 'cap'), `grille` (a GRILLES key),
 * `shutters`, `top` ('flat' or 'arch'). A door: `leaves` (1 or 2),
 * `sidelights` and `transom` (their width and height inside the door's
 * overall size; 0 for none), `head`.
 */
export function normalizeDetails(kind, raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const head = HEADS.includes(source.head) ? source.head : 'none';
  if (kind === 'door') {
    return {
      leaves: source.leaves === 2 ? 2 : 1,
      sidelights: inRange(source.sidelights, SIDELIGHT_RANGE, 0),
      transom: inRange(source.transom, TRANSOM_RANGE, 0),
      head,
    };
  }
  return {
    sill: source.sill !== false,
    head,
    grille: Object.hasOwn(GRILLES, source.grille) ? source.grille : 'none',
    shutters: source.shutters === true,
    top: WINDOW_TOPS.includes(source.top) ? source.top : 'flat',
  };
}

/**
 * The outline of an opening from u0 to u1 and v0 to v1, arched or flat: an
 * arched one rises to v1 in a half circle across its width (the arch's
 * springing line a half width below), so it keeps its overall size.
 */
export function openingPolygon(u0, v0, u1, v1, top = 'flat') {
  if (top !== 'arch') {
    return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
  }
  const r = (u1 - u0) / 2;
  const spring = Math.max(v0, v1 - r);
  const center = (u0 + u1) / 2;
  const arc = Array.from({ length: ARCH_SEGMENTS + 1 }, (_, k) => {
    const angle = (Math.PI * k) / ARCH_SEGMENTS;
    return [center + r * Math.cos(angle), spring + Math.min(r, v1 - v0) * Math.sin(angle)];
  });
  return [[u0, v0], [u1, v0], ...arc];
}

/**
 * Where a door's leaves stand inside its overall opening, less its
 * sidelights and transom (each with a mullion between): the part a walk-in
 * room's doorway is cut through. Kept at least MIN_LEAF_WIDTH wide and
 * MIN_LEAF_HEIGHT tall, the sidelights and transom giving way.
 */
export function leafSpan(resolved) {
  const details = normalizeDetails('door', resolved.details);
  const width = resolved.u1 - resolved.u0;
  const height = resolved.v1 - resolved.v0;
  const side = details.sidelights > 0 ? Math.min(details.sidelights + MULLION, Math.max(0, (width - MIN_LEAF_WIDTH) / 2)) : 0;
  const top = details.transom > 0 ? Math.min(details.transom + MULLION, Math.max(0, height - MIN_LEAF_HEIGHT)) : 0;
  return {
    u0: resolved.u0 + side, u1: resolved.u1 - side, v0: resolved.v0, v1: resolved.v1 - top,
  };
}

/**
 * The detail parts of a resolved opening (see the file's comment). `open`
 * leaves out a door's leaves (it stands open into a walk-in room; its
 * leaves are built there), keeping its sidelights and transom.
 */
export function detailParts(resolved, { open = false } = {}) {
  const {
    u0, u1, v0, v1, kind,
  } = resolved;
  const details = normalizeDetails(kind, resolved.details);
  const c = FRAME_CASING_WIDTH;
  const pane = FRAME_DEPTH - PANE_RECESS;
  const boxes = [];
  const panes = [];
  const box = (part, bu0, bu1, bv0, bv1, d0, d1, material = 'frame') => boxes.push({
    part, u0: bu0, u1: bu1, v0: bv0, v1: bv1, d0, d1, material,
  });
  // a bar in the pane's plane, standing a little proud of the glass
  const bar = (part, bu0, bu1, bv0, bv1) => box(part, bu0, bu1, bv0, bv1, pane - 0.005, pane + 0.015);
  if (details.head === 'cap') {
    box('head', u0 - c - CAP.overhang, u1 + c + CAP.overhang, v1 + c, v1 + c + CAP.height, 0, FRAME_DEPTH + CAP.projection);
  }

  if (kind === 'door') {
    const leaf = leafSpan({ ...resolved, details });
    if (!open) {
      if (details.leaves === 2) {
        const mid = (leaf.u0 + leaf.u1) / 2;
        panes.push({ part: 'leaf', points: openingPolygon(leaf.u0, leaf.v0, mid - 0.005, leaf.v1), material: 'panel' });
        panes.push({ part: 'leaf', points: openingPolygon(mid + 0.005, leaf.v0, leaf.u1, leaf.v1), material: 'panel' });
        bar('meeting-stile', mid - 0.01, mid + 0.01, leaf.v0, leaf.v1);
      } else {
        panes.push({ part: 'leaf', points: openingPolygon(leaf.u0, leaf.v0, leaf.u1, leaf.v1), material: 'panel' });
      }
    }
    if (leaf.u0 > u0 + 1e-9) {
      panes.push({ part: 'sidelight', points: openingPolygon(u0, v0, leaf.u0 - MULLION, leaf.v1), material: 'glass' });
      panes.push({ part: 'sidelight', points: openingPolygon(leaf.u1 + MULLION, v0, u1, leaf.v1), material: 'glass' });
      box('mullion', leaf.u0 - MULLION, leaf.u0, v0, leaf.v1, 0, FRAME_DEPTH);
      box('mullion', leaf.u1, leaf.u1 + MULLION, v0, leaf.v1, 0, FRAME_DEPTH);
    }
    if (leaf.v1 < v1 - 1e-9) {
      panes.push({ part: 'transom', points: openingPolygon(u0, leaf.v1 + MULLION, u1, v1), material: 'glass' });
      box('mullion', u0, u1, leaf.v1, leaf.v1 + MULLION, 0, FRAME_DEPTH);
    }
    return { boxes, panes };
  }

  panes.push({ part: 'glass', points: openingPolygon(u0, v0, u1, v1, details.top), material: 'glass' });
  if (details.sill) {
    box('sill', u0 - c - SILL.overhang, u1 + c + SILL.overhang, v0 - c - SILL.drop, v0 - c, 0, FRAME_DEPTH + SILL.projection);
  }
  if (details.shutters) {
    // a pair, each half the window's width, hung beside its casing
    const half = (u1 - u0) / 2;
    box('shutter', u0 - c - half, u0 - c, v0, v1, 0, SHUTTER_DEPTH, 'shutter');
    box('shutter', u1 + c, u1 + c + half, v0, v1, 0, SHUTTER_DEPTH, 'shutter');
  }
  const grille = GRILLES[details.grille];
  if (grille) {
    // under an arch the muntins stop at its springing line
    const topOfLights = details.top === 'arch' ? Math.max(v0, v1 - (u1 - u0) / 2) : v1;
    const sashHeight = (topOfLights - v0) / grille.sashes;
    for (let s = 0; s < grille.sashes; s += 1) {
      const sv0 = v0 + s * sashHeight;
      const sv1 = sv0 + sashHeight;
      if (s > 0) {
        bar('meeting-rail', u0, u1, sv0 - MEETING_RAIL / 2, sv0 + MEETING_RAIL / 2);
      }
      for (let i = 1; i < grille.cols; i += 1) {
        const u = u0 + ((u1 - u0) * i) / grille.cols;
        bar('muntin', u - MUNTIN / 2, u + MUNTIN / 2, sv0, sv1);
      }
      for (let j = 1; j < grille.rows; j += 1) {
        const v = sv0 + (sashHeight * j) / grille.rows;
        bar('muntin', u0, u1, v - MUNTIN / 2, v + MUNTIN / 2);
      }
    }
  }
  return { boxes, panes };
}
