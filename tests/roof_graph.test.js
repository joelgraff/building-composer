import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import {
  decomposeIntoVolumes,
  buildRoofGraph,
  computeFacadeLayout,
  serializeBuildingState,
  deserializeBuildingState,
} from '../js/facade.js';

const sampleFootprint = JSON.parse(readFileSync('./data/sample_footprint.json', 'utf8'));
const uFootprint = JSON.parse(readFileSync('./data/footprint_u.json', 'utf8'));

describe('Roof Graph & Edge Role Classification', () => {
  it('correctly classifies rectangular edges for hip roof (all eaves)', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const volumes = decomposeIntoVolumes(norm);
    const graph = buildRoofGraph(norm, volumes, { roofType: 'hip' });

    assert.equal(graph.edges.length, 4);
    assert.equal(graph.summary.eavesCount, 4);
    assert.equal(graph.summary.rakesCount, 0);
    assert.equal(graph.summary.flatCount, 0);
    graph.edges.forEach((e) => {
      assert.equal(e.role, 'eave');
      assert.equal(e.pitchRise, 6);
      assert.equal(e.pitchRun, 12);
    });
  });

  it('correctly classifies rectangular edges for gable roof (2 eaves, 2 rakes)', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const volumes = decomposeIntoVolumes(norm);
    // Longitudinal span is X (length 20, width 15), so ridgeAxis is 'x'
    const graph = buildRoofGraph(norm, volumes, { roofType: 'gable', roofDirection: 'z' });

    assert.equal(graph.summary.eavesCount, 2);
    assert.equal(graph.summary.rakesCount, 2);

    const eaves = graph.edges.filter((e) => e.role === 'eave');
    const rakes = graph.edges.filter((e) => e.role === 'rake');
    assert.equal(eaves.length, 2);
    assert.equal(rakes.length, 2);

    // Eaves are parallel to ridge (horizontal), rakes are perpendicular (vertical)
    eaves.forEach((e) => assert.equal(e.orientation, 'horizontal'));
    rakes.forEach((e) => assert.equal(e.orientation, 'vertical'));
  });

  it('correctly classifies rectangular edges for shed roof', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const volumes = decomposeIntoVolumes(norm);
    const graph = buildRoofGraph(norm, volumes, {
      roofType: 'shed',
      volumeRidgeDirections: { [volumes[0].id]: 'z-min' },
    });

    assert.equal(graph.summary.highPlatesCount, 1);
    assert.equal(graph.summary.eavesCount, 1);
    assert.equal(graph.summary.rakesCount, 2);
  });

  it('correctly classifies U-shaped multi-volume footprint edges', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, {
      roofType: 'gable',
      roofPitchRise: 7,
    });

    const graph = layout.roofGraph;
    assert.ok(graph);
    assert.equal(graph.zones.length, 3);
    assert.equal(graph.edges.length, 8);

    // In U-shape gable: 2 wing gable ends are rakes, remaining 6 edges are eaves
    assert.equal(graph.summary.rakesCount, 2);
    assert.equal(graph.summary.eavesCount, 6);

    // Verify all wall runs in layout carry the classified role and roofZoneId
    layout.wallRuns.forEach((run) => {
      assert.ok(['eave', 'rake', 'high-plate', 'flat'].includes(run.role));
      assert.ok(run.roofZoneId);
      assert.ok(run.volumeId);
    });
  });

  it('supports per-edge pitch overrides', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const volumes = decomposeIntoVolumes(norm);
    const graph = buildRoofGraph(norm, volumes, {
      roofType: 'hip',
      roofPitchRise: 6,
      edgePitchOverrides: {
        'wall-run-0': 10,
      },
    });

    const edge0 = graph.edges.find((e) => e.id === 'wall-run-0');
    const edge1 = graph.edges.find((e) => e.id === 'wall-run-1');
    assert.equal(edge0.pitchRise, 10);
    assert.equal(edge1.pitchRise, 6);
  });

  it('serializes and deserializes project state cleanly', () => {
    const norm = normalizeFootprint(sampleFootprint);
    const layout = computeFacadeLayout(norm);
    const modelConfig = {
      storyCount: 3,
      storyHeight: 3.5,
      wallMaterial: 'brick',
      roofType: 'gable',
      roofDirection: 'z',
      roofPitchRise: 8,
      roofPitchRun: 12,
      roofHeight: 4,
      roofEaveDepth: 0.4,
      roofHeightMode: 'slope',
      volumeStoryOverrides: { 'volume-0': 3 },
      volumeRidgeDirections: {},
      volumeRoofTypes: {},
      volumeRoofConnections: {},
      edgePitchOverrides: { 'wall-run-0': 8 },
    };

    const serialized = serializeBuildingState(layout, modelConfig);
    assert.equal(serialized.format, 'building-composer');
    assert.equal(serialized.version, 1);
    assert.equal(serialized.storyCount, 3);
    assert.equal(serialized.wallMaterial, 'brick');
    assert.ok(serialized.roofGraph);

    const deserialized = deserializeBuildingState(serialized);
    assert.equal(deserialized.valid, true);
    assert.equal(deserialized.state.storyCount, 3);
    assert.equal(deserialized.state.wallMaterial, 'brick');
    assert.equal(deserialized.state.roofPitchRise, 8);
    assert.equal(deserialized.state.edgePitchOverrides['wall-run-0'], 8);
  });
});
