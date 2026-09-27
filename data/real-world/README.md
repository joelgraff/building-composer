# Real-world evaluation models

House types common in Dixon, Illinois and the Midwest, modeled with the current massing, roofs, and roof structures to find what the system can't yet express. Sizes are typical for each type, not measured from particular buildings.

Regenerate with `node data/real-world/generate.mjs`. It writes a `.bld` per house and `summary.json`, and prints any structure the house calls for that the model refuses. Each entry in the generator records its gaps: what the real building has that could not be modeled.

| File | House |
|---|---|
| `italianate.bld` | Italianate (courthouse-square type, like the Van Epps and Brookner houses): hip roof on deep eaves, belvedere, flat-roofed entry porch, box bay, one-story rear wing |
| `upright-and-wing.bld` | Upright-and-wing: two-story gable-front upright, one-story side wing, porch in the ell. Faces +X |
| `queen-anne.bld` | Gable-front Queen Anne (Reagan Boyhood Home type): cross-gabled projection merged into the main roof, front and side porches. Faces +X |
| `foursquare.bld` | American Foursquare: hip roof with hipped dormers, full-width porch |
| `bungalow.bld` | Craftsman bungalow: side gable on deep eaves, shed dormer, front-gabled porch |
| `dutch-colonial.bld` | Dutch Colonial Revival: gambrel, shed dormer under the break, gabled entry |
| `farmhouse.bld` | I-house farmhouse with a rear ell and two porches |
| `cape-cod.bld` | 1940s Cape Cod: steep side gable, two gable dormers, gabled entry |
| `ranch.bld` | 1950s L-shaped ranch: continuous low hip, porch in the ell |

Two houses face +X rather than +Z. Volumes come from splitting the footprint into bands along Z, and facing +Z those two houses split against their massing (see the gaps in `generate.mjs`).
