/**
 * Roof structure presets and labels for the editor. Pure functions with no
 * DOM or THREE dependency; the sidebar in js/main.js builds on them.
 */

import { createRoofStructure, structureFrame, structureWallSides } from './roof-structures.js';

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
  {
    key: 'wraparound-porch',
    label: 'Wraparound porch',
    fields: {
      kind: 'porch', setback: -2.4, depth: 2.4, width: 6, baseHeight: 'ground', wallHeight: 2.8,
      roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'],
      wrap: { end: 'right', length: 4 },
    },
  },
  {
    key: 'integral-porch',
    label: 'Integral porch (recessed under the roof)',
    fields: {
      kind: 'porch', mount: 'recess', setback: 0, depth: 2.4, width: 3.6, baseHeight: 'ground', wallHeight: 2.4,
      roofType: 'flat', openSides: ['front'],
    },
  },
  { key: 'entry-hood', label: 'Entry hood (a roof on brackets over a door)', fields: { kind: 'hood' } },
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
  {
    key: 'canted-bay',
    label: 'Canted bay window',
    fields: {
      kind: 'porch', setback: -0.9, depth: 0.9, width: 2.8, baseHeight: 'ground', wallHeight: 2.8,
      roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: [], plan: { shape: 'canted', angle: 45 },
    },
  },
  {
    key: 'corner-tower',
    label: 'Corner tower (octagonal, or round with more sides)',
    corner: true,
    fields: {
      kind: 'porch', setback: -1.7, depth: 3.4, width: 3.4, baseHeight: 'ground',
      roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 18 }, openSides: [], plan: { shape: 'polygon', sides: 8 },
    },
  },
  {
    key: 'corbelled-turret',
    label: 'Corbelled turret (from an upper story)',
    corner: true,
    turret: true,
    fields: {
      kind: 'porch', setback: -1.2, depth: 2.4, width: 2.4, support: 'brackets',
      roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 24 }, openSides: [], plan: { shape: 'polygon', sides: 12 },
    },
  },
  { key: 'cupola', label: 'Cupola', fields: { kind: 'cupola' } },
]);

/**
 * A new structure from a UI preset, with an id unused by `existing`.
 *
 * @param {string} presetKey - a STRUCTURE_UI_PRESETS key
 * @param {{ hostVolumeId?: string, hostStructure?: object, hostSide: string, storyHeight?: number, wallLength?: number, wallTop?: number }} placement
 *   (`wallTop`: the host's wall height, which a corner tower rises past)
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
  if (preset.corner) {
    // centered on the right-hand corner, rising a story above the plate
    fields.offset = Number.isFinite(placement.wallLength) ? placement.wallLength / 2 : 0;
    fields.wallHeight = (placement.wallTop ?? 2 * (placement.storyHeight ?? 3.2)) + (placement.storyHeight ?? 3.2) * 0.6;
  }
  if (preset.turret) {
    // from the top story's floor, on its corbel, up past the eave
    const storyHeight = placement.storyHeight ?? 3.2;
    fields.baseHeight = -storyHeight;
    fields.wallHeight = storyHeight * 1.6;
  }
  if (presetKey === 'wraparound-porch' && Number.isFinite(placement.wallLength)) {
    // along the whole wall, so its right end is at the corner
    fields.width = placement.wallLength;
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
  hood: 'Entry hood',
};

/**
 * The walls of a volume named from the building's front (`front`, a side
 * such as 'maxZ'): the front, the back, and the left and right sides as seen
 * standing in front of it, facing the front wall.
 */
export function wallNames(front = 'maxZ') {
  const walls = structureWallSides(structureFrame(front));
  return {
    [walls.front]: 'front', [walls.back]: 'back', [walls.left]: 'left side', [walls.right]: 'right side',
  };
}

export function structureLabel(structure, front = 'maxZ') {
  const polygon = structure.baseHeight === 'ground' || structure.baseHeight === undefined ? 'Tower' : 'Turret';
  const plan = { canted: 'Canted bay', polygon }[structure.plan?.shape];
  const roof = plan ?? (['dormer', 'wall-dormer'].includes(structure.kind) && structure.roofType !== 'gable'
    ? `${structure.roofType[0].toUpperCase()}${structure.roofType.slice(1)} ${KIND_LABELS[structure.kind].toLowerCase()}`
    : KIND_LABELS[structure.kind] ?? structure.kind);
  const host = structure.hostStructureId
    ? `on ${structure.hostStructureId}`
    : `${(structure.hostVolumeId ?? '').replace('-', ' ')}, ${wallNames(front)[structure.hostSide] ?? structure.hostSide}`;
  return `${roof} · ${host}`;
}
