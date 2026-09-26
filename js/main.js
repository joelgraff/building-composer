import * as THREE from '../node_modules/three/build/three.module.js';
import { OrbitControls } from '../node_modules/three/examples/jsm/controls/OrbitControls.js';
import { validateFootprint, normalizeFootprint, computeFootprintMetrics } from './footprint.js';
import { createBuildingFromFootprint, roofHeightFromPitch, roofPitchFromHeight, roofPitchDegrees, setStraightSkeletonBuilder } from './extrusion.js';
import { computeFacadeLayout, serializeBuildingState, deserializeBuildingState, findVolumeAdjacencies, roofAxisForDirection } from './facade.js';
import { exportGlb } from './export.js';

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
const storyCountInput = document.getElementById('story-count');
const storyHeightInput = document.getElementById('story-height');
const panelsPerRunInput = document.getElementById('panels-per-run');
const roofTypeSelect = document.getElementById('roof-type');
const roofDirectionSelect = document.getElementById('roof-direction');
const roofPitchRiseInput = document.getElementById('roof-pitch-rise');
const roofPitchDisplay = document.getElementById('roof-pitch-display');
const roofHeightInput = document.getElementById('roof-height');
const roofEaveDepthInput = document.getElementById('roof-eave-depth');
const roofHeightModeSelect = document.getElementById('roof-height-mode');
const roofHeightModeField = document.getElementById('roof-height-mode-field');
const roofConnectionSelect = document.getElementById('roof-connection');
const roofConnectionField = document.getElementById('roof-connection-field');
const storyHeightUnit = document.getElementById('story-height-unit');
const roofHeightUnit = document.getElementById('roof-height-unit');
const roofEaveUnit = document.getElementById('roof-eave-unit');
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
let hoveredVolumeId = null;
let pointerDown = null;

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
  roofHeightMode: roofHeightModeSelect.value,
  wallMaterial: wallMaterialSelect.value,
  storyMaterials: [],
  panelMaterials: [],
  volumeStoryOverrides: {},
  volumeRidgeDirections: {},
  volumeRoofTypes: {},
  volumeRoofConnections: {},
  volumeRoofShapes: {},
  edgePitchOverrides: {},
};
let currentVolumeCount = 1;

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
}

function syncLengthInputs() {
  storyHeightInput.value = (modelConfig.storyHeight * unitFactor()).toFixed(1);
  roofHeightInput.value = (modelConfig.roofHeight * unitFactor()).toFixed(1);
  roofEaveDepthInput.value = (modelConfig.roofEaveDepth * unitFactor()).toFixed(1);
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
  roofEaveDepthInput.disabled = !rectangular;
  roofSupportNote.textContent = rectangular
    ? 'Roof variants and eave projection are active.'
    : 'Roof variants follow this footprint; eave projection is constrained until roof zones are assigned.';
}

function updateRoofHeightModeVisibility(volumeCount) {
  roofHeightModeField.style.display = volumeCount > 1 ? '' : 'none';
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
  facadeSummaryBox.innerHTML = `Story height: ${formatLength(layout.storyHeight)}<br>Stories: ${layout.stories.length}<br>Facade panels: ${layout.facadePanels.length}<br>${panelList}`;
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
  if (!options.some((option) => option.includes(`value="${selectedElementId}"`))) {
    selectedElementId = 'building-defaults';
  }
  elementSelect.innerHTML = options.join('');
  elementSelect.value = selectedElementId;
  selectedElementLabel.textContent = selectedElementId === 'building-defaults'
    ? 'Building defaults'
    : `Volume: ${selectedElementId.replace('-', ' ')}`;
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
  const canMerge = volume && (
    (roofType === 'shed' && adjacentVolumeForHighEdge(volume, layout.volumes, roofDirectionSelect.value))
    || (roofType === 'gable' && gableEndTouchesNeighbor(volume, layout.volumes))
  );
  if (volume && layout.volumes.length > 1) {
    syncVolumeRoofShapeInputs(volume);
  }
  roofConnectionField.style.display = canMerge ? '' : 'none';
  if (canMerge) {
    // Default to "standalone" only the first time this volume becomes
    // mergeable; once the user (or a prior render) has set a value, leave it
    // alone. Resetting it on every render here previously overwrote the
    // user's "merge-plane" choice on the very next rebuild.
    if (modelConfig.volumeRoofConnections[volume.id] === undefined) {
      modelConfig.volumeRoofConnections[volume.id] = 'standalone';
    }
    roofConnectionSelect.value = modelConfig.volumeRoofConnections[volume.id];
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

function gableEndTouchesNeighbor(volume, volumes) {
  const direction = modelConfig.volumeRidgeDirections[volume.id];
  const ridgeAxis = direction ? roofAxisForDirection(direction) : volume.ridgeAxis;
  const endSides = ridgeAxis === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ'];
  return findVolumeAdjacencies(volumes).some((adjacency) => (
    (adjacency.volumeAId === volume.id && endSides.includes(adjacency.sideA))
    || (adjacency.volumeBId === volume.id && endSides.includes(adjacency.sideB))
  ));
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
  volumeControlsBox.innerHTML = `
    <div class="field">
      <label for="${volume.id}-stories">${volume.id.replace('-', ' ')} (${width} × ${length})</label>
      <input type="number" min="1" max="12" step="1" value="${currentValue}" data-volume-id="${volume.id}" id="${volume.id}-stories" />
    </div>
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
  updateRoofControlAvailability(normalized);
  const layout = computeFacadeLayout(normalized, {
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

  const { building, foundationHeight } = createBuildingFromFootprint(normalized, {
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
    volumeRidgeDirections: modelConfig.volumeRidgeDirections,
    volumeRoofTypes: modelConfig.volumeRoofTypes,
    volumeRoofConnections: modelConfig.volumeRoofConnections,
    volumeRoofShapes: modelConfig.volumeRoofShapes,
    roofHeightMode: modelConfig.roofHeightMode,
    foundationDepth: 0.7,
    roofOverhang: 0.35,
  });

  group.add(building);
  activeLayout = layout;
  activeFoundationHeight = foundationHeight;
  addVolumePickTargets(layout, foundationHeight);
  renderSelectedVolumeHighlight(layout, foundationHeight);
  if (normalized.length === 4) {
    renderFootprintPreview(normalized);
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
  modelConfig.volumeRidgeDirections = {};
  modelConfig.volumeRoofTypes = {};
  modelConfig.volumeRoofConnections = {};
  modelConfig.volumeRoofShapes = {};
  selectedElementId = 'building-defaults';
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
  const storyCount = modelConfig.volumeStoryOverrides[volume.id] ?? modelConfig.storyCount;
  const height = storyCount * modelConfig.storyHeight + foundationHeight;
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
    const storyCount = modelConfig.volumeStoryOverrides[volume.id] ?? modelConfig.storyCount;
    const height = storyCount * modelConfig.storyHeight + foundationHeight;
    const target = new THREE.Mesh(
      new THREE.BoxGeometry(volume.maxX - volume.minX, height, volume.maxZ - volume.minZ),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    target.position.set((volume.minX + volume.maxX) / 2, height / 2 + 0.04, (volume.minZ + volume.maxZ) / 2);
    target.userData.volumeId = volume.id;
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
  if (!activeLayout || pickTargets.length === 0) {
    return;
  }
  const rect = viewportCanvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickTargets, false)[0];
  const volumeId = hit?.object.userData.volumeId ?? null;
  if (volumeId === hoveredVolumeId) {
    return;
  }
  hoveredVolumeId = volumeId;
  clearHoverCue();
  const volume = activeLayout.volumes.find((candidate) => candidate.id === volumeId);
  if (volume && volume.id !== selectedElementId) {
    renderVolumeCue(volume, activeFoundationHeight, 0xf4b400, 0.06, hoverGroup);
  }
  viewportCanvas.style.cursor = volume ? 'pointer' : 'default';
}

function handleFileInput(event) {
  const [file] = event.target.files;
  if (!file) {
    return;
  }
  modelConfig.volumeStoryOverrides = {};
  modelConfig.volumeRidgeDirections = {};
  modelConfig.volumeRoofTypes = {};
  modelConfig.volumeRoofConnections = {};
  modelConfig.volumeRoofShapes = {};
  modelConfig.edgePitchOverrides = {};
  selectedElementId = 'building-defaults';

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
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
          syncUnitLabels();
          syncLengthInputs();
          updateRoofPitchDisplay();
          loadFootprint(result.state.footprint, false);
          setStatus('Project (.bld) loaded successfully.', 'default');
          return;
        }
      }
      loadFootprint(payload, false);
    } catch (error) {
      setStatus('Unable to parse JSON footprint file.', 'error');
    }
  };

  reader.readAsText(file);
}

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
    modelConfig.volumeRoofShapes[targetVolume] = { mode: 'slope', pitchRise };
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
    modelConfig.volumeRoofShapes[targetVolume] = { mode: 'height', height };
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

roofEaveDepthInput.addEventListener('input', () => {
  modelConfig.roofEaveDepth = Math.max(0, (Number(roofEaveDepthInput.value) || 0) / unitFactor());
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
resetViewBtn.addEventListener('click', () => {
  controls.reset();
  camera.position.set(30, 18, 28);
  camera.lookAt(0, 0, 0);
  controls.update();
});

viewportCanvas.addEventListener('pointermove', updateHoveredVolume);
viewportCanvas.addEventListener('pointerleave', () => {
  hoveredVolumeId = null;
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
  if (!hoveredVolumeId || hoveredVolumeId === selectedElementId) {
    return;
  }
  selectedElementId = hoveredVolumeId;
  elementSelect.value = selectedElementId;
  loadFootprint(loadedFootprint);
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

loadSampleFootprint();

if (globalThis.SkeletonBuilder) {
  globalThis.SkeletonBuilder.init().then(() => {
    setStraightSkeletonBuilder(globalThis.SkeletonBuilder);
    if (loadedFootprint) {
      loadFootprint(loadedFootprint);
    }
  });
}
