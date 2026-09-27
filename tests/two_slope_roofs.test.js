import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import {
  computeFacadeLayout, classifyEdgeRole, serializeBuildingState, deserializeBuildingState,
} from '../js/facade.js';
import { createBuildingFromFootprint, computeVolumeEavePlanes, evalZoneHeight } from '../js/extrusion.js';
import { normalizeRoofStructures, normalizeRoofStructure, DECK_THICKNESS } from '../js/roof-structures.js';
import { meshTriangles, totalArea, uncoveredEdges } from './helpers/mesh.js';

const RECT = [[-10, -5], [10, -5], [10, 5], [-10, 5]];
const read = (name) => normalizeFootprint(JSON.parse(readFileSync(`./data/${name}`, 'utf8')));
// two stories, plate at 0.6 + 6 + 0.02
const PLATE = 6.62;
const E = 0.35; // eave depth
const R = 0.25; // rake depth
const F = 0.1524; // fascia (default)

function build(footprint, config = {}) {
  return createBuildingFromFootprint(footprint, {
    storyCount: 2,
    storyHeight: 3,
    foundationDepth: 0.6,
    roofDirection: 'x',
    roofPitchRise: 6,
    roofPitchRun: 12,
    roofEaveDepth: E,
    roofRakeDepth: R,
    volumes: computeFacadeLayout(footprint, {}).volumes,
    ...config,
    roofStructures: normalizeRoofStructures(config.roofStructures ?? []),
  });
}

function trianglesOf(building, predicate = () => true) {
  const out = [];
  building.traverse((child) => {
    if (child.isMesh && predicate(child.userData ?? {})) {
      meshTriangles(child).forEach((tri) => out.push(tri.map(([x, y, z]) => [x, y + child.position.y, z])));
    }
  });
  return out;
}
const isRoof = (data) => Boolean(data.roofType);

/** Heights at which a surface crosses the vertical line through (x, z). */
function surfaceHeightsAt(tris, x, z) {
  const heights = [];
  tris.forEach(([a, b, c]) => {
    const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(det) < 1e-12) {
      return;
    }
    const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
    const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
    const l3 = 1 - l1 - l2;
    if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) {
      heights.push(l1 * a[1] + l2 * b[1] + l3 * c[1]);
    }
  });
  return heights;
}

/**
 * Nothing to see through: every open edge lies on another surface, except
 * where a roof sits its 2 cm roof lift above its walls (as every roof does).
 */
function assertWatertight(result, label) {
  const lift = (edge) => result.roofZones.some((zone) => edge.every((p) => p[1] >= zone.wallTopY - 1e-3 && p[1] <= zone.baseY + 1e-3
    && ['minX', 'maxX', 'minZ', 'maxZ'].some((side) => Math.abs(p[side === 'minX' || side === 'maxX' ? 0 : 2] - zone.bounds[side]) < 1e-3)));
  const gaps = uncoveredEdges(trianglesOf(result.building)).filter((edge) => !lift(edge));
  assert.deepEqual(gaps, [], `${label}: see-through edges`);
  trianglesOf(result.building).flat(2).forEach((value) => assert.ok(Number.isFinite(value)));
}

const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-5, `${message ?? ''} expected ${b}, got ${a}`);

describe('two-slope roof planes', () => {
  const bounds = { minX: -10, maxX: 10, minZ: -5, maxZ: 5 };

  it('a mansard rises steeply to the break, then shallowly, on all four sides', () => {
    const planes = computeVolumeEavePlanes(bounds, 'mansard', { breakHeight: 2.4, lowerSlope: 2.5, upperSlope: 1 / 3, roofDirection: 'x' });
    assert.equal(planes.length, 8);
    assert.deepEqual(planes.slice(0, 4).map((plane) => plane.tier), ['lower', 'lower', 'lower', 'lower'], 'lower slopes first');
    near(evalZoneHeight(planes, 0, -5), 0, 'eave');
    near(evalZoneHeight(planes, 0, -5 + 0.96), 2.4, 'the break, 2.4 / 2.5 in');
    near(evalZoneHeight(planes, 0, 0), 2.4 + (5 - 0.96) / 3, 'the ridge');
    near(evalZoneHeight(planes, -10 + 0.5, 0), 0.5 * 2.5, 'the ends slope too');
  });

  it('a gambrel slopes only on its eave sides', () => {
    const planes = computeVolumeEavePlanes(bounds, 'gambrel', { breakHeight: 2.4, lowerSlope: 2.5, upperSlope: 0.5, roofDirection: 'x' });
    assert.deepEqual(planes.map((plane) => plane.side), ['minZ', 'maxZ', 'minZ', 'maxZ']);
    near(evalZoneHeight(planes, -10, 0), evalZoneHeight(planes, 0, 0), 'level along the ridge to the gable end');
  });
});

describe('mansard roofs', () => {
  it('build a closed shell whose surface matches its planes', () => {
    const result = build(RECT, { roofType: 'mansard' });
    const [zone] = result.roofZones;
    assert.equal(zone.roofType, 'mansard');
    // defaults: break 2.4, 30:12 lower, 4:12 upper
    near(zone.roofHeight, 2.4 + (5 - 2.4 / 2.5) * (4 / 12), 'peak over the 5 m half span');
    const roof = trianglesOf(result.building, isRoof);
    [[0, 0], [0, -4.5], [-9.6, 0], [5, 2], [-8, -3]].forEach(([x, z]) => {
      const expected = zone.baseY + evalZoneHeight(zone.planes, x, z);
      assert.ok(surfaceHeightsAt(roof, x, z).some((h) => Math.abs(h - expected) < 1e-4), `surface at (${x}, ${z})`);
    });
    assertWatertight(result, 'mansard');
  });

  it('have a horizontal cornice at the plate, not the steep slope carried past the wall', () => {
    const result = build(RECT, { roofType: 'mansard' });
    const roof = trianglesOf(result.building, isRoof);
    near(Math.min(...roof.flat().map((v) => v[1])), PLATE - F, 'nothing below the fascia');
    // the cornice top is level with the plate, all the way out to the fascia
    assert.ok(surfaceHeightsAt(roof, 0, -5 - E / 2).some((h) => Math.abs(h - PLATE) < 1e-5));
    const fascia = roof.filter((tri) => tri.every((v) => Math.abs(v[2] - -(5 + E)) < 1e-6));
    near(totalArea(fascia), (20 + 2 * E) * F, 'fascia the full length, mitred to the corners');
  });

  it('can be flat on top, the upper tier level at the break', () => {
    const result = build(RECT, { roofType: 'mansard', roofUpperPitchRise: 0 });
    near(result.roofZones[0].roofHeight, 2.4);
    assert.ok(surfaceHeightsAt(trianglesOf(result.building, isRoof), 3, 1).some((h) => Math.abs(h - (PLATE + 2.4)) < 1e-5));
    assertWatertight(result, 'flat-topped mansard');
  });

  it('take per-volume settings over the building ones', () => {
    const result = build(RECT, {
      roofType: 'mansard', roofBreakHeight: 3, volumeRoofShapes: { 'volume-0': { breakHeight: 2, lowerPitchRise: 24, upperPitchRise: 0 } },
    });
    near(result.roofZones[0].roofHeight, 2);
  });

  it('on a U, each block gets its own mansard; the wings end against the base', () => {
    const result = build(read('footprint_u.json'), { roofType: 'mansard' });
    assert.deepEqual(result.roofZones.map((zone) => zone.roofType), ['mansard', 'mansard', 'mansard']);
    assertWatertight(result, 'U mansard');
  });

  it('merges nothing into a mansard, and a wing roof still meets it', () => {
    const lean = read('footprint_narrow_lean_to.json');
    const result = build(lean, {
      roofType: 'mansard', volumeStoryOverrides: { 'volume-1': 1 }, volumeRoofTypes: { 'volume-1': 'gable' }, volumeRoofConnections: { 'volume-1': 'merge-plane' },
    });
    assert.deepEqual(result.roofZones.map((zone) => zone.roofType), ['mansard', 'gable']);
    assert.ok(result.roofZones.every((zone) => zone.exact));
    assertWatertight(result, 'mansard with a gable wing');
  });
});

describe('gambrel roofs', () => {
  it('build a closed shell with gable ends', () => {
    const result = build(RECT, { roofType: 'gambrel' });
    const [zone] = result.roofZones;
    // defaults: break 2.4, 20:12 lower, 6:12 upper
    near(zone.roofHeight, 2.4 + (5 - 2.4 / (20 / 12)) * 0.5);
    assertWatertight(result, 'gambrel');
  });

  it('carry the roof past the gable walls as rakes following the broken profile', () => {
    const result = build(RECT, { roofType: 'gambrel' });
    const [zone] = result.roofZones;
    const roof = trianglesOf(result.building, isRoof);
    [0, -2.5, -4.5].forEach((z) => {
      const expected = zone.baseY + evalZoneHeight(zone.planes, 0, z);
      assert.ok(surfaceHeightsAt(roof, -10 - R / 2, z).some((h) => Math.abs(h - expected) < 1e-4), `rake over z=${z}`);
    });
    // the rake fascia at the outer line, one fascia deep all along the profile
    const fascia = roof.filter((tri) => tri.every((v) => Math.abs(v[0] - -(10 + R)) < 1e-6));
    assert.ok(fascia.length > 0);
  });

  it('on an L, both blocks are gambrels and close against each other', () => {
    const result = build(read('footprint_l.json'), { roofType: 'gambrel' });
    assert.deepEqual(result.roofZones.map((zone) => zone.roofType), ['gambrel', 'gambrel']);
    assertWatertight(result, 'L gambrel');
  });
});

describe('two-slope roofs with structures, roles, and persistence', () => {
  it('a dormer on a mansard\'s lower slope stays below the break', () => {
    const fits = build(RECT, {
      roofType: 'mansard',
      roofStructures: [{ hostVolumeId: 'volume-0', hostSide: 'minZ', setback: 0.25, width: 1.4, wallHeight: 0.9, roofType: 'gable', roofShape: { mode: 'slope', pitchRise: 6 } }],
    });
    assert.deepEqual(fits.roofStructures[0].errors, []);
    assertWatertight(fits, 'mansard dormer');
    const tooTall = build(RECT, {
      roofType: 'mansard',
      roofStructures: [{ hostVolumeId: 'volume-0', hostSide: 'minZ', setback: 0.3, wallHeight: 1.2, roofType: 'gable' }],
    });
    assert.deepEqual(tooTall.roofStructures[0].errors.map((e) => e.code), ['crosses-face'], 'past the break it would span two faces');
  });

  it('a flush wall dormer breaks the cornice with a box-shaped cap', () => {
    const result = build(RECT, { roofType: 'mansard', roofStructures: [{ kind: 'wall-dormer', hostVolumeId: 'volume-0', hostSide: 'minZ' }] });
    assert.deepEqual(result.roofStructures[0].errors, []);
    const caps = trianglesOf(result.building, (data) => data.structurePart === 'eave-caps');
    near(totalArea(caps), 2 * E * F, 'two caps, each the cornice section');
    assertWatertight(result, 'mansard wall dormer');
  });

  it('classify a mansard\'s edges as eaves and a gambrel\'s like a gable\'s', () => {
    const volumes = computeFacadeLayout(RECT, {}).volumes;
    const edge = (start, end) => ({ start, end });
    const along = edge([-10, -5], [10, -5]); // parallel to the ridge
    const across = edge([10, -5], [10, 5]);
    assert.equal(classifyEdgeRole(across, volumes, { roofType: 'mansard' }).role, 'eave');
    const ridgeAxis = volumes[0].ridgeAxis;
    const [eaveEdge, rakeEdge] = ridgeAxis === 'x' ? [along, across] : [across, along];
    assert.equal(classifyEdgeRole(eaveEdge, volumes, { roofType: 'gambrel' }).role, 'eave');
    assert.equal(classifyEdgeRole(rakeEdge, volumes, { roofType: 'gambrel' }).role, 'rake');
  });

  it('keep the building-wide mansard settings in .bld files', () => {
    const layout = computeFacadeLayout(RECT, {});
    const saved = JSON.parse(JSON.stringify(serializeBuildingState(layout, {
      roofType: 'mansard', roofBreakHeight: 2.8, roofLowerPitchRise: 28, roofUpperPitchRise: 0,
    })));
    const { state } = deserializeBuildingState(saved);
    assert.deepEqual([state.roofBreakHeight, state.roofLowerPitchRise, state.roofUpperPitchRise], [2.8, 28, 0]);
    assert.equal(deserializeBuildingState({ footprint: RECT }).state.roofBreakHeight, undefined);
  });
});

describe('hip roofs cut flat at a deck', () => {
  it('stop at the deck height, with a level top inset by the deck height over the pitch', () => {
    const result = build(RECT, { roofType: 'hip', roofDeckHeight: 1.5 });
    const [zone] = result.roofZones;
    near(zone.roofHeight, 1.5);
    assert.ok(zone.planes.some((plane) => plane.tier === 'deck'));
    const roof = trianglesOf(result.building, isRoof);
    const top = roof.filter((tri) => tri.every((v) => Math.abs(v[1] - (PLATE + 1.5)) < 1e-5));
    // 6:12 reaches 1.5 m three meters in from each wall
    const planArea = top.reduce((sum, [a, b, c]) => sum + Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / 2, 0);
    near(planArea, (20 - 6) * (10 - 6), 'the flat top');
    [[0, 0], [-8, 0], [0, -4.5], [6.9, 1.9]].forEach(([x, z]) => {
      const expected = zone.baseY + evalZoneHeight(zone.planes, x, z);
      assert.ok(surfaceHeightsAt(roof, x, z).some((h) => Math.abs(h - expected) < 1e-4), `surface at (${x}, ${z})`);
    });
    assertWatertight(result, 'decked hip');
  });

  it('take a per-volume deck over the building one, and ignore a deck above the natural peak', () => {
    near(build(RECT, { roofType: 'hip', roofDeckHeight: 1.5, volumeRoofShapes: { 'volume-0': { deckHeight: 1 } } }).roofZones[0].roofHeight, 1);
    const high = build(RECT, { roofType: 'hip', roofHeight: 2.5, roofDeckHeight: 9 }).roofZones[0];
    assert.equal(high.planes.some((plane) => plane.tier === 'deck'), false);
    near(high.roofHeight, 2.5);
  });
});

describe('widow\'s walks', () => {
  const walk = (fields = {}, config = {}) => build(RECT, {
    roofType: 'hip', roofHeight: 2.5, roofDeckHeight: 1.5, ...config, roofStructures: [{ kind: 'widows-walk', hostVolumeId: 'volume-0', hostSide: 'minZ', ...fields }],
  });
  const deckOf = (result) => trianglesOf(result.building, (data) => data.structurePart === 'deck');

  it('the preset is a roofless deck through the roof, filling the flat top', () => {
    const record = normalizeRoofStructure({ kind: 'widows-walk', hostVolumeId: 'volume-0', hostSide: 'minZ' });
    assert.equal(record.roofType, 'none');
    assert.equal(record.mount, 'through');
    assert.equal(record.fill, true);
    assert.deepEqual(record.openSides, ['front', 'back', 'left', 'right']);
  });

  it('fills a hip\'s deck less its margin, standing on it', () => {
    const result = walk();
    const [{ resolved, errors }] = result.roofStructures;
    assert.deepEqual(errors, []);
    // the deck spans x within +-7 and z within +-2; less 0.3 m
    ['minX', 'maxX', 'minZ', 'maxZ'].forEach((side) => near(Math.abs(resolved.bounds[side]), side.endsWith('X') ? 6.7 : 1.7, side));
    near(resolved.sillY, PLATE + 1.5);
    near(resolved.plateY, PLATE + 1.5 + 1, 'wall height is the railing height');
    const deck = deckOf(result);
    const ys = deck.flat().map((v) => v[1]);
    near(Math.min(...ys), PLATE + 1.5);
    near(Math.max(...ys), PLATE + 1.5 + DECK_THICKNESS);
    ['walls', 'roof', 'posts'].forEach((part) => {
      assert.equal(trianglesOf(result.building, (data) => data.structurePart === part).length, 0, `no ${part}`);
    });
    assertWatertight(result, 'widow\'s walk');
  });

  it('fills a flat-topped mansard and a flat roof too', () => {
    const mansard = walk({}, { roofType: 'mansard', roofUpperPitchRise: 0 });
    assert.deepEqual(mansard.roofStructures[0].errors, []);
    near(mansard.roofStructures[0].resolved.sillY, PLATE + 2.4);
    const flat = walk({}, { roofType: 'flat' });
    near(flat.roofStructures[0].resolved.bounds.maxX, 10 - 0.3);
  });

  it('can be sized by hand, and only stands on the level part', () => {
    assert.deepEqual(walk({ fill: false, width: 4, depth: 2 }).roofStructures[0].errors, []);
    assert.deepEqual(walk({ fill: false, width: 4, depth: 5 }).roofStructures[0].errors.map((e) => e.code), ['not-level'], 'runs onto the slopes');
    assert.deepEqual(walk({}, { roofDeckHeight: undefined }).roofStructures[0].errors.map((e) => e.code), ['not-level'], 'a plain hip');
    assert.deepEqual(walk({}, { roofType: 'gable' }).roofStructures[0].errors.map((e) => e.code), ['not-level'], 'a gable');
  });

  it('leaves the roof under it whole', () => {
    const without = trianglesOf(build(RECT, { roofType: 'hip', roofDeckHeight: 1.5 }).building, isRoof).length;
    assert.equal(trianglesOf(walk().building, isRoof).length, without);
  });
});
