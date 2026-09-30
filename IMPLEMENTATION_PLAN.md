# Building Composer — Implementation Plan

This plan is the execution guide for the MVP and follows the architecture in ARCHITECTURE.md. It is intentionally milestone-driven: each stage produces a visible and testable piece of the model before the next set of work begins.

## Project scope and constraints

- Standalone local app, no framework.
- HTML + vanilla JS ES modules only.
- Three.js local package; no CDN.
- Units are meters; Y is up; footprint is in the XZ plane.
- Origin is computed from footprint centroid internally.
- Output should remain GLB/GLTF export compatible.
- No classes unless they genuinely simplify state management; plain objects are preferred for data.
- Winding must be configurable, because the Godot upstream model is expected to prefer clockwise input even though the default composer behavior is CCW.

## Current project status

### Completed
- Task 1: footprint input and validation
- Task 2: extrusion engine for foundation, wall mass, and flat roof
- Task 3: facade subdivision metadata (stories, wall runs, equal panels)
- Local app shell, JSON file input, orbit controls, unit display, GLB export

### In progress
- Task 4: material assignment. Palette and story/panel selectors exist; solid finish panels render on rectangular footprints only. Roof structures take their own wall and roof materials.
- Task 5: flat, gable, hip, shed, mansard, and gambrel roofs, and hips cut flat at a widow's walk (also on a continuous L/U hip). Rectangular analytic meshes and one equal-pitch hip skeleton path work. Complex joins do not; mansards on L/U footprints are per-volume, not continuous. See [Complex roof structures](#complex-roof-structures).
- Task 9: automatic rectilinear volume decomposition and per-volume story, roof type, and ridge controls. Caps stay independent.
- Task 10: roof-borne envelope modifiers (dormers, wall dormers, recessed porches, porches with supports and stacking, cupolas, widow's walks) are built and editable, with their walls and railings exposed as facade surfaces. The porch arrangements are provisional pending real buildings to model against. Bay windows and ground-level envelope modifiers beyond porches are not started. See [Roof-borne structures](#roof-borne-structures-dormers-raised-porches--plan).

### Not started
- Tasks 6–8: windows, doors, trim, railings, steps, and other facade and footprint modifiers. Roof structure wall runs and railing runs are ready for them to target.

## Architecture-aligned milestones

### Phase 1 — Geometry intake and validation

#### Task 1: Footprint input + validation
Status: Complete

Requirements:
- Accept a footprint as a JSON array of [x, z] pairs.
- Enforce closed ring validation.
- Detect self-intersections.
- Enforce configurable winding direction.
- Compute area, perimeter, centroid, and bounding box.
- Normalize model coordinates to centroid origin.

Acceptance criteria:
- The app accepts a simple rectangle footprint.
- Invalid footprints display a clear message.
- The sample rectangle validates and renders without error.

Implementation notes:
- Validation defaults to CCW to conform to standard geometry conventions.
- CW remains supported for Godot-imported data.
- This is now explicitly reflected in the architecture documentation.

#### Immediate follow-up actions
- Accept duplicate closing points and silently normalize them.
- Add more descriptive validation messages for degenerate or nearly collinear polygons.
- Expose a repair hint when a ring is not closed or winding is reversed.

### Phase 2 — Core massing

#### Task 2: Extrusion engine → foundation, walls, flat roof
Status: Complete for the basic rectangular box case

Requirements:
- Extrude footprint upward using story count × story height.
- Add foundation below grade.
- Add a flat roof cap with slight overhang.
- Use MeshStandardMaterial.
- Use orbit camera controls for interactive inspection.

Acceptance criteria:
- Footprint loads into a recognizable box mass.
- Roof cap clears the wall envelope.
- Local rendering remains stable in the browser.
- GLB export executes without requiring a build step.

Implementation notes:
- The current geometry is intentionally minimal and architecture-friendly.
- The geometry is structured as a group with explicit metadata for later facade and modifier integration.

#### Follow-up actions
- Add configurable roof thickness and depth.
- Add material presets and palette selection.
- Ensure exported models can retain the root building group without visual artifacts.

### Phase 3 — Facade subdivision

#### Task 3: Facade subdivision (stories + wall runs + optional panels)
Status: Complete

Requirements:
- Derive wall runs from footprint edges.
- Optionally subdivide wall runs into facade panels for surface features.
- Build a story-band map across the building height.
- Produce stable IDs for `story + wallRun` addressing, with optional panel detail.
- Attach metadata for later window, door, and cornice placement.

Acceptance criteria:
- A footprint of 4 vertices produces 4 wall runs.
- Optional panels subdivide those runs without implying structural boundaries.
- Story bands reflect the chosen story count and height.
- Data is plain object geometry metadata rather than class-heavy state.

Required output:
- A facade module that computes and returns:
  - story bands
  - wall runs
  - optional facade panels with lengths and center points
  - stable IDs and neighbor metadata

Recommended data shape:

```js
{
  storyCount: 2,
  storyHeight: 3.2,
  totalHeight: 6.4,
  stories: [
    { id: 'story-1', index: 0, minY: 0, maxY: 3.2 },
    { id: 'story-2', index: 1, minY: 3.2, maxY: 6.4 }
  ],
  panelsPerRun: 2,
  wallRuns: [
    { id: 'wall-run-0', index: 0, length: 20 }
  ],
  facadePanels: [
    { id: 'facade-panel-0', wallRunId: 'wall-run-0', positionInRun: 0, length: 10 },
    { id: 'facade-panel-1', wallRunId: 'wall-run-0', positionInRun: 1, length: 10 }
  ]
}
```

#### Planned deliverables
- `js/facade.js`
- Integration hook in `js/main.js` to compute facade metadata after validation
- UI summary showing wall-run and facade-panel counts
- Editor-only dashed story and panel guides aligned to the wall envelope
- GLB export excludes editor-only preview geometry

### Phase 4 — Material assignment

#### Task 4: Material assignment per wall run/story with optional panel override

Requirements:
- Attach default material assignments by wall run and story.
- Allow optional facade-panel overrides for local surface differences.
- Support the standard v1 palette: brick, wood, stucco, metal, stone.
- Keep material assignment independent from geometry generation.

Acceptance criteria:
- Each story band can be assigned a material.
- Each wall run can be tagged with a default facade finish.

Current slice:
- The facade layout carries material keys for every story and optional facade panel.
- The app exposes the v1 palette and applies the selected facade finish to the wall mass.
- Story and facade-panel selectors now update independent facade-region panels on the wall envelope.
- The continuous wall mass remains as the structural base; region panels provide the visible and exportable finish assignment.

Remaining Task 4 work:
- Add persistence for material assignments in the native `.bld` data format.
- Preserve the documented precedence rule: facade-panel and structural assignments override story assignment.

### Phase 5 — Roof and massing variants

#### Task 5: Gable + hip roof types
Status: In progress

Requirements:
- Add alternative roof geometry types while preserving flat roof default.
- Reuse the same footprint and facade metadata.
- Keep roof type and ridge direction explicit so future roof zones can use
  different configurations.

Acceptance criteria:
- Gable and hip forms produce a valid roof envelope without destabilizing the base model.

Current slice:
- Flat, gable, and hip controls are available in the UI.
- Manual roof-pitch edits use integer rise:run steps normalized to 12 run;
  manual roof-rise edits preserve decimal precision and may produce a
  fractional ratio. Degrees are shown parenthetically.
- Rectangular footprints generate explicit gable and hip roof meshes.
- Non-rectangular footprints retain the flat-cap fallback until explicit roof
  zones are assigned.
- Roof controls are enabled for every footprint. Rectangular footprints use
  the analytic roof mesh; other rectilinear footprints use a seamless
  roof-field surface (distance-to-nearest-exterior-edge, scaled by pitch)
  that automatically produces correct hips and valleys at convex/concave
  corners without a separate joinery step. Eave projection remains
  rectangular-only for now.
- Non-rectangular fallback roofs are constrained to the selected footprint;
  unsupported eave projection is intentionally disabled until roof zones are
  explicit.
- Solid facade material overlays are currently limited to rectangular
  footprints; concave footprints retain metadata and face-aligned guide lines
  without adding overlay geometry beyond the core facade.
- Ground-level footprint previews and dashed facade guides are suppressed for
  non-rectangular presets until exact wall-face mapping is implemented.
- Wall, roof, foundation, and facade-guide geometry now share the same
  positive-Z footprint orientation, including asymmetric L/U footprints.
- The facade layout now exposes explicit default `volume-main` and
  `roof-zone-main` metadata, with roof-zone ownership linked to wall runs.
- Roof eave depth is an explicit roof-only parameter and is adjustable without
  changing the wall envelope.
- UI length and area values can be displayed and edited in feet or meters;
  imperial feet is the default while internal geometry remains meter-based.

Roof-zone test fixtures:
- `data/footprint_u.json`: U-shaped footprint.
- `data/footprint_l.json`: L-shaped footprint.
- `data/footprint_narrow_lean_to.json`: narrower rear attached lean-to.
- `data/footprint_wide_wing.json`: wider attached wing.
- The preset selector loads each fixture for interactive testing before facade
  modifiers are started.

### Phase 6 — Facade modifiers

#### Task 6: Windows, doors, and parametric facade openings
Status: First pass done (`js/openings.js`). Windows have a sill, and can have a cap over the head, a grille (one over one to nine over nine), shutters, and an arched top; doors can be a pair, with sidelights, a transom, and a cap (`js/opening-details.js`; a walk-in doorway is cut through the leaves only). A wall can be filled with windows in one go: so many to a story, in equal bays lined up floor to floor, clear of its doors (`windowGrid`). Openings are frame-and-pane appliqué on the wall face, not cuts, on footprint walls and on roof structures' own walls (a dormer's face, a tower's sides), kept within the wall's visible shape.

Requirements:
- Place windows and doors on facade panels using story + wall-run addressing.
- Keep all modifiers relative to the wall envelope.

### Phase 7 — Ornament and trim

#### Task 7: Cornices, water tables, dentils
Status: First pass done (`js/trim.js`). Building-wide water table, belt courses at floor lines, and a cornice with optional dentils, swept round the footprint walls with mitered corners and broken around windows and doors. The cornice top is measured from the built roof's soffit. Roof structures' walls carry the courses too: the house's water table and belt courses where their walls span those heights (a tower, a bay), and each structure's own cornice under its own roof, all kept to the visible part of each wall. Railings (`js/railings.js`: top and bottom rails, a filling of square or turned balusters, flat sawn boards, a solid panel, or horizontal bars, and newels) run along porches' open sides, opening at their steps, and round widow's walks, in the trim material; each porch's, and the building's walk railing, has its own on/off, style, height, and spacing. Any wall, a structure's included, can turn each course on or off for itself (`wallTrim`); course sizes stay building-wide. The house's outside corners can have corner boards or quoins, from the water table up under the cornice. Chimneys (`js/chimneys.js`) stand on the house's walls, outside from the ground or inside through the roof, rising a set height over the roof around them, with a cap and flue. Gutters (`js/gutters.js`) run along the eaves, read off the roof as built, mitered where eaves meet, with downspouts from their ends.

Requirements:
- Add trim features as surface modifiers on the facade envelope.

### Walk-in interiors (navigable shells)
Status: First pass done (`js/interior.js`), opt-in per building ("Walk-in interior" in Facade defaults, off by default). Each mass is a hollow shell: walls of a set thickness built inward from the footprint line (so everything on the outside stays where it was), a floor on the foundation, and a ceiling at the ground story's height (upper stories stay solid until there are stairs). Neighboring masses are joined by passages cut through their shared walls; doors in the house's walls are cut through into the room and drawn standing open (hinge side per door); windows stay closed. The game file for a walk-in building (version 2) adds `collision.faces`, the triangles to collide with (door leaves, frames, and skins left out); the Dixon game's loader still needs to read it (see js/game-export.js). Not yet: interior partitions, stairs and upper floors, roof structures' interiors (a bay or tower stays closed off from the house), and confirmed game material names for the interior surfaces.

### Phase 8 — Footprint modifiers

#### Task 8: Steps, window wells, stoops
Status: Entry steps done: a door in the house's walls whose threshold is above grade gets a flight down to the ground (even risers, a landing at the door), part of the door record and switchable per door, and left off, with the reason given on the door, where a porch or bay stands in front of it, the house itself is in the way (a stoop run into an inside corner), or another flight is; a ground-level porch gets a flight from its open front (one per wall of a wraparound), its posts framing the opening, which can be moved along the front. Every flight's width, tread depth, and riser height or number of steps can be set; a door's landing can be deepened and its flight turned to run along the wall off either side of it (a stoop). Any flight can have railings (off by default): level round a stoop's landing, sloping down the flight's open sides with newels at the foot. Window wells are not done: a basement window below grade needs a hole in the ground this app's ground plane (and the game's terrain) don't have.

Requirements:
- Add non-functional plan extensions that share the footprint boundary.

### Phase 9 — Volume subdivision

#### Task 9: Multi-mass and winged footprints
Status: In progress

Requirements:
- Support attached volumes / wings as explicit groups of wall runs and roof zones.
- Preserve the single-building root while enabling mass subdivisions.
- Allow each volume its own story count and story height (e.g. a one-story
  lean-to attached to a two-story main block).
- Allow each volume's roof zone to be independently configured (type,
  direction, pitch) and joined to neighboring zones, including cases where a
  lower roof (lean-to/shed) tucks under a taller roof's eave, and cases where
  a lean-to's ridge merges into the main roof at a shared height.
- The current single roof-field surface (Task 5) remains the default when no
  independent volumes are defined.

Current slice:
- `decomposeIntoVolumes()` in `js/facade.js` automatically decomposes any
  rectilinear footprint into its minimal set of rectangular volumes (U=3,
  L=2, lean-to=2, wide-wing=2), each reporting its own `ridgeAxis` (long
  dimension) and bounds. Exposed as `layout.volumes`.
- A "Massing volumes" UI panel lists each volume with an editable story-count
  override. When any volume's story count diverges from the building
  default, `createMultiVolumeBuilding()` in `js/extrusion.js` takes over:
  each volume gets its own independent box walls, foundation, and analytic
  flat/gable/hip roof, elevated to that volume's own wall-top height, with
  the ridge automatically oriented along that volume's own long axis.
- When no overrides are set, gable/hip roofs on non-rectangular footprints
  now use `createVolumeRoofAssembly()`: each volume gets its own exact
  analytic roof (2 flat trapezoids + 2 flat triangles, matching the plain
  rectangle case, zero faceting), merged into one mesh at the shared
  wall-top height. This replaced the earlier grid-sampled height field for
  gable/hip (the sampled field remains as a fallback and is still used for
  flat roofs and footprints that don't decompose into volumes).
- Multi-volume hip roofs use the CGAL-backed `straight-skeleton` WebAssembly
  library in both modes. Its shared skeleton nodes and face polygons replace
  the earlier dense sampled field, reducing the U roof to 8 roof faces and 6
  connected ridge nodes. Pitch mode maps skeleton time through the selected
  pitch. Fixed-rise mode uses exact analytic per-volume roof planes, deriving
  each volume's pitch from its own half-span so all volume ridges reach the
  configured rise. For a spanning block with perpendicular attached volumes,
  shared ridge endpoints connect the roof graph and keep the rear hip end
  panels coplanar with the adjacent side outer roof panels; gable side ridges
  meet the full spanning ridge at high T-junctions.
- Gable orientation avoids parallel ridges across a shared volume boundary:
  the largest volume retains its longitudinal axis and smaller attached
  volumes rotate perpendicular when needed to avoid a flat valley.
- The Massing volumes panel provides a per-volume **Auto / X axis / Z axis**
  ridge-direction override. Explicit choices take precedence over automatic
  valley avoidance, including when a volume has an independent story count.
- Roof zone and massing editing use a selected-target workflow. The selected
  volume receives its own story count, roof form, and ridge direction without
  rendering a separate property panel for every volume.
- Volume and roof-zone ownership is currently one-to-one. The selected target
  is highlighted in the 3D and top views with a cyan translucent outline;
  independent roof-zone partitioning is deferred.
- Volumes can be selected directly in the 3D view. Hovering uses an amber mass
  and roof-perimeter cue; clicking synchronizes the selected-target controls.
- Roof-shell connections are implemented as one opt-in **Merge into adjacent
  roof** option per volume (see [Roof merge resolver](#roof-merge-resolver)).
  Every roof otherwise stays a closed standalone shell.
- Standalone shed shells: the high side receives a vertical return and each
  sloped end receives a triangular closure to the wall top.
- Pitch and roof rise can be set per volume; unset volumes follow the
  building default.
- The Roof zone panel exposes a **Multi-volume ridge** mode for these roofs:
  **Hold pitch constant** preserves the selected pitch and allows ridges to
  vary by volume width; **Hold roof rise constant** derives each volume's
  pitch so every ridge reaches the user-configured roof rise.
  Both modes preserve a genuinely peaked roof surface rather than adding a
  flat cap.

Remaining Task 9 work:
- Roof joins, edge roles, eaves, and shell closure are recorded under
  [Complex roof structures](#complex-roof-structures).
  That section supersedes the earlier note that a general skeleton solve was
  the whole follow-up. An unweighted skeleton already covers equal-height,
  equal-pitch hips.
- ~~Per-volume material assignment~~ done: a volume can have its own wall
  material (`volumeMaterials`), its walls then built on their own; a window's
  or door's frame left to default follows its volume's.

### Phase 10 — Envelope modifiers

#### Task 10: Porches, bay windows, associated enclosed spaces

Requirements:
- Add envelope modifiers that create or extend functional spatial volume.

## Execution principles

1. Keep each milestone small and visually testable.
2. Prefer plain objects and helper functions over class-heavy state.
3. Validate regularly in browser and in Node where geometric logic is isolated.
4. Treat `ARCHITECTURE.md` as the source of truth; any deviation becomes a documented architecture note.
5. Do not implement speculative abstraction beyond the active task.

## Deviation log

### Configurable winding support
This project intentionally differs from the strict CCW-only wording in the original architecture note, because the main Godot upstream expects something closer to clockwise input. The app therefore supports both winding directions and defaults to CCW for standard geometry workflows.

### Local static web app constraints
The current implementation uses a direct local static asset model rather than a framework build system. This is consistent with the project’s lightweight requirement and is the best fit for the user’s local-only workflow.

## Complex roof structures

A complex roof is still a set of independent caps. Each rectangular volume can take a flat, gable, hip, or shed roof. Those caps are not resolved into one roof. Shared valleys, mixed edge roles, different eave heights, and overhangs around a concave plan do not become a single surface.

The case that does resolve is narrow. An equal-height, equal-pitch hip over a simple rectilinear outline uses `createStraightSkeletonHipGeometry` and produces hips and valleys. Every other combination uses separate rectangular roofs, or a sampled distance field.

### What the current builders cover

- Rectangles use analytic flat, gable, hip, and shed meshes. A rectangular footprint ignores per-volume roof types and builds one roof from the building default.
- `decomposeIntoVolumes()` splits a rectilinear footprint into rectangles. The U preset is 3 volumes. The L, narrow lean-to, and wide wing presets are 2.
- Equal-height, equal-pitch hips with more than one volume call `createStraightSkeletonHipGeometry` after `SkeletonBuilder` initializes. The call passes one outer ring and one pitch.
- If that solver is missing, the same hip falls through to `createRoofFieldSurface`, a gridded distance field. The U preset is about 1,200 vertices on that path, and the UI does not report the fallback.
- Constant ridge height, any gable, or a mix of roof types uses `createVolumeRoofAssembly`.
- A story-count override uses `createMultiVolumeBuilding`. Each volume gets its own walls, foundation, and roof.
- Standalone sheds close the high side and the two sloped ends. Flat roofs are a thin slab.

### Deficiencies

#### The roof is not an editable structure

- `computeFacadeLayout()` always emits one zone, `roof-zone-main`, covering every wall run.
- Per-volume roof type and ridge direction live in sidebar state (`volumeRoofTypes`, `volumeRidgeDirections`) beside that zone. They are discarded with the page. There is no saved roof graph and no `.bld` record.
- A roof zone cannot differ from the automatic rectangle decomposition. Zones cannot be split, merged, or redrawn. A diagonal or non-orthogonal footprint is still forced onto that rectangle grid.
- Footprint edges have no role. Every skeleton edge is an eave. A gable rake, a hip, a valley, or a flush verge cannot be named on an edge.
- Rise and pitch are building-wide. Constant-height mode only derives a pitch from each volume's half-span so the ridges match. A 6:12 wing against a 4:12 main roof cannot be expressed. The skeleton is used unweighted.
- Courtyards are unsupported. `SkeletonBuilder.buildFromPolygon` accepts inner rings, and the composer never passes them.

#### Adjacent roofs do not cut each other

- In `createVolumeRoofAssembly`, each volume keeps a full rectangular prism. `buildConnectedConstantRiseRidges` moves ridge endpoints so a side ridge can meet a spanning ridge. It does not clip the planes. Valley faces are absent, and the roofs meet on a vertical seam along the shared wall.
- Different eave heights, from any story-count override, do not intersect. A one-story shed does not tuck under the main eave, and a lower ridge does not run into the taller slope. The weighted 3D intersection described in `ARCHITECTURE.md` is not implemented.
- **Snap to ridge** has no control. **Merge into adjacent roof plane** is a disabled dropdown. `volumeRoofConnections` is stored and never read by a mesh builder. A shed that shares an edge with another volume stays a standalone shell.

#### The surface stops at the wall plate

- Eave depth expands a rectangular outline only. Multi-volume roofs are built with overhang `0`. Hips and valleys do not continue past a re-entrant corner.
- Hip and gable geometry is the sloping top only. Fascia, soffit, and gable-end returns are not generated.
- Walls extrude to one horizontal plate, and the roof sits 2 cm above it. Gable triangles use the roof material. The top story stays a rectangle and is not clipped to a sloping upper edge.
- Mansard is named in `ARCHITECTURE.md` and is not built. Dormers, boolean cross-gables, crickets, and parapets sit outside the four implemented types.

### Next steps

The next roof work is a resolver, not another roof type.

1. **Tag footprint edges as eave or rake, and store one pitch per eave.** (Complete)
   - Footprint edges are classified as `eave`, `rake`, `high-plate`, or `flat` based on rectilinear volume ownership and ridge axis orientation.
   - Built `buildRoofGraph()` in `js/facade.js`, returning `zones`, `edges`, and summary metrics.
   - Associated wall runs with their parent roof zone and edge role.
   - Added native `.bld` persistence (`serializeBuildingState` and `deserializeBuildingState`), enabling saving and loading the complete building and roof configuration.
   - Added interactive Roof Graph & Edge Roles panel in UI.
2. At a shared wall-plate elevation, solve one weighted straight skeleton, or an equivalent plane arrangement, so equal-height hips, gables, and mixed pitches share valley and ridge vertices. Replace the silent dense-field fallback with a reported failure. (Partially complete — see below.)
3. Where plate elevations differ, trim plane against plane so a lower shed or gable can tuck under a taller slope, or snap its ridge to a chosen ridge. Drive this from the connection control already present in the sidebar.
4. Close every boundary that does not meet another roof face with fascia, a gable return, or a vertical closure. Offset the eave polygon before the solve so a concave plan carries a real overhang.
5. Cut wall tops and the top story to the resolved roof so gable ends are wall faces. Mansard, dormers, and other forms wait until this shell is closed.

### Roof merge resolver

Every roof zone is expressed as infinite "eave planes" (`computeVolumeEavePlanes`, `js/extrusion.js`): flat 1, shed 1, gable 2, hip 4. `resolveRoofConnections` uses `findVolumeAdjacencies()` (`js/facade.js`) and each volume's own pitch/rise (`volumeRoofParams`, driven by `volumeRoofShapes`) to decide, per volume side, how a roof joins its neighbor. Merging is **opt-in** (`volumeRoofConnections[id] === 'merge-plane'`, the sidebar's **Merge into adjacent roof**, offered on volumes with a shed high edge or a gable end touching a neighbor); the UI defaults to standalone. Behavior:

- **Shed, slope across the wall.** Keeps its own slope and runs on into the neighbor until it meets the neighbor's rising plane below the ridge (a valley-style join, nothing to close). If its plane would still be above the neighbor's plane at the ridge, it snaps to the ridge: the plane is rebuilt through the ridge point and the shed's own far eave, and its boundary (`extendTo`) moves to the ridge.
- **Shed, slope along the wall** (rake against the neighbor). Keeps its plane and adds a triangle to the valley (`rakeTriangle`); the whole plane is lowered (still planar) if it would exceed the ridge.
- **Gable end.** The ridge keeps its own height and ends where it meets the neighbor's plane; if it would exceed the neighbor's ridge the whole ridge is lowered to it, so both slopes stay single planes. The gable end face at a merged end is dropped.
- **Coplanar merge.** Where the neighbor is genuinely sloped along the whole wall (its gable end), corners clamp to the neighbor's plane and the closure is dropped.
- **Different story counts.** `volumePlateHeights` gives each volume's plate; a roof only interacts with a *taller* neighbor (`plateGap`), and only above that neighbor's eave. Below it, the roof is standalone against the wall. `createMultiVolumeBuilding` uses the same resolver.
- **Clipping.** Roof surface a merge carries past the shared wall below the neighbor's eave lies inside the neighbor's walls and z-fights with coplanar wall faces; `clipInsideNeighbor` removes it (Sutherland-Hodgman polygon clip).

Superseded approaches worth not repeating: recomputing only a height at the unmoved wall (leaves a hole once the closure is dropped, or a visible seam if it is kept); tilting a gable ridge toward the neighbor's ridge (bends each slope out of plane); automatic ridge-to-ridge nudging for gables (now opt-in).

Also in this slice: roof faces are flat-shaded (indexed builders shared vertices so normals smoothed across closure faces and shaded near-black); `clearModel` disposes nested groups; `.bld` files persist `volumeRoofConnections` and `volumeRoofShapes`.

Known limits: hip and flat roofs do not act as the merging (lower/joining) roof; a hip neighbor's boundary is always at its eave, so only ridge-directed joins apply against it; non-footprint attached elements (dormers and porches) are now roof structures, built on the resolved zone descriptors (see [Roof-borne structures](#roof-borne-structures-dormers-raised-porches--plan)); cupolas are built there (4d); widow's walks are a hip roof shape (see [Widow's walks as roof shape](#widows-walks-as-roof-shape)). Tests: `tests/roof_resolver.test.js`.

### Eaves (implemented)

`js/eaves.js` resolves per-volume eave/rake depth, fascia depth, and soffit styles (`volumeEaves` over building defaults; persisted in `.bld`), classifies each side as eave/rake/none per roof type, and builds fascia and soffit faces. The analytic roof builders continue the roof planes past the walls instead of enlarging a flat rectangle. Sidebar controls: eave depth, rake overhang, fascia depth, eave soffit and rake soffit styles, editing the selected volume or the building defaults. Tests: `tests/eaves.test.js` (including closure checks for every soffit style combination).

The exposed part of a partly shared eave side gets its own eave strip (top, fascia, soffit), and any eave strip that ends flush with a wall (zero rake overhang, a shared or merged side) gets an end cap unless a neighbor's wall already closes it. A roof that another *gable* merges into keeps its eave along the whole shared side; the merging gable's eave corner is inset onto the valley with the main roof's eave plane and its fascia/soffit start at the main eave line (`buildRoofSetups`/`eaveAbutments` in `js/extrusion.js`), so the two eaves meet as one continuous shell. Known limits: unequal slopes/depths between the two roofs meet at a small step; shed merges still zero the shared side; exposed strips that run into a corner do not yet join the perpendicular rake overhang, and only gable and shed eaves get strips (a hip that touches another volume loses its overhang entirely); hip overhang is all-or-nothing; the skeleton-hip and sampled-field fallbacks and flat roofs have no fascia/soffit trim (flat roofs overhang as a slab); eave/fascia are not yet part of merged-roof clipping.

## Roof-borne structures (dormers, raised porches) — plan

Status: Complete (phases 0–7, with 4a–4f). The porch arrangements (4–4b) are provisional and expected to be revisited with real cases. This covers structures that change the roof shell and have their own walls, but are not part of the footprint: gable, hip, shed, and flat dormers, wall dormers (a front wall that continues the main wall up through the eave), and second-story sleeping or smoking porches. Under ARCHITECTURE.md §5 they are **envelope modifiers**, because they add functional space. This work belongs to Task 10 and is also the "attached roof zone" noted under *Roof merge resolver → Known limits*.

### Core idea

A roof structure is a small rectangular **structure volume** with its own raised plate. Its walls, roof, and eaves reuse the existing per-volume machinery. It relates to the building through two operations on convex solids:

1. **Keep outside the host.** A host volume's solid is its wall box capped by its roof planes (`computeVolumeEavePlanes`). Min-of-planes is concave, so the solid is convex. The structure's walls, roof, and trim are built too large (walls reach down below the host roof, and the roof runs back past where it meets the host), then clipped to the part outside the host solid. That one clip produces the cheek-wall bottoms along the host slope, the valleys, the point where a gable ridge dies into the host plane, and a shed dormer's rear intersection line, for every roof type, with no special case per type. For a gable, the result matches `resolveGableEndMerge`/`gableMergeGeometry` (checked in the tests: the ridge ends at the same point).
2. **Cut the host.** The host's roof mesh and trim are clipped to the part outside the structure's solid (its wall box capped by its own roof planes, also convex). That opens a hole exactly where the structure stands. On a single host face, the hole outline is the wall rectangle clipped by the half-planes `dormerPlane_i(x,z) ≥ hostFace(x,z)`, which gives an exact convex polygon that tests can compare against.

Both operations use one primitive, **clip triangles outside a convex solid**: the difference of convex solids, split into pieces with Sutherland-Hodgman, one half-space per face. This generalizes the `clipPolygon`/`clipInsideNeighbor` code that already exists. A small tolerance puts coplanar faces inside the solid, so a porch's back wall against the main wall is dropped and does not z-fight.

Clipping works on the finished triangle soup, so it does not care how the host's roof mesh was built. The host's *solid*, however, comes from its resolved zone descriptor. The analytic per-volume builders produce exact ones. The straight-skeleton hip produces piecewise ones (`skeleton: true`, `roofPieces`, see [Porches on continuous hips](#porches-on-continuous-hips)), which host every kind of structure. The sampled field and a flat cap over a non-rectangular footprint produce none, so they host nothing (`host-missing`).

As built, the two clips are joined by a third: a structure is also kept outside every *other* volume and every structure built before it. A porch running into a taller block therefore merges with it, and structures can stand on each other.

### Data model

Structures are stored as a list in `modelConfig.roofStructures`, persisted in `.bld`, with a default of `[]`. Placement is in the host side's local frame, so the data does not depend on orientation, and a structure survives story-count and roof-type edits. `normalizeRoofStructure` fills each record from its kind's preset (`STRUCTURE_PRESETS`); the editor's presets (`STRUCTURE_UI_PRESETS` in `js/structure-ui.js`) are starting records built on those.

```js
{
  id: 'structure-1',
  kind: 'dormer' | 'wall-dormer' | 'recessed-porch' | 'porch' | 'cupola' | 'hood',  // a starting preset; geometry is uniform but for a hood's
  hostVolumeId: 'volume-0',       // the volume it sits in or on ...
  hostStructureId: null,          // ... or another structure it stands on (a sleeping porch on a ground porch)
  hostSide: 'minZ',               // the side it faces out of
  offset: 0,          // center along the side, from its midpoint (m)
  width: 2.4,
  setback: 0.9,       // front wall in from the host wall; 0 = flush; < 0 projects; 'center' = centered across the host
  depth: null,        // null = run back to the host ridge (the clip ends it)
  wallHeight: 1.4,    // plate above the sill
  baseHeight: null,   // null = rises out of the roof; a number = floor above the host plate; 'ground' = at the foundation top
  mount: 'join',      // 'join' a roof face (a dormer), rise 'through' the roof (a cupola), or 'recess' into the walls under it
  inset: 0,           // front wall set back behind an open porch under the roof (a recessed porch)
  openSides: [],      // walls left open: front, back, left, right
  support: 'auto',    // when projecting: deck | posts | porch | brackets | enclosed | none
  roofType: 'gable',  // flat | gable | hip | shed | none
  ridge: 'perpendicular' | 'parallel',  // a porch's or cupola's; a dormer's ridge always runs into the roof
  roofShape: null,    // { mode: 'slope', pitchRise } | { mode: 'height', height }; null = the building's pitch
  join: 'auto' | 'snap-ridge',  // a dormer's roof: lowered to the ridge only if it would pass it, or always meet it
  wrap: null,         // { end: 'left' | 'right', length }: a porch turning the corner (a wraparound)
  plan: null,         // { shape: 'canted', angle } | { shape: 'polygon', sides }: a canted bay or a polygonal tower
  eaves: {},          // volumeEaves fields, over the building's
  materials: {},      // { wall, roof }: palette keys, over the building's
}
```

`resolveRoofStructure` turns a record and its host's zone descriptor into a plan rectangle, sill and plate heights, the structure's own roof planes, `hostContact`/`removedRoof` (the host roof it replaces), and flags (`flush`, `projecting`, `standing`, `through`, and the resolved `support`). The result has the zone-descriptor shape, so it can serve as a solid and as another structure's host. The gable, hip, shed, and flat builders and the eave setup are reused unchanged.

**How the cases map to this model** (each has an example in `data/examples/`):

| Case | Parameters |
|---|---|
| Roof dormer (walls standing on the slope) | `setback > 0`, no base |
| Wall dormer (front wall carrying the main wall up through the eave) | `setback: 0`; the eave is cut and capped either side |
| Recessed porch | a dormer set up the roof with an `inset` |
| Ground porch | `setback < 0`, `baseHeight: 'ground'`, open sides; a deck under it |
| Upper porch | `setback < 0`, `baseHeight` a story below the plate, a support (posts, brackets, an enclosed base) |
| Sleeping porch | a flat-roofed ground porch, and an enclosed porch standing on it (`hostStructureId`) |
| Cupola, belvedere, rooftop pavilion | `mount: 'through'`, `setback: 'center'` |
| Widow's walk | not a structure: a hip roof's flat top (`roofWalkHeight`) |

### Validation (`resolveRoofStructure` / `validateRoofStructures`)

Each problem is an error with a code and a message, shown in the editor and the status line:

- The host: `host-missing` (no such volume or structure, no analytic roof, or a circular stack) and `host-inexact` (a merged roof that isn't a min of planes, such as a height-mode hip whose ridge ends were moved to meet a neighbor's).
- Dimensions and placement: `invalid-dimensions`, `outside-host`, `outside-face`, `depth-required`, and `needs-base` (projecting past the wall needs a base).
- Dormers only (joining one face, no base):
  - a dormer faces down a slope: on a side that isn't one (a gable end, after the ridge turned) it turns to the slope at the same end, a quarter turn round (`side-turned` warning). `side-not-sloped` remains for a side with no slope either way (a shed's high side and the rake beside it);
  - `crosses-face` (it must stay on one face: not across a hip, ridge, valley, or a mansard's break; on a skeleton hip, within the face's own region);
  - `above-ridge`;
  - a roof that would pass the ridge is lowered to it (`ridge-capped` warning), as a shed too steep to meet the host plane is.
- Porches (standing on a base) replace the host roof inside their footprint, may face any side, and span faces. Supports: `support-not-projecting` and `brackets-too-deep`.
- Through-mounted structures: `mount-conflict` (not with a base), `inset-not-supported`, and `not-level` (a roofless platform off a level roof, or nothing to fill).
- Recesses: `inset-too-deep`.
- Between structures: `overlap` (where they actually stand, on the same host).
- On load, a structure whose host is gone is dropped with a warning, along with anything standing on it.

### Phases

0. **Prep refactor (no behavior change).** Complete.
   - `createBuildingFromFootprint` now also returns `roofZones`: one resolved descriptor per volume, from `roofZoneDescriptor` in `js/extrusion.js`. It is produced by the single-rectangle path, `createVolumeRoofAssembly`, and `createMultiVolumeBuilding`.
   - A descriptor holds `{ volumeId, roofType, bounds (walls), roofBounds (a merged shed's extended rectangle), ridgeAxis, roofHighEdge, roofHeight, planes, slabThickness, overhang, eaves, exact, baseY }`.
   - Planes carry the *final* heights after merges: a merged gable's lowered ridge, and a snapped or intersecting shed's slope.
   - `exact: false` marks a hip whose ridge ends were moved to meet a neighbor's, and a shed corner clamped onto a neighbor's plane. Structures should not be hosted on these.
   - Roof meshes stay in their plate frame, and `baseY` records the offset.
   - The skeleton-hip, sampled-field, and non-rectangular flat paths return no zones. (The skeleton hip now returns approximate ones: see [Review fixes](#review-fixes).)
   - New `js/roof-structures.js` (no THREE dependency): `clipPolygon` (moved from `extrusion.js`), `clipOutsideConvexSolid`, `volumeSolid`, `isInsideSolid`, `FLAT_ROOF_THICKNESS`.
     - The clip cuts *exactly* on each face plane, so two solids clipped against each other share cut lines and close into one shell.
     - Its epsilon only decides that a piece lying *on* a face counts as inside. An earlier version grew the solid by epsilon instead, which left a hairline gap between mutually clipped solids.
   - `clipInsideNeighbor` now uses shared `geometryTriangles`/`trianglesToGeometry` helpers.
   - Tests in `tests/roof_structures.test.js`:
     - Clip area is exact.
     - Faces on the boundary are dropped.
     - Two boxes clipped against each other form a closed shell of the analytic area.
     - Each descriptor's planes match the rendered roof surface (rectangular gable, hip, shed, and flat; the U assembly; a merged shed; a lowered merged gable ridge; independent story counts).
     - `volumeSolid` membership.
   - Mesh helpers were extracted to `tests/helpers/mesh.js`.
1. **Data model, placement, validation, persistence.** Complete. Nothing is rendered yet.
   - The plane primitives moved to a THREE-free `js/roof-planes.js`. `extrusion.js` re-exports `computeVolumeEavePlanes` and `evalZoneHeight`.
   - `js/roof-structures.js` adds:
     - `STRUCTURE_PRESETS` (dormer, wall-dormer, porch).
     - `normalizeRoofStructure(s)`: preset defaults, and unique `structure-N` ids.
     - `createRoofStructure` and `structureFrame`.
     - `resolveRoofStructure(structure, hostZone, config)`, which returns the plan bounds, `sillY`/`plateY`, the structure's own roof planes (with the ridge cap applied), and `hostContact`. `hostContact` is the exact convex plan polygon where the structure stands in the host roof, which Phase 2 will cut out.
     - `validateRoofStructures(list, roofZones, config)`, which also rejects structures overlapping on the same host.
   - Error codes: `host-missing`, `host-inexact`, `invalid-dimensions`, `side-not-sloped`, `needs-base`, `outside-host`, `depth-required` (flat hosts), `outside-face`, `above-ridge`, `no-contact`, `crosses-face`, `overlap`. Warning codes: `ridge-capped`, and (since the review fixes) `side-turned`.
   - A resolved structure has the zone-descriptor shape, so `volumeSolid` accepts it.
   - Defaults:
     - Auto depth runs to the host ridge line, or to the high wall on a shed host.
     - Slope-mode pitch comes from the building default. A shed's pitch runs over its full depth.
     - Height mode is the ridge rise for a gable or hip, and the rise at the back for a shed.
   - `.bld` files store `roofStructures`. On load, a structure whose host volume is not in the footprint's decomposition is dropped, and the load status reports a warning.
   - `main.js` carries `modelConfig.roofStructures` and resets it wherever the per-volume overrides are reset.
   - Tests:
     - Records and ids.
     - The frame on all four sides.
     - A dormer's contact pentagon and ridge end, checked against hand-worked values (the ridge end matches the gable-merge rule).
     - Wall dormer, ridge cap and snap, a shed dormer meeting the host plane, and hip-end fit versus crossing the hip lines.
     - A flat host, a porch base, and every error code.
     - Overlap, and `.bld` round-trip, dropped hosts, and older files without structures.
   - Note: zone ids come from the `volumes` passed to `createBuildingFromFootprint`. Without them the single rectangle is `volume-main`. The app always passes them.
2. **Roof dormers (setback clears the host eave).** Complete.
   - `withRoofStructures` in `js/extrusion.js` runs after either build path (single-plate or independent story counts). It validates `config.roofStructures` against the resolved `roofZones`.
   - For each valid structure:
     - `structureWallPolygons` (in `js/roof-structures.js`) builds the walls from below the host roof up to the roof profile. `roofProfile` traces min-of-planes along each wall, so a gable end runs up to the ridge. A flat roof's walls run to the top of its slab.
     - `structureRoofTriangles` builds the roof with the existing gable, hip, shed, and flat builders at the structure's plate. The back side gets no overhang. A hip keeps its all-round overhang, because its faces are only planar with equal overhang and its back end drops to plate level, deep inside the host.
     - Roof faces the builders put in a wall plane (gable ends, shed side closures, slab edges) are dropped where the structure has a wall there, so walls carry the wall material. An open side keeps them.
     - A flat slab's underside is trimmed to its overhang.
     - Walls and roof are clipped outside the host solid, and every roof mesh is clipped outside the structure solid.
   - Meshes are tagged `userData.structureId` / `structurePart` (`walls` or `roof`), with no `roofType`, so host-roof lookups ignore them.
   - The result's `roofStructures` holds every validation result.
   - `main.js` passes `modelConfig.roofStructures` and reports structures that could not be built in the status line, including after a `.bld` load.
   - `polygonsToTriangles` now drops clipping slivers (twice-area ≤ 1e-6).
   - The test helper's point keys normalize `-0.000`.
   - Tests (`tests/roof_structure_geometry.test.js`), for each of gable, hip, shed, and flat dormers:
     - Host roof and dormer form one shell. Open edges are allowed only where either roof meets its own walls, or where dormer trim dips into the intact host roof outside the hole. The hole seam must be closed.
     - The plan area removed from the host roof equals the contact polygon's area.
     - Nothing is left below the host roof.
     - Also: the gable ridge end lands at the analytic valley point; gable ends are wall, not roof; open sides; several dormers on both slopes; invalid structures leave the roof untouched; a dormer on the two-story base of a mixed-story U.
   - A mutation check (disabling the host cut) fails both the shell and area tests.
3. **Wall dormers (flush front wall).** Complete.
   - A structure is `flush` when its setback is 0: its front wall stands on the host wall line.
   - With any positive setback, even one inside the eave depth, the front wall stands on the roof and the host eave runs on in front of it (an ordinary roof dormer).
   - For a flush structure:
     - `interruptHostEave` cuts the host roof and eave trim away across the structure's width, outside the wall line, with the same convex clip.
     - It then caps each cut end with the eave's cross-section, `hostEaveProfile`: roof edge, fascia, and a flat or sloped soffit, or a flat roof's slab edge. Caps are only added where the eave actually runs (`hostEaveCovers`, which includes partial strips).
     - The front wall is built unclipped from the host wall top (`wallTopY`, now on every zone descriptor; roofs sit `ROOF_LIFT` = 2 cm above their walls). This closes the gap the eave used to hide.
   - Deviation from the plan: this cut-and-cap approach replaces routing the span through `eaves.partial`. It works on gable, hip, shed, and flat hosts alike, whereas partial strips only exist for gable and shed eaves, and would have cost a hip its all-round overhang.
   - Hosts without zone descriptors (the sampled field) already reject every structure with `host-missing`. (The skeleton hip hosts dormers and cupolas since the review fixes.)
   - Tests (`tests/roof_structure_geometry.test.js`), on each of gable, hip, shed, and flat hosts:
     - One closed shell. On a flat host, the hole through the 8 cm slab opens into the dormer.
     - Removed plan area equals contact plus eave top and soffit across the width (the whole slab through on a flat host).
     - Each cap's area matches the hand-computed eave section.
   - Also tested:
     - The eave stays everywhere else.
     - The front wall reaches the wall top.
     - Sloped-soffit caps are a parallelogram.
     - A 0.1 m setback leaves the eave alone.
   - Mutation check: removing the caps fails the closure and cap tests on all four hosts.
   - The test helper now ignores edges that round to zero length.
4. **Porches (structures standing on a base).** Complete.
   - A structure with a `baseHeight` is `standing`. It replaces the host roof inside its footprint instead of rising out of one face. So it may sit on any side (including a gable end), may span several faces, and has no ridge cap.
   - Deviation from the plan: there is no `attachVolumeId`. Every structure is clipped outside *every* volume's solid, and every roof mesh is cut by the structure's solid. A porch on a wing that runs into the main block merges with its wall and roof automatically; for dormers the other solids are simply not touched.
   - `removedRoof`: the host roof a standing structure removes, as convex pieces, one per host face. Each piece is the face's own region (where that plane is lowest) where the structure's roof is above the face. For a dormer it is `[hostContact]`.
   - Walls (`standingWalls`):
     - They stand clear of the host roof.
     - Under the removed roof they run on down to the host wall top. A new exact-cut `clipInsideConvexSolid` and `planPrism` keep the part inside each piece, above the host body.
     - Standing walls start at the host wall top.
   - `kneeWalls`: along every edge of the removed roof that no closed structure wall covers, a vertical face runs from the host wall top up to the host roof. This happens where the structure's roof meets the host slope partway up, along open sides, and across the roof-lift gap. It closes the attic. Edges shared between pieces (a ridge) get none.
   - Floor: the deck at the sill, clipped only by the host body and other volumes. It is also the closed underside of a projecting porch.
   - Open sides get a header from the soffit to the plate under an overhang (`openEaveHeaders`). A rake side uses the deepest eave box it meets. A flat slab keeps its full underside when a side is open.
   - Host eave (`interruptsHostEave`):
     - A projecting structure breaks the eave when its roof at the wall line is at or above the host plate.
     - A lower one tucks under the eave, or its roof passes through the soffit, which its solid cut handles.
     - Caps go only where no side wall of the projecting structure already stands across the cut end.
     - `hostEaveProfile` now also gives a rake's cross-section: level at the roof height there, down to the sloped or flat rake soffit.
   - Tests (`tests/roof_structure_geometry.test.js`):
     - A new, stricter watertightness check over every mesh (walls and foundation too) via `uncoveredEdges` in the test helpers: every open edge must lie on another, non-coplanar surface. The only exceptions are each roof's designed `ROOF_LIFT` at its own walls and a structure's open sides.
     - Porch cases: a projecting second-floor porch through the eave (floor only outside the host, no caps, eave gone in front); tucked under the eave (host roof untouched); open (no walls outside the host, header area, caps); on the lean-to's one-story wing running into the two-story main block (nothing inside either volume, main roof cut); a porch spanning the host ridge (two pieces, no wall across the ridge); a knee wall's area; a porch on a flat roof.
   - Mutation checks: removing knee walls fails the watertight and knee tests; removing headers fails the header test.
   - The test helper `meshTriangles` now reads indexed geometry.
   *Review of the first examples (2026-09-26).* Dormers (roof, wall, hip-roof, attic) are right. The porch examples were not realistic: a projecting porch with nothing under it; a porch on a wing that left slivers of the wing roof and climbed into the main roof like a dormer; a porch straddling a ridge; a rooftop porch flush with the wall. Those examples were withdrawn. The two sleeping/smoking porch arrangements to model are **over a ground-level porch** and **recessed into the roof**. The common rooftop structure is a **cupola/belvedere**. Phases 4a–4d cover this; the Phase 4 machinery (standing structures, removed roof, knee walls, headers, floors) is the base for all of them.

4a. **Supports.** Complete. `support` on a structure: `auto` (default), `none`, `deck`, `posts`, `porch`, `brackets`, `enclosed`.
   - `auto` resolves to `none` unless the structure projects past its host wall; a projecting structure at ground level gets `deck`, a raised one `posts`.
   - Any other value on a non-projecting structure is refused (`support-not-projecting`). Brackets carry at most `MAX_BRACKET_PROJECTION` (1.5 m; `brackets-too-deep`).
   - `structureSupports` in `js/extrusion.js`, over the projecting part only:
     - `deck`: a foundation-material box from grade to the floor.
     - `posts`: 0.2 m posts from grade to the floor along the front, at the ends and at most 3 m apart (`MAX_POST_SPAN`), flush with the outer faces.
     - `porch`: the same posts on a ground-level deck.
     - `brackets`: triangular braces under the floor, back to the wall, 45°, at most 1.8 m apart.
     - `enclosed`: wall-material skirts on the front and both sides from the foundation top to the floor, over a foundation box.
   - `openSidePosts`: any structure with open sides gets posts from floor to plate along them, at the ends and at most 3 m apart. None at an end against one of its own closed walls, or against the host or another volume (the roof bears on that wall).
   - Posts and brackets use the wall material and are tagged `structurePart: 'posts'`; skirts are `support`, decks and foundations `foundation`.
   - `baseHeight: 'ground'` puts the floor at the host's foundation top. Zone descriptors now carry `foundationTopY`.

4b. **Ground porches and stacking.** Complete.
   - A ground porch is a projecting structure with `baseHeight: 'ground'`. Its roof tucks under the eave or butts the wall, which Phase 4 already handles.
   - Stacking: `hostStructureId` stands a structure on another; `hostVolumeId` is then unused.
     - `validateRoofStructures` resolves hosts first, whatever the list order. It refuses a missing or circular host (`host-missing`) and gives each structure a `level`. It returns each result with the `host` descriptor it was resolved against.
     - A resolved structure becomes a host through `structureAsHost`: the zone-descriptor shape with its plate as both roof base and wall top, its solid starting at its floor (`floorY`), and overhang and eave settings supplied by the builder (`describeStructure`).
   - `withRoofStructures` builds structures lowest level first, clips each outside every volume and every structure already built (except its host), and adds each built structure's roof to the meshes later structures cut. A standing floor lying exactly on its host's wall top is kept: it is the lower space's ceiling. A flush structure only breaks its host's eave where the host has a wall under it; a host structure open on that side (a ground porch under a sleeping porch) keeps its roof edge as a continuous band and beam at the floor line (`openBoundsSides` on the host descriptor).
   - `.bld` loading keeps a structure whose host structure survives, and drops a chain whose base is gone.
   - Tests:
     - posts (count, extent, flush);
     - `auto` resolving to posts or deck (deck size, floor at the foundation);
     - brackets (placement, too-deep refusal);
     - enclosed skirts and foundation;
     - the `porch` support;
     - `support-not-projecting`;
     - open-corner posts (none against the wall);
     - the stacked sleeping porch: level, floor = ground porch ceiling, ground roof replaced under it, roof under the main eave, back wall absent, watertight;
     - hosts resolved in either list order; missing and circular hosts;
     - `.bld` round-trip for stacked structures.
   - Mutation checks: dropping the floor-on-wall-top fix fails the stacking test; removing open-side posts fails the posts test.
   - Examples: `ground-porch`, `sleeping-porch`, `porch-supports`.

   *Review of the 4a/4b demo (2026-09-26).* Better, but porches are hard to develop further without actual buildings to model against. The porch arrangements, supports, and stacking are provisional, to be revisited with real cases.

4c. **Recessed porches.** Complete, in the covered form (a porch under a dormer roof). The open-to-the-sky notch, which needs a subtractive path, is deferred.
   - `inset` on any structure sets its front wall back by that depth. The front becomes an open side (a gable keeps its gable face over it, and a shed or hip front gets a header), and the structure's roof carries on over the recess. `innerLine` is the set-back wall's position.
   - The `recessed-porch` preset is a dormer set 1.2 m up the roof, so a strip of roof and the eave run on intact below it (the usual form), with a 1.5 m inset, 3.6 m wide, and 2.2 m walls. Its floor is level with the roof where the roof meets its front edge. A flush recess (setback 0) breaks the eave like a wall dormer.
   - `structureRecess` gives the recess's plan rectangle, its floor at the sill, and the inner wall from the sill up to the roof profile. `recessParts` in `js/extrusion.js` builds:
     - the floor and the inner wall;
     - for a dormer, the side walls run on down to the floor inside the recess (the host roof there is already cut away with the dormer's footprint);
     - for a flush recess, a strip under the floor edge that closes the roof-lift gap a front wall would have covered.
   - Validation (`inset-too-deep`): the inset must leave the inner wall inside the structure. For a dormer, the recess's back corners must lie within `hostContact`, so the porch never runs back under the remaining host roof.
   - Open-side posts are now for standing structures only; a dormer's open front spans between its own side walls.
   - Tests:
     - watertight;
     - floor area and level;
     - inner wall from the floor to the ridge;
     - side walls down to the floor, and no front wall;
     - eave caps, gable face, and lift strip;
     - the roof strip and eave left whole below a set-back recess;
     - a shed recess header;
     - a flush recess (breaks the eave; lift strip);
     - too-deep refusals;
     - inset normalization and the preset.
   - Mutation checks: removing the recess side walls fails the watertight tests; removing the lift strip fails the lift-strip check (it lies in the open front's plane, which the watertight check allows).
   - Example: `recessed-porch` (a gable-roofed recess on the front and a shed-roofed one on the back, both set up the roof).
   - Not modeled: a railing, or a knee wall/curb across the open front raising it above the roof. These come with facade modifiers, or a front knee-wall height if real cases call for one.

4d. **Cupolas and belvederes.** Complete.
   - `mount: 'through'` makes a structure rise through the roof without joining it; `'join'` (the default) is a dormer's. A through structure:
     - skips the single-face rule and the ridge cap;
     - measures its wall height from the highest point of the host roof under it (`highestHostRoof`: the roof is linear on each face's region, so the highest point is a corner of one of those pieces);
     - has walls that stop at the host roof as a dormer's do;
     - keeps its roof overhang on every side (no buried back);
     - leaves the host roof whole: an enclosed one hides the roof inside it, and an open one stands on it.
   - `setback: 'center'` centers a structure across its host (on the ridge); it needs an explicit depth.
   - The `cupola` preset is 1.6 m square, with 1.2 m walls, a hip (pyramid) roof, `mount: 'through'`, and `setback: 'center'`.
   - Open sides of a through structure get posts from the roof surface to the plate (and headers), so an open pavilion on a flat roof, or an open cupola, stands on the roof.
   - Validation:
     - `mount-conflict`: a through structure cannot also have a base height;
     - `inset-not-supported`;
     - `outside-host`: it must stand within the host walls;
     - `depth-required`: a centered or through structure needs a depth.
   - Tests:
     - centered on the ridge, sill at the ridge, plate one wall height above;
     - walls down to the slopes and nothing below the roof;
     - host roof untouched, overhang all round;
     - on a hip ridge and on a flat roof (belvedere);
     - an open pavilion on posts standing on the deck;
     - an open cupola's posts on the slopes;
     - all watertight;
     - the refusals, and normalization of `mount` and the centered setback.
   - Mutation checks: posts from the sill instead of the roof fail the open-cupola test; cutting the host roof fails four tests.
   - Examples: `cupola` (gable ridge), `belvedere` (low hip roof), and `rooftop-pavilion` (flat roof, open).

4e. **Mansard and gambrel roofs.** Complete. Two new volume roof types. Decisions (2026-09-26): straight slopes first (curved/bell-cast later if real cases need them); the mansard's upper tier defaults to a low hip (flat with an upper pitch of 0); gambrel included.
   - Both are two-slope roofs (`TWO_SLOPE_ROOF_TYPES` in `js/roof-planes.js`). On each sloped side a steep lower plane rises to the break, `breakHeight` above the plate, and a shallow upper plane carries on above it. The roof is their min. Lower planes come first, so the plane found for a side (a dormer's host face) is its lower slope.
     - A mansard slopes on all four sides.
     - A gambrel slopes on its two eave sides and has gable ends.
   - Parameters:
     - `breakHeight` (default 2.4 m) and `lowerPitchRise` (mansard 30:12, gambrel 20:12).
     - `upperPitchRise` (mansard 4:12, gambrel 6:12).
     - Set per volume in `volumeRoofShapes`, over the building's `roofBreakHeight`, `roofLowerPitchRise`, and `roofUpperPitchRise` (persisted in `.bld`, passed through from `main.js`), over the type's defaults.
     - The peak comes from the planes (`roofPeak`, the highest corner of the per-plane pieces).
   - `createTwoSlopeRoofGeometry` in `js/extrusion.js`:
     - faces from `minOfPlanesFaces`, the general min-of-planes face builder (identical planes tie-break to the first);
     - end faces on unsloped sides;
     - `twoSlopeTrim`: cornice boxes at the plate (top, fascia, flat soffit), mitred between eaves, running on under a rake, and capped where they end against nothing; gambrel rakes carry the roof past the gable wall, with a fascia and a soffit one fascia depth below the broken profile.
   - Multi-volume footprints: each volume gets its own two-slope roof. A side that other volumes' walls cover along its whole length (and rise past this plate) is left unsloped. Its end face is clipped outside those neighbors' solids (`neighborSolidsForEnds`, from `volumePlaneConfig`, which the merge resolver now also uses). A partly covered side keeps sloping.
   - Merges skip two-slope roofs. Partial eave strips are for gable and shed eaves only.
   - Known limit: on an L the blocks are separate mansards, and a block with an unsloped side rises to it (the L's smaller block ends in a tall end face). A continuous mansard around an L or U needs the straight-skeleton approach, with each skeleton face split at the break. That is later work.
   - Dormers on a mansard's or gambrel's lower slope must stay below the break; the single-face rule refuses one reaching past it (`crosses-face`). A flush wall dormer breaks the cornice with a box cap (`hostEaveProfile`).
   - Edge roles: mansard sides are eaves, gambrel sides like gable. The roof type menu has Mansard and Gambrel; their parameter controls come with Phase 6.
   - Tests (`tests/two_slope_roofs.test.js`):
     - plane heights at eave, break, and ridge;
     - surface matches planes;
     - watertight: mansard, flat-topped mansard, gambrel, U mansard, L gambrel, a mansard beside a gable wing;
     - cornice level with the plate and fascia length;
     - per-volume overrides;
     - gambrel rakes following the profile;
     - a dormer below the break, and one refused past it;
     - the wall dormer's box cap;
     - edge roles and `.bld` persistence.
   - Mutation check: removing the trim fails four tests.
   - Examples: `second-empire` (with dormers below the curb) and `gambrel`.
4f. **Widow's walks.** Complete, then revised: see [Widow's walks as roof shape](#widows-walks-as-roof-shape), which replaces the structure described here. As first built, a widow's walk sat on a flat roof top; its railing, when present, is a facade element (Phase 5).
   - A hip roof may be cut flat at `deckHeight` (per volume in `volumeRoofShapes`, or the building's `roofDeckHeight`). This adds a level deck plane (`tier: 'deck'`). The decked hip is built face by face with its usual hip trim; a deck above the pitch's natural peak is ignored.
   - `roofType: 'none'` gives a structure no roof. A through-mounted roofless structure is a platform: a thin deck (`DECK_THICKNESS`) on the roof, no roof, headers, or posts. Its wall height is kept as the railing height for Phase 5.
   - `fill: true` sizes and places a structure over the host roof's largest level region (a flat roof, a hip's deck, a flat-topped mansard), less `fillMargin`.
   - The `widows-walk` preset is through-mounted, roofless, open on all sides, filling with a 0.3 m margin, and a 1 m railing height.
   - Validation: `not-level` for a roofless platform that is not wholly on a level part of the roof, or a `fill` with nothing level to fill.
   - Tests:
     - a decked hip's height, flat-top area, surface, and closure;
     - per-volume deck, and a deck above the peak ignored;
     - the preset;
     - fill on a decked hip, a flat-topped mansard, and a flat roof;
     - a hand-sized walk, one running onto the slopes, and plain hip and gable refused;
     - the roof left whole.
   - Mutation check: disabling the level rule fails the test.
   - Example: `widows-walk`.

   New examples as each lands:
   - a ground porch with posts;
   - the stacked sleeping porch;
   - a recessed porch;
   - a cupola on a gable roof, a belvedere on a flat or hip roof;
   - supports: posts, brackets, an enclosed base.

5. **Facade surfaces.** Complete.
   - Structure walls are clipped to what shows, so their facade surfaces come from the build. `structureFacade` in `js/roof-structures.js` runs for each built structure; `createBuildingFromFootprint` returns the results as `structureFacades`. `withStructureFacades` in `js/facade.js` adds them to the layout beside the footprint's own runs: `structureWallRuns`, `structureStories`, and `railRuns`. The footprint's `wallRuns` are untouched, since they define the footprint a `.bld` saves. `main.js` merges them into the active layout, and the facade summary counts them.
   - Wall runs: `wall-run-<id>-<wall>` for each wall with a visible surface:
     - `front`, `left`, `right`, `back` (left and right as seen from outside);
     - `inner`, a recess's set-back wall;
     - `base-<wall>`, an enclosed base's walls.

     Each has `structureId`, `hostVolumeId`, `side`, `start`/`end` (plan, left to right as seen from outside), `normal`, `length`, `storyId`, and `baseY`. Its visible shape is `pieces`: the clipped triangles in wall-local (u, v), u across from the left and v up from the floor, with their `extent` and `area`. Windows go within the pieces.

     A buried back wall has no run. Knee walls are interior and get none. The builder now keeps each wall's pieces by name, and the recess and enclosed-base helpers return theirs by name too.
   - Stories: `story-<id>-1` from the floor to the plate (deck plus railing for a roofless platform), and `story-<id>-base` under an enclosed base.
   - Railing runs: `rail-run-<id>-<wall>` along each open side at floor level (`start`/`end` in 3D, `height`). They are clipped to the stretches clear of the host's body and other volumes (`segmentOutside`), so a porch's side railing stops at the house wall. The height is the structure's wall height for a roofless platform (a widow's walk: four runs around its deck), otherwise `RAILING_HEIGHT` (1 m) or less.
   - Materials: a structure's `materials.wall` and `materials.roof` (palette keys) now apply over the building's. Precedence documented in ARCHITECTURE.md: facade panel, wall run, roof structure, volume, story, building.
   - Tests (`tests/structure_facades.test.js`), with hand-computed values:
     - a dormer's front and cheek areas and extents;
     - left-to-right orientation;
     - a wall dormer's front reaching the wall top;
     - a recess's inner run and front railing;
     - an open ground porch's railings stopping at the wall, including one whose rectangle runs into the house;
     - an enclosed base's runs and story;
     - a widow's walk's four railings;
     - a cupola's walls following the ridge;
     - the layout keeping footprint runs;
     - structure materials.
   - Mutation checks: flipping u, or unclipping railings, fails the tests.
   - Windows, doors, trim, and railing geometry themselves are Tasks 6–7; these are the surfaces they target.
6. **UI and picking.** Complete.
   - A **Roof structures** panel:
     - **Add**: presets from `STRUCTURE_UI_PRESETS` in the new `js/structure-ui.js`: gable, shed, and hip dormers, wall dormer, recessed porch, ground porch, upper porch on posts, porch on this roof, sleeping porch on the selected porch, cupola, and widow's walk. Each goes on the selected volume (or the first), facing the chosen side; the sleeping porch goes on the selected porch.
     - **List**: the building's structures, each with its error or warning inline in red.
     - **Editor** for the selected structure, showing only the fields that apply: facing; joins or rises through (not for porches); fill and margin; offset, width, centered or setback, auto or fixed depth; wall or railing height; base (roof, ground, or a height); inset; roof type (including none); ridge; pitch (empty for the building's); ridge join; support (when projecting); open sides; wall and roof materials; and Delete, which also deletes anything standing on it.
     - Lengths are in the display units. Edits normalize the records and rebuild.
   - Picking: structures are picked on their own meshes, whichever of a volume or structure is nearest under the pointer. The hover cue (amber) and selection cue (cyan) are editor-only boxes around the structure's meshes, and show in the top view too. The selected-element label names the selected structure (`structureLabel`). Clicking a volume returns to editing it.
   - Roof settings: the Volume Configuration panel shows a mansard's or gambrel's break height and lower and upper pitches (hiding the single pitch and rise), and a hip's flat deck height. These edit the selected volume or the building defaults, with the type's defaults as fallbacks (`TWO_SLOPE_DEFAULTS`, now exported). A volume's shape settings are merged on edit, not replaced, so a break height survives a pitch change.
   - Export and save: GLB export includes structure meshes and leaves out the cues (all editor-only); `.bld` saves the structures.
   - Tests: `tests/structure_ui.test.js` checks that every preset builds without errors on a two-story house (the cupola on a gable, the widow's walk on a decked hip), that an upper porch stands one story down on posts, that the sleeping porch takes the whole selected porch, that ids are unique, and the labels.
   - Checked in the browser:
     - adding, editing, and deleting structures;
     - inline refusal messages;
     - hover and click picking of structures and volumes;
     - the mansard and deck fields;
     - saving stacked porches;
     - a GLB with 27 meshes and no cue lines.
7. **Docs.** Complete. Each phase updated the docs as it landed: ARCHITECTURE.md (§2 roof structures and two-slope roofs, §3 data model, §4 structure surfaces, §5 modifier examples, material precedence, and selected-element editing), the README features and project tree, `data/examples/README.md`, and this plan. A final pass brought the plan's status summary, data model, cases table, validation list, and next steps up to date.

### Porches on continuous hips

The review fixes let dormers and cupolas stand on a straight-skeleton hip but refused porches, which replace the roof over their footprint and so need the host's exact solid. That is now built:

- Each skeleton zone lists its roof exactly as convex plan pieces, each under one face's plane (`roofPieces`: every skeleton face and walk piece clipped to the volume, triangulated where not convex).
- `zoneSolids(zone)` (`js/roof-structures.js`) gives one prism per piece, capped by its plane, or the single `volumeSolid` for a min-of-planes zone. Structures are clipped outside every solid of the host and the other volumes, and inside them for the parts under the host roof, as before with one solid each.
- The roof a standing structure removes is each host piece (a face region for a min of planes, a `roofPieces` entry otherwise) where the structure's roof is above it. `zoneRoofHeight` gives the host roof height for knee walls.
- The dormer face-region check applies to dormers only; porches may span faces, hips, and valleys.
- Tests (`tests/skeleton_structures.test.js`): a ground porch and a porch on posts against the L, a porch standing on the plate astride the valley (the roof removed on each face under it), and a gable porch with an open front, each watertight but for its open sides. Mutation checks: using the single approximate solid, or min-of-planes pieces, fails the valley test.
- Still refused: height-mode hips over several volumes, whose ridge ends are moved to meet a neighbor's (`host-inexact`).

### Widow's walks as roof shape

A widow's walk is a flat section of roof in place of the ridge, not a platform standing on the roof. A deck on it and its railings are facade modifiers. This replaces the 4f model (a hip "deck" plus a `widows-walk` structure on it):

- The hip's `deckHeight`/`roofDeckHeight` became `walkHeight` (per volume in `volumeRoofShapes`) and `roofWalkHeight`, with the plane `tier: 'walk'`. Older files load with the old names renamed. The panel shows "Widow's walk height" and the size of the walk it makes.
- A continuous (straight-skeleton) hip over an L or U is now cut too: each skeleton face is clipped at the walk height and the parts above become the flat top, one walk of the footprint's shape inset by the height over the pitch (`createStraightSkeletonHipGeometry`). It uses the building's walk height, or failing that the lowest a volume sets. Its zone descriptors get the walk plane, so dormers and cupolas stand on it as on any hip.
- `roofWalks` in the build result and layout (`roofWalkFacade`): each walk's `id` (`roof-walk-<volume>`, or `roof-walk-main` on a continuous hip), `volumeIds`, elevation `y`, flat top in plan (`pieces`), and railing runs (`rail-run-<walk>-<n>`) along each edge where the roof slopes away, at `RAILING_HEIGHT`, clipped clear of structures standing on it (a belvedere). The walk's railing runs join `railRuns`.
- Removed: the `widows-walk` structure kind and preset, `fill`/`fillMargin` (only the walk used them), `roofType: 'none'` platforms, `DECK_THICKNESS`, the `deck` structure part, and the `not-level` error. A saved `widows-walk` structure is dropped on load with a warning.
- Tests: the walk surface and its four railing runs on a rectangle, railings broken by a belvedere, no walk on a plain hip or above the peak, loading an older file, and the L-shaped walk on a continuous hip (area, railing length, roof flat top, a cupola on it).
- Examples: `widows-walk` (now just the roof) and `widows-walk-l`. The example generator loads the skeleton library, as the app does.

### Review fixes

A review after phase 7 found and fixed:

- **Structures on a straight-skeleton hip.** A multi-volume equal-pitch hip is one skeleton roof, which used to return no zone descriptors, so nothing could stand on an L or U hip. `skeletonHipZones` (`js/extrusion.js`) now describes each volume by the planes of its sides on the footprint outline, each face's region in plan (`faceRegions`, from the skeleton polygon rising from that edge), and the skeleton faces themselves. Inside a volume the roof is not the min of those planes near an inner side or a valley, so the descriptors are `exact: false, skeleton: true`. A dormer must stand within its face's region (`crosses-face` otherwise), and a cupola takes its sill from the skeleton faces under it. Porches and fills are refused (`host-inexact`), since they replace the roof over their footprint. (Since lifted: see [Porches on continuous hips](#porches-on-continuous-hips).) The skeleton roof has no eave trim, so a structure there cuts no eave. Tests load the browser build of the skeleton library with `self`/`window` shims (`tests/skeleton_structures.test.js`).
- **Dormers follow their slope.** A dormer's centerline is always square to the host ridge. When the ridge turns, a dormer on what is now a gable end faces the slope at the same end (minZ ↔ minX, maxZ ↔ maxX), keeping its offset along the wall, with a `side-turned` warning. The record keeps its side, so turning the ridge back restores it. A dormer's `ridge` is ignored (always perpendicular), and the editor shows the Ridge option only for porches and structures rising through the roof.
- **GLB export.** The invisible volume pick targets are marked `editorOnly`, so the export leaves them out.
- **Roof merges.** "Merge into adjacent roof" is offered only when the neighbor it would merge into is not a mansard or gambrel (the resolver skips those merges).
- **Selection.** Selecting a structure selects the volume it stands on (through any structures it is stacked on) in the Volume Configuration panel, and the heading names that volume. Choosing another element there clears the structure selection.
- **Assumption: footprints are fixed.** Structures refer to volumes by id (`volume-0`, ...), which come from the footprint's decomposition. Editing the footprint can renumber volumes and orphan or move structures. For now footprints are treated as fixed once structures are placed.

### Risks and decisions

- **Clipping precision.** Coplanar and near-coplanar faces (a flush wall dormer front, a porch back wall) depend on the tolerance rule. Closure tests at each phase are the guard. T-junctions from clipping are acceptable, as they already are for partial eave strips.
- **Descriptor accuracy.** The host solid must use the *final* planes after merges (for example, a gable ridge lowered by a merge). Getting this wrong is the most likely source of seams, which is why phase 0 comes first.
- **Out of scope for now:**
  - Structures straddling two volumes or a valley.
  - Dormers on dormers.
  - The open-to-the-sky recessed notch cut into the roof: the subtractive counterpart, the same primitive run in reverse. (The covered form, a recess under a dormer roof, is built: 4c.)
  - Eyebrow and curved dormers.
  - Windows and railings themselves, which belong to Tasks 6–7 and only need the surfaces from phase 5.
  - A continuous mansard around an L or U footprint (4e builds per-volume two-slope roofs).

## Real-world evaluation, round 1

Nine house types common in Dixon, Illinois (`data/real-world/`, report with renders published separately) were modeled to test the system before facade modifiers. Three bugs were fixed on the spot: wall material and widow's walk surfaces lost on buildings whose volumes differ in story count, and a ground porch's deck z-fighting its floor. The gaps, worked through in this order:

1. **Volumes follow the massing.** Done. `decomposeIntoVolumes(footprint, { split })` cuts in Z bands (`'z'`, the old behavior and the default for files without the setting), X bands (`'x'`), or automatically (`'auto'`: the fewest volumes, then the largest smallest dimension, a tie keeping Z). New projects use `'auto'`; `volumeSplit` is saved. The app's **Volumes** control switches it and clears per-volume settings, since ids are renumbered. The upright-and-wing and Queen Anne now model facing +Z.
2. **Porches that turn a corner.** Done. A projecting porch whose end is at its wall's end can `wrap: { end: 'left'|'right', length }`. `expandWraps` makes it two rectangular segments: the porch, running on past the corner by its projection, and `<id>-wrap` along the adjacent wall. Where they meet, and along the front segment's back, are `seamSides`: no wall, post, header, or railing. `joinWrapRoofs` gives both one hip roof: the planes rising from every outer eave and none from the walls, so it is hipped at the corner and the far ends and runs level into the walls; each segment builds it face by face (`wrapRoofTriangles`) with fascia and soffit on its outer eaves. Both halves build or neither (`wrap-incomplete`). Errors: `wrap-not-at-corner`, `wrap-depth` (the depth must equal the projection), `wrap-roof` (hip or shed), `wrap-not-porch`. The editor has "Wraps around the corner" and a length; the "Wraparound porch" preset runs the whole wall. Picking either segment selects the porch. Tests: `tests/wraparound_porches.test.js`.
3. **Porches recessed into the house.** Done. `mount: 'recess'` on a structure standing on a base, with no setback and an explicit depth (`resolveRecess`): an integral porch, recessed entry, or upper-story loggia inside its host, under the host roof. `buildRecess` cuts the host's walls and facade panels (tagged `bodyPart`) away inside its box, carried a little past the wall so the panels go too, and adds its back and closed side walls (facade wall runs), a ceiling, a floor above the ground, posts at open corners, and a header down to the eave soffit where the ceiling is above it. The host roof and eave are untouched. A floor height is measured from the host's wall top. Errors: `recess-needs-base`, `recess-placement`, `recess-too-tall`, `recess-too-low`, `recess-not-outside` (it opens into another volume), `outside-host`. The editor's "Recessed into the house" check and the "Integral porch" preset. Tests: `tests/recessed_porches.test.js`. The bungalow and ranch evaluation houses use it. Reviewed with close-ups: the geometry is representative. Possible refinements, not yet confirmed as needed: the main roof carried down over the porch to a low eave at the porch beam; a porch deck a step or two below the house floor, with steps; framing at the opening (beam, columns, piers).
4. **Story-and-a-half.** Done. A half story's knee wall (`kneeWallHeight` for the building, `volumeKneeWalls` by volume, 0 for none on a volume) raises the walls above the full stories before the roof starts: `volumeWallHeight(volumeId, config)` in `js/extrusion.js` is the one place wall height comes from (stories times story height, plus the knee wall), and a volume whose wall height differs from the building's gets its own roof. The facade layout adds the half story (`half: true`) over the full ones. Saved in `.bld`. The panel has a building field and one per volume. Tests: `tests/half_story.test.js`. The upright-and-wing's wing, the bungalow, and the Cape Cod are now a story and a half.
Review of the round-1 renders added these, done before item 5:

- B. Done. A hip porch projecting from a wall is a hipped shed: planes from its front and ends only (`eaveRoof`, shared with the wraparound's roof and built by `eaveRoofTriangles`), level along the wall. One standing on a roof, with nothing behind it, keeps its full hip.
- D. Done. A side shared only with lower neighbors (`below` links in `adjacentSidesByVolume`) keeps its eave; the roof is then clipped outside those neighbors' solids, so it is cut only where their roofs pass through it.
- C. Done. With no choice saved, a gable's end merges into its neighbor (`resolveRoofConnections`); 'standalone' still opts out, and sheds still merge only on request. The roof a gable merges into keeps its eave along the side, clipped where it passes into the merging roof (`mergingNeighbors`). A merged gable's eave abuts the neighbor's eave line only when the two plates are level. The panel shows the default without saving it.
- A. Done. A projecting porch breaks (notches and caps) the host eave only when its walls rise past the host's wall top; where just its roof rises through the eave, the porch's solid cuts the host eave where the porch roof is above it, and the roofs meet in valleys.
- Tests: `tests/porch_roofs.test.js`, `tests/neighbor_roofs.test.js`. The report page's renders and statuses were refreshed.

A second review of the renders added:

- A porch end standing against a wall (`againstWall`: just outside it is inside a volume) is no eave: the roof runs level into it rather than hipping down onto it (a wraparound running back to a projection, a porch in an inside corner). `settleEaveRoofs` applies this to hipped porches, `joinWrapRoofs` to wraparounds.
- Wraparounds take a shed roof too (planes from the front and outer side only, hipped at the outer corner, plain far ends closed from the plate up, with the eave capped at them). The Queen Anne's is a shed.
- `above-eave` warning: a projecting porch whose roof rises through the host eave. Builders usually keep it below; the Cape Cod and Dutch Colonial entries now tuck under their eaves.

5. **Per-volume story height and floor level.** Done, with item 10. A volume can set its own story height (`volumeStoryHeights`, used by `volumeWallHeight`) and its own floor above grade (`volumeFoundationHeights`; `volumeFoundationHeight`), and the building's foundation (`foundationDepth`) is a setting (it was fixed at 0.7 m in the app). Volumes get their own roofs when their *plates* differ; volumes level at the plate share one roof even over different floors (a garage at grade with taller walls under the ranch's continuous hip), each with its own walls and foundation. Plates compared between volumes (merges, eaves over lower neighbors) are heights above grade. Saved in `.bld`; panel fields for the building and the selected volume. Tests: `tests/volume_levels.test.js`.
   - Found on the way: a gable merging into a neighbor whose plate is a little higher was cut level at the neighbor's plate beyond the wall, leaving its valleys inside the neighbor's attic; it is now cut along the neighbor's roof slope (`clipInsideNeighbor`). This predated the change but only showed once gables merged by default.
6. **Eaves on continuous hips.** Done. The skeleton is solved on the footprint pushed out to the eave line (`offsetRectilinear`), so every face carries on past the walls at the pitch; heights are shifted so the roof meets the walls at the plate. A fascia runs round the eave line and a soffit ring back to the walls (`skeletonEaveTrim`, flat or sloped). Zones report the eave: a full overhang on an outside side, partial strips (`eaves.partial`) along a side that is outside only in part, so a structure on an inside stretch doesn't break an eave that isn't there. Tests: `tests/skeleton_structures.test.js`.
   - Found on the way: the skeleton library works in single precision (20.2 comes back as 20.2000008); `snapSkeleton` puts each node back on the exact values a rectilinear skeleton can take. And a plan polygon with a repeated point made `planPrism` emit a degenerate side, which silently dropped a porch's wall below the host roof; zero-length edges are now skipped.
7. **Dormers crossing a two-slope break.** Done. On a mansard or gambrel a dormer may run up its side's lower slope and on past the break into the upper slope: the roof it replaces is one piece per host face under its roof (`piecesUnder`), all of which must be its own side's (lower or upper); any piece on another side is still `crosses-face` (a hip corner). The Dutch Colonial has its full shed dormer. Tests in `tests/two_slope_roofs.test.js`.
8. **Canted bays and towers.** Done. A structure standing on a base or rising through the roof can have a `plan`: `{ shape: 'canted', angle }` (a bay whose sides run back to the wall at the angle; an oriel on an upper story) or `{ shape: 'polygon', sides }` (a regular polygon inscribed in its rectangle: an octagonal, or with many sides a round, tower or cupola). `resolvePlanned` gives its `outline` and a hip roof of planes rising from its outer edges (a bay's front and sides; every edge of a tower, a pyramid or cone), or a flat one; roof planes may now rise in any direction (`dir` planes, `makeEdgePlane`), and `volumeSolid` bounds a structure by its outline. `plannedParts` builds walls on each edge (a wall run per facet), the roof face by face with its eave trim, a floor, and a foundation at ground level; its solid cuts the host eave along its outline (no notch). A tower may stand on the corner, past the end of its wall. Errors: `plan-needs-base`, `plan-roof`, `plan-canted`. Editor "Plan" field; presets for a canted bay, an octagonal corner tower, and a round turret. Tests: `tests/planned_structures.test.js`. The Italianate's side bay is canted; the Queen Anne has an octagonal corner tower.
9. **Entry hoods.** Done. Kind `hood`: a projecting structure whose wall height is how high its roof sits above the floor. It is its roof alone, with a ceiling under it and brackets from its plate down the wall (always `support: 'brackets'`, so at most `MAX_BRACKET_PROJECTION` deep): no floor, posts, walls, or railings. `hood-placement` when it doesn't project. "Entry hood" preset. Tests in `tests/porch_roofs.test.js`; the Dutch Colonial's entry is a hood.
10. **Foundation height as a setting.** Done with item 5.
11. **Refusals that say what fits.** Done. When a structure is refused for crossing a hip or valley, rising above the ridge, or running past its face or wall, `resolveRoofStructure` retries it narrower about its center (5 cm steps) and failing that with lower walls, and adds the first that fits to the error (`fix: { width }` or `{ wallHeight }`) and its message ("It fits at 1.70 m wide (0.70 m narrower)."). Tests in `tests/roof_structures.test.js`.

## Footprints from the Dixon project, and angled walls

Real buildings come from the Dixon Godot project (dixon_dem): its building editor (B) exports the selected building with X to `exports/composer/<id>.json` (`format: 'dixon-footprint'`: the traced outline in game meters, ground height, and the editor's fields). Load footprint imports it (`js/import.js`): the outline is turned square to the building's main axes, walls within 5 degrees of them (or within 15 cm of square on a short wall) are squared, wall lines traced within 30 cm of each other are made one (an OSM trace is no more accurate), tracing jogs under 15 cm are dropped, and walls further off square are kept as angled walls. Storeys, roof, and material fill the settings; the placement (id, rotation, center, ground) is saved in the `.bld` for the trip back to the game (not built yet).

Angled walls (a clipped street corner, a wedge-shaped lot, a church apse), stage 1, done:

- Massing (`js/angled-walls.js`): the footprint is squared out to its rectilinear hull (each run of angled walls replaced by the corner outside it) and cut into volumes as before; each volume keeps the angled walls crossing it (`cuts`) and its real plan (`outline`). A footprint whose hull corner reaches past another part of the building is refused, saying so (`angledWallProblem`).
- Roofs (`js/cut-roofs.js`): a cut volume's roof is the min of its rectangle's planes (less those of sides cut away entirely) and one facet per angled wall that takes an eave: every angled wall on a hip or mansard; one nearer the ridge on a gable or gambrel (a clipped corner); one on a shed's low side. Otherwise the roof runs on to the wall, which rises to meet it (a skewed gable end). Eave trim runs round the overhang, edge by edge. Continuous hips over several volumes use the straight skeleton, now for angled walls too (general offsets, face planes, and heights); where the library fails on a symmetric outline, each volume gets its own hip. A roof cut by angled walls doesn't merge with its neighbors; its walls and eaves are clipped outside them.
- Walls and facades: per-volume walls follow the outline; an angled wall run belongs to the volume it cuts, with the role its roof gives it.
- A cut volume's outline is broken where a neighbor's wall begins, so the stretch of a partly shared side that is outside gets its eave.
- Volume split 'auto': when only one cut leaves the largest block whole with a shallow projection along its side (at most 3 m, and a quarter of its length, deep), that cut wins over the no-slivers rule. A long house with a shallow front projection is one long gable, not two crossing ones; the nine round-1 houses are unchanged. Near-square blocks can still come out as crossing gables: their ridge direction is the thing to set.
- Found on the way: `roofProfile` dropped a bend where two pairs of planes cross at the same point (both copies looked collinear with each other), which left gaps in gambrel trim.
- Tests: `tests/angled_walls.test.js`, `tests/import.test.js`. Of the 707 OSM footprints in dixon_dem, 699 import (39 with angled walls); all build, and all but one close up (a near-round 9-sided building leaves a 1 mm sliver).

Still to do, when a real building needs it:

- Stage 2: roof structures (porches, bays, dormers, hoods) on angled walls. They are placed by rectangle side (`hostSide`) today.
- Wings turned at an angle to the main block (a church transept, the Dixon church 440071966): the wing is one volume cut by angled walls, so its roof runs along the main block's axes. It needs volumes with their own axes.
- The trip back to the game: write the composed building out in game space from its `placement`.
- Found while testing (predates this work): a gable over three stacked bands (building 1393801286 squared off) leaves gaps at its rake ends.

## Wraparound porches on more than one corner

A wraparound (`wrap: { walls, startLength, endLength }`) runs along two to four walls of its volume, each beside the next; with all four it runs all the way round. `expandWraps` makes one leg per wall: a leg turning a corner runs on past it by the projection (`wrapExtend`), the next starts at the corner. The two end legs' lengths are measured from their corners; the legs between run their whole walls. All legs share one depth and one roof: every leg takes every leg's front plane, and only its own end hips (`joinWrapRoofs`). The editor ticks the walls (only one unbroken run can be ticked) and has a slider for each end leg. Files with the one-corner form (`{ end, length }`) load as two walls, the porch's width as the first leg. Tests: `tests/wraparound_porches.test.js`.

## Immediate next implementation step

- Facade modifiers (Tasks 6–7): windows, doors, trim, and railings, placed on the footprint's wall runs and on roof structures' wall runs (within their visible pieces) and railing runs.
- Revisit porches with real buildings to model against.
- Found 2026-09-28, not fixed: a single-rectangle hip takes its height from the run along its ridge direction (`roofHeightFromPitch`), so for one of the two directions it is the longer side's and one pair of slopes is steeper than the pitch (a 12 x 9 m hip at 6/12 is 3.0 m high, not 2.25 m). A height below the natural one (a .bld with no `roofHeight`) makes the other pair shallower, and the walls show through at the eave.
- Porch posts, adjustable (asked for 2026-09-28; not designed yet): a spacing slider, like an array modifier (closer spacing, more posts), and a post style, with posts always at the porch's corners. Posts are placed by `spacedPositions` at `MAX_POST_SPAN` today.
- Deferred until needed: a continuous mansard around L/U footprints (straight skeleton split at the break); the open-to-the-sky recessed notch; curved mansard slopes.
- Remaining resolver work: hip and flat roofs as the merging roof, and cutting wall tops to the roof.
