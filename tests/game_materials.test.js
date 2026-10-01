import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';
import { buildGameFile, gameFileProblems, paneLight } from '../js/game-export.js';
import {
  GAME_WALLS, GAME_ROOFS, GAME_DOORS, GAME_TRIM, GAME_INTERIOR, GLASS,
  colorOf, familyOf, finishesFor, gameManifest, gameMaterialFor, isGameMaterial, loadGameManifest, resolveGameFinishes, setGameManifest, finishesForSlot} from '../js/game-materials.js';
import BUNDLED from '../js/game-materials-data.js';

const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const ELL = [[-6, -4], [6, -4], [6, 0], [0, 0], [0, 4], [-6, 4]];

function build(footprint, config = {}, structures = []) {
  const facadeLayout = computeFacadeLayout(footprint, { volumeSplit: 'auto' });
  const { building } = createBuildingFromFootprint(footprint, {
    storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
    roofEaveDepth: 0.35, volumes: facadeLayout.volumes, facadeLayout, roofStructures: normalizeRoofStructures(structures), ...config,
  });
  return building;
}
const placement = { rotation: 0, center: [0, 0], id: '7' };
const exported = (building) => buildGameFile(building, placement);

describe('the game\'s material manifest', () => {
  it('is bundled, and every default Composer falls back on is in it', () => {
    assert.equal(gameManifest().format, 'dixon-materials');
    const defaults = [GAME_WALLS, GAME_ROOFS, GAME_DOORS, GAME_TRIM, GAME_INTERIOR].flatMap(Object.values);
    [...defaults, GLASS, 'shingles_dark', 'roof_membrane', 'stone_foundation', 'trim_dark', 'trim_white']
      .forEach((name) => assert.ok(isGameMaterial(name), name));
    assert.ok(!isGameMaterial('glass_clear'));
  });

  it('lists finishes by category', () => {
    const walls = finishesFor('wall').map((m) => m.name);
    assert.ok(walls.includes('brick_buff') && walls.includes('siding_sage'));
    assert.ok(!walls.includes('shingles_dark'));
    assert.deepEqual(finishesFor('interior-floor').map((m) => m.name), ['floor_wood']);
    assert.match(colorOf('brick_buff'), /^#[0-9a-f]{6}$/);
  });

  it('uses the game\'s live manifest when served by it, and the bundled one otherwise', async () => {
    const live = { ...BUNDLED, hash: 'live', materials: [...BUNDLED.materials, { name: 'brick_new', label: 'New', categories: ['wall'], color: '#123456' }] };
    try {
      assert.equal(await loadGameManifest(async () => ({ ok: true, json: async () => live })), 'game');
      assert.ok(isGameMaterial('brick_new'));
      assert.equal(await loadGameManifest(async () => { throw new Error('offline'); }), 'bundled');
      assert.ok(!isGameMaterial('brick_new'));
      assert.equal(await loadGameManifest(async () => ({ ok: true, json: async () => ({ format: 'other' }) })), 'bundled');
    } finally {
      setGameManifest(BUNDLED);
    }
  });

  it('knows which Composer material each game material looks like', () => {
    assert.equal(familyOf('brick_buff'), 'brick');
    assert.equal(familyOf('siding_sage'), 'wood');
    assert.equal(familyOf('limestone'), 'stone');
    assert.equal(familyOf('trim_white'), 'paint');
    assert.equal(familyOf('roof_membrane'), null);
  });
});

describe('choosing game finishes', () => {
  it('takes a structure\'s over a volume\'s over the building\'s', () => {
    const config = {
      gameFinishes: { wall: 'brick_red', roof: 'shingles_dark', trim: 'trim_dark' },
      volumeGameFinishes: { 'volume-1': { wall: 'siding_sage' } },
      roofStructures: [{ id: 'p', materials: { gameRoof: 'roof_metal' } }],
    };
    assert.deepEqual(resolveGameFinishes(config), config.gameFinishes);
    assert.equal(resolveGameFinishes(config, { volumeId: 'volume-1' }).wall, 'siding_sage');
    const porch = resolveGameFinishes(config, { volumeId: 'volume-1', structureId: 'p' });
    assert.deepEqual([porch.wall, porch.roof, porch.flatRoof, porch.trim], ['siding_sage', 'roof_metal', 'roof_metal', 'trim_dark']);
  });

  it('applies a finish only to a surface of its family and category', () => {
    const finishes = {
      wall: 'brick_buff', roof: 'shingles_brown', flatRoof: 'roof_metal', trim: 'trim_dark', door: 'door_wood', porchFloor: 'stone_foundation',
    };
    const up = [0, 1, 0];
    const side = [1, 0, 0];
    assert.equal(gameMaterialFor({ role: 'wall', palette: 'brick', finishes }, side), 'brick_buff');
    assert.equal(gameMaterialFor({ role: 'wall', palette: 'wood', finishes }, side), 'siding_white', 'brick on siding is left over, not applied');
    assert.equal(gameMaterialFor({ role: 'roof', finishes }, [0, 0.8, 0.6]), 'shingles_brown');
    assert.equal(gameMaterialFor({ role: 'roof', finishes }, up), 'roof_metal');
    assert.equal(gameMaterialFor({ role: 'roof', finishes }, [0, -1, 0]), 'trim_dark');
    assert.equal(gameMaterialFor({ role: 'door', palette: 'wood', finishes }, side), 'door_wood');
    assert.equal(gameMaterialFor({ role: 'door', palette: 'wood', finishes: { door: 'trim_dark' } }, side), 'trim_dark', 'any door');
    assert.equal(gameMaterialFor({ role: 'roof', palette: 'metal', finishes }, [0, 0.8, 0.6]), 'roof_metal', 'a metal porch roof keeps its metal');
    assert.equal(gameMaterialFor({ role: 'roof', part: 'floor', finishes }, up), 'stone_foundation');
    assert.equal(gameMaterialFor({ role: 'wall', palette: 'brick', finishes: { wall: 'shingles_dark' } }, side), 'brick_red', 'a roofing is not a wall');
    assert.equal(gameMaterialFor({ role: 'wall', palette: 'brick', finishes: { wall: 'brick_imaginary' } }, side), 'brick_red');
  });

  it('sends the chosen finishes to the game, and shows them in their game colors', () => {
    const building = build(RECT, { wallMaterial: 'brick', gameFinishes: { wall: 'brick_buff', roof: 'shingles_brown' } });
    const names = Object.keys(exported(building).near);
    assert.ok(names.includes('brick_buff') && names.includes('shingles_brown'), names);
    assert.ok(!names.includes('brick_red') && !names.includes('shingles_dark'), names);
    let walls;
    building.traverse((mesh) => {
      if (mesh.userData?.bodyPart === 'walls') {
        walls = mesh;
      }
    });
    assert.equal(`#${walls.material.color.getHexString()}`, colorOf('brick_buff'));
    assert.equal(walls.material.userData.gameMaterial, 'brick_buff');
  });

  it('leaves a building with no finishes looking and exporting as before', () => {
    const building = build(RECT, { wallMaterial: 'brick' });
    const names = Object.keys(exported(building).near);
    assert.ok(names.includes('brick_red') && names.includes('shingles_dark'), names);
    building.traverse((mesh) => assert.equal(mesh.material?.userData?.gameMaterial, undefined));
  });

  it('gives a volume its own finish', () => {
    const building = build(ELL, {
      wallMaterial: 'brick',
      roofType: 'hip',
      volumeMaterials: { 'volume-1': 'wood' },
      gameFinishes: { wall: 'brick_buff' },
      volumeGameFinishes: { 'volume-1': { wall: 'siding_sage' } },
    });
    const names = Object.keys(exported(building).near);
    assert.ok(names.includes('brick_buff') && names.includes('siding_sage'), names);
  });

  it('gives a porch its own roof and floor', () => {
    const porch = {
      id: 'p', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', width: 6, offset: 2, setback: -2.4, depth: 2.4,
      baseHeight: 'ground', wallHeight: 2.8, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'],
      materials: { gameRoof: 'roof_metal' },
    };
    const building = build(RECT, { gameFinishes: { roof: 'shingles_brown', porchFloor: 'stone_foundation' } }, [porch]);
    const { near } = exported(building);
    assert.ok(near.roof_metal && near.shingles_brown, Object.keys(near));
    assert.ok(!near.trim_dark, 'the porch floor is stone, not the default');
  });

  it('keeps finishes through a project file', () => {
    const layout = computeFacadeLayout(ELL, { volumeSplit: 'auto' });
    const saved = serializeBuildingState(layout, {
      storyCount: 1, gameFinishes: { wall: 'brick_buff' }, volumeGameFinishes: { 'volume-1': { wall: 'siding_sage' }, 'volume-9': { wall: 'x' } },
    });
    const { state } = deserializeBuildingState(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(state.gameFinishes, { wall: 'brick_buff' });
    assert.deepEqual(state.volumeGameFinishes, { 'volume-1': { wall: 'siding_sage' } });
  });
});

describe('windows as the game lights them', () => {
  const window = (id, extra = {}) => ({
    id, kind: 'window', hostWallRunId: 'wall-run-0', offset: 1, width: 1.2, height: 1.4, sillHeight: 0.9, materials: {}, ...extra,
  });
  const withWindows = (openings) => build(RECT, { storyCount: 1, openings });

  it('gives each pane a light the game draws, and UVs across it', () => {
    const openings = [window('a', { offset: 0.5 }), window('b', { offset: 3 }), window('c', { offset: 6 })];
    const file = exported(withWindows(openings));
    const glass = file.near.window_lit;
    assert.ok(glass && glass.indices.length >= 6, Object.keys(file.near));
    const lights = new Set(glass.verts.map((v) => v.slice(8).join(',')));
    glass.verts.forEach((v) => {
      const [lit, warmth, curtain, storefront] = v.slice(8);
      assert.ok([0, 1].includes(lit) && warmth >= 0 && warmth <= 1 && [0, 0.35, 0.65, 0.9].includes(curtain) && storefront === 0, `${v}`);
      assert.ok(v[6] > -1e-3 && v[6] < 1 + 1e-3 && v[7] > -1e-3 && v[7] < 1 + 1e-3, `uv ${v.slice(6, 8)}`);
    });
    // each pane runs the whole 0-1 both ways
    lights.forEach((light) => {
      const verts = glass.verts.filter((v) => v.slice(8).join(',') === light);
      assert.ok(Math.min(...verts.map((v) => v[6])) < 1e-3 && Math.max(...verts.map((v) => v[6])) > 1 - 1e-3);
      assert.ok(Math.min(...verts.map((v) => v[7])) < 1e-3 && Math.max(...verts.map((v) => v[7])) > 1 - 1e-3);
    });
    // nothing else carries a light
    Object.entries(file.near).filter(([name]) => name !== 'window_lit')
      .forEach(([, { verts }]) => verts.forEach((v) => assert.deepEqual(v.slice(8), [1, 1, 1, 1])));
  });

  it('puts the bottom of the pane at V = 0', () => {
    const glass = exported(withWindows([window('a')])).near.window_lit;
    const low = Math.min(...glass.verts.map((v) => v[1]));
    glass.verts.filter((v) => Math.abs(v[1] - low) < 1e-3).forEach((v) => assert.ok(v[7] < 1e-3));
  });

  it('draws the same lights each time the building is sent', () => {
    const openings = [window('a'), window('b', { offset: 4 })];
    assert.deepEqual(exported(withWindows(openings)).near.window_lit, exported(withWindows(openings)).near.window_lit);
    assert.deepEqual(paneLight('7', 'a:0'), paneLight('7', 'a:0'));
    // over many panes, about a third are lit
    const lit = Array.from({ length: 2000 }, (_, i) => paneLight('7', `w${i}:0`)[0]).reduce((a, b) => a + b, 0);
    assert.ok(lit > 600 && lit < 800, `${lit} of 2000 lit`);
  });

  it('lights a wide, low ground-floor window as a shopfront', () => {
    const glass = exported(withWindows([window('s', { width: 2.4, height: 2.2, sillHeight: 0.45 })])).near.window_lit;
    glass.verts.forEach((v) => assert.equal(v[11], 1));
  });
});

describe('checking a file before it goes to the game', () => {
  it('names materials the game doesn\'t have', () => {
    const file = exported(build(RECT));
    assert.deepEqual(gameFileProblems(file), []);
    const bad = { near: { ...file.near, door_oak: { verts: [], indices: [0, 1, 2, 0, 2, 3] } } };
    assert.deepEqual(gameFileProblems(bad), ['2 triangles use "door_oak", which the game doesn\'t have']);
  });

  it('records which vocabulary it was made against', () => {
    assert.equal(exported(build(RECT)).materials_version, gameManifest().hash);
  });
});

describe('roof finishes by slot', () => {
  const names = (slot) => finishesForSlot(slot).map((m) => m.name);

  it('offers shingles and metal for a pitched roof, not membrane', () => {
    assert.ok(names('roof').includes('shingles_dark') && names('roof').includes('shingles_brown') && names('roof').includes('roof_metal'));
    assert.ok(!names('roof').includes('roof_membrane'));
  });

  it('offers membrane and metal for a flat roof, not shingles', () => {
    assert.deepEqual(names('flatRoof').sort(), ['roof_membrane', 'roof_metal']);
  });

  it('offers a slot\'s whole category otherwise', () => {
    assert.deepEqual(names('wall'), finishesFor('wall').map((m) => m.name));
  });
});
