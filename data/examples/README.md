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
| `recessed-porch.bld` | Recessed porches on a story-and-a-half bungalow, set up the roof above an intact strip of roof and eave: an open porch in front of a set-back wall under a gable dormer roof (front), and a wider one under a shed roof (back, −Z). |
| `second-empire.bld` | A mansard roof (steep lower slope to a curb at 3 m, low hip above, cornice eaves) with three dormers on the front slope, below the curb. |
| `gambrel.bld` | A story-and-a-half house under a gambrel roof (gable ends with rakes following the broken profile), with two small dormers. |
| `widows-walk.bld` | A widow's walk: a hip roof cut flat 1.6 m above the plate (`roofWalkHeight`) in place of its ridge. The flat top and its edges are facade surfaces for a deck and railings (`roofWalks`, `railRuns`). |
| `widows-walk-l.bld` | A widow's walk on an L-shaped house: the continuous (straight-skeleton) hip is cut flat into one L-shaped walk, with a belvedere standing on it. |
| `cupola.bld` | A cupola on the ridge of a two-story gable house: 1.6 m square, pyramid roof, walls clearing the ridge by 1.2 m (`mount: 'through'`, centered). |
| `belvedere.bld` | An Italianate belvedere at the center of a low hip roof, with a low hip roof of its own. |
| `rooftop-pavilion.bld` | An open pavilion on a flat roof: a hip roof on posts standing on the roof deck. |
| `ground-porch.bld` | A ground-level porch on a solid deck, open on three sides with posts, its shed roof butting the wall below the second floor. |
| `sleeping-porch.bld` | A sleeping porch standing on a flat-roofed ground porch (`hostStructureId`): the ground porch open with posts, the sleeping porch enclosed, its shed roof tucked under the main eave. |
| `porch-supports.bld` | Second-floor porches and their supports: posts, brackets (a shallow balcony), and an enclosed base (a two-story bay). |

The files are generated. After changing the data model, regenerate and check
them with:

```bash
node data/examples/generate.mjs
```
