/**
 * The Dixon game's materials, and which one each surface of a building
 * becomes when it is sent to the game.
 *
 * The game owns the vocabulary: its manifest (dixon_dem
 * pipeline/buildings/palette.py manifest()) lists each material's name,
 * label, categories (where it may be used: wall, roof, trim, door,
 * foundation, porch-floor, glass, accent, interior-wall, interior-floor,
 * interior-ceiling), and preview color. Composer uses the live manifest when
 * the game's composer_server.py serves it (GET /game-materials) and its
 * bundled copy (js/game-materials-data.js) otherwise.
 *
 * A building's chosen finishes are game material names:
 * `config.gameFinishes` for the building, `config.volumeGameFinishes[id]`
 * for a volume, and a roof structure's `materials.gameWall` / `gameRoof`,
 * each over the one before. A surface with no finish chosen gets a default
 * from its Composer material. A wall, trim, or roof finish applies only to a
 * surface of its own Composer family (see familyOf), so one left over from
 * before the family was changed is ignored rather than painting brick over
 * siding; door, foundation, and porch-floor finishes apply to every door,
 * foundation, and porch floor.
 */

import BUNDLED from './game-materials-data.js';

/** The finishes a building can choose, with the manifest category each is drawn from. */
export const FINISH_SLOTS = Object.freeze([
  { key: 'wall', category: 'wall', label: 'Walls' },
  { key: 'roof', category: 'roof', label: 'Pitched roof' },
  { key: 'flatRoof', category: 'roof', label: 'Flat roof' },
  { key: 'trim', category: 'trim', label: 'Trim' },
  { key: 'foundation', category: 'foundation', label: 'Foundation' },
  { key: 'door', category: 'door', label: 'Doors' },
  { key: 'porchFloor', category: 'porch-floor', label: 'Porch floor' },
]);

/** Defaults for a surface with no finish chosen, by its Composer material. */
export const GAME_WALLS = Object.freeze({
  brick: 'brick_red', wood: 'siding_white', stucco: 'siding_butter', metal: 'roof_metal', stone: 'limestone', paint: 'siding_white', black: 'trim_dark',
});
export const GAME_ROOFS = Object.freeze({ metal: 'roof_metal', wood: 'shingles_brown' });
export const GAME_DOORS = Object.freeze({
  brick: 'brick_red', wood: 'door_wood', stucco: 'siding_butter', metal: 'roof_metal', stone: 'limestone',
});
export const GAME_TRIM = Object.freeze({ paint: 'trim_white', wood: 'trim_white', black: 'trim_dark' });
export const GAME_INTERIOR = Object.freeze({
  'interior-wall': 'plaster_white', 'interior-floor': 'floor_wood', 'interior-ceiling': 'plaster_ceiling',
});
/** Exterior glass: lit at night, per pane (see js/game-export.js). */
export const GLASS = 'window_lit';
const TRIM = 'trim_white';
const SHINGLES = 'shingles_dark';
const MEMBRANE = 'roof_membrane';
const FOUNDATION = 'stone_foundation';
const PORCH_FLOOR = 'trim_dark';
export const FLAT = 0.98;
/** A roof face whose outward normal points up less than this is trim (fascia, rake, soffit), not roof. */
export const STEEP = 0.1;

let active = null;
let byName = new Map();

/** Makes `manifest` the one in use, if it is one; returns whether it was. */
export function setGameManifest(manifest) {
  if (manifest?.format !== 'dixon-materials' || !Array.isArray(manifest.materials)) {
    return false;
  }
  const entries = manifest.materials.filter((m) => typeof m?.name === 'string' && Array.isArray(m.categories));
  active = { ...manifest, materials: entries };
  byName = new Map(entries.map((m) => [m.name, m]));
  return true;
}
setGameManifest(BUNDLED);

/** The manifest in use. */
export function gameManifest() {
  return active;
}

/**
 * Uses the game's live manifest when this page is served by its
 * composer_server.py, and keeps the bundled copy otherwise.
 * @returns {Promise<'game'|'bundled'>} which one is in use
 */
export async function loadGameManifest(fetchImpl = globalThis.fetch) {
  try {
    const reply = await fetchImpl('/game-materials', { cache: 'no-cache' });
    if (reply.ok && setGameManifest(await reply.json())) {
      return 'game';
    }
  } catch {
    // not served by the game: the bundled copy stays
  }
  setGameManifest(BUNDLED);
  return 'bundled';
}

export const isGameMaterial = (name) => byName.has(name);
export const colorOf = (name) => byName.get(name)?.color ?? null;
export const labelOf = (name) => byName.get(name)?.label ?? name;
export const categoriesOf = (name) => byName.get(name)?.categories ?? [];

/** The game materials usable for a category (a FINISH_SLOTS category), in manifest order. */
export function finishesFor(category) {
  return active.materials.filter((m) => m.categories.includes(category));
}

/**
 * The game materials offered for a finish slot (a FINISH_SLOTS key): its
 * category's, and for a roof only those that suit it. A pitched roof is
 * shingles or metal, not membrane; a flat roof is membrane or metal, not
 * shingles.
 */
export function finishesForSlot(key) {
  const slot = FINISH_SLOTS.find((entry) => entry.key === key);
  const names = finishesFor(slot?.category ?? key);
  if (key === 'roof') {
    return names.filter((m) => !FLAT_ROOF_ONLY.test(m.name));
  }
  if (key === 'flatRoof') {
    return names.filter((m) => !PITCHED_ROOF_ONLY.test(m.name));
  }
  return names;
}
const FLAT_ROOF_ONLY = /membrane/;
const PITCHED_ROOF_ONLY = /^shingles_/;

/** The names in `names` the game doesn't have. */
export function unknownMaterials(names) {
  return [...new Set(names)].filter((name) => !byName.has(name)).sort();
}

/**
 * The Composer material family a game material looks like (a key of
 * MATERIAL_PALETTE in js/materials.js), or null for one with no family
 * (membrane roofing, glass, awnings), which fits any surface.
 */
export function familyOf(name) {
  if (/^brick_/.test(name)) {
    return 'brick';
  }
  if (/^(siding_|shingles_)|_wood$/.test(name)) {
    return 'wood';
  }
  if (/^(limestone|stone_)/.test(name)) {
    return 'stone';
  }
  if (/^(roof_metal|steel_)/.test(name)) {
    return 'metal';
  }
  if (/^plaster_/.test(name)) {
    return 'stucco';
  }
  return { trim_dark: 'black', trim_white: 'paint' }[name] ?? null;
}

const FINISH_KEYS = FINISH_SLOTS.map((slot) => slot.key);

const defined = (object) => Object.fromEntries(Object.entries(object ?? {})
  .filter(([key, value]) => FINISH_KEYS.includes(key) && typeof value === 'string' && value));

/**
 * The finishes chosen for a surface: the building's, then its volume's, then
 * its roof structure's (a structure's `gameRoof` covers its flat roof too).
 */
export function resolveGameFinishes(config = {}, { volumeId, structureId } = {}) {
  const structure = structureId ? (config.roofStructures ?? []).find((s) => s.id === structureId) : null;
  const own = structure ? defined({
    wall: structure.materials?.gameWall, roof: structure.materials?.gameRoof, flatRoof: structure.materials?.gameRoof,
  }) : {};
  return {
    ...defined(config.gameFinishes),
    ...defined(volumeId ? config.volumeGameFinishes?.[volumeId] : null),
    ...own,
  };
}

/**
 * The game material for a surface: its Composer material's role (wall,
 * foundation, roof, trim, door, glass, interior-*) and palette entry, the
 * part of a structure it is (a porch `floor`), the finishes chosen for it
 * (resolveGameFinishes), and the way it faces (a roof laid flat is a flat
 * roof; the underside and edges of a roof are its trim).
 */
export function gameMaterialFor({ role, palette, part, finishes = {} }, normal) {
  const chosen = (key, category, { sameFamily = false } = {}) => {
    const name = finishes[key];
    if (!name || !categoriesOf(name).includes(category)) {
      return null;
    }
    const family = familyOf(name);
    return !sameFamily || !palette || !family || family === palette ? name : null;
  };
  if (part === 'floor') {
    return chosen('porchFloor', 'porch-floor') ?? PORCH_FLOOR;
  }
  if (part === 'soffit') {
    return chosen('trim', 'trim') ?? TRIM;
  }
  if (role === 'foundation') {
    return chosen('foundation', 'foundation') ?? FOUNDATION;
  }
  if (role === 'roof') {
    // trim faces sideways or down (fascia, rakes, soffits); anything facing up,
    // however steep (a mansard's lower slope, a tower's spire), is roof
    if (normal[1] < STEEP) {
      return chosen('trim', 'trim') ?? TRIM;
    }
    if (normal[1] > FLAT) {
      return chosen('flatRoof', 'roof', { sameFamily: true }) ?? (palette === 'metal' ? GAME_ROOFS.metal : MEMBRANE);
    }
    return chosen('roof', 'roof', { sameFamily: true }) ?? GAME_ROOFS[palette] ?? SHINGLES;
  }
  if (role === 'glass') {
    return GLASS;
  }
  if (GAME_INTERIOR[role]) {
    return GAME_INTERIOR[role];
  }
  if (role === 'door') {
    return chosen('door', 'door') ?? GAME_DOORS[palette] ?? GAME_DOORS.wood;
  }
  if (role === 'trim') {
    return chosen('trim', 'trim', { sameFamily: true }) ?? GAME_TRIM[palette] ?? GAME_WALLS[palette] ?? TRIM;
  }
  return chosen('wall', 'wall', { sameFamily: true }) ?? GAME_WALLS[palette] ?? GAME_WALLS.wood;
}

/** What a mesh belongs to, from it or the nearest thing above it that says. */
function ownerOf(mesh, root) {
  let volumeId;
  let structureId;
  for (let node = mesh; node; node = node.parent) {
    volumeId ??= node.userData?.volumeId ?? node.userData?.hostVolumeId;
    structureId ??= node.userData?.structureId;
    if (node === root) {
      break;
    }
  }
  return { volumeId, structureId };
}

// the way a surface of each kind mostly faces, to pick its preview color
const TYPICAL_NORMAL = { roof: [0, 0.8, 0.6], flat: [0, 1, 0] };

/**
 * Records on each mesh of a built model the finishes chosen for it
 * (`userData.gameFinishes`, which the game export reads), and shows each
 * surface with a chosen finish in that finish's color, so the model looks as
 * it will in the game. Surfaces with none keep Composer's look.
 */
export function applyGameFinishes(root, config = {}) {
  const recolored = new Map();
  root.traverse((mesh) => {
    const material = mesh.material;
    if (!mesh.isMesh || !material?.userData?.role) {
      return;
    }
    const finishes = resolveGameFinishes(config, ownerOf(mesh, root));
    if (Object.keys(finishes).length === 0) {
      return;
    }
    mesh.userData.gameFinishes = finishes;
    const { role, palette } = material.userData;
    const flat = mesh.userData?.roofType === 'flat' || mesh.userData?.structurePart === 'floor';
    const normal = role === 'roof' ? TYPICAL_NORMAL[flat ? 'flat' : 'roof'] : [1, 0, 0];
    const surface = { role, palette, part: mesh.userData?.structurePart };
    const name = gameMaterialFor({ ...surface, finishes }, normal);
    if (name === gameMaterialFor(surface, normal) && !Object.values(finishes).includes(name)) {
      return;
    }
    const color = colorOf(name);
    if (!color || role === 'glass') {
      return;
    }
    const key = `${material.uuid}|${name}`;
    if (!recolored.has(key)) {
      const copy = material.clone();
      copy.userData = { ...material.userData, gameMaterial: name };
      copy.color?.set?.(color);
      recolored.set(key, copy);
    }
    mesh.material = recolored.get(key);
  });
  return root;
}
