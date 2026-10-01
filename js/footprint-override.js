/**
 * The footprint override written back to the Dixon game (docs/
 * FOOTPRINT_EDITING_PLAN.md, phase 5): one file per building,
 * `game/data/footprint_overrides/<id>.json`, with the corrected outline in
 * game coordinates and the porches Turn into a porch made, so the game's own
 * generated building gets them too. Pure functions with no DOM or THREE
 * dependency.
 *
 * `based_on.hash` is the fingerprint of the game's traced outline the
 * override replaces (`placement.basedOn`, recorded at import): outlineHash in js/import.js, the same as `outline_hash()` in
 * dixon_dem's pipeline/buildings/footprints.py (the same for the same
 * corners to the millimeter, whatever corner they start at or which way they
 * run), so the game notices when that outline has since changed.
 */
import { openRing, toGameFrame } from './footprint-editor.js';
import { outlineHash } from './import.js';
import { computeFootprintMetrics } from './footprint.js';

export const OVERRIDE_FORMAT = 'dixon-footprint-override';
export const OVERRIDE_VERSION = 1;

/** A porch under this deep and this wide is a stoop to the game. */
const STOOP_DEPTH = 1.5;
const STOOP_WIDTH = 2.5;

/**
 * A porch's legs in Composer's frame: the back edge of each part of it
 * along the house, `a` to `b`, and its depth out from the wall. A projecting
 * porch has one; a wraparound one per wall, the leg that turns a corner
 * running on past it by the depth (as the porch is built, see expandWraps in
 * js/roof-structures.js). Each leg runs the way a positive-area outline runs
 * along that wall, so its outward normal (dz, -dx) points away from the
 * building (the game's edge_dir_normal, for counter-clockwise rings).
 *
 * @param {object} structure - a normalized porch record
 * @param {{ minX: number, maxX: number, minZ: number, maxZ: number }} volume - the mass it stands on
 */
export function porchLegs(structure, volume) {
  const depth = Number.isFinite(structure.setback) ? -structure.setback : structure.depth;
  const walls = structure.wrap?.walls ?? [structure.hostSide];
  const loop = walls.length === 4;
  return walls.map((wall, i) => {
    const along = wall === 'minX' || wall === 'maxX' ? 'Z' : 'X';
    let [lo, hi] = [volume[`min${along}`], volume[`max${along}`]];
    if (!structure.wrap) {
      const middle = (lo + hi) / 2 + structure.offset;
      [lo, hi] = [middle - structure.width / 2, middle + structure.width / 2];
    } else {
      const previous = i > 0 ? walls[i - 1] : (loop ? walls[walls.length - 1] : null);
      const next = i < walls.length - 1 ? walls[i + 1] : (loop ? walls[0] : null);
      if (!previous) {
        // the first leg, `startLength` back from the corner it turns
        [lo, hi] = next === `max${along}` ? [Math.max(lo, hi - structure.wrap.startLength), hi] : [lo, Math.min(hi, lo + structure.wrap.startLength)];
      }
      if (!next) {
        // the last leg, `endLength` on from the corner it turns onto its wall
        [lo, hi] = previous === `max${along}` ? [Math.max(lo, hi - structure.wrap.endLength), hi] : [lo, Math.min(hi, lo + structure.wrap.endLength)];
      }
      // on past the corner onto the next wall: the corner square is this leg's
      if (next === `max${along}`) {
        hi += depth;
      } else if (next === `min${along}`) {
        lo -= depth;
      }
    }
    const line = volume[wall];
    const point = (t) => (along === 'X' ? [t, line] : [line, t]);
    // a positive-area outline (outward normal (dz, -dx)) runs +x along minZ, +z along maxX, -x along maxZ, -z along minX
    const forward = wall === 'minZ' || wall === 'maxX';
    return { a: point(forward ? lo : hi), b: point(forward ? hi : lo), depth };
  });
}

/** The game's porch kind nearest a porch record, for its style (see the plan). */
export function gamePorchKind(structure) {
  if (structure.wrap) {
    return 'wrap';
  }
  const depth = Number.isFinite(structure.setback) ? -structure.setback : structure.depth;
  if (depth < STOOP_DEPTH && structure.width < STOOP_WIDTH) {
    return 'stoop';
  }
  return structure.roofType === 'gable' ? 'gable_full' : 'shed_full';
}

/**
 * The override file for a building from the game.
 *
 * @param {object} args
 * @param {Array<[number, number]>} args.footprint - the outline, in Composer's frame
 * @param {{ id: string, source?: string, rotation: number, center: number[], trace?: Array<[number, number]>, basedOn?: { source: string, hash: string } }} args.placement
 * @param {object[]} [args.structures] - the building's structures; the porches made from the footprint (`fromFootprint`) go in the file, recessed ones aside (the game can't cut into its mass)
 * @param {Array<{ id: string }>} [args.volumes] - the masses, as Composer cut them (for the porches' walls)
 * @param {Date} [args.edited]
 * @param {string} [args.note]
 */
export function buildFootprintOverride({
  footprint, placement, structures = [], volumes = [], edited = new Date(), note = '',
}) {
  if (!placement?.id) {
    throw new RangeError('Only a building opened from the game has a footprint to save back to it.');
  }
  const trace = Array.isArray(placement.trace) && placement.trace.length >= 3 ? openRing(placement.trace) : null;
  // in the winding the game's own outlines have (the trace's), or the game's usual counter-clockwise
  const positive = (points) => computeFootprintMetrics(points).signedArea > 0;
  const gameWinding = trace ? positive(trace) : true;
  let outline = toGameFrame(openRing(footprint), placement).map(roundPoint);
  if (positive(outline) !== gameWinding) {
    outline = outline.reverse();
  }
  const porches = structures
    .filter((structure) => structure.fromFootprint && structure.kind === 'porch' && structure.mount !== 'recess' && !structure.hostStructureId)
    .flatMap((structure) => {
      const volume = volumes.find((candidate) => candidate.id === structure.hostVolumeId);
      if (!volume) {
        return [];
      }
      // as a positive-area (the pipeline's counter-clockwise) outline runs, whatever the file's
      // winding: the game builds a leg out along edge_dir_normal, outward only for that direction
      const legs = porchLegs(structure, volume).map(({ a, b, depth }) => {
        const [ga, gb] = toGameFrame([a, b], placement).map(roundPoint);
        return { a: ga, b: gb, depth: round(depth) };
      });
      return [{ kind: gamePorchKind(structure), legs }];
    });
  return {
    format: OVERRIDE_FORMAT,
    version: OVERRIDE_VERSION,
    id: String(placement.id),
    footprint: outline,
    // the game's own outline this replaces (recorded at import; a building corrected
    // before keeps the outline that correction replaced), never an earlier correction's
    based_on: placement.basedOn ?? { source: placement.source ?? 'dixon_dem', hash: trace ? outlineHash(trace) : null },
    source: 'building-composer',
    note,
    edited: edited.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    porches,
  };
}

function round(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundPoint([x, z]) {
  return [round(x), round(z)];
}

