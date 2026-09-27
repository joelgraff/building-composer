import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeFacadeLayout, withStructureFacades } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures, normalizeRoofStructure } from '../js/roof-structures.js';
import { meshTriangles, uncoveredEdges } from './helpers/mesh.js';

// a 12 x 10 two-story house (plate at 0.6 + 6), gable along x; its front is +Z (z = 5)
const RECT = [[-6, -5], [6, -5], [6, 5], [-6, 5]];
const LAYOUT = computeFacadeLayout(RECT, {});
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message ?? ''} expected ${b}, got ${a}`);

function build(structures) {
  const result = createBuildingFromFootprint(RECT, {
    storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
    roofEaveDepth: 0.35, volumes: LAYOUT.volumes, roofStructures: normalizeRoofStructures(structures),
  });
  return { result, layout: withStructureFacades(LAYOUT, result.structureFacades) };
}

function assertWatertight(result, label) {
  const tris = [];
  result.building.traverse((child) => {
    if (child.isMesh && !child.userData?.editorOnly) {
      meshTriangles(child).forEach((tri) => tris.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => Math.abs(p[1] - zone.baseY) < 1e-3));
  assert.deepEqual(uncoveredEdges(tris).filter((edge) => !lift(edge)), [], `${label}: see-through edges`);
}

const bay = (fields = {}) => ({
  id: 'b', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: -2, width: 3, setback: -1, depth: 1, baseHeight: 'ground', wallHeight: 2.8,
  roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: [], plan: { shape: 'canted' }, ...fields,
});
// centered on the front right corner (x = 6, z = 5), 3.4 m across, rising past the eave
const tower = (fields = {}) => ({
  id: 't', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: 6, width: 3.4, setback: -1.7, depth: 3.4, baseHeight: 'ground', wallHeight: 8.2,
  roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 18 }, openSides: [], plan: { shape: 'polygon', sides: 8 }, ...fields,
});

describe('canted bays', () => {
  it('angle their sides back to the wall, with a hip roof sloping from the three outer faces', () => {
    const { result, layout } = build([bay()]);
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, []);
    // 45 degrees over a 1 m projection: the front is 3 - 2 x 1 m wide
    const front = resolved.outline.filter(([, z]) => Math.abs(z - 6) < 1e-9).map(([x]) => x).sort((a, b) => a - b);
    near(front[1] - front[0], 1, 'front width');
    assert.equal(resolved.planes.length, 3, 'the front and two angled sides');
    assert.equal(layout.structureWallRuns.length, 3, 'a wall run per facet');
    assertWatertight(result, 'canted bay');
  });

  it('can be an oriel on the upper story, with no support', () => {
    const { result } = build([bay({ offset: 2, width: 2.4, setback: -0.8, depth: 0.8, baseHeight: -3, wallHeight: 2.4, support: 'none' })]);
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, []);
    assert.equal(resolved.support, 'none');
    assertWatertight(result, 'oriel');
  });
});

describe('towers', () => {
  it('an octagonal tower on the corner shows only outside the house and rises to a pyramid', () => {
    const { result, layout } = build([tower()]);
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, [], 'it may stand past the end of its wall');
    assert.equal(resolved.outline.length, 8);
    assert.equal(resolved.planes.length, 8);
    // a pyramid: the peak over the center at the pitch times the apothem
    const apothem = 1.7 * Math.cos(Math.PI / 8);
    near(resolved.roofHeight, (18 / 12) * apothem);
    assert.equal(layout.structureWallRuns.length, 8);
    // the quarter inside the house has no wall showing
    const inside = layout.structureWallRuns.filter((run) => {
      const [mx, mz] = [(run.start[0] + run.end[0]) / 2, (run.start[1] + run.end[1]) / 2];
      return mx < 6 && mz < 5;
    });
    inside.forEach((run) => assert.ok(run.area < 6.62 * run.length, `${run.id} shows only above the house`));
    assertWatertight(result, 'corner tower');
  });

  it('a round turret is a many-sided polygon with a cone', () => {
    const { result } = build([tower({ plan: { shape: 'polygon', sides: 16 }, roofShape: { mode: 'slope', pitchRise: 24 } })]);
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, []);
    assert.equal(resolved.outline.length, 16);
    assertWatertight(result, 'round turret');
  });

  it('an octagonal cupola rises through the roof', () => {
    const { result } = build([{
      id: 'c', kind: 'cupola', hostVolumeId: 'volume-0', hostSide: 'maxZ', width: 2, depth: 2, setback: 'center', wallHeight: 1.5,
      roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 12 }, plan: { shape: 'polygon', sides: 8 },
    }]);
    assert.deepEqual(result.roofStructures[0].errors, []);
    assertWatertight(result, 'octagonal cupola');
  });
});

describe('plans in the record', () => {
  it('are kept, clamped, and only for structures on a base or through the roof', () => {
    assert.deepEqual(normalizeRoofStructure(bay()).plan, { shape: 'canted', angle: 45 });
    assert.deepEqual(normalizeRoofStructure(tower({ plan: { shape: 'polygon', sides: 99 } })).plan, { shape: 'polygon', sides: 32 });
    assert.equal(normalizeRoofStructure(bay({ plan: { shape: 'star' } })).plan, null);
    const code = (fields) => build([bay(fields)]).result.roofStructures[0].errors.map((e) => e.code);
    assert.deepEqual(code({ roofType: 'gable' }), ['plan-roof']);
    assert.deepEqual(code({ width: 1.8 }), ['plan-canted'], 'narrower than its two angled sides');
    assert.deepEqual(code({ baseHeight: null, setback: 0.8, depth: null }), ['plan-needs-base'], 'a dormer');
  });
});
