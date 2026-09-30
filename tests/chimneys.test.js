import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeChimney, normalizeChimneys, chimneyPlan, chimneyParts, partTriangles, CHIMNEY_DEFAULTS,
} from '../js/chimneys.js';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { openTriangleEdges } from './helpers/mesh.js';

// a 10 x 8 box, gable along x: its gable ends are the x = +/-5 walls (wall-run-1 is x = 5, facing +x)
const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const LAYOUT = computeFacadeLayout(RECT, {});
const RUN = LAYOUT.wallRuns.find((run) => run.id === 'wall-run-1');

describe('chimney records', () => {
  it('fill in an outside brick chimney, and drop one with no wall', () => {
    assert.deepEqual(normalizeChimney({ hostWallRunId: 'wall-run-1' }), { id: null, hostWallRunId: 'wall-run-1', ...CHIMNEY_DEFAULTS });
    assert.equal(normalizeChimney({}), null);
    assert.deepEqual(normalizeChimneys([{ hostWallRunId: 'a' }, { hostWallRunId: 'b' }]).map((c) => c.id), ['chimney-1', 'chimney-2']);
    assert.equal(normalizeChimney({ hostWallRunId: 'a', width: 9, aboveRoof: 0 }).width, 3);
  });
});

describe('where a chimney stands', () => {
  it('outside: against the wall face, out from it by its depth', () => {
    const plan = chimneyPlan(normalizeChimney({ hostWallRunId: RUN.id, width: 1.2, depth: 0.6 }), RUN);
    const xs = plan.map(([x]) => x);
    const zs = plan.map(([, z]) => z);
    assert.deepEqual([Math.min(...xs), Math.max(...xs)], [5, 5.6]);
    assert.deepEqual([Math.min(...zs), Math.max(...zs)].map((v) => +v.toFixed(9)), [-0.6, 0.6]);
  });

  it('inside: set in from the wall', () => {
    const plan = chimneyPlan(normalizeChimney({
      hostWallRunId: RUN.id, position: 'inside', inset: 1, depth: 0.6,
    }), RUN);
    const xs = plan.map(([x]) => x);
    assert.deepEqual([Math.min(...xs), Math.max(...xs)].map((v) => +v.toFixed(9)), [3.4, 4]);
  });

  it('a stack, a cap, and a flue, each a closed box', () => {
    const parts = chimneyParts(chimneyPlan(normalizeChimney({ hostWallRunId: RUN.id }), RUN), 0, 8);
    assert.deepEqual(parts.map((p) => p.part), ['stack', 'cap', 'flue']);
    parts.forEach((part) => assert.deepEqual(openTriangleEdges(partTriangles(part)), []));
  });
});

describe('chimneys on a built house', () => {
  const build = (chimneys) => createBuildingFromFootprint(RECT, {
    storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofHeight: 3, roofEaveDepth: 0.3,
    volumes: LAYOUT.volumes, facadeLayout: LAYOUT, chimneys,
  });
  const chimneyYs = (built) => {
    const ys = [];
    built.building.traverse((mesh) => {
      if (mesh.userData?.bodyPart === 'chimney') {
        const p = mesh.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i += 1) ys.push(p.getY(i));
      }
    });
    return ys;
  };

  it('an end chimney rises from the ground past the ridge beside it', () => {
    const built = build([{ hostWallRunId: RUN.id, aboveRoof: 0.9 }]);
    const [entry] = built.chimneys;
    assert.deepEqual(entry.errors, []);
    const ys = chimneyYs(built);
    assert.equal(Math.min(...ys), 0);
    // the ridge (6.6 + 3, and the roof's lift) stands within reach: 0.9 over it, then its cap and flue
    assert.ok(entry.top > 6.6 + 3 + 0.9 - 1e-6 && entry.top < 6.6 + 3 + 0.9 + 0.1, `${entry.top}`);
    assert.ok(Math.max(...ys) > entry.top);
  });

  it('one through the roof starts at the wall top', () => {
    const built = build([{ hostWallRunId: RUN.id, position: 'inside', inset: 2 }]);
    assert.ok(Math.abs(Math.min(...chimneyYs(built)) - 6.6) < 1e-5);
  });

  it('saves with the project, dropping one whose wall is gone', () => {
    const saved = serializeBuildingState(LAYOUT, { chimneys: [{ hostWallRunId: RUN.id }, { hostWallRunId: 'wall-run-9' }] });
    const { state, warnings } = deserializeBuildingState(saved);
    assert.deepEqual(state.chimneys.map((c) => c.hostWallRunId), [RUN.id]);
    assert.ok(warnings.some((w) => w.includes('wall-run-9')));
  });
});
