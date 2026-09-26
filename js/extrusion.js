/**
 * Extrusion helper that creates the base massing for the model.
 */

import * as THREE from '../node_modules/three/build/three.module.js';
import { createMaterials, MATERIAL_PALETTE } from './materials.js';
import { roofAxisForDirection, findVolumeAdjacencies } from './facade.js';
import {
  resolveVolumeEaves, sideOverhangs, buildGableTrim, buildHipTrim, buildShedTrim,
} from './eaves.js';

let straightSkeletonBuilder = null;

export function setStraightSkeletonBuilder(builder) {
  straightSkeletonBuilder = builder;
}

/**
 * Create a parametric box building from a footprint polygon.
 *
 * @param {Array<[number, number]>} footprint - X/Z footprint vertices.
 * @param {object} config - Building configuration.
 * @param {number} [config.storyCount=1]
 * @param {number} [config.storyHeight=3.2]
 * @param {number} [config.foundationDepth=0.6]
 * @param {number} [config.roofOverhang=0.2]
 * @param {number} [config.roofEaveDepth=0.35]
 * @param {'flat'|'gable'|'hip'|'shed'} [config.roofType='flat']
 * @param {'x'|'z'} [config.roofDirection='z']
 * @param {number} [config.roofHeight=2]
 * @param {number} [config.roofPitchRise=6]
 * @param {number} [config.roofPitchRun=12]
 * @returns {{ building: THREE.Group, foundationHeight: number, totalHeight: number }}
 */
export function createBuildingFromFootprint(footprint, config = {}) {
  const {
    storyCount = 1,
    storyHeight = 3.2,
    foundationDepth = 0.6,
    roofOverhang = 0.2,
    roofEaveDepth = roofOverhang,
    roofType = 'flat',
    roofDirection = 'z',
    roofHeight = 2,
    roofPitchRise = 6,
    roofPitchRun = 12,
  } = config;

  const volumes = config.volumes ?? [];
  const overrides = config.volumeStoryOverrides ?? {};
  const hasVolumeOverrides = volumes.length > 1
    && volumes.some((volume) => overrides[volume.id] !== undefined && overrides[volume.id] !== storyCount);

  if (hasVolumeOverrides) {
    return createMultiVolumeBuilding(volumes, overrides, {
      storyCount, storyHeight, foundationDepth, roofEaveDepth, roofType, roofHeight, roofPitchRise, roofPitchRun, roofHeightMode: config.roofHeightMode, volumeRidgeDirections: config.volumeRidgeDirections, volumeRoofTypes: config.volumeRoofTypes, volumeRoofConnections: config.volumeRoofConnections, volumeRoofShapes: config.volumeRoofShapes,
      ...pickEaveConfig({ ...config, roofEaveDepth }),
    });
  }

  const materials = createMaterials(config);
  const group = new THREE.Group();
  const totalHeight = storyCount * storyHeight;
  const foundationHeight = foundationDepth;
  const primaryRoofZone = config.roofZones?.[0];
  const resolvedRoofType = primaryRoofZone?.roofType ?? roofType;
  const resolvedRoofDirection = primaryRoofZone?.roofDirection ?? roofDirection;
  const resolvedRoofPitchRise = primaryRoofZone?.roofPitchRise ?? roofPitchRise;
  const resolvedRoofPitchRun = primaryRoofZone?.roofPitchRun ?? roofPitchRun;

  const shape = buildShape(footprint, 0);
  const wallGeometry = new THREE.ExtrudeGeometry(shape, {
    depth: totalHeight,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });

  wallGeometry.rotateX(-Math.PI / 2);
  const walls = new THREE.Mesh(wallGeometry, materials.wall);
  walls.position.y = foundationHeight;
  group.add(walls);

  const foundationShape = buildShape(footprint, 0);
  const foundationGeometry = new THREE.ExtrudeGeometry(foundationShape, {
    depth: foundationHeight,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });
  foundationGeometry.rotateX(-Math.PI / 2);
  const foundation = new THREE.Mesh(foundationGeometry, materials.foundation);
  foundation.position.y = 0;
  group.add(foundation);

  const roof = new THREE.Mesh(
    createRoofGeometry(footprint, {
      roofType: resolvedRoofType,
      roofDirection: resolvedRoofDirection,
      roofHeight,
      roofOverhang: roofEaveDepth,
      roofPitchRise: resolvedRoofPitchRise,
      roofPitchRun: resolvedRoofPitchRun,
      volumes: config.volumes,
      volumeRidgeDirections: config.volumeRidgeDirections,
      volumeRoofTypes: config.volumeRoofTypes,
      volumeRoofConnections: config.volumeRoofConnections,
      volumeRoofShapes: config.volumeRoofShapes,
      roofHeightMode: config.roofHeightMode,
      ...pickEaveConfig({ ...config, roofEaveDepth }),
    }),
    materials.roof
  );
  roof.position.y = foundationHeight + totalHeight + 0.02;
  roof.userData = {
    roofZoneId: primaryRoofZone?.id ?? 'roof-zone-main',
    roofType: resolvedRoofType,
    roofDirection: resolvedRoofDirection,
    roofHeight,
    roofPitch: {
      rise: resolvedRoofPitchRise,
      run: resolvedRoofPitchRun,
      degrees: roofPitchDegrees(resolvedRoofPitchRise, resolvedRoofPitchRun),
    },
  };
  group.add(roof);

  if (config.facadeLayout && getRectangularBounds(footprint)) {
    addFacadePanels(group, footprint, config.facadeLayout, foundationHeight, config);
  }

  group.userData = {
    storyCount,
    storyHeight,
    foundationDepth,
    roofOverhang,
    roofEaveDepth,
    roofType,
    roofDirection,
    roofHeight,
    roofPitchRise,
    roofPitchRun,
    facadePanelsRendered: Boolean(config.facadeLayout && getRectangularBounds(footprint)),
  };

  return { building: group, foundationHeight, totalHeight };
}

/**
 * Build independent massing per volume when at least one volume has a story
 * count that diverges from the building default (Task 9). Each volume gets
 * its own box walls, foundation, and an analytic hip/gable/flat roof sized to
 * its own rectangle and elevated to its own wall-top height. The roof ridge
 * for each volume follows that volume's own longitudinal axis, so a lean-to
 * or wing naturally gets a ridge perpendicular to the main block's.
 *
 * This does not yet trim/miter roof planes where volumes of equal height
 * meet (unlike the single-field surface used when no overrides are set);
 * adjacent equal-height volumes will show independent roof edges meeting at
 * the shared wall rather than a blended valley.
 */
function createMultiVolumeBuilding(volumes, overrides, config) {
  const {
    storyCount, storyHeight, foundationDepth, roofEaveDepth, roofType, roofHeight, roofPitchRise, roofPitchRun,
  } = config;
  const directedVolumes = applyVolumeRidgeDirections(volumes, config.volumeRidgeDirections ?? {});
  const hasGableVolume = directedVolumes.some((volume) => (config.volumeRoofTypes?.[volume.id] ?? roofType) === 'gable');
  const roofVolumes = hasGableVolume
    ? resolveGableRidgeDirections(directedVolumes)
    : directedVolumes;
  const materials = createMaterials(config);
  const group = new THREE.Group();
  const foundationHeight = foundationDepth;
  let maxTotalHeight = 0;
  const volumePlateHeights = Object.fromEntries(
    roofVolumes.map((volume) => [volume.id, (overrides[volume.id] ?? storyCount) * storyHeight])
  );
  const connections = resolveRoofConnections(roofVolumes, { ...config, volumePlateHeights });
  const adjacentSides = adjacentSidesByVolume(roofVolumes);

  roofVolumes.forEach((volume) => {
    const volumeStoryCount = overrides[volume.id] ?? storyCount;
    const totalHeight = volumeStoryCount * storyHeight;
    maxTotalHeight = Math.max(maxTotalHeight, totalHeight);
    const roofTypeForVolume = config.volumeRoofTypes?.[volume.id] ?? roofType;
    const volumeConnections = connections.get(volume.id);
    const { bounds, extendedRoofHeight } = applyRoofExtension(
      { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ },
      roofTypeForVolume,
      volumeConnections
    );
    const wallBounds = { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };

    const walls = new THREE.Mesh(createBoxWallGeometry(wallBounds, totalHeight), materials.wall);
    walls.position.y = foundationHeight;
    walls.userData = { volumeId: volume.id };
    group.add(walls);

    const foundation = new THREE.Mesh(createBoxWallGeometry(wallBounds, foundationHeight), materials.foundation);
    foundation.userData = { volumeId: volume.id };
    group.add(foundation);

    const roofDirectionForVolume = volume.ridgeAxis;
    const params = volumeRoofParams(volume.id, halfSpanForBounds(wallBounds, roofDirectionForVolume), config);
    const setup = volumeEaveSetup(
      volume.id,
      roofTypeForVolume,
      { ridgeAxis: roofDirectionForVolume, roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(roofDirectionForVolume) },
      config,
      new Set([...(adjacentSides.get(volume.id) ?? []), ...Object.keys(volumeConnections ?? {})])
    );
    const roofHeightForVolume = roofTypeForVolume === 'flat'
      ? 0
      : (extendedRoofHeight ?? params.roofHeight);
    const roofConfig = {
      roofDirection: roofDirectionForVolume,
      roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(roofDirectionForVolume),
      roofHeight: roofHeightForVolume,
      overhang: setup.overhang,
      eaves: setup.eaves,
      roofPitchRise: params.pitchRise,
      roofPitchRun: params.pitchRun,
      connections: volumeConnections,
    };
    if (roofTypeForVolume === 'gable') {
      const gableMerge = gableMergeGeometry(volume, bounds, volumeConnections, roofHeightForVolume);
      if (gableMerge.any) {
        roofConfig.roofHeight = gableMerge.roofHeight;
        roofConfig.ridgeEndpoints = gableMerge.endpoints;
        roofConfig.mergedEnds = gableMerge.mergedEnds;
      }
    }
    const roofGeometry = roofTypeForVolume === 'gable'
      ? createGableRoofGeometry(bounds, roofConfig)
      : roofTypeForVolume === 'hip'
        ? createHipRoofGeometry(bounds, roofConfig)
        : roofTypeForVolume === 'shed'
          ? createShedRoofGeometry(bounds, roofConfig)
        : createFlatRoofGeometry(bounds, setup.overhang);
    const roof = new THREE.Mesh(flatShaded(clipInsideNeighbor(roofGeometry, volumeConnections)), materials.roof);
    roof.position.y = foundationHeight + totalHeight + 0.02;
    roof.userData = {
      volumeId: volume.id,
      roofType: roofTypeForVolume,
      roofDirection: roofDirectionForVolume,
      roofHeight: roofHeightForVolume,
      roofPitch: {
        rise: params.mode === 'height' ? roofHeightForVolume : params.pitchRise,
        run: params.mode === 'height' ? params.pitchRun : params.pitchRun,
        degrees: roofPitchDegrees(params.pitchRise, params.pitchRun),
      },
    };
    group.add(roof);
  });

  group.userData = { multiVolume: true, volumeCount: volumes.length };
  return { building: group, foundationHeight, totalHeight: maxTotalHeight };
}

/**
 * Resolves the roof shape parameters for one volume. A volume can override
 * the building-wide roof shape with its own pitch (`{ mode: 'slope',
 * pitchRise }`) or fixed roof rise (`{ mode: 'height', height }`) via
 * `config.volumeRoofShapes`; everything else follows the building defaults.
 * `halfSpan` is the volume's own half-width across its ridge.
 */
function volumeRoofParams(volumeId, halfSpan, config) {
  const shape = config.volumeRoofShapes?.[volumeId];
  const mode = shape?.mode ?? config.roofHeightMode ?? 'slope';
  const pitchRun = config.roofPitchRun ?? 12;
  if (mode === 'height') {
    const height = shape?.mode === 'height' ? shape.height : (config.roofHeight ?? 2);
    return { mode, roofHeight: height, pitchRise: height, pitchRun: halfSpan };
  }
  const pitchRise = shape?.mode === 'slope' ? shape.pitchRise : (config.roofPitchRise ?? 6);
  return { mode, roofHeight: halfSpan * (pitchRise / pitchRun), pitchRise, pitchRun };
}

/**
 * A ridge-snap connection (see resolveRoofConnections) physically relocates
 * a shed's boundary on that side out to the neighbor's actual ridge
 * coordinate — not just a taller corner within the same rectangle — so the
 * shed's own roof plane genuinely runs from its far eave to the neighbor's
 * ridge, the way a real saltbox's rear slope does.
 */
function applyRoofExtension(bounds, roofType, connections) {
  let extended = bounds;
  let extendedRoofHeight;
  if (roofType === 'shed' && connections) {
    Object.entries(connections).forEach(([side, resolution]) => {
      if (resolution.extendTo !== undefined) {
        extended = { ...extended, [side]: resolution.extendTo };
        extendedRoofHeight = resolution.height;
      } else if (resolution.rakeTriangle) {
        extendedRoofHeight = resolution.height;
      }
    });
  }
  return { bounds: extended, extendedRoofHeight };
}

// Indexed roof builders share vertices between differently-oriented faces, so
// computeVertexNormals smooths across them and steep closure faces shade
// wrongly (near-black). Unrolling to per-face vertices gives flat shading.
function flatShaded(geometry) {
  return mergeFlatGeometries([geometry]);
}

function roofHeightForBounds(bounds, roofDirection, pitchRise, pitchRun) {
  return halfSpanForBounds(bounds, roofDirection) * (pitchRise / pitchRun);
}

function halfSpanForBounds(bounds, roofDirection) {
  const span = roofDirection === 'x' ? (bounds.maxZ - bounds.minZ) : (bounds.maxX - bounds.minX);
  return Math.max(0.01, span / 2);
}

function defaultHighEdgeForAxis(axis) {
  return axis === 'x' ? 'z-min' : 'x-min';
}

function createBoxWallGeometry(bounds, depth) {
  const shape = new THREE.Shape();
  shape.moveTo(bounds.minX, -bounds.minZ);
  shape.lineTo(bounds.maxX, -bounds.minZ);
  shape.lineTo(bounds.maxX, -bounds.maxZ);
  shape.lineTo(bounds.minX, -bounds.maxZ);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: false, steps: 1, curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function getRoofRun(footprint, roofDirection = 'z', volumes = []) {
  roofDirection = roofAxisForDirection(roofDirection);
  if (volumes.length > 1) {
    if (straightSkeletonBuilder) {
      const ring = footprint.map(([x, z]) => [x, z]);
      ring.push([...ring[0]]);
      const skeleton = straightSkeletonBuilder.buildFromPolygon([ring]);
      if (skeleton) {
        return Math.max(...skeleton.vertices.map(([, , time]) => time), 0.01);
      }
    }
    return Math.max(...volumes.map((volume) => halfSpanForBounds(volume, volume.ridgeAxis)));
  }
  const xValues = footprint.map(([x]) => x);
  const zValues = footprint.map(([, z]) => z);
  const span = roofDirection === 'x'
    ? Math.max(...zValues) - Math.min(...zValues)
    : Math.max(...xValues) - Math.min(...xValues);
  return Math.max(0.01, span / 2);
}

export function roofHeightFromPitch(footprint, roofDirection, pitchRise, pitchRun = 12, volumes = []) {
  return (pitchRise / pitchRun) * getRoofRun(footprint, roofDirection, volumes);
}

export function roofPitchFromHeight(footprint, roofDirection, roofHeight, pitchRun = 12, volumes = []) {
  return (roofHeight / getRoofRun(footprint, roofDirection, volumes)) * pitchRun;
}

export function roofPitchDegrees(pitchRise, pitchRun = 12) {
  return THREE.MathUtils.radToDeg(Math.atan(pitchRise / pitchRun));
}

function createRoofGeometry(footprint, config) {
  const roofHighEdge = config.roofHighEdge ?? config.roofDirection;
  config = {
    ...config,
    roofDirection: roofAxisForDirection(config.roofDirection),
    roofHighEdge,
  };
  const bounds = getRectangularBounds(footprint);
  const hasSlopedVolumeRoof = config.volumes?.some((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
    return roofType === 'gable' || roofType === 'hip' || roofType === 'shed';
  });
  const rectangleVolumeId = config.volumes?.[0]?.id ?? 'volume-main';
  const rectangleSetup = bounds
    ? volumeEaveSetup(rectangleVolumeId, config.roofType, { ridgeAxis: config.roofDirection, roofHighEdge: config.roofHighEdge }, config)
    : null;
  if (bounds && config.roofType === 'flat') {
    return createFlatRoofGeometry(bounds, rectangleSetup.overhang);
  }

  const hasVolumeShapeOverride = Object.keys(config.volumeRoofShapes ?? {}).length > 0
    && config.volumes?.length > 1;
  if (hasVolumeShapeOverride && (config.roofType !== 'flat' || hasSlopedVolumeRoof)) {
    return createVolumeRoofAssembly(config.volumes, config);
  }
  if (config.roofType === 'gable' || config.roofType === 'hip' || config.roofType === 'shed' || hasSlopedVolumeRoof) {
    if (bounds) {
      const shapedConfig = { ...config, overhang: rectangleSetup.overhang, eaves: rectangleSetup.eaves };
      return flatShaded(config.roofType === 'gable'
        ? createGableRoofGeometry(bounds, shapedConfig)
        : config.roofType === 'hip'
          ? createHipRoofGeometry(bounds, shapedConfig)
          : createShedRoofGeometry(bounds, shapedConfig));
    }
    if (config.roofType === 'hip'
      && config.roofHeightMode === 'height'
      && config.volumes
      && config.volumes.length > 1) {
      return createVolumeRoofAssembly(config.volumes, config);
    }
    if (config.roofType === 'hip' && config.volumes && config.volumes.length > 1 && straightSkeletonBuilder) {
      const topologyGeometry = createStraightSkeletonHipGeometry(footprint, config);
      if (topologyGeometry) {
        return topologyGeometry;
      }
    }
    if (config.roofType === 'hip'
      && config.volumes
      && config.volumes.length > 1) {
      return createRoofFieldSurface(footprint, config);
    }
    if (config.volumes && config.volumes.length > 1) {
      return createVolumeRoofAssembly(config.volumes, config);
    }
    return createRoofFieldSurface(footprint, config);
  }

  const roofShape = buildShape(footprint, 0);
  const geometry = new THREE.ExtrudeGeometry(roofShape, {
    depth: 0.08,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 12,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function createStraightSkeletonHipGeometry(footprint, config) {
  const ring = footprint.map(([x, z]) => [x, z]);
  ring.push([...ring[0]]);
  const skeleton = straightSkeletonBuilder.buildFromPolygon([ring]);
  if (!skeleton) {
    return null;
  }

  const pitchRatio = (config.roofPitchRise ?? 6) / (config.roofPitchRun ?? 12);
  const positions = [];

  skeleton.polygons.forEach((polygon) => {
    const points = polygon.map((index) => {
      const [x, z, time] = skeleton.vertices[index];
      return { x, z, height: time * pitchRatio };
    });
    const triangles = THREE.ShapeUtils.triangulateShape(
      points.map((point) => new THREE.Vector2(point.x, point.z)),
      []
    );
    triangles.forEach(([first, second, third]) => {
      [first, second, third].forEach((index) => {
        const point = points[index];
        positions.push(point.x, point.height, point.z);
      });
    });
  });

  if (positions.length === 0) {
    return null;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Build a hip/gable roof for a non-rectangular footprint as an assembly of
 * exact, flat-faced analytic roofs (2 quads + 2 triangles each), one per
 * rectangular volume from decomposeIntoVolumes, each ridge-oriented along its
 * own long axis. This gives correctly flat, non-faceted roof planes.
 *
 * config.roofHeightMode selects which quantity is held constant across
 * volumes of differing width:
 * - 'slope' (default): every volume uses the same pitch, so ridge height
 *   varies with each volume's own half-width (a wider volume gets a taller
 *   ridge).
 * - 'height': every volume's ridge uses config.roofHeight, so each volume's
 *   effective pitch is derived from its own half-width to hit that target (a
 *   wider volume gets a visibly flatter, but still fully peaked, roof).
 *
 * Adjacent volumes meet at a vertical seam along their shared wall rather
 * than blending into one continuous mitered valley in either mode; true
 * seamless mitering requires a full straight-skeleton solve, which is a
 * distinct, larger follow-up (see Task 9 notes in IMPLEMENTATION_PLAN.md).
 */
function createVolumeRoofAssembly(volumes, config) {
  const directedVolumes = applyVolumeRidgeDirections(volumes, config.volumeRidgeDirections ?? {});
  const hasGableVolume = directedVolumes.some((volume) => (config.volumeRoofTypes?.[volume.id] ?? config.roofType) === 'gable');
  const roofVolumes = hasGableVolume
    ? resolveGableRidgeDirections(directedVolumes)
    : directedVolumes;
  const paramsFor = (volume, bounds) => volumeRoofParams(volume.id, halfSpanForBounds(bounds, volume.ridgeAxis), config);
  const ridgeHeights = new Map(roofVolumes.map((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
    const height = roofType === 'flat' ? 0 : paramsFor(volume, volume).roofHeight;
    return [volume.id, height];
  }));
  const anyHeightMode = roofVolumes.some((volume) => paramsFor(volume, volume).mode === 'height');
  // Ridge-to-ridge joins are opt-in now (see resolveRoofConnections); only the
  // older equal-rise hip/height-mode connection still nudges endpoints itself.
  const ridgeEndpoints = anyHeightMode
    ? buildConnectedConstantRiseRidges(roofVolumes, config.roofType === 'hip', ridgeHeights)
    : new Map();
  const connections = resolveRoofConnections(roofVolumes, config);
  const adjacentSides = adjacentSidesByVolume(roofVolumes);

  const chunks = roofVolumes.map((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
    const volumeConnections = connections.get(volume.id);
    const { bounds, extendedRoofHeight } = applyRoofExtension(
      { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ },
      roofType,
      volumeConnections
    );
    const params = paramsFor(volume, bounds);
    const setup = volumeEaveSetup(
      volume.id,
      roofType,
      { ridgeAxis: volume.ridgeAxis, roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(volume.ridgeAxis) },
      config,
      new Set([...(adjacentSides.get(volume.id) ?? []), ...Object.keys(volumeConnections ?? {})])
    );
    const gableMerge = roofType === 'gable' ? gableMergeGeometry(volume, bounds, volumeConnections, params.roofHeight) : null;
    const roofConfig = {
      roofDirection: volume.ridgeAxis,
      roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(volume.ridgeAxis),
      roofHeight: extendedRoofHeight ?? (gableMerge?.any ? gableMerge.roofHeight : params.roofHeight),
      overhang: setup.overhang,
      eaves: setup.eaves,
      roofPitchRise: params.pitchRise,
      roofPitchRun: params.pitchRun,
      ridgeEndpoints: gableMerge?.any
        ? gableMerge.endpoints
        : (roofType !== 'gable' && params.mode === 'height' ? ridgeEndpoints.get(volume.id) : undefined),
      mergedEnds: gableMerge?.mergedEnds,
      connections: volumeConnections,
    };
    const chunk = roofType === 'flat'
      ? createFlatRoofGeometry(bounds, setup.overhang)
      : roofType === 'gable'
        ? createGableRoofGeometry(bounds, roofConfig)
        : roofType === 'hip'
          ? createHipRoofGeometry(bounds, roofConfig)
          : createShedRoofGeometry(bounds, roofConfig);
    return clipInsideNeighbor(chunk, volumeConnections);
  });
  return mergeFlatGeometries(chunks);
}

function applyVolumeRidgeDirections(volumes, directions) {
  return volumes.map((volume) => {
    const highEdge = directions[volume.id];
    if (!highEdge) {
      return volume;
    }
    return {
      ...volume,
      ridgeAxis: roofAxisForDirection(highEdge),
      roofHighEdge: highEdge.length > 1 ? highEdge : defaultHighEdgeForAxis(highEdge),
      ridgeDirectionOverride: true,
    };
  });
}

function resolveGableRidgeDirections(volumes) {
  const primary = volumes.reduce((largest, volume) => {
    const area = (volume.maxX - volume.minX) * (volume.maxZ - volume.minZ);
    const largestArea = (largest.maxX - largest.minX) * (largest.maxZ - largest.minZ);
    return area > largestArea ? volume : largest;
  }, volumes[0]);
  const epsilon = 1e-6;

  return volumes.map((volume) => {
    if (volume.id === primary.id || volume.ridgeDirectionOverride || volume.ridgeAxis !== primary.ridgeAxis) {
      return volume;
    }
    const sharesHorizontalBoundary = (Math.abs(volume.maxZ - primary.minZ) < epsilon
      || Math.abs(volume.minZ - primary.maxZ) < epsilon)
      && Math.min(volume.maxX, primary.maxX) - Math.max(volume.minX, primary.minX) > epsilon;
    const sharesVerticalBoundary = (Math.abs(volume.maxX - primary.minX) < epsilon
      || Math.abs(volume.minX - primary.maxX) < epsilon)
      && Math.min(volume.maxZ, primary.maxZ) - Math.max(volume.minZ, primary.minZ) > epsilon;
    if (!sharesHorizontalBoundary && !sharesVerticalBoundary) {
      return volume;
    }
    return { ...volume, ridgeAxis: primary.ridgeAxis === 'x' ? 'z' : 'x' };
  });
}

const MERGE_HEIGHT_EPSILON = 0.02;

function makeEavePlane(bounds, side, slope) {
  const axis = side === 'minX' || side === 'maxX' ? 'x' : 'z';
  const sign = side === 'minX' || side === 'minZ' ? 1 : -1;
  return { side, axis, sign, constant: bounds[side], slope };
}

function evalPlaneHeight(plane, x, z) {
  if ('constantHeight' in plane) {
    return plane.constantHeight;
  }
  const coord = plane.axis === 'x' ? x : z;
  return (plane.offset ?? 0) + plane.slope * plane.sign * (coord - plane.constant);
}

export function evalZoneHeight(planes, x, z) {
  if (!planes || planes.length === 0) {
    return 0;
  }
  return Math.min(...planes.map((plane) => evalPlaneHeight(plane, x, z)));
}

/**
 * Derives the infinite sloped "eave planes" that define a roof zone's own
 * surface height at any point in its rectangle, so a neighboring zone can
 * ask "how tall is your roof here" without needing that zone's finished
 * mesh. A zone's height at a point is the min across its own planes: for
 * hip, min-of-4-sides is exactly the classic hip profile (cross-slope
 * capped by the end-triangle slope); for gable, min-of-2-eave-sides gives
 * the ridge with flat gable ends; for shed, a single plane spans the whole
 * rectangle from its one low eave. Mirrors the exact height formulas
 * createGableRoofGeometry/createHipRoofGeometry/createShedRoofGeometry use,
 * so a neighbor's plane always agrees with what that neighbor actually
 * renders.
 */
export function computeVolumeEavePlanes(bounds, roofType, config) {
  const roofHeight = config.roofHeight ?? 0;
  if (roofType === 'flat' || !(roofHeight > 0)) {
    return [];
  }

  if (roofType === 'hip') {
    const pitchRatio = (config.roofPitchRise ?? 0) / (config.roofPitchRun ?? 12);
    return ['minX', 'maxX', 'minZ', 'maxZ'].map((side) => makeEavePlane(bounds, side, pitchRatio));
  }

  const ridgeAxis = config.roofDirection === 'x' ? 'x' : 'z';

  if (roofType === 'gable') {
    const halfSpan = ridgeAxis === 'x' ? (bounds.maxZ - bounds.minZ) / 2 : (bounds.maxX - bounds.minX) / 2;
    const slope = halfSpan > 0 ? roofHeight / halfSpan : 0;
    const sides = ridgeAxis === 'x' ? ['minZ', 'maxZ'] : ['minX', 'maxX'];
    return sides.map((side) => makeEavePlane(bounds, side, slope));
  }

  if (roofType === 'shed') {
    const highEdge = config.roofHighEdge ?? defaultHighEdgeForAxis(ridgeAxis);
    const lowSide = { 'x-min': 'maxX', 'x-max': 'minX', 'z-min': 'maxZ', 'z-max': 'minZ' }[highEdge];
    const span = lowSide === 'minX' || lowSide === 'maxX' ? bounds.maxX - bounds.minX : bounds.maxZ - bounds.minZ;
    const slope = span > 0 ? roofHeight / span : 0;
    return [makeEavePlane(bounds, lowSide, slope)];
  }

  return [];
}

function sideCorners(bounds, side) {
  if (side === 'minX' || side === 'maxX') {
    return [[bounds[side], bounds.minZ], [bounds[side], bounds.maxZ]];
  }
  return [[bounds.minX, bounds[side]], [bounds.maxX, bounds[side]]];
}

/**
 * A shed whose plane slopes *along* the shared wall (its high edge is on a
 * side, so the wall is one of its rakes) meets the neighbor's eave-side roof
 * plane along a straight valley. Where the shed's roof is above the
 * neighbor's eave (`gap` above this roof's plate) it keeps its own plane and
 * runs on into the neighbor as a triangle whose far edge is that valley; the
 * part below the neighbor's eave just butts its wall, as a standalone roof.
 * If the shed would rise above the neighbor's ridge, the whole plane is
 * lowered (staying planar) so its high corner lands on the ridge.
 */
function resolveShedRakeMerge(own, neighbor, side, gap, ridgePlanes) {
  const mergeAxis = side === 'minX' || side === 'maxX' ? 'x' : 'z';
  const ownPlane = own.planes[0];
  const planeAxis = ownPlane.axis;
  const wallCoord = own.bounds[side];
  const facingPlane = ridgePlanes.reduce((best, plane) => (
    Math.abs(plane.constant - wallCoord) < Math.abs(best.constant - wallCoord) ? plane : best
  ));
  const ridgeCoord = (ridgePlanes[0].constant + ridgePlanes[1].constant) / 2;
  const direction = Math.sign(ridgeCoord - wallCoord);
  const lowKey = planeAxis === 'x' ? ['minX', 'maxX'] : ['minZ', 'maxZ'];
  const aLow = ownPlane.constant;
  const aHigh = Math.abs(own.bounds[lowKey[0]] - aLow) < Math.abs(own.bounds[lowKey[1]] - aLow)
    ? own.bounds[lowKey[1]]
    : own.bounds[lowKey[0]];
  const span = Math.abs(aHigh - aLow);
  const cap = neighbor.ridgeHeight + gap;
  const peak = Math.min(own.ridgeHeight, cap);
  if (span <= MERGE_HEIGHT_EPSILON || facingPlane.slope <= 1e-9 || peak <= gap + MERGE_HEIGHT_EPSILON) {
    return null;
  }
  const crossing = aLow + (aHigh - aLow) * (gap / peak);
  const reach = (peak - gap) / facingPlane.slope;
  const point = (a, along, height) => (mergeAxis === 'z' ? [a, height, along] : [along, height, a]);
  return {
    mode: 'merged',
    suppressClosure: true,
    override: true,
    height: peak,
    plateGap: gap,
    clip: { axis: mergeAxis, wall: wallCoord, direction, gap },
    rakeTriangle: [
      point(crossing, wallCoord, gap),
      point(aHigh, wallCoord, peak),
      point(aHigh, wallCoord + direction * reach, peak),
    ],
    neighborPlanes: [],
  };
}

/**
 * A gable meets a neighbor at one of its two gable ends (the sides across its
 * ridge). If the neighbor has a rising roof plane facing that end (a gable or
 * hip whose eave is on the shared wall), the gable's ridge keeps running into
 * it: at the ridge height the gable's own slopes meet the neighbor's plane
 * along valley lines (`kind: 'intersect'`, ridge ends where its height meets
 * that plane), and if the gable's ridge is higher than the neighbor's ridge it
 * instead snaps up to the neighbor's ridge point (`kind: 'snap'`).
 */
function resolveGableEndMerge(own, neighbor, side, gap = 0) {
  const sideAxis = side === 'minX' || side === 'maxX' ? 'x' : 'z';
  if (own.ridgeAxis !== sideAxis || own.ridgeHeight <= MERGE_HEIGHT_EPSILON + gap
    || neighbor.ridgeHeight <= MERGE_HEIGHT_EPSILON) {
    return null;
  }
  const ridgePlanes = neighbor.planes.filter((plane) => plane.axis === sideAxis);
  if (ridgePlanes.length !== 2) {
    return null;
  }
  const wallCoord = own.bounds[side];
  const facingPlane = ridgePlanes.reduce((best, plane) => (
    Math.abs(plane.constant - wallCoord) < Math.abs(best.constant - wallCoord) ? plane : best
  ));
  const ridgeCoord = (ridgePlanes[0].constant + ridgePlanes[1].constant) / 2;
  const direction = Math.sign(ridgeCoord - wallCoord);
  const runToRidge = Math.abs(ridgeCoord - wallCoord);
  if (facingPlane.slope <= 1e-9 || runToRidge <= MERGE_HEIGHT_EPSILON) {
    return null;
  }
  const end = side === 'minX' || side === 'minZ' ? 'start' : 'end';
  const intersects = own.ridgeHeight <= neighbor.ridgeHeight + gap + 1e-9;
  const height = intersects ? own.ridgeHeight : neighbor.ridgeHeight + gap;
  return {
    mode: 'merged',
    gableEnd: end,
    kind: intersects ? 'intersect' : 'snap',
    suppressClosure: true,
    clip: { axis: sideAxis, wall: wallCoord, direction, gap },
    along: wallCoord + direction * ((height - gap) / facingPlane.slope),
    height,
    plateGap: gap,
    ridgeCap: neighbor.ridgeHeight + gap,
    wallCoord,
    direction,
    facingSlope: facingPlane.slope,
    neighborPlanes: [],
  };
}

/**
 * Ridge endpoints / merged-end flags for a gable whose ends were merged (see
 * resolveGableEndMerge), in the shape createGableRoofGeometry expects.
 */
function gableMergeGeometry(volume, bounds, connections, ridgeHeight) {
  const merges = Object.values(connections ?? {}).filter((resolution) => resolution.gableEnd);
  // A gable's roof faces stay planar only if its ridge is level, so the whole
  // ridge is capped at the lowest neighbor ridge it joins (its configured
  // height is ignored where it would project above); each end then runs to
  // where that level ridge meets the neighbor's plane.
  const height = merges.reduce((lowest, resolution) => Math.min(lowest, resolution.ridgeCap), ridgeHeight);
  const endpoints = {};
  const mergedEnds = {};
  merges.forEach((resolution) => {
    mergedEnds[resolution.gableEnd] = true;
    const cross = volume.ridgeAxis === 'x'
      ? (bounds.minZ + bounds.maxZ) / 2
      : (bounds.minX + bounds.maxX) / 2;
    const along = resolution.wallCoord + resolution.direction * ((height - resolution.plateGap) / resolution.facingSlope);
    endpoints[resolution.gableEnd] = volume.ridgeAxis === 'x'
      ? [along, cross, height]
      : [cross, along, height];
  });
  return { endpoints, mergedEnds, roofHeight: height, any: merges.length > 0 };
}

/**
 * Decides, per volume and per rectangle side, whether that side's roof edge
 * should merge into an adjacent volume's roof, or stay a standalone,
 * independently closed edge. Merging is an optimization, not a requirement:
 * a side is only considered when its own roof is genuinely sloped there
 * (something to merge). Merging is opt-in: nothing merges unless
 * `config.volumeRoofConnections[volumeId] === 'merge-plane'` for that volume
 * (the sidebar's "Merge into adjacent roof" option — the UI defaults every
 * side to 'standalone' the moment it becomes selectable, so a side only
 * merges on a deliberate choice). Once opted in, a side tries two things in
 * order, matching ARCHITECTURE.md's two connection semantics — this is a
 * single unified "merge" behavior, not two separately selectable modes:
 *
 * 1. **Coplanar plane merge.** If the neighbor's own roof surface is
 *    genuinely sloped along the whole shared wall too (e.g. a gable's end
 *    face) — the two surfaces are already at the same height at every point
 *    on that wall, so the shed's plane can just clamp to the neighbor's own
 *    plane (never projecting above it) with no gap: the closure face on that
 *    side is dropped, since the neighbor's own surface picks up right where
 *    it left off.
 * 2. **Ridge snap.** Otherwise (the common case: the shared wall is the
 *    neighbor's flat eave, with its actual ridge set back further away) —
 *    if the neighbor has a real ridge at all, treat that ridge and our own
 *    far/low eave as the two ends of one continuous span, and rebuild our
 *    plane through both, so extending it back through the wall lands
 *    exactly on the neighbor's ridge point (not just its height). Because
 *    the neighbor's own surface does *not* reach this height at the wall
 *    (it's still down at its own eave there), this is a real vertical rise
 *    that needs a physical closing face — like a real building's knee wall
 *    closing the gap between a lean-to's low wall and where its roof ties
 *    into the taller structure above — so unlike case 1, the closure face
 *    on that side is kept, just built to the new, taller derived height.
 *
 * If neither applies (no ridge, or too short a combined span) the side
 * stays standalone.
 *
 * @param {Array<object>} volumes - directed volumes (ridgeAxis/roofHighEdge already resolved)
 * @param {object} config - same config passed to createVolumeRoofAssembly
 * @returns {Map<string, Record<string, { mode: 'merged', neighborPlanes: Array<object>, override?: boolean, suppressClosure?: boolean }>>}
 */
export function resolveRoofConnections(volumes, config) {
  const planesByVolumeId = new Map(volumes.map((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
    const bounds = { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };
    const params = volumeRoofParams(volume.id, halfSpanForBounds(bounds, volume.ridgeAxis), config);
    const roofHeight = roofType === 'flat' ? 0 : params.roofHeight;
    const planeConfig = {
      roofDirection: volume.ridgeAxis,
      roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(volume.ridgeAxis),
      roofHeight,
      roofPitchRise: params.pitchRise,
      roofPitchRun: params.pitchRun,
    };
    return [volume.id, {
      bounds,
      roofType,
      ridgeAxis: volume.ridgeAxis,
      ridgeHeight: roofHeight,
      planes: computeVolumeEavePlanes(bounds, roofType, planeConfig),
    }];
  }));

  const resolutions = new Map(volumes.map((volume) => [volume.id, {}]));

  findVolumeAdjacencies(volumes).forEach(({ volumeAId, sideA, volumeBId, sideB }) => {
    [[volumeAId, sideA, volumeBId], [volumeBId, sideB, volumeAId]].forEach(([ownId, side, neighborId]) => {
      // Merging is opt-in: a side stays standalone unless the user explicitly
      // chose "Merge into adjacent roof" for it (the UI defaults every side
      // to 'standalone' the first time it becomes selectable, so this only
      // engages on a deliberate choice, matching a standalone shell being an
      // equally valid, unforced outcome).
      if (config.volumeRoofConnections?.[ownId] !== 'merge-plane') {
        return;
      }
      // Independent story counts put the two roofs on different plates. A
      // roof only interacts with a *taller* neighbor, and only once it rises
      // above that neighbor's eave (`plateGap` up): below that it just butts
      // against the neighbor's wall and stays standalone. A taller roof never
      // reaches a lower neighbor's roof at all.
      const plates = config.volumePlateHeights;
      const plateGap = plates ? (plates[neighborId] ?? 0) - (plates[ownId] ?? 0) : 0;
      if (plateGap < -1e-6) {
        return;
      }
      const own = planesByVolumeId.get(ownId);
      const neighbor = planesByVolumeId.get(neighborId);
      if (own.roofType === 'gable') {
        const resolution = resolveGableEndMerge(own, neighbor, side, Math.max(0, plateGap));
        if (resolution) {
          resolutions.get(ownId)[side] = resolution;
        }
        return;
      }
      const corners = sideCorners(own.bounds, side);
      const ownHeights = corners.map(([x, z]) => evalZoneHeight(own.planes, x, z));
      if (Math.max(...ownHeights) <= MERGE_HEIGHT_EPSILON + Math.max(0, plateGap)) {
        return;
      }
      const gap = Math.max(0, plateGap);

      // 1. Coplanar plane merge: the neighbor is genuinely sloped along the
      // whole shared wall (e.g. a gable end face).
      const neighborHeights = corners.map(([x, z]) => evalZoneHeight(neighbor.planes, x, z));
      if (Math.min(...neighborHeights) > MERGE_HEIGHT_EPSILON) {
        resolutions.get(ownId)[side] = {
          mode: 'merged',
          neighborPlanes: gap > 0 ? neighbor.planes.map((plane) => ({ ...plane, offset: (plane.offset ?? 0) + gap })) : neighbor.planes,
          suppressClosure: true,
        };
        return;
      }

      // 2. Ridge snap fallback: the shared wall is the neighbor's flat eave,
      // but it has a real ridge set back further in that carries a genuine
      // height worth reaching up to.
      if (neighbor.ridgeHeight <= MERGE_HEIGHT_EPSILON) {
        return;
      }
      const mergeAxis = side === 'minX' || side === 'maxX' ? 'x' : 'z';
      const neighborRidgePlanes = neighbor.planes.filter((plane) => plane.axis === mergeAxis);
      const ownSpanPlanes = own.planes.filter((plane) => plane.axis === mergeAxis);
      if (neighborRidgePlanes.length === 2 && ownSpanPlanes.length === 1) {
        const ridgeCoord = (neighborRidgePlanes[0].constant + neighborRidgePlanes[1].constant) / 2;
        const ownPlane = ownSpanPlanes[0];

        // 2a. Keep the shed's own configured slope and let it run on into the
        // neighbor until it meets the neighbor's rising roof plane. When that
        // crossing lands at or below the ridge, that is the merge: the shed
        // keeps its pitch and its roof simply ends where it intersects the
        // neighbor's plane (a valley-style join), with nothing left to close.
        const wallCoord = own.bounds[side];
        const facingPlane = neighborRidgePlanes.reduce((best, plane) => (
          Math.abs(plane.constant - wallCoord) < Math.abs(best.constant - wallCoord) ? plane : best
        ));
        const wallHeight = ownPlane.slope * ownPlane.sign * (wallCoord - ownPlane.constant);
        const slopeGap = facingPlane.slope - ownPlane.slope;
        const runToRidge = Math.abs(ridgeCoord - wallCoord);
        // Heights above are on this roof's own plate; the neighbor's eave sits
        // `gap` above it, so only the part above that competes with its roof.
        if (wallHeight - gap > MERGE_HEIGHT_EPSILON && slopeGap > 1e-9) {
          const run = (wallHeight - gap) / slopeGap;
          if (run <= runToRidge) {
            const extendTo = wallCoord + Math.sign(ridgeCoord - wallCoord) * run;
            resolutions.get(ownId)[side] = {
              mode: 'merged',
              override: true,
              suppressClosure: true,
              clip: { axis: mergeAxis, wall: wallCoord, direction: Math.sign(ridgeCoord - wallCoord), gap },
              intersectsPlane: true,
              extendTo,
              height: wallHeight + ownPlane.slope * run,
              neighborPlanes: [{ ...ownPlane }],
            };
            return;
          }
        }

        // 2b. The shed's own slope would still be above the neighbor's plane
        // when it reaches the ridge, i.e. it would project above the ridge:
        // snap to the ridge instead, with a plane rebuilt through the ridge
        // point and the shed's own far eave.
        const combinedSpan = Math.abs(ownPlane.constant - ridgeCoord);
        if (combinedSpan > MERGE_HEIGHT_EPSILON && wallHeight > gap + MERGE_HEIGHT_EPSILON) {
          // This is not just a height clamp at the existing wall: the roof's
          // own boundary is physically relocated from the wall out to the
          // neighbor's actual ridge coordinate (`extendTo`), the way a real
          // saltbox's rear slope is one continuous surface running from the
          // ridge, over the wall, to its own low eave — so there is no edge
          // left at the old wall to close at all (the "high edge" now *is*
          // the ridge, same as any roof's ridge needs no vertical closure).
          // The extended surface passes directly over the neighbor's own
          // rear-facing portion (hidden beneath it, since a plane through
          // the same ridge point with a shallower slope — reaching all the
          // way to this shed's own far eave instead of just the neighbor's
          // near eave — is always higher there), so nothing needs clipping.
          resolutions.get(ownId)[side] = {
            mode: 'merged',
            override: true,
            suppressClosure: true,
            clip: { axis: mergeAxis, wall: wallCoord, direction: Math.sign(ridgeCoord - wallCoord), gap },
            extendTo: ridgeCoord,
            height: neighbor.ridgeHeight + gap,
            neighborPlanes: [{
              axis: ownPlane.axis, sign: ownPlane.sign, constant: ownPlane.constant,
              slope: (neighbor.ridgeHeight + gap) / combinedSpan,
            }],
          };
        }
        return;
      }
      // A shed whose slope runs along the shared wall (its rake meets the
      // neighbor) merges through a triangle of extra roof instead.
      if (neighborRidgePlanes.length === 2 && ownSpanPlanes.length === 0 && own.planes.length === 1) {
        const resolution = resolveShedRakeMerge(own, neighbor, side, gap, neighborRidgePlanes);
        if (resolution) {
          resolutions.get(ownId)[side] = resolution;
        }
        return;
      }
      // Fallback for shapes without a clean single ridge line on this axis
      // (e.g. a flat or shed neighbor): just target its own peak height.
      resolutions.get(ownId)[side] = {
        mode: 'merged', override: true, suppressClosure: false, neighborPlanes: [{ constantHeight: neighbor.ridgeHeight + gap }],
      };
    });
  });

  return resolutions;
}

/**
 * Roof surface that a merge carries into the taller neighbor lies inside that
 * neighbor's walls below its eave (`gap` above this roof's plate), where it is
 * hidden at best and z-fights with the wall where the faces are coplanar (a
 * flush outer wall). Cut it away: drop everything past the shared wall
 * (`axis`/`wall`/`direction`) that is lower than `gap`.
 */
function clipInsideNeighbor(geometry, connections) {
  const clips = Object.values(connections ?? {}).map((resolution) => resolution.clip).filter(Boolean);
  if (clips.length === 0 || clips.every((clip) => clip.gap <= MERGE_HEIGHT_EPSILON)) {
    return geometry;
  }
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index ? index.count : position.count;
  let polygons = [];
  for (let i = 0; i < count; i += 3) {
    polygons.push([0, 1, 2].map((k) => {
      const v = index ? index.getX(i + k) : i + k;
      return [position.getX(v), position.getY(v), position.getZ(v)];
    }));
  }
  clips.forEach(({ axis, wall, direction, gap }) => {
    const beyond = (v) => direction * ((axis === 'x' ? v[0] : v[2]) - wall);
    polygons = polygons.flatMap((polygon) => {
      const near = clipPolygon(polygon, (v) => -beyond(v));
      const far = clipPolygon(clipPolygon(polygon, beyond), (v) => v[1] - gap);
      return [near, far].filter((poly) => poly.length >= 3);
    });
  });
  const positions = [];
  polygons.forEach((polygon) => {
    for (let k = 1; k < polygon.length - 1; k += 1) {
      [polygon[0], polygon[k], polygon[k + 1]].forEach((v) => positions.push(...v));
    }
  });
  const clipped = new THREE.BufferGeometry();
  clipped.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  clipped.computeVertexNormals();
  return clipped;
}

// Sutherland-Hodgman against the half-space where distance(v) >= 0.
function clipPolygon(polygon, distance) {
  const out = [];
  polygon.forEach((current, i) => {
    const previous = polygon[(i + polygon.length - 1) % polygon.length];
    const dCurrent = distance(current);
    const dPrevious = distance(previous);
    if ((dCurrent >= 0) !== (dPrevious >= 0)) {
      const t = dPrevious / (dPrevious - dCurrent);
      out.push(previous.map((value, k) => value + (current[k] - value) * t));
    }
    if (dCurrent >= 0) {
      out.push(current);
    }
  });
  return out;
}

function mergeFlatGeometries(geometries) {
  const positions = [];
  geometries.forEach((geometry) => {
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    if (index) {
      for (let i = 0; i < index.count; i += 1) {
        const vertexIndex = index.getX(i);
        positions.push(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));
      }
    } else {
      for (let i = 0; i < position.count; i += 1) {
        positions.push(position.getX(i), position.getY(i), position.getZ(i));
      }
    }
  });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.computeVertexNormals();
  return merged;
}

/**
 * Build a roof surface for an arbitrary rectilinear footprint using the
 * perpendicular distance to the nearest qualifying exterior wall edge as the
 * height field. This is a straight-skeleton approximation that is exact for
 * axis-aligned polygons: it produces correctly seamed hips at convex corners
 * and valleys at concave (re-entrant) corners automatically, because the
 * ridge/valley line is simply where two edges are equidistant.
 *
 * Note: this generates a single roof spanning the whole footprint. Wings or
 * additions that need an independent roof height (e.g. a one-story lean-to
 * under a two-story main roof) require separate massing volumes, which is a
 * distinct planned step (see Task 9 in IMPLEMENTATION_PLAN.md).
 */
function createRoofFieldSurface(footprint, config) {
  const edges = config.roofHeightMode === 'height' && config.volumes?.length > 1
    ? buildFixedRiseRoofEdges(footprint, config.volumes, config.roofHeight ?? 2)
    : classifyFootprintEdges(footprint);
  const xs = buildRoofGridLines(footprint.map(([x]) => x));
  const zs = buildRoofGridLines(footprint.map(([, z]) => z));
  const rawHeights = [];
  let maximumDistance = 0;

  for (let zi = 0; zi < zs.length; zi += 1) {
    const row = [];
    for (let xi = 0; xi < xs.length; xi += 1) {
      const x = xs[xi];
      const z = zs[zi];
      const distance = isPointCoveredByFootprint(x, z, footprint, edges)
        ? roofFieldHeightAt(x, z, edges, config.roofType, config.roofDirection, 1)
        : null;
      if (distance !== null) {
        maximumDistance = Math.max(maximumDistance, distance);
      }
      row.push(distance);
    }
    rawHeights.push(row);
  }

  const pitchRatio = config.roofHeightMode === 'height'
    ? 1
    : (config.roofPitchRise ?? 6) / (config.roofPitchRun ?? 12);

  const indexGrid = [];
  const positions = [];
  for (let zi = 0; zi < zs.length; zi += 1) {
    const row = [];
    for (let xi = 0; xi < xs.length; xi += 1) {
      const x = xs[xi];
      const z = zs[zi];
      const distance = rawHeights[zi][xi];
      if (distance !== null) {
        const height = distance * pitchRatio;
        row.push(positions.length / 3);
        positions.push(x, height, z);
      } else {
        row.push(-1);
      }
    }
    indexGrid.push(row);
  }

  const indices = [];
  for (let zi = 0; zi < zs.length - 1; zi += 1) {
    for (let xi = 0; xi < xs.length - 1; xi += 1) {
      const a = indexGrid[zi][xi];
      const b = indexGrid[zi][xi + 1];
      const c = indexGrid[zi + 1][xi];
      const d = indexGrid[zi + 1][xi + 1];
      if (a >= 0 && b >= 0 && c >= 0 && d >= 0) {
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildRoofGridLines(values, subdivisionsPerSegment = 14) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length < 2) {
    return sorted;
  }
  const lines = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    for (let s = 0; s < subdivisionsPerSegment; s += 1) {
      lines.push(a + ((b - a) * s) / subdivisionsPerSegment);
    }
  }
  lines.push(sorted[sorted.length - 1]);
  return lines;
}

function classifyFootprintEdges(footprint) {
  return footprint.map(([x, z], index) => {
    const [ex, ez] = footprint[(index + 1) % footprint.length];
    let orientation = null;
    if (Math.abs(x - ex) < 1e-6) {
      orientation = 'vertical';
    } else if (Math.abs(z - ez) < 1e-6) {
      orientation = 'horizontal';
    }
    return { start: [x, z], end: [ex, ez], orientation };
  });
}

function buildFixedRiseRoofEdges(footprint, volumes, roofHeight) {
  const epsilon = 1e-4;
  return classifyFootprintEdges(footprint).map((edge) => {
    const midpointX = (edge.start[0] + edge.end[0]) / 2;
    const midpointZ = (edge.start[1] + edge.end[1]) / 2;
    const owner = volumes.find((volume) => {
      if (edge.orientation === 'horizontal') {
        return midpointX >= volume.minX - epsilon
          && midpointX <= volume.maxX + epsilon
          && (Math.abs(midpointZ - volume.minZ) < epsilon || Math.abs(midpointZ - volume.maxZ) < epsilon);
      }
      return midpointZ >= volume.minZ - epsilon
        && midpointZ <= volume.maxZ + epsilon
        && (Math.abs(midpointX - volume.minX) < epsilon || Math.abs(midpointX - volume.maxX) < epsilon);
    });
    if (!owner) {
      return edge;
    }
    const bounds = { minX: owner.minX, maxX: owner.maxX, minZ: owner.minZ, maxZ: owner.maxZ };
    return {
      ...edge,
      slope: roofHeight / halfSpanForBounds(bounds, owner.ridgeAxis),
    };
  });
}

function buildConnectedConstantRiseRidges(volumes, extendSpanningRidge, ridgeHeights = new Map()) {
  const endpoints = new Map();
  const epsilon = 1e-6;

  volumes.forEach((spanning) => {
    if (spanning.ridgeAxis !== 'x') {
      return;
    }
    const centerZ = (spanning.minZ + spanning.maxZ) / 2;
    const attached = volumes.filter((side) => side.ridgeAxis === 'z'
      && side.id !== spanning.id
      && side.minX >= spanning.minX - epsilon
      && side.maxX <= spanning.maxX + epsilon
      && (Math.abs(side.minZ - spanning.maxZ) < epsilon || Math.abs(side.maxZ - spanning.minZ) < epsilon));
    if (attached.length === 0) {
      return;
    }

    const spanningEnds = {
      start: [spanning.minX + halfSpanForBounds(spanning, 'x'), centerZ, ridgeHeights.get(spanning.id)],
      end: [spanning.maxX - halfSpanForBounds(spanning, 'x'), centerZ, ridgeHeights.get(spanning.id)],
    };
    attached.forEach((side) => {
      const centerX = (side.minX + side.maxX) / 2;
      if (extendSpanningRidge) {
        if (centerX < (spanning.minX + spanning.maxX) / 2) {
          spanningEnds.start = [centerX, centerZ, ridgeHeights.get(spanning.id)];
        } else {
          spanningEnds.end = [centerX, centerZ, ridgeHeights.get(spanning.id)];
        }
      }

      const sideEndpoints = endpoints.get(side.id) ?? {
        start: [(side.minX + side.maxX) / 2, extendSpanningRidge ? side.minZ + halfSpanForBounds(side, 'z') : side.minZ, ridgeHeights.get(side.id)],
        end: [(side.minX + side.maxX) / 2, extendSpanningRidge ? side.maxZ - halfSpanForBounds(side, 'z') : side.maxZ, ridgeHeights.get(side.id)],
      };
      if (Math.abs(side.minZ - spanning.maxZ) < epsilon) {
        sideEndpoints.start = [centerX, centerZ, ridgeHeights.get(spanning.id)];
      } else {
        sideEndpoints.end = [centerX, centerZ, ridgeHeights.get(spanning.id)];
      }
      endpoints.set(side.id, sideEndpoints);
    });
    if (extendSpanningRidge) {
      endpoints.set(spanning.id, spanningEnds);
    }
  });

  return endpoints;
}

function distancePointToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  let t = lengthSquared > 0 ? ((px - ax) * dx + (pz - az) * dz) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cz = az + t * dz;
  return Math.hypot(px - cx, pz - cz);
}

function roofFieldHeightAt(x, z, edges, roofType, roofDirection, pitchRatio) {
  let qualifying = edges;
  if (roofType === 'gable') {
    const wanted = roofDirection === 'x' ? 'horizontal' : 'vertical';
    const filtered = edges.filter((edge) => edge.orientation === wanted);
    if (filtered.length > 0) {
      qualifying = filtered;
    }
  }

  let minHeight = Infinity;
  qualifying.forEach((edge) => {
    const distance = distancePointToSegment(x, z, edge.start[0], edge.start[1], edge.end[0], edge.end[1]);
    const height = distance * (edge.slope ?? pitchRatio);
    if (height < minHeight) {
      minHeight = height;
    }
  });

  if (!Number.isFinite(minHeight)) {
    minHeight = 0;
  }
  return minHeight;
}

function isPointInPolygon(x, z, footprint) {
  let inside = false;
  for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i, i += 1) {
    const [xi, zi] = footprint[i];
    const [xj, zj] = footprint[j];
    const intersect = ((zi > z) !== (zj > z))
      && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi);
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
}

function isPointCoveredByFootprint(x, z, footprint, edges) {
  if (isPointInPolygon(x, z, footprint)) {
    return true;
  }
  return edges.some((edge) => distancePointToSegment(x, z, edge.start[0], edge.start[1], edge.end[0], edge.end[1]) < 1e-6);
}

function createFlatRoofGeometry(bounds, overhang) {
  const ov = typeof overhang === 'number'
    ? { minX: overhang, maxX: overhang, minZ: overhang, maxZ: overhang }
    : { minX: 0, maxX: 0, minZ: 0, maxZ: 0, ...overhang };
  const shape = new THREE.Shape();
  const minX = bounds.minX - ov.minX;
  const maxX = bounds.maxX + ov.maxX;
  const minZ = bounds.minZ - ov.minZ;
  const maxZ = bounds.maxZ + ov.maxZ;
  shape.moveTo(minX, -minZ);
  shape.lineTo(maxX, -minZ);
  shape.lineTo(maxX, -maxZ);
  shape.lineTo(minX, -maxZ);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.08,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 1,
  });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function getRectangularBounds(footprint) {
  if (footprint.length !== 4) {
    return null;
  }

  const xValues = [...new Set(footprint.map(([x]) => x))];
  const zValues = [...new Set(footprint.map(([, z]) => z))];
  if (xValues.length !== 2 || zValues.length !== 2) {
    return null;
  }

  return {
    minX: Math.min(...xValues),
    maxX: Math.max(...xValues),
    minZ: Math.min(...zValues),
    maxZ: Math.max(...zValues),
  };
}

const EAVE_CONFIG_KEYS = ['roofEaveDepth', 'roofRakeDepth', 'eaveSoffit', 'rakeSoffit', 'roofFasciaDepth', 'volumeEaves'];

function pickEaveConfig(config) {
  return Object.fromEntries(EAVE_CONFIG_KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
}

/** Sides of each volume that touch another volume (no overhang there). */
function adjacentSidesByVolume(volumes) {
  const sides = new Map(volumes.map((volume) => [volume.id, new Set()]));
  findVolumeAdjacencies(volumes).forEach((adjacency) => {
    sides.get(adjacency.volumeAId)?.add(adjacency.sideA);
    sides.get(adjacency.volumeBId)?.add(adjacency.sideB);
  });
  return sides;
}

/**
 * Overhang and eave settings for one volume's roof. Shared walls and merged
 * sides never overhang.
 */
function volumeEaveSetup(volumeId, roofType, orientation, config, zeroSides) {
  const eaves = resolveVolumeEaves(volumeId, config);
  const { overhang } = sideOverhangs(roofType, orientation, eaves, zeroSides ?? new Set());
  return { overhang, eaves };
}

/** Per-side overhang from `config.overhang`, or a uniform scalar `roofOverhang`. */
function overhangOf(config) {
  if (config.overhang) {
    return { minX: 0, maxX: 0, minZ: 0, maxZ: 0, ...config.overhang };
  }
  const o = config.roofOverhang ?? 0;
  return { minX: o, maxX: o, minZ: o, maxZ: o };
}

function appendTriangles(positions, indices, triangles) {
  triangles.forEach((triangle) => {
    const first = positions.length / 3;
    triangle.forEach((vertex) => positions.push(...vertex));
    indices.push(first, first + 1, first + 2);
  });
}

function createGableRoofGeometry(bounds, config) {
  const ov = overhangOf(config);
  const axis = config.roofDirection === 'x' ? 'x' : 'z';
  const [cMin, cMax] = axis === 'x' ? [bounds.minZ, bounds.maxZ] : [bounds.minX, bounds.maxX];
  const [aMin, aMax] = axis === 'x' ? [bounds.minX, bounds.maxX] : [bounds.minZ, bounds.maxZ];
  const [eMin, eMax] = axis === 'x' ? [ov.minZ, ov.maxZ] : [ov.minX, ov.maxX];
  const [rStart, rEnd] = axis === 'x' ? [ov.minX, ov.maxX] : [ov.minZ, ov.maxZ];
  const centerCross = (cMin + cMax) / 2;
  const peakY = config.roofHeight;
  const halfSpan = (cMax - cMin) / 2;
  // The slopes keep their pitch past the wall, so an eave edge sits below the plate.
  const slope = halfSpan > 1e-9 ? peakY / halfSpan : 0;
  const yLow = -slope * eMin;
  const yHigh = -slope * eMax;
  const aStart = aMin - rStart;
  const aEnd = aMax + rEnd;
  const W = axis === 'x' ? (c, a, y) => [a, y, c] : (c, a, y) => [c, y, a];
  const ridgeEndpoints = config.ridgeEndpoints;
  const startPeakY = ridgeEndpoints?.start?.[2] ?? peakY;
  const endPeakY = ridgeEndpoints?.end?.[2] ?? peakY;
  const corners = axis === 'x'
    ? [W(cMin - eMin, aStart, yLow), W(cMin - eMin, aEnd, yLow), W(cMax + eMax, aEnd, yHigh), W(cMax + eMax, aStart, yHigh)]
    : [W(cMin - eMin, aStart, yLow), W(cMax + eMax, aStart, yHigh), W(cMax + eMax, aEnd, yHigh), W(cMin - eMin, aEnd, yLow)];
  const ridgeStart = ridgeEndpoints?.start
    ? [ridgeEndpoints.start[0], startPeakY, ridgeEndpoints.start[1]]
    : W(centerCross, aStart, peakY);
  const ridgeEnd = ridgeEndpoints?.end
    ? [ridgeEndpoints.end[0], endPeakY, ridgeEndpoints.end[1]]
    : W(centerCross, aEnd, peakY);
  const positions = [...corners, ridgeStart, ridgeEnd].flat();
  // gable end faces stay at the wall plane; only the slopes run out past them
  [W(cMin, aMin, 0), W(cMax, aMin, 0), W(centerCross, aMin, startPeakY),
    W(cMin, aMax, 0), W(cMax, aMax, 0), W(centerCross, aMax, endPeakY)].forEach((v) => positions.push(...v));
  const slopes = axis === 'x'
    ? [0, 1, 5, 0, 5, 4, 3, 4, 5, 3, 5, 2]
    : [0, 4, 5, 0, 5, 3, 1, 2, 5, 1, 5, 4];
  // A merged end has no gable-end face: the ridge runs on into the
  // neighbor's roof, so the two slopes simply continue to their valley lines.
  const indices = [
    ...slopes,
    ...(config.mergedEnds?.start ? [] : [6, 7, 8]),
    ...(config.mergedEnds?.end ? [] : [9, 10, 11]),
  ];
  if (config.eaves) {
    appendTriangles(positions, indices, buildGableTrim(bounds, {
      roofHeight: peakY, ridgeAxis: axis, overhang: ov, eaves: config.eaves,
    }));
  }
  return createIndexedGeometry(positions, indices);
}

export function createShedRoofGeometry(bounds, config) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const ov = overhangOf(config);
  const peakY = config.roofHeight;
  const requestedHighEdge = config.roofHighEdge ?? defaultHighEdgeForAxis(config.roofDirection);
  // anything that is not a recognised edge has always meant 'z-max' here
  const highEdge = ['x-min', 'x-max', 'z-min', 'z-max'].includes(requestedHighEdge) ? requestedHighEdge : 'z-max';
  const cornerDefs = highEdge === 'x-min'
    ? [
      { x: minX, z: minZ, height: peakY, sides: ['minX', 'minZ'] },
      { x: maxX, z: minZ, height: 0, sides: ['maxX', 'minZ'] },
      { x: maxX, z: maxZ, height: 0, sides: ['maxX', 'maxZ'] },
      { x: minX, z: maxZ, height: peakY, sides: ['minX', 'maxZ'] },
    ]
    : highEdge === 'x-max'
      ? [
        { x: minX, z: minZ, height: 0, sides: ['minX', 'minZ'] },
        { x: maxX, z: minZ, height: peakY, sides: ['maxX', 'minZ'] },
        { x: maxX, z: maxZ, height: peakY, sides: ['maxX', 'maxZ'] },
        { x: minX, z: maxZ, height: 0, sides: ['minX', 'maxZ'] },
      ]
      : highEdge === 'z-min'
        ? [
          { x: minX, z: minZ, height: peakY, sides: ['minX', 'minZ'] },
          { x: maxX, z: minZ, height: peakY, sides: ['maxX', 'minZ'] },
          { x: maxX, z: maxZ, height: 0, sides: ['maxX', 'maxZ'] },
          { x: minX, z: maxZ, height: 0, sides: ['minX', 'maxZ'] },
        ]
        : [
          { x: minX, z: minZ, height: 0, sides: ['minX', 'minZ'] },
          { x: maxX, z: minZ, height: 0, sides: ['maxX', 'minZ'] },
          { x: maxX, z: maxZ, height: peakY, sides: ['maxX', 'maxZ'] },
          { x: minX, z: maxZ, height: peakY, sides: ['minX', 'maxZ'] },
        ];

  // A side merges into a neighbor only when resolveRoofConnections found a
  // connection for it (see its docstring for the two cases). Every merged
  // side's corners get repositioned to the neighbor's height; only a truly
  // coplanar merge (the neighbor's own surface is already at that height
  // right there) also skips the vertical/triangular closure — a ridge-snap
  // connection is a real vertical rise with nothing behind it, so its
  // closure stays, just built to the new, taller height (like a knee wall
  // closing the gap between a lean-to's own wall and the taller roof it
  // ties into).
  const connections = config.connections ?? {};
  const mergedSides = new Set(
    Object.keys(connections).filter((side) => connections[side]?.mode === 'merged' && !connections[side]?.rakeTriangle)
  );
  const closureSuppressedSides = new Set(
    Object.keys(connections).filter((side) => connections[side]?.mode === 'merged' && connections[side]?.suppressClosure)
  );

  const corners = cornerDefs.map((corner) => {
    const mergingSides = corner.sides.filter((side) => mergedSides.has(side));
    if (mergingSides.length === 0 || corner.height <= 1e-8) {
      return corner;
    }
    // An `override` connection (snap-ridge) deterministically replaces this
    // corner's height with a plane derived to pass through the neighbor's
    // own ridge, rather than merely capping our own configured height.
    const overrideSide = mergingSides.find((side) => connections[side].override);
    if (overrideSide) {
      return { ...corner, height: evalZoneHeight(connections[overrideSide].neighborPlanes, corner.x, corner.z) };
    }
    const clampedHeight = mergingSides.reduce(
      (height, side) => Math.min(height, evalZoneHeight(connections[side].neighborPlanes, corner.x, corner.z)),
      corner.height
    );
    return { ...corner, height: clampedHeight };
  });

  const positions = corners.flatMap((corner) => [corner.x, corner.height, corner.z]);
  corners.forEach((corner) => positions.push(corner.x, 0, corner.z));

  // Top surface: the corner quad, or — with overhang — the same plane
  // continued out to the expanded outline (closures stay at the wall plane).
  let indices = [0, 1, 2, 0, 2, 3];
  if (Object.values(ov).some((value) => value > 1e-9)) {
    const planes = computeVolumeEavePlanes(bounds, 'shed', {
      roofHeight: peakY, roofHighEdge: highEdge, roofDirection: config.roofDirection,
    });
    const first = positions.length / 3;
    corners.forEach((corner) => {
      const dx = corner.sides.includes('minX') ? -ov.minX : ov.maxX;
      const dz = corner.sides.includes('minZ') ? -ov.minZ : ov.maxZ;
      const height = dx === 0 && dz === 0 ? corner.height : evalZoneHeight(planes, corner.x + dx, corner.z + dz);
      positions.push(corner.x + dx, height, corner.z + dz);
    });
    indices = [first, first + 1, first + 2, first, first + 2, first + 3];
  }
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    const edgeSide = cornerDefs[index].sides.find((side) => cornerDefs[next].sides.includes(side));
    if (closureSuppressedSides.has(edgeSide)) {
      continue;
    }
    const height = corners[index].height;
    const nextHeight = corners[next].height;
    if (height > 1e-8 && nextHeight > 1e-8) {
      indices.push(index, next, next + 4, index, next + 4, index + 4);
    } else if (height > 1e-8) {
      indices.push(index, next, index + 4);
    } else if (nextHeight > 1e-8) {
      indices.push(index, next, next + 4);
    }
  }
  Object.values(connections).forEach((resolution) => {
    if (resolution?.rakeTriangle) {
      const first = positions.length / 3;
      resolution.rakeTriangle.forEach((vertex) => positions.push(...vertex));
      indices.push(first, first + 1, first + 2);
    }
  });
  if (config.eaves) {
    appendTriangles(positions, indices, buildShedTrim(bounds, {
      roofHeight: peakY, roofHighEdge: highEdge, overhang: ov, eaves: config.eaves,
    }));
  }
  return createIndexedGeometry(positions, indices);
}

function createHipRoofGeometry(bounds, config) {
  const ov = overhangOf(config);
  const e = Math.min(ov.minX, ov.maxX, ov.minZ, ov.maxZ);
  const { minX, maxX, minZ, maxZ } = bounds;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const peakY = config.roofHeight;
  const pitchRatio = config.roofPitchRise / config.roofPitchRun;
  const longitudinalSpan = config.roofDirection === 'x' ? maxX - minX : maxZ - minZ;
  const ridgeEndOffset = Number.isFinite(pitchRatio) && pitchRatio > 0
    ? Math.min(longitudinalSpan / 2, peakY / pitchRatio)
    : 0;
  const eaveY = Number.isFinite(pitchRatio) ? -pitchRatio * e : 0;
  const ridgeEndpoints = config.ridgeEndpoints;
  const positions = config.roofDirection === 'x'
    ? [
      minX - e, eaveY, minZ - e, maxX + e, eaveY, minZ - e, maxX + e, eaveY, maxZ + e, minX - e, eaveY, maxZ + e,
      ridgeEndpoints?.start?.[0] ?? minX + ridgeEndOffset, peakY, ridgeEndpoints?.start?.[1] ?? centerZ,
      ridgeEndpoints?.end?.[0] ?? maxX - ridgeEndOffset, peakY, ridgeEndpoints?.end?.[1] ?? centerZ,
    ]
    : [
      minX - e, eaveY, minZ - e, maxX + e, eaveY, minZ - e, maxX + e, eaveY, maxZ + e, minX - e, eaveY, maxZ + e,
      ridgeEndpoints?.start?.[0] ?? centerX, peakY, ridgeEndpoints?.start?.[1] ?? minZ + ridgeEndOffset,
      ridgeEndpoints?.end?.[0] ?? centerX, peakY, ridgeEndpoints?.end?.[1] ?? maxZ - ridgeEndOffset,
    ];
  const indices = config.roofDirection === 'x'
    ? [0, 1, 5, 0, 5, 4, 3, 4, 5, 3, 5, 2, 0, 4, 3, 1, 2, 5]
    : [0, 4, 5, 0, 5, 3, 1, 2, 5, 1, 5, 4, 0, 1, 4, 3, 5, 2];
  if (config.eaves && e > 0) {
    appendTriangles(positions, indices, buildHipTrim(bounds, {
      pitchRatio: Number.isFinite(pitchRatio) ? pitchRatio : 0,
      overhang: { minX: e, maxX: e, minZ: e, maxZ: e },
      eaves: config.eaves,
    }));
  }
  return createIndexedGeometry(positions, indices);
}

function createIndexedGeometry(positions, indices) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function addFacadePanels(group, footprint, layout, foundationHeight, config) {
  layout.stories.forEach((story) => {
    layout.facadePanels.forEach((facadePanel) => {
      const [startX, startZ] = facadePanel.start;
      const [endX, endZ] = facadePanel.end;
      const edgeLength = Math.hypot(endX - startX, endZ - startZ);
      const normalX = (endZ - startZ) / edgeLength;
      const normalZ = -(endX - startX) / edgeLength;
      const offset = 0.035;
      const minY = foundationHeight + story.minY + 0.02;
      const maxY = foundationHeight + story.maxY - 0.02;
      const positions = new Float32Array([
        startX + normalX * offset, minY, startZ + normalZ * offset,
        endX + normalX * offset, minY, endZ + normalZ * offset,
        endX + normalX * offset, maxY, endZ + normalZ * offset,
        startX + normalX * offset, maxY, startZ + normalZ * offset,
      ]);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      geometry.computeVertexNormals();

      const materialKey = config.panelMaterials?.[facadePanel.index]
        ?? config.storyMaterials?.[story.index]
        ?? config.wallMaterial
        ?? 'wood';
      const preset = MATERIAL_PALETTE[materialKey] ?? MATERIAL_PALETTE.wood;
      const panel = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: preset.color,
        roughness: preset.roughness,
        metalness: preset.metalness,
        side: THREE.DoubleSide,
      }));
      panel.userData = {
        facadeRegion: `${story.id}:${facadePanel.id}`,
        storyId: story.id,
        facadePanelId: facadePanel.id,
        material: materialKey,
      };
      group.add(panel);
    });
  });
}

function buildShape(footprint, overhang) {
  const shape = new THREE.Shape();
  const ring = footprint.map(([x, z]) => [x, -z]);

  if (ring.length === 0) {
    return shape;
  }

  const [firstX, firstZ] = ring[0];
  shape.moveTo(firstX, firstZ);
  for (let i = 1; i < ring.length; i += 1) {
    const [x, z] = ring[i];
    shape.lineTo(x, z);
  }

  if (overhang > 0) {
    const offset = new THREE.Shape();
    const offsets = footprint.map(([x, z]) => [
      x - (x / Math.hypot(x, z || 1)) * overhang,
      -(z - (z / Math.hypot(z, x || 1)) * overhang),
    ]);
    offset.moveTo(offsets[0][0], offsets[0][1]);
    for (let i = 1; i < offsets.length; i += 1) {
      offset.lineTo(offsets[i][0], offsets[i][1]);
    }
    return offset;
  }

  return shape;
}
