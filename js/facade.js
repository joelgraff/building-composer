import { normalizeRoofStructures } from './roof-structures.js';
import { hasAngledWalls, rectilinearHull, cutVolumes, cutDistance } from './angled-walls.js';
import { cutRole } from './cut-roofs.js';
import { normalizeOpenings } from './openings.js';
import { normalizeTrim, normalizeWallTrim } from './trim.js';
import { normalizeRailing } from './railings.js';
import { normalizeInterior } from './interior.js';

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
  // a half story: the top floor's walls rise only to a knee wall under the roof
  const kneeWall = config.kneeWallHeight > 0 ? config.kneeWallHeight : 0;
  const totalHeight = storyCount * storyHeight + kneeWall;
  const wallMaterial = config.wallMaterial ?? 'wood';
  const storyMaterials = config.storyMaterials ?? [];
  const panelMaterials = config.panelMaterials ?? [];

  const stories = Array.from({ length: storyCount + (kneeWall ? 1 : 0) }, (_, index) => ({
    id: `story-${index + 1}`,
    index,
    minY: index * storyHeight,
    maxY: index < storyCount ? (index + 1) * storyHeight : storyCount * storyHeight + kneeWall,
    ...(index >= storyCount ? { half: true } : {}),
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

  const volumes = decomposeIntoVolumes(footprint, { split: config.volumeSplit });
  const roofGraph = buildRoofGraph(footprint, volumes, config);

  const enhancedWallRuns = wallRuns.map((wallRun, index) => {
    const edgeData = roofGraph.edges[index];
    return {
      ...wallRun,
      ...wallRunFrame(wallRun.start, wallRun.end),
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
 * A facade layout with the facade surfaces of the building's roof structures
 * (the `structureFacades` a build returns, see structureFacade in
 * js/roof-structures.js) and the widow's walks (`roofWalks`, see roofWalkFacade)
 * added alongside the footprint's: `structureWallRuns`, `structureStories`,
 * `roofWalks` (each walk's flat top, for a deck), and `railRuns` (along
 * structures' open sides and walks' edges). The footprint's own `wallRuns` are left
 * as they are (they also define the footprint a `.bld` file saves). Addressing
 * runs volume -> roof structure -> wall run -> facade panel -> story.
 */
export function withStructureFacades(layout, structureFacades = [], roofWalks = []) {
  return {
    ...layout,
    structureWallRuns: structureFacades.flatMap((facade) => facade.wallRuns),
    structureStories: structureFacades.flatMap((facade) => facade.stories),
    roofWalks,
    railRuns: [...structureFacades.flatMap((facade) => facade.railRuns), ...roofWalks.flatMap((walk) => walk.railRuns)],
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
 * An L or T can be cut two ways, and which one matches the house depends on
 * its massing: `split` picks the cut. `'z'` (the default, and what files
 * saved before the choice existed use) cuts between Z coordinates, so each
 * volume runs the full X width of its band; `'x'` cuts between X
 * coordinates; `'auto'` picks whichever matches the massing (see
 * pickVolumeSplit). Volume ids follow the decomposition, so changing the
 * cut renumbers the volumes.
 *
 * @param {Array<[number, number]>} footprint
 * @param {{ split?: 'z'|'x'|'auto' }} [options]
 * @returns {Array<{ id: string, minX: number, maxX: number, minZ: number, maxZ: number, ridgeAxis: 'x'|'z', width: number, length: number }>}
 */
export function decomposeIntoVolumes(footprint, { split = 'z' } = {}) {
  if (split === 'auto') {
    return pickVolumeSplit(footprint);
  }
  if (hasAngledWalls(footprint)) {
    // squared out to its rectilinear hull, then cut back by its angled walls
    // (see js/angled-walls.js); the hull's volumes as they are if that fails
    const { hull, cuts } = rectilinearHull(footprint);
    const volumes = decomposeRectilinear(hull, split);
    return cutVolumes(volumes, cuts, footprint) ?? volumes.map((volume) => ({ ...volume, uncut: true }));
  }
  return decomposeRectilinear(footprint, split);
}

/** Whether decomposeIntoVolumes could not follow a footprint's angled walls. */
export function angledWallProblem(footprint) {
  if (!hasAngledWalls(footprint)) {
    return null;
  }
  return decomposeIntoVolumes(footprint).some((volume) => volume.uncut)
    ? 'An angled wall reaches past another part of the building, so the footprint cannot be cut into volumes.'
    : null;
}

function decomposeRectilinear(footprint, split) {
  if (split === 'x') {
    // cut the other way: decompose the footprint with x and z swapped, and swap back
    const swapped = decomposeInBands(footprint.map(([x, z]) => [z, x]));
    return swapped.map((volume) => withVolumeShape({
      id: volume.id, minX: volume.minZ, maxX: volume.maxZ, minZ: volume.minX, maxZ: volume.maxX,
    }));
  }
  return decomposeInBands(footprint);
}

/** A volume with its ridge axis and extents from its rectangle. */
function withVolumeShape(volume) {
  const width = volume.maxX - volume.minX;
  const length = volume.maxZ - volume.minZ;
  return {
    ...volume,
    ridgeAxis: length >= width ? 'z' : 'x',
    width: Math.min(width, length),
    length: Math.max(width, length),
  };
}

/**
 * The decomposition, of the two cut directions, that best matches how a
 * house is massed: the fewest volumes; then, if only one cut leaves the
 * largest block whole with a shallow projection along its side, that one;
 * then no thin slivers (the largest smallest dimension of any volume); a tie
 * keeps the Z bands. A wing
 * beside a gable-front upright, or a projection in the middle of a side,
 * comes out as its own volume with the main block whole, whichever way the
 * house faces.
 */
function pickVolumeSplit(footprint) {
  const candidates = ['z', 'x'].map((split) => decomposeIntoVolumes(footprint, { split }));
  const depth = (volume) => Math.min(volume.maxX - volume.minX, volume.maxZ - volume.minZ);
  const length = (volume) => Math.max(volume.maxX - volume.minX, volume.maxZ - volume.minZ);
  // a shallow projection along a side (at most 3 m, and a quarter of its
  // length, deep) is no sliver: it leaves the main block whole
  const projection = (volume) => depth(volume) <= PROJECTION_DEPTH && depth(volume) <= length(volume) / 4;
  const largest = (volumes) => Math.max(...volumes.map((volume) => (volume.maxX - volume.minX) * (volume.maxZ - volume.minZ)));
  const [z, x] = candidates;
  if (z.length === x.length && z.length > 1) {
    const keepsBlock = (own, other) => own.some(projection) && largest(own) > largest(other) + 1e-6;
    if (keepsBlock(z, x) !== keepsBlock(x, z)) {
      return keepsBlock(z, x) ? z : x;
    }
  }
  const score = (volumes) => [
    -volumes.length,
    Math.min(...volumes.map(depth)),
  ];
  const better = (a, b) => {
    const [sa, sb] = [score(a), score(b)];
    for (let k = 0; k < sa.length; k += 1) {
      if (Math.abs(sa[k] - sb[k]) > 1e-6) {
        return sa[k] > sb[k];
      }
    }
    return false;
  };
  return better(candidates[1], candidates[0]) ? candidates[1] : candidates[0];
}

/** How deep a projection along a side may be and still leave the main block whole (see pickVolumeSplit). */
const PROJECTION_DEPTH = 3;

/** Row-run decomposition: bands between the footprint's z coordinates, merged where their x-runs match. */
function decomposeInBands(footprint) {
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
 * A footprint edge's own local frame: `right`, the unit vector from `start`
 * toward `end` (the wall's own "u" axis), and `normal`, the outward unit
 * vector (its "v"-facing direction) — rotating `right` -90°, which is
 * outward for a footprint's own CCW winding (already guaranteed by
 * normalizeFootprint/validateFootprint, unlike an arbitrary edge, so this
 * needs no "inside point" the way roof-structures.js's edgeFrame/wallFrame do).
 */
export function wallRunFrame(start, end) {
  const length = computeSegmentLength(start, end) || 1;
  const right = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
  const normal = [right[1], -right[0]];
  return { right, normal };
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

  // an angled wall belongs to the volume it cuts
  const onCut = (candidate) => [edge.start, edge.end].every((point) => Math.abs(cutDistance(candidate, point)) < 1e-6);
  const cutVolume = orientation === 'diagonal' ? volumes.find((candidate) => candidate.cuts?.some(onCut)) : null;
  if (cutVolume) {
    bestVol = cutVolume;
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
  } else if (roofType === 'hip' || roofType === 'mansard') {
    role = 'eave';
    pitchRise = defaultPitchRise;
  } else if (roofType === 'gable' || roofType === 'gambrel') {
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

  if (cutVolume && roofType !== 'flat') {
    // as its roof treats it (see cutRole in js/cut-roofs.js)
    const cut = cutVolume.cuts.find(onCut);
    const highEdgeForCut = roofType === 'shed' ? highEdge : undefined;
    role = cutRole(cut, roofType, { ridgeAxis, roofHighEdge: highEdgeForCut, bounds: cutVolume }) === 'eave' ? 'eave' : 'rake';
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
    volumeSplit: modelConfig.volumeSplit ?? 'z',
    volumeStoryOverrides: modelConfig.volumeStoryOverrides ?? {},
    kneeWallHeight: modelConfig.kneeWallHeight,
    volumeKneeWalls: modelConfig.volumeKneeWalls ?? {},
    foundationDepth: modelConfig.foundationDepth,
    volumeStoryHeights: modelConfig.volumeStoryHeights ?? {},
    volumeFoundationHeights: modelConfig.volumeFoundationHeights ?? {},
    volumeRidgeDirections: modelConfig.volumeRidgeDirections ?? {},
    volumeRoofTypes: modelConfig.volumeRoofTypes ?? {},
    volumeRoofConnections: modelConfig.volumeRoofConnections ?? {},
    volumeRoofShapes: modelConfig.volumeRoofShapes ?? {},
    roofRakeDepth: modelConfig.roofRakeDepth,
    roofFasciaDepth: modelConfig.roofFasciaDepth,
    eaveSoffit: modelConfig.eaveSoffit,
    rakeSoffit: modelConfig.rakeSoffit,
    volumeEaves: modelConfig.volumeEaves ?? {},
    edgePitchOverrides: modelConfig.edgePitchOverrides ?? {},
    roofBreakHeight: modelConfig.roofBreakHeight,
    roofLowerPitchRise: modelConfig.roofLowerPitchRise,
    roofUpperPitchRise: modelConfig.roofUpperPitchRise,
    roofWalkHeight: modelConfig.roofWalkHeight,
    roofStructures: modelConfig.roofStructures ?? [],
    openings: modelConfig.openings ?? [],
    trim: normalizeTrim(modelConfig.trim),
    wallTrim: normalizeWallTrim(modelConfig.wallTrim),
    volumeMaterials: modelConfig.volumeMaterials ?? {},
    interior: normalizeInterior(modelConfig.interior),
    walkRailings: normalizeRailing(modelConfig.walkRailings),
    // where the footprint came from, to put the building back (see import.js)
    placement: modelConfig.placement ?? null,
    // the side the building fronts (walls are named from it)
    frontSide: modelConfig.frontSide ?? 'maxZ',
    roofGraph: layout.roofGraph,
  };
}

/** Per-volume roof shapes, with a widow's walk saved under its old name (`deckHeight`) renamed. */
function legacyRoofShapes(shapes) {
  const out = {};
  Object.entries(shapes && typeof shapes === 'object' ? shapes : {}).forEach(([volumeId, shape]) => {
    const { deckHeight, ...rest } = shape ?? {};
    out[volumeId] = Number.isFinite(deckHeight) && !Number.isFinite(rest.walkHeight) ? { ...rest, walkHeight: deckHeight } : rest;
  });
  return out;
}

/**
 * Validates and restores building configuration from a parsed .bld JSON payload.
 *
 * @param {object} data
 * @returns {{ valid: boolean, state?: object, errors?: string[], warnings?: string[] }}
 */
export function deserializeBuildingState(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Invalid file format: expected JSON object.'] };
  }
  if (!Array.isArray(data.footprint) || data.footprint.length < 3) {
    return { valid: false, errors: ['Invalid file format: footprint array missing or incomplete.'] };
  }

  // Structures are placed on a volume of the footprint's decomposition, or on
  // another structure; one whose host is gone (the file was edited, or
  // decomposition changed) is dropped rather than guessed onto another host,
  // and so is anything standing on it.
  // files saved before the cut could be chosen used Z bands; keep their volume ids
  const volumeSplit = ['auto', 'x', 'z'].includes(data.volumeSplit) ? data.volumeSplit : 'z';
  const volumeIds = new Set(decomposeIntoVolumes(data.footprint, { split: volumeSplit }).map((volume) => volume.id));
  const warnings = [];
  // a widow's walk was once a structure standing on a hip's flat top; it is
  // now that flat top itself (roofWalkHeight), so the structure is dropped
  const rawStructures = Array.isArray(data.roofStructures) ? data.roofStructures : [];
  rawStructures.filter((raw) => raw?.kind === 'widows-walk').forEach((raw) => {
    warnings.push(`Dropped roof structure ${raw.id ?? '(unnamed)'}: a widow's walk is now the flat top of a hip roof (its widow's walk height).`);
  });
  let roofStructures = normalizeRoofStructures(rawStructures.filter((raw) => raw?.kind !== 'widows-walk'));
  let dropped = true;
  while (dropped) {
    const structureIds = new Set(roofStructures.map((structure) => structure.id));
    const kept = roofStructures.filter((structure) => {
      const hostOk = structure.hostStructureId
        ? structureIds.has(structure.hostStructureId) && structure.hostStructureId !== structure.id
        : volumeIds.has(structure.hostVolumeId);
      if (!hostOk) {
        const hostName = structure.hostStructureId ? `structure ${structure.hostStructureId}` : `volume ${structure.hostVolumeId}`;
        warnings.push(`Dropped roof structure ${structure.id}: host ${hostName} does not exist.`);
      }
      return hostOk;
    });
    dropped = kept.length < roofStructures.length;
    roofStructures = kept;
  }

  // A footprint wall run's id is purely positional ('wall-run-<index>'), so
  // the valid set is cheap to recompute from the footprint alone — one per
  // edge, the same count computeFacadeLayout's own wallRuns would produce.
  // A structure's walls only exist once it's built, so an opening on one is
  // kept while its structure is (a wall it no longer has fails to build, with a reason).
  const wallRunIds = new Set(data.footprint.map((_, index) => `wall-run-${index}`));
  const onKeptStructure = (hostId) => roofStructures.some((structure) => hostId.startsWith(`wall-run-${structure.id}-`));
  const openings = normalizeOpenings(Array.isArray(data.openings) ? data.openings : []).filter((opening) => {
    const hostOk = wallRunIds.has(opening.hostWallRunId) || onKeptStructure(opening.hostWallRunId);
    if (!hostOk) {
      warnings.push(`Dropped ${opening.kind} ${opening.id}: host wall ${opening.hostWallRunId} does not exist.`);
    }
    return hostOk;
  });
  // a volume's own wall material, kept for the volumes the footprint still cuts
  const volumeMaterials = Object.fromEntries(Object.entries(data.volumeMaterials && typeof data.volumeMaterials === 'object' ? data.volumeMaterials : {})
    .filter(([volumeId, key]) => volumeIds.has(volumeId) && typeof key === 'string'));
  // per-wall trim, kept for the walls that still exist (a structure's while it does)
  const wallTrim = Object.fromEntries(Object.entries(normalizeWallTrim(data.wallTrim))
    .filter(([wallId]) => wallRunIds.has(wallId) || onKeptStructure(wallId)));

  return {
    valid: true,
    warnings,
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
      volumeSplit,
      volumeStoryOverrides: data.volumeStoryOverrides ?? {},
      // a half story's knee wall, for the building and by volume
      kneeWallHeight: Number.isFinite(data.kneeWallHeight) && data.kneeWallHeight > 0 ? data.kneeWallHeight : undefined,
      volumeKneeWalls: data.volumeKneeWalls ?? {},
      // the foundation (floor level above grade), for the building and by volume, and story height by volume
      foundationDepth: Number.isFinite(data.foundationDepth) && data.foundationDepth >= 0 ? data.foundationDepth : undefined,
      volumeStoryHeights: data.volumeStoryHeights ?? {},
      volumeFoundationHeights: data.volumeFoundationHeights ?? {},
      volumeRidgeDirections: data.volumeRidgeDirections ?? {},
      volumeRoofTypes: data.volumeRoofTypes ?? {},
      volumeRoofConnections: data.volumeRoofConnections ?? {},
      volumeRoofShapes: legacyRoofShapes(data.volumeRoofShapes),
      roofRakeDepth: data.roofRakeDepth ?? data.roofEaveDepth ?? 0.35,
      roofFasciaDepth: data.roofFasciaDepth ?? 0.1524,
      eaveSoffit: data.eaveSoffit ?? 'flat',
      rakeSoffit: data.rakeSoffit ?? 'sloped',
      volumeEaves: data.volumeEaves ?? {},
      edgePitchOverrides: data.edgePitchOverrides ?? {},
      // mansard and gambrel settings; left unset, each type uses its own defaults
      roofBreakHeight: Number.isFinite(data.roofBreakHeight) ? data.roofBreakHeight : undefined,
      roofLowerPitchRise: Number.isFinite(data.roofLowerPitchRise) ? data.roofLowerPitchRise : undefined,
      roofUpperPitchRise: Number.isFinite(data.roofUpperPitchRise) ? data.roofUpperPitchRise : undefined,
      // a hip roof's widow's walk (its flat top), if any; older files called it a deck
      roofWalkHeight: [data.roofWalkHeight, data.roofDeckHeight].find(Number.isFinite),
      roofStructures,
      openings,
      // trim courses; an older file has none, so every course is off
      trim: normalizeTrim(data.trim),
      wallTrim,
      volumeMaterials,
      // a walk-in interior; an older file's building is solid
      interior: normalizeInterior(data.interior),
      // a widow's walk's railings; an older file's walk has the plain default
      walkRailings: normalizeRailing(data.walkRailings),
      placement: data.placement && typeof data.placement === 'object' ? data.placement : undefined,
      frontSide: ['minX', 'maxX', 'minZ', 'maxZ'].includes(data.frontSide) ? data.frontSide : 'maxZ',
    },
  };
}
