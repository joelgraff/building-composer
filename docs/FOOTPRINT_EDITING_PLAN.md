# Footprint editing plan

The footprints the Dixon game exports come from OSM, Microsoft's ML footprints, and a few hand traces, and they miss detail. This plan adds a footprint editor to Composer, with the game's aerial imagery underneath, and writes the corrected outline back to the game so both the composed building and the game's own generated building use it. The material and round-trip work is in [GAME_INTEGRATION_PLAN.md](GAME_INTEGRATION_PLAN.md).

Status: planned (2026-09-30). Decisions in [Decisions](#decisions) were made with the project owner.

Progress:

- Phase 2 (editor core) is done: `js/footprint-editor.js`, tested in `tests/footprint_editor.test.js`. `squareFootprint` in `js/import.js` now takes its tolerances and a fixed rotation as options, for the editor's re-square; imports use the same defaults as before.
- Phase 3 (editor UI) is done, except the aerial and neighbors, which wait for phase 1's endpoints: `js/footprint-view.js` draws footprint mode, and `js/main.js` opens it (File › Edit footprint…, the Building panel, and a building from the game with no saved design) and applies the result. It asks for `/game-footprints` and `/game-aerial` with the query this plan gives and, until they answer, says so in the Layers section. The game's trace and the squared import are kept in `placement.trace` and `placement.squared`, in game coordinates. Using an outline with a different number of walls drops the windows, doors, chimneys, and wall trim (placed by wall); with a different number of masses, also the masses' own settings and the roof structures; it asks first.
- Open question answered for now: only a building with no saved design opens in footprint mode (as proposed).

## The problem

Where footprints come from today (`dixon_dem`):

- `game/data/buildings.json`: 707 OSM footprints.
- `game/data/buildings_ms.json`: Microsoft open ML footprints filling the rest of the town (`pipeline/buildings/ms_footprints.py`).
- `game/data/buildings_curated.json`: hand traces from `pipeline/buildings/aerial_trace.py`. Pixel rectangles and polygons are typed into the Python file, measured on a Google Earth screenshot (about ±2 m). A curated record gets a new id and `replaces` the OSM ids it covers.

What's missing, as seen in practice:

- small jogs and bump-outs (bays, chimney chases, shallow projections);
- porches, stoops, and additions missing from the trace;
- outlines offset, turned, or mis-scaled against the aerial.

Composer makes it worse on import. `js/import.js` squares any wall within 5° of the main axes (`MAX_SKEW_DEGREES`), drops jogs under 15 cm (`MIN_EDGE`), and puts wall lines within 30 cm on one line (`ALIGN`). These suit a noisy trace, but they also remove real detail, and there's no way to change them.

There is no footprint editor in either project. ARCHITECTURE.md §7 lists an in-app 2D polygon editor as a bonus input.

## Decisions

- **Edit in Composer.** It already holds the outline, validates it (`validateFootprint`, `angledWallProblem`), and turns it into volumes, and web UI is quicker to build than a GDScript editor inside the 3D game.
- **Write the result back to the game** as a footprint override keyed by the building's own id. The game's generated building, collision, neighbors' context, and later X exports then all use the corrected outline, not only a composed design.

## What there is to trace against

- **Orthoimagery**: `dixon_dem/data/raw/il2025/`, Illinois 2025 leaf-off imagery at 0.25 m/px (0.1524 m native), fetched by `pipeline/aerial/fetch_illinois.py`. 2048-px tiles of 512 m, north-up, axis-aligned in game coordinates (`x = world_x0 + px * mpp`, `z = world_z0 + py * mpp`), listed in `index.json`. Public domain. Gitignored (211 MB); each machine fetches its own.
- **Game frame**: x east, z south (−north), meters, origin at UTM 16N (292300, 4634000) (`game/data/world_origin.json`).
- **Composer's frame**: `game point = placement.center + R(placement.rotation) · Composer point`, saved at import.

Caveat: an aerial shows **roofs, not walls**. Tracing roof edges gives an outline one eave depth (typically 0.3–0.6 m) too large on every side with an overhang. The editor should show a guide inset from the drawn outline by the building's eave depth, and the tracing notes should say to trace the wall line.

## Workflow

1. In the game: B, click the building, X. Composer opens it (unchanged).
2. Composer opens a building with no saved design in **footprint mode**: a 2D plan with the aerial beneath, the game's trace, the squared outline, and the neighbors' outlines. A design already saved opens in the usual 3D view, with an **Edit footprint** button.
3. Correct the outline: move, insert, and delete corners; move walls; add bump-outs and notches; snap to square, to the aerial grid, and to neighbors' walls; type lengths and offsets.
4. **Use this footprint** goes on to the design, building volumes as today.
5. **Save footprint to game** writes the override (see below). Rebuild the chunk in the game (Enter) to see the generated building on the new outline, or design the building and Send to game as today.

Which parts belong in the footprint: enclosed rooms (bump-outs, additions, enclosed porches). Open porches, stoops, steps, and bays are Composer structures and steps, not footprint. OSM often traces an open porch as part of the building, so the editor has a one-step **Turn into a porch** (below).

## Design

### Composer: the editor

- **`js/footprint-editor.js`** (new, pure, no DOM or THREE): edit state and operations, so all of it is testable in node.
  - Operations: move corner; insert a corner on a wall; delete a corner; move a wall along its normal (neighbors keep their directions); add a rectangular bump-out or notch on a wall (position, width, depth); straighten or square one wall; re-square the whole outline with adjustable tolerances; undo and redo.
  - Snapping: to 90° and the building's axes, to a 5 cm grid, and to neighbors' walls (for party walls).
  - Validation after every edit: closed, not self-intersecting, winding, no wall shorter than a minimum, and `angledWallProblem`.
- **Turn into a porch.** Select a rectangular part of the outline standing out from a wall (or draw a rectangle across a wall), and choose Turn into a porch:
  - the part is cut out of the footprint, leaving the wall straight behind it;
  - a porch roof structure (projecting from that wall, standing at ground level, with steps from its open front) is added with the part's offset along the wall, width, and depth;
  - a part that turns a building corner becomes a wraparound porch (`wrap`);
  - a part that sits inside the wall line (a recessed porch traced as solid) becomes a recessed porch (`mount: 'recess'`), keeping the footprint.

  The porch is created when the footprint is used, through the normal structure path (`normalizeRoofStructure`, `resolveRoofStructure`). If it's refused, the message says why (e.g. too shallow), and the footprint change stands. It's one undo step in the editor. The footprint written back to the game leaves the porch out, as it's not an enclosed part, and the porch goes back separately so the game's generated building has it too (below, `porches` in the override).
- **UI** (`js/main.js`, `index.html`): a footprint mode in the main viewport. An SVG overlay is recommended over a Three.js scene, for crisp handles, simple hit-testing, an `<image>` underlay, and zoom and pan with `viewBox`.
  - Layers, each toggleable: aerial (with opacity), the game's trace (dashed), the squared import, the edited outline with corner and wall handles, neighbors' outlines, and the eave-inset guide.
  - Readouts: wall lengths and angles, area, and how far the outline moved from the game's trace.
  - Numeric entry for a selected wall's length or offset, in Composer's display units (feet or meters).
  - **Import simplification** settings (`MAX_SKEW_DEGREES`, `MIN_EDGE`, `ALIGN`) with a "keep as traced" option, so detail the default squaring drops can be kept.
- **Frame.** The editor works in Composer's frame, square to the building's axes, so most walls are horizontal or vertical. The aerial crop is turned by −rotation to match. Composer re-centers footprints on their centroid; after an edit, the change in centroid is added to `placement.center` (turned by the rotation) so the building doesn't move in the game. This needs a test.

### Server: `dixon_dem/game/tools/composer_server.py`

- `GET /game-aerial?x0=&z0=&x1=&z1=&mpp=`: a PNG of an axis-aligned box in game coordinates, stitched from the `il2025` tiles (Pillow), with a small cache. Composer asks for the footprint's box plus about 15 m.
- `GET /game-footprints?x0=&z0=&x1=&z1=`: outlines with ids in a box, from OSM, Microsoft, curated, and overrides (the override replacing its source), for context and snapping.
- `POST /game-footprint/<id>`: validates and writes the override (below) atomically. It uses the same same-origin checks as `/game-save` (`X-Composer` header, `Origin`, plain id, size limit).
- Without the server (Composer opened as a file, or on its own), there is no aerial or neighbors, and Save footprint to game downloads the override file for `game/data/footprint_overrides/` instead, like Send to game does.

### The override file

One file per building, `game/data/footprint_overrides/<id>.json`, like `game/data/composed/<id>.json`, so edits to different buildings never conflict:

```json
{
  "format": "dixon-footprint-override",
  "version": 1,
  "id": "115768678",
  "footprint": [[508.108, -212.668], [523.095, -213.555], "..."],
  "based_on": { "source": "osm", "hash": "<hash of the outline it replaced>" },
  "source": "building-composer",
  "note": "",
  "edited": "2026-09-30T14:00:00Z"
}
```

`footprint` is in game coordinates, in the same winding as `game/data/buildings.json` (see the triangle-winding notes near the top of the game's `docs/buildings_notes.md`). `based_on` lets the game notice when the underlying OSM or Microsoft outline has since changed.

Porches made with Turn into a porch go in the same file, so the game's generated building gets them too:

```json
"porches": [
  { "kind": "shed_full", "legs": [ { "a": [510.2, -212.8], "b": [519.6, -213.4], "depth": 2.4 } ] }
]
```

- Each leg is the porch's back edge along the wall, `a` to `b` in game coordinates, ordered so the edge's outward normal (the pipeline's `edge_dir_normal`, counter-clockwise rings) points away from the building, and its depth.
- A projecting porch has one leg; a wraparound has one per wall.
- `kind` is the game's nearest porch kind, for its style (post style, railing): `stoop` for a porch under about 1.5 m deep and 2.5 m wide, `wrap` for a wraparound, `gable_full` for a gable roof, and `shed_full` otherwise.
- A recessed porch has no entry: the game's generator can't cut into its mass. It stays part of the solid building in the game's generated version.
- Porches Composer already had (not made by Turn into a porch) are not sent. Only the footprint editor writes this list.

The game's generator places porches by kind alone: on the main block's first wall, at a fraction of its width, with a fixed depth (`_place_porch()` in `pipeline/buildings/archetypes.py`). So the exact position has to travel with the kind.

### Game: pipeline and editor (dixon_dem)

- `pipeline/buildings/build_building_plan.py`: after loading OSM, curated, and Microsoft footprints, apply `footprint_overrides/`. Replace the `footprint` of the record with that id, keep its id and tags, and recompute its ground heights from the heightmap as it already does. If `based_on.hash` no longer matches the source outline, warn and keep the override.
- Porches from the override: set the building's template `porch` to the first porch's `kind` (over the generated choice, but under an explicit `porch` in `building_overrides.json`), and pass the legs as `porch_legs`.
- `pipeline/buildings/archetypes.py` `_place_porch()`: when the template has `porch_legs`, build each leg with `build_porch(mb, a, b, ground_y, rng, width_frac=1.0, max_width=<leg length>, depth=<depth>)`, which already places a porch exactly along a given edge, instead of the kind's default edge and size. Without `porch_legs`, nothing changes.
- Tests: an override with a porch on a side wall builds the porch on that wall, at that offset, width, and depth; a wraparound builds a porch per leg; a building without `porch_legs` builds as before.
- `game/player/building_edit.gd`:
  - `_footprint(bid)` reads an override first, so X exports the corrected outline. The export adds `override: true` and `based_on`.
  - A key to revert a footprint to its source (deleting or disabling the override), matching R for composed designs.
- Check that Microsoft footprint ids are stable across a re-fetch (`ms_footprints.py`), since overrides are keyed on id.

### Reopening a design after the outline changes

Shared with the integration plan's Phase 5. Composer stores the hash of the outline a design was made from (`placement.sourceHash`), and reopens a saved design when the export's outline hash matches it, instead of comparing re-squared center and rotation. A design made on the old outline, opened after the footprint was corrected, opens with a notice that the outline changed and an offer to keep the design (fitting it to the new outline where possible) or start from the new outline.

## Phases

1. **Server, read-only** (dixon_dem): `/game-aerial` and `/game-footprints`, with pytest on a synthetic tile and a few records.
2. **Editor core** (Composer): `js/footprint-editor.js`, with node tests for every operation, undo, snapping, validation, and the placement adjustment when the centroid moves.
3. **Editor UI** (Composer): footprint mode, layers, handles, numeric entry, import simplification settings, and the entry points (new building, Edit footprint).
4. **Turn into a porch** (Composer): the cut, the porch, wraparound, and recessed cases, with tests that each yields a valid footprint and an accepted porch structure matching the cut part.
5. **Write-back**: `POST /game-footprint/<id>`, the override file, and the download fallback.
6. **Game pipeline and editor** (dixon_dem): apply overrides in the build plan, including porches placed by their legs (`porch_legs` in `_place_porch()`); X exports them; revert key (which also removes the porches); tests.
7. **Reopen by outline hash** (Composer), with the integration plan's Phase 5.
8. **Docs**: ARCHITECTURE.md §7 (the input pipeline), IMPLEMENTATION_PLAN.md, and the game's `docs/buildings_notes.md`.

Phases 1 and 2 are independent and can go in parallel. The UI needs both.

## Verification

- `npm test` (Composer) and pytest (dixon_dem) cover the pieces above.
- End to end:
  1. Run `python3 game/tools/composer_server.py`.
  2. In the game, press B and click a house whose OSM outline lacks a visible rear addition, then X. Composer opens in footprint mode with the aerial aligned under the trace. Check alignment against a clear corner.
  3. Add the addition as a bump-out, and snap a wall to the neighbor's party wall. Its front porch was traced as part of the house: select it and Turn into a porch. Save footprint to game.
  4. In the game, rebuild the chunk. The generated house has the addition, a porch where the traced one was (same wall, offset, width, and depth), and sits where it did.
  5. Press X again. The corrected outline arrives, and a design saved before the edit offers to fit or start fresh.
  6. Design the building, Send to game, and rebuild. The composed building matches the corrected outline.

## Out of scope for now

- **Adding buildings missing from every source**, and splitting or merging buildings. Merging is possible today through `buildings_curated.json` `replaces`; a Composer-drawn new building would need a new id range.
- **Editing in the game itself.** The override format is plain JSON, so a small in-game editor could be added later without changing it.
- **Automatic outline refinement** from the imagery (edge detection).

## Open questions

- **Default entry point.** Should every X open in footprint mode first, or only buildings without a saved design (as proposed)?
- **Imagery elsewhere.** The aerial tiles are only on the machine that fetched them. Should the server fetch a missing tile on demand (`fetch_illinois.py` logic), or should Composer do without?
