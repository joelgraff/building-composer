# Building Composer — Architecture Plan

## 1. Purpose

A parametric reconstruction tool that, given a 2D building footprint (primarily
supplied from an existing Godot model with OSM-derived geometry), assembles a
3D model with reasonable aesthetic proximity to the real structure by
reproducing significant architectural features.

**Aesthetic target.** The output targets immediate recognition by a user who
knows the real building. Visual fidelity is bounded by the project's existing
game aesthetic (poly budget, material style); the tool does not aim for
photorealism or exact material reproduction. The goal is that no visible
discontinuity causes the user to think "I can see what it is, but it looks
weird."

**Secondary use:** freeform footprint definition when no OSM data exists.

## 2. Core Engine

**Parametric extrusion.** The primary model is derived from a single 2D
footprint polygon:

```
Footprint (2D polygon)
  → Foundation (extruded down, optional above-grade projection)
  → Walls (extruded up, one or more story heights)
  → Roof (capped, type-dependent geometry)
  → Facade (the surface of the extrusion, subdivided)
```

Every structural and semi-structural feature is anchored to a defined envelope
surface. Detached objects (appurtenances) and separate structures
(substructures) are scene-graph children, not part of the primary envelope.

## 3. Data Model

| Layer | What it defines | Key parameters |
| ------- | ----------------- | ---------------- |
| Footprint | 2D polygon (supplied by main model) | Vertices, area, perimeter segments |
| Foundation | Base below/at grade | Depth, above-grade height, material |
| Walls | Vertical extrusion | Story count, per-story height, wall thickness |
| Roof | Top cap | Type (gable, hip, flat, mansard…), pitch, overhang/eave depth |
| Facade | Subdivided surface of the envelope | See §4 |
| Substructure * | Associated separate footprint (shed, garage, gazebo) | Parent reference, relative transform, own extrusion params |
| Appurtenance * | Detached object in the building's immediate vicinity | Type, relative placement (face + offset + distance), scale, mesh reference |

\* Post-MVP (bonus features).

**Centroid.** The composer computes its own internal centroid from the supplied
footprint geometry. The main model's centroid (used for OSM placement and world
transforms) is not used by the composer's subdivision or addressing logic.

**Units.** Geometry is stored and computed internally in meters. The UI defaults
to imperial display and input units labeled `feet`, with a selectable metric
mode labeled `meters`. Area, perimeter, coordinates, facade lengths, story
height, roof rise, and eave depth are converted at the UI boundary; exported
geometry remains meter-based.

**Footprint coordinate alignment.** Footprint coordinates are in the X/Z plane
with positive Z preserved through wall, foundation, roof, and guide geometry.
Facade subdivision lines must use the same transformed wall-run endpoints as
the envelope; a mirrored Z transform creates false projected geometry on
asymmetric footprints.

**Winding policy.** The default composer behavior is CCW for standard geometry
conventions, but the app supports CW input as well. This is required because the
upstream Godot model is expected to prefer clockwise polygon winding in some
scenes. The selected winding is treated as a validation parameter, not a hidden
assumption.

**Eaves.** Overhang is a per-side property of each volume's roof (`js/eaves.js`).
An *eave* is a side where the slope meets the wall (gable long sides, every hip
side, a shed's low side); a *rake* is a side across a gable ridge or a shed's
sloped side. Eave depth, rake overhang, fascia depth (default six inches), and
the eave/rake soffit styles are building-wide defaults that any volume can
override (`volumeEaves`). The roof slope continues past the wall at its own
pitch, so eave edges sit below the plate; gable end faces stay at the wall plane
and only the slopes run out past them. A vertical fascia hangs below every outer
roof edge. Soffits are *flat* (horizontal, at the bottom of the fascia; the
default for eaves) or *sloped* (roof plane shifted down by the fascia depth; the
default for rakes). Where a flat eave soffit meets a sloped rake soffit the
corner is boxed: the rake fascia deepens over the eave strip and a step face
closes the height change. Sides that touch another volume, and merged sides,
get no overhang; a hip overhangs equally on all sides (or not at all) so its
faces stay planar. Overhang never changes the wall or foundation footprint.

**Roof variant support.** Gable, hip, pitch, and ridge direction controls apply
to every footprint. Rectangular footprints use a direct analytic roof mesh.
Non-rectangular rectilinear footprints use exact analytic roofs for their
decomposed rectangular volumes. Eave projection beyond the footprint remains
rectangular-footprint-only.

**Independent roof zones.** A rectilinear footprint is automatically
decomposed into its minimal set of rectangular volumes (`decomposeIntoVolumes`
in `js/facade.js`), each with its own longitudinal ridge axis. For a
multi-volume hip roof, the roof is resolved as one continuous surface across
the footprint, allowing side ridges to project into the spanning roof rather
than stopping at internal walls. The **Multi-volume ridge** control selects
the roof behavior from either the selected pitch or the configured overall roof
rise. Constant-pitch roofs use the CGAL-backed `straight-skeleton` WebAssembly
library: skeleton vertices become shared ridge/valley nodes and skeleton polygons
become reduced planar roof faces. Constant-rise roofs use one analytic hip roof
per volume, deriving each volume's pitch from its own half-span so every ridge
reaches the configured height. Where a spanning volume has perpendicular
attached side volumes, the spanning ridge extends to their centerlines and the
side ridges extend back to the shared ridge endpoints. Hip rear end panels are
coplanar with the matching side outer roof panels; gable side ridges form high
T-junctions on the full spanning ridge line. When a volume is given an
independent story count, it is built with its own walls, foundation, and roof at
its own elevation (supports a one-story lean-to under a two-story main block).

**Gable orientation.** The primary volume keeps its longitudinal gable ridge.
If a smaller attached volume would otherwise place a parallel ridge beside it
across a shared boundary, its ridge is rotated perpendicular to the primary
ridge. This avoids a flat valley and directs the attached roof into the spanning
roof line. Each volume exposes an **Auto / X axis / Z axis** ridge-direction
control through its selected Roof zone. Auto applies the valley-avoidance rule;
an explicit axis takes precedence for both equal-height and independent-story
roof assemblies.

**Selected-element editing.** Roof and massing properties are edited through a
single selected target rather than repeated panels. The **Selected element**
picker selects Building defaults or a volume's massing/roof-zone pair. A
selected volume exposes its own story count in **Massing volumes** and its own
roof form, ridge direction, pitch, and roof rise in **Roof zone** (a volume
without its own pitch/rise follows the building default; eave depth remains a
building-level control). The selected volume is shown in the 3D and top
views with a subtle translucent cyan tint and a cyan roof-perimeter outline;
the volume's internal box edges are intentionally omitted to avoid visual
clutter. Massing volumes and roof zones are currently a deliberate one-to-one
pair; separate roof-zone partitioning is deferred. Volumes are also direct
manipulation targets in the 3D view: hovering highlights the volume and its
roof perimeter in amber, while clicking makes it the selected cyan target and
synchronizes the property controls.

**Roof shell connections.** Every roof must form a closed shell: boundaries
that do not connect to another roof face receive fascia, gable-end, or vertical
return faces. A volume can opt in (per-volume **Roof connection: Merge into
adjacent roof**; the default is a standalone shell, which is always valid) to
join a neighbor. Each roof zone is modelled as infinite eave planes (flat 1,
shed 1, gable 2, hip 4) so neighbors can be intersected analytically:

- A **shed** whose slope crosses the shared wall keeps its own slope and runs
  on into the neighbor until it meets the neighbor's rising roof plane; if it
  would project above the neighbor's ridge it snaps to the ridge (its plane is
  rebuilt through the ridge and its own far eave). A shed whose slope runs
  *along* the wall adds a triangle of roof to the valley, lowering the whole
  plane if it would exceed the ridge.
- A **gable** joins at a gable end: its ridge keeps its own height and ends
  where it meets the neighbor's plane; if it would exceed the neighbor's ridge
  the whole ridge is lowered to it. Ridges stay level so every roof face
  remains a single plane.
- A merged edge has no closing face, since the roof continues into the
  neighbor. Surface a merge carries past the shared wall below the neighbor's
  eave is clipped away.
- Across different story counts (different wall-plate elevations) a roof only
  interacts with a taller neighbor, and only above that neighbor's eave; below
  it the roof butts the wall as a standalone roof.

**Standalone shed shell.** Shed roofs emit a sloped roof plane, vertical
high-side return, and triangular end closures down to the supporting wall top.
A shed is the half-gable special case: one of a gable's two slopes.

The skeleton path applies when equal-height multi-volume hip roofs are rendered.
Independent story-height overrides still use separate roofs because their
different eave elevations require a weighted 3D intersection solve.

**Concave facade rendering.** Facade-panel metadata and subdivision guides may
be generated for any valid footprint, but solid material overlay panels are
currently restricted to rectangular footprints. Concave overlay surfaces will
be introduced with explicit wall-run/roof-zone geometry rather than allowing
panels to become unintended building mass.

Until that exact surface mapping exists, the editor also suppresses the
ground-level footprint preview and dashed facade guides for non-rectangular
presets. This keeps the rendered result limited to the selected footprint
geometry instead of showing projected helper lines that could be mistaken for
building faces.

**Roof pitch.** Pitch is represented as an integer rise:run ratio, normalized
to a 12-unit run in the UI (for example, `6:12`). Degrees are derived for
reference only. For the current rectangular roof builder, rise is derived from
the perpendicular half-span using `roofRise = (pitchRise / pitchRun) * run`.
The UI permits editing either pitch ratio or geometric roof rise; the most
recently edited value drives the other. Manual pitch edits use integer rise
steps; manual roof-rise edits preserve decimal precision and may display a
fractional rise:run ratio.

## 4. Facade Subdivision

The facade is the **addressable surface** where all non-structural features are
placed. It is subdivided in two axes:

- **Vertical → Stories.** Horizontal planes at user-specified heights. Each
  story is a band around the perimeter.
- **Horizontal → Wall runs, facade panels, volumes, and roof zones.**
  - **Wall run** — the continuous straight wall segment between two footprint
    corners or explicit break points.
  - **Facade panel** — an optional subdivision within a wall run for surface
    features such as windows, doors, trim, or local material changes. Equal
    spacing is the current preview default; panels do not imply structural
    discontinuities.
  - **Volume** — a major massing division such as a main block, ell, wing, or
    tower. A volume may contain multiple wall runs.
  - **Roof zone** — a set of wall runs governed by one roof form or direction.
    Roof zones represent gables, hips, and lean-to additions; they are not
    inferred from facade-panel numbering.

This hierarchy (Volume → Roof zones → Wall runs → Facade panels → Stories)
supports addressing such as *"the second story on the east wall run of the
main volume."*

**MVP addressing** is `story + wallRun`, with optional `facadePanel` detail.
Volumes and roof zones are explicit metadata rather than inferred from
perimeter order.

**Concave / complex footprints.** A wall run is a surface unit and does not
imply a roof boundary. A single roof zone may span multiple wall runs, and a
wall run may be split between roof zones only by explicit metadata. Facade
panels correlate with modifiers, not roof geometry.

**Roof–facade interaction.** A gable or hip roof changes the top boundary of
the facade (the wall no longer ends at a horizontal line). The top story
subdivision at a gable or hip must accommodate a non-horizontal upper edge.

## 5. Modifier Taxonomy

All non-structural additions are **modifiers** applied to a specific region of
the building. Three categories, distinguished by a two-step test:

| Category | Test | Examples |
|----------|------|----------|
| Facade modifier | Surface-applied; no functional space | Windows, doors, dentil courses, water table, window casings, cornices, gutters, eave depth, widow's walks |
| Footprint modifier | Extends the plan; no functional space | Exterior steps, basement window wells, freestanding stoops, open porches |
| Envelope modifier | Creates/extends functional space (regardless of enclosure) | Attached porches, bay windows, towers (Queen Anne), enclosed verandas |

**The test:**
1. Does it share a boundary with the footprint polygon?
   - No → Appurtenance (not a modifier; see §3).
   - Yes → continue.
2. Does it contribute to the functional space of the building?
   - Yes → Envelope modifier.
   - No + extends plan → Footprint modifier.
   - No + surface-applied → Facade modifier.

**Note on gray areas.** A covered-but-open porch (loggia, carport) is an
envelope modifier if it constitutes a functional space; a roofed-but-
non-functional awning is a facade modifier. Enclosure is not the determining
factor; functional contribution is.

**Queen Anne towers.** If the tower is in the footprint → it is a volume
(`shape: tower`). If it is not in the footprint → it is an envelope modifier.
No special category is needed.

## 6. Materials & Textures

Each facade panel, wall run, story, volume, and roof zone can be assigned a material. Standard material set
for v1:

- Brick
- Wood (clapboard, shingle, siding)
- Stucco / plaster
- Metal (standing seam, corrugated)
- Stone (for foundations, quoins)

Each material is a **shader + texture** pair. Textures are UV-mapped to the bay
surface. The facade subdivision is what makes per-region material assignment
possible without breaking the envelope geometry.

**Material precedence.** A facade-panel assignment overrides a wall-run,
volume, or story assignment when both target the same surface region. If no
panel assignment exists, the most specific applicable structural assignment is
used, followed by the story assignment and facade-wide default.

**PBR forward note.** The output targets GLB/GLTF, which uses PBR (albedo,
normal, roughness, metallic). The v1 material model should map to these
channels to avoid rework when the export pipeline is finalized.

## 7. Input Pipeline

| Source | Method | Priority |
|--------|--------|----------|
| Existing Godot model | Read footprint polygon from scene | Primary |
| Floor plan image | Manual trace / digitize | Useful |
| Drawn from scratch | 2D polygon editor in-app | Bonus |

**Contract with upstream.** The main model is responsible for:
- Supplying a clean, closed 2D polygon with no self-intersections.
- Performing any coordinate transformation (OSM WGS 84 → local units).
- The composer operates in its own local coordinate space, independent of the
  main model's coordinate system.

OSM data quality (gaps, overlaps, self-intersections) is a design concern of
the main model, not this project.

## 8. Output

A 3D model suitable for:

- Visual inspection / walkthrough
- Integration into the existing Godot scene (OSM-derived environments)
- Export for rendering or game engines

**Formats:** GLB/GLTF for interchange; native scene format (`.bld` or
equivalent) for in-app persistence.

## 9. Entity Classification

| Entity | Relationship to building | Test |
|--------|--------------------------|------|
| Facade modifier | Applied to envelope surface | Surface-applied; no functional space |
| Footprint modifier | Extends the plan | Shares boundary; no functional space |
| Envelope modifier | Creates/extends functional space | Shares boundary; functional space |
| Substructure | Separate footprint, parent-linked | Own closed polygon; associated |
| Appurtenance | Detached, co-located, no structural interaction | No shared boundary with footprint |

Five entity types, each with a single clear test for classification.

## 10. Suggested Task Order (MVP)

| # | Task | Milestone |
|---|------|-----------|
| 1 | Footprint input (from Godot scene) + validation | |
| 2 | Extrusion engine → foundation, walls, roof (flat) | |
| 3 | Facade subdivision (stories + wall runs, optional panels) | |
| 4 | Material assignment per wall run/story, optional panel override | |
| 5 | Gable + hip roof types | **First recognizable building** |
| 6 | Facade modifiers: windows, doors (parametric) | |
| 7 | Facade modifiers: cornices, water table, dentils | |
| 8 | Footprint modifiers: steps, window wells | |
| 9 | Volume subdivision (multi-mass buildings) | |
| 10 | Envelope modifiers: attached porches, bay windows | |

Each step produces a visible, testable result. Steps 1–5 give a recognizable
building from an OSM footprint with the right massing and materials.

**Post-MVP (bonus):**
- Substructure support (scene-graph children with own extrusion)
- Appurtenance placement (flagpoles, fences, gardens, mailboxes)
- Freeform footprint drawing
- Floor plan image tracing

---

*Terminology (bays, volumes, massing, envelope, appurtenance) follows standard
architectural and real-estate usage.*   