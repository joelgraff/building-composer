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

  const wallRunIds = wallRuns.map((wallRun) => wallRun.id);
  const volumes = decomposeIntoVolumes(footprint);
  const mainVolume = volumes.reduce((largest, volume) => {
    const area = (volume.maxX - volume.minX) * (volume.maxZ - volume.minZ);
    const largestArea = (largest.maxX - largest.minX) * (largest.maxZ - largest.minZ);
    return area > largestArea ? volume : largest;
  }, volumes[0]);
  const roofZones = [{
    id: 'roof-zone-main',
    volumeId: mainVolume.id,
    wallRunIds,
    roofType: config.roofType ?? 'flat',
    roofDirection: config.roofDirection ?? 'z',
    roofPitchRise: config.roofPitchRise ?? 6,
    roofPitchRun: config.roofPitchRun ?? 12,
  }];

  return {
    storyCount,
    storyHeight,
    panelsPerRun,
    totalHeight,
    wallMaterial,
    stories,
    wallRuns,
    facadePanels,
    volumes,
    roofZones,
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
