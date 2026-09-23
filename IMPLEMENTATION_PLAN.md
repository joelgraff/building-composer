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
- Local app shell, JSON file input, orbit controls, GLB export

### In progress
- Task 4: per-wall-run and per-story material assignment (visible panel controls complete)

### Deferred to later milestones
- Task 5: gable/hip roof types
- Task 6–10: modifiers and volume logic

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
- Planned roof-shell connections distinguish deterministic **Snap to ridge**
  from optional **Merge into roof plane**. Snap explicitly controls the joined
  ridge's slope and height and supports orthogonal or parallel gables. Merge
  applies only to shed and gable roofs, projecting beyond the parent-volume
  boundary to intersect an adjacent roof plane. Both modes must either form a
  valid connection or close the roof with fascia, end, or vertical return faces.
- Standalone shed shells are implemented: the high side receives a vertical
  return and each sloped end receives a triangular closure to the wall top.
  Shed-to-roof-plane merge and ridge snap remain planned connection modes.
- The Roof zone panel exposes a **Multi-volume ridge** mode for these roofs:
  **Hold pitch constant** preserves the selected pitch and allows ridges to
  vary by volume width; **Hold roof rise constant** derives each volume's
  pitch so every ridge reaches the user-configured roof rise.
  Both modes preserve a genuinely peaked roof surface rather than adding a
  flat cap.

Remaining Task 9 work:
- Per-volume roof plane mitering where two volumes share the same wall-top
  elevation (currently each volume's roof is independently flat/exact but
  meets its neighbor at a visible seam along the shared wall rather than a
  blended valley). This requires a general straight-skeleton solve
  (simultaneous/cascading edge-collapse events); evaluated and deferred as a
  larger follow-up rather than risking a partially-correct implementation.
- A mitered lean-to/main-roof intersection. Constant ridge-height mode aligns
  ridge elevations across differing widths, but it does not yet create the
  required trimmed valley faces.
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

## Immediate next implementation step

Add user-defined volume and roof-zone assignments so different parts of a
concave or attached footprint can select independent roof configurations.
Facade panels remain an optional surface-detail layer.
