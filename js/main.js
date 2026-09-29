import * as THREE from '../node_modules/three/build/three.module.js';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { validateFootprint, normalizeFootprint, computeFootprintMetrics } from './footprint.js';
import {
  createBuildingFromFootprint, volumeWallHeight, volumeFoundationHeight, roofHeightFromPitch, roofPitchFromHeight, roofPitchDegrees, setStraightSkeletonBuilder, TWO_SLOPE_DEFAULTS,
} from './extrusion.js';
import {
  normalizeRoofStructures, STRUCTURE_SUPPORTS, STRUCTURE_WALLS, structureFrame, structureWallSides, resolveRoofStructure, MAX_BRACKET_PROJECTION, hostEaveProfile,
} from './roof-structures.js';
import { STRUCTURE_UI_PRESETS, newRoofStructure, structureLabel, wallNames } from './structure-ui.js';
import { TWO_SLOPE_ROOF_TYPES } from './roof-planes.js';
import { sideOverhangs, resolveVolumeEaves } from './eaves.js';
import {
  computeFacadeLayout, serializeBuildingState, deserializeBuildingState, findVolumeAdjacencies, roofAxisForDirection, withStructureFacades, angledWallProblem, wallRunFrame,
} from './facade.js';
import {
  normalizeOpenings, createOpening, resolveOpening, MIN_OPENING_SIZE, OPENING_EDGE_MARGIN, DOOR_SILL_MAX,
} from './openings.js';
import { normalizeTrim, TRIM_HEIGHT_RANGE, TRIM_PROJECTION_RANGE } from './trim.js';
import { exportGlb } from './export.js';
import { buildGameFile } from './game-export.js';
import { importDixonFootprint } from './import.js';

const statusValue = document.getElementById('status-value');
const areaValue = document.getElementById('area-value');
const perimeterValue = document.getElementById('perimeter-value');
const centroidValue = document.getElementById('centroid-value');
const bboxValue = document.getElementById('bbox-value');
const facadeValue = document.getElementById('facade-value');
const statusBox = document.getElementById('status-box');
const fileInput = document.getElementById('file-input');
const windingSelect = document.getElementById('winding-select');
const unitSelect = document.getElementById('unit-select');
const frontSelect = document.getElementById('front-select');
const storyCountInput = document.getElementById('story-count');
const storyHeightInput = document.getElementById('story-height');
const kneeWallInput = document.getElementById('knee-wall-height');
const foundationInput = document.getElementById('foundation-height');
const panelsPerRunInput = document.getElementById('panels-per-run');
const roofTypeSelect = document.getElementById('roof-type');
const roofDirectionSelect = document.getElementById('roof-direction');
const roofPitchRiseInput = document.getElementById('roof-pitch-rise');
const roofPitchDisplay = document.getElementById('roof-pitch-display');
const roofHeightInput = document.getElementById('roof-height');
const roofEaveDepthInput = document.getElementById('roof-eave-depth');
const roofHeightModeSelect = document.getElementById('roof-height-mode');
const roofHeightModeField = document.getElementById('roof-height-mode-field');
const volumeSplitSelect = document.getElementById('volume-split');
const volumeSplitField = document.getElementById('volume-split-field');
const roofConnectionSelect = document.getElementById('roof-connection');
const roofConnectionField = document.getElementById('roof-connection-field');
const storyHeightUnit = document.getElementById('story-height-unit');
const roofHeightUnit = document.getElementById('roof-height-unit');
const roofEaveUnit = document.getElementById('roof-eave-unit');
const roofRakeUnit = document.getElementById('roof-rake-unit');
const roofFasciaUnit = document.getElementById('roof-fascia-unit');
const roofRakeDepthInput = document.getElementById('roof-rake-depth');
const roofFasciaDepthInput = document.getElementById('roof-fascia-depth');
const eaveSoffitSelect = document.getElementById('eave-soffit');
const rakeSoffitSelect = document.getElementById('rake-soffit');
const roofSupportNote = document.getElementById('roof-support-note');
const roofZoneTarget = document.getElementById('roof-zone-target');
const wallMaterialSelect = document.getElementById('wall-material');
const storyMaterialsBox = document.getElementById('story-materials');
const wallInfoPanel = document.getElementById('wall-info-panel');
const wallInfoSummary = document.getElementById('wall-info-summary');
const wallPanelMaterialsBox = document.getElementById('wall-panel-materials');
const wallOpeningsBox = document.getElementById('wall-openings-box');
const openingEditor = document.getElementById('opening-editor');
const volumeControlsBox = document.getElementById('volume-controls');
const scopeCrumbs = document.getElementById('scope-crumbs');
const facadeDefaultsPanel = document.getElementById('facade-defaults-panel');
const trimPanel = document.getElementById('trim-panel');
const trimControls = document.getElementById('trim-controls');
const volumeConfigPanel = document.getElementById('volume-config-panel');
const facadeSummaryBox = document.getElementById('facade-summary-box');
const roofGraphSummary = document.getElementById('roof-graph-summary');
const roofGraphEdges = document.getElementById('roof-graph-edges');
const sampleBtn = document.getElementById('sample-btn');
const footprintSelect = document.getElementById('footprint-select');
const loadBtn = document.getElementById('load-btn');
const saveBtn = document.getElementById('save-btn');
const exportBtn = document.getElementById('export-btn');
const sendBtn = document.getElementById('send-btn');
const resetViewBtn = document.getElementById('reset-view-btn');
const roofPitchField = document.getElementById('roof-pitch-field');
const roofHeightField = document.getElementById('roof-height-field');
const twoSlopeFields = document.getElementById('two-slope-fields');
const roofBreakHeightInput = document.getElementById('roof-break-height');
const roofLowerPitchInput = document.getElementById('roof-lower-pitch');
const roofUpperPitchInput = document.getElementById('roof-upper-pitch');
const roofWalkField = document.getElementById('roof-walk-field');
const roofWalkHeightInput = document.getElementById('roof-walk-height');
const roofWalkSize = document.getElementById('roof-walk-size');
const structurePresetSelect = document.getElementById('structure-preset');
const structureSideSelect = document.getElementById('structure-side');
const structureAddBtn = document.getElementById('structure-add-btn');
const structureEditor = document.getElementById('structure-editor');

const viewportCanvas = document.getElementById('viewport');
const topViewCanvas = document.getElementById('top-view');
const elevationViewCanvas = document.getElementById('elevation-view');
const elevationLabel = document.getElementById('elevation-label');

const renderer = new THREE.WebGLRenderer({ canvas: viewportCanvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0xf3f5f7, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const topRenderer = new THREE.WebGLRenderer({ canvas: topViewCanvas, antialias: true, alpha: true });
topRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
topRenderer.setClearColor(0xf3f5f7, 1);
topRenderer.outputColorSpace = THREE.SRGBColorSpace;

const elevationRenderer = new THREE.WebGLRenderer({ canvas: elevationViewCanvas, antialias: true, alpha: true });
elevationRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
elevationRenderer.setClearColor(0xf3f5f7, 1);
elevationRenderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x586678, 1.3);
scene.add(hemiLight);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.4);
sunLight.position.set(30, 45, 18);
scene.add(sunLight);

const fillLight = new THREE.DirectionalLight(0xcfe2ff, 0.65);
fillLight.position.set(-30, 18, -12);
scene.add(fillLight);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 5000);
camera.position.set(30, 18, 28);

const topCamera = new THREE.OrthographicCamera(-22, 22, 20, -20, 0.1, 5000);
topCamera.position.set(0, 35, 0);
topCamera.lookAt(0, 0, 0);

topCamera.rotation.order = 'YXZ';

const elevationCamera = new THREE.OrthographicCamera(-22, 22, 20, -20, 0.1, 5000);
elevationCamera.position.set(0, 3, 30);
elevationCamera.lookAt(0, 3, 0);

const controls = new OrbitControls(camera, viewportCanvas);
controls.enableDamping = true;
controls.target.set(0, 3, 0);

const topControls = new OrbitControls(topCamera, topViewCanvas);
topControls.enableRotate = false;
topControls.enablePan = true;
topControls.enableZoom = true;
topControls.target.set(0, 0, 0);

const elevationControls = new OrbitControls(elevationCamera, elevationViewCanvas);
elevationControls.enableRotate = false;
elevationControls.enablePan = true;
elevationControls.enableZoom = true;
elevationControls.target.set(0, 3, 0);

const group = new THREE.Group();
scene.add(group);
const hoverGroup = new THREE.Group();
scene.add(hoverGroup);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pickTargets = [];
let wallPickTargets = [];
let activeLayout = null;
let activeFoundationHeight = 0;
// The roof-building step's own per-volume zone descriptors (resolved ridge
// axis, roof type, bounds): what a roof structure actually validates its
// host side against. Kept distinct from `activeLayout.roofZones`, the
// facade layer's own roof-graph zones (used for the edge-role summary
// panel) — for a volume with no ridge-direction override, that one falls
// back to the footprint's geometric default ridge axis, which can differ
// from the building's actual configured roof direction.
let activeRoofZones = [];
let hoveredVolumeId = null;
// roof structures: the one being edited, what the last build made of each, and their meshes (for picking)
let selectedStructureId = null;
let hoveredStructureId = null;
let activeStructureEntries = [];
let structureMeshes = [];
// windows/doors: the one being edited, and what the last build made of each
let selectedOpeningId = null;
let activeOpeningEntries = [];
// a wall run picked directly (in the orbit or plan view), overriding the
// scope-implied wall the elevation would otherwise show (see elevationTarget)
let selectedWallId = null;
let hoveredWallId = null;
// which wall the elevation view is currently framed on, so a reload that
// keeps showing the same wall can preserve the user's own pan/zoom on it
// the way the orbit and plan views already preserve theirs (see loadFootprint)
let elevationTargetKey = null;

let loadedFootprint = null;
let activeBuildingSize = new THREE.Vector3(30, 0, 30);

/**
 * Sizes an orthographic camera's frustum to fit `contentWidth` × `contentHeight`
 * (world units) inside a canvas of `canvasAspect` (width/height) without
 * distorting it: the frustum's own aspect always matches the canvas's, and
 * whichever content dimension would otherwise overflow sets the scale. This
 * is what the old fixed-aspect top-view frustum skipped, which is why a wider
 * window used to stretch the plan instead of just showing more margin.
 */
function fitOrthoFrustum(orthoCamera, contentWidth, contentHeight, canvasAspect, margin = 1.15) {
  const safeAspect = Number.isFinite(canvasAspect) && canvasAspect > 0 ? canvasAspect : 1;
  const contentAspect = contentWidth / Math.max(contentHeight, 1e-6);
  let halfWidth;
  let halfHeight;
  if (contentAspect > safeAspect) {
    halfWidth = (contentWidth * margin) / 2;
    halfHeight = halfWidth / safeAspect;
  } else {
    halfHeight = (contentHeight * margin) / 2;
    halfWidth = halfHeight * safeAspect;
  }
  orthoCamera.left = -halfWidth;
  orthoCamera.right = halfWidth;
  orthoCamera.top = halfHeight;
  orthoCamera.bottom = -halfHeight;
  orthoCamera.updateProjectionMatrix();
}

function canvasAspect(canvas) {
  return canvas.clientWidth / Math.max(canvas.clientHeight, 1);
}

function updateTopCameraFrustum() {
  const width = Math.max(15, activeBuildingSize.x * 1.15);
  const depth = Math.max(15, activeBuildingSize.z * 1.15);
  fitOrthoFrustum(topCamera, width, depth, canvasAspect(topViewCanvas));
}

/** The bounding box (in the footprint plane) of every mass together. */
function overallBounds(volumes) {
  return volumes.reduce((bounds, candidate) => ({
    minX: Math.min(bounds.minX, candidate.minX),
    maxX: Math.max(bounds.maxX, candidate.maxX),
    minZ: Math.min(bounds.minZ, candidate.minZ),
    maxZ: Math.max(bounds.maxZ, candidate.maxZ),
  }), {
    minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
  });
}

/** Whether a mass's `side` sits on the whole building's own `side` (within a hair). */
function touchesOverallSide(volume, volumes, side) {
  return Math.abs(volume[side] - overallBounds(volumes)[side]) < 0.05;
}

/** The outward unit normal [nx, nz] of a mass's side, in the footprint plane. */
function outwardNormalForSide(side) {
  const frame = structureFrame(side);
  const magnitude = -frame.sign;
  return frame.inward === 'x' ? [magnitude, 0] : [0, magnitude];
}

/**
 * A mass's whole wall on `side`, as a 2D segment — independent of any notch a
 * neighboring mass cuts into it (see elevationTarget's wall-run branch below,
 * which follows the actual footprint edge instead, for a wall picked directly).
 */
function volumeWallSegment(volume, side) {
  const frame = structureFrame(side);
  const fixed = volume[side];
  const [minAlong, maxAlong] = frame.along === 'x' ? [volume.minX, volume.maxX] : [volume.minZ, volume.maxZ];
  const start = frame.along === 'x' ? [minAlong, fixed] : [fixed, minAlong];
  const end = frame.along === 'x' ? [maxAlong, fixed] : [fixed, maxAlong];
  return {
    start, end, length: maxAlong - minAlong, normal: outwardNormalForSide(side),
  };
}

/** Which of a wall run's host mass's four sides it actually lies on (null if it can't be told, e.g. a notch). */
function sideForWallRun(wallRun, layout) {
  const volume = layout.volumes.find((candidate) => candidate.id === wallRun.volumeId);
  if (!volume) {
    return null;
  }
  const eps = 0.05;
  if (wallRun.orientation === 'horizontal') {
    if (Math.abs(wallRun.start[1] - volume.maxZ) < eps) return 'maxZ';
    if (Math.abs(wallRun.start[1] - volume.minZ) < eps) return 'minZ';
  } else {
    if (Math.abs(wallRun.start[0] - volume.maxX) < eps) return 'maxX';
    if (Math.abs(wallRun.start[0] - volume.minX) < eps) return 'minX';
  }
  return null;
}

/**
 * The wall the elevation pane frames: a wall picked directly (selectedWallId)
 * wins; otherwise it follows the sidebar's own scope — a selected structure's
 * host wall, a selected mass's front wall, or, at the building level, the
 * front wall of whichever mass actually fronts the building. `key` identifies
 * the wall across reloads, so the same wall keeps its own pan/zoom instead of
 * snapping back to a fresh frame on every edit (see updateElevationCamera).
 */
function elevationTarget(layout) {
  if (selectedWallId) {
    const run = findRun(selectedWallId, layout);
    if (run?.runType === 'wall') {
      const [sx, sz] = run.start;
      const [ex, ez] = run.end;
      const normal = [(ez - sz) / run.length, -(ex - sx) / run.length];
      return {
        key: `wall:${run.id}`,
        start: run.start,
        end: run.end,
        length: run.length,
        normal,
        label: `${disambiguatedWallLabel(run, layout)} wall`,
      };
    }
    if (run?.runType === 'structure-wall') {
      const structure = structureRecord(run.structureId);
      return {
        key: `structure-wall:${run.id}`,
        start: run.start,
        end: run.end,
        length: run.length,
        normal: run.normal,
        label: structure ? `${structureLabel(structure, modelConfig.frontSide, { withHost: false })}, ${run.wall}` : run.wall,
      };
    }
    // a railing isn't a face to frame an elevation on; fall through to scope
  }
  if (selectedStructureId) {
    const structure = structureRecord(selectedStructureId);
    const hostVolumeId = structure && (structure.hostVolumeId ?? structureHostVolumeId(structure));
    const volume = hostVolumeId && layout.volumes.find((candidate) => candidate.id === hostVolumeId);
    if (structure && volume) {
      return {
        key: `structure:${structure.id}`,
        ...volumeWallSegment(volume, structure.hostSide),
        label: `${structureLabel(structure, modelConfig.frontSide, { withHost: false })} · host wall`,
      };
    }
  }
  const volume = layout.volumes.find((candidate) => candidate.id === selectedElementId)
    ?? layout.volumes.find((candidate) => touchesOverallSide(candidate, layout.volumes, modelConfig.frontSide));
  if (!volume) {
    return null;
  }
  return {
    key: `volume:${volume.id}`,
    ...volumeWallSegment(volume, modelConfig.frontSide),
    label: `${massName(volume, layout.volumes)} · front wall`,
  };
}

/**
 * Frames the elevation camera on elevationTarget's wall, from outside along
 * its outward normal. The same wall (by `key`) keeps its own pan/zoom across
 * a reload, the way the orbit and plan views already preserve theirs;
 * switching to a different wall reframes from scratch.
 */
function updateElevationCamera(layout, previousZoom, previousTarget) {
  const target = layout ? elevationTarget(layout) : null;
  if (!target) {
    elevationTargetKey = null;
    elevationLabel.textContent = 'Elevation';
    return;
  }
  elevationLabel.textContent = target.label;
  const sameTarget = target.key === elevationTargetKey;
  elevationTargetKey = target.key;
  const height = Math.max(activeBuildingSize.y, 1);
  const midX = (target.start[0] + target.end[0]) / 2;
  const midZ = (target.start[1] + target.end[1]) / 2;
  const midY = height / 2;
  const focus = sameTarget ? previousTarget : new THREE.Vector3(midX, midY, midZ);
  const [nx, nz] = target.normal;
  const distance = Math.max(target.length, height) * 2 + 10;
  elevationControls.target.copy(focus);
  elevationCamera.position.set(focus.x + nx * distance, focus.y, focus.z + nz * distance);
  elevationCamera.up.set(0, 1, 0);
  elevationCamera.lookAt(focus);
  fitOrthoFrustum(elevationCamera, target.length, height, canvasAspect(elevationViewCanvas));
  // Fitting a narrow wall's frustum to the canvas aspect can end up much
  // wider than the wall itself (e.g. a tall, narrow wing on a shallow
  // canvas), and an ortho camera draws anything in that width regardless of
  // depth — without a tight far clip, whatever else sits behind the wall
  // (another wing, the far side of a courtyard) shows through the gap beside
  // it. Clipping just past the wall's own plane keeps the view to the wall
  // and anything projecting toward the camera from it (a porch, a bay).
  const projectionAllowance = Math.max(target.length, height) + 10;
  elevationCamera.near = Math.max(0.1, distance - projectionAllowance);
  elevationCamera.far = distance + 1;
  elevationCamera.zoom = sameTarget ? previousZoom : 1;
  elevationCamera.updateProjectionMatrix();
}

let footprintLoadRequest = 0;
let windingPreference = windingSelect.value;
let displayUnits = unitSelect.value;
let roofControlAuthority = 'pitch';
let selectedElementId = 'building-defaults';
let modelConfig = {
  storyCount: Number(storyCountInput.value) || 2,
  storyHeight: 3.2,
  panelsPerRun: Number(panelsPerRunInput.value) || 2,
  roofType: roofTypeSelect.value,
  roofDirection: roofDirectionSelect.value,
  roofPitchRise: Number(roofPitchRiseInput.value) || 6,
  roofPitchRun: 12,
  roofHeight: 5,
  roofEaveDepth: 0.35,
  roofRakeDepth: 0.35,
  roofFasciaDepth: 0.1524,
  eaveSoffit: 'flat',
  rakeSoffit: 'sloped',
  roofHeightMode: roofHeightModeSelect.value,
  // how an L, T, or U footprint is cut into volumes (see decomposeIntoVolumes)
  volumeSplit: 'auto',
  wallMaterial: wallMaterialSelect.value,
  storyMaterials: [],
  panelMaterials: [],
  volumeStoryOverrides: {},
  // a half story's knee wall, for the building (undefined for none) and by volume
  kneeWallHeight: undefined,
  volumeKneeWalls: {},
  // the floor above grade, for the building and by volume, and story height by volume
  foundationDepth: 0.7,
  volumeFoundationHeights: {},
  volumeStoryHeights: {},
  volumeRidgeDirections: {},
  volumeRoofTypes: {},
  volumeRoofConnections: {},
  volumeRoofShapes: {},
  volumeEaves: {},
  edgePitchOverrides: {},
  roofStructures: [],
  openings: [],
  // water table, belt courses, cornice (see js/trim.js)
  trim: normalizeTrim(),
  // where an imported footprint came from, to put the building back (see import.js)
  placement: undefined,
  // the side the building fronts: walls are named from it (see wallNames)
  frontSide: 'maxZ',
};
let currentVolumeCount = 1;
// why any of modelConfig.roofStructures could not be built on the last render
let roofStructureIssues = '';

const UNIT_FACTORS = Object.freeze({ imperial: 3.28084, metric: 1 });

function unitFactor() {
  return UNIT_FACTORS[displayUnits];
}

function unitLabel() {
  return displayUnits === 'imperial' ? 'feet' : 'meters';
}

function formatLength(meters, decimals = 1) {
  return `${(meters * unitFactor()).toFixed(decimals)} ${unitLabel()}`;
}

function syncUnitLabels() {
  const label = unitLabel();
  storyHeightUnit.textContent = label;
  roofHeightUnit.textContent = label;
  roofEaveUnit.textContent = label;
  roofRakeUnit.textContent = label;
  roofFasciaUnit.textContent = label;
  document.querySelectorAll('.unit-label').forEach((span) => {
    span.textContent = label;
  });
}

function syncLengthInputs() {
  storyHeightInput.value = (modelConfig.storyHeight * unitFactor()).toFixed(1);
  foundationInput.value = ((modelConfig.foundationDepth ?? 0.7) * unitFactor()).toFixed(1);
  kneeWallInput.value = modelConfig.kneeWallHeight > 0 ? (modelConfig.kneeWallHeight * unitFactor()).toFixed(1) : '';
  roofHeightInput.value = (modelConfig.roofHeight * unitFactor()).toFixed(1);
  roofEaveDepthInput.value = (modelConfig.roofEaveDepth * unitFactor()).toFixed(1);
  syncEaveInputs(null);
  renderTrimPanel();
}

function syncEaveInputs(volumeId) {
  const own = volumeId ? modelConfig.volumeEaves[volumeId] ?? {} : {};
  const factor = unitFactor();
  roofEaveDepthInput.value = ((own.eaveDepth ?? modelConfig.roofEaveDepth) * factor).toFixed(1);
  roofRakeDepthInput.value = ((own.rakeDepth ?? modelConfig.roofRakeDepth) * factor).toFixed(1);
  roofFasciaDepthInput.value = ((own.fasciaDepth ?? modelConfig.roofFasciaDepth) * factor).toFixed(2);
  eaveSoffitSelect.value = own.eaveSoffit ?? modelConfig.eaveSoffit;
  rakeSoffitSelect.value = own.rakeSoffit ?? modelConfig.rakeSoffit;
}

function isRectangularFootprint(vertices) {
  if (vertices.length !== 4) {
    return false;
  }
  const xValues = new Set(vertices.map(([x]) => x));
  const zValues = new Set(vertices.map(([, z]) => z));
  return xValues.size === 2 && zValues.size === 2;
}

function updateRoofControlAvailability(vertices) {
  const rectangular = isRectangularFootprint(vertices);
  [roofTypeSelect, roofDirectionSelect, roofPitchRiseInput, roofHeightInput]
    .forEach((control) => {
      control.disabled = false;
    });
  roofSupportNote.textContent = rectangular
    ? 'Roof variants and eave projection are active.'
    : 'Roof variants follow this footprint; eave projection is constrained until roof zones are assigned.';
}

function updateRoofHeightModeVisibility(volumeCount) {
  roofHeightModeField.style.display = volumeCount > 1 ? '' : 'none';
  volumeSplitField.style.display = volumeCount > 1 ? '' : 'none';
}

syncUnitLabels();
syncLengthInputs();

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(120, 120),
  new THREE.MeshStandardMaterial({ color: 0xe6ebf0, roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.02;
scene.add(ground);

const axisHelper = new THREE.AxesHelper(8);
axisHelper.position.y = 0.01;
scene.add(axisHelper);

function setStatus(text, tone = 'default') {
  statusValue.textContent = text;
  statusBox.textContent = tone === 'error'
    ? `Validation error: ${text}`
    : text;
  statusBox.style.background = tone === 'error'
    ? 'rgba(214, 69, 69, 0.08)'
    : 'rgba(50, 107, 245, 0.08)';
  statusBox.style.borderColor = tone === 'error'
    ? 'rgba(214, 69, 69, 0.22)'
    : 'rgba(50, 107, 245, 0.18)';
}

function updateMetrics(metrics) {
  const { area, perimeter, centroid, bbox } = metrics;
  const factor = unitFactor();
  const areaUnit = displayUnits === 'imperial' ? 'square feet' : 'square meters';
  areaValue.textContent = `${(area * factor * factor).toFixed(2)} ${areaUnit}`;
  perimeterValue.textContent = formatLength(perimeter, 2);
  centroidValue.textContent = `(${(centroid.x * factor).toFixed(2)}, ${(centroid.z * factor).toFixed(2)}) ${unitLabel()}`;
  bboxValue.textContent = `x: ${(bbox.minX * factor).toFixed(2)}–${(bbox.maxX * factor).toFixed(2)}, z: ${(bbox.minZ * factor).toFixed(2)}–${(bbox.maxZ * factor).toFixed(2)} ${unitLabel()}`;
}

function syncRoofHeightFromPitch(footprint, volumes = []) {
  modelConfig.roofHeight = roofHeightFromPitch(
    footprint,
    modelConfig.roofDirection,
    modelConfig.roofPitchRise,
    modelConfig.roofPitchRun,
    volumes,
    modelConfig.roofType
  );
  roofHeightInput.value = (modelConfig.roofHeight * unitFactor()).toFixed(1);
  roofPitchRiseInput.value = String(modelConfig.roofPitchRise);
  updateRoofPitchDisplay();
}

function syncRoofPitchFromHeight(footprint, volumes = []) {
  const derivedPitchRise = Math.max(0.1, Math.min(24, roofPitchFromHeight(
    footprint,
    modelConfig.roofDirection,
    modelConfig.roofHeight,
    modelConfig.roofPitchRun,
    volumes,
    modelConfig.roofType
  )));
  roofPitchRiseInput.value = derivedPitchRise.toFixed(2);
  updateRoofPitchDisplay(derivedPitchRise);
}

function updateRoofPitchDisplay(pitchRise = modelConfig.roofPitchRise) {
  const degrees = roofPitchDegrees(pitchRise, modelConfig.roofPitchRun);
  const riseLabel = Number.isInteger(pitchRise)
    ? String(pitchRise)
    : pitchRise.toFixed(2);
  roofPitchDisplay.textContent = `${riseLabel}:${modelConfig.roofPitchRun} (approximately ${degrees.toFixed(1)}°)`;
}

function updateFacadeSummary(layout) {
  if (!layout) {
    facadeValue.textContent = '—';
    facadeSummaryBox.textContent = 'No footprint loaded.';
    return;
  }

  facadeValue.textContent = `${layout.facadePanels.length} facade panels · ${layout.stories.length} stories`;
  const structureRuns = layout.structureWallRuns?.length ?? 0;
  const railRuns = layout.railRuns?.length ?? 0;
  const structureSummary = structureRuns || railRuns
    ? `<br>Roof structure wall runs: ${structureRuns}<br>Railing runs: ${railRuns}`
    : '';
  // Which wall each panel belongs to, and picking one to edit, is the scope
  // control's and the wall-info panel's job now (see renderWallInfoPanel) —
  // this stays a plain count, not a per-panel dump.
  facadeSummaryBox.innerHTML = `Story height: ${formatLength(layout.storyHeight)}<br>Stories: ${layout.stories.length}<br>Facade panels: ${layout.facadePanels.length}${structureSummary}`;
  renderMaterialControls(layout);
  syncSelectionValidity(layout);
  renderVolumeControls(layout);
  syncSelectedRoofZoneControls(layout);
  renderRoofGraphSummary(layout);
}

function renderRoofGraphSummary(layout) {
  if (!roofGraphSummary || !roofGraphEdges) {
    return;
  }
  if (!layout?.roofGraph) {
    roofGraphSummary.textContent = 'No roof graph computed.';
    roofGraphEdges.innerHTML = '';
    return;
  }
  const { summary, edges, zones } = layout.roofGraph;
  roofGraphSummary.innerHTML = `<strong>${zones.length} Roof Zone(s):</strong> ${summary.eavesCount} eave(s) · ${summary.rakesCount} rake(s) · ${summary.highPlatesCount} high plate(s) · ${summary.flatCount} flat`;
  const edgeList = edges.map((e) => {
    const roleColor = e.role === 'eave' ? '#1f5edc' : e.role === 'rake' ? '#d97706' : e.role === 'high-plate' ? '#7c3aed' : '#6b7280';
    const roleBadge = `<span style="font-weight:700; color:${roleColor};">${e.role.toUpperCase()}</span>`;
    const pitchText = e.role === 'eave' ? ` (pitch ${e.pitchRise}:12)` : '';
    const volText = e.volumeId ? ` · ${e.volumeId.replace('-', ' ')}` : '';
    return `Edge ${e.index + 1} (${e.orientation}): ${roleBadge}${pitchText} · ${formatLength(e.length)}${volText}`;
  }).join('<br>');
  roofGraphEdges.innerHTML = edgeList;
}

/**
 * Keeps selectedElementId/selectedStructureId valid against the current
 * layout (a footprint reload can renumber or drop volumes and structures),
 * and shows only the panels that belong to the current scope: Building,
 * a mass, or a structure standing on one (see renderScopeControl).
 */
function syncSelectionValidity(layout) {
  const structure = selectedStructureId ? structureRecord(selectedStructureId) : null;
  if (selectedStructureId && !structure) {
    selectedStructureId = null;
  }
  // with a structure selected, its mass is the one whose fields would show
  const hostVolumeId = structure ? structureHostVolumeId(structure) : null;
  if (hostVolumeId && layout.volumes.some((volume) => volume.id === hostVolumeId)) {
    selectedElementId = hostVolumeId;
  }
  if (selectedElementId !== 'building-defaults' && !layout.volumes.some((volume) => volume.id === selectedElementId)) {
    selectedElementId = 'building-defaults';
  }
  // structureWallRuns/railRuns only exist once withStructureFacades has run
  // (not yet on the plain layout this also validates against, mid-render);
  // skip invalidating a structure-wall or railing selection against a layout
  // that doesn't carry them yet, rather than wrongly clearing it here only
  // for the later, fuller call to never get the chance to confirm it's fine.
  const wallStillExists = layout.wallRuns.some((run) => run.id === selectedWallId)
    || (!layout.structureWallRuns
      ? Boolean(selectedWallId)
      : layout.structureWallRuns.some((run) => run.id === selectedWallId) || (layout.railRuns ?? []).some((run) => run.id === selectedWallId));
  if (selectedWallId && !wallStillExists) {
    selectedWallId = null;
  }
  // a structure's own editor stands alone: the mass it stands on isn't shown alongside it
  facadeDefaultsPanel.style.display = selectedElementId === 'building-defaults' && !selectedStructureId ? '' : 'none';
  trimPanel.style.display = facadeDefaultsPanel.style.display;
  volumeConfigPanel.style.display = selectedStructureId ? 'none' : '';
}

/** A mass's name for the scope control: its size, and which side of the building it sits on. */
function massName(volume, allVolumes) {
  const overall = allVolumes.reduce((bounds, candidate) => ({
    minX: Math.min(bounds.minX, candidate.minX),
    maxX: Math.max(bounds.maxX, candidate.maxX),
    minZ: Math.min(bounds.minZ, candidate.minZ),
    maxZ: Math.max(bounds.maxZ, candidate.maxZ),
  }), {
    minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
  });
  const eps = 0.05;
  const touches = (side) => Math.abs(volume[side] - overall[side]) < eps;
  // a volume spanning the whole building on an axis (front to back, or side
  // to side) has nothing distinctive to say about that axis; naming it from
  // just one axis is what tells two same-sized wings (e.g. a U's two legs)
  // apart, since they differ on the axis the other one doesn't.
  const zLabel = touches('minZ') && touches('maxZ') ? null : touches('maxZ') ? wallName('maxZ') : touches('minZ') ? wallName('minZ') : null;
  const xLabel = touches('minX') && touches('maxX') ? null : touches('maxX') ? wallName('maxX') : touches('minX') ? wallName('minX') : null;
  const labels = [zLabel, xLabel].filter(Boolean).sort((a) => (a === 'front' || a === 'back' ? -1 : 1));
  const factor = unitFactor();
  const width = Math.round(Math.min(volume.maxX - volume.minX, volume.maxZ - volume.minZ) * factor);
  const length = Math.round(Math.max(volume.maxX - volume.minX, volume.maxZ - volume.minZ) * factor);
  const size = `${width} × ${length} ${unitLabel()}`;
  return labels.length ? `${size}, on the ${labels.join(' and ')}` : size;
}

/** A structure's rows in the scope control: its label, any build problem, and a delete button. */
function structureRowHtml(structure) {
  const entry = activeStructureEntries.find((candidate) => candidate.id === structure.id);
  const problem = entry?.errors?.[0] ?? entry?.warnings?.[0];
  const note = problem
    ? `<span class="structure-note${entry.errors.length ? ' error' : ''}">${escapeHtml(nameSides(problem.message))}</span>`
    : '';
  return `<div class="structure-row-wrap scope-structure-wrap"><button class="structure-row scope-btn structure-btn${structure.id === selectedStructureId ? ' selected' : ''}" data-structure-id="${structure.id}">`
    + `${escapeHtml(structureLabel(structure, modelConfig.frontSide, { withHost: false }))}${note}</button>`
    + `<button class="structure-delete" data-delete-structure="${structure.id}" title="Delete ${escapeHtml(structure.id)}" aria-label="Delete ${escapeHtml(structure.id)}">×</button></div>`;
}

/**
 * The scope control pinned at the top of the sidebar: Building, then each
 * mass, then (once a mass is selected) the structures standing on it.
 * Choosing an entry is the only way selectedElementId/selectedStructureId
 * change from the sidebar; a 3D click sets the same state (see pickAtPointer).
 */
/** A wall or structure-run row for the scope control: a button plus its own hover/select styling. */
function wallRowHtml(id, label) {
  return `<button class="scope-btn wall-btn${id === selectedWallId ? ' selected' : ''}" data-wall-id="${id}">${escapeHtml(label)}</button>`;
}

/**
 * A footprint wall run's label: its name from the front, marked "Inner"
 * when it doesn't sit on the building's own outer edge on that side — an L
 * or U's reentrant corner puts a second wall on, say, the left, facing into
 * the notch rather than out from the building, and without this a courtyard
 * wall and the building's actual left face would read as the same "Left
 * side" (see touchesOverallSide, the same check massName uses for a mass's
 * own name). A run a simple side name can't be told for (a skewed edge) falls
 * back to its length.
 */
function footprintWallLabel(run, layout) {
  const side = sideForWallRun(run, layout);
  if (!side) {
    return `Wall (${formatLength(run.length, 0)})`;
  }
  const name = wallName(side);
  const label = `${name[0].toUpperCase()}${name.slice(1)}`;
  const volume = layout.volumes.find((candidate) => candidate.id === run.volumeId);
  const outer = !volume || touchesOverallSide(volume, layout.volumes, side);
  return outer ? label : `Inner ${name}`;
}

/**
 * Numbers any label that repeats in the list ("Inner back (1)", "Inner back
 * (2)") — a wing narrower than the mass it attaches to splits that mass's
 * far wall into two flanking stubs, both inner and both facing the same way,
 * so front/back/left/right plus inner/outer still isn't always unique on its
 * own. A label that appears once is left as it is.
 */
function dedupeLabels(labels) {
  const counts = {};
  labels.forEach((label) => {
    counts[label] = (counts[label] ?? 0) + 1;
  });
  const seen = {};
  return labels.map((label) => {
    if (counts[label] <= 1) {
      return label;
    }
    seen[label] = (seen[label] ?? 0) + 1;
    return `${label} (${seen[label]})`;
  });
}

/** A wall run's label, numbered against its own mass's other walls if another of them would otherwise read the same (see dedupeLabels). */
function disambiguatedWallLabel(run, layout) {
  const siblings = layout.wallRuns.filter((candidate) => candidate.volumeId === run.volumeId);
  const labels = dedupeLabels(siblings.map((candidate) => footprintWallLabel(candidate, layout)));
  const index = siblings.findIndex((candidate) => candidate.id === run.id);
  return index >= 0 ? labels[index] : footprintWallLabel(run, layout);
}

function renderScopeControl(layout) {
  const buildingRow = `<button class="scope-btn${selectedElementId === 'building-defaults' ? ' selected' : ''}" data-scope="building">Building</button>`;
  const massRow = layout.volumes.map((volume) => `<button class="scope-btn${selectedElementId === volume.id ? ' selected' : ''}" data-scope="${volume.id}">${escapeHtml(massName(volume, layout.volumes))}</button>`).join('');
  const mass = layout.volumes.find((volume) => volume.id === selectedElementId);
  let wallsSection = '';
  let structureRow = '';
  if (mass) {
    if (selectedStructureId) {
      // the selected structure's own facade surfaces (withStructureFacades), not the house wall it stands on
      const walls = (layout.structureWallRuns ?? []).filter((run) => run.structureId === selectedStructureId);
      const rails = (layout.railRuns ?? []).filter((run) => run.structureId === selectedStructureId);
      const rows = [
        ...walls.map((run) => wallRowHtml(run.id, `${run.wall[0].toUpperCase()}${run.wall.slice(1)} wall`)),
        ...rails.map((run) => wallRowHtml(run.id, `Railing, ${run.wall}`)),
      ];
      if (rows.length) {
        wallsSection = `<div class="scope-section-label">Walls</div><div class="scope-row">${rows.join('')}</div>`;
      }
    } else {
      const massWalls = layout.wallRuns.filter((run) => run.volumeId === mass.id);
      if (massWalls.length) {
        const rows = massWalls.map((run) => wallRowHtml(run.id, disambiguatedWallLabel(run, layout))).join('');
        wallsSection = `<div class="scope-section-label">Walls</div><div class="scope-row">${rows}</div>`;
      }
    }
    const onThisMass = modelConfig.roofStructures.filter((structure) => structureHostVolumeId(structure) === mass.id);
    structureRow = `<div class="scope-section-label">Structures</div>${onThisMass.length
      ? `<div class="scope-row">${onThisMass.map(structureRowHtml).join('')}</div>`
      : '<div class="scope-empty">No roof structures on this mass yet.</div>'}`;
  }
  scopeCrumbs.innerHTML = `<div class="scope-row">${buildingRow}${massRow}</div>${wallsSection}${structureRow}`;
}

scopeCrumbs.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-delete-structure]');
  if (remove) {
    deleteStructure(remove.dataset.deleteStructure);
    return;
  }
  const wallBtn = event.target.closest('[data-wall-id]');
  if (wallBtn) {
    selectedWallId = wallBtn.dataset.wallId === selectedWallId ? null : wallBtn.dataset.wallId;
    if (loadedFootprint) {
      loadFootprint(loadedFootprint);
    }
    return;
  }
  const structureBtn = event.target.closest('[data-structure-id]');
  if (structureBtn) {
    selectedWallId = null;
    selectedStructureId = structureBtn.dataset.structureId === selectedStructureId ? null : structureBtn.dataset.structureId;
    if (loadedFootprint) {
      loadFootprint(loadedFootprint);
    }
    return;
  }
  const scopeBtn = event.target.closest('[data-scope]');
  if (!scopeBtn) {
    return;
  }
  selectedStructureId = null;
  selectedWallId = null;
  selectedElementId = scopeBtn.dataset.scope;
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

// Hovering a scope-control row highlights it in the orbit/plan view with the
// same cue a 3D hover already draws, so the sidebar and the model stay
// visually linked in both directions.
scopeCrumbs.addEventListener('pointerover', (event) => {
  if (!activeLayout) {
    return;
  }
  const wallBtn = event.target.closest('[data-wall-id]');
  const structureBtn = event.target.closest('[data-structure-id]');
  const scopeBtn = event.target.closest('[data-scope]');
  if (!wallBtn && !structureBtn && !scopeBtn) {
    return;
  }
  clearHoverCue();
  if (wallBtn && wallBtn.dataset.wallId !== selectedWallId) {
    renderWallCue(wallBtn.dataset.wallId, 0xf4b400, hoverGroup);
  } else if (structureBtn && structureBtn.dataset.structureId !== selectedStructureId) {
    renderStructureCue(structureBtn.dataset.structureId, 0xf4b400, hoverGroup);
  } else if (scopeBtn && scopeBtn.dataset.scope !== 'building') {
    const volume = activeLayout.volumes.find((candidate) => candidate.id === scopeBtn.dataset.scope);
    if (volume && (volume.id !== selectedElementId || selectedStructureId)) {
      renderVolumeCue(volume, activeFoundationHeight, 0xf4b400, 0.06, hoverGroup);
    }
  }
});
scopeCrumbs.addEventListener('pointerleave', () => {
  clearHoverCue();
});

/** The volume a structure stands on, through any structures it is stacked on. */
function structureHostVolumeId(structure) {
  const seen = new Set();
  let current = structure;
  while (current?.hostStructureId && !seen.has(current.id)) {
    seen.add(current.id);
    current = structureRecord(current.hostStructureId);
  }
  return current?.hostVolumeId ?? null;
}

function selectedVolume(layout) {
  return layout.volumes.find((volume) => volume.id === selectedElementId) ?? null;
}

function syncSelectedRoofZoneControls(layout) {
  const volume = selectedVolume(layout);
  roofZoneTarget.textContent = volume
    ? `Editing roof zone for ${volume.id.replace('-', ' ')}`
    : 'Editing building roof defaults';
  roofTypeSelect.value = volume
    ? modelConfig.volumeRoofTypes[volume.id] ?? modelConfig.roofType
    : modelConfig.roofType;
  roofDirectionSelect.value = volume
    ? modelConfig.volumeRidgeDirections[volume.id] ?? (volume.ridgeAxis === 'x' ? 'z-min' : 'x-min')
    : modelConfig.roofDirection;
  const roofType = volume ? modelConfig.volumeRoofTypes[volume.id] ?? modelConfig.roofType : modelConfig.roofType;
  // a mansard or gambrel neighbor has its own ends and is never merged into
  const mergeable = (neighbor) => neighbor && !TWO_SLOPE_ROOF_TYPES.includes(modelConfig.volumeRoofTypes[neighbor.id] ?? modelConfig.roofType);
  const canMerge = volume && (
    (roofType === 'shed' && mergeable(adjacentVolumeForHighEdge(volume, layout.volumes, roofDirectionSelect.value)))
    || (roofType === 'gable' && gableEndNeighbors(volume, layout.volumes).some(mergeable))
  );
  if (volume && layout.volumes.length > 1) {
    syncVolumeRoofShapeInputs(volume);
  }
  syncEaveInputs(volume && layout.volumes.length > 1 ? volume.id : null);
  syncRoofShapeFields(roofType);
  roofConnectionField.style.display = canMerge ? '' : 'none';
  if (canMerge) {
    // Unset, a gable's end merges into its neighbor (see resolveRoofConnections)
    // and a shed stays standalone; show that without saving it as a choice.
    roofConnectionSelect.value = modelConfig.volumeRoofConnections[volume.id] ?? (roofType === 'gable' ? 'merge-plane' : 'standalone');
  }

}

function volumeShapeTarget() {
  return selectedElementId !== 'building-defaults' && currentVolumeCount > 1 ? selectedElementId : null;
}

function syncVolumeRoofShapeInputs(volume) {
  const direction = modelConfig.volumeRidgeDirections[volume.id];
  const axis = direction ? roofAxisForDirection(direction) : volume.ridgeAxis;
  const halfSpan = Math.max(0.01, (axis === 'x' ? volume.maxZ - volume.minZ : volume.maxX - volume.minX) / 2);
  const shape = modelConfig.volumeRoofShapes[volume.id];
  const run = modelConfig.roofPitchRun;
  const heightMode = (shape?.mode ?? modelConfig.roofHeightMode) === 'height';
  let pitchRise;
  let height;
  if (heightMode) {
    height = shape?.mode === 'height' ? shape.height : modelConfig.roofHeight;
    pitchRise = (height / halfSpan) * run;
  } else {
    pitchRise = shape?.mode === 'slope' ? shape.pitchRise : modelConfig.roofPitchRise;
    height = halfSpan * (pitchRise / run);
  }
  roofPitchRiseInput.value = Number.isInteger(pitchRise) ? String(pitchRise) : pitchRise.toFixed(2);
  roofHeightInput.value = (height * unitFactor()).toFixed(1);
  updateRoofPitchDisplay(pitchRise);
}

/** The volumes touching a gable volume's ends. */
function gableEndNeighbors(volume, volumes) {
  const direction = modelConfig.volumeRidgeDirections[volume.id];
  const ridgeAxis = direction ? roofAxisForDirection(direction) : volume.ridgeAxis;
  const endSides = ridgeAxis === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ'];
  return findVolumeAdjacencies(volumes).flatMap((adjacency) => {
    if (adjacency.volumeAId === volume.id && endSides.includes(adjacency.sideA)) {
      return [adjacency.volumeBId];
    }
    return adjacency.volumeBId === volume.id && endSides.includes(adjacency.sideB) ? [adjacency.volumeAId] : [];
  }).map((id) => volumes.find((candidate) => candidate.id === id)).filter(Boolean);
}

function adjacentVolumeForHighEdge(volume, volumes, highEdge) {
  const side = { 'x-min': 'minX', 'x-max': 'maxX', 'z-min': 'minZ', 'z-max': 'maxZ' }[highEdge];
  if (!side) {
    return null;
  }
  const adjacency = findVolumeAdjacencies(volumes).find((candidate) => (
    (candidate.volumeAId === volume.id && candidate.sideA === side)
    || (candidate.volumeBId === volume.id && candidate.sideB === side)
  ));
  if (!adjacency) {
    return null;
  }
  const neighborId = adjacency.volumeAId === volume.id ? adjacency.volumeBId : adjacency.volumeAId;
  return volumes.find((candidate) => candidate.id === neighborId) ?? null;
}

function renderVolumeControls(layout) {
  updateRoofHeightModeVisibility(layout.volumes.length);
  if (layout.volumes.length <= 1) {
    volumeControlsBox.innerHTML = 'This footprint is a single volume; no independent massing to configure.';
    return;
  }

  const volume = selectedVolume(layout);
  if (!volume) {
    volumeControlsBox.innerHTML = 'Select a massing volume to edit it.';
    return;
  }

  const width = formatLength(Math.min(volume.maxX - volume.minX, volume.maxZ - volume.minZ));
  const length = formatLength(Math.max(volume.maxX - volume.minX, volume.maxZ - volume.minZ));
  const currentValue = modelConfig.volumeStoryOverrides[volume.id] ?? modelConfig.storyCount;
  // lengths this volume can set for itself, each empty for the building's
  const lengthField = (key, label, own, fallback, id) => `
    <div class="field">
      <label for="${volume.id}-${id}">${label} (${unitLabel()}; empty for the building's)</label>
      <input type="number" min="0" max="20" step="0.1" value="${Number.isFinite(own) ? (own * unitFactor()).toFixed(1) : ''}" placeholder="${Number.isFinite(fallback) ? (fallback * unitFactor()).toFixed(1) : 'none'}" data-volume-length="${key}" data-volume="${volume.id}" id="${volume.id}-${id}" />
    </div>`;
  volumeControlsBox.innerHTML = `
    <div class="field">
      <label for="${volume.id}-stories">${volume.id.replace('-', ' ')} (${width} × ${length})</label>
      <input type="number" min="1" max="12" step="1" value="${currentValue}" data-volume-id="${volume.id}" id="${volume.id}-stories" />
    </div>
    ${lengthField('volumeStoryHeights', 'Story height', modelConfig.volumeStoryHeights[volume.id], modelConfig.storyHeight, 'story-height')}
    ${lengthField('volumeKneeWalls', 'Half story above: knee wall', modelConfig.volumeKneeWalls[volume.id], modelConfig.kneeWallHeight, 'knee')}
    ${lengthField('volumeFoundationHeights', 'Floor above grade (foundation)', modelConfig.volumeFoundationHeights[volume.id], modelConfig.foundationDepth ?? 0.7, 'foundation')}
  `;
}

function createMaterialOptions(selected) {
  return ['wood', 'brick', 'stucco', 'metal', 'stone']
    .map((key) => `<option value="${key}"${key === selected ? ' selected' : ''}>${key[0].toUpperCase()}${key.slice(1)}</option>`)
    .join('');
}

function renderMaterialControls(layout) {
  storyMaterialsBox.innerHTML = layout.stories.map((story) => `
    <div class="field">
      <label for="${story.id}-material">${story.id.replace('-', ' ')}</label>
      <select data-material-axis="story" data-material-index="${story.index}" id="${story.id}-material">
        ${createMaterialOptions(story.material)}
      </select>
    </div>
  `).join('');
}

const WALL_ROLE_LABELS = {
  eave: 'Eave', rake: 'Rake', 'high-plate': 'High plate', flat: 'Flat',
};

/**
 * The selected wall's own panel: its name, length, stories, and roof-edge
 * role, and its facade panels' materials — grouped under it ("Front, panel 2
 * of 2") rather than one flat list of every panel in the building. Shown
 * only for a footprint wall run; a structure's own wall or a railing doesn't
 * have a story count or roof-edge role the same way (its elevation label
 * already says what it is).
 */
function renderWallInfoPanel(layout) {
  const run = layout ? findRun(selectedWallId, layout) : null;
  if (!run || run.runType !== 'wall') {
    wallInfoPanel.style.display = 'none';
    wallInfoSummary.innerHTML = '';
    wallPanelMaterialsBox.innerHTML = '';
    wallOpeningsBox.innerHTML = '';
    openingEditor.innerHTML = '';
    // no wall (or a structure/rail run) is selected, so no window/door on a
    // wall can be either — every place that clears selectedWallId funnels
    // through this one render, rather than each needing its own reset
    selectedOpeningId = null;
    return;
  }
  wallInfoPanel.style.display = '';
  const name = disambiguatedWallLabel(run, layout);
  const volume = layout.volumes.find((candidate) => candidate.id === run.volumeId);
  const storyCount = volume ? modelConfig.volumeStoryOverrides[volume.id] ?? modelConfig.storyCount : modelConfig.storyCount;
  const roleLabel = WALL_ROLE_LABELS[run.role] ?? run.role;
  wallInfoSummary.innerHTML = `<strong>${escapeHtml(name)} wall</strong><br>`
    + `Length: ${formatLength(run.length)}<br>Stories: ${storyCount}<br>Roof edge: ${escapeHtml(roleLabel)}`;
  const panels = layout.facadePanels.filter((panel) => panel.wallRunId === run.id);
  wallPanelMaterialsBox.innerHTML = panels.map((panel) => `
    <div class="field">
      <label for="${panel.id}-material">${escapeHtml(name)}, panel ${panel.positionInRun + 1} of ${panel.runPanelCount}</label>
      <select data-material-axis="panel" data-material-index="${panel.index}" id="${panel.id}-material">
        ${createMaterialOptions(panel.material)}
      </select>
    </div>
  `).join('');
  renderOpeningsBox(run);
}

/** This wall's own windows/doors: an Add row, then each one's row (mirrors structureRowHtml). */
function renderOpeningsBox(wallRun) {
  const onThisWall = modelConfig.openings.filter((opening) => opening.hostWallRunId === wallRun.id);
  if (selectedOpeningId && !onThisWall.some((opening) => opening.id === selectedOpeningId)) {
    selectedOpeningId = null;
  }
  const addRow = '<div class="actions" style="margin:8px 0;">'
    + '<button data-add-opening="window">Add window</button>'
    + '<button data-add-opening="door">Add door</button>'
    + '</div>';
  const rows = onThisWall.length
    ? onThisWall.map(openingRowHtml).join('')
    : '<div class="scope-empty">No windows or doors on this wall yet.</div>';
  wallOpeningsBox.innerHTML = addRow + rows;
  const selected = selectedOpeningId ? openingRecord(selectedOpeningId) : null;
  // Rewriting the editor's HTML on every tick of a slider drag would tear
  // out the range input the pointer is captured on — see the identical
  // structureLiveDragging guard around structureEditor's own render.
  if (openingLiveDragging && document.activeElement?.type === 'range' && openingEditor.contains(document.activeElement)) {
    const readout = document.activeElement.parentElement?.querySelector('.slider-value');
    if (readout) {
      readout.value = Number(document.activeElement.value).toFixed(2);
    }
    return;
  }
  openingEditor.innerHTML = selected ? openingEditorHtml(selected) : '';
}

/** A window/door's row in the wall-info panel: its kind, any build problem, and a delete button. */
function openingRowHtml(opening) {
  const entry = activeOpeningEntries.find((candidate) => candidate.id === opening.id);
  const problem = entry?.errors?.[0] ?? entry?.warnings?.[0];
  const note = problem
    ? `<span class="structure-note${entry.errors.length ? ' error' : ''}">${escapeHtml(problem.message)}</span>`
    : '';
  const label = opening.kind === 'window' ? 'Window' : 'Door';
  return `<div class="structure-row-wrap"><button class="structure-row${opening.id === selectedOpeningId ? ' selected' : ''}" data-opening-id="${opening.id}">`
    + `${escapeHtml(label)}${note}</button>`
    + `<button class="structure-delete" data-delete-opening="${opening.id}" title="Delete ${escapeHtml(opening.id)}" aria-label="Delete ${escapeHtml(opening.id)}">×</button></div>`;
}

function openingRecord(id) {
  return modelConfig.openings.find((opening) => opening.id === id) ?? null;
}

/**
 * The valid range for an opening's offset/width/sillHeight/height, holding
 * every other field at its current value — the same "compose predictably"
 * rule structurePlacementLimits documents. Simpler than a roof structure's
 * limits: an opening's host wall run always exists once a footprint is
 * loaded (unlike a roof structure's host, which may never resolve), so
 * there's no fallback-vs-built branch to carry — only a defensive fallback
 * for the moment before any footprint has loaded at all.
 */
function openingPlacementLimits(opening) {
  const host = activeLayout?.wallRuns.find((run) => run.id === opening.hostWallRunId);
  if (!host) {
    return {
      offsetMin: -FALLBACK_PLACEMENT_RANGE,
      offsetMax: FALLBACK_PLACEMENT_RANGE,
      widthMin: MIN_OPENING_SIZE,
      widthMax: FALLBACK_PLACEMENT_RANGE * 2,
      heightMin: MIN_OPENING_SIZE,
      heightMax: FALLBACK_PLACEMENT_RANGE,
      sillHeightMin: 0,
      sillHeightMax: FALLBACK_PLACEMENT_RANGE,
    };
  }
  const wallHeight = volumeWallHeight(host.volumeId, modelConfig);
  const halfWidth = opening.width / 2;
  const halfTravel = Math.max(0, host.length / 2 - OPENING_EDGE_MARGIN - halfWidth);
  // width's own bound holds at offset 0, the same reasoning structurePlacementLimits
  // gives for a roof structure's width: otherwise dragging offset would
  // visibly rescale the width slider's own track under an untouched value
  const widthMax = Math.max(MIN_OPENING_SIZE, host.length - 2 * OPENING_EDGE_MARGIN);
  const heightMax = Math.max(MIN_OPENING_SIZE, wallHeight - OPENING_EDGE_MARGIN - opening.sillHeight);
  const sillHeightMax = opening.kind === 'door'
    ? DOOR_SILL_MAX
    : Math.max(0, wallHeight - OPENING_EDGE_MARGIN - opening.height);
  return {
    offsetMin: -halfTravel,
    offsetMax: halfTravel,
    widthMin: MIN_OPENING_SIZE,
    widthMax,
    heightMin: MIN_OPENING_SIZE,
    heightMax,
    sillHeightMin: 0,
    sillHeightMax,
  };
}

function openingEditorHtml(opening) {
  const limits = openingPlacementLimits(opening);
  const entry = activeOpeningEntries.find((candidate) => candidate.id === opening.id);
  const buildError = entry?.errors?.[0];
  const errorBanner = buildError
    ? `<div class="structure-editor-error">Not built: ${escapeHtml(buildError.message)}</div>`
    : '';
  const placement = [
    sliderField('Offset along the wall', 'offset', opening.offset, limits.offsetMin, limits.offsetMax),
    sliderField('Width', 'width', opening.width, limits.widthMin, limits.widthMax),
    sliderField('Height', 'height', opening.height, limits.heightMin, limits.heightMax),
    sliderField(opening.kind === 'door' ? 'Threshold height' : 'Sill height', 'sillHeight', opening.sillHeight, limits.sillHeightMin, limits.sillHeightMax),
  ];
  const materials = [selectField('Frame material', 'frameMaterial', MATERIAL_OPTIONS, opening.materials?.frame ?? '')];
  if (opening.kind === 'door') {
    materials.push(selectField('Door material', 'panelMaterial', MATERIAL_OPTIONS, opening.materials?.panel ?? ''));
  }
  return `<div class="structure-editor-head"><span>Editing ${escapeHtml(opening.id)}</span></div>${errorBanner}`
    + fieldGroup('Placement', placement)
    + fieldGroup('Materials', materials);
}

function rebuildWithOpenings(openings) {
  modelConfig.openings = normalizeOpenings(openings);
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
}

/** Applies one opening-editor field's current value to its record and rebuilds — mirrors applyStructureFieldEdit. */
function applyOpeningFieldEdit(input) {
  const record = openingRecord(selectedOpeningId);
  if (!input || !record) {
    return;
  }
  const edited = { ...record, materials: { ...record.materials } };
  const length = () => (Number(input.value) || 0) / unitFactor();
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  switch (input.dataset.field) {
    case 'offset': {
      const limits = openingPlacementLimits(record);
      edited.offset = clamp(length(), limits.offsetMin, limits.offsetMax);
      break;
    }
    case 'width': {
      const limits = openingPlacementLimits(record);
      edited.width = clamp(length(), limits.widthMin, limits.widthMax);
      const offsetLimits = openingPlacementLimits({ ...record, width: edited.width });
      edited.offset = clamp(record.offset, offsetLimits.offsetMin, offsetLimits.offsetMax);
      break;
    }
    case 'height': {
      const limits = openingPlacementLimits(record);
      edited.height = clamp(length(), limits.heightMin, limits.heightMax);
      break;
    }
    case 'sillHeight': {
      const limits = openingPlacementLimits(record);
      edited.sillHeight = clamp(length(), limits.sillHeightMin, limits.sillHeightMax);
      break;
    }
    case 'frameMaterial': edited.materials.frame = input.value || undefined; break;
    case 'panelMaterial': edited.materials.panel = input.value || undefined; break;
    default: return;
  }
  rebuildWithOpenings(modelConfig.openings.map((opening) => (opening.id === record.id ? edited : opening)));
}

/** Deletes a window or door. */
function deleteOpening(id) {
  if (selectedOpeningId === id) {
    selectedOpeningId = null;
  }
  rebuildWithOpenings(modelConfig.openings.filter((opening) => opening.id !== id));
}

wallOpeningsBox.addEventListener('click', (event) => {
  const addBtn = event.target.closest('[data-add-opening]');
  if (addBtn) {
    if (!activeLayout || !selectedWallId) {
      return;
    }
    const record = createOpening(addBtn.dataset.addOpening, { hostWallRunId: selectedWallId }, modelConfig.openings);
    selectedOpeningId = record.id;
    rebuildWithOpenings([...modelConfig.openings, record]);
    return;
  }
  const removeBtn = event.target.closest('[data-delete-opening]');
  if (removeBtn) {
    deleteOpening(removeBtn.dataset.deleteOpening);
    return;
  }
  const rowBtn = event.target.closest('[data-opening-id]');
  if (rowBtn) {
    selectedOpeningId = rowBtn.dataset.openingId === selectedOpeningId ? null : rowBtn.dataset.openingId;
    if (loadedFootprint) {
      loadFootprint(loadedFootprint);
    }
  }
});

openingEditor.addEventListener('change', (event) => {
  applyOpeningFieldEdit(event.target.closest('[data-field]'));
});

let openingLiveDragging = false;
openingEditor.addEventListener('input', (event) => {
  const input = event.target.closest('input[type="range"][data-field]');
  if (!input) {
    return;
  }
  openingLiveDragging = true;
  try {
    applyOpeningFieldEdit(input);
  } finally {
    openingLiveDragging = false;
  }
});

/**
 * The rectangle (on the wall's own face) a window/door's raw fields
 * describe, whether or not it actually built — reconstructed straight from
 * the record the same reason structureFootprintRect is: a failed opening has
 * no resolved geometry to draw from.
 */
function openingFailureRect(opening, layout) {
  const wallRun = layout.wallRuns.find((run) => run.id === opening.hostWallRunId);
  if (!wallRun) {
    return null;
  }
  const baseY = volumeFoundationHeight(wallRun.volumeId, modelConfig);
  const halfWidth = Math.max(0.15, (opening.width ?? 1) / 2);
  const midX = (wallRun.start[0] + wallRun.end[0]) / 2;
  const midZ = (wallRun.start[1] + wallRun.end[1]) / 2;
  const [dirX, dirZ] = wallRun.right;
  const offset = Number.isFinite(opening.offset) ? opening.offset : 0;
  const point = (u) => [midX + dirX * u, midZ + dirZ * u];
  const sill = Math.max(0, Number.isFinite(opening.sillHeight) ? opening.sillHeight : 0);
  const height = Math.max(0.15, opening.height ?? 1);
  return {
    start: point(offset - halfWidth), end: point(offset + halfWidth), normal: wallRun.normal, yMin: baseY + sill, yMax: baseY + sill + height,
  };
}

/** A dashed outline on the wall's own face where a window/door that failed to build tried to go. */
function renderOpeningFailureMarker(opening, layout, parent) {
  const rect = openingFailureRect(opening, layout);
  if (!rect) {
    return;
  }
  const off = 0.03;
  const [nx, nz] = rect.normal;
  const corner = ([x, z], y) => new THREE.Vector3(x + nx * off, y, z + nz * off);
  const points = [
    corner(rect.start, rect.yMin), corner(rect.end, rect.yMin), corner(rect.end, rect.yMax), corner(rect.start, rect.yMax), corner(rect.start, rect.yMin),
  ];
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineDashedMaterial({
      color: 0xd64545, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.9, depthTest: false,
    })
  );
  line.computeLineDistances();
  line.userData.editorOnly = true;
  parent.add(line);
}

/** Every unbuilt window/door's attempted rectangle, drawn on its wall's own face (in both the orbit and elevation views — they share one scene). */
function renderOpeningFailureMarkers(layout) {
  modelConfig.openings.forEach((opening) => {
    const entry = activeOpeningEntries.find((candidate) => candidate.id === opening.id);
    if (entry?.errors?.length) {
      renderOpeningFailureMarker(opening, layout, group);
    }
  });
}

function disposeObject3D(object) {
  if (object.geometry) {
    object.geometry.dispose();
  }
  if (object.material) {
    if (Array.isArray(object.material)) {
      object.material.forEach((mat) => mat.dispose());
    } else {
      object.material.dispose();
    }
  }
}

function clearModel() {
  pickTargets = [];
  wallPickTargets = [];
  hoveredVolumeId = null;
  hoveredWallId = null;
  clearHoverCue();
  while (group.children.length > 0) {
    const child = group.children.pop();
    child.traverse(disposeObject3D);
  }
}

function renderFootprintPreview(vertices) {
  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(vertices.map(([x, z]) => new THREE.Vector3(x, 0.02, z))),
    new THREE.LineBasicMaterial({ color: 0x1f5edc })
  );
  outline.userData.editorOnly = true;
  outline.position.y = 0.02;
  group.add(outline);
}

/**
 * The building's front, marked in the views: an arrow on the ground just
 * out from the middle of the front, pointing away from the house, labeled
 * FRONT (editor-only; not exported).
 */
function renderFrontMarker(vertices) {
  const xs = vertices.map(([x]) => x);
  const zs = vertices.map(([, z]) => z);
  const bounds = { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  const side = modelConfig.frontSide ?? 'maxZ';
  const sign = side.startsWith('max') ? 1 : -1;
  const acrossX = side === 'minX' || side === 'maxX';
  const span = acrossX ? bounds.maxZ - bounds.minZ : bounds.maxX - bounds.minX;
  const size = Math.min(3, Math.max(1.2, span * 0.25));
  const gap = 1.2;
  // (u along the front, v out from it) -> [x, z]
  const at = (u, v) => (acrossX
    ? [bounds[side] + sign * v, (bounds.minZ + bounds.maxZ) / 2 + u]
    : [(bounds.minX + bounds.maxX) / 2 + u, bounds[side] + sign * v]);
  const arrow = [
    [-size * 0.18, gap], [size * 0.18, gap], [size * 0.18, gap + size * 0.55], [size * 0.45, gap + size * 0.55],
    [0, gap + size], [-size * 0.45, gap + size * 0.55], [-size * 0.18, gap + size * 0.55],
  ].map(([u, v]) => at(u, v));
  const shape = new THREE.Shape(arrow.map(([x, z]) => new THREE.Vector2(x, -z)));
  const geometry = new THREE.ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x1f5edc, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
  mesh.position.y = 0.03;
  mesh.userData.editorOnly = true;
  group.add(mesh);

  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.fillStyle = '#1f5edc';
  context.font = 'bold 44px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('FRONT', 128, 34);
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false }));
  const [lx, lz] = at(0, gap + size + 0.9);
  label.position.set(lx, 0.6, lz);
  label.scale.set(size * 1.4, size * 0.35, 1);
  label.userData.editorOnly = true;
  group.add(label);
}

function renderFacadeGuides(layout, foundationHeight) {
  if (!layout) {
    return;
  }

  const guideGroup = new THREE.Group();
  guideGroup.userData.editorOnly = true;
  const guideMaterial = new THREE.LineDashedMaterial({
    color: 0x4c6ef5,
    dashSize: 0.7,
    gapSize: 0.45,
    transparent: true,
    opacity: 0.9,
  });
  const faceOffset = 0.002;

  layout.stories.forEach((story) => {
    const y = foundationHeight + story.minY + 0.01;
    layout.wallRuns.forEach((wallRun) => {
      const [startX, startZ] = wallRun.start;
      const [endX, endZ] = wallRun.end;
      const [normalX, normalZ] = wallRun.normal;
      const points = [
        new THREE.Vector3(startX + normalX * faceOffset, y, startZ + normalZ * faceOffset),
        new THREE.Vector3(endX + normalX * faceOffset, y, endZ + normalZ * faceOffset),
      ];
      const storyGuide = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        guideMaterial.clone()
      );
      storyGuide.computeLineDistances();
      guideGroup.add(storyGuide);
    });
  });

  layout.facadePanels.forEach((panel) => {
    const [startX, startZ] = panel.start;
    const [endX, endZ] = panel.end;
    const edgeLength = Math.hypot(endX - startX, endZ - startZ);
    const normalX = (endZ - startZ) / edgeLength;
    const normalZ = -(endX - startX) / edgeLength;
    const guideX = startX + normalX * faceOffset;
    const guideZ = startZ + normalZ * faceOffset;
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(guideX, foundationHeight + 0.01, guideZ),
      new THREE.Vector3(guideX, foundationHeight + layout.totalHeight + 0.01, guideZ),
    ]);
    const line = new THREE.Line(geometry, guideMaterial.clone());
    line.computeLineDistances();
    guideGroup.add(line);
  });

  group.add(guideGroup);
}

async function loadFootprint(footprintData, preserveView = true) {
  const previousCameraPosition = camera.position.clone();
  const previousCameraTarget = controls.target.clone();
  const previousTopZoom = topCamera.zoom;
  const previousTopTarget = topControls.target.clone();
  const previousElevationZoom = elevationCamera.zoom;
  const previousElevationTarget = elevationControls.target.clone();
  clearModel();
  loadedFootprint = Array.isArray(footprintData) ? footprintData : JSON.parse(JSON.stringify(footprintData));

  const vertices = loadedFootprint;
  const validation = validateFootprint(vertices, { expectedWinding: windingPreference });

  if (!validation.valid) {
    setStatus(validation.errors.join(' '), 'error');
    return;
  }

  const normalized = normalizeFootprint(vertices, { expectedWinding: windingPreference });
  const angledProblem = angledWallProblem(normalized);
  if (angledProblem) {
    setStatus(angledProblem, 'error');
    return;
  }
  updateRoofControlAvailability(normalized);
  const layout = computeFacadeLayout(normalized, {
    volumeSplit: modelConfig.volumeSplit,
    kneeWallHeight: modelConfig.kneeWallHeight,
    storyCount: modelConfig.storyCount,
    storyHeight: modelConfig.storyHeight,
    panelsPerRun: modelConfig.panelsPerRun,
    wallMaterial: modelConfig.wallMaterial,
    storyMaterials: modelConfig.storyMaterials,
    panelMaterials: modelConfig.panelMaterials,
    roofType: modelConfig.roofType,
    roofDirection: modelConfig.roofDirection,
    roofPitchRise: modelConfig.roofPitchRise,
    roofPitchRun: modelConfig.roofPitchRun,
    roofHeight: modelConfig.roofHeight,
    roofEaveDepth: modelConfig.roofEaveDepth,
    volumeRoofTypes: modelConfig.volumeRoofTypes,
    volumeRidgeDirections: modelConfig.volumeRidgeDirections,
    volumeRoofShapes: modelConfig.volumeRoofShapes,
    edgePitchOverrides: modelConfig.edgePitchOverrides,
  });
  currentVolumeCount = layout.volumes.length;
  if (roofControlAuthority === 'pitch') {
    syncRoofHeightFromPitch(normalized, layout.volumes);
  } else {
    syncRoofPitchFromHeight(normalized, layout.volumes);
  }
  const metrics = computeFootprintMetrics(normalized);
  updateMetrics(metrics);
  updateFacadeSummary(layout);
  setStatus(`Valid footprint loaded (${windingPreference})`, 'default');

  const {
    building, foundationHeight, roofStructures, structureFacades, roofWalks, roofZones: builtRoofZones, openings: openingEntries,
  } = createBuildingFromFootprint(normalized, {
    storyCount: modelConfig.storyCount,
    storyHeight: modelConfig.storyHeight,
    panelsPerRun: modelConfig.panelsPerRun,
    wallMaterial: modelConfig.wallMaterial,
    storyMaterials: modelConfig.storyMaterials,
    panelMaterials: modelConfig.panelMaterials,
    roofType: modelConfig.roofType,
    roofDirection: modelConfig.roofDirection,
    roofPitchRise: modelConfig.roofPitchRise,
    roofPitchRun: modelConfig.roofPitchRun,
    roofHeight: modelConfig.roofHeight,
    roofEaveDepth: modelConfig.roofEaveDepth,
    roofZones: layout.roofZones,
    facadeLayout: layout,
    volumes: layout.volumes,
    volumeStoryOverrides: modelConfig.volumeStoryOverrides,
    kneeWallHeight: modelConfig.kneeWallHeight,
    volumeKneeWalls: modelConfig.volumeKneeWalls,
    volumeFoundationHeights: modelConfig.volumeFoundationHeights,
    volumeStoryHeights: modelConfig.volumeStoryHeights,
    volumeRidgeDirections: modelConfig.volumeRidgeDirections,
    volumeRoofTypes: modelConfig.volumeRoofTypes,
    volumeRoofConnections: modelConfig.volumeRoofConnections,
    volumeRoofShapes: modelConfig.volumeRoofShapes,
    volumeEaves: modelConfig.volumeEaves,
    roofRakeDepth: modelConfig.roofRakeDepth,
    roofFasciaDepth: modelConfig.roofFasciaDepth,
    eaveSoffit: modelConfig.eaveSoffit,
    rakeSoffit: modelConfig.rakeSoffit,
    roofHeightMode: modelConfig.roofHeightMode,
    roofStructures: modelConfig.roofStructures,
    openings: modelConfig.openings,
    trim: modelConfig.trim,
    roofBreakHeight: modelConfig.roofBreakHeight,
    roofLowerPitchRise: modelConfig.roofLowerPitchRise,
    roofUpperPitchRise: modelConfig.roofUpperPitchRise,
    roofWalkHeight: modelConfig.roofWalkHeight,
    foundationDepth: modelConfig.foundationDepth ?? 0.7,
    roofOverhang: 0.35,
  });
  const unbuilt = roofStructures.filter((entry) => entry.errors.length);
  roofStructureIssues = unbuilt.length
    ? `Roof structures not built: ${unbuilt.map((entry) => `${entry.id} (${entry.errors.map((e) => nameSides(e.message)).join(' ')})`).join('; ')}`
    : '';
  if (roofStructureIssues) {
    setStatus(roofStructureIssues, 'error');
  }

  group.add(building);
  // the roof structures' walls and railings, and the widow's walks, join the footprint's facade surfaces
  activeLayout = withStructureFacades(layout, structureFacades, roofWalks);
  showWalkSize(roofWalks);
  if (activeLayout.structureWallRuns.length || activeLayout.railRuns.length) {
    updateFacadeSummary(activeLayout);
  }
  activeFoundationHeight = foundationHeight;
  activeRoofZones = builtRoofZones ?? [];
  activeStructureEntries = roofStructures;
  activeOpeningEntries = openingEntries ?? [];
  structureMeshes = [];
  building.traverse((child) => {
    if (child.isMesh && child.userData?.structureId) {
      structureMeshes.push(child);
    }
  });
  addVolumePickTargets(layout, foundationHeight);
  addWallPickTargets(layout);
  if (selectedStructureId) {
    renderStructureCue(selectedStructureId, 0x00a6b8, group);
  } else {
    renderSelectedVolumeHighlight(layout, foundationHeight);
  }
  if (selectedWallId) {
    renderWallCue(selectedWallId, 0x00a6b8, group);
  }
  renderStructurePanel();
  renderStructureFailureMarkers(activeLayout);
  renderOpeningFailureMarkers(activeLayout);
  renderScopeControl(activeLayout);
  renderWallInfoPanel(activeLayout);
  if (normalized.length === 4) {
    renderFootprintPreview(normalized);
    renderFrontMarker(normalized);
  }
  renderFacadeGuides(layout, foundationHeight);

  const bounds = new THREE.Box3().setFromObject(building);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);

  if (preserveView) {
    camera.position.copy(previousCameraPosition);
    controls.target.copy(previousCameraTarget);
  } else {
    camera.position.set(center.x + maxDimension * 1.2, maxDimension * 0.9, center.z + maxDimension * 1.4);
    controls.target.copy(center);
  }
  controls.update();

  activeBuildingSize.copy(size);
  updateTopCameraFrustum();
  topCamera.zoom = preserveView ? previousTopZoom : 1;
  topControls.target.copy(preserveView ? previousTopTarget : center);
  topCamera.position.set(topControls.target.x, 30, topControls.target.z);
  topCamera.lookAt(topControls.target.x, 0, topControls.target.z);

  updateElevationCamera(activeLayout, previousElevationZoom, previousElevationTarget);
}

async function loadSampleFootprint() {
  const requestId = ++footprintLoadRequest;
  modelConfig.volumeStoryOverrides = {};
  modelConfig.volumeKneeWalls = {};
  modelConfig.volumeFoundationHeights = {};
  modelConfig.volumeStoryHeights = {};
  modelConfig.volumeRidgeDirections = {};
  modelConfig.volumeRoofTypes = {};
  modelConfig.volumeRoofConnections = {};
  modelConfig.volumeRoofShapes = {};
  modelConfig.volumeEaves = {};
  modelConfig.roofStructures = [];
  modelConfig.placement = undefined;
  modelConfig.frontSide = 'maxZ';
  frontSelect.value = 'maxZ';
  nameSideControls();
  // a new footprint: cut it to follow its massing (a .bld sets its own)
  modelConfig.volumeSplit = 'auto';
  volumeSplitSelect.value = 'auto';
  selectedElementId = 'building-defaults';
  selectedStructureId = null;
  selectedWallId = null;
  // a mass or wall run id can coincidentally match one from the previous
  // footprint (they're positional, e.g. "volume-0"), which would otherwise
  // make the elevation camera think it's still framed on the same wall and
  // keep that wall's stale pan/zoom instead of framing the new one fresh
  elevationTargetKey = null;
  const presetFiles = {
    sample: 'sample_footprint.json',
    u: 'footprint_u.json',
    l: 'footprint_l.json',
    'narrow-lean-to': 'footprint_narrow_lean_to.json',
    'wide-wing': 'footprint_wide_wing.json',
  };
  const response = await fetch(`./data/${presetFiles[footprintSelect.value]}`);
  const data = await response.json();
  if (requestId !== footprintLoadRequest) {
    return;
  }
  loadFootprint(data, false);
}

function renderSelectedVolumeHighlight(layout, foundationHeight) {
  const volume = selectedVolume(layout);
  if (!volume) {
    return;
  }
  renderVolumeCue(volume, foundationHeight, 0x00a6b8, 0.09, group);
}

function renderVolumeCue(volume, foundationHeight, color, opacity, parent) {
  const height = volumeWallHeight(volume.id, modelConfig) + volumeFoundationHeight(volume.id, modelConfig);
  const width = volume.maxX - volume.minX;
  const depth = volume.maxZ - volume.minZ;
  const centerX = (volume.minX + volume.maxX) / 2;
  const centerZ = (volume.minZ + volume.maxZ) / 2;
  const fill = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  fill.position.set(centerX, height / 2 + 0.04, centerZ);
  fill.userData.editorOnly = true;
  parent.add(fill);
  const roofY = height + 0.08;
  const roofOutline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(volume.minX, roofY, volume.minZ),
      new THREE.Vector3(volume.maxX, roofY, volume.minZ),
      new THREE.Vector3(volume.maxX, roofY, volume.maxZ),
      new THREE.Vector3(volume.minX, roofY, volume.maxZ),
      new THREE.Vector3(volume.minX, roofY, volume.minZ),
    ]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false })
  );
  roofOutline.userData.editorOnly = true;
  parent.add(roofOutline);
}

function addVolumePickTargets(layout, foundationHeight) {
  pickTargets = layout.volumes.map((volume) => {
    const height = volumeWallHeight(volume.id, modelConfig) + volumeFoundationHeight(volume.id, modelConfig);
    const target = new THREE.Mesh(
      new THREE.BoxGeometry(volume.maxX - volume.minX, height, volume.maxZ - volume.minZ),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    target.position.set((volume.minX + volume.maxX) / 2, height / 2 + 0.04, (volume.minZ + volume.maxZ) / 2);
    target.userData.volumeId = volume.id;
    target.userData.editorOnly = true;
    group.add(target);
    return target;
  });
}

/**
 * A thin invisible pick target for each footprint wall run, sitting just
 * outside the mass's own pick-target box so a click there resolves to the
 * wall (the nearer hit) rather than the mass behind it. DoubleSide keeps a
 * click from failing based on which way the rotation happens to face it,
 * since the target is never actually drawn.
 */
function addWallPickTargets(layout) {
  const thickness = 0.15;
  wallPickTargets = layout.wallRuns.map((wallRun) => {
    const height = volumeWallHeight(wallRun.volumeId, modelConfig) + volumeFoundationHeight(wallRun.volumeId, modelConfig);
    const [sx, sz] = wallRun.start;
    const [ex, ez] = wallRun.end;
    const { length } = wallRun;
    const [dirX, dirZ] = wallRun.right;
    const [normalX, normalZ] = wallRun.normal;
    const midX = (sx + ex) / 2;
    const midZ = (sz + ez) / 2;
    const offset = thickness / 2 + 0.03;
    const target = new THREE.Mesh(
      new THREE.BoxGeometry(length, height, thickness),
      new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    target.rotation.y = Math.atan2(-dirZ, dirX);
    target.position.set(midX + normalX * offset, height / 2 + 0.04, midZ + normalZ * offset);
    target.userData.wallId = wallRun.id;
    target.userData.editorOnly = true;
    group.add(target);
    return target;
  });
}

function clearHoverCue() {
  while (hoverGroup.children.length > 0) {
    const child = hoverGroup.children.pop();
    child.geometry?.dispose();
    child.material?.dispose();
  }
}

/**
 * Raycasts at a client-coordinate point against the volumes and roof
 * structures: what pointerup selects, and (from the last pointermove) what
 * the hover cue shows. A click reads this fresh rather than trusting
 * whatever the pointer was last hovering, so a press that never moved still
 * picks whatever is actually under it.
 */
/**
 * Raycasts at a client-coordinate point against the wall runs, volumes, and
 * roof structures, from whichever view is asking — the orbit view by
 * default, or the plan view (its own camera and canvas), so clicking a wall
 * or a mass there selects the same thing the scope control would.
 */
function pickAtPointer(clientX, clientY, pickCamera = camera, pickCanvas = viewportCanvas) {
  if (!activeLayout || (pickTargets.length === 0 && structureMeshes.length === 0 && wallPickTargets.length === 0)) {
    return { volumeId: null, structureId: null, wallId: null };
  }
  const rect = pickCanvas.getBoundingClientRect();
  pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, pickCamera);
  // the nearest of the wall runs, volumes, and roof structures under the
  // pointer; a wall run's target sits just outside its mass's own box, so
  // from outside it wins the nearest-hit without needing any special-casing
  const hit = raycaster.intersectObjects([...wallPickTargets, ...pickTargets, ...structureMeshes], false)[0];
  // a wraparound's side segment picks its porch
  const structureId = hit?.object.userData.recordId ?? hit?.object.userData.structureId ?? null;
  const wallId = !structureId ? hit?.object.userData.wallId ?? null : null;
  const volumeId = !structureId && !wallId ? hit?.object.userData.volumeId ?? null : null;
  return { volumeId, structureId, wallId };
}

function updateHoveredVolume(event, pickCamera = camera, pickCanvas = viewportCanvas) {
  const { volumeId, structureId, wallId } = pickAtPointer(event.clientX, event.clientY, pickCamera, pickCanvas);
  if (volumeId === hoveredVolumeId && structureId === hoveredStructureId && wallId === hoveredWallId) {
    return;
  }
  hoveredVolumeId = volumeId;
  hoveredStructureId = structureId;
  hoveredWallId = wallId;
  clearHoverCue();
  if (structureId && structureId !== selectedStructureId) {
    renderStructureCue(structureId, 0xf4b400, hoverGroup);
  }
  if (wallId && wallId !== selectedWallId) {
    renderWallCue(wallId, 0xf4b400, hoverGroup);
  }
  const volume = activeLayout.volumes.find((candidate) => candidate.id === volumeId);
  if (volume && (volume.id !== selectedElementId || selectedStructureId)) {
    renderVolumeCue(volume, activeFoundationHeight, 0xf4b400, 0.06, hoverGroup);
  }
  const pointerStyle = volume || structureId || wallId ? 'pointer' : 'default';
  viewportCanvas.style.cursor = pointerStyle;
  topViewCanvas.style.cursor = pointerStyle;
}

/** An outline around a wall run's face, as a selection or hover cue. */
/**
 * Any addressable run by id: a footprint wall run, a structure's own wall
 * run, or a railing run (the surfaces withStructureFacades adds — see
 * facade.js). Tagged with `runType` so callers (the cue renderer, the
 * elevation target, the wall-info panel) know which shape its fields are in:
 * a footprint or structure wall run's `start`/`end` are 2D ([x, z]); a
 * railing's are 3D ([x, y, z]), since it doesn't sit at a fixed floor line.
 */
function findRun(id, layout) {
  if (!id || !layout) {
    return null;
  }
  const wall = layout.wallRuns.find((run) => run.id === id);
  if (wall) {
    return { ...wall, runType: 'wall' };
  }
  const structureWall = (layout.structureWallRuns ?? []).find((run) => run.id === id);
  if (structureWall) {
    return { ...structureWall, runType: 'structure-wall' };
  }
  const rail = (layout.railRuns ?? []).find((run) => run.id === id);
  if (rail) {
    return { ...rail, runType: 'rail' };
  }
  return null;
}

/** An outline around a run's face (a wall, a structure's own wall, or a railing), as a selection or hover cue. */
function renderWallCue(wallId, color, parent) {
  const run = findRun(wallId, activeLayout);
  if (!run) {
    return;
  }
  let start2D;
  let end2D;
  let yBase;
  let yTop;
  if (run.runType === 'rail') {
    start2D = [run.start[0], run.start[2]];
    end2D = [run.end[0], run.end[2]];
    yBase = run.start[1];
    yTop = yBase + run.height;
  } else if (run.runType === 'structure-wall') {
    start2D = run.start;
    end2D = run.end;
    yBase = run.baseY + (run.extent?.minV ?? 0);
    yTop = run.baseY + (run.extent?.maxV ?? 3);
  } else {
    start2D = run.start;
    end2D = run.end;
    yBase = 0;
    yTop = volumeWallHeight(run.volumeId, modelConfig) + volumeFoundationHeight(run.volumeId, modelConfig);
  }
  const [sx, sz] = start2D;
  const [ex, ez] = end2D;
  const { normal: [normalX, normalZ] } = wallRunFrame(start2D, end2D);
  const off = 0.03;
  const corner = (x, z, y) => new THREE.Vector3(x + normalX * off, y, z + normalZ * off);
  const outline = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      corner(sx, sz, yBase), corner(ex, ez, yBase), corner(ex, ez, yTop), corner(sx, sz, yTop), corner(sx, sz, yBase),
    ]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, depthTest: false })
  );
  outline.userData.editorOnly = true;
  parent.add(outline);
}

/**
 * The plan rectangle a roof structure's raw fields describe, whether or not
 * it actually built: along its host wall (offset ± half its width) and out
 * from it (setback to setback + depth, in the host frame's inward
 * direction). A structure that failed to build has no mesh and never gets
 * as far as `resolveRoofStructure`'s own geometry, so this is worked out
 * straight from the record instead, the same way structurePlacementLimits'
 * fallback reasons about a host it hasn't resolved either. Approximate for a
 * polygon (a tower) or wraparound (its own wall-length fields, not offset)
 * — skipped rather than guessed at.
 */
function structureFootprintRect(structure, volumes) {
  if (!structure.hostVolumeId || structure.wrap || structure.plan?.shape === 'polygon') {
    return null;
  }
  const volume = volumes.find((candidate) => candidate.id === structure.hostVolumeId);
  const frame = structureFrame(structure.hostSide);
  if (!volume || !frame) {
    return null;
  }
  const [minAlong, maxAlong] = frame.along === 'x' ? [volume.minX, volume.maxX] : [volume.minZ, volume.maxZ];
  const alongCenter = (minAlong + maxAlong) / 2 + (Number.isFinite(structure.offset) ? structure.offset : 0);
  const halfWidth = Math.max(0.15, (structure.width ?? 1) / 2);
  const alongMin = alongCenter - halfWidth;
  const alongMax = alongCenter + halfWidth;
  const wallCoord = volume[structure.hostSide];
  const setback = structure.setback === 'center' ? 0 : (Number.isFinite(structure.setback) ? structure.setback : 0);
  const depth = Number.isFinite(structure.depth) ? structure.depth : 2.4;
  const near = wallCoord + frame.sign * setback;
  const far = near + frame.sign * depth;
  const inwardMin = Math.min(near, far);
  const inwardMax = Math.max(near, far);
  return frame.along === 'x'
    ? { minX: alongMin, maxX: alongMax, minZ: inwardMin, maxZ: inwardMax }
    : { minZ: alongMin, maxZ: alongMax, minX: inwardMin, maxX: inwardMax };
}

/** A dashed outline at ground level over the footprint a structure that failed to build tried to occupy. */
function renderStructureFailureMarker(structure, volumes, parent) {
  const rect = structureFootprintRect(structure, volumes);
  if (!rect) {
    return;
  }
  const y = 0.05;
  const points = [
    new THREE.Vector3(rect.minX, y, rect.minZ),
    new THREE.Vector3(rect.maxX, y, rect.minZ),
    new THREE.Vector3(rect.maxX, y, rect.maxZ),
    new THREE.Vector3(rect.minX, y, rect.maxZ),
    new THREE.Vector3(rect.minX, y, rect.minZ),
  ];
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineDashedMaterial({
      color: 0xd64545, dashSize: 0.3, gapSize: 0.2, transparent: true, opacity: 0.9, depthTest: false,
    })
  );
  line.computeLineDistances();
  line.userData.editorOnly = true;
  parent.add(line);
}

/** Every unbuilt structure's attempted footprint, drawn in the plan (and orbit — they share one scene). */
function renderStructureFailureMarkers(layout) {
  modelConfig.roofStructures.forEach((structure) => {
    const entry = activeStructureEntries.find((candidate) => candidate.id === structure.id);
    if (entry?.errors?.length) {
      renderStructureFailureMarker(structure, layout.volumes, group);
    }
  });
}

/** A box around a roof structure's visible meshes, as a selection or hover cue. */
function renderStructureCue(structureId, color, parent) {
  const box = new THREE.Box3();
  let found = false;
  structureMeshes.forEach((mesh) => {
    if ((mesh.userData.recordId ?? mesh.userData.structureId) === structureId) {
      box.expandByObject(mesh);
      found = true;
    }
  });
  if (!found) {
    return;
  }
  const helper = new THREE.Box3Helper(box, color);
  helper.material.depthTest = false;
  helper.material.transparent = true;
  helper.userData.editorOnly = true;
  parent.add(helper);
}

/** Clears everything tied to the last footprint, before another is opened. */
function resetForNewFootprint() {
  modelConfig.volumeStoryOverrides = {};
  modelConfig.volumeKneeWalls = {};
  modelConfig.volumeFoundationHeights = {};
  modelConfig.volumeStoryHeights = {};
  modelConfig.volumeRidgeDirections = {};
  modelConfig.volumeRoofTypes = {};
  modelConfig.volumeRoofConnections = {};
  modelConfig.volumeRoofShapes = {};
  modelConfig.volumeEaves = {};
  modelConfig.edgePitchOverrides = {};
  modelConfig.roofStructures = [];
  modelConfig.placement = undefined;
  modelConfig.frontSide = 'maxZ';
  frontSelect.value = 'maxZ';
  nameSideControls();
  // a new footprint: cut it to follow its massing (a .bld sets its own)
  modelConfig.volumeSplit = 'auto';
  volumeSplitSelect.value = 'auto';
  selectedElementId = 'building-defaults';
  selectedStructureId = null;
  selectedWallId = null;
  elevationTargetKey = null;
}

/**
 * Opens a parsed file: a project (.bld), a footprint exported from the
 * Dixon project (see js/import.js), or a plain footprint (an array of [x, z]).
 */
function openPayload(payload) {
  resetForNewFootprint();
  if (payload && payload.format === 'building-composer') {
    const result = deserializeBuildingState(payload);
    if (result.valid) {
      Object.assign(modelConfig, result.state);
      storyCountInput.value = modelConfig.storyCount;
      wallMaterialSelect.value = modelConfig.wallMaterial;
      roofTypeSelect.value = modelConfig.roofType;
      roofDirectionSelect.value = modelConfig.roofDirection;
      roofPitchRiseInput.value = modelConfig.roofPitchRise;
      roofHeightModeSelect.value = modelConfig.roofHeightMode;
      volumeSplitSelect.value = modelConfig.volumeSplit;
      frontSelect.value = modelConfig.frontSide;
      nameSideControls();
      syncUnitLabels();
      syncLengthInputs();
      updateRoofPitchDisplay();
      loadFootprint(result.state.footprint, false);
      const notes = [...result.warnings, roofStructureIssues].filter(Boolean);
      setStatus(notes.length
        ? `Project (.bld) loaded. ${notes.join(' ')}`
        : 'Project (.bld) loaded successfully.', roofStructureIssues ? 'error' : 'default');
      return;
    }
  }
  if (payload && payload.format === 'dixon-footprint') {
    const imported = importDixonFootprint(payload);
    if (imported.error) {
      setStatus(imported.error, 'error');
      return;
    }
    const saved = payload.project?.format === 'building-composer' ? deserializeBuildingState(payload.project) : undefined;
    if (saved?.valid) {
      const was = saved.state.placement;
      const now = imported.placement;
      const [dx, dz] = was ? [was.center[0] - now.center[0], was.center[1] - now.center[1]] : [Infinity, Infinity];
      if (Math.hypot(dx, dz) < 0.05 && Math.abs(Math.atan2(Math.sin(was.rotation - now.rotation), Math.cos(was.rotation - now.rotation))) < 0.005) {
        openPayload(payload.project);
        setStatus(`Building ${now.id}: the design saved from the game is open. ${imported.warnings.join(' ')}`.trim());
        return;
      }
      imported.warnings.push('The outline was changed in the game since this design was made, so the design is not opened; the new outline is.');
    }
    Object.assign(modelConfig, imported.settings, { placement: imported.placement });
    frontSelect.value = modelConfig.frontSide;
    nameSideControls();
    storyCountInput.value = modelConfig.storyCount;
    wallMaterialSelect.value = modelConfig.wallMaterial;
    roofTypeSelect.value = modelConfig.roofType;
    syncLengthInputs();
    updateRoofPitchDisplay();
    loadFootprint(imported.footprint, false);
    const angle = (imported.placement.rotation * 180) / Math.PI;
    setStatus([
      `Building ${imported.placement.id} imported from ${imported.placement.source}, turned ${angle.toFixed(1)} degrees square to the axes.`,
      ...imported.warnings, roofStructureIssues,
    ].filter(Boolean).join(' '), roofStructureIssues ? 'error' : 'default');
    return;
  }
  loadFootprint(payload, false);
}

function handleFileInput(event) {
  const [file] = event.target.files;
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    let payload;
    try {
      payload = JSON.parse(reader.result);
    } catch (error) {
      setStatus('Unable to parse JSON footprint file.', 'error');
      return;
    }
    openPayload(payload);
  };
  reader.readAsText(file);
}

/**
 * A file handed over in the page address, as `#import=<base64url JSON>`
 * (the Dixon building editor's X opens Composer this way). The fragment is
 * never sent to the server. Returns whether there was one.
 */
function openPayloadFromAddress() {
  const match = /^#import=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  if (!match) {
    return false;
  }
  // the address is cleared, so a reload doesn't open the file again over any edits
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
    openPayload(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    setStatus('The footprint in the page address could not be read.', 'error');
  }
  return true;
}

window.addEventListener('hashchange', openPayloadFromAddress);

saveBtn.addEventListener('click', () => {
  if (!activeLayout || !loadedFootprint) {
    setStatus('Load a footprint before saving project.', 'error');
    return;
  }
  const payload = serializeBuildingState(activeLayout, modelConfig);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'building-model.bld';
  link.click();
  URL.revokeObjectURL(url);
  setStatus('Project saved as building-model.bld', 'default');
});

sendBtn.addEventListener('click', async () => {
  if (!group.children.length || !activeLayout) {
    setStatus('Load a footprint before sending.', 'error');
    return;
  }
  const { placement } = modelConfig;
  if (!placement?.id) {
    setStatus('Only a building opened from the game (its X key) can be sent back to it.', 'error');
    return;
  }
  const project = serializeBuildingState(activeLayout, modelConfig);
  const file = buildGameFile(group, placement, project);
  const body = JSON.stringify(file);
  try {
    const response = await fetch(`/game-save/${encodeURIComponent(placement.id)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Composer': '1' }, body,
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    setStatus(`Building ${placement.id} sent to the game. In the game, select it and press I.`);
  } catch (error) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    link.download = `${placement.id}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    setStatus(`Not sent (${error.message || 'no game server'}); saved ${placement.id}.json. Put it in dixon_dem/game/data/composed/.`, 'error');
  }
});

exportBtn.addEventListener('click', async () => {
  if (!group.children.length) {
    setStatus('Load a footprint before exporting.', 'error');
    return;
  }

  const buffer = await exportGlb(group);
  const blob = new Blob([buffer], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'building-composer.glb';
  link.click();
  URL.revokeObjectURL(url);
});

windingSelect.addEventListener('change', () => {
  windingPreference = windingSelect.value;
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

storyCountInput.addEventListener('input', () => {
  modelConfig.storyCount = Math.max(1, Number(storyCountInput.value) || 1);
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

foundationInput.addEventListener('change', () => {
  modelConfig.foundationDepth = Math.max(0, Number(foundationInput.value) || 0) / unitFactor();
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

kneeWallInput.addEventListener('change', () => {
  const value = Number(kneeWallInput.value);
  modelConfig.kneeWallHeight = kneeWallInput.value === '' || !(value > 0) ? undefined : value / unitFactor();
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

storyHeightInput.addEventListener('input', () => {
  modelConfig.storyHeight = Math.max(0.1, (Number(storyHeightInput.value) || 0.1) / unitFactor());
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

panelsPerRunInput.addEventListener('input', () => {
  modelConfig.panelsPerRun = Math.max(1, Math.min(8, Number(panelsPerRunInput.value) || 1));
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

roofTypeSelect.addEventListener('change', () => {
  if (selectedElementId === 'building-defaults') {
    modelConfig.roofType = roofTypeSelect.value;
  } else {
    modelConfig.volumeRoofTypes[selectedElementId] = roofTypeSelect.value;
  }
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

volumeSplitSelect.addEventListener('change', () => {
  modelConfig.volumeSplit = volumeSplitSelect.value;
  // volumes are renumbered, so settings kept by volume no longer apply
  const volumeKeys = ['volumeStoryOverrides', 'volumeKneeWalls', 'volumeFoundationHeights', 'volumeStoryHeights', 'volumeRidgeDirections', 'volumeRoofTypes', 'volumeRoofConnections', 'volumeRoofShapes', 'volumeEaves'];
  const hadVolumeSettings = volumeKeys.some((key) => Object.keys(modelConfig[key] ?? {}).length);
  volumeKeys.forEach((key) => {
    modelConfig[key] = {};
  });
  selectedElementId = 'building-defaults';
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
  const notes = [
    hadVolumeSettings ? 'Per-volume settings were cleared, since the volumes were renumbered.' : '',
    modelConfig.roofStructures.length ? 'Check the roof structures: each stays on the volume with its id.' : '',
  ].filter(Boolean);
  if (notes.length) {
    setStatus(notes.join(' '), 'default');
  }
});

roofDirectionSelect.addEventListener('change', () => {
  if (selectedElementId === 'building-defaults') {
    modelConfig.roofDirection = roofDirectionSelect.value;
    roofControlAuthority = 'pitch';
    modelConfig.roofHeightMode = 'slope';
    roofHeightModeSelect.value = 'slope';
  } else {
    modelConfig.volumeRidgeDirections[selectedElementId] = roofDirectionSelect.value;
  }
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

roofPitchRiseInput.addEventListener('input', () => {
  const targetVolume = volumeShapeTarget();
  if (targetVolume) {
    const pitchRise = Math.max(1, Math.min(24, Math.round(Number(roofPitchRiseInput.value) || 1)));
    modelConfig.volumeRoofShapes[targetVolume] = { ...(modelConfig.volumeRoofShapes[targetVolume] ?? {}), mode: 'slope', pitchRise };
    if (loadedFootprint) {
      loadFootprint(loadedFootprint);
    }
    return;
  }
  roofControlAuthority = 'pitch';
  modelConfig.roofHeightMode = 'slope';
  roofHeightModeSelect.value = 'slope';
  modelConfig.roofPitchRise = Math.max(1, Math.min(24, Math.round(Number(roofPitchRiseInput.value) || 1)));
  roofPitchRiseInput.value = String(modelConfig.roofPitchRise);
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

roofHeightInput.addEventListener('input', () => {
  const targetVolume = volumeShapeTarget();
  if (targetVolume) {
    const height = Math.max(0.1, (Number(roofHeightInput.value) || 0.1) / unitFactor());
    modelConfig.volumeRoofShapes[targetVolume] = { ...(modelConfig.volumeRoofShapes[targetVolume] ?? {}), mode: 'height', height };
    if (loadedFootprint) {
      loadFootprint(loadedFootprint);
    }
    return;
  }
  modelConfig.roofHeight = Math.max(0.1, (Number(roofHeightInput.value) || 0.1) / unitFactor());
  roofControlAuthority = 'height';
  modelConfig.roofHeightMode = 'height';
  roofHeightModeSelect.value = 'height';
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

// Eave controls edit the selected volume's override, or the building defaults
// when no volume is selected (see volumeShapeTarget).
function setEaveValue(volumeKey, buildingKey, value) {
  const target = volumeShapeTarget();
  if (target) {
    modelConfig.volumeEaves[target] = { ...(modelConfig.volumeEaves[target] ?? {}), [volumeKey]: value };
  } else {
    modelConfig[buildingKey] = value;
  }
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
}

roofEaveDepthInput.addEventListener('input', () => {
  setEaveValue('eaveDepth', 'roofEaveDepth', Math.max(0, (Number(roofEaveDepthInput.value) || 0) / unitFactor()));
});
roofRakeDepthInput.addEventListener('input', () => {
  setEaveValue('rakeDepth', 'roofRakeDepth', Math.max(0, (Number(roofRakeDepthInput.value) || 0) / unitFactor()));
});
roofFasciaDepthInput.addEventListener('input', () => {
  setEaveValue('fasciaDepth', 'roofFasciaDepth', Math.max(0.01, (Number(roofFasciaDepthInput.value) || 0.01) / unitFactor()));
});
eaveSoffitSelect.addEventListener('change', () => setEaveValue('eaveSoffit', 'eaveSoffit', eaveSoffitSelect.value));
rakeSoffitSelect.addEventListener('change', () => setEaveValue('rakeSoffit', 'rakeSoffit', rakeSoffitSelect.value));

volumeControlsBox.addEventListener('change', (event) => {
  const input = event.target.closest('input[data-volume-length]');
  if (!input) {
    return;
  }
  const map = modelConfig[input.dataset.volumeLength];
  const id = input.dataset.volume;
  if (input.value === '') {
    delete map[id];
  } else {
    // 0 is a real value: no half story, or a floor at grade
    map[id] = Math.max(0, Number(input.value) || 0) / unitFactor();
    if (input.dataset.volumeLength === 'volumeStoryHeights' && !(map[id] > 0)) {
      delete map[id];
    }
  }
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

volumeControlsBox.addEventListener('input', (event) => {
  const input = event.target.closest('input[data-volume-id]');
  if (!input) {
    return;
  }
  modelConfig.volumeStoryOverrides[input.dataset.volumeId] = Math.max(1, Math.round(Number(input.value) || 1));
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

roofHeightModeSelect.addEventListener('change', () => {
  modelConfig.roofHeightMode = roofHeightModeSelect.value;
  roofControlAuthority = modelConfig.roofHeightMode === 'height' ? 'height' : 'pitch';
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

roofConnectionSelect.addEventListener('change', () => {
  if (selectedElementId === 'building-defaults') {
    return;
  }
  modelConfig.volumeRoofConnections[selectedElementId] = roofConnectionSelect.value;
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

unitSelect.addEventListener('change', () => {
  displayUnits = unitSelect.value;
  syncUnitLabels();
  syncLengthInputs();
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

wallMaterialSelect.addEventListener('change', () => {
  modelConfig.wallMaterial = wallMaterialSelect.value;
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});

function handleRegionMaterialChange(event) {
  const select = event.target.closest('select[data-material-axis]');
  if (!select) {
    return;
  }

  const index = Number(select.dataset.materialIndex);
  const materials = select.dataset.materialAxis === 'story'
    ? modelConfig.storyMaterials
    : modelConfig.panelMaterials;
  materials[index] = select.value;
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
}

storyMaterialsBox.addEventListener('change', handleRegionMaterialChange);
wallPanelMaterialsBox.addEventListener('change', handleRegionMaterialChange);

sampleBtn.addEventListener('click', () => {
  loadSampleFootprint();
});

footprintSelect.addEventListener('change', () => {
  loadSampleFootprint();
});

loadBtn.addEventListener('click', () => {
  fileInput.click();
});

fileInput.addEventListener('change', handleFileInput);

frontSelect.addEventListener('change', () => {
  modelConfig.frontSide = frontSelect.value;
  nameSideControls();
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
});
nameSideControls();
resetViewBtn.addEventListener('click', () => {
  controls.reset();
  camera.position.set(30, 18, 28);
  camera.lookAt(0, 0, 0);
  controls.update();
});

/**
 * Applies a pick result (from either the orbit or the plan view) to the
 * selection state, exactly as a direct click there would.
 */
function applyPickSelection({ volumeId, structureId, wallId }) {
  if (structureId) {
    if (structureId !== selectedStructureId) {
      selectedWallId = null;
      selectedStructureId = structureId;
      loadFootprint(loadedFootprint);
    }
    return;
  }
  if (wallId) {
    // a wall steers the elevation pane, and (like a structure) brings the
    // scope control to the mass it belongs to
    const toggledOff = wallId === selectedWallId;
    selectedWallId = toggledOff ? null : wallId;
    if (!toggledOff) {
      const wallRun = activeLayout.wallRuns.find((run) => run.id === wallId);
      if (wallRun?.volumeId) {
        selectedStructureId = null;
        selectedElementId = wallRun.volumeId;
      }
    }
    loadFootprint(loadedFootprint);
    return;
  }
  if (!volumeId) {
    // empty ground: back out to building defaults
    if (selectedElementId !== 'building-defaults' || selectedStructureId || selectedWallId) {
      selectedElementId = 'building-defaults';
      selectedStructureId = null;
      selectedWallId = null;
      loadFootprint(loadedFootprint);
    }
    return;
  }
  if (volumeId === selectedElementId && !selectedStructureId) {
    return;
  }
  selectedStructureId = null;
  selectedWallId = null;
  selectedElementId = volumeId;
  loadFootprint(loadedFootprint);
}

/** Wires up click-to-select and hover cues on a view's canvas, against its own camera. */
function wireViewSelection(canvas, viewCamera) {
  canvas.addEventListener('pointermove', (event) => updateHoveredVolume(event, viewCamera, canvas));
  canvas.addEventListener('pointerleave', () => {
    hoveredVolumeId = null;
    hoveredStructureId = null;
    hoveredWallId = null;
    clearHoverCue();
    canvas.style.cursor = 'default';
  });
  let localPointerDown = null;
  canvas.addEventListener('pointerdown', (event) => {
    localPointerDown = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!localPointerDown || Math.hypot(event.clientX - localPointerDown.x, event.clientY - localPointerDown.y) > 4) {
      localPointerDown = null;
      return;
    }
    localPointerDown = null;
    // a fresh raycast at the click itself, not whatever pointermove last hovered
    applyPickSelection(pickAtPointer(event.clientX, event.clientY, viewCamera, canvas));
  });
}

wireViewSelection(viewportCanvas, camera);
wireViewSelection(topViewCanvas, topCamera);
wireViewSelection(elevationViewCanvas, elevationCamera);

// --- Mansard, gambrel, and widow's walk settings --------------------------------

/**
 * Shows the settings of the selected roof type: a mansard's or gambrel's
 * break height and two pitches (in place of the single pitch and rise), and a
 * hip's widow's walk height (its flat top in place of the ridge). They edit the selected volume, or the building
 * defaults (see volumeShapeTarget).
 */
function syncRoofShapeFields(roofType) {
  const twoSlope = roofType === 'mansard' || roofType === 'gambrel';
  twoSlopeFields.style.display = twoSlope ? '' : 'none';
  roofPitchField.style.display = twoSlope ? 'none' : '';
  roofHeightField.style.display = twoSlope ? 'none' : '';
  roofWalkField.style.display = roofType === 'hip' ? '' : 'none';
  const target = volumeShapeTarget();
  const own = target ? modelConfig.volumeRoofShapes[target] ?? {} : {};
  if (twoSlope) {
    const defaults = TWO_SLOPE_DEFAULTS[roofType];
    const pick = (key, buildingKey) => own[key] ?? modelConfig[buildingKey] ?? defaults[key];
    roofBreakHeightInput.value = (pick('breakHeight', 'roofBreakHeight') * unitFactor()).toFixed(1);
    roofLowerPitchInput.value = String(pick('lowerPitchRise', 'roofLowerPitchRise'));
    roofUpperPitchInput.value = String(pick('upperPitchRise', 'roofUpperPitchRise'));
  }
  const walk = own.walkHeight ?? modelConfig.roofWalkHeight;
  roofWalkHeightInput.value = Number.isFinite(walk) ? (walk * unitFactor()).toFixed(1) : '';
}

/** Under the widow's walk height: the size of the flat top it makes (for the selected volume, or all). */
function showWalkSize(roofWalks) {
  const target = volumeShapeTarget();
  const walks = roofWalks.filter((walk) => !target || walk.volumeIds.includes(target));
  const own = target ? modelConfig.volumeRoofShapes[target]?.walkHeight : undefined;
  const height = own ?? modelConfig.roofWalkHeight;
  const units = unitFactor();
  const label = document.querySelector('#roof-walk-field .unit-label')?.textContent ?? '';
  roofWalkSize.textContent = walks.length
    ? walks.map((walk) => {
      const points = walk.pieces.flat();
      const size = (k) => (Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]))) * units;
      return `Walk: ${size(0).toFixed(1)} × ${size(1).toFixed(1)} ${label}${walk.pieces.length > 1 ? ' overall' : ''}`;
    }).join('; ')
    : height > 0 ? 'At or above the ridge: no flat top.' : '';
}

function setRoofShapeValue(key, buildingKey, value) {
  const target = volumeShapeTarget();
  if (target) {
    const own = { ...(modelConfig.volumeRoofShapes[target] ?? {}) };
    if (value === undefined) {
      delete own[key];
    } else {
      own[key] = value;
    }
    modelConfig.volumeRoofShapes[target] = own;
  } else {
    modelConfig[buildingKey] = value;
  }
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
}

roofBreakHeightInput.addEventListener('change', () => {
  setRoofShapeValue('breakHeight', 'roofBreakHeight', Math.max(0.1, (Number(roofBreakHeightInput.value) || 0.1) / unitFactor()));
});
roofLowerPitchInput.addEventListener('change', () => {
  setRoofShapeValue('lowerPitchRise', 'roofLowerPitchRise', Math.max(1, Number(roofLowerPitchInput.value) || 1));
});
roofUpperPitchInput.addEventListener('change', () => {
  setRoofShapeValue('upperPitchRise', 'roofUpperPitchRise', Math.max(0, Number(roofUpperPitchInput.value) || 0));
});
roofWalkHeightInput.addEventListener('change', () => {
  const value = Number(roofWalkHeightInput.value);
  setRoofShapeValue('walkHeight', 'roofWalkHeight', roofWalkHeightInput.value === '' || !(value > 0) ? undefined : value / unitFactor());
});

// --- Roof structures -----------------------------------------------------------

/** A wall's name, from the building's front ("front", "left side", ...). */
function wallName(side) {
  return wallNames(modelConfig.frontSide)[side] ?? side;
}

/** The four sides as choices, named from the front: front, right side, back, left side. */
function sideOptions() {
  const names = wallNames(modelConfig.frontSide);
  const order = ['front', 'right side', 'back', 'left side'];
  return Object.entries(names).sort(([, a], [, b]) => order.indexOf(a) - order.indexOf(b))
    .map(([side, name]) => [side, `${name[0].toUpperCase()}${name.slice(1)}`]);
}

/** Text from the resolver with its sides (minZ, ...) named from the front instead. */
function nameSides(text) {
  return String(text).replace(/\b(min|max)(X|Z)\b/g, (side) => wallName(side));
}

/**
 * Names the side choices outside the structure editor from the front: the
 * Add menu's facing and the roof's high edge (x-min: the high edge on the
 * minX side, the ridge along z).
 */
function nameSideControls() {
  [...structureSideSelect.options].forEach((option) => {
    const name = wallName(option.value);
    option.textContent = `${name[0].toUpperCase()}${name.slice(1)}`;
  });
  // a ridge along an axis runs toward the walls across that axis
  const ridge = (axis) => (['front', 'back'].includes(wallName(axis === 'z' ? 'maxZ' : 'maxX')) ? 'front to back' : 'side to side');
  [...roofDirectionSelect.options].forEach((option) => {
    const [axis, end] = option.value.split('-');
    // a high edge on an x side puts the ridge along z, and the other way round
    option.textContent = `High edge on the ${wallName(`${end}${axis.toUpperCase()}`)} (ridge ${ridge(axis === 'x' ? 'z' : 'x')})`;
  });
}
const STRUCTURE_ROOF_OPTIONS = [['gable', 'Gable'], ['hip', 'Hip'], ['shed', 'Shed'], ['flat', 'Flat']];
const MATERIAL_OPTIONS = [['', 'Building default'], ['wood', 'Wood'], ['brick', 'Brick'], ['stucco', 'Stucco'], ['metal', 'Metal'], ['stone', 'Stone'], ['paint', 'Painted white']];

function structureRecord(id) {
  return modelConfig.roofStructures.find((structure) => structure.id === id) ?? null;
}

/**
 * Whether a preset's structure needs a sloped host side to rise from: the
 * resolver only checks for one when the structure neither stands on its own
 * base (a porch) nor rises through the roof (a cupola) — everything else
 * (`mount: 'join'` and no `baseHeight`, the dormer family's default) joins
 * whatever roof face is under `hostSide`, and there has to be one. Built by
 * actually normalizing the preset rather than reading its raw fields, so a
 * kind's own defaults (e.g. cupola's `mount: 'through'`, unset by the UI
 * preset itself) are resolved the same way the builder resolves them.
 */
function presetNeedsSlopedSide(presetKey) {
  const preset = STRUCTURE_UI_PRESETS.find((candidate) => candidate.key === presetKey);
  if (!preset || preset.onStructure) {
    return false;
  }
  const probe = newRoofStructure(presetKey, { hostVolumeId: 'probe', hostSide: 'minX' }, []);
  return Boolean(probe) && probe.baseHeight === null && probe.mount !== 'through';
}

/**
 * Which of a volume's four sides a roof structure that needs a slope (see
 * `presetNeedsSlopedSide`) can actually be hosted on. Checked by resolving a
 * minimal probe structure against the volume's own built roof zone
 * (`activeRoofZones`, not the facade layer's roof-graph zones — see that
 * variable's comment) and reading off whether the resolver's `side-not-
 * sloped` check specifically rejected it, the same way `maxValidInset`
 * settles a question that isn't worth re-deriving by hand: a gable's or
 * hip's sloped face and a shed's low side pass; a gable end, a shed's high
 * edge, or its rake sides don't. A flat roof has no slope anywhere but takes
 * an explicit depth instead (see the "Add" button's flat-roof fallback
 * below), so every side counts there too. `true` for every side when the
 * host's roof isn't known yet (nothing built to check against), so nothing
 * is disabled from a guess.
 */
function eligibleHostSides(hostVolume) {
  const allSides = {
    minZ: true, maxZ: true, minX: true, maxX: true,
  };
  const zone = activeRoofZones.find((candidate) => candidate.volumeId === hostVolume?.id);
  if (!zone || zone.roofType === 'flat') {
    return allSides;
  }
  const config = { roofPitchRise: modelConfig.roofPitchRise, roofPitchRun: modelConfig.roofPitchRun };
  const result = {};
  Object.keys(allSides).forEach((side) => {
    const probe = normalizeRoofStructures([{ hostVolumeId: hostVolume.id, hostSide: side, kind: 'dormer' }])[0];
    const { errors } = resolveRoofStructure(probe, zone, config);
    result[side] = !errors.some((error) => error.code === 'side-not-sloped');
  });
  return result;
}

/** A generous fallback range (meters) for a structure whose host geometry isn't resolved yet. */
const FALLBACK_PLACEMENT_RANGE = 4;

/**
 * A hair's width (meters) kept inside the computed edge so a slider dragged
 * to its extreme still resolves: the resolver rejects a structure whose edge
 * lands exactly on the host wall run or ridge (it must end strictly before
 * it), and well clear of the resolver's own epsilon (1e-4 m).
 */
const PLACEMENT_EDGE_MARGIN = 0.02;

/**
 * How far the structure's own roof overhangs past its wall footprint on
 * whichever pair of sides `offset` slides it toward (its own eave or rake,
 * whichever those sides are, given its roof type and ridge orientation).
 * Left unaccounted for, a slider dragged to the edge of the host wall run
 * still leaves the structure's own roof overhang projecting past it, through
 * the host's gable end. Mirrors the overhang the builder itself computes
 * (see structureEaveSetup in js/extrusion.js) without needing a resolved
 * structure, since it depends only on roof type and orientation, not offset.
 */
function structureAlongOverhang(structure, frame) {
  if (structure.roofType === 'flat' || structure.roofType === 'none') {
    return 0;
  }
  const ridgeAxis = structure.roofType === 'shed' || structure.ridge === 'parallel' ? frame.along : frame.inward;
  const roofHighEdge = structure.roofType === 'shed' ? `${frame.inward}-${frame.sign > 0 ? 'max' : 'min'}` : undefined;
  const eaves = resolveVolumeEaves(structure.id, {
    roofEaveDepth: modelConfig.roofEaveDepth,
    roofRakeDepth: modelConfig.roofRakeDepth,
    roofFasciaDepth: modelConfig.roofFasciaDepth,
    volumeEaves: { [structure.id]: structure.eaves },
  });
  const { overhang } = sideOverhangs(structure.roofType, { ridgeAxis, roofHighEdge }, eaves);
  const [alongMinKey, alongMaxKey] = frame.along === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ'];
  return Math.max(overhang[alongMinKey] ?? 0, overhang[alongMaxKey] ?? 0);
}

/** The smallest a structure's width, depth, or wall/railing height can be dragged to (meters). */
const MIN_STRUCTURE_SIZE = 0.3;

/**
 * The valid range (meters) for a structure's `offset`, `setback`, `width`,
 * `depth`, and `wallHeight`, so no slider's travel can push the structure's
 * own footprint or roof overhang past its host roof plane's edges, or its
 * plate above the host ridge. Each bound is computed holding every *other*
 * field at its current value — e.g. width's max leaves room for the current
 * offset, offset's max leaves room for the current width — the same way
 * offset and setback already worked; dragging one and then another lets each
 * catch up to the last, rather than trying to solve every field at once.
 *
 * - `offset`: the host wall run less the structure's width and its own roof
 *   overhang on that side (else the overhang alone can poke through the
 *   host's gable end at the extreme of the slider).
 * - `setback`: the distance from the host wall to the ridge (or, for a shed
 *   roof, the far wall) less the structure's depth (an auto depth is treated
 *   as 0, since the resolver stretches it to the ridge on its own), and, for
 *   a dormer rising out of a gable/hip host, how far it can move toward the
 *   ridge before its own plate rises above it (the resolver rejects that
 *   outright rather than lowering it). Negative setback (projecting past the
 *   wall) stays available only when the structure already has a base to
 *   stand on.
 * - `width`: the host wall run less twice the current offset and roof
 *   overhang, so it can't widen past either end of the host wall.
 * - `depth`: the distance from the host wall to the ridge (or far wall) less
 *   the current setback.
 * - `wallHeight`: for a dormer, how tall its wall can stand at the current
 *   setback before its plate reaches the host ridge; unconstrained by the
 *   ridge for a structure with its own base (a porch) or rising through the
 *   roof (a cupola), which don't answer to it.
 * - `inset`: the deepest the recess can go before either reaching the back
 *   of the structure, or (on a sloped host) running back under the host
 *   roof still standing beyond where the structure's own footprint cut it
 *   away — a shape too irregular to invert into a formula, so it's found by
 *   bisecting against the real resolver instead (see `maxValidInset`).
 */

/**
 * The deepest `inset` the real resolver still accepts for this structure, by
 * bisection: resolving a hypothetical copy of the record is cheap pure
 * geometry (no meshes), and settling for "found by trying values" here beats
 * reverse-engineering `resolveRoofStructure`'s host-roof-containment check
 * (see its `inset-too-deep` case) into a closed-form bound.
 */
function maxValidInset(structure, host, ceiling) {
  if (!(ceiling > 0)) {
    return 0;
  }
  const config = { roofPitchRise: modelConfig.roofPitchRise, roofPitchRun: modelConfig.roofPitchRun };
  const valid = (inset) => resolveRoofStructure({ ...structure, inset }, host, config).errors.length === 0;
  if (valid(ceiling)) {
    return ceiling;
  }
  let lo = 0;
  let hi = ceiling;
  for (let i = 0; i < 24; i += 1) {
    const mid = (lo + hi) / 2;
    if (valid(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}
function structurePlacementLimits(structure) {
  const fallback = {
    offsetMin: -FALLBACK_PLACEMENT_RANGE,
    offsetMax: FALLBACK_PLACEMENT_RANGE,
    setbackMin: structure.baseHeight === null ? 0 : -FALLBACK_PLACEMENT_RANGE,
    setbackMax: FALLBACK_PLACEMENT_RANGE,
    widthMin: MIN_STRUCTURE_SIZE,
    widthMax: FALLBACK_PLACEMENT_RANGE * 2,
    depthMin: MIN_STRUCTURE_SIZE,
    depthMax: FALLBACK_PLACEMENT_RANGE * 2,
    wallHeightMin: MIN_STRUCTURE_SIZE,
    wallHeightMax: FALLBACK_PLACEMENT_RANGE,
    insetMin: 0,
    insetMax: FALLBACK_PLACEMENT_RANGE,
  };
  const entry = activeStructureEntries.find((candidate) => candidate.id === structure.id);
  const host = entry?.host;
  // a dormer asked for on a gable end is turned to the slope beside it (see
  // resolveRoofStructure); what was built says so only for the side it was
  // built on, not a side it is being moved to
  const built = modelConfig.roofStructures.find((candidate) => candidate.id === structure.id);
  const asBuilt = built?.hostSide === structure.hostSide;
  const turned = asBuilt && entry?.warnings?.some((warning) => warning.code === 'side-turned')
    ? { minX: 'minZ', minZ: 'minX', maxX: 'maxZ', maxZ: 'maxX' }[structure.hostSide]
    : null;
  const frame = host ? structureFrame((asBuilt ? entry.resolved?.hostSide : null) ?? turned ?? structure.hostSide) : null;
  if (!host || !frame) {
    return fallback;
  }
  const [alongMinKey, alongMaxKey] = frame.along === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ'];
  const [inwardMinKey, inwardMaxKey] = frame.inward === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ'];

  const alongSpan = host.bounds[alongMaxKey] - host.bounds[alongMinKey];
  // A dormer rising from the roof needs this margin: past the host's along
  // bound, on that same wall run, stands the gable end (a wall the full
  // height of the roof), and an unclamped overhang would run into it. A
  // structure with its own base (a porch) or rising through the roof
  // doesn't answer to that: past the host's corner there's open air, not
  // another wall, so its eave is free to run past the corner the way a real
  // porch roof would, and its footprint can run flush to the corner too.
  const isDormer = structure.baseHeight === null && structure.mount !== 'through';
  const overhang = isDormer ? structureAlongOverhang(structure, frame) : 0;
  // a polygonal tower may stand past the end of its wall (centered on the
  // corner); anything else stays on its wall, and a dormer on its slope
  const pastCorner = structure.plan?.shape === 'polygon' && !isDormer;
  const halfTravel = pastCorner
    ? alongSpan / 2 + (structure.width ?? 0) / 2
    : Math.max(0, alongSpan / 2 - (structure.width ?? 0) / 2 - overhang - (isDormer ? PLACEMENT_EDGE_MARGIN : 0));
  // Width's own bound holds *at offset 0* (as wide as the host wall run
  // allows if centered) rather than the current offset: were it narrowed by
  // the current offset instead, dragging offset would visibly rescale the
  // width slider's whole track under an untouched value, making it look
  // like width itself was changing. offset already can't exceed what the
  // current width leaves room for (above); editing width instead re-clamps
  // offset to fit afterward (see applyStructureFieldEdit), so the coupling
  // only ever moves the slider you're not currently holding.
  const widthMax = isDormer
    ? Math.max(MIN_STRUCTURE_SIZE, alongSpan - 2 * overhang - 2 * PLACEMENT_EDGE_MARGIN)
    : Math.max(MIN_STRUCTURE_SIZE, alongSpan);

  const inwardSpan = host.bounds[inwardMaxKey] - host.bounds[inwardMinKey];
  const usableInward = host.roofType === 'shed' ? inwardSpan : inwardSpan / 2;
  const depth = structure.depth === null ? 0 : (structure.depth ?? 0);
  const planSetbackMax = Math.max(0, usableInward - depth - PLACEMENT_EDGE_MARGIN);
  // Same reasoning as width above: depth's bound holds at setback 0, not the
  // current setback, so dragging setback doesn't rescale the depth slider.
  // (a porch's depth is how far it projects, not how far up the roof it reaches)
  const depthMax = isDormer || structure.mount === 'recess'
    ? Math.max(MIN_STRUCTURE_SIZE, usableInward - PLACEMENT_EDGE_MARGIN)
    : Math.max(usableInward, FALLBACK_PLACEMENT_RANGE * 2);

  // A dormer's plate rises with the host roof pitch as it moves toward the
  // ridge; past this setback its wall top would clear the ridge outright.
  const pitchSlope = host.roofHeight > 0 ? host.roofHeight / usableInward : 0;
  const plateSetbackMax = isDormer && pitchSlope > 0
    ? Math.max(0, (host.roofHeight - (structure.wallHeight ?? 0)) / pitchSlope - PLACEMENT_EDGE_MARGIN)
    : Infinity;
  // And again: wall height's bound holds at setback 0 (the tallest it could
  // stand right at the wall line), not the current setback.
  // A structure on a base, or rising through the roof, may stand as tall as
  // the house and its roof (a tower rising past the eave).
  // A porch, bay, or hood against its wall stays under the host's eave: its
  // roof tops out no higher than the host's wall top.
  const levels = structureRole(structure) === 'projecting' ? structureLevels(structure) : null;
  const wallHeightMax = isDormer && pitchSlope > 0
    ? Math.max(MIN_STRUCTURE_SIZE, host.roofHeight - PLACEMENT_EDGE_MARGIN)
    : levels
      ? Math.max(MIN_STRUCTURE_SIZE, levels.topY - levels.sillY - levels.roofRise)
      : Math.max(fallback.wallHeightMax, (host.wallTopY ?? 0) + (host.roofHeight ?? 0) + FALLBACK_PLACEMENT_RANGE);

  const effectiveDepth = entry?.resolved
    ? Math.abs(entry.resolved.back - entry.resolved.front)
    : (structure.depth ?? depthMax);
  const insetMax = maxValidInset(structure, host, Math.max(0, effectiveDepth - PLACEMENT_EDGE_MARGIN));

  const limits = {
    offsetMin: -halfTravel,
    offsetMax: halfTravel,
    setbackMin: structure.baseHeight === null ? 0 : -Math.max(usableInward, FALLBACK_PLACEMENT_RANGE * 2),
    setbackMax: Math.min(planSetbackMax, plateSetbackMax),
    widthMin: MIN_STRUCTURE_SIZE,
    widthMax,
    depthMin: MIN_STRUCTURE_SIZE,
    depthMax,
    wallHeightMin: MIN_STRUCTURE_SIZE,
    wallHeightMax,
    insetMin: 0,
    insetMax,
  };
  const role = structureRole(structure);
  if (role === 'on-roof') {
    // a porch on the roof stays within the walls (past them it is an upper porch)
    limits.setbackMin = Math.max(limits.setbackMin, 0);
  }
  if (role === 'projecting' && (structure.kind === 'hood' || structure.support === 'brackets')) {
    // brackets carry only so much projection
    limits.depthMax = Math.min(limits.depthMax, MAX_BRACKET_PROJECTION);
  }
  if (structureType(structure) === 'turret' && structure.support !== 'none') {
    // a turret on a corbel projects no further than brackets carry
    const center = (Number.isFinite(structure.setback) ? structure.setback : 0) + (structure.depth ?? structure.width) / 2;
    const most = Math.max(MIN_STRUCTURE_SIZE, 2 * (MAX_BRACKET_PROJECTION + center));
    limits.setbackMin = Math.max(limits.setbackMin, -MAX_BRACKET_PROJECTION);
    limits.widthMax = Math.min(limits.widthMax, most);
    limits.depthMax = Math.min(limits.depthMax, most);
  }
  if (structure.plan?.shape === 'canted') {
    // a canted bay's front is what its width leaves after its two angled sides
    const run = 1 / Math.tan(((structure.plan.angle ?? 45) * Math.PI) / 180);
    const depthNow = structure.depth ?? -structure.setback;
    limits.widthMin = Math.max(limits.widthMin, 2 * depthNow * run + MIN_STRUCTURE_SIZE);
    limits.depthMax = Math.min(limits.depthMax, Math.max(MIN_STRUCTURE_SIZE, ((structure.width ?? 0) - MIN_STRUCTURE_SIZE) / (2 * run)));
  }
  if (role === 'recess') {
    // the recess's ceiling stays under the roof
    const levels = structureLevels(structure);
    if (levels) {
      limits.wallHeightMax = Math.max(MIN_STRUCTURE_SIZE, levels.wallTopY - levels.sillY);
    }
  }
  if (structure.wrap) {
    // a wraparound's end legs run from their corners at most the length of their walls
    const { walls } = structure.wrap;
    limits.wrapStartMax = wallSpan(host, walls[0]);
    limits.wrapEndMax = wallSpan(host, walls[walls.length - 1]);
  }
  return limits;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function lengthText(meters) {
  return meters === null || meters === undefined || !Number.isFinite(meters) ? '' : String(Number((meters * unitFactor()).toFixed(2)));
}

function optionsHtml(options, value) {
  return options.map(([key, label]) => `<option value="${key}"${key === value ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function numberField(label, field, value, { length = true, step = 0.1, disabled = false, placeholder = '' } = {}) {
  const shown = length ? lengthText(value) : (value ?? '');
  return `<div class="field"><label>${escapeHtml(label)}${length ? ` (${unitLabel()})` : ''}</label>`
    + `<input type="number" data-field="${field}" step="${step}" value="${shown}"${disabled ? ' disabled' : ''}${placeholder ? ` placeholder="${placeholder}"` : ''} /></div>`;
}

/**
 * A range slider paired with a live numeric readout, for a length field whose
 * valid travel is bounded (e.g. a roof structure's offset/setback). `min` and
 * `max` are in meters; the slider itself works in display units so its step
 * matches what the readout shows. Firing on `input` (not just `change`) lets
 * the caller update the model continuously while the slider is dragged.
 */
/**
 * A range slider paired with a number box at its end showing the same value,
 * either of which can drive the field: drag the slider for continuous
 * feedback, or type an exact figure in the box. Both share `data-field` and
 * the same min/max, so whichever one fires still runs through the normal
 * field-edit path (which also clamps offset/setback to these limits, since a
 * typed value bypasses the slider's own inherent clamping).
 */
function sliderField(label, field, value, min, max, { disabled = false, unitless = false, step = 'any' } = {}) {
  const factor = unitless ? 1 : unitFactor();
  let displayMin = Number((min * factor).toFixed(2));
  let displayMax = Number((max * factor).toFixed(2));
  const shown = Number.isFinite(value) ? Number((value * factor).toFixed(2)) : displayMax;
  const clamped = Math.min(Math.max(shown, displayMin), displayMax);
  // no travel left (a porch as wide as its wall has one place to be): the
  // slider sits disabled at its middle rather than pinned to one end
  const stuck = displayMax - displayMin < 0.005;
  if (stuck) {
    [displayMin, displayMax] = [clamped - 1, clamped + 1];
  }
  const disabledAttr = disabled || stuck ? ' disabled' : '';
  // step="any": with a min that isn't a clean multiple of a fixed step, a
  // numeric step snaps every value a little off what was actually set.
  const digits = unitless && step !== 'any' ? 0 : 2;
  return `<div class="field"><label>${escapeHtml(label)}${unitless ? '' : ` (${unitLabel()})`}</label>`
    + `<div class="slider-field">`
    + `<input type="range" data-field="${field}" min="${displayMin}" max="${displayMax}" step="${step}" value="${clamped}"${disabledAttr} />`
    + `<input type="number" class="slider-value" data-field="${field}" min="${displayMin}" max="${displayMax}" step="${digits ? '0.01' : step}" value="${clamped.toFixed(digits)}"${disabledAttr} />`
    + `</div></div>`;
}

/** A labeled group of fields, visually set off from the ones around it. Omitted entirely when empty (a group whose fields are all conditionally hidden). */
function fieldGroup(label, parts) {
  return parts.length ? `<div class="field-group"><div class="field-group-label">${escapeHtml(label)}</div>${parts.join('')}</div>` : '';
}

function selectField(label, field, options, value) {
  return `<div class="field"><label>${escapeHtml(label)}</label><select data-field="${field}">${optionsHtml(options, value)}</select></div>`;
}

function checkField(label, field, checked) {
  return `<label class="field-inline" style="margin-bottom:8px;"><input type="checkbox" data-field="${field}"${checked ? ' checked' : ''} />${escapeHtml(label)}</label>`;
}

/** The building's trim courses: which are on, their sizes, and the material they're all made of. */
function renderTrimPanel() {
  // (declared here, not at module level: syncLengthInputs renders this during startup, before later consts exist)
  const TRIM_COURSES = [
    ['waterTable', 'Water table', 'On the foundation'],
    ['beltCourse', 'Belt courses', 'At each floor line'],
    ['cornice', 'Cornice', 'Under the eaves'],
  ];
  const trim = normalizeTrim(modelConfig.trim);
  const materialOptions = [['paint', 'Painted white'], ['wood', 'Wood'], ['brick', 'Brick'], ['stucco', 'Stucco'], ['metal', 'Metal'], ['stone', 'Stone']];
  const groups = TRIM_COURSES.map(([kind, label, where]) => {
    const course = trim[kind];
    const parts = [checkField(`${where}`, `${kind}.enabled`, course.enabled)];
    if (course.enabled) {
      parts.push(numberField('Height', `${kind}.height`, course.height, { step: 0.05 }));
      parts.push(numberField('Projection', `${kind}.projection`, course.projection, { step: 0.05 }));
      if (kind === 'cornice') {
        parts.push(checkField('Dentils beneath', 'cornice.dentils', course.dentils));
      }
    }
    return fieldGroup(label, parts);
  });
  trimControls.innerHTML = selectField('Trim material', 'material', materialOptions, trim.material) + groups.join('');
}

function applyTrimFieldEdit(input) {
  const trim = normalizeTrim(modelConfig.trim);
  const [kind, key] = input.dataset.field.split('.');
  if (kind === 'material') {
    trim.material = input.value;
  } else if (key === 'enabled' || key === 'dentils') {
    trim[kind][key] = input.checked;
  } else {
    const range = key === 'height' ? TRIM_HEIGHT_RANGE : TRIM_PROJECTION_RANGE;
    const meters = Number(input.value) / unitFactor();
    if (!Number.isFinite(meters) || input.value === '') {
      renderTrimPanel();
      return;
    }
    trim[kind][key] = Math.min(Math.max(meters, range[0]), range[1]);
  }
  modelConfig.trim = normalizeTrim(trim);
  renderTrimPanel();
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
}

trimControls.addEventListener('change', (event) => {
  if (event.target.dataset?.field) {
    applyTrimFieldEdit(event.target);
  }
});

/** The "Add" menu, the list of the building's structures with how each built, and the selected one's editor. */
function renderStructurePanel() {
  if (!structurePresetSelect.options.length) {
    structurePresetSelect.innerHTML = STRUCTURE_UI_PRESETS.map((preset) => `<option value="${preset.key}">${escapeHtml(preset.label)}</option>`).join('');
  }
  const selected = selectedStructureId ? structureRecord(selectedStructureId) : null;
  [...structurePresetSelect.options].forEach((option) => {
    const preset = STRUCTURE_UI_PRESETS.find((candidate) => candidate.key === option.value);
    option.disabled = Boolean(preset?.onStructure) && !selected;
  });
  if (structurePresetSelect.selectedOptions[0]?.disabled) {
    structurePresetSelect.value = STRUCTURE_UI_PRESETS[0].key;
  }
  const preset = STRUCTURE_UI_PRESETS.find((candidate) => candidate.key === structurePresetSelect.value);
  const hostVolume = activeLayout ? selectedVolume(activeLayout) ?? activeLayout.volumes[0] : null;
  structureSideSelect.disabled = Boolean(preset?.onStructure);
  structureAddBtn.textContent = preset?.onStructure
    ? `Add on ${selected?.id ?? 'the selected porch'}`
    : `Add to ${hostVolume ? hostVolume.id.replace('-', ' ') : 'the building'}`;

  // Disable a facing option the preset couldn't rise from (a gable end, a
  // shed's high or rake side): with nothing to override it, default onto a
  // side that works instead of onto whatever the dropdown last held.
  if (!structureSideSelect.disabled && hostVolume) {
    const eligible = presetNeedsSlopedSide(structurePresetSelect.value) ? eligibleHostSides(hostVolume) : null;
    [...structureSideSelect.options].forEach((option) => {
      option.disabled = Boolean(eligible) && !eligible[option.value];
    });
    if (structureSideSelect.selectedOptions[0]?.disabled) {
      const firstEligible = [...structureSideSelect.options].find((option) => !option.disabled);
      if (firstEligible) {
        structureSideSelect.value = firstEligible.value;
      }
    }
  }

  // The building's structures are listed and selected from the scope control
  // (see renderScopeControl), grouped there under the mass each stands on.

  // Rewriting the editor's HTML on every tick of a slider drag would tear out
  // the range input the pointer is captured on and stall the drag. While a
  // drag tick is in flight (see structureLiveDragging), leave the DOM alone
  // and just refresh the live numeric readout next to it; the full editor
  // (and any field whose visibility depends on the value being dragged)
  // catches up once the drag ends and `change` re-renders it normally.
  if (structureLiveDragging && document.activeElement?.type === 'range' && structureEditor.contains(document.activeElement)) {
    const readout = document.activeElement.parentElement?.querySelector('.slider-value');
    if (readout) {
      readout.value = Number(document.activeElement.value).toFixed(2);
    }
    return;
  }
  structureEditor.innerHTML = selected ? structureEditorHtml(selected) : '';
}

/** The length of a volume's wall on `side` (a zone's rectangle). */
function wallSpan(host, side) {
  const { bounds } = host;
  return side === 'minX' || side === 'maxX' ? bounds.maxZ - bounds.minZ : bounds.maxX - bounds.minX;
}

/** The walls in order around a volume: each beside the next, the last beside the first. */
const WALL_ORDER = ['minZ', 'maxX', 'maxZ', 'minX'];

/**
 * A wraparound's walls after ticking or clearing one: the chosen walls in
 * order around the volume, running the same way as before where it can, or
 * null when they are not one unbroken run of two or more.
 */
function wrapWallsWith(walls, side, ticked) {
  const chosen = new Set(ticked ? [...walls, side] : walls.filter((wall) => wall !== side));
  if (chosen.size < 2) {
    return null;
  }
  const at = (k) => WALL_ORDER[((k % 4) + 4) % 4];
  let start = chosen.size === 4
    ? WALL_ORDER.indexOf(walls[0])
    : WALL_ORDER.findIndex((wall, k) => chosen.has(wall) && !chosen.has(at(k - 1)));
  if (start < 0) {
    return null;
  }
  const run = [];
  for (let k = start; run.length < chosen.size && chosen.has(at(k)); k += 1) {
    run.push(at(k));
  }
  if (run.length !== chosen.size) {
    return null;
  }
  // keep the direction it ran before: its first (or last) wall stays first (or last)
  const reversed = chosen.size === 4 ? [run[0], ...run.slice(1).reverse()] : [...run].reverse();
  const keeps = (order) => order[0] === walls[0] || order[order.length - 1] === walls[walls.length - 1];
  return !keeps(run) && keeps(reversed) ? reversed : run;
}

/**
 * Which kind of structure a record is, as the Add list names them: a
 * structure's editor only adjusts that kind, and never offers what would
 * make it another (a ground porch's base on the roof is a dormer, at a
 * height an upper porch); another kind is added from the list instead.
 */
function structureType(structure) {
  if (structure.kind === 'hood') {
    return 'hood';
  }
  if (structure.mount === 'recess') {
    return 'integral-porch';
  }
  if (structure.baseHeight === null) {
    return structure.mount === 'through' ? 'cupola' : 'dormer';
  }
  if (structure.hostStructureId) {
    return 'sleeping-porch';
  }
  if (structure.plan?.shape === 'polygon') {
    return structure.baseHeight === 'ground' ? 'tower' : 'turret';
  }
  if (structure.plan?.shape === 'canted') {
    return 'canted-bay';
  }
  if (structure.wrap) {
    return 'wraparound-porch';
  }
  const projecting = Number.isFinite(structure.setback) && structure.setback < 0;
  if (!projecting) {
    return 'porch-on-roof';
  }
  return structure.baseHeight === 'ground' ? 'ground-porch' : 'upper-porch';
}

/**
 * What a structure is, for its editor: 'dormer' (rises out of the roof),
 * 'through' (rises through it, a cupola), 'recess' (cut into the house),
 * 'projecting' (stands against its wall and projects from it: a porch, bay,
 * or hood), 'tower' (a polygonal tower, which may straddle the wall or
 * corner), or 'on-roof' (stands on the roof or on another structure).
 */
function structureRole(structure) {
  if (structure.baseHeight === null) {
    return structure.mount === 'through' ? 'through' : 'dormer';
  }
  if (structure.mount === 'recess') {
    return 'recess';
  }
  if (structure.plan?.shape === 'polygon') {
    return 'tower';
  }
  return !structure.hostStructureId && Number.isFinite(structure.setback) && structure.setback < 0 ? 'projecting' : 'on-roof';
}

/**
 * Where a structure stands against its host: its floor (sill), its roof's
 * rise above its plate, and the host's floor, wall top, and story height.
 * Null when it hasn't been built.
 */
function structureLevels(structure) {
  const entry = activeStructureEntries.find((candidate) => candidate.id === structure.id);
  const host = entry?.host;
  if (!host || !Number.isFinite(host.wallTopY)) {
    return null;
  }
  const sillY = entry.resolved?.sillY ?? (structure.baseHeight === 'ground'
    ? host.foundationTopY
    : Number.isFinite(structure.baseHeight) ? host.wallTopY + structure.baseHeight : null);
  if (!Number.isFinite(sillY)) {
    return null;
  }
  const roofRise = entry.resolved
    ? ({ flat: 0.08, none: 0 }[entry.resolved.roofType] ?? entry.resolved.roofHeight ?? 0)
    : 0;
  const volumeId = structure.hostVolumeId;
  const storyHeight = modelConfig.volumeStoryHeights?.[volumeId] ?? modelConfig.storyHeight;
  // the underside of the host's eave where the structure meets the wall: its
  // roof stays below it (see the resolver's above-eave warning)
  let topY = host.wallTopY;
  const resolved = entry.resolved;
  if (resolved?.along && Number.isFinite(host.baseY)) {
    const wall = host.bounds[resolved.hostSide];
    const profile = hostEaveProfile(host, resolved.hostSide, (resolved.along[0] + resolved.along[1]) / 2);
    const atWall = profile?.outline.filter(([u]) => Math.abs(u - wall) < 1e-9).map(([, v]) => v) ?? [];
    if (atWall.length) {
      topY = Math.min(topY, host.baseY + Math.min(...atWall));
    }
  }
  return {
    sillY, roofRise, storyHeight, floorY: host.foundationTopY ?? sillY, wallTopY: host.wallTopY, topY,
  };
}

/** The whole-story heights a porch or bay can rise to: its roof topping out at the top of story 1, 2, ... of its host. */
function storyChoices(structure) {
  const levels = structureLevels(structure);
  if (!levels) {
    return [];
  }
  const choices = [];
  for (let stories = 1; levels.floorY + stories * levels.storyHeight <= levels.wallTopY + 1e-6; stories += 1) {
    const wallHeight = Math.min(levels.floorY + stories * levels.storyHeight, levels.topY) - levels.sillY - levels.roofRise;
    if (wallHeight >= MIN_PORCH_WALL) {
      choices.push({ stories, wallHeight });
    }
  }
  return choices;
}

/** The lowest a porch's walls go when set by stories (a door fits under). */
const MIN_PORCH_WALL = 2;

function structureEditorHtml(structure) {
  const through = structure.mount === 'through';
  const recess = structure.mount === 'recess';
  const standing = structure.baseHeight !== null;
  const limits = structurePlacementLimits(structure);

  const type = structureType(structure);
  const placement = [];
  if (type === 'wraparound-porch') {
    // the walls it runs along: one unbroken run of two or more (all four: all the way round)
    const { walls } = structure.wrap;
    placement.push('<div class="field"><label>Runs along</label>' + sideOptions().map(([side, label]) => {
      const ticked = walls.includes(side);
      const allowed = Boolean(wrapWallsWith(walls, side, !ticked));
      return `<label class="field-inline" style="margin-bottom:6px;"><input type="checkbox" data-field="wrapWall:${side}"${ticked ? ' checked' : ''}${allowed ? '' : ' disabled'} />${escapeHtml(label)}</label>`;
    }).join('') + '</div>');
  } else {
    placement.push(selectField('Facing', 'hostSide', sideOptions(), structure.hostSide));
  }
  if (type === 'cupola') {
    placement.push(selectField('Plan', 'planShape', [['', 'Rectangle'], ['polygon', 'Polygon (octagonal, or many sides for round)']], structure.plan?.shape ?? ''));
  }
  if (type === 'canted-bay') {
    placement.push(numberField('Angle of the sides (degrees)', 'planAngle', structure.plan.angle, { length: false, step: 5 }));
  }
  if (structure.plan?.shape === 'polygon') {
    placement.push(sliderField('Sides', 'planSides', structure.plan.sides, 5, 32, { unitless: true, step: 1 }));
  }

  const role = structureRole(structure);
  const footprint = [];
  if (type === 'wraparound-porch') {
    // its two end legs, each from the corner it turns (the legs between run their whole walls)
    const { walls } = structure.wrap;
    const name = (side) => wallName(side);
    if (walls.length < 4) {
      footprint.push(sliderField(`Leg along the ${name(walls[0])}, from the corner`, 'wrapStart', structure.wrap.startLength, MIN_STRUCTURE_SIZE, limits.wrapStartMax ?? FALLBACK_PLACEMENT_RANGE * 2));
      footprint.push(sliderField(`Leg along the ${name(walls[walls.length - 1])}, from the corner`, 'wrapEnd', structure.wrap.endLength, MIN_STRUCTURE_SIZE, limits.wrapEndMax ?? FALLBACK_PLACEMENT_RANGE * 2));
    }
  } else {
    footprint.push(sliderField('Offset along the side', 'offset', structure.offset, limits.offsetMin, limits.offsetMax));
    if (role === 'tower') {
      // a regular polygon: one size across
      footprint.push(sliderField('Diameter', 'diameter', structure.width, limits.widthMin, Math.min(limits.widthMax, limits.depthMax)));
    } else {
      footprint.push(sliderField('Width', 'width', structure.width, limits.widthMin, limits.widthMax));
    }
  }
  if (role === 'projecting') {
    // a porch, bay, or hood stands against its wall: its depth is how far it projects
    footprint.push(sliderField('Depth (out from the wall)', 'projection', structure.depth ?? -structure.setback, limits.depthMin, limits.depthMax));
  } else if (role === 'tower') {
    footprint.push(sliderField('Setback from the wall (negative stands out past it)', 'setback', structure.setback, limits.setbackMin, limits.setbackMax));
  } else if (recess) {
    footprint.push(sliderField('Depth into the house', 'depth', structure.depth, limits.depthMin, limits.depthMax));
  } else {
    // a dormer, a cupola, or a porch standing on the roof: placed up the roof from the wall
    footprint.push(checkField('Centered across the roof', 'setbackCenter', structure.setback === 'center'));
    if (structure.setback !== 'center') {
      footprint.push(sliderField('Setback from the wall', 'setback', structure.setback, limits.setbackMin, limits.setbackMax));
    }
    if (role === 'dormer') {
      footprint.push(checkField('Depth runs back to the roof', 'depthAuto', structure.depth === null));
    }
    footprint.push(sliderField('Depth', 'depth', structure.depth, limits.depthMin, limits.depthMax, { disabled: structure.depth === null }));
  }

  const height = [];
  const stories = role === 'projecting' && structure.kind !== 'hood' ? storyChoices(structure) : [];
  if (stories.length) {
    // a porch or bay rises a whole number of the house's stories: its roof tops out at the top of one
    const current = stories.find((choice) => Math.abs(choice.wallHeight - structure.wallHeight) < 0.005);
    height.push(selectField('Stories (its roof reaches the top of)', 'stories', [
      ...(current ? [] : [['', 'Custom height']]),
      ...stories.map((choice) => [String(choice.stories), choice.stories === 1 ? 'The first story' : `Story ${choice.stories}`]),
    ], current ? String(current.stories) : ''));
  }
  height.push(sliderField(
    recess ? 'Ceiling height' : structure.kind === 'hood' ? 'Height of its roof above the floor' : 'Wall height',
    'wallHeight', structure.wallHeight, limits.wallHeightMin, limits.wallHeightMax,
  ));
  if (type === 'upper-porch' || type === 'turret') {
    height.push(numberField('Base height above the host plate', 'baseHeight', structure.baseHeight));
  }
  if (type === 'turret') {
    height.push(selectField('Held up by', 'support', [['brackets', 'A corbel (brackets)'], ['none', 'Nothing (cantilevered)']], structure.support === 'none' ? 'none' : 'brackets'));
  }
  if (role === 'dormer') {
    height.push(sliderField('Recessed front (inset)', 'inset', structure.inset, limits.insetMin, limits.insetMax));
  }

  const roof = [];
  if (role === 'tower') {
    // a tower's roof is a pyramid (a cone when round): only its pitch is a choice
    roof.push(numberField('Roof pitch (rise per 12; empty for the building\'s)', 'pitch', structure.roofShape?.mode === 'slope' ? structure.roofShape.pitchRise : null, { length: false, step: 1, placeholder: 'building' }));
  } else if (!recess) {
    // a wraparound turns its corner on a hip or shed roof; a canted bay takes
    // a hip, a flat roof, or none (tucked under the eave)
    const roofOptions = type === 'wraparound-porch'
      ? STRUCTURE_ROOF_OPTIONS.filter(([key]) => key === 'hip' || key === 'shed')
      : type === 'canted-bay'
        ? [...STRUCTURE_ROOF_OPTIONS.filter(([key]) => key === 'hip' || key === 'flat'), ['none', 'None (tucked under the eave)']]
        : STRUCTURE_ROOF_OPTIONS;
    roof.push(selectField('Roof', 'roofType', roofOptions, structure.roofType));
    // a dormer's ridge always runs into the roof; a bay's roof rises from its outer walls
    if ((through || standing) && type !== 'canted-bay' && (structure.roofType === 'gable' || structure.roofType === 'hip')) {
      roof.push(selectField('Ridge', 'ridge', [['perpendicular', 'Runs into the roof'], ['parallel', 'Runs along the side']], structure.ridge));
    }
    if (structure.roofType !== 'flat' && structure.roofType !== 'none') {
      roof.push(numberField('Roof pitch (rise per 12; empty for the building\'s)', 'pitch', structure.roofShape?.mode === 'slope' ? structure.roofShape.pitchRise : null, { length: false, step: 1, placeholder: 'building' }));
    }
  }
  if (!through && !standing) {
    roof.push(selectField('At the ridge', 'join', [['auto', 'Lower the roof only if it would pass the ridge'], ['snap-ridge', 'Always meet the ridge']], structure.join));
  }
  if (!recess && !['hood', 'tower', 'turret'].includes(type) && Number.isFinite(structure.setback) && structure.setback < 0) {
    // a hood is always on brackets; a porch on the ground stands on its deck, posts, or walls
    const supports = STRUCTURE_SUPPORTS.filter((key) => !(structure.baseHeight === 'ground' && (key === 'brackets' || key === 'none')));
    height.push(selectField('Held up by', 'support', supports.map((key) => [key, key === 'auto' ? 'Automatic' : `${key[0].toUpperCase()}${key.slice(1)}`]), structure.support));
  }

  const openings = ['<div class="field"><label>Open sides</label>'
    + STRUCTURE_WALLS.map((wall) => checkField(wall, `open:${wall}`, structure.openSides.includes(wall))).join('') + '</div>'];

  const materials = [selectField('Wall material', 'wallMaterial', MATERIAL_OPTIONS, structure.materials?.wall ?? '')];
  if (!recess) {
    materials.push(selectField('Roof material', 'roofMaterial', MATERIAL_OPTIONS, structure.materials?.roof ?? ''));
  }

  const entry = activeStructureEntries.find((candidate) => candidate.id === structure.id);
  const buildError = entry?.errors?.[0];
  const errorBanner = buildError
    ? `<div class="structure-editor-error">Not built: ${escapeHtml(nameSides(buildError.message))}</div>`
    : '';

  return `<div class="structure-editor-head"><span>Editing ${escapeHtml(structure.id)}</span></div>${errorBanner}`
    + fieldGroup('Placement', placement)
    + fieldGroup('Footprint', footprint)
    + fieldGroup('Height', height)
    + fieldGroup('Roof', roof)
    + fieldGroup('Openings', openings)
    + fieldGroup('Materials', materials);
}

function rebuildWithStructures(structures) {
  modelConfig.roofStructures = normalizeRoofStructures(structures);
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
}

/**
 * A new structure's offset along its host wall, moved clear of any sibling
 * already on the same host volume and side: the default of 0 (see
 * normalizeRoofStructure) would otherwise stack every same-preset addition
 * on top of the first, guaranteeing the "overlaps" error a second dormer or
 * porch on a wall would hit. A wraparound (its own wall-length fields) or a
 * corner tower/turret (already offset to straddle the corner) don't use a
 * plain offset the same way, so they're left alone.
 */
function nextFreeOffset(record, siblings, wallLength) {
  if (record.wrap || record.plan?.shape === 'polygon') {
    return record.offset;
  }
  const width = record.width ?? 1;
  const gap = 0.3;
  const halfWall = wallLength / 2;
  const occupied = siblings
    .filter((s) => s.id !== record.id && !s.hostStructureId && s.hostVolumeId === record.hostVolumeId && s.hostSide === record.hostSide)
    .map((s) => ({ lo: s.offset - (s.width ?? 1) / 2 - gap, hi: s.offset + (s.width ?? 1) / 2 + gap }))
    .sort((a, b) => a.lo - b.lo);
  if (!occupied.length) {
    return record.offset;
  }
  const overlapsAny = (range) => occupied.some((o) => range.lo < o.hi && o.lo < range.hi);
  const fitsWall = (range) => range.lo >= -halfWall && range.hi <= halfWall;
  const rangeAt = (offset) => ({ lo: offset - width / 2, hi: offset + width / 2 });
  if (!overlapsAny(rangeAt(record.offset))) {
    return record.offset;
  }
  for (const o of occupied) {
    const candidate = o.hi + width / 2;
    const range = rangeAt(candidate);
    if (fitsWall(range) && !overlapsAny(range)) {
      return candidate;
    }
  }
  // no clear stretch fits: leave it where it was (the overlap error still flags it)
  return record.offset;
}

structurePresetSelect.addEventListener('change', renderStructurePanel);

structureAddBtn.addEventListener('click', () => {
  if (!activeLayout) {
    setStatus('Load a footprint before adding roof structures.', 'error');
    return;
  }
  const hostVolume = selectedVolume(activeLayout) ?? activeLayout.volumes[0];
  const wallLength = ['minX', 'maxX'].includes(structureSideSelect.value) ? hostVolume.maxZ - hostVolume.minZ : hostVolume.maxX - hostVolume.minX;
  const record = newRoofStructure(structurePresetSelect.value, {
    hostVolumeId: hostVolume.id,
    hostSide: structureSideSelect.value,
    storyHeight: modelConfig.storyHeight,
    wallLength,
    wallTop: volumeWallHeight(hostVolume.id, modelConfig),
    hostStructure: selectedStructureId ? structureRecord(selectedStructureId) : undefined,
  }, modelConfig.roofStructures);
  if (!record) {
    setStatus('Select the porch to stand it on first.', 'error');
    return;
  }
  // A dormer's depth defaults to "auto" (stretch to the host ridge), which
  // only resolves on a sloped roof; a flat host has no ridge to reach, so it
  // would otherwise add a structure that can never build (and, until fixed,
  // never render). Give it an explicit depth instead.
  if (record.depth === null && (modelConfig.volumeRoofTypes?.[hostVolume.id] ?? modelConfig.roofType) === 'flat') {
    record.depth = 2.4;
  }
  record.offset = nextFreeOffset(record, modelConfig.roofStructures, wallLength);
  selectedStructureId = record.id;
  rebuildWithStructures([...modelConfig.roofStructures, record]);
});

/** Deletes a roof structure, with everything standing on it. */
function deleteStructure(id) {
  const doomed = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    modelConfig.roofStructures.forEach((structure) => {
      if (structure.hostStructureId && doomed.has(structure.hostStructureId) && !doomed.has(structure.id)) {
        doomed.add(structure.id);
        grew = true;
      }
    });
  }
  if (doomed.has(selectedStructureId)) {
    selectedStructureId = null;
  }
  rebuildWithStructures(modelConfig.roofStructures.filter((structure) => !doomed.has(structure.id)));
}

/** Applies one structure-editor field's current value to its record and rebuilds. Shared by `change` (every field) and `input` (sliders, for continuous updates while dragging). */
function applyStructureFieldEdit(input) {
  const record = structureRecord(selectedStructureId);
  if (!input || !record) {
    return;
  }
  const edited = { ...record, materials: { ...record.materials } };
  const length = () => (Number(input.value) || 0) / unitFactor();
  // Offset/setback also reach the model from the paired number box, which
  // (unlike the slider) doesn't inherently keep its value in range, so clamp
  // both to the same limits the slider's own travel is bounded to.
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const field = input.dataset.field;
  if (field.startsWith('wrapWall:')) {
    // tick or clear a wall; the end legs keep their lengths where their walls stay at the ends
    const side = field.slice('wrapWall:'.length);
    const walls = wrapWallsWith(record.wrap.walls, side, input.checked);
    if (!walls) {
      renderStructurePanel();
      return;
    }
    const host = activeStructureEntries.find((candidate) => candidate.id === record.id)?.host;
    const span = (wall) => (host ? wallSpan(host, wall) : 4);
    const old = record.wrap.walls;
    edited.wrap = {
      walls,
      startLength: walls[0] === old[0] ? record.wrap.startLength : Math.min(4, span(walls[0])),
      endLength: walls[walls.length - 1] === old[old.length - 1] ? record.wrap.endLength : Math.min(4, span(walls[walls.length - 1])),
    };
    // a leg that was in the middle and is now an end keeps its whole wall
    if (old.includes(walls[0]) && walls[0] !== old[0]) {
      edited.wrap.startLength = span(walls[0]);
    }
    if (old.includes(walls[walls.length - 1]) && walls[walls.length - 1] !== old[old.length - 1]) {
      edited.wrap.endLength = span(walls[walls.length - 1]);
    }
    edited.hostSide = walls[0];
  } else if (field.startsWith('open:')) {
    const wall = field.slice(5);
    edited.openSides = input.checked ? [...new Set([...record.openSides, wall])] : record.openSides.filter((side) => side !== wall);
  } else {
    switch (field) {
      case 'hostSide': {
        // on a shorter wall it is made to fit: as wide as the wall at most, and on it
        edited.hostSide = input.value;
        const limits = structurePlacementLimits(edited);
        edited.width = clamp(record.width, limits.widthMin, limits.widthMax);
        const placed = structurePlacementLimits({ ...edited, width: edited.width });
        edited.offset = clamp(record.offset, placed.offsetMin, placed.offsetMax);
        if (structureRole(edited) === 'projecting') {
          edited.depth = clamp(record.depth ?? -record.setback, placed.depthMin, placed.depthMax);
          edited.setback = -edited.depth;
        }
        break;
      }
      case 'offset': {
        const limits = structurePlacementLimits(record);
        edited.offset = clamp(length(), limits.offsetMin, limits.offsetMax);
        break;
      }
      // Width/depth/wallHeight's own slider bounds hold at offset/setback 0
      // (see structurePlacementLimits), so growing one of them can leave the
      // *other* slider's current value no longer valid; re-clamp it here,
      // against the just-edited size, rather than shrinking the size
      // slider's own range to account for a position it isn't showing.
      case 'width': {
        const limits = structurePlacementLimits(record);
        edited.width = clamp(length(), limits.widthMin, limits.widthMax);
        const offsetLimits = structurePlacementLimits({ ...record, width: edited.width });
        edited.offset = clamp(record.offset, offsetLimits.offsetMin, offsetLimits.offsetMax);
        if (record.plan?.shape === 'canted') {
          // narrowing a canted bay shortens its projection to keep a front
          const depthLimits = structurePlacementLimits({ ...record, width: edited.width });
          const depth = clamp(record.depth ?? -record.setback, depthLimits.depthMin, depthLimits.depthMax);
          Object.assign(edited, { depth, setback: -depth });
        }
        break;
      }
      case 'setbackCenter':
        edited.setback = input.checked ? 'center' : 0;
        if (input.checked && record.depth === null) {
          edited.depth = record.width;
        }
        break;
      case 'setback': {
        const limits = structurePlacementLimits(record);
        edited.setback = clamp(length(), limits.setbackMin, limits.setbackMax);
        break;
      }
      case 'depthAuto': {
        const limits = structurePlacementLimits(record);
        edited.depth = input.checked ? null : clamp(2.4, limits.depthMin, limits.depthMax);
        break;
      }
      case 'depth': {
        const limits = structurePlacementLimits(record);
        edited.depth = clamp(length(), limits.depthMin, limits.depthMax);
        const setbackLimits = structurePlacementLimits({ ...record, depth: edited.depth });
        if (typeof record.setback === 'number') {
          edited.setback = clamp(record.setback, setbackLimits.setbackMin, setbackLimits.setbackMax);
        }
        break;
      }
      case 'wallHeight': {
        const limits = structurePlacementLimits(record);
        edited.wallHeight = clamp(length(), limits.wallHeightMin, limits.wallHeightMax);
        const setbackLimits = structurePlacementLimits({ ...record, wallHeight: edited.wallHeight });
        if (structureRole(record) === 'dormer' && record.inset > 0) {
          // lower walls leave less room for a recessed front
          const insetLimits = structurePlacementLimits({ ...record, wallHeight: edited.wallHeight });
          edited.inset = clamp(record.inset, insetLimits.insetMin, insetLimits.insetMax);
        }
        if (typeof record.setback === 'number' && structureRole(record) !== 'projecting') {
          edited.setback = clamp(record.setback, setbackLimits.setbackMin, setbackLimits.setbackMax);
        }
        break;
      }
      case 'projection': {
        // a porch stands against its wall: its back on the wall, its front out by its depth
        const limits = structurePlacementLimits(record);
        edited.depth = clamp(length(), limits.depthMin, limits.depthMax);
        edited.setback = -edited.depth;
        if (record.wrap) {
          edited.wrap = { ...record.wrap };
        }
        break;
      }
      case 'stories': {
        const choice = storyChoices(record).find((candidate) => String(candidate.stories) === input.value);
        if (choice) {
          edited.wallHeight = choice.wallHeight;
        }
        break;
      }
      case 'baseHeight': {
        // an upper porch stays at least a story up, and no higher than the host's plate
        const host = activeStructureEntries.find((candidate) => candidate.id === record.id)?.host;
        const storyHeight = modelConfig.volumeStoryHeights?.[record.hostVolumeId] ?? modelConfig.storyHeight;
        const lowest = host && Number.isFinite(host.foundationTopY) && Number.isFinite(host.baseY)
          ? host.foundationTopY + storyHeight - host.baseY
          : -Infinity;
        edited.baseHeight = clamp(length(), Math.min(lowest, 0), 0);
        break;
      }
      case 'inset': {
        const limits = structurePlacementLimits(record);
        edited.inset = clamp(length(), limits.insetMin, limits.insetMax);
        break;
      }
      case 'roofType': edited.roofType = input.value; break;
      case 'ridge': edited.ridge = input.value; break;
      case 'pitch': edited.roofShape = input.value === '' ? null : { mode: 'slope', pitchRise: Math.max(0, Number(input.value) || 0) }; break;
      case 'join': edited.join = input.value; break;
      case 'support': edited.support = input.value; break;
      case 'planShape': edited.plan = input.value ? { shape: input.value } : null; break;
      case 'planAngle': edited.plan = { ...edited.plan, angle: Number(input.value) || 45 }; break;
      case 'planSides': edited.plan = { ...edited.plan, sides: clamp(Math.round(Number(input.value) || 8), 5, 32) }; break;
      case 'diameter': {
        // resized about its center, so a tower on a corner stays on it
        const limits = structurePlacementLimits(record);
        const diameter = clamp(length(), limits.widthMin, Math.min(limits.widthMax, limits.depthMax));
        const depth = record.depth ?? record.width;
        Object.assign(edited, { width: diameter, depth: diameter });
        if (Number.isFinite(record.setback)) {
          edited.setback = record.setback + (depth - diameter) / 2;
        }
        const placed = structurePlacementLimits(edited);
        edited.offset = clamp(record.offset, placed.offsetMin, placed.offsetMax);
        break;
      }
      case 'wrapStart': {
        const limits = structurePlacementLimits(record);
        edited.wrap = { ...record.wrap, startLength: clamp(length(), MIN_STRUCTURE_SIZE, limits.wrapStartMax ?? Infinity) };
        break;
      }
      case 'wrapEnd': {
        const limits = structurePlacementLimits(record);
        edited.wrap = { ...record.wrap, endLength: clamp(length(), MIN_STRUCTURE_SIZE, limits.wrapEndMax ?? Infinity) };
        break;
      }
      case 'wallMaterial': edited.materials.wall = input.value || undefined; break;
      case 'roofMaterial': edited.materials.roof = input.value || undefined; break;
      default: return;
    }
  }
  rebuildWithStructures(modelConfig.roofStructures.map((structure) => (structure.id === record.id ? edited : structure)));
  // a wider or steeper roof rises higher: a porch's walls come down so it
  // still tops out under the host eave (its limits use the roof as built)
  const settled = modelConfig.roofStructures.find((structure) => structure.id === record.id);
  if (settled && structureRole(settled) === 'projecting') {
    const limits = structurePlacementLimits(settled);
    if (settled.wallHeight > limits.wallHeightMax + 1e-6 && limits.wallHeightMax > limits.wallHeightMin) {
      rebuildWithStructures(modelConfig.roofStructures.map((structure) => (structure.id === record.id
        ? { ...settled, wallHeight: limits.wallHeightMax }
        : structure)));
    }
  }
}

structureEditor.addEventListener('change', (event) => {
  applyStructureFieldEdit(event.target.closest('[data-field]'));
});

// Sliders (offset/setback) fire `input` continuously while dragged, so the
// dormer's position updates live instead of only once the mouse is released.
let structureLiveDragging = false;
structureEditor.addEventListener('input', (event) => {
  const input = event.target.closest('input[type="range"][data-field]');
  if (!input) {
    return;
  }
  structureLiveDragging = true;
  try {
    applyStructureFieldEdit(input);
  } finally {
    structureLiveDragging = false;
  }
});

function resizeRenderer() {
  const viewportWidth = viewportCanvas.clientWidth;
  const viewportHeight = viewportCanvas.clientHeight;
  const topWidth = topViewCanvas.clientWidth;
  const topHeight = topViewCanvas.clientHeight;
  const elevationWidth = elevationViewCanvas.clientWidth;
  const elevationHeight = elevationViewCanvas.clientHeight;

  renderer.setSize(viewportWidth, viewportHeight, false);
  topRenderer.setSize(topWidth, topHeight, false);
  elevationRenderer.setSize(elevationWidth, elevationHeight, false);

  camera.aspect = viewportWidth / viewportHeight;
  camera.updateProjectionMatrix();

  updateTopCameraFrustum();
  if (activeLayout) {
    updateElevationCamera(activeLayout, elevationCamera.zoom, elevationControls.target.clone());
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  topControls.update();
  elevationControls.update();

  renderer.render(scene, camera);
  topRenderer.render(scene, topCamera);
  elevationRenderer.render(scene, elevationCamera);
}

window.addEventListener('resize', resizeRenderer);
resizeRenderer();
animate();

// a footprint handed over in the address opens once the skeleton library
// is ready (hips need it); otherwise the sample shows, rebuilt when it is
const importing = /^#import=/.test(window.location.hash);
if (!importing) {
  loadSampleFootprint();
}

if (globalThis.SkeletonBuilder) {
  globalThis.SkeletonBuilder.init().then(() => {
    setStraightSkeletonBuilder(globalThis.SkeletonBuilder);
    if (importing) {
      openPayloadFromAddress();
    } else if (loadedFootprint) {
      loadFootprint(loadedFootprint);
    }
  });
} else if (importing) {
  openPayloadFromAddress();
}
