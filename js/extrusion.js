/**
 * Extrusion helper that creates the base massing for the model.
 */

import * as THREE from '../node_modules/three/build/three.module.js';
import { createMaterials, MATERIAL_PALETTE } from './materials.js';

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
      storyCount, storyHeight, foundationDepth, roofEaveDepth, roofType, roofHeight, roofPitchRise, roofPitchRun, roofHeightMode: config.roofHeightMode, volumeRidgeDirections: config.volumeRidgeDirections, volumeRoofTypes: config.volumeRoofTypes, volumeRoofConnections: config.volumeRoofConnections,
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
      roofHeightMode: config.roofHeightMode,
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
  const mode = config.roofHeightMode ?? 'slope';
  const directedVolumes = applyVolumeRidgeDirections(volumes, config.volumeRidgeDirections ?? {});
  const hasGableVolume = directedVolumes.some((volume) => (config.volumeRoofTypes?.[volume.id] ?? roofType) === 'gable');
  const roofVolumes = hasGableVolume
    ? resolveGableRidgeDirections(directedVolumes)
    : directedVolumes;
  const materials = createMaterials(config);
  const group = new THREE.Group();
  const foundationHeight = foundationDepth;
  let maxTotalHeight = 0;

  roofVolumes.forEach((volume) => {
    const volumeStoryCount = overrides[volume.id] ?? storyCount;
    const totalHeight = volumeStoryCount * storyHeight;
    maxTotalHeight = Math.max(maxTotalHeight, totalHeight);
    const bounds = { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };

    const walls = new THREE.Mesh(createBoxWallGeometry(bounds, totalHeight), materials.wall);
    walls.position.y = foundationHeight;
    walls.userData = { volumeId: volume.id };
    group.add(walls);

    const foundation = new THREE.Mesh(createBoxWallGeometry(bounds, foundationHeight), materials.foundation);
    foundation.userData = { volumeId: volume.id };
    group.add(foundation);

    const roofDirectionForVolume = volume.ridgeAxis;
    const halfSpan = halfSpanForBounds(bounds, roofDirectionForVolume);
    const roofTypeForVolume = config.volumeRoofTypes?.[volume.id] ?? roofType;
    const roofHeightForVolume = roofTypeForVolume === 'flat'
      ? 0
      : (mode === 'height' ? roofHeight : halfSpan * (roofPitchRise / roofPitchRun));
    const roofConfig = {
      roofDirection: roofDirectionForVolume,
      roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(roofDirectionForVolume),
      roofHeight: roofHeightForVolume,
      roofOverhang: roofEaveDepth,
      roofPitchRise: mode === 'height' ? roofHeight : roofPitchRise,
      roofPitchRun: mode === 'height' ? halfSpan : roofPitchRun,
    };
    const roofGeometry = roofTypeForVolume === 'gable'
      ? createGableRoofGeometry(bounds, roofConfig)
      : roofTypeForVolume === 'hip'
        ? createHipRoofGeometry(bounds, roofConfig)
        : roofTypeForVolume === 'shed'
          ? createShedRoofGeometry(bounds, roofConfig)
        : createFlatRoofGeometry(bounds, roofEaveDepth);
    const roof = new THREE.Mesh(roofGeometry, materials.roof);
    roof.position.y = foundationHeight + totalHeight + 0.02;
    roof.userData = {
      volumeId: volume.id,
      roofType: roofTypeForVolume,
      roofDirection: roofDirectionForVolume,
      roofHeight: roofHeightForVolume,
      roofPitch: {
        rise: roofPitchRise,
        run: roofPitchRun,
        degrees: roofPitchDegrees(roofPitchRise, roofPitchRun),
      },
    };
    group.add(roof);
  });

  group.userData = { multiVolume: true, volumeCount: volumes.length };
  return { building: group, foundationHeight, totalHeight: maxTotalHeight };
}

function roofHeightForBounds(bounds, roofDirection, pitchRise, pitchRun) {
  return halfSpanForBounds(bounds, roofDirection) * (pitchRise / pitchRun);
}

function halfSpanForBounds(bounds, roofDirection) {
  const span = roofDirection === 'x' ? (bounds.maxZ - bounds.minZ) : (bounds.maxX - bounds.minX);
  return Math.max(0.01, span / 2);
}

function roofAxisForDirection(direction) {
  if (direction === 'x-min' || direction === 'x-max') {
    return 'z';
  }
  if (direction === 'z-min' || direction === 'z-max') {
    return 'x';
  }
  return direction === 'x' ? 'x' : 'z';
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
  if (bounds && config.roofType === 'flat') {
    return createFlatRoofGeometry(bounds, config.roofOverhang);
  }

  if (config.roofType === 'gable' || config.roofType === 'hip' || config.roofType === 'shed' || hasSlopedVolumeRoof) {
    if (bounds) {
      return config.roofType === 'gable'
        ? createGableRoofGeometry(bounds, config)
        : config.roofType === 'hip'
          ? createHipRoofGeometry(bounds, config)
          : createShedRoofGeometry(bounds, config);
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
  const pitchRise = config.roofPitchRise ?? 6;
  const pitchRun = config.roofPitchRun ?? 12;
  const mode = config.roofHeightMode ?? 'slope';
  const roofHeight = config.roofHeight ?? 2;
  const directedVolumes = applyVolumeRidgeDirections(volumes, config.volumeRidgeDirections ?? {});
  const hasGableVolume = directedVolumes.some((volume) => (config.volumeRoofTypes?.[volume.id] ?? config.roofType) === 'gable');
  const roofVolumes = hasGableVolume
    ? resolveGableRidgeDirections(directedVolumes)
    : directedVolumes;
  const ridgeHeights = new Map(roofVolumes.map((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
    const halfSpan = halfSpanForBounds(volume, volume.ridgeAxis);
    const height = roofType === 'flat'
      ? 0
      : (mode === 'height' ? roofHeight : halfSpan * (pitchRise / pitchRun));
    return [volume.id, height];
  }));
  const ridgeEndpoints = (mode === 'height' || hasGableVolume)
    ? buildConnectedConstantRiseRidges(roofVolumes, config.roofType === 'hip', ridgeHeights)
    : new Map();

  const chunks = roofVolumes.map((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType;
    const bounds = { minX: volume.minX, maxX: volume.maxX, minZ: volume.minZ, maxZ: volume.maxZ };
    const halfSpan = halfSpanForBounds(bounds, volume.ridgeAxis);
    const roofConfig = mode === 'height'
      ? {
        roofDirection: volume.ridgeAxis,
        roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(volume.ridgeAxis),
        roofHeight,
        roofOverhang: 0,
        roofPitchRise: roofHeight,
        roofPitchRun: halfSpan,
        ridgeEndpoints: (roofType === 'gable' || mode === 'height') ? ridgeEndpoints.get(volume.id) : undefined,
      }
      : {
        roofDirection: volume.ridgeAxis,
        roofHighEdge: volume.roofHighEdge ?? defaultHighEdgeForAxis(volume.ridgeAxis),
        roofHeight: halfSpan * (pitchRise / pitchRun),
        roofOverhang: 0,
        roofPitchRise: pitchRise,
        roofPitchRun: pitchRun,
        ridgeEndpoints: roofType === 'gable' ? ridgeEndpoints.get(volume.id) : undefined,
      };
    return roofType === 'flat'
      ? createFlatRoofGeometry(bounds, 0)
      : roofType === 'gable'
        ? createGableRoofGeometry(bounds, roofConfig)
        : roofType === 'hip'
          ? createHipRoofGeometry(bounds, roofConfig)
          : createShedRoofGeometry(bounds, roofConfig);
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

function createFlatRoofGeometry(bounds, eaveDepth) {
  const shape = new THREE.Shape();
  const minX = bounds.minX - eaveDepth;
  const maxX = bounds.maxX + eaveDepth;
  const minZ = bounds.minZ - eaveDepth;
  const maxZ = bounds.maxZ + eaveDepth;
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

function createGableRoofGeometry(bounds, config) {
  const minX = bounds.minX - config.roofOverhang;
  const maxX = bounds.maxX + config.roofOverhang;
  const minZ = bounds.minZ - config.roofOverhang;
  const maxZ = bounds.maxZ + config.roofOverhang;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const baseY = 0;
  const peakY = config.roofHeight;
  const ridgeEndpoints = config.ridgeEndpoints;
  const startPeakY = ridgeEndpoints?.start?.[2] ?? peakY;
  const endPeakY = ridgeEndpoints?.end?.[2] ?? peakY;
  const positions = config.roofDirection === 'x'
    ? [
      minX, baseY, minZ, maxX, baseY, minZ, maxX, baseY, maxZ, minX, baseY, maxZ,
      ridgeEndpoints?.start?.[0] ?? minX, startPeakY, ridgeEndpoints?.start?.[1] ?? centerZ,
      ridgeEndpoints?.end?.[0] ?? maxX, endPeakY, ridgeEndpoints?.end?.[1] ?? centerZ,
    ]
    : [
      minX, baseY, minZ, maxX, baseY, minZ, maxX, baseY, maxZ, minX, baseY, maxZ,
      ridgeEndpoints?.start?.[0] ?? centerX, startPeakY, ridgeEndpoints?.start?.[1] ?? minZ,
      ridgeEndpoints?.end?.[0] ?? centerX, endPeakY, ridgeEndpoints?.end?.[1] ?? maxZ,
    ];
  const indices = config.roofDirection === 'x'
    ? [0, 1, 5, 0, 5, 4, 3, 4, 5, 3, 5, 2, 0, 4, 3, 1, 2, 5]
    : [0, 4, 5, 0, 5, 3, 1, 2, 5, 1, 5, 4, 0, 1, 4, 3, 5, 2];
  return createIndexedGeometry(positions, indices);
}

function createShedRoofGeometry(bounds, config) {
  const minX = bounds.minX - config.roofOverhang;
  const maxX = bounds.maxX + config.roofOverhang;
  const minZ = bounds.minZ - config.roofOverhang;
  const maxZ = bounds.maxZ + config.roofOverhang;
  const peakY = config.roofHeight;
  const highEdge = config.roofHighEdge ?? defaultHighEdgeForAxis(config.roofDirection);
  const roofCorners = highEdge === 'x-min'
    ? [
      minX, peakY, minZ,
      maxX, 0, minZ,
      maxX, 0, maxZ,
      minX, peakY, maxZ,
    ]
    : highEdge === 'x-max'
      ? [
        minX, 0, minZ,
        maxX, peakY, minZ,
        maxX, peakY, maxZ,
        minX, 0, maxZ,
      ]
      : highEdge === 'z-min'
        ? [
      minX, peakY, minZ,
      maxX, peakY, minZ,
      maxX, 0, maxZ,
      minX, 0, maxZ,
        ]
        : [
          minX, 0, minZ,
          maxX, 0, minZ,
          maxX, peakY, maxZ,
          minX, peakY, maxZ,
        ];
  const positions = [...roofCorners];
  for (let index = 0; index < 4; index += 1) {
    positions.push(roofCorners[index * 3], 0, roofCorners[index * 3 + 2]);
  }

  const indices = [0, 1, 2, 0, 2, 3];
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    const height = roofCorners[index * 3 + 1];
    const nextHeight = roofCorners[next * 3 + 1];
    if (height > 1e-8 && nextHeight > 1e-8) {
      indices.push(index, next, next + 4, index, next + 4, index + 4);
    } else if (height > 1e-8) {
      indices.push(index, next, index + 4);
    } else if (nextHeight > 1e-8) {
      indices.push(index, next, next + 4);
    }
  }
  return createIndexedGeometry(positions, indices);
}

function createHipRoofGeometry(bounds, config) {
  const minX = bounds.minX - config.roofOverhang;
  const maxX = bounds.maxX + config.roofOverhang;
  const minZ = bounds.minZ - config.roofOverhang;
  const maxZ = bounds.maxZ + config.roofOverhang;
  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  const baseY = 0;
  const peakY = config.roofHeight;
  const pitchRatio = config.roofPitchRise / config.roofPitchRun;
  const longitudinalSpan = config.roofDirection === 'x' ? maxX - minX : maxZ - minZ;
  const ridgeEndOffset = Number.isFinite(pitchRatio) && pitchRatio > 0
    ? Math.min(longitudinalSpan / 2, peakY / pitchRatio)
    : 0;
  const ridgeEndpoints = config.ridgeEndpoints;
  const positions = config.roofDirection === 'x'
    ? [
      minX, baseY, minZ, maxX, baseY, minZ, maxX, baseY, maxZ, minX, baseY, maxZ,
      ridgeEndpoints?.start?.[0] ?? minX + ridgeEndOffset, peakY, ridgeEndpoints?.start?.[1] ?? centerZ,
      ridgeEndpoints?.end?.[0] ?? maxX - ridgeEndOffset, peakY, ridgeEndpoints?.end?.[1] ?? centerZ,
    ]
    : [
      minX, baseY, minZ, maxX, baseY, minZ, maxX, baseY, maxZ, minX, baseY, maxZ,
      ridgeEndpoints?.start?.[0] ?? centerX, peakY, ridgeEndpoints?.start?.[1] ?? minZ + ridgeEndOffset,
      ridgeEndpoints?.end?.[0] ?? centerX, peakY, ridgeEndpoints?.end?.[1] ?? maxZ - ridgeEndOffset,
    ];
  const indices = config.roofDirection === 'x'
    ? [0, 1, 5, 0, 5, 4, 3, 4, 5, 3, 5, 2, 0, 4, 3, 1, 2, 5]
    : [0, 4, 5, 0, 5, 3, 1, 2, 5, 1, 5, 4, 0, 1, 4, 3, 5, 2];
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
