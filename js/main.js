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
  computeFacadeLayout, serializeBuildingState, deserializeBuildingState, findVolumeAdjacencies, roofAxisForDirection, withStructureFacades, angledWallProblem,
} from './facade.js';
import { exportGlb } from './export.js';
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
const panelMaterialsBox = document.getElementById('panel-materials');
const volumeControlsBox = document.getElementById('volume-controls');
const elementSelect = document.getElementById('element-select');
const selectedElementLabel = document.getElementById('selected-element-label');
const facadeSummaryBox = document.getElementById('facade-summary-box');
const roofGraphSummary = document.getElementById('roof-graph-summary');
const roofGraphEdges = document.getElementById('roof-graph-edges');
const sampleBtn = document.getElementById('sample-btn');
const footprintSelect = document.getElementById('footprint-select');
const loadBtn = document.getElementById('load-btn');
const saveBtn = document.getElementById('save-btn');
const exportBtn = document.getElementById('export-btn');
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
const structureList = document.getElementById('structure-list');
const structureEditor = document.getElementById('structure-editor');

const viewportCanvas = document.getElementById('viewport');
const topViewCanvas = document.getElementById('top-view');

const renderer = new THREE.WebGLRenderer({ canvas: viewportCanvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0xf3f5f7, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const topRenderer = new THREE.WebGLRenderer({ canvas: topViewCanvas, antialias: true, alpha: true });
topRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
topRenderer.setClearColor(0xf3f5f7, 1);
topRenderer.outputColorSpace = THREE.SRGBColorSpace;

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

const controls = new OrbitControls(camera, viewportCanvas);
controls.enableDamping = true;
controls.target.set(0, 3, 0);

const topControls = new OrbitControls(topCamera, topViewCanvas);
topControls.enableRotate = false;
topControls.enablePan = true;
topControls.enableZoom = true;
topControls.target.set(0, 0, 0);

const group = new THREE.Group();
scene.add(group);
const hoverGroup = new THREE.Group();
scene.add(hoverGroup);
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pickTargets = [];
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
let pointerDown = null;
// roof structures: the one being edited, what the last build made of each, and their meshes (for picking)
let selectedStructureId = null;
let hoveredStructureId = null;
let activeStructureEntries = [];
let structureMeshes = [];

let loadedFootprint = null;
let activeBuildingSize = new THREE.Vector3(30, 0, 30);

function updateTopCameraFrustum() {
  const halfX = Math.max(15, activeBuildingSize.x * 0.7) / 2;
  const halfZ = Math.max(15, activeBuildingSize.z * 0.7) / 2;
  topCamera.left = -halfX;
  topCamera.right = halfX;
  topCamera.top = halfZ;
  topCamera.bottom = -halfZ;
  topCamera.updateProjectionMatrix();
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
    volumes
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
    volumes
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
  const panelList = layout.facadePanels
    .map((panel) => `Panel ${panel.index + 1}: ${formatLength(panel.length)}`)
    .join('<br>');
  const structureRuns = layout.structureWallRuns?.length ?? 0;
  const railRuns = layout.railRuns?.length ?? 0;
  const structureSummary = structureRuns || railRuns
    ? `<br>Roof structure wall runs: ${structureRuns}<br>Railing runs: ${railRuns}`
    : '';
  facadeSummaryBox.innerHTML = `Story height: ${formatLength(layout.storyHeight)}<br>Stories: ${layout.stories.length}<br>Facade panels: ${layout.facadePanels.length}${structureSummary}<br>${panelList}`;
  renderMaterialControls(layout);
  renderElementSelector(layout);
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

function renderElementSelector(layout) {
  const options = [
    '<option value="building-defaults">Building defaults</option>',
    ...layout.volumes.map((volume) => `<option value="${volume.id}">Massing + roof zone: ${volume.id.replace('-', ' ')}</option>`),
  ];
  const structure = selectedStructureId ? structureRecord(selectedStructureId) : null;
  if (selectedStructureId && !structure) {
    selectedStructureId = null;
  }
  // with a structure selected, the volume settings are those of the volume it stands on
  const hostVolumeId = structure ? structureHostVolumeId(structure) : null;
  if (hostVolumeId && layout.volumes.some((volume) => volume.id === hostVolumeId)) {
    selectedElementId = hostVolumeId;
  }
  if (!options.some((option) => option.includes(`value="${selectedElementId}"`))) {
    selectedElementId = 'building-defaults';
  }
  elementSelect.innerHTML = options.join('');
  elementSelect.value = selectedElementId;
  selectedElementLabel.textContent = structure
    ? `Roof structure: ${structureLabel(structure, modelConfig.frontSide)} (volume settings: ${selectedElementId === 'building-defaults' ? 'building defaults' : selectedElementId.replace('-', ' ')})`
    : selectedElementId === 'building-defaults'
      ? 'Building defaults'
      : `Volume: ${selectedElementId.replace('-', ' ')}`;
}

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
  panelMaterialsBox.innerHTML = layout.facadePanels.map((panel) => `
    <div class="field">
      <label for="${panel.id}-material">Panel ${panel.index + 1}</label>
      <select data-material-axis="panel" data-material-index="${panel.index}" id="${panel.id}-material">
        ${createMaterialOptions(panel.material)}
      </select>
    </div>
  `).join('');
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
  hoveredVolumeId = null;
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
      const edgeLength = Math.hypot(endX - startX, endZ - startZ);
      const normalX = (endZ - startZ) / edgeLength;
      const normalZ = -(endX - startX) / edgeLength;
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
    building, foundationHeight, roofStructures, structureFacades, roofWalks, roofZones: builtRoofZones,
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
  structureMeshes = [];
  building.traverse((child) => {
    if (child.isMesh && child.userData?.structureId) {
      structureMeshes.push(child);
    }
  });
  addVolumePickTargets(layout, foundationHeight);
  if (selectedStructureId) {
    renderStructureCue(selectedStructureId, 0x00a6b8, group);
  } else {
    renderSelectedVolumeHighlight(layout, foundationHeight);
  }
  renderStructurePanel();
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

function clearHoverCue() {
  while (hoverGroup.children.length > 0) {
    const child = hoverGroup.children.pop();
    child.geometry?.dispose();
    child.material?.dispose();
  }
}

function updateHoveredVolume(event) {
  if (!activeLayout || (pickTargets.length === 0 && structureMeshes.length === 0)) {
    return;
  }
  const rect = viewportCanvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  // the nearest of the volumes and the roof structures under the pointer
  const hit = raycaster.intersectObjects([...pickTargets, ...structureMeshes], false)[0];
  // a wraparound's side segment picks its porch
  const structureId = hit?.object.userData.recordId ?? hit?.object.userData.structureId ?? null;
  const volumeId = structureId ? null : hit?.object.userData.volumeId ?? null;
  if (volumeId === hoveredVolumeId && structureId === hoveredStructureId) {
    return;
  }
  hoveredVolumeId = volumeId;
  hoveredStructureId = structureId;
  clearHoverCue();
  if (structureId && structureId !== selectedStructureId) {
    renderStructureCue(structureId, 0xf4b400, hoverGroup);
  }
  const volume = activeLayout.volumes.find((candidate) => candidate.id === volumeId);
  if (volume && (volume.id !== selectedElementId || selectedStructureId)) {
    renderVolumeCue(volume, activeFoundationHeight, 0xf4b400, 0.06, hoverGroup);
  }
  viewportCanvas.style.cursor = volume || structureId ? 'pointer' : 'default';
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

elementSelect.addEventListener('change', () => {
  selectedElementId = elementSelect.value;
  // choosing another element leaves the structure it was showing
  selectedStructureId = null;
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
panelMaterialsBox.addEventListener('change', handleRegionMaterialChange);

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

viewportCanvas.addEventListener('pointermove', updateHoveredVolume);
viewportCanvas.addEventListener('pointerleave', () => {
  hoveredVolumeId = null;
  hoveredStructureId = null;
  clearHoverCue();
  viewportCanvas.style.cursor = 'default';
});
viewportCanvas.addEventListener('pointerdown', (event) => {
  pointerDown = { x: event.clientX, y: event.clientY };
});
viewportCanvas.addEventListener('pointerup', (event) => {
  if (!pointerDown || Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 4) {
    pointerDown = null;
    return;
  }
  pointerDown = null;
  if (hoveredStructureId) {
    if (hoveredStructureId !== selectedStructureId) {
      selectedStructureId = hoveredStructureId;
      loadFootprint(loadedFootprint);
    }
    return;
  }
  if (!hoveredVolumeId || (hoveredVolumeId === selectedElementId && !selectedStructureId)) {
    return;
  }
  selectedStructureId = null;
  selectedElementId = hoveredVolumeId;
  elementSelect.value = selectedElementId;
  loadFootprint(loadedFootprint);
});

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
const MATERIAL_OPTIONS = [['', 'Building default'], ['wood', 'Wood'], ['brick', 'Brick'], ['stucco', 'Stucco'], ['metal', 'Metal'], ['stone', 'Stone']];

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

  structureList.innerHTML = modelConfig.roofStructures.length
    ? modelConfig.roofStructures.map((structure) => {
      const entry = activeStructureEntries.find((candidate) => candidate.id === structure.id);
      const problem = entry?.errors?.[0] ?? entry?.warnings?.[0];
      const note = problem
        ? `<span class="structure-note${entry.errors.length ? ' error' : ''}">${escapeHtml(nameSides(problem.message))}</span>`
        : '';
      return `<div class="structure-row-wrap"><button class="structure-row${structure.id === selectedStructureId ? ' selected' : ''}" data-structure-id="${structure.id}">`
        + `${escapeHtml(structure.id)}: ${escapeHtml(structureLabel(structure, modelConfig.frontSide))}${note}</button>`
        + `<button class="structure-delete" data-delete-structure="${structure.id}" title="Delete ${escapeHtml(structure.id)}" aria-label="Delete ${escapeHtml(structure.id)}">×</button></div>`;
    }).join('')
    : '<div style="color:var(--muted);">No roof structures. Pick one above and add it to the selected volume.</div>';

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

  return `<div class="structure-editor-head"><span>Editing ${escapeHtml(structure.id)}</span></div>`
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

structurePresetSelect.addEventListener('change', renderStructurePanel);

structureAddBtn.addEventListener('click', () => {
  if (!activeLayout) {
    setStatus('Load a footprint before adding roof structures.', 'error');
    return;
  }
  const hostVolume = selectedVolume(activeLayout) ?? activeLayout.volumes[0];
  const record = newRoofStructure(structurePresetSelect.value, {
    hostVolumeId: hostVolume.id,
    hostSide: structureSideSelect.value,
    storyHeight: modelConfig.storyHeight,
    wallLength: ['minX', 'maxX'].includes(structureSideSelect.value) ? hostVolume.maxZ - hostVolume.minZ : hostVolume.maxX - hostVolume.minX,
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
  selectedStructureId = record.id;
  rebuildWithStructures([...modelConfig.roofStructures, record]);
});

structureList.addEventListener('click', (event) => {
  const remove = event.target.closest('[data-delete-structure]');
  if (remove) {
    deleteStructure(remove.dataset.deleteStructure);
    return;
  }
  const row = event.target.closest('[data-structure-id]');
  if (!row) {
    return;
  }
  selectedStructureId = row.dataset.structureId === selectedStructureId ? null : row.dataset.structureId;
  if (loadedFootprint) {
    loadFootprint(loadedFootprint);
  }
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

  renderer.setSize(viewportWidth, viewportHeight, false);
  topRenderer.setSize(topWidth, topHeight, false);

  camera.aspect = viewportWidth / viewportHeight;
  camera.updateProjectionMatrix();

  updateTopCameraFrustum();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  topControls.update();

  renderer.render(scene, camera);
  topRenderer.render(scene, topCamera);
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
