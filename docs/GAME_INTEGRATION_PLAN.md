# Game integration plan: materials and the round trip

Composer and the Dixon game (`dixon_dem`) already exchange buildings in both directions. This plan finishes that exchange: one material vocabulary owned by the game, the game editor's choices carried into Composer, and the loose ends in the round trip. Footprint correction is its own plan: [FOOTPRINT_EDITING_PLAN.md](FOOTPRINT_EDITING_PLAN.md).

Status: planned (2026-09-30). Decisions in [Decisions](#decisions) were made with the project owner.

## Where it stands

| Step | Where | What happens |
|------|-------|--------------|
| Export from the game | `dixon_dem/game/player/building_edit.gd` `_export_composer()` (B, click, X) | Writes `exports/composer/<id>.json` (`format: 'dixon-footprint'`) and opens Composer at `#import=<base64>`. Fields: `id`, `footprint` (`[[x, z], ...]`, game meters, x east, z south), `ground_y_min`, `ground_y_max`, `height_m`, `tags` (OSM), `front` (street direction), and `project` (the last design sent for this id). |
| Import | `js/import.js` `importDixonFootprint()` | Squares the outline, records `placement` (id, rotation, center, groundY), and fills settings from `settingsFromHints(payload.hints ?? {})`. |
| Reopen a design | `js/main.js` `openPayload()` | Reopens `payload.project` if its placement's center and rotation match the new import within 5 cm / 0.005 rad. |
| Send back | `js/game-export.js` `buildGameFile()` | Triangles in game space, grouped by game material name (`near`), convex `hull`, `y0`/`y1`, the `.bld` as `project`; version 2 adds `collision.faces` for walk-in buildings. POSTed to `/game-save/<id>`, or downloaded. |
| Receive | `dixon_dem/game/tools/composer_server.py` | Validates and writes `game/data/composed/<id>.json`. |
| Bake | `dixon_dem/pipeline/buildings/composed.py` `build()` | Copies `near` groups into the chunk's mesh with the ground height added; far LOD is a box tinted by the largest wall material; collision is the hull and y range. |
| Materials in Godot | `dixon_dem/game/buildings/tools/build_buildings.gd` `_build_array_mesh()` | Each group key is looked up in the manifest's `materials` (from `pipeline/buildings/palette.py` `MATERIALS`). |
| Use / revert | building editor I / R | `composed: false` in `game/data/building_overrides.json` turns a design off. |

## Problems

1. **Names the game doesn't have.** Composer emits five material names that are not in `palette.MATERIALS`: `door_wood`, `glass_clear`, `plaster_white`, `plaster_ceiling`, `floor_wood`. `build_buildings.gd` only sets a surface material when the name is found, so those surfaces silently get Godot's default material. There is no warning on either side.
2. **A lossy palette.** Composer has 7 material families (`brick`, `wood`, `stucco`, `metal`, `stone`, `paint`, `black`). The game has 12 wall finishes (5 bricks, 5 sidings, limestone, roof metal) plus roofs, trim, and accents. Export maps each family to one name (`GAME_WALLS` in `js/game-export.js`), so a `brick_buff` building comes back `brick_red`, and `siding_gray`, `siding_sage`, and `siding_blue` can't be chosen at all. The main roof has no finish choice: pitched is `shingles_dark`, flat is `roof_membrane`.
3. **The game editor's choices are lost.** The game exports OSM `tags`, but not the building's own template or override fields (`form`, `storeys`, `roof`, `roof_axis`, `color`, `material`, `dressing`). Composer reads `hints`, which the game never sends, so its storeys, roof, and material fall back to OSM tags (mostly empty) or defaults.
4. **Two copies of the vocabulary.** The names are hardcoded in `js/game-export.js` and in `palette.py` (and again in `composed.py` `WALL_MATERIALS`). Nothing checks one against the other.
5. **Fragile reopen.** Reopening a saved design compares the re-squared placement, not the outline. It works while the game's outline never changes, but not once outlines can be corrected (see the footprint plan).
6. **Walk-in collision not used.** The game reads only the hull. A version 2 file's `collision.faces` is ignored, so a walk-in interior can't be walked into.

Not a problem: UVs. The game's building materials use triplanar mapping (`shader_parameter/triplanar = true` in e.g. `game/materials/lib/brick_red.tres`), so Composer's per-meter UVs don't affect them. New materials should follow the same convention.

## Decisions

- **The game owns the material vocabulary.** It publishes a manifest; Composer reads it and never invents names.
- **Missing surfaces get new game materials** (doors, interior walls, floors, ceilings, white trim), not substitutes.
- **Windows glow at night like the generated buildings'.** Composed exterior panes use the game's `window_lit`, with the same per-pane lit and curtain variation. No separate unlit glass material.
- **White trim.** The game gets a `trim_white` material; Composer's trim uses it instead of `siding_white`.
- **Footprints are edited in Composer and written back to the game** (the footprint plan).

## Plan

### Phase 1 — A material manifest (dixon_dem)

- `pipeline/buildings/palette.py`: give every material a `category` and a `label`, and add `manifest()` returning `[{ name, category, label, color, resource }]`. `color` is the existing `APPROX_COLOR` as sRGB hex. Categories: `wall`, `roof`, `trim`, `foundation`, `glass`, `door`, `interior-wall`, `interior-floor`, `interior-ceiling`, `accent` (awnings, `steel_rusted`).
- Write `game/data/materials_manifest.json` whenever the build plan is made (`build_building_plan.py`), and commit it, so it can't drift from `MATERIALS`.
- `game/tools/composer_server.py`: `GET /game-materials` serves that file (read-only, same host as today).
- `composed.py`: choose the far-LOD tint from the largest `wall`-category group, from the manifest, instead of the hardcoded `WALL_MATERIALS`.
- Tests (`pipeline/buildings/`): manifest names equal `MATERIALS` keys; every entry has a category, label, and color.

### Phase 2 — New game materials (dixon_dem)

- Add `.tres` files for `door_wood`, `plaster_white`, `plaster_ceiling`, `floor_wood`, and `trim_white`, based on the existing building material shader (triplanar). The first four are names Composer already emits. `game/data/composed/` is empty today, so no earlier files depend on the old names.
- `glass_clear` is not added: exterior glass is `window_lit` (Phase 3).
- Add each to `MATERIALS`, `APPROX_COLOR`, and the manifest categories (`trim_white` as `trim`).
- `build_buildings.gd`: `push_warning` when a group key has no material, naming the building, instead of silently using the default.
- `test_composed.py`: every group name in a composed file is a manifest name.

### Phase 3 — Composer uses the game's finishes (building-composer)

- `js/game-materials.js` (new, pure): load the manifest from `/game-materials` when served by the game's server, falling back to a bundled copy, `data/game-materials.json`. `scripts/sync-game-materials.mjs` refreshes the bundled copy from `../dixon_dem/game/data/materials_manifest.json`. Helpers: `finishesFor(category)`, `colorOf(name)`, `isGameMaterial(name)`, `familyOf(name)` (e.g. `brick_buff` is `brick`, `siding_sage` is `wood`, for Composer's own roughness and look).
- Model: explicit game finishes, following the existing per-volume pattern (`volumeRoofShapes`, `volumeEaves`):
  - `modelConfig.gameFinishes = { wall, roof, flatRoof, trim, foundation, door, glass, porchFloor }` (building defaults, each optional);
  - `volumeGameFinishes[volumeId]` for per-volume overrides;
  - `structure.materials.gameWall` / `gameRoof` for roof structures;
  - persisted in `.bld` (`js/facade.js` serialize/deserialize).
- UI: a **Game finish** select beside each Material select (walls, roof, structures), listing the manifest's finishes for that category with their colour. Picking a finish also sets the matching Composer family, and the preview uses the manifest colour, so the model looks as it will in the game. Shown when a manifest is available; otherwise the UI is unchanged.
- `js/materials.js`: materials carry `userData.gameMaterial` when a finish is chosen.
- `js/game-export.js` `gameMaterial()`: use `userData.gameMaterial` first, and the existing role/palette tables only as a fallback when none is set. Trim maps to `trim_white` by default.
- **Windows as the game draws them.** Exterior panes export as `window_lit`. That shader reads each pane's vertex colour as `(lit, warmth, curtain, storefront)` and expects UVs running 0–1 across the pane (`window_unit()` in `dixon_dem/pipeline/buildings/facade.py`). Composer today writes white and per-meter UVs, which would make every window lit, curtained, and a storefront. For each pane (one opening's glass), export must:
  - write UVs 0–1 across the pane's width and height;
  - write a vertex colour drawn like the game's: lit with probability 0.35, warmth uniform in 0–1, curtain from `[0, 0, 0.35, 0.65, 0.9]`, storefront 1 only for a ground-story shopfront opening;
  - seed the draw from the building id and the opening's id, so a building looks the same each time it's sent.
  - Test: every `window_lit` vertex's colour is one pane's, UVs are 0–1, and the same design exports the same colours twice.
  - Panes in doors (sidelights, transoms, door lights) follow the same rule.
- Before Send to game: check every group name against the manifest. If any is unknown, refuse and name the surfaces (e.g. "doors use door_oak, which the game doesn't have"). The download fallback applies the same check.
- Tests: manifest loading and fallback; finish resolution (building, volume, structure precedence); export uses explicit finishes; an unknown name is refused; `.bld` round trip keeps finishes.

### Phase 4 — Carry the game editor's choices into Composer

- dixon_dem `building_edit.gd` `_export_composer()`: add `hints` from the building's resolved record (`_record`): `form`, `storeys`, `roof`, `roof_axis`, `material`, `color`, `dressing`, `porch`, and `awnings`. Confirm `_record` is the resolved template including overrides, not only the override.
- `js/import.js` `settingsFromHints()`:
  - `color` becomes `gameFinishes.wall` exactly (e.g. `brick_buff`), and sets the family;
  - `roof_axis` (`front` or `side`) becomes the ridge direction relative to the imported `front` side;
  - `storeys`, `roof`, and `material` are handled as today.
- A building sent back and reopened keeps its finishes through `project`, as today.
- Tests (`tests/import.test.js`): each hint field; a `color` not in the manifest is ignored with a warning.

### Phase 5 — Round-trip robustness

- **Identity by outline, not placement.** At import, store `placement.sourceHash`, a hash of the game outline as exported, rounded to the millimeter. Reopen `payload.project` when its `sourceHash` matches the export's outline hash, and keep the center/rotation comparison only for designs saved before this change. This is needed once outlines can be corrected, because an edited outline re-squares to a slightly different center. Shared with the footprint plan.
- **Walk-in collision.** `composed.py` passes `collision.faces` through, and `build_buildings.gd` builds a `ConcavePolygonShape3D` (double-sided) from it, falling back to the hull when absent. Test with a version 2 file.
- **Versioning.** `dixon-composed` version 3 adds `materials_version` (the manifest's hash). The game warns, but still loads, when a file was made against an older vocabulary.

### Later

- Detail levels (`mid`, `far`) by part tag, as described in ARCHITECTURE.md §8. The far box is adequate for now.

## Verification

- Composer: `npm test` covers manifest loading and fallback, finishes, export validation, and hint mapping.
- Game: pytest covers manifest generation, composed names being known, and collision faces.
- End to end:
  1. Run `python3 game/tools/composer_server.py`.
  2. In the game, press B, click a brick building whose override has `color: brick_buff`, and press X. Composer should open with the wall finish `brick_buff`, the right storeys and roof, and the ridge set by `roof_axis`.
  3. Add a door and windows and a walk-in interior. Send to game.
  4. Rebuild the chunk (Enter, or I). The walls are buff brick, trim is white, doors and the interior use their new materials, the interior can be walked into, and the Godot log has no unknown-material warnings. At night, about a third of the windows glow, with curtains varying as on the neighbors.
  5. Press X again. The design reopens.

## Open questions

- **Interior glass.** A walk-in building's windows are seen from inside too. Does `window_lit` read well from inside (its glow and curtains are drawn for a viewer outside), or does the inner face need its own treatment?
- **Roof finishes.** Offer `shingles_brown` and `roof_metal` for pitched roofs, and `roof_membrane` or `roof_metal` for flat roofs, per volume?
- **Bundled manifest freshness.** Composer run on its own (not through the game's server) uses the bundled copy. Is a sync script enough, or should Composer show the manifest's version when it opens a game building?
