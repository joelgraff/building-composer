import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDetails, openingPolygon, leafSpan, detailParts, MIN_LEAF_WIDTH,
} from '../js/opening-details.js';
import { normalizeOpening, openingOutline, FRAME_CASING_WIDTH } from '../js/openings.js';
import { computeFacadeLayout } from '../js/facade.js';
import { createBuildingFromFootprint } from '../js/extrusion.js';

const window = (details = {}) => ({
  id: 'w', kind: 'window', u0: -0.5, u1: 0.5, v0: 0.9, v1: 2.3, details: normalizeDetails('window', details),
});
const door = (details = {}) => ({
  id: 'd', kind: 'door', u0: -0.8, u1: 0.8, v0: 0, v1: 2.6, details: normalizeDetails('door', details),
});
const of = ({ boxes }, part) => boxes.filter((box) => box.part === part);

describe('opening details: settings', () => {
  it('a window has a sill and nothing else unless asked; a door is a single plain leaf', () => {
    assert.deepEqual(normalizeDetails('window'), {
      sill: true, head: 'none', grille: 'none', shutters: false, top: 'flat',
    });
    assert.deepEqual(normalizeDetails('door'), {
      leaves: 1, sidelights: 0, transom: 0, head: 'none',
    });
    assert.deepEqual(normalizeDetails('door', { leaves: 3, sidelights: 2, transom: -1, head: 'pediment' }), {
      leaves: 1, sidelights: 0.6, transom: 0, head: 'none',
    });
    assert.deepEqual(normalizeOpening({ hostWallRunId: 'wall-run-0', kind: 'window', details: { grille: '6/6' } }).details.grille, '6/6');
  });
});

describe('opening details: shapes', () => {
  it('an arched top keeps the opening\'s overall size, a half circle across its width', () => {
    const arch = openingPolygon(-0.5, 0, 0.5, 2, 'arch');
    assert.equal(Math.max(...arch.map(([, v]) => v)), 2);
    assert.deepEqual([Math.min(...arch.map(([u]) => u)), Math.max(...arch.map(([u]) => u))], [-0.5, 0.5]);
    // its springing line half the width below the top
    assert.ok(arch.some(([u, v]) => Math.abs(u - 0.5) < 1e-9 && Math.abs(v - 1.5) < 1e-9));
  });

  it('an arched window\'s casing follows its arch', () => {
    const { outer } = openingOutline({ ...window({ top: 'arch' }), u0: -0.5, u1: 0.5 });
    assert.ok(Math.abs(Math.max(...outer.map(([, v]) => v)) - (2.3 + FRAME_CASING_WIDTH)) < 1e-9);
    assert.ok(outer.length > 4);
  });

  it('gives a door\'s leaves what its sidelights and transom leave, never less than a leaf', () => {
    assert.deepEqual(leafSpan(door()), {
      u0: -0.8, u1: 0.8, v0: 0, v1: 2.6,
    });
    const lit = leafSpan(door({ sidelights: 0.3, transom: 0.4 }));
    assert.ok(Math.abs(lit.u0 - (-0.8 + 0.36)) < 1e-9 && Math.abs(lit.v1 - (2.6 - 0.46)) < 1e-9);
    const squeezed = leafSpan(door({ sidelights: 0.6 }));
    assert.ok(squeezed.u1 - squeezed.u0 >= MIN_LEAF_WIDTH - 1e-9);
  });
});

describe('opening details: parts', () => {
  it('a window\'s grille: a meeting rail between its sashes, and the muntins in each', () => {
    assert.equal(of(detailParts(window({ grille: '1/1' })), 'meeting-rail').length, 1);
    assert.equal(of(detailParts(window({ grille: '1/1' })), 'muntin').length, 0);
    // six over six: 3 lights across and 2 up in each sash: 2 vertical and 1 horizontal muntins a sash
    assert.equal(of(detailParts(window({ grille: '6/6' })), 'muntin').length, 6);
    assert.equal(of(detailParts(window({ grille: 'none' })), 'muntin').length, 0);
  });

  it('a sill below, a cap above, shutters beside', () => {
    const parts = detailParts(window({ head: 'cap', shutters: true }));
    const [sill] = of(parts, 'sill');
    const [cap] = of(parts, 'head');
    assert.ok(sill.v1 <= 0.9 - FRAME_CASING_WIDTH + 1e-9 && cap.v0 >= 2.3 + FRAME_CASING_WIDTH - 1e-9);
    const shutters = of(parts, 'shutter');
    assert.equal(shutters.length, 2);
    assert.ok(shutters.every((s) => s.material === 'shutter' && (s.u1 <= -0.5 - FRAME_CASING_WIDTH + 1e-9 || s.u0 >= 0.5 + FRAME_CASING_WIDTH - 1e-9)));
    assert.equal(of(detailParts(window({ sill: false })), 'sill').length, 0);
  });

  it('a door: its leaves as panels, glazed sidelights and transom between mullions', () => {
    const parts = detailParts(door({ leaves: 2, sidelights: 0.3, transom: 0.4 }));
    assert.equal(parts.panes.filter((p) => p.part === 'leaf').length, 2);
    assert.equal(parts.panes.filter((p) => p.material === 'glass').length, 3);
    assert.equal(of(parts, 'mullion').length, 3);
    // standing open, its leaves are left out; its glass stays
    const open = detailParts(door({ leaves: 2, sidelights: 0.3 }), { open: true });
    assert.equal(open.panes.filter((p) => p.part === 'leaf').length, 0);
    assert.equal(open.panes.filter((p) => p.material === 'glass').length, 2);
  });
});

describe('opening details on a built house', () => {
  const RECT = [[-5, -4], [5, -4], [5, 4], [-5, 4]];
  const build = (openings, config = {}) => {
    const layout = computeFacadeLayout(RECT, { storyCount: 1, storyHeight: 3 });
    return createBuildingFromFootprint(RECT, {
      storyCount: 1, storyHeight: 3, foundationDepth: 0.7, roofType: 'gable', roofDirection: 'x', roofHeight: 2,
      volumes: layout.volumes, facadeLayout: layout, openings, ...config,
    });
  };

  it('builds the details as the window\'s own parts, not the wall\'s', () => {
    const built = build([{ id: 'w', kind: 'window', hostWallRunId: 'wall-run-0', offset: 0, width: 1, height: 1.4, sillHeight: 0.9, materials: {}, details: { grille: '6/6', shutters: true, head: 'cap' } }]);
    const parts = [];
    built.building.traverse((mesh) => { if (mesh.userData?.bodyPart === 'opening-detail') parts.push(mesh); });
    assert.equal(parts.length, 2, 'one for the frame\'s parts, one for the shutters');
    assert.ok(parts.some((mesh) => mesh.material.userData.palette === 'black'), 'shutters painted black unless set');
  });

  it('cuts a walk-in doorway through the leaves only, a pair standing open about both jambs', () => {
    const built = build([{
      id: 'd', kind: 'door', hostWallRunId: 'wall-run-0', offset: 0, width: 1.8, height: 2.5, sillHeight: 0, materials: {},
      steps: { enabled: false }, details: { leaves: 2, sidelights: 0.3 },
    }], { interior: { enabled: true } });
    const leaves = built.building.children.filter((mesh) => mesh.userData?.bodyPart === 'door-leaf');
    assert.equal(leaves.length, 2);
    // the doorway's reveals stand at the leaves' edges, inside the sidelights (0.3 + 0.06 in from each side)
    const reveals = built.building.children.filter((mesh) => mesh.userData?.bodyPart === 'interior-wall' && mesh.geometry.getAttribute('position').count < 40);
    const xs = reveals.flatMap((mesh) => {
      const p = mesh.geometry.getAttribute('position');
      return Array.from({ length: p.count }, (_, i) => p.getX(i));
    });
    assert.ok(Math.abs(Math.min(...xs) - (-0.9 + 0.36)) < 1e-5 && Math.abs(Math.max(...xs) - (0.9 - 0.36)) < 1e-5);
  });
});
