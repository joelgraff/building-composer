import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTrim, hasTrim, courseProfile, profileExtent, subtractIntervals, triangulatePolygon, sweepCourse, miterVector,
  dentilTriangles, dentilSize, floorLines, TRIM_DEFAULTS,
} from '../js/trim.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { gameMaterial } from '../js/game-export.js';

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
