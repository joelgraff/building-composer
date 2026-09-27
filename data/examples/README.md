# Roof structure examples

Example projects for roof structures (dormers and porches; see *Roof-borne
structures* in `IMPLEMENTATION_PLAN.md`). Open one with **Load JSON** in the
app. Every structure faces +Z, toward the default camera, unless noted.

| File | What it shows |
|------|---------------|
| `roof-dormers.bld` | Roof dormers set back on the slope, one of each roof type: gable, hip, shed, flat. |
| `wall-dormers.bld` | Wall dormers (zero setback): the front wall carries the main wall up, and the eave stops and is capped either side. Gable, hip, and shed roofs. |
| `hip-roof-dormers.bld` | Dormers on a hip roof: a gable dormer and a hip wall dormer on the long slope, and a small dormer in the hip end (+X). |
| `attic-dormers.bld` | Story-and-a-half cottage on a 12:12 roof: a long shed wall dormer on the front, two steep gable dormers on the back (−Z). |
| `ground-porch.bld` | A ground-level porch on a solid deck, open on three sides with posts, its shed roof butting the wall below the second floor. |
| `sleeping-porch.bld` | A sleeping porch standing on a flat-roofed ground porch (`hostStructureId`): the ground porch open with posts, the sleeping porch enclosed, its shed roof tucked under the main eave. |
| `porch-supports.bld` | Second-floor porches and their supports: posts, brackets (a shallow balcony), and an enclosed base (a two-story bay). |

The files are generated. After changing the data model, regenerate and check
them with:

```bash
node data/examples/generate.mjs
```
