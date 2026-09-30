import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postTriangles, normalizePostStyle, POST_STYLES } from '../js/posts.js';
import { normalizeRoofStructures, normalizeRoofStructure } from '../js/roof-structures.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { openTriangleEdges } from './helpers/mesh.js';

const RECT = {
  minX: 1, maxX: 1.2, minZ: 5, maxZ: 5.2,
};

describe('porch post styles', () => {
  it('square unless set', () => {
    assert.equal(normalizePostStyle(undefined), 'square');
    assert.equal(normalizePostStyle('gothic'), 'square');
    assert.equal(normalizeRoofStructure({
      kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ',
    }).postStyle, 'square');
  });

  it('each stands closed in the post\'s square, the whole height', () => {
    POST_STYLES.forEach((style) => {
      const triangles = postTriangles(style, RECT, 0.7, 3.5);
      assert.deepEqual(openTriangleEdges(triangles), [], style);
      const points = triangles.flat();
      const within = (v, lo, hi) => v >= lo - 1e-9 && v <= hi + 1e-9;
      assert.ok(points.every(([x, , z]) => within(x, RECT.minX, RECT.maxX) && within(z, RECT.minZ, RECT.maxZ)), `${style} within its square`);
      assert.ok(Math.abs(Math.min(...points.map(([, y]) => y)) - 0.7) < 1e-9 && Math.abs(Math.max(...points.map(([, y]) => y)) - 3.5) < 1e-9, `${style} full height`);
    });
  });

  it('a tapered post narrows toward its head; a column is round', () => {
    const tapered = postTriangles('tapered', RECT, 0, 3).flat();
    // at the shaft's head (under its cap) its corners stand in from the square
    const inset = 0.2 * 0.18;
    assert.ok(tapered.some(([x, y, z]) => Math.abs(y - (3 - 0.12)) < 1e-6 && Math.abs(x - (RECT.minX + inset)) < 1e-9 && Math.abs(z - (RECT.minZ + inset)) < 1e-9));
    assert.ok(!tapered.some(([x, y]) => Math.abs(y) < 1e-6 && Math.abs(x - (RECT.minX + inset)) < 1e-9), 'and at its foot it fills the square');
    assert.ok(postTriangles('round', RECT, 0, 3).length > postTriangles('square', RECT, 0, 3).length * 10);
  });

  it('builds a porch\'s posts in its style', () => {
    const footprint = [[-6, -5], [6, -5], [6, 5], [-6, 5]];
    const layout = computeFacadeLayout(footprint, {});
    const build = (postStyle) => createBuildingFromFootprint(footprint, {
      storyCount: 2, storyHeight: 3, foundationDepth: 0.7, roofType: 'gable', roofDirection: 'x', roofHeight: 3, volumes: layout.volumes, facadeLayout: layout,
      roofStructures: normalizeRoofStructures([{
        id: 'p', kind: 'porch', hostVolumeId: 'volume-0', hostSide: 'maxZ', offset: 0, width: 6, setback: -2.4, depth: 2.4, baseHeight: 'ground', wallHeight: 2.8,
        roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 4 }, openSides: ['front', 'left', 'right'], postStyle,
      }]),
    });
    const postCount = (built) => {
      let n = 0;
      built.building.traverse((mesh) => { if (mesh.userData?.structurePart === 'posts') n = mesh.geometry.getAttribute('position').count / 3; });
      return n;
    };
    assert.ok(postCount(build('round')) > postCount(build('square')) * 10);
  });
});
