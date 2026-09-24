import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateFootprint,
  computeFootprintMetrics,
  normalizeFootprint,
} from '../js/footprint.js';

const sampleFootprint = JSON.parse(readFileSync('./data/sample_footprint.json', 'utf8'));
const uFootprint = JSON.parse(readFileSync('./data/footprint_u.json', 'utf8'));
const lFootprint = JSON.parse(readFileSync('./data/footprint_l.json', 'utf8'));
const leanToFootprint = JSON.parse(readFileSync('./data/footprint_narrow_lean_to.json', 'utf8'));
const wideWingFootprint = JSON.parse(readFileSync('./data/footprint_wide_wing.json', 'utf8'));

describe('Footprint Validation & Metrics', () => {
  it('validates rectangular sample footprint', () => {
    const res = validateFootprint(sampleFootprint, { expectedWinding: 'CCW' });
    assert.equal(res.valid, true);
    assert.equal(res.errors.length, 0);
    assert.equal(res.metrics.area, 300);
    assert.equal(res.metrics.perimeter, 70);
    assert.deepEqual(res.metrics.centroid, { x: 10, z: 7.5 });
  });

  it('validates preset footprints (U, L, Lean-to, Wide-wing)', () => {
    [uFootprint, lFootprint, leanToFootprint, wideWingFootprint].forEach((fp) => {
      const res = validateFootprint(fp, { expectedWinding: 'CCW' });
      assert.equal(res.valid, true, `Footprint should be valid: ${JSON.stringify(res.errors)}`);
      assert.ok(res.metrics.area > 0);
    });
  });

  it('rejects footprint with fewer than 3 distinct vertices', () => {
    const res1 = validateFootprint([[0, 0], [10, 0]]);
    assert.equal(res1.valid, false);
    assert.ok(res1.errors.some((e) => e.includes('three distinct vertices')));

    const res2 = validateFootprint([[0, 0], [10, 0], [0, 0]]);
    assert.equal(res2.valid, false);
    assert.ok(res2.errors.some((e) => e.includes('three distinct vertices')));
  });

  it('detects self-intersecting polygon (bowtie)', () => {
    const bowtie = [[0, 0], [10, 10], [10, 0], [0, 10]];
    const res = validateFootprint(bowtie);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('self-intersections')));
  });

  it('detects and enforces expected winding (CCW vs CW)', () => {
    const cwRect = [[0, 0], [0, 10], [10, 10], [10, 0]];
    const ccwValidation = validateFootprint(cwRect, { expectedWinding: 'CCW' });
    assert.equal(ccwValidation.valid, false);
    assert.ok(ccwValidation.errors.some((e) => e.includes('counter-clockwise')));

    const cwValidation = validateFootprint(cwRect, { expectedWinding: 'CW' });
    assert.equal(cwValidation.valid, true);
  });

  it('normalizes footprint by centering around centroid origin', () => {
    const normalized = normalizeFootprint(sampleFootprint, { expectedWinding: 'CCW' });
    const metrics = computeFootprintMetrics(normalized);
    assert.ok(Math.abs(metrics.centroid.x) < 1e-6);
    assert.ok(Math.abs(metrics.centroid.z) < 1e-6);
    assert.equal(metrics.area, 300);
  });
});
