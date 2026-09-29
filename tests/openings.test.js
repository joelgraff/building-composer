import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpening, normalizeOpenings, createOpening, resolveOpening, openingOutline,
  OPENING_PRESETS, MIN_OPENING_SIZE, OPENING_EDGE_MARGIN, DOOR_SILL_MAX,
} from '../js/openings.js';

const wallRun = (overrides = {}) => ({
  id: 'wall-run-0',
  start: [-5, 5],
  end: [5, 5],
  length: 10,
  normal: [0, 1],
  right: [1, 0],
  baseY: 0,
  wallHeight: 3,
  ...overrides,
});

describe('normalizeOpening', () => {
  it('returns null without a host wall run', () => {
    assert.equal(normalizeOpening({ kind: 'window' }), null);
    assert.equal(normalizeOpening(null), null);
  });

  it('fills a window from its preset', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0' });
    assert.equal(opening.kind, 'window');
    assert.equal(opening.width, OPENING_PRESETS.window.width);
    assert.equal(opening.height, OPENING_PRESETS.window.height);
    assert.equal(opening.sillHeight, OPENING_PRESETS.window.sillHeight);
  });

  it('fills a door from its preset, sill near the floor', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', kind: 'door' });
    assert.equal(opening.width, OPENING_PRESETS.door.width);
    assert.equal(opening.sillHeight, 0);
  });

  it('clamps a door sill to the threshold range even if asked for more', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', kind: 'door', sillHeight: 0.9 });
    assert.equal(opening.sillHeight, DOOR_SILL_MAX);
  });

  it('leaves a window sill free', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', kind: 'window', sillHeight: 1.8 });
    assert.equal(opening.sillHeight, 1.8);
  });

  it('clamps width/height to the minimum opening size', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', width: 0.01, height: -1 });
    assert.equal(opening.width, MIN_OPENING_SIZE);
    assert.equal(opening.height, MIN_OPENING_SIZE);
  });

  it('keeps a materials object, dropping anything not a plain object', () => {
    assert.deepEqual(normalizeOpening({ hostWallRunId: 'wall-run-0', materials: { frame: 'brick' } }).materials, { frame: 'brick' });
    assert.deepEqual(normalizeOpening({ hostWallRunId: 'wall-run-0', materials: 'brick' }).materials, {});
  });
});

describe('normalizeOpenings / createOpening', () => {
  it('assigns unique opening-N ids, keeping a valid existing id', () => {
    const openings = normalizeOpenings([
      { hostWallRunId: 'wall-run-0', id: 'opening-1' },
      { hostWallRunId: 'wall-run-0' },
      { hostWallRunId: 'wall-run-0', id: 'opening-1' },
    ]);
    assert.equal(openings.length, 3);
    assert.equal(new Set(openings.map((o) => o.id)).size, 3);
    assert.ok(openings[0].id === 'opening-1');
  });

  it('drops unplaceable raw records (no host)', () => {
    const openings = normalizeOpenings([{ hostWallRunId: 'wall-run-0' }, { kind: 'door' }]);
    assert.equal(openings.length, 1);
  });

  it('createOpening builds one record with an id not already used', () => {
    const existing = normalizeOpenings([{ hostWallRunId: 'wall-run-0' }]);
    const created = createOpening('door', { hostWallRunId: 'wall-run-0' }, existing);
    assert.equal(created.kind, 'door');
    assert.notEqual(created.id, existing[0].id);
  });
});

describe('resolveOpening', () => {
  it('resolves a centered window with no errors or warnings', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', offset: 0, width: 1, height: 1.4, sillHeight: 0.9 });
    const { resolved, errors, warnings } = resolveOpening(opening, wallRun());
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.ok(resolved);
    assert.equal(resolved.u0, -0.5);
    assert.equal(resolved.u1, 0.5);
    assert.equal(resolved.v0, 0.9);
    assert.equal(resolved.v1, 2.3);
    assert.deepEqual(resolved.frame.start, [-5, 5]);
  });

  it('reports no-host when the wall run is missing', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-9' });
    const { resolved, errors } = resolveOpening(opening, null);
    assert.equal(resolved, null);
    assert.equal(errors[0].code, 'no-host');
  });

  it('flags outside-wall when it runs past the end of a short wall', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', offset: 4, width: 2 });
    const { resolved, errors } = resolveOpening(opening, wallRun({ length: 10 }));
    assert.equal(resolved, null);
    assert.equal(errors[0].code, 'outside-wall');
  });

  it('flags above-wall when the top exceeds the wall height', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', sillHeight: 2, height: 2 });
    const { errors } = resolveOpening(opening, wallRun({ wallHeight: 3 }));
    assert.equal(errors[0].code, 'above-wall');
  });

  it('flags overlap against a sibling on the same wall, ignoring one on a different wall', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', offset: 0, width: 1 });
    const overlapping = { id: 'opening-2', hostWallRunId: 'wall-run-0', offset: 0.5, width: 1 };
    const elsewhere = { id: 'opening-3', hostWallRunId: 'wall-run-1', offset: 0, width: 1 };
    const { errors: withOverlap } = resolveOpening(opening, wallRun(), { siblings: [overlapping] });
    assert.equal(withOverlap[0].code, 'overlap');
    const { errors: withoutOverlap } = resolveOpening(opening, wallRun(), { siblings: [elsewhere] });
    assert.deepEqual(withoutOverlap, []);
  });

  it('does not overlap against its own record in the siblings list', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', id: 'opening-1', offset: 0, width: 1 });
    const { errors } = resolveOpening(opening, wallRun(), { siblings: [opening] });
    assert.deepEqual(errors, []);
  });

  it('warns (not errors) when the opening crosses a story boundary short of the wall top', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', sillHeight: 2.7, height: 1 });
    const stories = [{ minY: 0, maxY: 3 }, { minY: 3, maxY: 6 }];
    const { resolved, errors, warnings } = resolveOpening(opening, wallRun({ wallHeight: 6 }), { stories });
    assert.deepEqual(errors, []);
    assert.ok(resolved);
    assert.equal(warnings[0].code, 'crosses-story');
  });

  it('respects the edge margin at the very end of a wall', () => {
    const halfLength = 5;
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', offset: halfLength - 1 - OPENING_EDGE_MARGIN / 2, width: 2 });
    const { errors } = resolveOpening(opening, wallRun({ length: halfLength * 2 }));
    assert.equal(errors[0]?.code, 'outside-wall');
  });
});

describe('openingOutline', () => {
  it('the outer casing rectangle is larger than the inner opening on every side', () => {
    const opening = normalizeOpening({ hostWallRunId: 'wall-run-0', offset: 0, width: 1, height: 1.4, sillHeight: 0.9 });
    const { resolved } = resolveOpening(opening, wallRun());
    const { outer, inner } = openingOutline(resolved);
    const [innerU0, innerV0] = inner[0];
    const [outerU0, outerV0] = outer[0];
    assert.ok(outerU0 < innerU0);
    assert.ok(outerV0 < innerV0);
    const [innerU1, innerV1] = inner[2];
    const [outerU1, outerV1] = outer[2];
    assert.ok(outerU1 > innerU1);
    assert.ok(outerV1 > innerV1);
  });
});
