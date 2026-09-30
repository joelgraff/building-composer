/**
 * Footprint mode: the footprint editor's view (docs/FOOTPRINT_EDITING_PLAN.md,
 * phase 3). A 2D plan in SVG over the work area, with the outline's corners
 * and walls to drag, the game's trace, the squared import, neighbors, the
 * aerial, and an eave guide underneath, and a panel of tools beside it. All
 * edits go through js/footprint-editor.js; this file only draws and turns
 * pointer and keyboard input into those operations. DOM only, no THREE.
 *
 * Coordinates are Composer's frame in meters, drawn with x to the right and
 * z down, as the plan pane shows them (the front marker at +z is below).
 */
import {
  createFootprintEditor, edit, undo, redo, footprintWalls,
  moveCorner, insertCorner, deleteCorner, moveWall, addBump, straightenWall, setWallLength, resquare,
  snapPoint, snapWallOffset, insetOutline, outlineDeviation, openRing, MIN_WALL,
} from './footprint-editor.js';
import { MAX_SKEW_DEGREES, MIN_EDGE, ALIGN } from './import.js';
import { computeFootprintMetrics } from './footprint.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Handle and hit sizes, in screen pixels. */
const CORNER_RADIUS_PX = 6;
const WALL_HIT_PX = 12;
const SNAP_REACH_PX = 10;
/** A press that moves less than this is a click, not a drag. */
const DRAG_START_PX = 3;

/**
 * Opens footprint mode in `host` (an element covering the work area).
 *
 * @param {HTMLElement} host
 * @param {object} options
 * @param {Array<[number, number]>} options.footprint - the outline to edit, in Composer's frame
 * @param {Array<[number, number]>|null} [options.trace] - the game's own outline, in Composer's frame
 * @param {Array<[number, number]>|null} [options.squared] - the import's squared outline, in Composer's frame
 * @param {number} [options.eaveDepth] - meters, for the eave guide
 * @param {string} [options.title]
 * @param {'CCW'|'CW'} [options.expectedWinding]
 * @param {() => { factor: number, short: string }} options.units - display units (feet or meters)
 * @param {(footprint: Array<[number, number]>) => void} options.onUse
 * @param {() => void} options.onCancel
 * @returns {{ setContext(context: { neighbors?: Array, aerial?: object|null, contextNote?: string }): void, close(): void }}
 */
export function openFootprintView(host, options) {
  const expectedWinding = options.expectedWinding ?? 'CCW';
  const state = {
    editor: createFootprintEditor(options.footprint, { expectedWinding }),
    // what the drawing shows mid-drag, before it's committed as an edit
    preview: null,
    snaps: [],
    selection: null,
    layers: {
      aerial: true, trace: true, squared: false, neighbors: true, guide: true, grid: true,
    },
    aerialOpacity: 0.8,
    neighbors: [],
    aerial: null,
    contextNote: '',
    tolerances: { maxSkewDegrees: MAX_SKEW_DEGREES, minEdge: MIN_EDGE, align: ALIGN, keepAsTraced: false },
    // the panel's collapsible sections left open (the panel is redrawn on every change)
    openSections: new Set(),
    view: null,
  };
  const trace = options.trace ? openRing(options.trace) : null;
  const squared = options.squared ? openRing(options.squared) : null;

  host.innerHTML = `
    <div class="fp-canvas">
      <svg class="fp-svg" xmlns="${SVG_NS}" tabindex="0" aria-label="Footprint plan">
        <defs>
          <pattern id="fp-grid" width="1" height="1" patternUnits="userSpaceOnUse">
            <path d="M 1 0 L 0 0 0 1" fill="none" class="fp-grid-line" vector-effect="non-scaling-stroke" />
          </pattern>
        </defs>
        <g class="fp-aerial"></g>
        <rect class="fp-grid" x="-10000" y="-10000" width="20000" height="20000" fill="url(#fp-grid)" />
        <g class="fp-neighbors"></g>
        <g class="fp-squared"></g>
        <g class="fp-trace"></g>
        <g class="fp-guide"></g>
        <g class="fp-outline"></g>
        <g class="fp-labels"></g>
        <g class="fp-handles"></g>
        <g class="fp-snaps"></g>
      </svg>
      <div class="fp-hint">Drag a corner or a wall. Double-click a wall to add a corner. Hold Alt to drag without snapping. Scroll to zoom; drag the background to pan.</div>
    </div>
    <aside class="fp-panel"></aside>`;
  const svg = host.querySelector('.fp-svg');
  const panel = host.querySelector('.fp-panel');
  const groups = Object.fromEntries(['aerial', 'neighbors', 'squared', 'trace', 'guide', 'outline', 'labels', 'handles', 'snaps']
    .map((name) => [name, svg.querySelector(`.fp-${name}`)]));
  const gridRect = svg.querySelector('.fp-grid');

  // --- View box: fit, zoom, pan ---------------------------------------------

  function fitView() {
    const points = [...state.editor.footprint, ...(trace ?? [])];
    const xs = points.map(([x]) => x);
    const zs = points.map(([, z]) => z);
    const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const margin = Math.max(4, (maxX - minX + maxZ - minZ) * 0.2);
    const width = maxX - minX + margin * 2;
    const height = maxZ - minZ + margin * 2;
    const aspect = svg.clientWidth / Math.max(1, svg.clientHeight) || 1;
    const [w, h] = width / height > aspect ? [width, width / aspect] : [height * aspect, height];
    state.view = { x: (minX + maxX) / 2 - w / 2, y: (minZ + maxZ) / 2 - h / 2, w, h };
  }

  /** Meters per screen pixel. */
  function scale() {
    return state.view.w / Math.max(1, svg.clientWidth);
  }

  function toPlan(event) {
    const rect = svg.getBoundingClientRect();
    return [
      state.view.x + ((event.clientX - rect.left) / rect.width) * state.view.w,
      state.view.y + ((event.clientY - rect.top) / rect.height) * state.view.h,
    ];
  }

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const [px, pz] = toPlan(event);
    const factor = Math.exp(event.deltaY * 0.0015);
    state.view = {
      x: px - (px - state.view.x) * factor,
      y: pz - (pz - state.view.y) * factor,
      w: state.view.w * factor,
      h: state.view.h * factor,
    };
    render();
  }, { passive: false });

  // --- Drawing --------------------------------------------------------------

  function polygon(points, className) {
    return `<polygon class="${className}" points="${points.map(([x, z]) => `${x},${z}`).join(' ')}" vector-effect="non-scaling-stroke" />`;
  }

  function formatLength(meters, digits = 1) {
    const { factor, short } = options.units();
    return `${(meters * factor).toFixed(digits)} ${short}`;
  }

  function render() {
    const footprint = state.preview ?? state.editor.footprint;
    const px = scale();
    svg.setAttribute('viewBox', `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`);
    gridRect.style.display = state.layers.grid && px < 0.15 ? '' : 'none';

    const aerial = state.aerial;
    groups.aerial.innerHTML = aerial && state.layers.aerial
      ? `<image href="${aerial.href}" x="${aerial.x}" y="${aerial.y}" width="${aerial.width}" height="${aerial.height}" transform="${aerial.transform ?? ''}" opacity="${state.aerialOpacity}" preserveAspectRatio="none" />`
      : '';
    groups.neighbors.innerHTML = state.layers.neighbors ? state.neighbors.map((outline) => polygon(outline, 'fp-neighbor')).join('') : '';
    groups.squared.innerHTML = squared && state.layers.squared ? polygon(squared, 'fp-squared-line') : '';
    groups.trace.innerHTML = trace && state.layers.trace ? polygon(trace, 'fp-trace-line') : '';
    let guide = '';
    if (state.layers.guide && options.eaveDepth > 0) {
      try {
        guide = polygon(insetOutline(footprint, options.eaveDepth), 'fp-guide-line');
      } catch {
        guide = '';
      }
    }
    groups.guide.innerHTML = guide;

    const walls = footprintWalls(footprint);
    const selectedWall = state.selection?.kind === 'wall' ? state.selection.index : -1;
    const selectedCorner = state.selection?.kind === 'corner' ? state.selection.index : -1;
    groups.outline.innerHTML = polygon(footprint, `fp-outline-fill${state.editor.problems.length && !state.preview ? ' has-problems' : ''}`)
      + walls.map((wall) => `<line class="fp-wall${wall.index === selectedWall ? ' selected' : ''}${wall.length < MIN_WALL ? ' too-short' : ''}" data-wall="${wall.index}" x1="${wall.start[0]}" y1="${wall.start[1]}" x2="${wall.end[0]}" y2="${wall.end[1]}" vector-effect="non-scaling-stroke" />`
        + `<line class="fp-wall-hit" data-wall="${wall.index}" x1="${wall.start[0]}" y1="${wall.start[1]}" x2="${wall.end[0]}" y2="${wall.end[1]}" stroke-width="${WALL_HIT_PX}" vector-effect="non-scaling-stroke" />`).join('');

    // each wall's length, just outside it (angled walls also their angle)
    const fontSize = 12 * px;
    groups.labels.innerHTML = walls.filter((wall) => wall.length > 24 * px).map((wall) => {
      const [mx, mz] = [(wall.start[0] + wall.end[0]) / 2 + wall.normal[0] * 14 * px, (wall.start[1] + wall.end[1]) / 2 + wall.normal[1] * 14 * px];
      const angle = wall.axis ? '' : ` · ${((wall.angle + 360) % 180).toFixed(1)}°`;
      return `<text x="${mx}" y="${mz}" font-size="${fontSize}" stroke-width="${3 * px}" text-anchor="middle" dominant-baseline="middle">${formatLength(wall.length)}${angle}</text>`;
    }).join('');

    groups.handles.innerHTML = footprint.map(([x, z], index) => `<circle class="fp-corner${index === selectedCorner ? ' selected' : ''}" data-corner="${index}" cx="${x}" cy="${z}" r="${CORNER_RADIUS_PX * px}" vector-effect="non-scaling-stroke" />`).join('');

    groups.snaps.innerHTML = state.snaps.filter((snap) => snap.to).map((snap) => `<circle class="fp-snap" cx="${snap.to[0]}" cy="${snap.to[1]}" r="${4 * px}" vector-effect="non-scaling-stroke" />`).join('');
    if (!state.preview) {
      renderPanel();
    }
  }

  // --- Pointer input --------------------------------------------------------

  let drag = null;

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    svg.focus();
    const corner = event.target.closest('[data-corner]');
    const wall = event.target.closest('[data-wall]');
    const start = toPlan(event);
    if (corner) {
      const index = Number(corner.dataset.corner);
      state.selection = { kind: 'corner', index };
      drag = { kind: 'corner', index, start, screen: [event.clientX, event.clientY], moved: false };
    } else if (wall) {
      const index = Number(wall.dataset.wall);
      state.selection = { kind: 'wall', index };
      drag = { kind: 'wall', index, start, screen: [event.clientX, event.clientY], moved: false };
    } else {
      drag = { kind: 'pan', view: { ...state.view }, screen: [event.clientX, event.clientY], moved: false };
    }
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // (a pointer the browser no longer tracks: the drag still works while over the plan)
    }
    render();
  });

  svg.addEventListener('pointermove', (event) => {
    if (!drag) {
      return;
    }
    if (!drag.moved && Math.hypot(event.clientX - drag.screen[0], event.clientY - drag.screen[1]) < DRAG_START_PX) {
      return;
    }
    drag.moved = true;
    const footprint = state.editor.footprint;
    const snapping = !event.altKey;
    const reach = snapping ? SNAP_REACH_PX * scale() : 0;
    const grid = snapping ? 0.05 : 0;
    if (drag.kind === 'pan') {
      const rect = svg.getBoundingClientRect();
      state.view = {
        ...drag.view,
        x: drag.view.x - ((event.clientX - drag.screen[0]) / rect.width) * drag.view.w,
        y: drag.view.y - ((event.clientY - drag.screen[1]) / rect.height) * drag.view.h,
      };
      render();
      return;
    }
    const point = toPlan(event);
    try {
      if (drag.kind === 'corner') {
        const snapped = snapPoint(point, {
          footprint, corner: drag.index, neighbors: state.layers.neighbors ? state.neighbors : [], grid, reach,
        });
        state.snaps = snapped.snaps;
        state.preview = moveCorner(footprint, drag.index, snapped.point);
      } else {
        const wall = footprintWalls(footprint)[drag.index];
        const raw = (point[0] - drag.start[0]) * wall.normal[0] + (point[1] - drag.start[1]) * wall.normal[1];
        const snapped = snapWallOffset(footprint, drag.index, raw, { neighbors: state.layers.neighbors ? state.neighbors : [], grid, reach });
        state.snaps = [];
        state.preview = Math.abs(snapped.offset) > 1e-4 ? moveWall(footprint, drag.index, snapped.offset) : null;
      }
    } catch {
      state.preview = null;
    }
    render();
  });

  function endDrag(event) {
    if (!drag) {
      return;
    }
    const wasClick = !drag.moved;
    if (drag.kind === 'pan' && wasClick) {
      state.selection = null;
    }
    if (state.preview) {
      const before = state.editor.footprint.length;
      commit(state.preview);
      // an edit that added or removed corners renumbers them: keep the selection only when it still means the same thing
      if (state.editor.footprint.length !== before) {
        state.selection = null;
      }
    }
    state.preview = null;
    state.snaps = [];
    drag = null;
    if (event?.pointerId !== undefined && svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
    render();
  }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  svg.addEventListener('dblclick', (event) => {
    const wall = event.target.closest('[data-wall]');
    if (!wall) {
      return;
    }
    const index = Number(wall.dataset.wall);
    run(() => insertCorner(state.editor.footprint, index, toPlan(event)));
    state.selection = { kind: 'corner', index: index + 1 };
    render();
  });

  // --- Keyboard -------------------------------------------------------------

  function onKey(event) {
    if (event.target.closest?.('input, select, textarea')) {
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      setEditor(event.shiftKey ? redo(state.editor) : undo(state.editor));
    } else if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      setEditor(redo(state.editor));
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && state.selection?.kind === 'corner') {
      event.preventDefault();
      run(() => deleteCorner(state.editor.footprint, state.selection.index));
      state.selection = null;
      render();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      state.selection = null;
      render();
    }
    // footprint mode owns the keyboard while it's open
    event.stopImmediatePropagation();
  }
  document.addEventListener('keydown', onKey, true);

  // --- Edits ----------------------------------------------------------------

  let message = '';

  function setEditor(editor) {
    state.editor = editor;
    if (state.selection && state.selection.index >= editor.footprint.length) {
      state.selection = null;
    }
    render();
  }

  function commit(footprint) {
    state.editor = edit(state.editor, footprint);
    message = '';
  }

  /** Runs an operation and commits its outline, or shows why it couldn't be done. */
  function run(operation) {
    try {
      commit(operation());
    } catch (error) {
      message = error.message;
    }
    render();
  }

  /** A length typed in display units, in meters (NaN when it isn't a number). */
  function metersFrom(input) {
    return Number(input.value) / options.units().factor;
  }

  // --- Panel ----------------------------------------------------------------

  function renderPanel() {
    const { factor, short } = options.units();
    const footprint = state.editor.footprint;
    const walls = footprintWalls(footprint);
    const { area } = computeFootprintMetrics(footprint);
    const deviation = trace ? outlineDeviation(footprint, trace) : null;
    const selection = state.selection;
    const value = (meters, digits = 2) => (meters * factor).toFixed(digits);

    let selected = '<div class="fp-note">Select a corner or a wall to change it.</div>';
    if (selection?.kind === 'corner') {
      const [x, z] = footprint[selection.index];
      selected = `
        <div class="fp-subhead">Corner ${selection.index + 1}</div>
        <div class="fp-row">
          <label>x (${short})<input type="number" step="0.05" data-corner-field="0" value="${value(x)}" /></label>
          <label>z (${short})<input type="number" step="0.05" data-corner-field="1" value="${value(z)}" /></label>
        </div>
        <div class="fp-actions"><button data-action="delete-corner"${footprint.length <= 3 ? ' disabled' : ''}>Delete corner</button></div>`;
    } else if (selection?.kind === 'wall') {
      const wall = walls[selection.index];
      const along = wall.axis ? `along ${wall.axis}` : `at ${((wall.angle + 360) % 180).toFixed(1)}°`;
      selected = `
        <div class="fp-subhead">Wall ${selection.index + 1} <span class="fp-note">${along}</span></div>
        <div class="fp-row">
          <label>Length (${short})<input type="number" step="0.1" min="${value(MIN_WALL)}" data-wall-length value="${value(wall.length)}" /></label>
          <label>Move out (${short})<input type="number" step="0.1" data-wall-move value="0" /></label>
        </div>
        <div class="fp-actions">
          <button data-action="apply-wall">Apply</button>
          ${wall.axis ? '' : '<button data-action="straighten">Straighten</button>'}
        </div>
        <div class="fp-subhead">Bump-out or notch on this wall</div>
        <div class="fp-row">
          <label>From its start (${short})<input type="number" step="0.1" min="0" data-bump="start" value="${value((wall.length - Math.min(3, wall.length)) / 2, 1)}" /></label>
          <label>Width (${short})<input type="number" step="0.1" min="0" data-bump="width" value="${value(Math.min(3, wall.length), 1)}" /></label>
          <label>Depth (${short})<input type="number" step="0.1" min="0" data-bump="depth" value="${value(1.5, 1)}" /></label>
        </div>
        <div class="fp-actions">
          <button data-action="bump">Add bump-out</button>
          <button data-action="notch">Cut notch</button>
        </div>`;
    }

    const layer = (key, label, available = true, note = '') => `<label class="fp-check${available ? '' : ' unavailable'}">`
      + `<input type="checkbox" data-layer="${key}"${state.layers[key] && available ? ' checked' : ''}${available ? '' : ' disabled'} />${label}${note ? ` <span class="fp-note">${note}</span>` : ''}</label>`;
    const { tolerances } = state;

    panel.innerHTML = `
      <div class="fp-head">
        <div class="fp-title">Footprint</div>
        <div class="fp-note">${escapeHtml(options.title ?? '')}</div>
      </div>
      <div class="fp-actions">
        <button data-action="undo"${state.editor.past.length ? '' : ' disabled'} title="Ctrl+Z">Undo</button>
        <button data-action="redo"${state.editor.future.length ? '' : ' disabled'} title="Ctrl+Shift+Z">Redo</button>
        <button data-action="fit">Fit view</button>
      </div>
      <div class="fp-facts">
        <div>Area</div><div>${(area * factor * factor).toFixed(0)} sq ${short}</div>
        <div>Walls</div><div>${walls.length}</div>
        ${deviation === null ? '' : `<div>From the game's trace</div><div>up to ${formatLength(deviation, 2)}</div>`}
      </div>
      <section class="fp-section">${selected}</section>
      ${message ? `<div class="fp-message">${escapeHtml(message)}</div>` : ''}
      <details class="fp-section" data-section="square"${state.openSections.has('square') ? ' open' : ''}>
        <summary>Square up again</summary>
        <div class="fp-note">Squares the ${trace ? "game's trace" : 'outline'} to the building's axes. Smaller values keep more detail.</div>
        <div class="fp-row">
          <label>Square within (°)<input type="number" step="0.5" min="0" max="45" data-tolerance="maxSkewDegrees" value="${tolerances.maxSkewDegrees}" /></label>
          <label>Drop jogs under (${short})<input type="number" step="0.05" min="0" data-tolerance="minEdge" value="${value(tolerances.minEdge)}" /></label>
          <label>Merge lines within (${short})<input type="number" step="0.05" min="0" data-tolerance="align" value="${value(tolerances.align)}" /></label>
        </div>
        ${trace ? `<label class="fp-check"><input type="checkbox" data-tolerance="keepAsTraced"${tolerances.keepAsTraced ? ' checked' : ''} />Keep as traced (no squaring)</label>` : ''}
        <div class="fp-actions"><button data-action="resquare">${trace ? 'Start again from the trace' : 'Square up'}</button></div>
      </details>
      <details class="fp-section" data-section="layers"${state.openSections.has('layers') ? ' open' : ''}>
        <summary>Layers</summary>
        ${layer('aerial', 'Aerial', Boolean(state.aerial))}
        ${state.aerial ? `<label class="fp-row-label">Opacity<input type="range" min="0.1" max="1" step="0.05" data-aerial-opacity value="${state.aerialOpacity}" /></label>` : ''}
        ${layer('trace', "Game's trace", Boolean(trace))}
        ${layer('squared', 'Squared import', Boolean(squared))}
        ${layer('neighbors', 'Neighbors', state.neighbors.length > 0)}
        ${layer('guide', 'Eave guide', options.eaveDepth > 0, options.eaveDepth > 0 ? `(${formatLength(options.eaveDepth, 2)} in: trace the wall, not the roof edge)` : '')}
        ${layer('grid', '1 m grid')}
        ${state.contextNote ? `<div class="fp-note">${escapeHtml(state.contextNote)}</div>` : ''}
      </details>
      ${state.editor.problems.length ? `<ul class="fp-problems">${state.editor.problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join('')}</ul>` : ''}
      <div class="fp-footer">
        <button data-action="cancel">Cancel</button>
        <button data-action="use" class="primary"${state.editor.problems.length ? ' disabled title="Fix the problems listed first"' : ''}>Use this footprint</button>
      </div>`;
  }

  panel.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) {
      return;
    }
    const footprint = state.editor.footprint;
    const selection = state.selection;
    const field = (selector) => panel.querySelector(selector);
    switch (action) {
      case 'undo':
        setEditor(undo(state.editor));
        break;
      case 'redo':
        setEditor(redo(state.editor));
        break;
      case 'fit':
        fitView();
        render();
        break;
      case 'delete-corner':
        run(() => deleteCorner(footprint, selection.index));
        state.selection = null;
        render();
        break;
      case 'apply-wall': {
        const length = metersFrom(field('[data-wall-length]'));
        const move = metersFrom(field('[data-wall-move]'));
        run(() => {
          let next = footprint;
          if (Number.isFinite(length) && Math.abs(length - footprintWalls(next)[selection.index].length) > 1e-4) {
            next = setWallLength(next, selection.index, length);
          }
          if (Number.isFinite(move) && Math.abs(move) > 1e-4) {
            next = moveWall(next, selection.index, move);
          }
          return next;
        });
        break;
      }
      case 'straighten':
        run(() => straightenWall(footprint, selection.index));
        break;
      case 'bump':
      case 'notch': {
        const [start, width, depth] = ['start', 'width', 'depth'].map((key) => metersFrom(field(`[data-bump="${key}"]`)));
        run(() => addBump(footprint, selection.index, { start, width, depth: action === 'notch' ? -Math.abs(depth) : Math.abs(depth) }));
        state.selection = null;
        render();
        break;
      }
      case 'resquare':
        run(() => {
          if (!trace) {
            return resquare(footprint, state.tolerances);
          }
          if (state.tolerances.keepAsTraced) {
            return orientTo(trace, expectedWinding);
          }
          return orientTo(resquare(trace, state.tolerances), expectedWinding);
        });
        state.selection = null;
        render();
        break;
      case 'cancel':
        options.onCancel();
        break;
      case 'use':
        if (!state.editor.problems.length) {
          options.onUse(state.editor.footprint);
        }
        break;
      default:
        break;
    }
  });

  // a section's summary clicked: note whether it's about to open (the toggle
  // event comes later, and a redraw in between would otherwise lose it)
  panel.addEventListener('click', (event) => {
    const details = event.target.closest('summary')?.parentElement;
    const key = details?.dataset.section;
    if (key) {
      if (details.open) {
        state.openSections.delete(key);
      } else {
        state.openSections.add(key);
      }
    }
  });

  panel.addEventListener('change', (event) => {
    const target = event.target;
    if (target.dataset.layer) {
      state.layers[target.dataset.layer] = target.checked;
      render();
    } else if (target.dataset.tolerance) {
      const key = target.dataset.tolerance;
      if (key === 'keepAsTraced') {
        state.tolerances.keepAsTraced = target.checked;
      } else {
        const typed = Number(target.value);
        if (Number.isFinite(typed) && typed >= 0) {
          state.tolerances[key] = key === 'maxSkewDegrees' ? typed : typed / options.units().factor;
        }
      }
    } else if (target.dataset.cornerField !== undefined && state.selection?.kind === 'corner') {
      const point = [...state.editor.footprint[state.selection.index]];
      const typed = metersFrom(target);
      if (Number.isFinite(typed)) {
        point[Number(target.dataset.cornerField)] = typed;
        run(() => moveCorner(state.editor.footprint, state.selection.index, point));
      }
    }
  });

  panel.addEventListener('input', (event) => {
    if (event.target.dataset.aerialOpacity !== undefined) {
      state.aerialOpacity = Number(event.target.value);
      const image = groups.aerial.querySelector('image');
      if (image) {
        image.setAttribute('opacity', String(state.aerialOpacity));
      }
    }
  });

  // --- Lifetime -------------------------------------------------------------

  const resize = new ResizeObserver(() => {
    if (state.view) {
      // keep the scale and the middle; follow the new aspect
      const aspect = svg.clientWidth / Math.max(1, svg.clientHeight);
      const middle = [state.view.x + state.view.w / 2, state.view.y + state.view.h / 2];
      const h = state.view.w / aspect;
      state.view = { ...state.view, y: middle[1] - h / 2, h };
      render();
    }
  });
  resize.observe(svg);

  host.hidden = false;
  fitView();
  render();
  svg.focus();

  return {
    setContext({ neighbors, aerial, contextNote } = {}) {
      if (neighbors) {
        state.neighbors = neighbors.map(openRing);
      }
      if (aerial !== undefined) {
        state.aerial = aerial;
      }
      if (contextNote !== undefined) {
        state.contextNote = contextNote;
      }
      render();
    },
    close() {
      document.removeEventListener('keydown', onKey, true);
      resize.disconnect();
      host.hidden = true;
      host.innerHTML = '';
    },
  };
}

/** An outline in the given winding (the trace comes in the game's). */
function orientTo(footprint, winding) {
  const ring = openRing(footprint);
  const { signedArea } = computeFootprintMetrics(ring);
  const ccw = signedArea > 0;
  return (winding === 'CCW') === ccw ? ring : ring.reverse();
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
