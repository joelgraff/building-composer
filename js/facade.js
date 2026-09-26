/**
 * Facade subdivision helpers for Task 3.
 *
 * The goal is to establish stable wall-run, story, and facade-panel metadata
 * that later feeds window placement, doors, and roof interaction logic.
 */

/**
 * Compute a simple facade layout from a normalized footprint.
 *
 * @param {Array<[number, number]>} footprint - Footprint in X/Z plane.
 * @param {{ storyCount?: number, storyHeight?: number, panelsPerRun?: number, wallMaterial?: string, storyMaterials?: string[], panelMaterials?: string[], roofType?: string, roofDirection?: string, roofPitchRise?: number, roofPitchRun?: number }} [config]
 * @returns {{ storyCount: number, storyHeight: number, totalHeight: number, stories: Array<object>, wallRuns: Array<object>, facadePanels: Array<object>, volumes: Array<object>, roofZones: Array<object> }}
 */
export function computeFacadeLayout(footprint, config = {}) {
  const storyCount = config.storyCount ?? 1;
  const storyHeight = config.storyHeight ?? 3.2;
  const panelsPerRun = Math.max(1, Math.floor(config.panelsPerRun ?? 2));
  const totalHeight = storyCount * storyHeight;
  const wallMaterial = config.wallMaterial ?? 'wood';
  const storyMaterials = config.storyMaterials ?? [];
  const panelMaterials = config.panelMaterials ?? [];

  const stories = Array.from({ length: storyCount }, (_, index) => ({
    id: `story-${index + 1}`,
    index,
    minY: index * storyHeight,
    maxY: (index + 1) * storyHeight,
    material: storyMaterials[index] ?? wallMaterial,
  }));

  const wallRuns = footprint.map(([x, z], index) => {
    const end = footprint[(index + 1) % footprint.length];
    return {
      id: `wall-run-${index}`,
      index,
      start: [x, z],
      end,
      length: computeSegmentLength([x, z], end),
    };
  });

  const facadePanels = [];
  wallRuns.forEach((wallRun) => {
    for (let positionInRun = 0; positionInRun < panelsPerRun; positionInRun += 1) {
      const startT = positionInRun / panelsPerRun;
      const endT = (positionInRun + 1) / panelsPerRun;
      const start = interpolatePoint(wallRun.start, wallRun.end, startT);
      const end = interpolatePoint(wallRun.start, wallRun.end, endT);
      const index = facadePanels.length;
      const length = computeSegmentLength(start, end);
      const midpoint = interpolatePoint(start, end, 0.5);

      facadePanels.push({
        id: `facade-panel-${index}`,
        index,
        wallRunId: wallRun.id,
        wallRunIndex: wallRun.index,
        positionInRun,
        runPanelCount: panelsPerRun,
        start,
        end,
        length,
        midpoint,
        vector: [end[0] - start[0], end[1] - start[1]],
        material: panelMaterials[index] ?? wallMaterial,
      });
    }
  });

  const volumes = decomposeIntoVolumes(footprint);
  const roofGraph = buildRoofGraph(footprint, volumes, config);

  const enhancedWallRuns = wallRuns.map((wallRun, index) => {
    const edgeData = roofGraph.edges[index];
    return {
      ...wallRun,
      orientation: edgeData?.orientation ?? 'horizontal',
      role: edgeData?.role ?? 'flat',
      pitchRise: edgeData?.pitchRise ?? 0,
      pitchRun: edgeData?.pitchRun ?? 12,
      roofZoneId: edgeData?.roofZoneId ?? 'roof-zone-main',
      volumeId: edgeData?.volumeId ?? null,
    };
  });

  return {
    storyCount,
    storyHeight,
    panelsPerRun,
    totalHeight,
    wallMaterial,
    stories,
    wallRuns: enhancedWallRuns,
    facadePanels,
    volumes,
    roofZones: roofGraph.zones,
    roofGraph,
  };
}

/**
 * Decompose a rectilinear (axis-aligned) footprint into the minimal set of
 * non-overlapping rectangular volumes that exactly tile it, e.g. a U-shaped
 * footprint decomposes into 3 volumes (two legs + a base), an L-shape into 2.
 *
 * This is the "bays" concept from the architecture discussion: each volume
 * is a candidate massing element with its own longitudinal (ridge) axis,
 * intended as the substrate for independent per-volume roof zones (Task 9).
 * It does not yet drive independent roof heights; the current roof builder
 * still renders one seamless height field across the whole footprint.
 *
 * Uses row-run matching: for each horizontal band between adjacent Z
 * coordinates, find the contiguous X-runs that lie inside the polygon, then
 * merge vertically-adjacent bands that share an identical X-run into a
 * single rectangle.
 *
 * @param {Array<[number, number]>} footprint
 * @returns {Array<{ id: string, minX: number, maxX: number, minZ: number, maxZ: number, ridgeAxis: 'x'|'z', width: number, length: number }>}
 */
export function decomposeIntoVolumes(footprint) {
  const xs = [...new Set(footprint.map(([x]) => x))].sort((a, b) => a - b);
  const zs = [...new Set(footprint.map(([, z]) => z))].sort((a, b) => a - b);

  if (xs.length < 2 || zs.length < 2) {
    return [{ id: 'volume-main', minX: xs[0] ?? 0, maxX: xs[0] ?? 0, minZ: zs[0] ?? 0, maxZ: zs[0] ?? 0, ridgeAxis: 'z', width: 0, length: 0 }];
  }

  const rowRuns = [];
  for (let zi = 0; zi < zs.length - 1; zi += 1) {
    const zMid = (zs[zi] + zs[zi + 1]) / 2;
    const runs = [];
    let runStart = null;
    for (let xi = 0; xi < xs.length - 1; xi += 1) {
      const xMid = (xs[xi] + xs[xi + 1]) / 2;
      const inside = isPointInPolygon(xMid, zMid, footprint);
      if (inside && runStart === null) {
        runStart = xi;
      } else if (!inside && runStart !== null) {
        runs.push([runStart, xi]);
        runStart = null;
      }
    }
    if (runStart !== null) {
      runs.push([runStart, xs.length - 1]);
    }
    rowRuns.push(runs);
  }

  const rectangles = [];
  let openRects = [];
  for (let zi = 0; zi <= rowRuns.length; zi += 1) {
    const runs = zi < rowRuns.length ? rowRuns[zi] : [];
    const stillOpen = [];
    openRects.forEach((rect) => {
      const matches = runs.some((run) => run[0] === rect.xStartIdx && run[1] === rect.xEndIdx);
      if (matches) {
        stillOpen.push(rect);
      } else {
        rectangles.push({ ...rect, zEndIdx: zi });
      }
    });
    openRects = stillOpen;
    runs.forEach((run) => {
      const alreadyOpen = openRects.some((rect) => rect.xStartIdx === run[0] && rect.xEndIdx === run[1]);
      if (!alreadyOpen) {
        openRects.push({ xStartIdx: run[0], xEndIdx: run[1], zStartIdx: zi });
      }
    });
  }

  return rectangles.map((rect, index) => {
    const minX = xs[rect.xStartIdx];
    const maxX = xs[rect.xEndIdx];
    const minZ = zs[rect.zStartIdx];
    const maxZ = zs[rect.zEndIdx];
    const width = maxX - minX;
    const length = maxZ - minZ;
    return {
      id: `volume-${index}`,
      minX,
      maxX,
      minZ,
      maxZ,
      ridgeAxis: length >= width ? 'z' : 'x',
      width: Math.min(width, length),
      length: Math.max(width, length),
    };
  });
}

/**
 * Finds every pair of rectangular volumes that share a coincident rectangle
 * side with a positive-length overlap, i.e. volumes whose walls physically
 * touch along a real span (not just at a single corner point).
 *
 * @param {Array<{ id: string, minX: number, maxX: number, minZ: number, maxZ: number }>} volumes
 * @returns {Array<{ volumeAId: string, sideA: 'minX'|'maxX'|'minZ'|'maxZ', volumeBId: string, sideB: 'minX'|'maxX'|'minZ'|'maxZ', axis: 'x'|'z', overlapMin: number, overlapMax: number }>}
 */
export function findVolumeAdjacencies(volumes) {
  const epsilon = 1e-6;
  const adjacencies = [];

  for (let i = 0; i < volumes.length; i += 1) {
    for (let j = i + 1; j < volumes.length; j += 1) {
      const a = volumes[i];
      const b = volumes[j];

      [['minX', 'maxX'], ['maxX', 'minX']].forEach(([sideA, sideB]) => {
        if (Math.abs(a[sideA] - b[sideB]) < epsilon) {
          const overlapMin = Math.max(a.minZ, b.minZ);
          const overlapMax = Math.min(a.maxZ, b.maxZ);
          if (overlapMax - overlapMin > epsilon) {
            adjacencies.push({
              volumeAId: a.id, sideA, volumeBId: b.id, sideB, axis: 'z', overlapMin, overlapMax,
            });
          }
        }
      });

      [['minZ', 'maxZ'], ['maxZ', 'minZ']].forEach(([sideA, sideB]) => {
        if (Math.abs(a[sideA] - b[sideB]) < epsilon) {
          const overlapMin = Math.max(a.minX, b.minX);
          const overlapMax = Math.min(a.maxX, b.maxX);
          if (overlapMax - overlapMin > epsilon) {
            adjacencies.push({
              volumeAId: a.id, sideA, volumeBId: b.id, sideB, axis: 'x', overlapMin, overlapMax,
            });
          }
        }
      });
    }
  }

  return adjacencies;
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

function computeSegmentLength(start, end) {
  const [x1, z1] = start;
  const [x2, z2] = end;
  return Math.hypot(x2 - x1, z2 - z1);
}

function interpolatePoint(start, end, amount) {
  return [
    start[0] + (end[0] - start[0]) * amount,
    start[1] + (end[1] - start[1]) * amount,
  ];
}

/**
 * Maps direction string to primary ridge axis.
 *
 * @param {string} direction
 * @returns {'x' | 'z'}
 */
export function roofAxisForDirection(direction) {
  if (direction === 'x-min' || direction === 'x-max') {
    return 'z';
  }
  if (direction === 'z-min' || direction === 'z-max') {
    return 'x';
  }
  return direction === 'x' ? 'x' : 'z';
}

/**
 * Classify a footprint wall run edge against rectilinear volumes and roof parameters.
 *
 * @param {{ id?: string, start: [number, number], end: [number, number] }} edge
 * @param {Array<object>} volumes
 * @param {object} [config]
 * @returns {{ volume: object|null, orientation: 'horizontal'|'vertical'|'diagonal', role: 'eave'|'rake'|'high-plate'|'flat', pitchRise: number, pitchRun: number }}
 */
export function classifyEdgeRole(edge, volumes, config = {}) {
  const [x1, z1] = edge.start;
  const [x2, z2] = edge.end;
  const eps = 1e-4;

  let orientation = 'diagonal';
  if (Math.abs(z1 - z2) < eps) {
    orientation = 'horizontal';
  } else if (Math.abs(x1 - x2) < eps) {
    orientation = 'vertical';
  }

  // Find the volume with maximum boundary overlap with this edge
  let bestVol = null;
  let maxOverlap = -1;

  for (const vol of volumes) {
    let overlap = 0;
    if (orientation === 'horizontal') {
      const z = (z1 + z2) / 2;
      if (Math.abs(z - vol.minZ) < eps || Math.abs(z - vol.maxZ) < eps) {
        const segMin = Math.min(x1, x2);
        const segMax = Math.max(x1, x2);
        overlap = Math.max(0, Math.min(segMax, vol.maxX) - Math.max(segMin, vol.minX));
      }
    } else if (orientation === 'vertical') {
      const x = (x1 + x2) / 2;
      if (Math.abs(x - vol.minX) < eps || Math.abs(x - vol.maxX) < eps) {
        const segMin = Math.min(z1, z2);
        const segMax = Math.max(z1, z2);
        overlap = Math.max(0, Math.min(segMax, vol.maxZ) - Math.max(segMin, vol.minZ));
      }
    }
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      bestVol = vol;
    }
  }

  const vol = bestVol ?? volumes[0];
  const roofType = (vol && config.volumeRoofTypes?.[vol.id]) ?? config.roofType ?? 'flat';
  const ridgeDirectionOverride = vol ? config.volumeRidgeDirections?.[vol.id] : undefined;
  const ridgeAxis = ridgeDirectionOverride ? roofAxisForDirection(ridgeDirectionOverride) : (vol?.ridgeAxis ?? 'z');
  const highEdge = ridgeDirectionOverride ?? (ridgeAxis === 'x' ? 'z-min' : 'x-min');

  const defaultPitchRise = config.roofPitchRise ?? 6;
  const defaultPitchRun = config.roofPitchRun ?? 12;

  let role = 'eave';
  let pitchRise = defaultPitchRise;

  if (roofType === 'flat') {
    role = 'flat';
    pitchRise = 0;
  } else if (roofType === 'hip') {
    role = 'eave';
    pitchRise = defaultPitchRise;
  } else if (roofType === 'gable') {
    const isParallelToRidge = (orientation === 'horizontal' && ridgeAxis === 'x')
      || (orientation === 'vertical' && ridgeAxis === 'z');
    role = isParallelToRidge ? 'eave' : 'rake';
    pitchRise = isParallelToRidge ? defaultPitchRise : 0;
  } else if (roofType === 'shed') {
    if (orientation === 'horizontal') {
      const z = (z1 + z2) / 2;
      if (highEdge === 'z-min') {
        role = Math.abs(z - vol.minZ) < eps ? 'high-plate' : (Math.abs(z - vol.maxZ) < eps ? 'eave' : 'rake');
      } else if (highEdge === 'z-max') {
        role = Math.abs(z - vol.maxZ) < eps ? 'high-plate' : (Math.abs(z - vol.minZ) < eps ? 'eave' : 'rake');
      } else {
        role = 'rake';
      }
    } else if (orientation === 'vertical') {
      const x = (x1 + x2) / 2;
      if (highEdge === 'x-min') {
        role = Math.abs(x - vol.minX) < eps ? 'high-plate' : (Math.abs(x - vol.maxX) < eps ? 'eave' : 'rake');
      } else if (highEdge === 'x-max') {
        role = Math.abs(x - vol.maxX) < eps ? 'high-plate' : (Math.abs(x - vol.minX) < eps ? 'eave' : 'rake');
      } else {
        role = 'rake';
      }
    }
    pitchRise = role === 'eave' ? defaultPitchRise : 0;
  }

  // Check if edge has a specific pitch override
  const edgeId = edge.id;
  if (edgeId && config.edgePitchOverrides?.[edgeId] !== undefined) {
    pitchRise = config.edgePitchOverrides[edgeId];
  }

  return {
    volume: vol,
    orientation,
    role,
    pitchRise,
    pitchRun: defaultPitchRun,
  };
}

/**
 * Builds the persistent RoofGraph data structure linking footprint edges to roof zones.
 *
 * @param {Array<[number, number]>} footprint
 * @param {Array<object>} volumes
 * @param {object} [config]
 * @returns {{ version: number, zones: Array<object>, edges: Array<object>, summary: object }}
 */
export function buildRoofGraph(footprint, volumes, config = {}) {
  const wallRuns = footprint.map(([x, z], index) => {
    const end = footprint[(index + 1) % footprint.length];
    return {
      id: `wall-run-${index}`,
      index,
      start: [x, z],
      end,
      length: computeSegmentLength([x, z], end),
    };
  });

  const zones = volumes.map((volume) => {
    const roofType = config.volumeRoofTypes?.[volume.id] ?? config.roofType ?? 'flat';
    const directionOverride = config.volumeRidgeDirections?.[volume.id];
    const ridgeAxis = directionOverride ? roofAxisForDirection(directionOverride) : volume.ridgeAxis;
    const highEdge = directionOverride ?? (ridgeAxis === 'x' ? 'z-min' : 'x-min');
    const pitchRise = config.roofPitchRise ?? 6;
    const pitchRun = config.roofPitchRun ?? 12;

    return {
      id: `roof-zone-${volume.id}`,
      volumeId: volume.id,
      roofType,
      ridgeAxis,
      highEdge,
      pitchRise,
      pitchRun,
      wallRunIds: [],
    };
  });

  const zoneMap = new Map(zones.map((z) => [z.volumeId, z]));

  const edges = wallRuns.map((wallRun) => {
    const classification = classifyEdgeRole(wallRun, volumes, config);
    const ownerVol = classification.volume;
    const zone = ownerVol ? zoneMap.get(ownerVol.id) : zones[0];
    if (zone) {
      zone.wallRunIds.push(wallRun.id);
    }

    return {
      id: wallRun.id,
      index: wallRun.index,
      start: wallRun.start,
      end: wallRun.end,
      length: wallRun.length,
      orientation: classification.orientation,
      role: classification.role,
      pitchRise: classification.pitchRise,
      pitchRun: classification.pitchRun,
      volumeId: ownerVol ? ownerVol.id : null,
      roofZoneId: zone ? zone.id : null,
    };
  });

  return {
    version: 1,
    zones,
    edges,
    summary: {
      eavesCount: edges.filter((e) => e.role === 'eave').length,
      rakesCount: edges.filter((e) => e.role === 'rake').length,
      highPlatesCount: edges.filter((e) => e.role === 'high-plate').length,
      flatCount: edges.filter((e) => e.role === 'flat').length,
    },
  };
}

/**
 * Serializes the complete building state into a native .bld JSON payload.
 *
 * @param {object} layout
 * @param {object} modelConfig
 * @returns {object}
 */
export function serializeBuildingState(layout, modelConfig) {
  return {
    format: 'building-composer',
    version: 1,
    createdAt: new Date().toISOString(),
    footprint: layout.wallRuns.map((w) => w.start),
    storyCount: modelConfig.storyCount,
    storyHeight: modelConfig.storyHeight,
    wallMaterial: modelConfig.wallMaterial,
    storyMaterials: modelConfig.storyMaterials ?? [],
    panelMaterials: modelConfig.panelMaterials ?? [],
    roofType: modelConfig.roofType,
    roofDirection: modelConfig.roofDirection,
    roofPitchRise: modelConfig.roofPitchRise,
    roofPitchRun: modelConfig.roofPitchRun,
    roofHeight: modelConfig.roofHeight,
    roofEaveDepth: modelConfig.roofEaveDepth,
    roofHeightMode: modelConfig.roofHeightMode,
    volumeStoryOverrides: modelConfig.volumeStoryOverrides ?? {},
    volumeRidgeDirections: modelConfig.volumeRidgeDirections ?? {},
    volumeRoofTypes: modelConfig.volumeRoofTypes ?? {},
    volumeRoofConnections: modelConfig.volumeRoofConnections ?? {},
    volumeRoofShapes: modelConfig.volumeRoofShapes ?? {},
    edgePitchOverrides: modelConfig.edgePitchOverrides ?? {},
    roofGraph: layout.roofGraph,
  };
}

/**
 * Validates and restores building configuration from a parsed .bld JSON payload.
 *
 * @param {object} data
 * @returns {{ valid: boolean, state?: object, errors?: string[] }}
 */
export function deserializeBuildingState(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Invalid file format: expected JSON object.'] };
  }
  if (!Array.isArray(data.footprint) || data.footprint.length < 3) {
    return { valid: false, errors: ['Invalid file format: footprint array missing or incomplete.'] };
  }

  return {
    valid: true,
    state: {
      footprint: data.footprint,
      storyCount: data.storyCount ?? 1,
      storyHeight: data.storyHeight ?? 3.2,
      wallMaterial: data.wallMaterial ?? 'wood',
      storyMaterials: data.storyMaterials ?? [],
      panelMaterials: data.panelMaterials ?? [],
      roofType: data.roofType ?? 'flat',
      roofDirection: data.roofDirection ?? 'z',
      roofPitchRise: data.roofPitchRise ?? 6,
      roofPitchRun: data.roofPitchRun ?? 12,
      roofHeight: data.roofHeight ?? 2,
      roofEaveDepth: data.roofEaveDepth ?? 0.35,
      roofHeightMode: data.roofHeightMode ?? 'slope',
      volumeStoryOverrides: data.volumeStoryOverrides ?? {},
      volumeRidgeDirections: data.volumeRidgeDirections ?? {},
      volumeRoofTypes: data.volumeRoofTypes ?? {},
      volumeRoofConnections: data.volumeRoofConnections ?? {},
      volumeRoofShapes: data.volumeRoofShapes ?? {},
      edgePitchOverrides: data.edgePitchOverrides ?? {},
    },
  };
}
