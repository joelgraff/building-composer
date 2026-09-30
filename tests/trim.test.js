import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrim, hasTrim, courseProfile, profileExtent, subtractIntervals, triangulatePolygon, sweepCourse, miterVector,
  dentilTriangles, dentilSize, floorLines, TRIM_DEFAULTS, normalizeWallTrim, courseOn, cornerTriangles,
} from '../js/trim.js';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { gameMaterial } from '../js/game-export.js';
import { normalizeRoofStructures } from '../js/roof-structures.js';

const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];

/** A footprint's wall runs as sweepCourse takes them, every run carrying the course at `y`. */
function ringOf(footprint, y = 1) {
  const layout = computeFacadeLayout(footprint, {});
  return layout.wallRuns.map((run) => ({
    start: run.start, end: run.end, normal: run.normal, y,
  }));
}

const polygonArea = (points) => Math.abs(points.reduce((sum, [x, y], i) => {
  const [nx, ny] = points[(i + 1) % points.length];
  return sum + (x * ny - nx * y);
}, 0)) / 2;

describe('trim settings', () => {
  it('an old file (no trim) or a partial one normalizes to every course off, at default sizes', () => {
    const trim = normalizeTrim(undefined);
    assert.equal(trim.material, TRIM_DEFAULTS.material);
    assert.equal(trim.waterTable.enabled, false);
    assert.equal(trim.cornice.dentils, false);
    assert.equal(trim.cornice.height, TRIM_DEFAULTS.cornice.height);
    assert.equal(hasTrim(trim), false);
    assert.equal(hasTrim(normalizeTrim({ beltCourse: { enabled: true } })), true);
  });

  it('clamps sizes into range and ignores junk', () => {
    const trim = normalizeTrim({ cornice: { enabled: true, height: 50, projection: -1, dentils: 'yes' }, waterTable: { height: 'x' } });
    assert.equal(trim.cornice.height, 1.2);
    assert.equal(trim.cornice.projection, 0.01);
    assert.equal(trim.cornice.dentils, false);
    assert.equal(trim.waterTable.height, TRIM_DEFAULTS.waterTable.height);
  });
});

describe('trim geometry helpers', () => {
  it('subtracts cuts from a run, dropping slivers', () => {
    assert.deepEqual(subtractIntervals(10, [[2, 3], [2.5, 4], [9.99, 12]]), [[0, 2], [4, 9.99]]);
    assert.deepEqual(subtractIntervals(10, [[-1, 11]]), []);
  });

  it('triangulates every profile, concave cornice included, into its own area', () => {
    ['waterTable', 'beltCourse', 'cornice'].forEach((kind) => {
      const profile = courseProfile(kind, { height: 0.3, projection: 0.2 });
      const triangles = triangulatePolygon(profile);
      assert.equal(triangles.length, profile.length - 2, kind);
      const area = triangles.reduce((sum, [a, b, c]) => sum + polygonArea([profile[a], profile[b], profile[c]]), 0);
      assert.ok(Math.abs(area - polygonArea(profile)) < 1e-9, kind);
    });
  });

  it('anchors each profile where its course is set out from', () => {
    assert.deepEqual(profileExtent(courseProfile('waterTable', { height: 0.3, projection: 0.1 })), { min: 0, max: 0.3 });
    assert.deepEqual(profileExtent(courseProfile('beltCourse', { height: 0.2, projection: 0.1 })), { min: -0.1, max: 0.1 });
    assert.deepEqual(profileExtent(courseProfile('cornice', { height: 0.3, projection: 0.1 })), { min: -0.3, max: 0 });
  });

  it('a miter keeps the offset the same distance off both walls, outside or inside a corner', () => {
    const m = miterVector([0, -1], [1, 0]);
    assert.deepEqual(m, [1, -1]);
    assert.deepEqual(miterVector([1, 0], [1, 0]), [1, 0]);
  });

  it('floor lines fall between stories, and under a half story', () => {
    assert.deepEqual(floorLines(1, 3), []);
    assert.deepEqual(floorLines(3, 3), [3, 6]);
    assert.deepEqual(floorLines(2, 3, true), [3, 6]);
  });
});

describe('sweeping a course round the walls', () => {
  const profile = courseProfile('beltCourse', { height: 0.2, projection: 0.1 });
  const faceCount = profile.length - 1; // the edge against the wall has no face

  it('a course all the way round a box is mitered at every corner, with no end caps', () => {
    const triangles = sweepCourse(ringOf(RECT), profile);
    assert.equal(triangles.length, 4 * faceCount * 2);
    const points = triangles.flat();
    const maxX = Math.max(...points.map(([x]) => x));
    const maxZ = Math.max(...points.map(([, , z]) => z));
    assert.ok(Math.abs(maxX - 5.1) < 1e-9 && Math.abs(maxZ - 4.1) < 1e-9, 'stands out by its projection');
    assert.ok(points.some(([x, , z]) => Math.abs(x - 5.1) < 1e-9 && Math.abs(z - 4.1) < 1e-9), 'the corner is mitered out to the diagonal');
  });

  it('miters inside corners too (an L), again with no caps', () => {
    const ell = [[-6, -4], [6, -4], [6, 0], [0, 0], [0, 4], [-6, 4]];
    const triangles = sweepCourse(ringOf(ell), profile);
    assert.equal(triangles.length, 6 * faceCount * 2);
    // the inside corner (0, 0): its miter point sits in the notch, off both walls
    assert.ok(triangles.flat().some(([x, , z]) => Math.abs(x - 0.1) < 1e-9 && Math.abs(z - 0.1) < 1e-9));
  });

  it('ends square with a cap where the next wall carries it at another height, or not at all', () => {
    const ring = ringOf(RECT);
    ring[2] = { ...ring[2], y: null };
    ring[3] = { ...ring[3], y: 2 };
    const capTriangles = profile.length - 2;
    const triangles = sweepCourse(ring, profile);
    // run 1 ends at the missing run 2; run 3 (another height) is capped at both ends; run 0 starts at run 3
    assert.equal(triangles.length, 3 * faceCount * 2 + 4 * capTriangles);
  });

  it('miters only where runs meet: a chain open at one side ends square there', () => {
    const ring = ringOf(RECT);
    const open = [ring[1], ring[2], ring[3]]; // three walls of a box, the fourth left out
    const capTriangles = profile.length - 2;
    assert.equal(sweepCourse(open, profile).length, 3 * faceCount * 2 + 2 * capTriangles);
  });

  it('breaks around a cut, capping both sides of the gap', () => {
    const ring = ringOf(RECT);
    ring[0] = { ...ring[0], pieces: [[0, 4], [6, 10]] };
    const capTriangles = profile.length - 2;
    assert.equal(sweepCourse(ring, profile).length, 5 * faceCount * 2 + 2 * capTriangles);
  });

  it('hangs dentils clear of each piece\'s ends', () => {
    const size = dentilSize({ height: 0.3, projection: 0.2 });
    const ring = ringOf(RECT, 5);
    const triangles = dentilTriangles(ring, size);
    assert.ok(triangles.length > 0 && triangles.length % 8 === 0);
    const alongFront = triangles.flat().filter(([, , z]) => z < -4);
    assert.ok(Math.min(...alongFront.map(([x]) => x)) >= -5 + size.depth - 1e-9);
    assert.ok(Math.max(...alongFront.map(([x]) => x)) <= 5 - size.depth + 1e-9);
  });
});

describe('trim on a built building', () => {
  function build(config = {}) {
    const layout = computeFacadeLayout(RECT, { storyCount: 2, storyHeight: 3 });
    return createBuildingFromFootprint(RECT, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
      roofHeight: 8 / 12 * 4, roofEaveDepth: 0.5, roofFasciaDepth: 0.15, eaveSoffit: 'flat', volumes: layout.volumes, facadeLayout: layout, ...config,
    });
  }
  const trimMeshes = ({ building }) => {
    const out = {};
    building.traverse((mesh) => {
      if (mesh.userData?.bodyPart === 'trim') {
        const p = mesh.geometry.getAttribute('position');
        const ys = Array.from({ length: p.count }, (_, i) => p.getY(i));
        out[mesh.userData.trimKind] = { mesh, minY: Math.min(...ys), maxY: Math.max(...ys), triangles: p.count / 3 };
      }
    });
    return out;
  };

  it('builds nothing when no course is on, or the project has no trim at all', () => {
    assert.deepEqual(trimMeshes(build()), {});
    assert.deepEqual(trimMeshes(build({ trim: normalizeTrim({}) })), {});
  });

  it('sets the water table on the foundation, a belt course at the floor line, the cornice under the soffit', () => {
    const meshes = trimMeshes(build({
      trim: { waterTable: { enabled: true }, beltCourse: { enabled: true }, cornice: { enabled: true, dentils: true } },
    }));
    assert.ok(Math.abs(meshes.waterTable.minY - 0.6) < 1e-6);
    assert.ok(Math.abs((meshes.beltCourse.minY + meshes.beltCourse.maxY) / 2 - 3.6) < 1e-6);
    // plate 6.6; the flat soffit runs level from the fascia's foot: 6.6 + lift - (8/12) * 0.5 - 0.15
    const soffit = 6.6 + 0.02 - (8 / 12) * 0.5 - 0.15;
    assert.ok(meshes.cornice.maxY < soffit && meshes.cornice.maxY > soffit - 0.01, `cornice top ${meshes.cornice.maxY}, soffit ${soffit}`);
    assert.ok(Math.abs(meshes.dentils.maxY - meshes.cornice.minY) < 1e-6, 'dentils hang from the cornice');
    assert.equal(meshes.cornice.mesh.material.userData.role, 'trim');
    assert.equal(meshes.cornice.mesh.material.userData.palette, 'paint');
  });

  it('rises to the plate where there is no overhang to tuck under', () => {
    const meshes = trimMeshes(build({ roofEaveDepth: 0, roofRakeDepth: 0, trim: { cornice: { enabled: true } } }));
    assert.ok(Math.abs(meshes.cornice.maxY - 6.6) < 1e-6);
  });

  it('breaks the water table around a door, and a belt course around a window crossing the floor line', () => {
    const openings = [
      { id: 'd', kind: 'door', hostWallRunId: 'wall-run-0', offset: -2, width: 0.9, height: 2.05, sillHeight: 0, materials: {} },
      { id: 'w', kind: 'window', hostWallRunId: 'wall-run-0', offset: 2, width: 1, height: 1.4, sillHeight: 2.4, materials: {} },
    ];
    const plain = trimMeshes(build({ trim: { waterTable: { enabled: true }, beltCourse: { enabled: true } } }));
    const cut = trimMeshes(build({ openings, trim: { waterTable: { enabled: true }, beltCourse: { enabled: true } } }));
    const caps = 2 * (courseProfile('waterTable', TRIM_DEFAULTS.waterTable).length - 2);
    const faces = 2 * (courseProfile('waterTable', TRIM_DEFAULTS.waterTable).length - 1);
    assert.equal(cut.waterTable.triangles, plain.waterTable.triangles + faces + caps);
    assert.equal(cut.beltCourse.triangles, plain.beltCourse.triangles + 2 * (courseProfile('beltCourse', TRIM_DEFAULTS.beltCourse).length - 1)
      + 2 * (courseProfile('beltCourse', TRIM_DEFAULTS.beltCourse).length - 2));
  });

  it('goes to the game as its palette\'s wall material', () => {
    assert.equal(gameMaterial({ role: 'trim', palette: 'paint' }, [1, 0, 0]), 'siding_white');
    assert.equal(gameMaterial({ role: 'trim', palette: 'stone' }, [0, 1, 0]), 'limestone');
  });
});

describe('trim on roof structures\' walls', () => {
  const FOOTPRINT = [[-6, -5], [6, -5], [6, 5], [-6, 5]];
  const ALL = { waterTable: { enabled: true }, beltCourse: { enabled: true }, cornice: { enabled: true } };
  const tower = {
    id: 't', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: 6, width: 3.4, setback: -1.7, depth: 3.4, baseHeight: 'ground', wallHeight: 8.2,
    roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 18 }, openSides: [], plan: { shape: 'polygon', sides: 8 },
  };
  const dormer = { id: 'd', kind: 'dormer', hostVolumeId: 'volume-0', hostSide: 'minZ', offset: -2, width: 2.4, setback: 0.6 };
  function build(structures, trim = ALL) {
    const layout = computeFacadeLayout(FOOTPRINT, { storyCount: 2, storyHeight: 3 });
    return createBuildingFromFootprint(FOOTPRINT, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.7, roofType: 'gable', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
      roofHeight: (8 / 12) * 5, roofEaveDepth: 0.4, volumes: layout.volumes, facadeLayout: layout, roofStructures: normalizeRoofStructures(structures), trim,
    });
  }
  // every point of one kind of trim
  const trimPoints = (built, kind) => {
    const points = [];
    built.building.traverse((mesh) => {
      if (mesh.userData?.trimKind === kind) {
        const p = mesh.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i += 1) {
          points.push([p.getX(i), p.getY(i), p.getZ(i)]);
        }
      }
    });
    return points;
  };

  it('a corner tower carries the house\'s water table and belt course round it, and its own cornice under its roof', () => {
    const built = build([tower]);
    const [{ resolved }] = built.roofStructures;
    // the tower stands round (6, 5 + 1.7): its facets are 1.7 off center or less, the house's walls farther
    const onTower = (kind) => trimPoints(built, kind).filter(([x, , z]) => x > 6.05 || z > 5.05);
    assert.ok(onTower('waterTable').length > 0 && onTower('waterTable').every(([, y]) => y >= 0.7 - 1e-6 && y <= 0.7 + 0.25 + 1e-6));
    assert.ok(onTower('beltCourse').some(([, y]) => Math.abs(y - 3.7) < 0.1));
    const corniceTop = Math.max(...onTower('cornice').map(([, y]) => y));
    assert.ok(corniceTop <= resolved.plateY + 1e-6 && corniceTop > resolved.plateY - 1, `${corniceTop} near the tower's plate ${resolved.plateY}`);
  });

  it('a dormer gets a cornice at its own plate, and no water table or belt course up on the roof', () => {
    const built = build([dormer]);
    const [{ resolved }] = built.roofStructures;
    const high = (kind) => trimPoints(built, kind).filter(([, y]) => y > resolved.sillY - 1e-6);
    assert.equal(high('waterTable').length, 0);
    assert.equal(high('beltCourse').length, 0);
    const cornice = high('cornice');
    assert.ok(cornice.length > 0 && Math.max(...cornice.map(([, y]) => y)) <= resolved.plateY + 1e-6);
  });

  it('none on a structure when every course is off', () => {
    assert.equal(trimPoints(build([tower], {}), 'cornice').length, 0);
  });
});

describe('trim wall by wall', () => {
  it('keeps only on/off settings for known courses', () => {
    assert.deepEqual(normalizeWallTrim({
      'wall-run-0': { cornice: 'off', waterTable: 'maybe', dentils: 'on' }, 'wall-run-1': {}, 'wall-run-2': { beltCourse: 'on' },
    }), { 'wall-run-0': { cornice: 'off' }, 'wall-run-2': { beltCourse: 'on' } });
  });

  it('a wall\'s own setting wins over the building\'s', () => {
    const trim = normalizeTrim({ cornice: { enabled: true } });
    const wallTrim = { 'wall-run-1': { cornice: 'off', waterTable: 'on' } };
    assert.equal(courseOn(trim, wallTrim, 'wall-run-0', 'cornice'), true);
    assert.equal(courseOn(trim, wallTrim, 'wall-run-1', 'cornice'), false);
    assert.equal(courseOn(trim, wallTrim, 'wall-run-1', 'waterTable'), true);
    assert.equal(courseOn(trim, wallTrim, 'wall-run-0', 'waterTable'), false);
  });

  const build = (trim, wallTrim) => {
    const layout = computeFacadeLayout(RECT, {});
    return createBuildingFromFootprint(RECT, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofHeight: 2, roofEaveDepth: 0,
      volumes: layout.volumes, facadeLayout: layout, trim, wallTrim,
    });
  };
  const pointsOf = (built, kind) => {
    const points = [];
    built.building.traverse((mesh) => {
      if (mesh.userData?.trimKind === kind) {
        const p = mesh.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i += 1) points.push([p.getX(i), p.getY(i), p.getZ(i)]);
      }
    });
    return points;
  };

  it('leaves a course off one wall, ending it square at that wall\'s corners', () => {
    // wall-run-0 is the z = -4 wall
    const points = pointsOf(build({ cornice: { enabled: true } }, { 'wall-run-0': { cornice: 'off' } }), 'cornice');
    assert.ok(points.length > 0);
    assert.ok(points.every(([, , z]) => z >= -4 - 1e-6), 'none stands out from the z = -4 wall');
  });

  it('runs a course along one wall only, with the building\'s turned off', () => {
    const points = pointsOf(build({}, { 'wall-run-0': { waterTable: 'on' } }), 'waterTable');
    assert.ok(points.length > 0);
    assert.ok(points.every(([, , z]) => z <= -4 + 1e-6), 'only along the z = -4 wall');
  });

  it('saves wall by wall, dropping walls the footprint no longer has', () => {
    const layout = computeFacadeLayout(RECT, {});
    const saved = serializeBuildingState(layout, { wallTrim: { 'wall-run-0': { cornice: 'off' }, 'wall-run-9': { cornice: 'on' } } });
    assert.deepEqual(deserializeBuildingState(saved).state.wallTrim, { 'wall-run-0': { cornice: 'off' } });
    assert.deepEqual(deserializeBuildingState({ format: 'building-composer', version: 1, footprint: RECT }).state.wallTrim, {});
  });
});

describe('at the outside corners', () => {
  const ringWith = (footprint, y0 = 0.6, y1 = 6.6) => ringOf(footprint).map((run) => ({ ...run, y0, y1 }));
  // a corner piece: an L of 6 points stood up: 4 cap triangles top and bottom, 6 sides
  const PIECE = 2 * 4 + 6 * 2;
  const boards = { style: 'boards', width: 0.15, projection: 0.025 };

  it('none unless asked', () => {
    assert.equal(normalizeTrim({}).corners.style, 'none');
    assert.deepEqual(cornerTriangles(ringWith(RECT), normalizeTrim({}).corners), []);
    assert.equal(hasTrim(normalizeTrim({ corners: { style: 'quoins' } })), true);
  });

  it('boards at each of a box\'s four corners, standing out from both faces, the corner\'s height', () => {
    const triangles = cornerTriangles(ringWith(RECT), boards);
    assert.equal(triangles.length, 4 * PIECE);
    const points = triangles.flat();
    assert.ok(Math.abs(Math.max(...points.map(([x]) => x)) - 5.025) < 1e-9);
    assert.deepEqual([Math.min(...points.map(([, y]) => y)), Math.max(...points.map(([, y]) => y))], [0.6, 6.6]);
    // along each face, the board's width back from the corner
    assert.ok(points.some(([x, , z]) => Math.abs(x - (5 - 0.15)) < 1e-9 && Math.abs(z - -4.025) < 1e-9));
  });

  it('none at an inside corner, or where the wall only bends (a tower\'s facets)', () => {
    const ell = [[-6, -4], [6, -4], [6, 0], [0, 0], [0, 4], [-6, 4]];
    assert.equal(cornerTriangles(ringWith(ell), boards).length, 5 * PIECE);
    const octagon = Array.from({ length: 8 }, (_, k) => [3 * Math.cos((k * Math.PI) / 4), 3 * Math.sin((k * Math.PI) / 4)]);
    const ring = octagon.map((start, i) => {
      const end = octagon[(i + 1) % 8];
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      return {
        start, end, normal: [(end[1] - start[1]) / length, -(end[0] - start[0]) / length], y0: 0, y1: 3,
      };
    });
    assert.deepEqual(cornerTriangles(ring, boards), []);
  });

  it('quoins stacked up the corner, long and short in turn', () => {
    const quoins = cornerTriangles(ringWith(RECT, 0.6, 3.6), { style: 'quoins', width: 0.2, projection: 0.04 });
    // 3 m of corner: 9 quoins of 0.3 m with 0.03 m gaps
    assert.equal(quoins.length, 4 * 9 * PIECE);
    const first = cornerTriangles(ringWith([[-5, -4], [5, -4], [5, 4], [-5, 4]], 0, 0.3), { style: 'quoins', width: 0.2, projection: 0.04 }).flat();
    // at the (5, -4) corner the first is long along the z = -4 face (0.36) and short along the x = 5 face (0.2)
    assert.ok(first.some(([x, , z]) => Math.abs(x - (5 - 0.36)) < 1e-9 && Math.abs(z + 4) < 1e-9));
    assert.ok(first.some(([x, , z]) => Math.abs(x - 5) < 1e-9 && Math.abs(z - (-4 + 0.2)) < 1e-9));
  });

  it('on a built house, from on top of the water table up under the cornice', () => {
    const layout = computeFacadeLayout(RECT, {});
    const built = createBuildingFromFootprint(RECT, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.6, roofType: 'gable', roofDirection: 'x', roofHeight: 2, roofEaveDepth: 0,
      volumes: layout.volumes, facadeLayout: layout,
      trim: { waterTable: { enabled: true }, cornice: { enabled: true }, corners: { style: 'boards' } },
    });
    let ys = [];
    built.building.traverse((mesh) => {
      if (mesh.userData?.trimKind === 'corners') {
        const p = mesh.geometry.getAttribute('position');
        ys = Array.from({ length: p.count }, (_, i) => p.getY(i));
      }
    });
    assert.ok(Math.abs(Math.min(...ys) - (0.6 + TRIM_DEFAULTS.waterTable.height)) < 1e-5);
    assert.ok(Math.abs(Math.max(...ys) - (6.6 - TRIM_DEFAULTS.cornice.height)) < 1e-5);
  });
});
