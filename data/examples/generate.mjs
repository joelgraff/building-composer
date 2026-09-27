// Generates the example .bld projects in this folder (roof structures) and
// checks that each builds without errors. Run from anywhere:
//   node data/examples/generate.mjs
import { writeFileSync } from 'node:fs';
import { normalizeFootprint } from '../../js/footprint.js';
import { computeFacadeLayout } from '../../js/facade.js';
import { createBuildingFromFootprint, roofHeightFromPitch } from '../../js/extrusion.js';
import { normalizeRoofStructures } from '../../js/roof-structures.js';

const rect = (w, d) => [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];

const defaults = {
  storyCount: 2, storyHeight: 3.2, roofType: 'gable', roofDirection: 'z-min', roofPitchRise: 8, roofPitchRun: 12,
  roofHeightMode: 'slope', roofEaveDepth: 0.35, roofRakeDepth: 0.25, roofFasciaDepth: 0.1524, eaveSoffit: 'flat', rakeSoffit: 'sloped',
  wallMaterial: 'wood',
};
// all structures face +Z (maxZ), toward the app's default camera
const on = (hostVolumeId, fields) => ({ hostVolumeId, hostSide: 'maxZ', ...fields });

const examples = {
  'roof-dormers': {
    note: 'Roof dormers, one of each roof type, standing on the slope (set back from the eave).',
    footprint: rect(18, 9),
    structures: [
      on('volume-0', { kind: 'dormer', offset: -6, roofType: 'gable' }),
      on('volume-0', { kind: 'dormer', offset: -2, roofType: 'hip' }),
      on('volume-0', { kind: 'dormer', offset: 2.2, roofType: 'shed', width: 2.8, roofShape: { mode: 'slope', pitchRise: 3 } }),
      on('volume-0', { kind: 'dormer', offset: 6.2, roofType: 'flat', depth: 2, wallHeight: 1.1 }),
    ],
  },
  'wall-dormers': {
    note: 'Wall dormers: the front wall carries the main wall up through the eave, which stops and is capped either side.',
    footprint: rect(18, 9),
    structures: [
      on('volume-0', { kind: 'wall-dormer', offset: -5.5, roofType: 'gable' }),
      on('volume-0', { kind: 'wall-dormer', offset: 0, roofType: 'hip' }),
      on('volume-0', { kind: 'wall-dormer', offset: 5.5, roofType: 'shed', width: 3, roofShape: { mode: 'slope', pitchRise: 3 } }),
    ],
  },
  'hip-roof-dormers': {
    note: 'Dormers on a hip roof: a gable dormer and a wall dormer on the long slope, and a small dormer in the hip end.',
    footprint: rect(16, 10),
    config: { roofType: 'hip' },
    structures: [
      on('volume-0', { kind: 'dormer', offset: -3, roofType: 'gable' }),
      on('volume-0', { kind: 'wall-dormer', offset: 3, roofType: 'hip' }),
      { hostVolumeId: 'volume-0', hostSide: 'maxX', kind: 'dormer', width: 1.4, setback: 0.8, wallHeight: 0.9, roofType: 'gable' },
    ],
  },
  'attic-dormers': {
    note: 'Key example: a story-and-a-half cottage. A long shed dormer lights the attic on one side, two gable dormers on the other.',
    footprint: rect(12, 9),
    config: { storyCount: 1, roofPitchRise: 12 },
    structures: [
      on('volume-0', { kind: 'wall-dormer', width: 7, roofType: 'shed', wallHeight: 1.6, roofShape: { mode: 'slope', pitchRise: 2 } }),
      { hostVolumeId: 'volume-0', hostSide: 'minZ', kind: 'dormer', offset: -3, width: 2, roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 12 } },
      { hostVolumeId: 'volume-0', hostSide: 'minZ', kind: 'dormer', offset: 3, width: 2, roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 12 } },
    ],
  },
  'recessed-porch': {
    note: 'Recessed porches on a story-and-a-half bungalow, set up the roof above an intact strip of roof and eave: a gable-roofed one on the front and a wider shed-roofed one on the back, each an open porch in front of a set-back wall under a dormer roof.',
    footprint: rect(12, 9),
    config: { storyCount: 1, roofPitchRise: 12 },
    structures: [
      on('volume-0', { kind: 'recessed-porch', width: 3.6, wallHeight: 2, roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 8 } }),
      { hostVolumeId: 'volume-0', hostSide: 'minZ', kind: 'recessed-porch', width: 5.4, setback: 0.9, inset: 1.2, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 } },
    ],
  },
  'second-empire': {
    note: 'A Second Empire house: a mansard roof (steep lower slope to a curb at 3 m, low hip above) with three dormers on the front slope, below the curb.',
    footprint: rect(14, 10),
    config: { roofType: 'mansard', roofBreakHeight: 3 },
    structures: [-4, 0, 4].map((offset) => on('volume-0', {
      kind: 'dormer', offset, width: 1.4, setback: 0.25, wallHeight: 1.3, roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 6 },
    })),
  },
  gambrel: {
    note: 'A story-and-a-half house under a gambrel roof (steep lower slopes to a break at 2.4 m, gable ends), with two small dormers on the front lower slope.',
    footprint: rect(12, 8),
    config: { storyCount: 1, roofType: 'gambrel' },
    structures: [-2.5, 2.5].map((offset) => on('volume-0', {
      kind: 'dormer', offset, width: 1.4, setback: 0.3, wallHeight: 1.1, roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 8 },
    })),
  },
  'widows-walk': {
    note: 'A widow\'s walk: a hip roof cut flat at 1.6 m, with a deck filling the flat top less 0.3 m. Its railing (1 m, the structure\'s wall height) comes with facade elements.',
    footprint: rect(14, 11),
    config: { roofType: 'hip', roofPitchRise: 8, roofEaveDepth: 0.6, roofDeckHeight: 1.6 },
    structures: [
      on('volume-0', { kind: 'widows-walk' }),
    ],
  },
  cupola: {
    note: 'A cupola on the ridge of a two-story gable house: 1.6 m square with a pyramid roof, its walls clearing the ridge by 1.2 m.',
    footprint: rect(16, 9),
    structures: [
      on('volume-0', { kind: 'cupola', roofShape: { mode: 'slope', pitchRise: 12 } }),
    ],
  },
  belvedere: {
    note: 'An Italianate belvedere: a windowed lookout at the center of a low hip roof, with a low hip roof of its own.',
    footprint: rect(12, 12),
    config: { roofType: 'hip', roofPitchRise: 4, roofEaveDepth: 0.6 },
    structures: [
      on('volume-0', { kind: 'cupola', width: 3.2, depth: 3.2, wallHeight: 1.8, roofShape: { mode: 'slope', pitchRise: 4 }, eaves: { eaveDepth: 0.45 } }),
    ],
  },
  'rooftop-pavilion': {
    note: 'An open pavilion on a flat roof: a hip roof on posts standing on the roof deck, set back from the edges.',
    footprint: rect(14, 10),
    config: { roofType: 'flat' },
    structures: [
      on('volume-0', { kind: 'cupola', width: 4, depth: 4, wallHeight: 2.4, roofShape: { mode: 'slope', pitchRise: 6 }, openSides: ['front', 'back', 'left', 'right'] }),
    ],
  },
  'ground-porch': {
    note: 'A ground-level porch on a solid deck, open on three sides with posts, its shed roof butting the wall below the second floor.',
    footprint: rect(16, 9),
    structures: [
      on('volume-0', { kind: 'porch', setback: -2.4, depth: 2.4, width: 9, baseHeight: 'ground', wallHeight: 2.6, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 }, openSides: ['front', 'left', 'right'] }),
    ],
  },
  'sleeping-porch': {
    note: 'Key example: a sleeping porch standing on a flat-roofed ground porch. The ground porch is open with posts; the sleeping porch is enclosed, its shed roof tucked just under the main eave.',
    footprint: rect(16, 9),
    structures: [
      on('volume-0', { id: 'ground-porch', kind: 'porch', setback: -2.4, depth: 2.4, width: 7, baseHeight: 'ground', wallHeight: 3.2, roofType: 'flat', openSides: ['front', 'left', 'right'] }),
      { id: 'sleeping-porch', kind: 'porch', hostStructureId: 'ground-porch', hostSide: 'maxZ', setback: 0, depth: 2.4, width: 7, baseHeight: 0, wallHeight: 2.4, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 1.5 }, openSides: [] },
    ],
  },
  'porch-supports': {
    note: 'Second-floor porches and how they are held up: an open porch on posts, a shallow balcony on brackets, and an enclosed base (a two-story bay).',
    footprint: rect(18, 9),
    structures: [
      on('volume-0', { kind: 'porch', offset: -5.5, setback: -2.4, depth: 2.4, width: 3.6, baseHeight: -3.2, wallHeight: 2.4, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 1.5 }, openSides: ['front', 'left', 'right'], support: 'posts' }),
      on('volume-0', { kind: 'porch', offset: 0, setback: -1.2, depth: 1.2, width: 3, baseHeight: -3.2, wallHeight: 2.4, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 }, openSides: ['front'], support: 'brackets' }),
      on('volume-0', { kind: 'porch', offset: 5.5, setback: -1.8, depth: 1.8, width: 3.6, baseHeight: -3.2, wallHeight: 2.4, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 6 }, openSides: [], support: 'enclosed' }),
    ],
  },
};

let failed = false;
for (const [name, example] of Object.entries(examples)) {
  const cfg = { ...defaults, ...(example.config ?? {}) };
  const norm = normalizeFootprint(example.footprint);
  const layout = computeFacadeLayout(norm, cfg);
  const roofStructures = normalizeRoofStructures(example.structures);
  const roofHeight = roofHeightFromPitch(norm, cfg.roofDirection, cfg.roofPitchRise, 12, layout.volumes);
  const result = createBuildingFromFootprint(norm, {
    ...cfg, roofHeight, volumes: layout.volumes, roofZones: layout.roofZones, foundationDepth: 0.7, roofStructures,
  });
  const issues = result.roofStructures.filter((entry) => entry.errors.length || entry.warnings.length)
    .map((entry) => `${entry.id}: ${[...entry.errors, ...entry.warnings].map((e) => e.code).join(', ')}`);
  console.log(name.padEnd(20), layout.volumes.map((v) => v.id).join(','), issues.length ? issues.join('; ') : 'ok');
  if (result.roofStructures.some((entry) => entry.errors.length)) failed = true;
  const bld = {
    format: 'building-composer',
    version: 1,
    note: example.note,
    footprint: norm,
    ...cfg,
    roofHeight,
    volumeStoryOverrides: cfg.volumeStoryOverrides ?? {},
    roofStructures,
  };
  writeFileSync(new URL(`${name}.bld`, import.meta.url), `${JSON.stringify(bld, null, 2)}\n`);
}
process.exit(failed ? 1 : 0);
