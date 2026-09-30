# Building Composer

A lightweight standalone HTML/JavaScript app for parametric 3D building massing from a 2D footprint polygon.

## Run Locally

Install local dependencies once:

```bash
npm install
```

Start a local static web server from the project root:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Open `http://localhost:8000` (or the URL shown by your server) in a web browser.

## Run Tests

Building Composer includes unit tests for geometric validation, volume decomposition, extrusion, roof forms, and project serialization using Node.js's built-in test runner:

```bash
npm test
```

## Features

- **Footprint Input & Validation**:
  - Accept 2D polygon footprints in the XZ plane.
  - Automated validation for polygon closure, self-intersections, and configurable winding direction (counter-clockwise default, clockwise supported for Godot compatibility).
  - Real-time summary metrics: area, perimeter, centroid, and bounding box with dual-unit display (Imperial feet or Metric meters).
  - Preset footprints included (Rectangle, U shape, L shape, Narrow rear lean-to, Wider attached wing).

- **Parametric 3D Massing Engine**:
  - Extrudes foundation below grade, vertical walls per story, and roof envelope.
  - Story-and-a-half houses: a knee wall above the full stories, for the building or a volume.
  - Story height and floor level (foundation height) for the building or a volume; volumes level at the plate share one roof even over different floors.
  - Rectilinear volume decomposition (`decomposeIntoVolumes`): automatically splits complex rectilinear footprints into constituent massing blocks, cutting the way that follows the massing (or along a chosen axis).
  - Independent volume editing: configure story counts, roof forms, and ridge directions per volume or at the building-default level.
  - Interactive 3D volume picking: hover over building volumes for amber highlighting and click to select for direct parametric control.

- **Roof System & Variants**:
  - Roof forms supported: **Flat**, **Gable**, **Hip**, **Shed**, **Mansard**, and **Gambrel**.
  - Mansard and gambrel roofs: a steep lower slope to a break (curb) and a shallow or flat upper slope, with a horizontal cornice at the eaves; a gambrel has gable ends with rakes following its broken profile. Break height and both pitches are building defaults any volume can override (the Roof section of the building or a mass).
  - A hip roof can have a widow's walk: cut flat at a height above the plate in place of its ridge. On an L or U the continuous hip is cut flat as one walk. The flat top and its edges are facade surfaces for a deck and railings.
  - Dual control authority: edit roof pitch ratio (rise per 12 run) or geometric roof rise.
  - Straight skeleton WebAssembly solver (`straight-skeleton` CGAL library) for multi-volume equal-height hip roofs, with automatic fall-through to gridded distance fields.
  - Gable valley avoidance: automatically orients attached wing ridges perpendicular to spanning blocks.
  - Per-volume pitch and roof rise: select a volume to override the building default.
  - **Merge into adjacent roof** (opt-in per volume): a shed or gable joins its neighbor by intersecting the neighbor's roof plane below the ridge, or snapping to the ridge if it would rise above it. Works across different story counts once the roof clears the taller neighbor's eave, and roof faces always stay planar.

- **Eaves**:
  - Separate eave depth and rake overhang, plus a fascia (default six inches) hanging below every roof edge.
  - Flat or roof-parallel soffits (eaves default flat, rakes default parallel), with boxed corners where they meet.
  - Every setting is a building default that any volume can override; a main roof keeps its eave where a gable merges into it.

- **Roof Structures** (dormers, porches, cupolas; added from a selected mass, picked in the 3D view or the scope control, and edited in the inspector; examples in `data/examples/`):
  - **Dormers** rising out of one roof slope, with gable, hip, shed, or flat roofs. Their walls stand clear of the roof, their roofs die into it along exact valleys, and the host roof is cut to meet them as one closed shell. A roof that would pass the host ridge is lowered to it.
  - **Wall dormers** (zero setback) carry the main wall up through the eave, which stops and is capped on either side.
  - **Recessed porches**: a dormer, usually set up the roof above an intact strip of roof and eave, whose front wall is set back (`inset`), leaving an open porch with a floor, side walls, and the dormer roof over it.
  - **Cupolas, belvederes, and rooftop pavilions** (`mount: 'through'`): rise through the roof without joining it, centered on the ridge or on a flat roof, walls clearing the highest point of the roof under them; open ones stand on posts on the roof.
  - **Entry hoods**: a small roof on brackets over a door.
  - **Canted bay windows, oriels, and towers**: octagonal or round in plan, with polygonal hip or conical roofs; a tower can stand on a corner.
  - **Integral porches**, recessed entries, and loggias cut into the house under its roof (`mount: 'recess'`).
  - **Wraparound porches**: a porch at the end of its wall turns the corner and runs back along the side, under one hip roof.
  - **Porches** standing on a base: projecting past the wall (at ground level or above), or standing on a lower wing. Open sides get posts and headers, and knee walls close the attic where they replace part of the roof.
  - **Supports** for projecting porches: a solid deck, posts, a ground-level porch, brackets, or an enclosed base (a two-story bay).
  - **Stacking**: a structure can stand on another, e.g. a sleeping porch on a ground porch's roof.
  - Every placement is validated (host side, fit on one roof face, overlaps, supports), and anything not built is reported in the status line.
  - **Facade surfaces**: each structure's visible walls become addressable wall runs (with their clipped shapes), with their own story and railing runs along open sides, ready for windows, trim, and railings. A structure can have its own wall and roof materials.

- **Roof Graph & Edge Roles**:
  - Automatically identifies and tags exterior perimeter edges by their architectural roof role:
    - **Eave**: Lower edge where the roof plane slopes upward (includes all hip edges, parallel gable edges, shed low eaves, and courtyard walls).
    - **Rake**: Sloping gable end or verge.
    - **High-Plate**: Elevated wall plate return for shed roofs.
    - **Flat**: Perimeter boundary for flat roofs.
  - Tracks individual edge pitch overrides and wall run ownership.

- **Dual Viewport Interface**:
  - Primary 3D orbit inspection camera with damping and sun/fill lighting.
  - Secondary top-down orthographic plan view synchronized with camera controls and dynamic bounding frustum.

- **Native Persistence & Interchange**:
  - **Footprint editing** (File › Edit footprint…): drag corners and walls on a 2D plan with snapping, add bump-outs and notches, type lengths, re-square, undo and redo, over the game's trace; the building keeps its place in the game. **Turn into a porch** makes an open porch traced as part of the house into a porch structure (projecting, recessed, or a wraparound turned one leg at a time).
  - **File menu**: New building (from a preset footprint, after asking, since it replaces the current one), Open, Save `.bld`, and Export GLB.
  - **Save Project (`.bld`)**: Serializes complete footprint, volumes, roof graph, story overrides, materials, edge pitches, per-volume roof shapes, eave settings, and roof structures into a native JSON document.
  - **Load Project**: Restores saved `.bld` files or raw footprint JSON arrays.
  - **GLB Export**: One-click binary GLTF/GLB export via Three.js `GLTFExporter`, cleanly omitting editor-only visual guides, outlines, and pick targets.
  - **Send to game**: For a building opened from the Dixon game (its X key), posts the model back as game triangles (`js/game-export.js`) with the project, so the game can use it in place of the generated building. Falls back to a download.

## Project Structure

```
building-composer/
├── data/                  # Preset footprint JSON fixtures (Rectangle, U, L, etc.)
│   └── examples/          # Example .bld projects with dormers and porches (and their generator)
├── js/
│   ├── eaves.js           # Eave/rake overhang, fascia, and soffit geometry
│   ├── export.js          # GLTF/GLB binary export logic
│   ├── game-export.js     # the model as the Dixon game's triangles, by its material names
│   ├── extrusion.js       # 3D procedural geometry builders for walls, roofs, foundation; roof merge resolver
│   ├── facade.js          # Facade layout (with roof structure surfaces), volume decomposition, roof graph, .bld persistence
│   ├── footprint.js       # 2D polygon validation, normalization, and metrics
│   ├── footprint-editor.js # Footprint editor core: edits, snapping, validation, undo, placement
│   ├── footprint-view.js  # Footprint mode: the SVG plan editor and its panel
│   ├── footprint-porch.js # Turn into a porch: cut a traced porch out, as a porch structure
│   ├── main.js            # UI controller, scene management, dual viewport rendering
│   ├── materials.js       # Shared PBR material definitions and palette presets
│   ├── roof-planes.js     # Roof eave planes and their heights (shared by roofs and structures)
│   ├── roof-structures.js # Dormer/porch records, placement, validation, and convex-solid clipping
│   └── structure-ui.js    # Roof structure presets and labels for the editor
├── tests/
│   ├── eaves.test.js      # Overhang, fascia/soffit, and closure tests
│   ├── extrusion.test.js  # Massing, extrusion, and NaN validation tests
│   ├── facade.test.js     # Facade layout and volume decomposition tests
│   ├── footprint.test.js  # Validation, winding, and metrics tests
│   ├── helpers/mesh.js    # Mesh inspection helpers (open and uncovered edges, areas)
│   ├── roof_graph.test.js # Edge role classification and serialization tests
│   ├── roof_resolver.test.js # Roof merge, planarity, and story-count tests
│   ├── roof_structures.test.js # Structure records, placement, validation, clipping, persistence
│   ├── roof_structure_geometry.test.js # Dormer and porch geometry: closure, cuts, supports, stacking
│   ├── structure_facades.test.js # Roof structure wall runs, stories, railing runs, materials
│   ├── structure_ui.test.js # Roof structure editor presets and labels
│   └── two_slope_roofs.test.js # Mansard, gambrel, and hip roofs with widow's walks
├── index.html             # App shell, toolbar, sidebar panels, and viewport canvases
├── ARCHITECTURE.md        # Architectural specification and data model
└── IMPLEMENTATION_PLAN.md # Milestone roadmap and execution log
```

## Technical Notes

- Units are meters internally; UI converts to feet when Imperial display is selected.
- Y is up; the footprint is defined in the XZ plane.
- The composer's internal origin is normalized to the footprint centroid.
