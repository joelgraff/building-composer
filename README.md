# Building Composer

A lightweight standalone HTML/JavaScript app for building massing from a 2D footprint polygon.

## Run locally

From the project root:

```bash
npx serve .
```

Then open the local URL shown by the server, or open `index.html` directly in a browser.

## Features

- Footprint JSON upload
- Validation for closed rings, self-intersections, and CCW winding
- Summary metrics: area, perimeter, centroid, bounding box
- Top-down orthographic preview
- 3D orbit view with foundation, extruded walls, and flat roof
- GLB export via Three.js `GLTFExporter`

## Notes

- Units are meters.
- Y is up and the footprint is defined in the XZ plane.
- The composer's internal origin is the footprint centroid.
