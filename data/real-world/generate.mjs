// Real-world evaluation models: house types common in Dixon, Illinois and the
// Midwest, at typical (not measured) sizes. Generates a .bld per house and
// reports what each building needed that the model lacks. Run from anywhere:
//   node data/real-world/generate.mjs
// Lengths in meters (1 ft = 0.3048 m). Every house faces +Z (maxZ), toward
// the app's default camera.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { normalizeFootprint } from '../../js/footprint.js';
import { computeFacadeLayout } from '../../js/facade.js';
import { createBuildingFromFootprint, roofHeightFromPitch, setStraightSkeletonBuilder } from '../../js/extrusion.js';
import { normalizeRoofStructures } from '../../js/roof-structures.js';

globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
const { SkeletonBuilder } = createRequire(import.meta.url)('../../node_modules/straight-skeleton/dist/index.js');
await SkeletonBuilder.init();
setStraightSkeletonBuilder(SkeletonBuilder);

const ft = (feet) => Math.round(feet * 0.3048 * 100) / 100;
const box = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

const defaults = {
  storyCount: 2, storyHeight: 2.9, roofType: 'gable', roofDirection: 'z-min', roofPitchRise: 8, roofPitchRun: 12,
  roofHeightMode: 'slope', roofEaveDepth: 0.35, roofRakeDepth: 0.25, roofFasciaDepth: 0.1524, eaveSoffit: 'flat', rakeSoffit: 'sloped',
  wallMaterial: 'wood', volumeSplit: 'auto', foundationDepth: 0.7,
};

/**
 * Each house: its footprint, building settings, per-volume settings keyed by
 * a point inside the volume (`at: [x, z]`, since volume ids come from the
 * footprint's decomposition), and structures on a volume found the same way.
 * `gaps` records what the real building has that could not be modeled.
 */
const houses = {
  italianate: {
    title: 'Italianate (courthouse-square type)',
    note: 'A two-story brick Italianate of the 1850s-60s, like the Van Epps and Brookner houses: a near-square block with tall 12 ft stories, a low hip roof on deep bracketed eaves, a belvedere, a flat-roofed entry porch, a side bay, and a one-story rear kitchen wing.',
    // the main block, with the kitchen wing behind its left half
    footprint: [[-5.5, -11.1], [1.5, -11.1], [1.5, -6.1], [5.5, -6.1], [5.5, 6.1], [-5.5, 6.1]],
    config: {
      storyHeight: ft(12), roofType: 'hip', roofPitchRise: 4, roofEaveDepth: 0.75, roofRakeDepth: 0.75, wallMaterial: 'brick',
    },
    volumes: [
      { at: [-2, -8], storyCount: 1, storyHeight: ft(8.5), roofType: 'shed', ridge: 'z-max' },
    ],
    structures: [
      { at: [0, 0], kind: 'cupola', width: 2.4, depth: 2.4, wallHeight: 1.5, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 } },
      {
        at: [0, 0], kind: 'porch', hostSide: 'maxZ', width: 3.6, setback: -2.4, depth: 2.4, baseHeight: 'ground', wallHeight: 3.3,
        roofType: 'flat', openSides: ['front', 'left', 'right'],
      },
      {
        // the canted (octagonal) side bay
        at: [0, 0], kind: 'porch', hostSide: 'maxX', offset: 1.5, width: 2.8, setback: -0.9, depth: 0.9, baseHeight: 'ground', wallHeight: 3.4,
        roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: [], plan: { shape: 'canted', angle: 45 },
      },
    ],
    gaps: [
      'The entry porch\'s flat roof usually carries a balustrade: a railing on a roof edge, not yet a facade element.',
      'Paired brackets, tall arched windows, and hood molds are facade modifiers (not built yet).',
    ],
  },
  'upright-and-wing': {
    title: 'Upright-and-wing (gable-front-and-wing)',
    note: 'The most common Midwestern farmhouse and town house of 1860-1900: a two-story gable-front "upright" with a lower one-and-a-half-story side wing, and a porch in the ell along the wing.',
    footprint: [[-6.4, -4.6], [6.4, -4.6], [6.4, 2.4], [-0.9, 2.4], [-0.9, 4.6], [-6.4, 4.6]],
    config: { roofPitchRise: 10 },
    volumes: [
      { at: [-3.6, 0], ridge: 'x-min' },
      { at: [3, 0], storyCount: 1, kneeWall: 0.9, ridge: 'z-min' },
    ],
    structures: [
      {
        at: [3, 0], kind: 'porch', hostSide: 'maxZ', width: 7.3, setback: -2.2, depth: 2.2, baseHeight: 'ground', wallHeight: 2.6,
        roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 }, openSides: ['front', 'left', 'right'],
      },
      { at: [3, 0], kind: 'dormer', hostSide: 'maxZ', width: 1.4, wallHeight: 1.1, setback: 0.4, roofType: 'gable', offset: 1.5 },
    ],
    gaps: [],
  },
  'queen-anne': {
    title: 'Gable-front Queen Anne (Reagan Boyhood Home type)',
    note: 'A two-story frame Queen Anne of the 1890s like the Reagan Boyhood Home (1891): a steep gable-front main block, a two-story cross-gabled side projection, and a front porch wrapping one corner.',
    footprint: [[-3.65, -6.1], [3.65, -6.1], [3.65, -1], [6.1, -1], [6.1, 3], [3.65, 3], [3.65, 6.1], [-3.65, 6.1]],
    config: { roofPitchRise: 10 },
    volumes: [
      { at: [0, 0], ridge: 'x-min' },
      { at: [5, 1], ridge: 'z-min', connection: 'merge-plane' },
    ],
    structures: [
      {
        // from the tower to the right-hand corner, and around it back along the side to the projection
        at: [0, 0], kind: 'porch', hostSide: 'maxZ', width: 5.6, offset: 0.85, setback: -2.4, depth: 2.4, baseHeight: 'ground', wallHeight: 2.8,
        roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'],
        wrap: { end: 'right', length: 3.1 },
      },
      {
        // an octagonal tower on the front left corner, rising a story past the eave to a steep pyramid
        at: [0, 0], kind: 'porch', hostSide: 'maxZ', offset: -3.65, width: 3.4, setback: -1.7, depth: 3.4, baseHeight: 'ground', wallHeight: 7.6,
        roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 20 }, openSides: [], plan: { shape: 'polygon', sides: 8 },
      },
    ],
    gaps: [
      'Gable-end detailing (fish-scale shingles, spindlework, bargeboards) is facade work.',
    ],
  },
  foursquare: {
    title: 'American Foursquare',
    note: 'The standard Midwestern house of 1900-1930: a two-and-a-half-story square box, a hip roof with hipped dormers, and a full-width front porch on columns.',
    footprint: box(-4.25, -4.25, 4.25, 4.25),
    config: { storyHeight: 2.9, roofType: 'hip', roofPitchRise: 9, roofEaveDepth: 0.6, roofRakeDepth: 0.6 },
    structures: [
      { at: [0, 0], kind: 'dormer', hostSide: 'maxZ', width: 2.2, wallHeight: 1, setback: 1, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 6 } },
      { at: [0, 0], kind: 'dormer', hostSide: 'minX', width: 2, wallHeight: 1, setback: 1, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 6 } },
      {
        at: [0, 0], kind: 'porch', hostSide: 'maxZ', width: 8.5, setback: -2.4, depth: 2.4, baseHeight: 'ground', wallHeight: 2.7,
        roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 3 }, openSides: ['front', 'left', 'right'],
      },
    ],
    refused: [
      { label: 'hip dormer 2.4 m wide, 1.1 m walls, under a 6:12 roof', config: { roofPitchRise: 6 }, structure: { at: [0, 0], kind: 'dormer', width: 2.4, wallHeight: 1.1, setback: 1.2, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 6 } } },
    ],
    gaps: [
      'Porch columns on brick piers with a solid half wall between are facade/railing work; posts are plain boxes.',
    ],
  },
  bungalow: {
    title: 'Craftsman bungalow',
    note: 'A story-and-a-half side-gabled bungalow of the 1910s-20s: a broad low roof on deep eaves, a wide shed dormer, and an integral porch recessed into the corner under the main roof.',
    footprint: box(-6.1, -4.9, 6.1, 4.9),
    config: {
      storyCount: 1, storyHeight: 2.9, kneeWallHeight: 0.9, roofPitchRise: 8, roofEaveDepth: 0.75, roofRakeDepth: 0.6,
    },
    structures: [
      {
        at: [0, 0], kind: 'dormer', hostSide: 'maxZ', width: 5, wallHeight: 1.3, setback: 1.5, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 2 },
      },
      {
        // an integral porch at the right-hand corner, under the main roof
        at: [0, 0], kind: 'porch', mount: 'recess', hostSide: 'maxZ', offset: 3.6, width: 5, setback: 0, depth: 2.7, baseHeight: 'ground', wallHeight: 2.4,
        roofType: 'flat', openSides: ['front', 'right'],
      },
    ],
    gaps: [
      'Exposed rafter tails, knee braces, and tapered piers are facade work.',
    ],
  },
  'dutch-colonial': {
    title: 'Dutch Colonial Revival',
    note: 'A 1910s-30s Dutch Colonial: a side-gabled gambrel whose steep lower slopes hold the second floor, a long shed dormer across the front, and a gabled entry hood.',
    footprint: box(-4.55, -3.95, 4.55, 3.95),
    config: {
      storyCount: 1, storyHeight: 2.9, roofType: 'gambrel', roofBreakHeight: 2.6, roofLowerPitchRise: 24, roofUpperPitchRise: 6,
    },
    structures: [
      {
        // the full shed dormer: up the lower slope and on to meet the upper slope near the ridge
        at: [0, 0], kind: 'dormer', hostSide: 'maxZ', width: 7, wallHeight: 1.7, setback: 0.4, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 2 },
      },
      {
        // an entry hood on brackets, kept below the eave
        at: [0, 0], kind: 'hood', hostSide: 'maxZ', width: 2.2, setback: -0.9, depth: 0.9, wallHeight: 2.3,
        roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 5 },
      },
    ],
    gaps: [
    ],
  },
  farmhouse: {
    title: 'I-house farmhouse with rear ell',
    note: 'A two-story, one-room-deep I-house (common across northern Illinois from the 1850s) with a two-story rear ell, a full-width front porch, and a side porch along the ell.',
    footprint: [[-5.5, -6], [-0.5, -6], [-0.5, 0], [5.5, 0], [5.5, 5.5], [-5.5, 5.5]],
    config: { roofPitchRise: 10 },
    volumes: [
      { at: [0, 3], ridge: 'z-min' },
      { at: [-3, -3], ridge: 'x-min' },
    ],
    structures: [
      {
        at: [0, 3], kind: 'porch', hostSide: 'maxZ', width: 11, setback: -2.4, depth: 2.4, baseHeight: 'ground', wallHeight: 2.6,
        roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 }, openSides: ['front', 'left', 'right'],
      },
      {
        at: [-3, -3], kind: 'porch', hostSide: 'maxX', width: 6, setback: -2.4, depth: 2.4, baseHeight: 'ground', wallHeight: 2.6,
        roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 }, openSides: ['front', 'left', 'right'],
      },
    ],
    gaps: [],
  },
  'cape-cod': {
    title: 'Cape Cod (1940s)',
    note: 'A 1940s story-and-a-half Cape Cod: a steep side-gabled roof with two gabled dormers and a small gabled entry.',
    footprint: box(-4.9, -3.65, 4.9, 3.65),
    config: {
      storyCount: 1, storyHeight: 2.6, kneeWallHeight: 0.6, roofPitchRise: 12, roofEaveDepth: 0.2, roofRakeDepth: 0.1,
    },
    structures: [-2.4, 2.4].map((offset) => ({
      at: [0, 0], kind: 'dormer', hostSide: 'maxZ', offset, width: 1.5, wallHeight: 1.3, setback: 1, roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 12 },
    })).concat([{
      // kept below the eave, as builders do
      at: [0, 0], kind: 'porch', hostSide: 'maxZ', width: 2, setback: -1.2, depth: 1.2, baseHeight: 'ground', wallHeight: 2.1,
      roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 8 }, openSides: ['front', 'left', 'right'],
    }]),
    gaps: [
      'The entry is often an enclosed vestibule or just a hood; here it is an open stoop.',
      'Dormer spacing is set by window bays; placing dormers by the facade layout is not linked yet.',
    ],
  },
  ranch: {
    title: 'L-shaped ranch (1950s)',
    note: 'A 1950s one-story ranch: a long low hip roof over an L with a front-facing garage wing, and an entry recessed under the roof in the ell.',
    footprint: [[-9, 0], [9, 0], [9, 15], [3, 15], [3, 8.5], [-9, 8.5]],
    config: {
      storyCount: 1, storyHeight: 2.7, roofType: 'hip', roofPitchRise: 4, roofEaveDepth: 0.6, roofRakeDepth: 0.6,
    },
    volumes: [
      // the garage on a slab at grade, its walls taller so its plate stays level with the house
      { at: [5, 12], foundation: 0, storyHeight: 2.7 + 0.7 },
    ],
    structures: [
      {
        // a recessed entry in the ell, beside the garage wing, under the main roof
        at: [-3, 4], kind: 'porch', mount: 'recess', hostSide: 'maxZ', offset: 1.5, width: 3, setback: 0, depth: 1.8, baseHeight: 'ground', wallHeight: 2.4,
        roofType: 'flat', openSides: ['front'],
      },
    ],
    gaps: [
    ],
  },
};

const summary = {};
let failed = false;
for (const [name, house] of Object.entries(houses)) {
  const cfg = { ...defaults, ...house.config };
  const norm = normalizeFootprint(house.footprint);
  const layout = computeFacadeLayout(norm, cfg);
  // normalizing centers the footprint: shift the authored points the same way
  const shift = [0, 1].map((k) => Math.min(...norm.map((p) => p[k])) - Math.min(...house.footprint.map((p) => p[k])));
  const volumeAt = ([ax, az]) => layout.volumes.find((v) => {
    const [x, z] = [ax + shift[0], az + shift[1]];
    return x > v.minX && x < v.maxX && z > v.minZ && z < v.maxZ;
  })?.id;
  const volumeStoryOverrides = {};
  const volumeRidgeDirections = {};
  const volumeRoofTypes = {};
  const volumeRoofConnections = {};
  const volumeKneeWalls = {};
  const volumeStoryHeights = {};
  const volumeFoundationHeights = {};
  (house.volumes ?? []).forEach(({
    at, storyCount, storyHeight, foundation, kneeWall, roofType, ridge, connection,
  }) => {
    const id = volumeAt(at);
    if (!id) {
      throw new Error(`${name}: no volume at ${at}`);
    }
    if (storyCount) volumeStoryOverrides[id] = storyCount;
    if (roofType) volumeRoofTypes[id] = roofType;
    if (ridge) volumeRidgeDirections[id] = ridge;
    if (connection) volumeRoofConnections[id] = connection;
    if (kneeWall !== undefined) volumeKneeWalls[id] = kneeWall;
    if (storyHeight !== undefined) volumeStoryHeights[id] = storyHeight;
    if (foundation !== undefined) volumeFoundationHeights[id] = foundation;
  });
  const roofStructures = normalizeRoofStructures((house.structures ?? []).map(({ at, ...fields }) => ({
    hostSide: 'maxZ', ...fields, hostVolumeId: volumeAt(at),
  })));
  const roofHeight = roofHeightFromPitch(norm, cfg.roofDirection, cfg.roofPitchRise, 12, layout.volumes);
  const full = {
    ...cfg, roofHeight, volumeStoryOverrides, volumeRidgeDirections, volumeRoofTypes, volumeRoofConnections, volumeKneeWalls, volumeStoryHeights, volumeFoundationHeights,
  };
  const result = createBuildingFromFootprint(norm, {
    ...full, volumes: layout.volumes, roofZones: layout.roofZones, foundationDepth: 0.7, roofStructures,
  });
  const issues = result.roofStructures.filter((entry) => entry.errors.length || entry.warnings.length)
    .map((entry) => ({ id: entry.id, errors: entry.errors, warnings: entry.warnings }));
  if (result.roofStructures.some((entry) => entry.errors.length)) failed = true;
  // what the real building has, tried on its own, and refused
  const refused = (house.refused ?? []).map(({ label, config: override = {}, structure: { at, ...fields } }) => {
    const tried = { ...full, ...override };
    tried.roofHeight = roofHeightFromPitch(norm, tried.roofDirection, tried.roofPitchRise, 12, layout.volumes);
    const [entry] = createBuildingFromFootprint(norm, {
      ...tried, volumes: layout.volumes, roofZones: layout.roofZones, foundationDepth: 0.7,
      roofStructures: normalizeRoofStructures([{ hostSide: 'maxZ', ...fields, hostVolumeId: volumeAt(at) }]),
    }).roofStructures;
    return { label, errors: entry.errors.map((e) => e.message), warnings: entry.warnings.map((e) => e.message) };
  });
  refused.forEach(({ label, errors }) => console.log('   refused:', label, '->', errors.join(' ') || 'NOW BUILDS'));
  console.log(name.padEnd(18), layout.volumes.map((v) => `${v.id}[${v.minX},${v.maxX}]x[${v.minZ},${v.maxZ}]`).join(' '),
    issues.length ? JSON.stringify(issues.map((i) => `${i.id}: ${[...i.errors, ...i.warnings].map((e) => e.message).join(' ')}`)) : 'ok');
  summary[name] = {
    title: house.title, note: house.note, front: house.front ?? 'maxZ', gaps: house.gaps, issues, refused, zones: result.roofZones.length, volumes: layout.volumes.length,
  };
  writeFileSync(new URL(`${name}.bld`, import.meta.url), `${JSON.stringify({
    format: 'building-composer',
    version: 1,
    note: house.note,
    footprint: norm,
    ...full,
    roofStructures,
  }, null, 2)}\n`);
}
writeFileSync(new URL('summary.json', import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
process.exit(failed ? 1 : 0);
