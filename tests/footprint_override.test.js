import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  outlineHashText, outlineHash, porchLegs, gamePorchKind, buildFootprintOverride, OVERRIDE_FORMAT,
} from '../js/footprint-override.js';
import { toComposerFrame, toGameFrame } from '../js/footprint-editor.js';
import { cutPart, porchStructures } from '../js/footprint-porch.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';
import { computeFacadeLayout } from '../js/facade.js';
import { computeFootprintMetrics } from '../js/footprint.js';

const near = (a, b, tolerance = 1e-3, message = '') => assert.ok(Math.abs(a - b) < tolerance, `${message} expected ${b}, got ${a}`);
const samePoint = (a, b, tolerance = 2e-3) => {
  near(a[0], b[0], tolerance, 'x:');
  near(a[1], b[1], tolerance, 'z:');
};

const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
const PLACEMENT = { id: '115768678', source: 'dixon_dem', rotation: 0.3, center: [508.1, -212.7] };
const VOLUMES = computeFacadeLayout(RECT, {}).volumes;

describe('outline hash', () => {
  it('writes each corner to the millimeter, x,z joined by ;', () => {
    assert.equal(outlineHashText([[508.1081, -212.6684], [523.0954, -213.5549], [1e-5, -0.0002], [508.1081, -212.6684]]), '508.108,-212.668;523.095,-213.555;0.000,0.000');
  });

  it('is the SHA-256 of that text, as the game computes it', async () => {
    const points = [[508.108, -212.668], [523.095, -213.555], [520.2, -200.1]];
    const expected = createHash('sha256').update(outlineHashText(points)).digest('hex');
    assert.equal(await outlineHash(points), expected);
    assert.match(expected, /^[0-9a-f]{64}$/);
  });
});

describe('porchLegs', () => {
  it('gives a projecting porch one leg along its wall, running as the outline does', () => {
    const [record] = normalizeRoofStructures([{
      kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: 1, width: 4, setback: -2.4, depth: 2.4, baseHeight: 'ground',
    }]);
    const [leg] = porchLegs(record, VOLUMES[0]);
    // the front (z = 4) runs -x in a positive-area outline
    assert.deepEqual(leg, { a: [3, 4], b: [-1, 4], depth: 2.4 });
  });

  it('gives a wraparound a leg per wall, the first on past the corner', () => {
    const traced = [[-5, -4], [5, -4], [5, 0], [7.4, 0], [7.4, 6.4], [-5, 6.4]];
    const front = cutPart(traced, { minX: -6, maxX: 8, minZ: 4, maxZ: 7 });
    const side = cutPart(front.footprint, { minX: 5, maxX: 8, minZ: -1, maxZ: 4.5 });
    const [wrap] = normalizeRoofStructures(porchStructures(side.footprint, [front.porch, side.porch]).structures);
    const legs = porchLegs(wrap, VOLUMES[0]);
    assert.equal(legs.length, 2);
    // the front leg, from past the corner (x = 7.4) back along the front; the side leg up the +x wall from z = 0 to the corner
    samePoint(legs[0].a, [7.4, 4]);
    samePoint(legs[0].b, [-5, 4]);
    samePoint(legs[1].a, [5, 0]);
    samePoint(legs[1].b, [5, 4]);
    legs.forEach((leg) => near(leg.depth, 2.4));
  });
});

describe('gamePorchKind', () => {
  it('names the game kind nearest a porch', () => {
    assert.equal(gamePorchKind({ setback: -1.2, width: 2, roofType: 'shed' }), 'stoop');
    assert.equal(gamePorchKind({ setback: -2.4, width: 6, roofType: 'shed' }), 'shed_full');
    assert.equal(gamePorchKind({ setback: -2.4, width: 6, roofType: 'gable' }), 'gable_full');
    assert.equal(gamePorchKind({ setback: -2.4, width: 6, wrap: { walls: ['maxZ', 'maxX'] } }), 'wrap');
  });
});

describe('buildFootprintOverride', () => {
  const edited = new Date('2026-09-30T14:00:00.123Z');

  it('writes the outline in game coordinates, where the building is', async () => {
    const trace = toGameFrame([[-5.02, -4], [5, -4.01], [5, 4], [-5, 4]], PLACEMENT);
    const override = await buildFootprintOverride({ footprint: RECT, placement: { ...PLACEMENT, trace }, edited });
    assert.equal(override.format, OVERRIDE_FORMAT);
    assert.equal(override.version, 1);
    assert.equal(override.id, '115768678');
    assert.equal(override.source, 'building-composer');
    assert.equal(override.edited, '2026-09-30T14:00:00Z');
    assert.deepEqual(override.porches, []);
    toComposerFrame(override.footprint, PLACEMENT).forEach((point, i) => samePoint(point, RECT[i]));
    assert.deepEqual(override.based_on, { source: 'dixon_dem', hash: await outlineHash(trace) });
  });

  it("winds the outline as the game's trace does", async () => {
    const trace = toGameFrame([...RECT].reverse(), PLACEMENT);
    const override = await buildFootprintOverride({ footprint: RECT, placement: { ...PLACEMENT, trace }, edited });
    const sign = (points) => Math.sign(computeFootprintMetrics(points).signedArea);
    assert.equal(sign(override.footprint), sign(trace));
  });

  it("sends the porches made from the outline, in game coordinates, not others or recessed ones", async () => {
    const records = normalizeRoofStructures([
      { kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: 0, width: 4, setback: -2.4, depth: 2.4, baseHeight: 'ground', fromFootprint: true },
      { kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'minZ', offset: 0, width: 4, setback: -2.4, depth: 2.4, baseHeight: 'ground' },
      { kind: 'porch', mount: 'recess', hostVolumeId: 'volume-0', hostSide: 'maxX', offset: 0, width: 3, setback: 0, depth: 2, baseHeight: 'ground', fromFootprint: true },
    ]);
    const override = await buildFootprintOverride({
      footprint: RECT, placement: { ...PLACEMENT, trace: toGameFrame(RECT, PLACEMENT) }, structures: records, volumes: VOLUMES, edited,
    });
    assert.equal(override.porches.length, 1);
    const [porch] = override.porches;
    assert.equal(porch.kind, 'shed_full');
    const [leg] = porch.legs;
    samePoint(toComposerFrame([leg.a], PLACEMENT)[0], [2, 4]);
    samePoint(toComposerFrame([leg.b], PLACEMENT)[0], [-2, 4]);
    near(leg.depth, 2.4);
  });

  it("turns the legs round with the outline when the game's winding is the other way", async () => {
    const records = normalizeRoofStructures([
      { kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: 0, width: 4, setback: -2.4, depth: 2.4, baseHeight: 'ground', fromFootprint: true },
    ]);
    const override = await buildFootprintOverride({
      footprint: RECT, placement: { ...PLACEMENT, trace: toGameFrame([...RECT].reverse(), PLACEMENT) }, structures: records, volumes: VOLUMES, edited,
    });
    const [leg] = override.porches[0].legs;
    samePoint(toComposerFrame([leg.a], PLACEMENT)[0], [-2, 4]);
    samePoint(toComposerFrame([leg.b], PLACEMENT)[0], [2, 4]);
  });

  it('needs a building from the game', async () => {
    await assert.rejects(buildFootprintOverride({ footprint: RECT, placement: undefined }), RangeError);
  });
});
