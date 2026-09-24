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
  - Rectilinear volume decomposition (`decomposeIntoVolumes`): automatically splits complex rectilinear footprints into constituent massing blocks.
  - Independent volume editing: configure story counts, roof forms, and ridge directions per volume or at the building-default level.
  - Interactive 3D volume picking: hover over building volumes for amber highlighting and click to select for direct parametric control.

- **Roof System & Variants**:
  - Roof forms supported: **Flat**, **Gable**, **Hip**, and **Shed**.
  - Dual control authority: edit roof pitch ratio (rise per 12 run) or geometric roof rise.
  - Straight skeleton WebAssembly solver (`straight-skeleton` CGAL library) for multi-volume equal-height hip roofs, with automatic fall-through to gridded distance fields.
  - Gable valley avoidance: automatically orients attached wing ridges perpendicular to spanning blocks.

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
  - **Save Project (`.bld`)**: Serializes complete footprint, volumes, roof graph, story overrides, materials, and edge pitches into a native JSON document.
  - **Load Project**: Restores saved `.bld` files or raw footprint JSON arrays.
  - **GLB Export**: One-click binary GLTF/GLB export via Three.js `GLTFExporter`, cleanly omitting editor-only visual guides, outlines, and pick targets.

## Project Structure

```
building-composer/
├── data/                  # Preset footprint JSON fixtures (Rectangle, U, L, etc.)
├── js/
│   ├── export.js          # GLTF/GLB binary export logic
│   ├── extrusion.js       # 3D procedural geometry builders for walls, roofs, foundation
│   ├── facade.js          # Facade layout, volume decomposition, roof graph, .bld persistence
│   ├── footprint.js       # 2D polygon validation, normalization, and metrics
│   ├── main.js            # UI controller, scene management, dual viewport rendering
│   └── materials.js       # Shared PBR material definitions and palette presets
├── tests/
│   ├── extrusion.test.js  # Massing, extrusion, and NaN validation tests
│   ├── facade.test.js     # Facade layout and volume decomposition tests
│   ├── footprint.test.js  # Validation, winding, and metrics tests
│   └── roof_graph.test.js # Edge role classification and serialization tests
├── index.html             # App shell, toolbar, sidebar panels, and viewport canvases
├── ARCHITECTURE.md        # Architectural specification and data model
└── IMPLEMENTATION_PLAN.md # Milestone roadmap and execution log
```

## Technical Notes

- Units are meters internally; UI converts to feet when Imperial display is selected.
- Y is up; the footprint is defined in the XZ plane.
- The composer's internal origin is normalized to the footprint centroid.
