import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeFootprint } from '../js/footprint.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';
import { resolveVolumeEaves, sideOverhangs, DEFAULT_FASCIA_DEPTH } from '../js/eaves.js';

const uFootprint = JSON.parse(readFileSync('./data/footprint_u.json', 'utf8'));
const RECT = [[-10, -5], [10, -5], [10, 5], [-10, 5]];
const F = 0.15;

function roofMesh(config, footprint = RECT) {
  const { building } = createBuildingFromFootprint(footprint, {
    storyCount: 1, storyHeight: 3, roofHeight: 2.5, roofPitchRise: 6, roofPitchRun: 12, ...config,
  });
  let mesh = null;
  building.traverse((child) => { if (child.isMesh && child.userData?.roofType) { mesh = child; } });
  return mesh;
}

function triangles(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const out = [];
  for (let i = 0; i < pos.count; i += 3) {
    out.push([0, 1, 2].map((k) => [pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)]));
  }
  return out;
}

const area = ([a, b, c]) => {
  const u = b.map((v, i) => v - a[i]);
  const w = c.map((v, i) => v - a[i]);
  return 0.5 * Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
};

/**
 * Edges used by exactly one triangle, i.e. the boundary of the shell. Edges
 * are split at any vertex lying on them first, so a long edge that meets two
 * shorter neighbors (a T-junction) still counts as closed.
 */
function openEdges(mesh) {
  const key = (p) => p.map((v) => v.toFixed(3)).join(',');
  const unique = new Map();
  const tris = triangles(mesh);
  tris.flat().forEach((p) => unique.set(key(p), p));
  const points = [...unique.values()];
  const between = (a, b, p) => {
    const ab = b.map((v, i) => v - a[i]);
    const ap = p.map((v, i) => v - a[i]);
    const len2 = ab.reduce((sum, v) => sum + v * v, 0);
    const t = ap.reduce((sum, v, i) => sum + v * ab[i], 0) / len2;
    if (t <= 1e-6 || t >= 1 - 1e-6) { return null; }
    const off = ap.map((v, i) => v - ab[i] * t);
    return Math.hypot(...off) < 1e-6 ? t : null;
  };
  const counts = new Map();
  tris.forEach((tri) => {
    [[0, 1], [1, 2], [2, 0]].forEach(([i, j]) => {
      const a = tri[i];
      const b = tri[j];
      const stops = points.map((p) => [between(a, b, p), p]).filter(([t]) => t !== null).sort((x, y) => x[0] - y[0]).map(([, p]) => p);
      const chain = [a, ...stops, b];
      for (let k = 0; k < chain.length - 1; k += 1) {
        const ka = key(chain[k]);
        const kb = key(chain[k + 1]);
        const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    });
  });
  return [...counts].filter(([, n]) => n === 1).map(([k]) => k.split('|').map((s) => s.split(',').map(Number)));
}

describe('eave settings', () => {
  it('resolves per-volume overrides over building defaults', () => {
    const config = { roofEaveDepth: 0.4, roofRakeDepth: 0.2, eaveSoffit: 'flat', rakeSoffit: 'sloped', roofFasciaDepth: 0.2, volumeEaves: { 'volume-1': { eaveDepth: 0.1, rakeSoffit: 'flat' } } };
    assert.deepEqual(resolveVolumeEaves('volume-0', config), { eaveDepth: 0.4, rakeDepth: 0.2, eaveSoffit: 'flat', rakeSoffit: 'sloped', fasciaDepth: 0.2 });
    assert.deepEqual(resolveVolumeEaves('volume-1', config), { eaveDepth: 0.1, rakeDepth: 0.2, eaveSoffit: 'flat', rakeSoffit: 'flat', fasciaDepth: 0.2 });
    assert.equal(resolveVolumeEaves('x', {}).fasciaDepth, DEFAULT_FASCIA_DEPTH);
    assert.ok(Math.abs(DEFAULT_FASCIA_DEPTH - 6 * 0.0254) < 1e-9, 'default fascia is six inches');
  });

  it('classifies eaves and rakes per roof type and zeroes shared sides', () => {
    const eaves = { eaveDepth: 0.5, rakeDepth: 0.3 };
    const gable = sideOverhangs('gable', { ridgeAxis: 'x' }, eaves);
    assert.deepEqual(gable.roles, { minX: 'rake', maxX: 'rake', minZ: 'eave', maxZ: 'eave' });
    assert.deepEqual(gable.overhang, { minX: 0.3, maxX: 0.3, minZ: 0.5, maxZ: 0.5 });
    const shed = sideOverhangs('shed', { roofHighEdge: 'z-min' }, eaves);
    assert.deepEqual(shed.roles, { minX: 'rake', maxX: 'rake', minZ: 'none', maxZ: 'eave' });
    const shared = sideOverhangs('gable', { ridgeAxis: 'x' }, eaves, new Set(['maxZ']));
    assert.equal(shared.overhang.maxZ, 0);
    const hip = sideOverhangs('hip', { ridgeAxis: 'x' }, eaves, new Set(['maxZ']));
    assert.ok(Object.values(hip.overhang).every((v) => v === 0), 'a hip keeps equal overhang so its faces stay planar');
  });
});

describe('gable eaves', () => {
  const config = { roofType: 'gable', roofDirection: 'x', roofEaveDepth: 0.5, roofRakeDepth: 0.3, roofFasciaDepth: F };

  it('continues the slope past the wall, keeps the gable end at the wall, and boxes the corners', () => {
    const mesh = roofMesh(config);
    const tris = triangles(mesh);
    const ys = tris.flat().map((v) => v[1]);
    const slope = 2.5 / 5;
    assert.ok(Math.abs(Math.min(...ys) - (-slope * 0.5 - F)) < 1e-6, 'fascia bottom = eave edge height - fascia depth');
    const vertices = tris.flat();
    assert.ok(vertices.some((v) => Math.abs(v[0] - 10.3) < 1e-6 && Math.abs(v[1] - 2.5) < 1e-6), 'ridge runs out to the rake edge');
    assert.ok(vertices.some((v) => Math.abs(Math.abs(v[0]) - 10) < 1e-6 && Math.abs(v[1] - 2.5) < 1e-6), 'gable end apex stays at the wall plane');
    // flat eave soffits: horizontal at the fascia bottom, 0.5 deep x (20 + 2*0.3) long, two of them
    const yBottom = -slope * 0.5 - F;
    const flat = tris.filter((tri) => tri.every((v) => Math.abs(v[1] - yBottom) < 1e-6));
    assert.ok(Math.abs(flat.reduce((sum, tri) => sum + area(tri), 0) - 2 * 0.5 * 20.6) < 1e-6);
  });

  it('is closed everywhere except where it meets the walls', () => {
    ['flat', 'sloped'].forEach((eaveSoffit) => {
      ['sloped', 'flat'].forEach((rakeSoffit) => {
        const mesh = roofMesh({ ...config, eaveSoffit, rakeSoffit });
        openEdges(mesh).forEach((edge) => {
          const onWall = edge.every((p) => Math.abs(Math.abs(p[0]) - 10) < 1e-6)
            || edge.every((p) => Math.abs(Math.abs(p[2]) - 5) < 1e-6);
          assert.ok(onWall, `${eaveSoffit}/${rakeSoffit}: open edge away from the walls ${JSON.stringify(edge)}`);
        });
      });
    });
  });

  it('shows no overhang when eave and rake depths are zero', () => {
    const mesh = roofMesh({ ...config, roofEaveDepth: 0, roofRakeDepth: 0 });
    assert.ok(Math.min(...triangles(mesh).flat().map((v) => v[1])) >= -1e-9);
  });
});

describe('hip and shed eaves', () => {
  it('a hip roof gets a fascia and soffit all round, closed except at the walls', () => {
    const mesh = roofMesh({ roofType: 'hip', roofDirection: 'x', roofEaveDepth: 0.5, roofFasciaDepth: F });
    assert.ok(Math.abs(Math.min(...triangles(mesh).flat().map((v) => v[1])) - (-0.5 * (6 / 12) - F)) < 1e-6);
    openEdges(mesh).forEach((edge) => {
      const onWall = edge.every((p) => Math.abs(Math.abs(p[0]) - 10) < 1e-6 && Math.abs(p[2]) <= 5 + 1e-6)
        || edge.every((p) => Math.abs(Math.abs(p[2]) - 5) < 1e-6 && Math.abs(p[0]) <= 10 + 1e-6);
      assert.ok(onWall, `open edge away from the walls ${JSON.stringify(edge)}`);
    });
  });

  it('a shed gets a low-side eave and lateral rakes but nothing on its high edge', () => {
    const mesh = roofMesh({ roofType: 'shed', roofDirection: 'z-min', roofEaveDepth: 0.5, roofRakeDepth: 0.3, roofFasciaDepth: F });
    const vertices = triangles(mesh).flat();
    assert.ok(Math.max(...vertices.map((v) => v[2])) > 5 + 0.49, 'eave projects past the low (z-max) wall');
    assert.ok(Math.min(...vertices.map((v) => v[2])) >= -5 - 1e-9, 'the high edge does not project');
    assert.ok(Math.max(...vertices.map((v) => v[0])) > 10.29, 'rakes project');
    openEdges(mesh).forEach((edge) => {
      const onWall = edge.every((p) => Math.abs(Math.abs(p[0]) - 10) < 1e-6)
        || edge.every((p) => Math.abs(Math.abs(p[2]) - 5) < 1e-6);
      assert.ok(onWall, `open edge away from the walls ${JSON.stringify(edge)}`);
    });
  });
});

describe('eaves across volumes', () => {
  const norm = normalizeFootprint(uFootprint);
  const layout = computeFacadeLayout(norm, { roofType: 'gable' });
  const build = (extra) => createBuildingFromFootprint(norm, {
    storyCount: 1, storyHeight: 3, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
    volumeStoryOverrides: { 'volume-0': 2 }, roofFasciaDepth: F, ...extra,
  }).building;
  const minY = (building, id) => {
    let min = Infinity;
    building.traverse((c) => {
      if (c.isMesh && c.userData?.volumeId === id && c.userData?.roofType) {
        const pos = c.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i += 1) { min = Math.min(min, pos.getY(i)); }
      }
    });
    return min;
  };

  it('a non-rectangular footprint honors eave depth, with per-volume overrides', () => {
    const uniform = build({ roofEaveDepth: 0.5 });
    assert.ok(minY(uniform, 'volume-2') < -0.2, 'legs get eaves even though the footprint is not a rectangle');
    const noEaves = build({ roofEaveDepth: 0 });
    assert.ok(minY(noEaves, 'volume-2') > -1e-9);
    const overridden = build({ roofEaveDepth: 0.5, roofRakeDepth: 0.5, volumeEaves: { 'volume-2': { eaveDepth: 0, rakeDepth: 0 } } });
    assert.ok(minY(overridden, 'volume-2') > -1e-9, 'volume-2 override removes its eaves');
    assert.ok(minY(overridden, 'volume-1') < -0.2, 'other volumes keep the building default');
  });
});

describe('soffit style variants stay closed', () => {
  const wallEdge = (edge) => edge.every((p) => Math.abs(Math.abs(p[0]) - 10) < 1e-6 && Math.abs(p[2]) <= 5 + 1e-6)
    || edge.every((p) => Math.abs(Math.abs(p[2]) - 5) < 1e-6 && Math.abs(p[0]) <= 10 + 1e-6);

  ['flat', 'sloped'].forEach((eaveSoffit) => {
    it(`hip with ${eaveSoffit} soffit`, () => {
      const mesh = roofMesh({ roofType: 'hip', roofDirection: 'x', roofEaveDepth: 0.5, eaveSoffit, roofFasciaDepth: F });
      openEdges(mesh).forEach((edge) => assert.ok(wallEdge(edge), JSON.stringify(edge)));
    });
    ['sloped', 'flat'].forEach((rakeSoffit) => {
      it(`shed with ${eaveSoffit} eave / ${rakeSoffit} rake soffits`, () => {
        const mesh = roofMesh({
          roofType: 'shed', roofDirection: 'z-min', roofEaveDepth: 0.5, roofRakeDepth: 0.3, eaveSoffit, rakeSoffit, roofFasciaDepth: F,
        });
        openEdges(mesh).forEach((edge) => assert.ok(wallEdge(edge), JSON.stringify(edge)));
      });
    });
  });
});

describe('eave ends and partly shared sides', () => {
  it('boxes in an eave whose rake overhang is zero', () => {
    const mesh = roofMesh({ roofType: 'gable', roofDirection: 'x', roofEaveDepth: 0.5, roofRakeDepth: 0, roofFasciaDepth: F });
    const wallEdge = (edge) => edge.every((p) => Math.abs(Math.abs(p[0]) - 10) < 1e-6)
      || edge.every((p) => Math.abs(Math.abs(p[2]) - 5) < 1e-6);
    openEdges(mesh).forEach((edge) => assert.ok(wallEdge(edge), `open end ${JSON.stringify(edge)}`));
    // a cap at each of the four eave ends: the fascia-height box is visible at x = +-10
    assert.ok(triangles(mesh).some((tri) => tri.every((v) => Math.abs(v[0] - 10) < 1e-6) && tri.some((v) => Math.abs(v[2] - 5.5) < 1e-6)));
  });

  it('the exposed part of a shared eave gets its own strip, closed against the neighbors', () => {
    const norm = normalizeFootprint(uFootprint);
    const layout = computeFacadeLayout(norm, { roofType: 'gable' });
    const { building } = createBuildingFromFootprint(norm, {
      storyCount: 1, storyHeight: 3, roofType: 'gable', roofPitchRise: 6, roofPitchRun: 12, volumes: layout.volumes,
      volumeStoryOverrides: { 'volume-0': 2 }, roofEaveDepth: 0.5, roofFasciaDepth: F,
    });
    const base = layout.volumes[0];
    let found = 0;
    building.traverse((child) => {
      if (child.isMesh && child.userData?.volumeId === 'volume-0' && child.userData?.roofType) {
        const pos = child.geometry.getAttribute('position');
        for (let i = 0; i < pos.count; i += 1) {
          if (Math.abs(pos.getZ(i) - (base.maxZ + 0.5)) < 1e-6 && Math.abs(pos.getX(i)) < 6 + 1e-6 && pos.getY(i) < 0) {
            found += 1;
          }
        }
      }
    });
    assert.ok(found > 0, 'base roof projects into the courtyard along its exposed eave');
  });
});
