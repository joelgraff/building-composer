/**
 * Roof structure presets and labels for the editor. Pure functions with no
 * DOM or THREE dependency; the sidebar in js/main.js builds on them.
 */

import { createRoofStructure } from './roof-structures.js';

/**
 * What the "Add" menu offers: a starting record for each common case, from
 * the structure kinds' presets (see STRUCTURE_PRESETS) plus the fields that
 * make it that case. `onStructure` presets stand on the selected structure
 * rather than a volume. Lengths in meters.
 */
export const STRUCTURE_UI_PRESETS = Object.freeze([
  { key: 'gable-dormer', label: 'Gable dormer', fields: { kind: 'dormer', roofType: 'gable' } },
  { key: 'shed-dormer', label: 'Shed dormer', fields: { kind: 'dormer', roofType: 'shed', width: 3, roofShape: { mode: 'slope', pitchRise: 3 } } },
  { key: 'hip-dormer', label: 'Hip dormer', fields: { kind: 'dormer', roofType: 'hip' } },
  { key: 'wall-dormer', label: 'Wall dormer', fields: { kind: 'wall-dormer' } },
  { key: 'recessed-porch', label: 'Recessed porch', fields: { kind: 'recessed-porch' } },
  {
    key: 'ground-porch',
    label: 'Ground porch',
    fields: {
      kind: 'porch', setback: -2.4, depth: 2.4, width: 4.8, baseHeight: 'ground', wallHeight: 2.6,
      roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 }, openSides: ['front', 'left', 'right'],
    },
  },
  {
    key: 'upper-porch',
    label: 'Upper porch on posts',
    fields: {
      kind: 'porch', setback: -2.4, depth: 2.4, width: 3.6, wallHeight: 2.4,
      roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 2 }, openSides: ['front', 'left', 'right'], support: 'posts',
    },
  },
  { key: 'porch-on-roof', label: 'Porch on this roof', fields: { kind: 'porch' } },
  {
    key: 'sleeping-porch',
    label: 'Sleeping porch on the selected porch',
    onStructure: true,
    fields: {
      kind: 'porch', setback: 0, baseHeight: 0, wallHeight: 2.4,
      roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 1.5 }, openSides: [],
    },
  },
  { key: 'cupola', label: 'Cupola', fields: { kind: 'cupola' } },
]);

/**
 * A new structure from a UI preset, with an id unused by `existing`.
 *
 * @param {string} presetKey - a STRUCTURE_UI_PRESETS key
 * @param {{ hostVolumeId?: string, hostStructure?: object, hostSide: string, storyHeight?: number }} placement
 *   The volume (or, for an `onStructure` preset, the structure record) to
 *   stand on, and the side it faces. An upper porch's floor goes one story
 *   below the host plate.
 * @param {Array<object>} existing - the building's structures
 * @returns {object|null} the normalized record, or null for an unknown preset
 *   or an `onStructure` preset with no structure to stand on
 */
export function newRoofStructure(presetKey, placement, existing = []) {
  const preset = STRUCTURE_UI_PRESETS.find((candidate) => candidate.key === presetKey);
  if (!preset) {
    return null;
  }
  const fields = { ...preset.fields };
  if (presetKey === 'upper-porch') {
    fields.baseHeight = -(placement.storyHeight ?? 3.2);
  }
  if (preset.onStructure) {
    const host = placement.hostStructure;
    if (!host) {
      return null;
    }
    // over the whole of the porch it stands on, facing the same way
    Object.assign(fields, {
      hostStructureId: host.id,
      hostSide: host.hostSide,
      width: host.width,
      depth: Number.isFinite(host.depth) ? host.depth : 2.4,
    });
    return createRoofStructure(fields.kind, fields, existing);
  }
  return createRoofStructure(fields.kind, {
    ...fields, hostVolumeId: placement.hostVolumeId, hostSide: placement.hostSide,
  }, existing);
}

const KIND_LABELS = {
  dormer: 'Dormer',
  'wall-dormer': 'Wall dormer',
  'recessed-porch': 'Recessed porch',
  porch: 'Porch',
  cupola: 'Cupola',
};

const SIDE_LABELS = {
  minX: 'X-min side', maxX: 'X-max side', minZ: 'Z-min side', maxZ: 'Z-max side',
};

/** A short label for a structure record: what it is, and where. */
export function structureLabel(structure) {
  const roof = ['dormer', 'wall-dormer'].includes(structure.kind) && structure.roofType !== 'gable'
    ? `${structure.roofType[0].toUpperCase()}${structure.roofType.slice(1)} ${KIND_LABELS[structure.kind].toLowerCase()}`
    : KIND_LABELS[structure.kind] ?? structure.kind;
  const host = structure.hostStructureId
    ? `on ${structure.hostStructureId}`
    : `${(structure.hostVolumeId ?? '').replace('-', ' ')}, ${SIDE_LABELS[structure.hostSide] ?? structure.hostSide}`;
  return `${roof} · ${host}`;
}
