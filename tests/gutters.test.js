import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gutterRing, downspoutParts } from '../js/gutters.js';
import { normalizeTrim } from '../js/trim.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';

const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const runsOf = (footprint, eaveOf) => computeFacadeLayout(footprint, {}).wallRuns.map((run, i) => ({
  start: run.start, end: run.end, normal: run.normal, eave: eaveOf(i),
}));
const close = (a, b) => Math.abs(a - b) < 1e-5;

describe('a gutter ring', () => {
  it('moves each eave out to its edge, meeting its neighbor\'s round a corner', () => {
    // all four walls eaves 0.4 out (a hip): the corners meet on the diagonal
    const ring = gutterRing(runsOf(RECT, () => ({ depth: 0.4, y: 7 })));
    assert.deepEqual(ring[0].start.map((v) => +v.toFixed(9)), [-5.4, -4.4]);
    assert.deepEqual(ring[0].end.map((v) => +v.toFixed(9)), [5.4, -4.4]);
    assert.ok(ring.every((run) => close(run.y, 6.98)));
  });

  it('runs on past a gable wall as far as the eave overhangs', () => {
    // eaves on the z walls only (0 and 2); the x walls are gable ends
    const ring = gutterRing(runsOf(RECT, (i) => (i % 2 === 0 ? { depth: 0.4, y: 7 } : null)));
    assert.deepEqual(ring[0].start.map((v) => +v.toFixed(9)), [-5.4, -4.4]);
    assert.equal(ring[1].y, null);
  });

  it('drops a downspout from each free end, or two from a gutter all the way round', () => {
    const gable = gutterRing(runsOf(RECT, (i) => (i % 2 === 0 ? { depth: 0.4, y: 7 } : null)));
    assert.equal(downspoutParts(gable).filter((p) => p.part === 'downspout').length, 4);
    const hip = gutterRing(runsOf(RECT, () => ({ depth: 0.4, y: 7 })));
    const pipes = downspoutParts(hip).filter((p) => p.part === 'downspout');
    assert.equal(pipes.length, 2);
    assert.ok(pipes.every((pipe) => pipe.bottom < 0.1 && close(pipe.top, 6.98 - 0.12)));
  });
});

describe('gutters on a built house', () => {
  const build = (roofType, trim) => {
    const layout = computeFacadeLayout(RECT, { roofType, roofDirection: 'x-min' });
    return createBuildingFromFootprint(RECT, {
      storyCount: 1, storyHeight: 3, foundationDepth: 0.6, roofType, roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12, roofHeight: (8 / 12) * 4,
      roofEaveDepth: 0.4, volumes: layout.volumes, facadeLayout: layout, trim,
    });
  };
  const pointsOf = (built, kind) => {
    const out = [];
    built.building.traverse((mesh) => {
      if (mesh.userData?.trimKind === kind) {
        const p = mesh.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i += 1) out.push([p.getX(i), p.getY(i), p.getZ(i)]);
      }
    });
    return out;
  };

  it('none unless turned on', () => {
    assert.equal(normalizeTrim({}).gutters.enabled, false);
    assert.equal(pointsOf(build('gable', {}), 'gutter').length, 0);
  });

  it('hangs a gable\'s gutters under its eaves\' edges, out past its gable walls', () => {
    const points = pointsOf(build('gable', { gutters: { enabled: true } }), 'gutter');
    assert.ok(points.length > 0);
    // along the z = +/-4 eaves only, out at the edge (0.4) and a gutter's width beyond
    assert.ok(points.every(([, , z]) => Math.abs(z) > 4.39));
    assert.ok(points.some(([x]) => x < -5.3) && points.some(([x]) => x > 5.3), 'past the gable walls');
    // its top a little under the roof's edge (the plate, 3.6, less the eave's slope, and the roof's lift)
    const top = Math.max(...points.map(([, y]) => y));
    assert.ok(top < 3.6 + 0.02 && top > 3.6 - 0.5, `${top}`);
  });

  it('finds the eaves on the roof as built, whichever way its ridge was set to run', () => {
    // 'x-min' sets the high edge on the x sides: the ridge runs along z, so the eaves are the x = +/-5 walls
    const layout = computeFacadeLayout(RECT, { roofType: 'gable', roofDirection: 'x-min' });
    const built = createBuildingFromFootprint(RECT, {
      storyCount: 1, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x-min', roofPitchRise: 8, roofPitchRun: 12, roofHeight: (8 / 12) * 5,
      roofEaveDepth: 0.4, volumes: layout.volumes, facadeLayout: layout, trim: { gutters: { enabled: true } },
    });
    const points = pointsOf(built, 'gutter');
    assert.ok(points.length > 0);
    assert.ok(points.every(([x]) => Math.abs(x) > 5.39), 'along the x walls only');
    assert.ok(Math.max(...points.map(([, y]) => y)) < 3.6 + 0.02, 'under the eave, not up at the ridge');
  });

  it('runs a hip\'s gutter all the way round, with downspouts to the ground', () => {
    const built = build('hip', { gutters: { enabled: true } });
    const points = pointsOf(built, 'gutter');
    assert.ok(points.some(([x]) => Math.abs(x) > 5.3) && points.some(([, , z]) => Math.abs(z) > 4.3));
    const spouts = pointsOf(built, 'downspout');
    assert.ok(spouts.length > 0 && Math.min(...spouts.map(([, y]) => y)) < 0.1);
    assert.equal(pointsOf(build('hip', { gutters: { enabled: true, downspouts: false } }), 'downspout').length, 0);
  });
});
