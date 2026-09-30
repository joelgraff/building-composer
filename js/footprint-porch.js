/**
 * Turn into a porch (docs/FOOTPRINT_EDITING_PLAN.md, phase 4): a part of a
 * traced outline that is really a porch (OSM often traces an open porch as
 * part of the building) is cut out of the footprint and becomes a porch
 * structure. Pure functions with no DOM or THREE dependency.
 *
 * The part is an axis-aligned rectangle in Composer's frame (drawn across a
 * wall, or a traced bump: findBump). What it becomes depends on how it
 * touches the rest of the building:
 * - on one side: a porch projecting from that wall, standing on the ground,
 *   and the part is cut out of the footprint, leaving the wall straight;
 * - on two or more sides (it sits inside the wall line, a recessed porch
 *   traced as solid): a recessed porch (`mount: 'recess'`), and the
 *   footprint stays as it is.
 * A wraparound is turned one leg at a time: projecting porches on adjacent
 * walls of one mass, with the same depth, meeting at its corner, become one
 * wraparound porch when the footprint is used (porchStructures).
 *
 * The editor keeps these as pending porches, `{ type, side, rect,
 * openSides }`, and makes the structure records only when the footprint is
 * used (porchStructures), from the final outline and its masses.
 */
import { computeFacadeLayout } from './facade.js';
import { computeFootprintMetrics } from './footprint.js';
import { structureFrame, structureWallSides } from './roof-structures.js';
import { openRing, footprintWalls, MIN_WALL } from './footprint-editor.js';

const EPS = 1e-6;
/** Tolerance for a porch meeting a wall, a corner, or another porch (meters). */
const MEET = 0.02;
const SIDES = ['minX', 'maxX', 'minZ', 'maxZ'];
const OPPOSITE = {
  minX: 'maxX', maxX: 'minX', minZ: 'maxZ', maxZ: 'minZ',
};

/** A porch's roof and walls, by what it became (the Add menu's ground, wraparound, and integral porches). */
const PORCH_FIELDS = {
  projecting: {
    kind: 'porch', baseHeight: 'ground', wallHeight: 2.6, roofType: 'shed', roofShape: { mode: 'slope', pitchRise: 3 },
  },
  wraparound: {
    kind: 'porch', baseHeight: 'ground', wallHeight: 2.8, roofType: 'hip', roofShape: { mode: 'slope', pitchRise: 4 },
  },
  recess: {
    kind: 'porch', mount: 'recess', setback: 0, baseHeight: 'ground', wallHeight: 2.4, roofType: 'flat',
  },
};

/**
 * The rectangle of a traced bump whose outer wall is `wallIndex`: the wall
 * and the two walls either side of it turning back, square, to one wall
 * line. Null when the wall isn't the face of a bump standing out.
 */
export function findBump(footprint, wallIndex) {
  const ring = openRing(footprint);
  const n = ring.length;
  if (n < 6) {
    return null;
  }
  const walls = footprintWalls(ring);
  const face = walls[wallIndex];
  const before = walls[(wallIndex - 1 + n) % n];
  const after = walls[(wallIndex + 1) % n];
  if (!face?.axis || !before.axis || !after.axis || before.axis === face.axis || after.axis === face.axis) {
    return null;
  }
  // the sides run out from one wall line and back to it
  const start = ring[(wallIndex - 1 + n) % n];
  const end = ring[(wallIndex + 2) % n];
  const across = face.axis === 'x' ? 1 : 0;
  if (Math.abs(start[across] - end[across]) > MEET) {
    return null;
  }
  // and the face stands outside that line
  const out = (face.start[across] - start[across]) * face.normal[across];
  if (!(out > MIN_WALL)) {
    return null;
  }
  const corners = [start, face.start, face.end, end];
  return rectOf(corners);
}

/**
 * Cuts `rect` out of the footprint as a porch, or finds it's a recessed
 * porch. Throws a RangeError saying why when it can't.
 *
 * @returns {{ footprint: Array<[number, number]>, porch: { type: 'projecting'|'recess', side: string, rect: object, openSides: string[] } }}
 *   `side` is the side of the house the porch faces out of (its host side).
 */
export function cutPart(footprint, rect) {
  const ring = openRing(footprint);
  if (footprintWalls(ring).some((wall) => !wall.axis)) {
    throw new RangeError('Turn into a porch works on square walls: straighten the angled ones first.');
  }
  const box = normalizeRect(rect);
  if (box.maxX - box.minX < MIN_WALL || box.maxZ - box.minZ < MIN_WALL) {
    throw new RangeError('Draw a rectangle over the porch, at least a few inches each way.');
  }
  const grid = cellGrid(ring, box);
  const { cut, rest } = grid.count();
  if (!cut) {
    throw new RangeError("The rectangle doesn't cover any of the building.");
  }
  if (!rest) {
    throw new RangeError('That would take the whole building.');
  }
  if (grid.components(REST) > 1) {
    throw new RangeError('That would cut the building in two.');
  }
  if (!grid.touchesOutside(CUT)) {
    throw new RangeError("That part is inside the building: draw the rectangle across an outside wall.");
  }
  const part = grid.bounds(CUT);
  if (!grid.isFull(CUT, part)) {
    throw new RangeError('Only a rectangular part can become a porch: draw the rectangle over just the porch (turn a wraparound one leg at a time).');
  }
  const faces = grid.faces(part);
  const house = SIDES.filter((side) => faces[side].rest > 0);
  if (!house.length) {
    throw new RangeError("That part doesn't touch the rest of the building.");
  }
  const rectCoords = grid.coords(part);
  if (house.length === 1) {
    // standing out from one wall: cut it off, and a porch stands where it was
    const back = house[0];
    const side = OPPOSITE[back];
    return {
      footprint: orientLike(grid.outline(REST), ring),
      porch: { type: 'projecting', side, rect: rectCoords, openSides: ['front', 'left', 'right'] },
    };
  }
  // inside the wall line: a recessed porch, open where it faces outside, the footprint kept
  const fronts = SIDES.filter((side) => faces[side].rest === 0 && house.includes(OPPOSITE[side]));
  if (!fronts.length) {
    throw new RangeError('That part has the house on facing sides with nothing to open onto: it can\'t be a porch.');
  }
  const length = (side) => (side === 'minX' || side === 'maxX' ? rectCoords.maxZ - rectCoords.minZ : rectCoords.maxX - rectCoords.minX);
  const side = fronts.reduce((best, candidate) => (length(candidate) > length(best) + EPS ? candidate : best));
  const names = structureWallSides(structureFrame(side));
  const openSides = ['front', 'left', 'right'].filter((name) => faces[names[name]].rest === 0);
  return { footprint: ring, porch: { type: 'recess', side, rect: rectCoords, openSides } };
}

/**
 * The structure records for an outline's pending porches (from cutPart), on
 * its masses as Composer will cut them (`volumeSplit`, see
 * computeFacadeLayout). Projecting porches that meet at a mass's corner
 * with the same depth become one wraparound. A porch that no longer stands
 * against a wall (the outline was edited after) is left out, with a problem
 * saying so.
 *
 * @returns {{ structures: object[], problems: string[] }} records to pass
 *   to createRoofStructure (each marked `fromFootprint`)
 */
export function porchStructures(footprint, porches, { volumeSplit = 'auto' } = {}) {
  const ring = openRing(footprint);
  const { volumes } = computeFacadeLayout(ring, { volumeSplit });
  const problems = [];
  const placed = [];
  porches.forEach((porch, index) => {
    const found = porch.type === 'recess' ? hostForRecess(porch, volumes) : hostForProjecting(porch, volumes);
    if (!found) {
      problems.push(`Porch ${index + 1} no longer stands against a wall of the building, so it wasn't added.`);
      return;
    }
    placed.push({ ...porch, ...found });
  });

  const structures = [];
  placed.filter((porch) => porch.type === 'recess').forEach((porch) => {
    structures.push({
      ...PORCH_FIELDS.recess,
      hostVolumeId: porch.volume.id,
      hostSide: porch.side,
      offset: porch.center - porch.volumeMiddle,
      width: porch.length,
      depth: porch.depth,
      openSides: porch.openSides,
      fromFootprint: true,
    });
  });
  const projecting = placed.filter((porch) => porch.type === 'projecting');
  chainWraps(projecting).forEach((chain) => {
    if (chain.length === 1) {
      const [porch] = chain;
      structures.push({
        ...PORCH_FIELDS.projecting,
        hostVolumeId: porch.volume.id,
        hostSide: porch.side,
        offset: porch.center - porch.volumeMiddle,
        width: porch.length,
        setback: -porch.depth,
        depth: porch.depth,
        openSides: porch.openSides,
        fromFootprint: true,
      });
      return;
    }
    const [first] = chain;
    const last = chain[chain.length - 1];
    const loop = chain.length === 4 && chain.loop;
    structures.push({
      ...PORCH_FIELDS.wraparound,
      hostVolumeId: first.volume.id,
      hostSide: first.side,
      offset: first.center - first.volumeMiddle,
      width: first.houseLength,
      setback: -first.depth,
      depth: first.depth,
      openSides: ['front', 'left', 'right'],
      wrap: {
        walls: chain.map((porch) => porch.side),
        startLength: loop ? first.wallLength : first.houseLength,
        endLength: loop ? last.wallLength : last.houseLength,
      },
      fromFootprint: true,
    });
  });
  return { structures, problems };
}

// --- Hosts and wraparounds ---------------------------------------------------

/** A side's axis along it, and the coordinate across it. */
function sideAxes(side) {
  return side === 'minX' || side === 'maxX' ? { along: 'Z', across: 'X' } : { along: 'X', across: 'Z' };
}

/** The mass a projecting porch stands against (its back on the mass's side, overlapping most), with its placement along that side. */
function hostForProjecting(porch, volumes) {
  const { along, across } = sideAxes(porch.side);
  const back = porch.rect[OPPOSITE[porch.side]];
  const [lo, hi] = [porch.rect[`min${along}`], porch.rect[`max${along}`]];
  let best = null;
  volumes.forEach((volume) => {
    if (Math.abs(volume[porch.side] - back) > MEET) {
      return;
    }
    const overlap = Math.min(hi, volume[`max${along}`]) - Math.max(lo, volume[`min${along}`]);
    if (overlap > EPS && (!best || overlap > best.overlap)) {
      best = { volume, overlap };
    }
  });
  if (!best) {
    return null;
  }
  const { volume } = best;
  const [vlo, vhi] = [volume[`min${along}`], volume[`max${along}`]];
  const depth = Math.abs(porch.rect[porch.side] - back);
  return {
    volume,
    along,
    across,
    lo,
    hi,
    vlo,
    vhi,
    depth,
    center: (lo + hi) / 2,
    length: hi - lo,
    volumeMiddle: (vlo + vhi) / 2,
    // the stretch along the house (a leg's length in a wraparound), and the whole wall
    houseLength: Math.min(hi, vhi) - Math.max(lo, vlo),
    wallLength: vhi - vlo,
  };
}

/** The mass a recessed porch is cut into (the one holding it, its front on the mass's side). */
function hostForRecess(porch, volumes) {
  const { along } = sideAxes(porch.side);
  const middle = [(porch.rect.minX + porch.rect.maxX) / 2, (porch.rect.minZ + porch.rect.maxZ) / 2];
  const volume = volumes.find((candidate) => middle[0] > candidate.minX - EPS && middle[0] < candidate.maxX + EPS
    && middle[1] > candidate.minZ - EPS && middle[1] < candidate.maxZ + EPS
    && Math.abs(candidate[porch.side] - porch.rect[porch.side]) < MEET);
  if (!volume) {
    return null;
  }
  const [lo, hi] = [porch.rect[`min${along}`], porch.rect[`max${along}`]];
  return {
    volume,
    center: (lo + hi) / 2,
    length: hi - lo,
    depth: porch.side === 'minX' || porch.side === 'maxX' ? porch.rect.maxX - porch.rect.minX : porch.rect.maxZ - porch.rect.minZ,
    volumeMiddle: (volume[`min${along}`] + volume[`max${along}`]) / 2,
  };
}

/**
 * Groups projecting porches into wraparound chains: a porch that runs on
 * past its mass's corner by its depth (the corner square is its), and a
 * porch of the same depth on the mass's next wall starting at that corner,
 * are one wraparound, in that order. A leg between two others must run its
 * whole wall. Porches that don't chain stay on their own.
 */
function chainWraps(porches) {
  const nextOf = new Map();
  porches.forEach((porch) => {
    const ownsMax = Math.abs(porch.hi - (porch.vhi + porch.depth)) < MEET;
    const ownsMin = Math.abs(porch.lo - (porch.vlo - porch.depth)) < MEET;
    [[ownsMax, `max${porch.along}`], [ownsMin, `min${porch.along}`]].forEach(([owns, turnsOnto]) => {
      if (!owns || nextOf.has(porch)) {
        return;
      }
      // the next leg: on the wall round the corner, same mass and depth, reaching the corner
      const cornerAt = porch.volume[porch.side];
      const next = porches.find((other) => other !== porch && other.volume === porch.volume && other.side === turnsOnto
        && Math.abs(other.depth - porch.depth) < MEET
        && (porch.side.startsWith('max') ? Math.abs(other.hi - cornerAt) < MEET : Math.abs(other.lo - cornerAt) < MEET));
      if (next) {
        nextOf.set(porch, next);
      }
    });
  });
  const hasPrevious = new Set(nextOf.values());
  const chains = [];
  const used = new Set();
  const follow = (start) => {
    const chain = [start];
    used.add(start);
    let current = start;
    while (nextOf.has(current) && !used.has(nextOf.get(current))) {
      current = nextOf.get(current);
      chain.push(current);
      used.add(current);
    }
    chain.loop = nextOf.get(current) === start;
    return chain;
  };
  porches.filter((porch) => !hasPrevious.has(porch)).forEach((porch) => chains.push(follow(porch)));
  // what's left is a loop all the way round
  porches.filter((porch) => !used.has(porch)).forEach((porch) => chains.push(follow(porch)));
  // a leg between two others runs its whole wall; otherwise the chain stays as separate porches
  return chains.flatMap((chain) => {
    if (chain.length < 2) {
      return [chain];
    }
    const middles = chain.loop ? chain : chain.slice(1, -1);
    const whole = middles.every((porch) => Math.abs(porch.houseLength - porch.wallLength) < MEET);
    return whole && chain.length <= 4 ? [chain] : chain.map((porch) => [porch]);
  });
}

// --- The cell grid ------------------------------------------------------------

const OUTSIDE = 0;
const REST = 1;
const CUT = 2;

/**
 * The footprint and rectangle cut into cells along every x and z either
 * has, each outside, in the rest of the building, or in the cut part.
 */
function cellGrid(ring, box) {
  const xs = uniqueSorted([...ring.map(([x]) => x), box.minX, box.maxX]);
  const zs = uniqueSorted([...ring.map(([, z]) => z), box.minZ, box.maxZ]);
  const [nx, nz] = [xs.length - 1, zs.length - 1];
  const cells = [];
  for (let i = 0; i < nx; i += 1) {
    cells.push([]);
    for (let j = 0; j < nz; j += 1) {
      const center = [(xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2];
      const inside = pointInPolygon(center, ring);
      const inBox = center[0] > box.minX && center[0] < box.maxX && center[1] > box.minZ && center[1] < box.maxZ;
      cells[i].push(!inside ? OUTSIDE : inBox ? CUT : REST);
    }
  }
  const at = (i, j) => (i < 0 || j < 0 || i >= nx || j >= nz ? OUTSIDE : cells[i][j]);
  const each = (fn) => cells.forEach((column, i) => column.forEach((value, j) => fn(i, j, value)));

  return {
    count() {
      let [cut, rest] = [0, 0];
      each((i, j, value) => {
        cut += value === CUT ? 1 : 0;
        rest += value === REST ? 1 : 0;
      });
      return { cut, rest };
    },
    components(kind) {
      const seen = new Set();
      let count = 0;
      each((i, j, value) => {
        if (value !== kind || seen.has(`${i},${j}`)) {
          return;
        }
        count += 1;
        const stack = [[i, j]];
        seen.add(`${i},${j}`);
        while (stack.length) {
          const [a, b] = stack.pop();
          [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([da, db]) => {
            const key = `${a + da},${b + db}`;
            if (at(a + da, b + db) === kind && !seen.has(key)) {
              seen.add(key);
              stack.push([a + da, b + db]);
            }
          });
        }
      });
      return count;
    },
    touchesOutside(kind) {
      let touches = false;
      each((i, j, value) => {
        if (value === kind && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => at(i + di, j + dj) === OUTSIDE)) {
          touches = true;
        }
      });
      return touches;
    },
    /** The index range of a kind's cells. */
    bounds(kind) {
      const range = { i0: Infinity, i1: -Infinity, j0: Infinity, j1: -Infinity };
      each((i, j, value) => {
        if (value === kind) {
          range.i0 = Math.min(range.i0, i);
          range.i1 = Math.max(range.i1, i);
          range.j0 = Math.min(range.j0, j);
          range.j1 = Math.max(range.j1, j);
        }
      });
      return range;
    },
    isFull(kind, range) {
      for (let i = range.i0; i <= range.i1; i += 1) {
        for (let j = range.j0; j <= range.j1; j += 1) {
          if (at(i, j) !== kind) {
            return false;
          }
        }
      }
      return true;
    },
    coords(range) {
      return {
        minX: xs[range.i0], maxX: xs[range.i1 + 1], minZ: zs[range.j0], maxZ: zs[range.j1 + 1],
      };
    },
    /** How much of each face of a cell range lies against the rest of the building (cells, by length). */
    faces(range) {
      const tally = Object.fromEntries(SIDES.map((side) => [side, { rest: 0, outside: 0 }]));
      const add = (side, value, length) => {
        if (value === REST) {
          tally[side].rest += length;
        } else if (value === OUTSIDE) {
          tally[side].outside += length;
        }
      };
      for (let j = range.j0; j <= range.j1; j += 1) {
        add('minX', at(range.i0 - 1, j), zs[j + 1] - zs[j]);
        add('maxX', at(range.i1 + 1, j), zs[j + 1] - zs[j]);
      }
      for (let i = range.i0; i <= range.i1; i += 1) {
        add('minZ', at(i, range.j0 - 1), xs[i + 1] - xs[i]);
        add('maxZ', at(i, range.j1 + 1), xs[i + 1] - xs[i]);
      }
      return tally;
    },
    /** The outline round a kind's cells, as one ring (positive signed area), corners in line dropped. */
    outline(kind) {
      const edges = new Map();
      const addEdge = (from, to) => {
        const key = pointKey(from);
        if (edges.has(key)) {
          throw new RangeError('That would leave two parts of the building touching only at a corner.');
        }
        edges.set(key, { from, to });
      };
      each((i, j, value) => {
        if (value !== kind) {
          return;
        }
        const [x0, x1, z0, z1] = [xs[i], xs[i + 1], zs[j], zs[j + 1]];
        if (at(i, j - 1) !== kind) addEdge([x0, z0], [x1, z0]);
        if (at(i + 1, j) !== kind) addEdge([x1, z0], [x1, z1]);
        if (at(i, j + 1) !== kind) addEdge([x1, z1], [x0, z1]);
        if (at(i - 1, j) !== kind) addEdge([x0, z1], [x0, z0]);
      });
      const [first] = edges.values();
      const loop = [];
      let edge = first;
      for (let guard = 0; guard <= edges.size; guard += 1) {
        loop.push(edge.from);
        edge = edges.get(pointKey(edge.to));
        if (!edge || edge === first) {
          break;
        }
      }
      if (loop.length !== edges.size) {
        throw new RangeError('That would leave the building with a hole in it.');
      }
      return dropInLine(loop);
    },
  };
}

function pointInPolygon([x, z], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function dropInLine(loop) {
  return loop.filter((point, i) => {
    const previous = loop[(i - 1 + loop.length) % loop.length];
    const next = loop[(i + 1) % loop.length];
    const cross = (point[0] - previous[0]) * (next[1] - point[1]) - (point[1] - previous[1]) * (next[0] - point[0]);
    return Math.abs(cross) > EPS;
  });
}

/** `ring` turned to wind the same way as `like`. */
function orientLike(ring, like) {
  const sign = (points) => Math.sign(computeFootprintMetrics(points).signedArea);
  return sign(ring) === sign(like) ? ring : [...ring].reverse();
}

function uniqueSorted(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.filter((value, i) => i === 0 || value - sorted[i - 1] > EPS);
}

function normalizeRect(rect) {
  return {
    minX: Math.min(rect.minX, rect.maxX), maxX: Math.max(rect.minX, rect.maxX), minZ: Math.min(rect.minZ, rect.maxZ), maxZ: Math.max(rect.minZ, rect.maxZ),
  };
}

function rectOf(points) {
  const xs = points.map(([x]) => x);
  const zs = points.map(([, z]) => z);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs),
  };
}

function pointKey([x, z]) {
  return `${Math.round(x * 1e6)},${Math.round(z * 1e6)}`;
}
