import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  railingParts, partTriangles, normalizeRailing, RAILING_DEFAULTS, RAILING_STYLES, TOP_RAIL, BOTTOM_RAIL, NEWEL, FLAT_BOARD, BAR_SIZE,
} from '../js/railings.js';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { normalizeRoofStructures, normalizeRoofStructure } from '../js/roof-structures.js';

const SQUARE = normalizeRailing();
const of = (parts, part) => parts.filter((candidate) => candidate.part === part);

describe('railing settings', () => {
  it('fill in defaults, keep sizes in range, and read an older plain on/off', () => {
    assert.deepEqual(normalizeRailing(), RAILING_DEFAULTS);
    assert.deepEqual(normalizeRailing(false), { ...RAILING_DEFAULTS, enabled: false });
    assert.deepEqual(normalizeRailing(true), RAILING_DEFAULTS);
    assert.deepEqual(normalizeRailing({ style: 'lattice', height: 9, spacing: 0 }), {
      enabled: true, style: 'square', height: 1.5, spacing: 0.06,
    });
  });
});

describe('railing parts', () => {
  it('a top and a bottom rail the run\'s length, balusters evenly spaced between them', () => {
    const parts = railingParts(2, SQUARE);
    const rails = of(parts, 'rail');
    assert.equal(rails.length, 2);
    assert.ok(rails.every((box) => box.u0 === 0 && box.u1 === 2));
    assert.deepEqual(rails.map((box) => [box.y0, box.y1]).sort((a, b) => a[0] - b[0]), [
      [BOTTOM_RAIL.lift, BOTTOM_RAIL.lift + BOTTOM_RAIL.height], [1 - TOP_RAIL.height, 1],
    ]);
    const balusters = of(parts, 'baluster');
    assert.equal(balusters.length, Math.floor(2 / SQUARE.spacing));
    assert.ok(balusters.every((box) => box.y0 === BOTTOM_RAIL.lift + BOTTOM_RAIL.height && box.y1 === 1 - TOP_RAIL.height));
    assert.equal(of(parts, 'newel').length, 0);
  });

  it('spaces balusters as set, and stands the rail at the height asked', () => {
    assert.equal(of(railingParts(2, normalizeRailing({ spacing: 0.25 })), 'baluster').length, 8);
    const low = railingParts(2, normalizeRailing({ height: 0.8 }));
    assert.equal(Math.max(...low.map((part) => part.y1)), 0.8);
    const capped = railingParts(2, normalizeRailing({ height: 1.2 }), { height: 0.9 });
    assert.equal(Math.max(...capped.map((part) => part.y1)), 0.9, 'a lower ceiling caps it');
  });

  it('builds each style\'s filling', () => {
    const turned = of(railingParts(1, normalizeRailing({ style: 'turned' })), 'baluster');
    assert.ok(turned.length > 0 && turned.every((part) => part.turned));
    const flat = of(railingParts(1, normalizeRailing({ style: 'flat', spacing: 0.15 })), 'baluster');
    assert.ok(flat.every((part) => Math.abs(part.u1 - part.u0 - FLAT_BOARD.width) < 1e-9 && Math.abs(part.c1 - part.c0 - FLAT_BOARD.thickness) < 1e-9));
    const panel = railingParts(1, normalizeRailing({ style: 'panel' }));
    assert.equal(of(panel, 'panel').length, 1);
    assert.equal(of(panel, 'baluster').length, 0);
    const bars = of(railingParts(1, normalizeRailing({ style: 'bars', spacing: 0.2 })), 'bar');
    assert.equal(bars.length, 3);
    assert.ok(bars.every((part) => part.u0 === 0 && part.u1 === 1 && Math.abs(part.y1 - part.y0 - BAR_SIZE) < 1e-9));
    RAILING_STYLES.forEach((style) => railingParts(1, normalizeRailing({ style })).forEach((part) => {
      const triangles = partTriangles(part);
      assert.ok(triangles.length > 0 && triangles.flat(2).every(Number.isFinite), style);
    }));
  });

  it('opens across a gap, with a newel just outside each side of it', () => {
    const parts = railingParts(6, SQUARE, { gaps: [[2.25, 3.75]] });
    assert.ok(parts.filter((part) => part.part !== 'newel').every((box) => box.u1 <= 2.25 + 1e-9 || box.u0 >= 3.75 - 1e-9));
    const newels = of(parts, 'newel').map((box) => (box.u0 + box.u1) / 2).sort((a, b) => a - b);
    assert.deepEqual(newels, [2.25 - NEWEL.width / 2, 3.75 + NEWEL.width / 2]);
  });

  it('stops rails and balusters at the faces of posts already standing on the run', () => {
    const parts = railingParts(3, SQUARE, { obstacles: [[0, 0.2], [1.4, 1.6], [2.8, 3]] });
    const filling = parts.filter((part) => part.part !== 'newel');
    assert.ok(filling.every((part) => [[0, 0.2], [1.4, 1.6], [2.8, 3]].every(([from, to]) => part.u1 <= from + 1e-9 || part.u0 >= to - 1e-9)));
    assert.deepEqual(of(parts, 'rail').filter((rail) => rail.y1 === 1).map((rail) => [rail.u0, rail.u1]), [[0.2, 1.4], [1.6, 2.8]]);
    assert.equal(of(parts, 'newel').length, 0, 'posts already there are not drawn again');
  });

  it('stops rails at a newel\'s faces', () => {
    const rails = of(railingParts(3, SQUARE, { posts: [0, 3] }), 'rail');
    assert.ok(rails.every((rail) => Math.abs(rail.u0 - NEWEL.width) < 1e-9 && Math.abs(rail.u1 - (3 - NEWEL.width)) < 1e-9));
  });

  it('puts newels at the posts asked for, kept within the run', () => {
    const newels = of(railingParts(3, SQUARE, { posts: [0, 3] }), 'newel');
    const ends = newels.map((box) => [box.u0, box.u1]);
    [[0, NEWEL.width], [3 - NEWEL.width, 3]].forEach((expected, i) => expected.forEach((v, k) => assert.ok(Math.abs(ends[i][k] - v) < 1e-9, `${ends[i]}`)));
    assert.ok(newels.every((box) => box.y1 === 1 + NEWEL.cap));
  });
});

describe('railings on a built building', () => {
  const FOOTPRINT = [[-6, -5], [6, -5], [6, 5], [-6, 5]];
  const porch = (fields = {}) => ({
    id: 'p', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: 0, width: 6, setback: -2.4, depth: 2.4, baseHeight: 'ground', wallHeight: 2.8,
    roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'], ...fields,
  });
  const build = (config) => {
    const layout = computeFacadeLayout(FOOTPRINT, {});
    return createBuildingFromFootprint(FOOTPRINT, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.7, roofType: 'hip', roofDirection: 'x', roofPitchRise: 8, roofPitchRun: 12,
      roofHeight: (8 / 12) * 5, volumes: layout.volumes, facadeLayout: layout, ...config,
    });
  };
  const railingPoints = (built) => {
    const points = [];
    built.building.traverse((mesh) => {
      if (mesh.userData?.bodyPart === 'railing') {
        const p = mesh.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i += 1) {
          points.push([p.getX(i), p.getY(i), p.getZ(i)]);
        }
        assert.equal(mesh.material.userData.role, 'trim');
      }
    });
    return points;
  };

  it('rails a porch\'s open sides from its floor, and opens the front where its steps come up', () => {
    const points = railingPoints(build({ roofStructures: normalizeRoofStructures([porch()]) }));
    assert.ok(points.length > 0);
    assert.ok(Math.abs(Math.min(...points.map(([, y]) => y)) - 0.7) < 1e-6, 'standing on the deck');
    // the front (z = 7.4) is open across the 1.5 m flight of steps in its middle, rails and balusters alike
    const inGap = points.filter(([x, y, z]) => Math.abs(z - 7.4) < 0.1 && Math.abs(x) < 0.7 && y > 0.75);
    assert.equal(inGap.length, 0);
  });

  it('a porch\'s railing runs on its posts\' center line and stops at their faces', () => {
    const built = build({ roofStructures: normalizeRoofStructures([porch()]) });
    // each post's plan square, from its top and bottom faces
    const squares = [];
    built.building.traverse((mesh) => {
      if (mesh.userData?.structurePart === 'posts') {
        const p = mesh.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i += 3) {
          const tri = [0, 1, 2].map((k) => [p.getX(i + k), p.getY(i + k), p.getZ(i + k)]);
          if (tri.every(([, y]) => Math.abs(y - tri[0][1]) < 1e-9)) {
            const xs = tri.map(([x]) => x);
            const zs = tri.map(([, , z]) => z);
            squares.push([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]);
          }
        }
      }
    });
    assert.ok(squares.length > 0);
    const eps = 1e-6;
    const inside = ([x, , z]) => squares.some(([x0, x1, z0, z1]) => x > x0 + eps && x < x1 - eps && z > z0 + eps && z < z1 - eps);
    const points = railingPoints(built);
    assert.deepEqual(points.filter(inside), [], 'nothing of the railing runs into a post');
    // centered on the posts: the front rail's line is half a post in from the porch's front
    const front = points.filter(([x, y, z]) => y > 1.6 && z > 7 && Math.abs(x) < 2.5);
    assert.ok(Math.abs((Math.min(...front.map(([, , z]) => z)) + Math.max(...front.map(([, , z]) => z))) / 2 - (7.4 - 0.1)) < 1e-6);
  });

  it('none on a porch with its railings turned off; older records have them on', () => {
    assert.equal(railingPoints(build({ roofStructures: normalizeRoofStructures([porch({ railings: false })]) })).length, 0);
    assert.deepEqual(normalizeRoofStructure(porch()).railings, RAILING_DEFAULTS);
    assert.equal('railings' in normalizeRoofStructure({ ...porch(), kind: 'dormer' }), false);
  });

  it('a porch\'s railing is no higher than its ceiling, and as high as set below that', () => {
    const top = (railings, wallHeight = 2.8) => Math.max(...railingPoints(build({ roofStructures: normalizeRoofStructures([porch({ railings, wallHeight })]) })).map(([, y]) => y));
    // the newels either side of the steps stand a cap above the rail
    assert.ok(Math.abs(top({ height: 0.8 }) - (0.7 + 0.8 + NEWEL.cap)) < 1e-6);
    assert.ok(top({ height: 1.5 }, 1.2) <= 0.7 + 1.2 + NEWEL.cap + 1e-6);
  });

  it('a widow\'s walk railing can be turned off, and saves with the project', () => {
    assert.equal(railingPoints(build({ roofWalkHeight: 2, walkRailings: { enabled: false } })).length, 0);
    const layout = computeFacadeLayout(FOOTPRINT, {});
    const { state } = deserializeBuildingState(serializeBuildingState(layout, { walkRailings: { style: 'turned', height: 0.9 } }));
    assert.deepEqual(state.walkRailings, { ...RAILING_DEFAULTS, style: 'turned', height: 0.9 });
    const old = deserializeBuildingState({ format: 'building-composer', version: 1, footprint: FOOTPRINT }).state;
    assert.deepEqual(old.walkRailings, RAILING_DEFAULTS);
  });

  it('rails a widow\'s walk all the way round, up on the roof', () => {
    const built = build({ roofWalkHeight: 2 });
    const points = railingPoints(built);
    assert.ok(points.length > 0);
    const [walk] = built.roofWalks;
    assert.ok(Math.abs(Math.min(...points.map(([, y]) => y)) - walk.y) < 1e-6);
  });
});
