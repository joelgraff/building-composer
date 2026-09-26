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
- Task 4: material assignment. Palette and story/panel selectors exist; solid finish panels render on rectangular footprints only.
- Task 5: flat, gable, hip, and shed roofs. Rectangular analytic meshes and one equal-pitch hip skeleton path work. Complex joins do not. See [Complex roof structures](#complex-roof-structures).
- Task 9: automatic rectilinear volume decomposition and per-volume story, roof type, and ridge controls. Caps stay independent.

### Not started
- Tasks 6–8 and 10: windows, doors, trim, steps, porches, and other modifiers.

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

Requirements:
- Place windows and doors on facade panels using story + wall-run addressing.
- Keep all modifiers relative to the wall envelope.

### Phase 7 — Ornament and trim

#### Task 7: Cornices, water tables, dentils

Requirements:
- Add trim features as surface modifiers on the facade envelope.

### Phase 8 — Footprint modifiers

#### Task 8: Steps, window wells, stoops

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
- Per-volume material assignment (currently shares the building-wide wall
  material).

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

Known limits: hip and flat roofs do not act as the merging (lower/joining) roof; a hip neighbor's boundary is always at its eave, so only ridge-directed joins apply against it; non-footprint attached elements (dormers, porch roofs, widow's walks) are not designed yet — the eave-plane/zone model is expected to extend to an "attached" roof zone. Tests: `tests/roof_resolver.test.js`.

### Eaves (implemented)

`js/eaves.js` resolves per-volume eave/rake depth, fascia depth, and soffit styles (`volumeEaves` over building defaults; persisted in `.bld`), classifies each side as eave/rake/none per roof type, and builds fascia and soffit faces. The analytic roof builders continue the roof planes past the walls instead of enlarging a flat rectangle. Sidebar controls: eave depth, rake overhang, fascia depth, eave soffit and rake soffit styles, editing the selected volume or the building defaults. Tests: `tests/eaves.test.js` (including closure checks for every soffit style combination).

The exposed part of a partly shared eave side gets its own eave strip (top, fascia, soffit), and any eave strip that ends flush with a wall (zero rake overhang, a shared or merged side) gets an end cap unless a neighbor's wall already closes it. Known limits: exposed strips that run into a corner do not yet join the perpendicular rake overhang, and only gable and shed eaves get strips (a hip that touches another volume loses its overhang entirely); hip overhang is all-or-nothing; the skeleton-hip and sampled-field fallbacks and flat roofs have no fascia/soffit trim (flat roofs overhang as a slab); eave/fascia are not yet part of merged-roof clipping.

## Immediate next implementation step

Steps 3–5 of the resolver above (trimming plane against plane at differing elevations is done for shed/gable; hip and wall cut-to-roof remain).
