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
