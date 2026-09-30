import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpening, normalizeOpenings, createOpening, resolveOpening, openingOutline, structureOpeningHost, rectInShape, fitOpening, shapeLimit, stepFlight, normalizeSteps, flightFor,
  STEP_TREAD, STEP_LANDING, STEP_SIDE_MARGIN,
  OPENING_PRESETS, FRAME_CASING_WIDTH, MIN_OPENING_SIZE, OPENING_EDGE_MARGIN, DOOR_SILL_MAX,
} from '../js/openings.js';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';
import { RAILING_DEFAULTS, NEWEL } from '../js/railings.js';

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

describe('windows on a roof structure\'s own walls', () => {
  // a gable dormer's face as facadeWallRun gives it: 2.4 wide, walls 1.4 high, its gable peaking at 2.4
  const dormerFace = {
    id: 'wall-run-d-front',
    start: [1.2, -4],
    end: [-1.2, -4],
    length: 2.4,
    normal: [0, -1],
    baseY: 7,
    pieces: [
      [[0, 0], [2.4, 0], [2.4, 1.4]], [[0, 0], [2.4, 1.4], [0, 1.4]], [[0, 1.4], [2.4, 1.4], [1.2, 2.4]],
    ],
    extent: { minU: 0, maxU: 2.4, minV: 0, maxV: 2.4 },
  };

  it('puts the wall in the footprint walls\' frame: u from its middle, the same handedness', () => {
    const host = structureOpeningHost(dormerFace);
    assert.deepEqual(host.right, [1, 0]);
    // (right, normal) as wallRunFrame pairs them: normal = (right.z, -right.x)
    assert.deepEqual([host.right[1], -host.right[0]].map((c) => c + 0), dormerFace.normal);
    assert.deepEqual([host.start, host.end], [dormerFace.end, dormerFace.start]);
    assert.equal(host.wallHeight, 2.4);
    const us = host.shape.flat().map(([u]) => u);
    assert.deepEqual([Math.min(...us), Math.max(...us)], [-1.2, 1.2]);
  });

  it('knows which rectangles lie on the visible face', () => {
    const { shape } = structureOpeningHost(dormerFace);
    assert.equal(rectInShape(-0.5, 0.2, 0.5, 1.3, shape), true);
    assert.equal(rectInShape(-0.5, 0.2, 0.5, 1.8, shape), true, 'up into the gable, clear of its slopes');
    assert.equal(rectInShape(-1, 0.2, 1, 2.2, shape), false, 'through the gable\'s slopes');
  });

  it('refuses a window whose frame runs into the dormer\'s roof', () => {
    const host = structureOpeningHost(dormerFace);
    const { errors } = resolveOpening(normalizeOpening({ hostWallRunId: dormerFace.id, kind: 'window', width: 1.6, height: 1.9, sillHeight: 0.2 }), host);
    assert.deepEqual(errors.map((e) => e.code), ['outside-shape']);
  });

  it('fits a new window onto a face too small for the preset', () => {
    const host = structureOpeningHost(dormerFace);
    const preset = createOpening('window', { hostWallRunId: dormerFace.id });
    assert.ok(resolveOpening(preset, host).errors.length, 'the preset does not fit');
    const fitted = fitOpening(preset, host);
    assert.equal(resolveOpening(fitted, host).errors.length, 0);
    assert.equal(fitted.offset, 0);
    assert.ok(fitted.sillHeight > FRAME_CASING_WIDTH && fitted.height >= MIN_OPENING_SIZE && fitted.height <= preset.height);
    assert.deepEqual(fitOpening(normalizeOpening({ hostWallRunId: dormerFace.id, sillHeight: 0.2, height: 1, width: 0.8 }), host).width, 0.8, 'one that fits is left alone');
  });

  it('finds how far a field can go before the frame leaves the face', () => {
    const host = structureOpeningHost(dormerFace);
    const window = normalizeOpening({ hostWallRunId: dormerFace.id, width: 0.6, height: 0.8, sillHeight: 0.2 });
    const tallest = shapeLimit(window, host, 'height', 0.3, 3);
    // the frame's top corners (0.39 out from the middle) meet the gable slopes: v = 1.4 + (1.2 - 0.39) / 1.2
    assert.ok(Math.abs(tallest + 0.2 + FRAME_CASING_WIDTH - (1.4 + (1.2 - 0.39) / 1.2)) < 1e-3, `${tallest}`);
    assert.ok(Math.abs(shapeLimit(window, host, 'offset', 0, 5) - (1.2 - 0.39)) < 1e-3);
    assert.equal(shapeLimit({ ...window, height: 3 }, host, 'height', 3, 4), 3, 'starting outside, it stays put');
  });

  it('builds on a real dormer, standing out from its face, and saves with it', () => {
    const footprint = [[-6, -4], [6, -4], [6, 4], [-6, 4]];
    const layout = computeFacadeLayout(footprint, { storyCount: 2, storyHeight: 3 });
    const roofStructures = normalizeRoofStructures([{ id: 'd', kind: 'dormer', hostVolumeId: 'volume-0', hostSide: 'minZ', offset: 0, width: 2.4, setback: 0.6 }]);
    const config = {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 10, roofPitchRun: 12,
      roofHeight: (10 / 12) * 4, roofEaveDepth: 0.4, volumes: layout.volumes, facadeLayout: layout, roofStructures,
    };
    const face = createBuildingFromFootprint(footprint, config).structureFacades[0].wallRuns.find((run) => run.wall === 'front');
    const window = fitOpening(createOpening('window', { hostWallRunId: face.id }), structureOpeningHost(face));
    const built = createBuildingFromFootprint(footprint, { ...config, openings: [window] });
    assert.deepEqual(built.openings[0].errors, []);
    built.building.updateMatrixWorld(true);
    let frame;
    built.building.traverse((mesh) => { if (mesh.userData?.bodyPart === 'opening-frame') frame = mesh; });
    const position = frame.geometry.getAttribute('position');
    const outward = [];
    const ys = [];
    for (let i = 0; i < position.count; i += 1) {
      const p = { x: position.getX(i), y: position.getY(i), z: position.getZ(i) };
      const e = frame.matrixWorld.elements;
      const world = [e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12], e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13], e[2] * p.x + e[6] * p.y + e[10] * p.z + e[14]];
      outward.push((world[0] - face.start[0]) * face.normal[0] + (world[2] - face.start[1]) * face.normal[1]);
      ys.push(world[1]);
    }
    assert.ok(Math.min(...outward) > 0, 'the frame stands proud of the dormer face, not inside it');
    assert.ok(Math.min(...ys) >= face.baseY - 1e-6, 'and sits on the dormer, not down on the house');

    const saved = serializeBuildingState(layout, { roofStructures, openings: [window] });
    assert.equal(deserializeBuildingState(saved).state.openings.length, 1);
    const withoutDormer = deserializeBuildingState({ ...saved, roofStructures: [] });
    assert.equal(withoutDormer.state.openings.length, 0);
    assert.ok(withoutDormer.warnings.some((w) => w.includes(face.id)));
  });
});

describe('entry steps', () => {
  it('a door has steps unless turned off; a window never does', () => {
    assert.deepEqual(normalizeOpening({ hostWallRunId: 'wall-run-0', kind: 'door' }).steps, {
      enabled: true, width: null, tread: STEP_TREAD, riser: 0.18, count: null, offset: 0, landing: null, direction: 'front', railings: { ...RAILING_DEFAULTS, enabled: false },
    });
    assert.equal(normalizeOpening({ hostWallRunId: 'wall-run-0', kind: 'door', steps: false }).steps.enabled, false, 'an older file\'s plain off');
    assert.equal(normalizeOpening({ hostWallRunId: 'wall-run-0', kind: 'door', steps: true }).steps.enabled, true);
    assert.equal('steps' in normalizeOpening({ hostWallRunId: 'wall-run-0', kind: 'window', steps: true }), false);
  });

  it('divides the rise into even risers near 18 cm, with a landing at the door', () => {
    const flight = stepFlight(0.7);
    assert.equal(flight.count, 4);
    assert.ok(Math.abs(flight.riser - 0.175) < 1e-9);
    assert.ok(Math.abs(flight.depth - (STEP_LANDING + 3 * STEP_TREAD)) < 1e-9);
    // each riser climbs one step toward the wall: out decreases as up increases
    const tops = flight.profile.filter(([, up]) => up > 0);
    assert.deepEqual(tops.at(-1), [0, 0.7]);
    assert.deepEqual(tops.at(-2), [STEP_LANDING, 0.7]);
    assert.equal(stepFlight(0.02), null, 'a threshold at grade needs none');
    assert.equal(stepFlight(0.1).count, 1);
  });

  const footprint = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
  const build = (openings, extra = {}) => {
    const layout = computeFacadeLayout(footprint, {});
    return createBuildingFromFootprint(footprint, {
      storyCount: 1, storyHeight: 3, foundationDepth: 0.7, roofType: 'gable', roofDirection: 'x', roofHeight: 2,
      volumes: layout.volumes, facadeLayout: layout, openings: normalizeOpenings(openings), ...extra,
    });
  };
  const stepsOf = (built) => {
    const found = [];
    built.building.updateMatrixWorld(true);
    built.building.traverse((mesh) => {
      if (mesh.userData?.bodyPart === 'opening-steps') {
        mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
        found.push({ mesh, box });
      }
    });
    return found;
  };

  it('runs from a house door\'s threshold straight out and down to grade, in the foundation\'s material', () => {
    const [{ mesh, box }] = stepsOf(build([{ kind: 'door', hostWallRunId: 'wall-run-0', offset: 1 }]));
    // wall-run-0 is the z = -4 wall, facing -z
    assert.ok(Math.abs(box.max.z - -4) < 1e-6 && Math.abs(box.min.z - (-4 - stepFlight(0.7).depth)) < 1e-6);
    assert.ok(Math.abs(box.min.y) < 1e-6 && Math.abs(box.max.y - 0.7) < 1e-6);
    const halfWidth = 0.9 / 2 + FRAME_CASING_WIDTH + STEP_SIDE_MARGIN;
    assert.ok(Math.abs(box.min.x - (1 - halfWidth)) < 1e-6 && Math.abs(box.max.x - (1 + halfWidth)) < 1e-6);
    assert.equal(mesh.material.userData.role, 'foundation');
  });

  it('builds none when turned off, at grade, or for a window', () => {
    assert.equal(stepsOf(build([{ kind: 'door', hostWallRunId: 'wall-run-0', steps: false }])).length, 0);
    assert.equal(stepsOf(build([{ kind: 'door', hostWallRunId: 'wall-run-0' }], { foundationDepth: 0 })).length, 0);
    assert.equal(stepsOf(build([{ kind: 'window', hostWallRunId: 'wall-run-0' }])).length, 0);
  });

  it('a porch deck is its own top step: its flight starts a riser below', () => {
    const flight = stepFlight(0.7, { landing: 0 });
    assert.ok(Math.abs(Math.max(...flight.profile.map(([, up]) => up)) - 0.525) < 1e-9);
    assert.ok(Math.abs(flight.depth - 3 * STEP_TREAD) < 1e-9);
    assert.equal(stepFlight(0.18, { landing: 0 }), null, 'a deck one step up needs none');
  });

  const porch = (fields = {}) => ({
    id: 'p', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'minZ', offset: 1, width: 5, setback: -2.4, depth: 2.4, baseHeight: 'ground', wallHeight: 2.8,
    roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'], ...fields,
  });
  const porchStepsOf = (built) => {
    const found = [];
    built.building.updateMatrixWorld(true);
    built.building.traverse((mesh) => {
      if (mesh.userData?.bodyPart === 'porch-steps') {
        mesh.geometry.computeBoundingBox();
        found.push(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
      }
    });
    return found;
  };

  it('runs steps from a ground porch\'s open front, and none from a door the porch stands in front of', () => {
    const built = build([{ kind: 'door', hostWallRunId: 'wall-run-0', offset: 1 }, { kind: 'door', hostWallRunId: 'wall-run-2' }], {
      roofStructures: normalizeRoofStructures([porch()]),
    });
    const [box] = porchStepsOf(built);
    // the porch front is at z = -4 - 2.4, facing -z; centered on the porch (x = 1)
    assert.ok(Math.abs(box.max.z - -6.4) < 1e-6 && Math.abs(box.min.z - (-6.4 - 3 * STEP_TREAD)) < 1e-6);
    assert.ok(Math.abs((box.min.x + box.max.x) / 2 - 1) < 1e-6 && Math.abs(box.max.x - box.min.x - 1.5) < 1e-6);
    assert.ok(Math.abs(box.max.y - 0.525) < 1e-6);
    const doorSteps = stepsOf(built).map(({ mesh }) => mesh.userData.openingId);
    assert.deepEqual(doorSteps, ['opening-2'], 'the door onto the porch has none; the one on the far wall keeps its own');
  });

  it('none from a porch closed at the front, or raised on posts to an upper floor', () => {
    assert.equal(porchStepsOf(build([], { roofStructures: normalizeRoofStructures([porch({ openSides: ['left', 'right'] })]) })).length, 0);
    assert.equal(porchStepsOf(build([], { storyCount: 2, roofStructures: normalizeRoofStructures([porch({ baseHeight: 3, support: 'posts' })]) })).length, 0);
  });

  it('keeps sizes in range; a count of steps is whole', () => {
    const steps = normalizeSteps({
      width: 20, tread: 0.1, riser: 0.4, count: 3.6, landing: 9, direction: 'up',
    });
    assert.deepEqual(steps, {
      enabled: true, width: 8, tread: 0.2, riser: 0.25, count: 4, offset: 0, landing: 4, direction: 'front', railings: { ...RAILING_DEFAULTS, enabled: false },
    });
  });

  it('sizes a flight by its riser height, or by a number of steps', () => {
    const byRiser = flightFor(normalizeSteps({ riser: 0.14, tread: 0.35 }), 0.7);
    assert.equal(byRiser.built, 5);
    assert.ok(Math.abs(byRiser.depth - (STEP_LANDING + 4 * 0.35)) < 1e-9);
    const byCount = flightFor(normalizeSteps({ count: 2 }), 0.7);
    assert.equal(byCount.built, 2);
    assert.ok(Math.abs(byCount.riser - 0.35) < 1e-9);
    // a porch's deck is its top step: two steps below it are three risers
    const porchFlight = flightFor(normalizeSteps({ count: 2 }), 0.7, { deck: true });
    assert.equal(porchFlight.built, 2);
    assert.ok(Math.abs(porchFlight.riser - 0.7 / 3) < 1e-9);
  });

  it('builds a door\'s steps as wide as set, and a porch\'s as wide and deep as set', () => {
    const [{ box }] = stepsOf(build([{
      kind: 'door', hostWallRunId: 'wall-run-0', offset: 1, steps: { width: 2.4, tread: 0.4, count: 2 },
    }]));
    assert.ok(Math.abs(box.max.x - box.min.x - 2.4) < 1e-6);
    assert.ok(Math.abs(-4 - box.min.z - (STEP_LANDING + 0.4)) < 1e-6);
    const [porchBox] = porchStepsOf(build([], { roofStructures: normalizeRoofStructures([porch({ steps: { width: 3, tread: 0.5, count: 2 } })]) }));
    assert.ok(Math.abs(porchBox.max.x - porchBox.min.x - 3) < 1e-6);
    // two steps below the deck, three risers: the flight runs out (3 - 1) treads
    assert.ok(Math.abs(porchBox.max.z - porchBox.min.z - 2 * 0.5) < 1e-6);
    assert.equal(porchStepsOf(build([], { roofStructures: normalizeRoofStructures([porch({ steps: { enabled: false } })]) })).length, 0);
  });

  it('a deeper landing pushes a straight flight out', () => {
    const [{ box }] = stepsOf(build([{ kind: 'door', hostWallRunId: 'wall-run-0', offset: 1, steps: { landing: 2 } }]));
    assert.ok(Math.abs(-4 - box.min.z - (2 + 3 * STEP_TREAD)) < 1e-6);
  });

  it('a stoop: a landing, and a flight down along the wall to either side of it', () => {
    // wall-run-0 is the z = -4 wall, facing -z: seen from outside (looking toward +z), left is +x
    const halfWidth = 0.9 / 2 + FRAME_CASING_WIDTH + STEP_SIDE_MARGIN;
    const flightDepth = 3 * STEP_TREAD; // 0.7 m: four risers, the landing the top step
    const stoop = (direction) => stepsOf(build([{
      kind: 'door', hostWallRunId: 'wall-run-0', offset: 1, steps: { landing: 1.5, direction },
    }]))[0];
    const left = stoop('left');
    assert.ok(Math.abs(left.box.min.z - -5.5) < 1e-6 && Math.abs(left.box.max.z - -4) < 1e-6, 'as deep as the landing');
    assert.ok(Math.abs(left.box.min.x - (1 - halfWidth)) < 1e-6 && Math.abs(left.box.max.x - (1 + halfWidth + flightDepth)) < 1e-6, 'running off its left side');
    assert.ok(Math.abs(left.box.max.y - 0.7) < 1e-6 && Math.abs(left.box.min.y) < 1e-6);
    const right = stoop('right');
    assert.ok(Math.abs(right.box.max.x - (1 + halfWidth)) < 1e-6 && Math.abs(right.box.min.x - (1 - halfWidth - flightDepth)) < 1e-6, 'or its right');
    // the flight steps down away from the landing: one riser high at its far end
    const p = left.mesh.geometry.getAttribute('position');
    const e = left.mesh.matrixWorld.elements;
    let farTop = 0;
    for (let i = 0; i < p.count; i += 1) {
      const [x, y, z] = [p.getX(i), p.getY(i), p.getZ(i)];
      const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
      const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
      if (wx > left.box.max.x - 0.2) farTop = Math.max(farTop, wy);
    }
    assert.ok(Math.abs(farTop - 0.7 / 4) < 1e-6, `${farTop}`);
  });

  const railingOf = (built) => {
    const points = [];
    built.building.updateMatrixWorld(true);
    built.building.traverse((mesh) => {
      if (mesh.userData?.bodyPart === 'railing') {
        const p = mesh.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i += 1) points.push([p.getX(i), p.getY(i), p.getZ(i)]);
      }
    });
    return points;
  };

  it('rails a door\'s flight when asked: level along the landing, sloping down the flight, a newel at its foot', () => {
    assert.equal(railingOf(build([{ kind: 'door', hostWallRunId: 'wall-run-0', offset: 1 }])).length, 0, 'off unless turned on');
    const points = railingOf(build([{ kind: 'door', hostWallRunId: 'wall-run-0', offset: 1, steps: { railings: { enabled: true } } }]));
    assert.ok(points.length > 0);
    // wall-run-0 faces -z from z = -4: the flight's foot is at z = -4 - (0.9 + 3 * 0.28)
    const foot = -4 - (STEP_LANDING + 3 * STEP_TREAD);
    assert.ok(Math.abs(Math.min(...points.map(([, , z]) => z)) - (foot - NEWEL.width / 2)) < 0.06, 'down to the flight\'s foot');
    const topAt = (z) => Math.max(...points.filter(([, , pz]) => Math.abs(pz - z) < 0.05).map(([, y]) => y));
    // (a rail's corners are at its ends: sample by the wall, where the landing's rail starts)
    assert.ok(Math.abs(topAt(-4.02) - (0.7 + 1)) < 1e-6, 'level along the landing');
    assert.ok(topAt(-5.2) < 0.7 + 1 - 0.1, 'sloping down the flight');
  });

  it('rails a stoop round its landing and down its flight\'s outer side, not against the wall', () => {
    const points = railingOf(build([{
      kind: 'door', hostWallRunId: 'wall-run-0', offset: 1, steps: { landing: 1.5, direction: 'left', railings: { enabled: true } },
    }]));
    assert.ok(points.length > 0);
    // the flight runs toward +x off the landing; its only railing is along the landing's front edge line
    const alongFlight = points.filter(([x]) => x > 1 + 0.9 / 2 + FRAME_CASING_WIDTH + STEP_SIDE_MARGIN + 0.1);
    assert.ok(alongFlight.length > 0 && alongFlight.every(([, , z]) => z < -5.3), 'on its outer side only');
  });

  it('rails a porch\'s steps down both sides when asked', () => {
    const points = railingOf(build([], {
      roofStructures: normalizeRoofStructures([porch({ railings: { enabled: false }, steps: { railings: { enabled: true, style: 'bars' } } })]),
    }));
    // the flight comes down from the porch front at z = -6.4, 1.5 m wide round x = 1
    assert.ok(points.length > 0);
    assert.ok(points.every(([x, , z]) => z <= -6.4 + 1e-6 && Math.abs(x - 1) <= 0.75 + 1e-6));
    assert.ok(points.some(([x]) => x < 1 - 0.6) && points.some(([x]) => x > 1 + 0.6), 'both sides');
  });

  const leftOff = (built, id) => built.openings.find((entry) => entry.id === id).warnings.find((w) => w.code === 'steps-left-off')?.message;

  it('says why a door\'s steps were left off: a porch in front of it', () => {
    const built = build([{ id: 'd', kind: 'door', hostWallRunId: 'wall-run-0', offset: 1 }], { roofStructures: normalizeRoofStructures([porch()]) });
    assert.match(leftOff(built, 'd'), /porch/);
    assert.deepEqual(built.openings[0].errors, [], 'the door itself still builds');
  });

  it('... another door\'s steps in the way', () => {
    const built = build(normalizeOpenings([
      { id: 'a', kind: 'door', hostWallRunId: 'wall-run-0', offset: -1.5, steps: { landing: 1.5, direction: 'left' } },
      // a's flight runs toward +x (its left, facing -z) to x = 0.03; b's straight flight stands from x = -0.19
      { id: 'b', kind: 'door', hostWallRunId: 'wall-run-0', offset: 0.5 },
    ]));
    assert.equal(leftOff(built, 'a'), undefined);
    assert.match(leftOff(built, 'b'), /another flight/);
    assert.equal(stepsOf(built).length, 1);
  });

  it('... the house itself, where a stoop\'s flight runs into an inside corner', () => {
    const ell = [[-6, -4], [6, -4], [6, 0], [0, 0], [0, 4], [-6, 4]];
    const layout = computeFacadeLayout(ell, { volumeSplit: 'auto' });
    // the wall along z = 0 from x = 6 to 0, facing +z; the wing's wall rises at x = 0
    const wall = layout.wallRuns.find((run) => Math.abs(run.start[1]) < 1e-9 && Math.abs(run.end[1]) < 1e-9);
    const built = createBuildingFromFootprint(ell, {
      storyCount: 1, storyHeight: 3, foundationDepth: 0.7, roofType: 'gable', roofDirection: 'x', roofHeight: 2,
      volumes: layout.volumes, facadeLayout: layout,
      openings: normalizeOpenings(['left', 'right'].map((direction, i) => ({
        id: `s${i}`, kind: 'door', hostWallRunId: wall.id, offset: (i === 0 ? 1 : -1) * 2.2, steps: { landing: 1.2, direction },
      }))),
    });
    const messages = ['s0', 's1'].map((id) => leftOff(built, id));
    assert.ok(messages.some((m) => /house/.test(m ?? '')), `${messages}`);
    assert.ok(messages.some((m) => m === undefined), 'the one running away from the corner builds');
  });

  it('saves whether a door has steps', () => {
    const layout = computeFacadeLayout(footprint, {});
    const openings = normalizeOpenings([{ kind: 'door', hostWallRunId: 'wall-run-0', steps: false }, { kind: 'door', hostWallRunId: 'wall-run-1', offset: 2 }]);
    const { state } = deserializeBuildingState(serializeBuildingState(layout, { openings }));
    assert.deepEqual(state.openings.map((opening) => opening.steps.enabled), [false, true]);
  });
});
