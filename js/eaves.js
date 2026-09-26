/**
 * Eaves: per-volume overhang, fascia and soffit geometry.
 *
 * Pure functions with no THREE dependency. Triangles are returned as arrays of
 * three [x, y, z] points in the roof-local frame (y = 0 at the wall plate).
 *
 * Terminology: an *eave* is a side where the roof slope meets the wall (gable
 * long sides, every hip side, a shed's low side); a *rake* is a side across a
 * gable ridge or the sloped side of a shed. Eaves and rakes have independent
 * overhang depths, and each has a soffit style: `flat` (horizontal, at the
 * bottom of the fascia) or `sloped` (parallel to the roof, the roof plane
 * shifted down by the fascia depth).
 */

export const DEFAULT_FASCIA_DEPTH = 0.1524; // six inches
const EPS = 1e-9;

/**
 * Effective eave settings for a volume: its own overrides
 * (`config.volumeEaves[volumeId]`) over the building-wide defaults.
 */
export function resolveVolumeEaves(volumeId, config = {}) {
  const own = config.volumeEaves?.[volumeId] ?? {};
  const eaveDepth = own.eaveDepth ?? config.roofEaveDepth ?? 0;
  return {
    eaveDepth,
    rakeDepth: own.rakeDepth ?? config.roofRakeDepth ?? config.roofEaveDepth ?? 0,
    eaveSoffit: own.eaveSoffit ?? config.eaveSoffit ?? 'flat',
    rakeSoffit: own.rakeSoffit ?? config.rakeSoffit ?? 'sloped',
    fasciaDepth: own.fasciaDepth ?? config.roofFasciaDepth ?? DEFAULT_FASCIA_DEPTH,
  };
}

const LOW_SIDE_FOR_HIGH_EDGE = { 'x-min': 'maxX', 'x-max': 'minX', 'z-min': 'maxZ', 'z-max': 'minZ' };

/**
 * Overhang per rectangle side and each side's role. Sides that touch another
 * volume or are merged into a neighbor (`zeroSides`) get no overhang.
 *
 * @returns {{ overhang: Record<string, number>, roles: Record<string, 'eave'|'rake'|'none'> }}
 */
export function sideOverhangs(roofType, { ridgeAxis = 'x', roofHighEdge }, eaves, zeroSides = new Set()) {
  const sides = ['minX', 'maxX', 'minZ', 'maxZ'];
  const roles = {};
  if (roofType === 'gable') {
    sides.forEach((side) => {
      const acrossX = side === 'minX' || side === 'maxX';
      // ridge along x: the z sides run parallel to it (eaves)
      roles[side] = (ridgeAxis === 'x') === acrossX ? 'rake' : 'eave';
    });
  } else if (roofType === 'shed') {
    const low = LOW_SIDE_FOR_HIGH_EDGE[roofHighEdge] ?? 'maxX';
    const slopeAlongX = low === 'minX' || low === 'maxX';
    sides.forEach((side) => {
      const acrossX = side === 'minX' || side === 'maxX';
      if (side === low) {
        roles[side] = 'eave';
      } else if (acrossX === slopeAlongX) {
        roles[side] = 'none'; // the high edge
      } else {
        roles[side] = 'rake';
      }
    });
  } else {
    sides.forEach((side) => { roles[side] = 'eave'; });
  }
  const overhang = {};
  sides.forEach((side) => {
    const depth = roles[side] === 'eave' ? eaves.eaveDepth : (roles[side] === 'rake' ? eaves.rakeDepth : 0);
    overhang[side] = zeroSides.has(side) ? 0 : Math.max(0, depth);
  });
  if (roofType === 'hip') {
    // A hip's four faces only stay planar if every eave projects equally.
    const uniform = Math.min(...sides.map((side) => overhang[side]));
    sides.forEach((side) => { overhang[side] = uniform; });
  }
  return { overhang, roles };
}

const quad = (a, b, c, d) => [[a, b, c], [a, c, d]];
const fan = (points) => points.slice(1, -1).map((_, i) => [points[0], points[i + 1], points[i + 2]]);

/** Maps (cross, along, y) to world [x, y, z] for a ridge/slope running along `axis`. */
function frameFor(axis) {
  return axis === 'x' ? (c, a, y) => [a, y, c] : (c, a, y) => [c, y, a];
}

/**
 * Fascia and soffit triangles for a gable. `merged` flags which ends have no
 * overhang because the ridge runs on into a neighbor.
 */
export function buildGableTrim(bounds, { roofHeight, ridgeAxis, overhang, eaves }) {
  const axis = ridgeAxis === 'x' ? 'x' : 'z';
  const P = frameFor(axis);
  const [cMin, cMax] = axis === 'x' ? [bounds.minZ, bounds.maxZ] : [bounds.minX, bounds.maxX];
  const [aMin, aMax] = axis === 'x' ? [bounds.minX, bounds.maxX] : [bounds.minZ, bounds.maxZ];
  const [eMin, eMax] = axis === 'x' ? [overhang.minZ, overhang.maxZ] : [overhang.minX, overhang.maxX];
  const [rStart, rEnd] = axis === 'x' ? [overhang.minX, overhang.maxX] : [overhang.minZ, overhang.maxZ];
  if (eMin + eMax + rStart + rEnd <= EPS) {
    return [];
  }
  const cc = (cMin + cMax) / 2;
  const halfSpan = (cMax - cMin) / 2;
  const slope = halfSpan > EPS ? roofHeight / halfSpan : 0;
  const f = eaves.fasciaDepth;
  const cLo = cMin - eMin;
  const cHi = cMax + eMax;
  const yLo = -slope * eMin;
  const yHi = -slope * eMax;
  const aS = aMin - rStart;
  const aE = aMax + rEnd;
  const eaveFlat = eaves.eaveSoffit !== 'sloped';
  const rakeFlat = eaves.rakeSoffit === 'flat';
  const tris = [];

  // eave fascia + soffits
  [[eMin, cMin, cLo, yLo], [eMax, cMax, cHi, yHi]].forEach(([e, cWall, cOut, yOut]) => {
    if (e <= EPS) {
      return;
    }
    tris.push(...quad(P(cOut, aS, yOut), P(cOut, aE, yOut), P(cOut, aE, yOut - f), P(cOut, aS, yOut - f)));
    if (eaveFlat) {
      const along = rakeFlat ? [aMin, aMax] : [aS, aE];
      tris.push(...quad(P(cWall, along[0], yOut - f), P(cOut, along[0], yOut - f), P(cOut, along[1], yOut - f), P(cWall, along[1], yOut - f)));
    } else {
      tris.push(...quad(P(cWall, aMin, -f), P(cOut, aMin, yOut - f), P(cOut, aMax, yOut - f), P(cWall, aMax, -f)));
    }
  });

  // rake fascia + soffits at each overhanging end
  const flatLevel = Math.min(eMin > EPS ? yLo - f : -f, eMax > EPS ? yHi - f : -f);
  [[rStart, aMin, aS], [rEnd, aMax, aE]].forEach(([r, aWall, aOut]) => {
    if (r <= EPS) {
      return;
    }
    if (rakeFlat) {
      tris.push(...fan([P(cLo, aOut, yLo), P(cc, aOut, roofHeight), P(cHi, aOut, yHi), P(cHi, aOut, flatLevel), P(cLo, aOut, flatLevel)]));
      tris.push(...quad(P(cLo, aWall, flatLevel), P(cHi, aWall, flatLevel), P(cHi, aOut, flatLevel), P(cLo, aOut, flatLevel)));
      if (!eaveFlat) {
        // sloped eave soffit ends against the deeper flat rake box
        [[eMin, cMin, cLo, yLo], [eMax, cMax, cHi, yHi]].forEach(([e, cWall, cOut, yOut]) => {
          if (e > EPS) {
            tris.push([P(cOut, aWall, yOut - f), P(cWall, aWall, -f), P(cWall, aWall, flatLevel)]);
          }
        });
      }
      return;
    }
    // sloped rake: fascia follows the slope, deepening to the eave-soffit level over a flat eave soffit
    [[eMin, cMin, cLo, yLo, cc], [eMax, cMax, cHi, yHi, cc]].forEach(([e, cWall, cOut, yOut, cRidge]) => {
      const strip = (c0, y0, c1, y1, bottom0, bottom1) => {
        tris.push(...quad(P(c0, aOut, y0), P(c1, aOut, y1), P(c1, aOut, bottom1), P(c0, aOut, bottom0)));
      };
      if (e > EPS && eaveFlat) {
        strip(cOut, yOut, cWall, 0, yOut - f, yOut - f);
        // step face closing the boxed corner where the flat eave soffit meets the sloped rake soffit
        tris.push(...quad(P(cWall, aWall, yOut - f), P(cWall, aOut, yOut - f), P(cWall, aOut, -f), P(cWall, aWall, -f)));
        strip(cWall, 0, cRidge, roofHeight, -f, roofHeight - f);
        tris.push(...quad(P(cWall, aWall, -f), P(cWall, aOut, -f), P(cRidge, aOut, roofHeight - f), P(cRidge, aWall, roofHeight - f)));
      } else {
        const cStart = e > EPS ? cOut : cWall;
        const yStart = e > EPS ? yOut : 0;
        strip(cStart, yStart, cRidge, roofHeight, yStart - f, roofHeight - f);
        tris.push(...quad(P(cStart, aWall, yStart - f), P(cStart, aOut, yStart - f), P(cRidge, aOut, roofHeight - f), P(cRidge, aWall, roofHeight - f)));
      }
    });
  });
  return tris;
}

/** Fascia and soffit triangles for a hip (uniform overhang on all four sides). */
export function buildHipTrim(bounds, { pitchRatio, overhang, eaves }) {
  const e = overhang.minX;
  if (e <= EPS) {
    return [];
  }
  const f = eaves.fasciaDepth;
  const yOut = -pitchRatio * e;
  const { minX, maxX, minZ, maxZ } = bounds;
  const outer = [[minX - e, minZ - e], [maxX + e, minZ - e], [maxX + e, maxZ + e], [minX - e, maxZ + e]];
  const inner = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
  const tris = [];
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    const [o0, o1] = [outer[i], outer[j]];
    const [w0, w1] = [inner[i], inner[j]];
    tris.push(...quad([o0[0], yOut, o0[1]], [o1[0], yOut, o1[1]], [o1[0], yOut - f, o1[1]], [o0[0], yOut - f, o0[1]]));
    if (eaves.eaveSoffit === 'sloped') {
      tris.push(...quad([w0[0], -f, w0[1]], [w1[0], -f, w1[1]], [o1[0], yOut - f, o1[1]], [o0[0], yOut - f, o0[1]]));
    } else {
      tris.push(...quad([w0[0], yOut - f, w0[1]], [w1[0], yOut - f, w1[1]], [o1[0], yOut - f, o1[1]], [o0[0], yOut - f, o0[1]]));
    }
  }
  return tris;
}

/** Fascia and soffit triangles for a shed (low-side eave, lateral rakes, overhang-free high edge). */
export function buildShedTrim(bounds, { roofHeight, roofHighEdge, overhang, eaves }) {
  const low = LOW_SIDE_FOR_HIGH_EDGE[roofHighEdge] ?? 'maxX';
  const slopeAlongX = low === 'minX' || low === 'maxX';
  const P = frameFor(slopeAlongX ? 'z' : 'x'); // cross = slope coordinate, along = lateral coordinate
  const [sMin, sMax] = slopeAlongX ? [bounds.minX, bounds.maxX] : [bounds.minZ, bounds.maxZ];
  const [lMin, lMax] = slopeAlongX ? [bounds.minZ, bounds.maxZ] : [bounds.minX, bounds.maxX];
  const lowIsMin = low === 'minX' || low === 'minZ';
  const sLow = lowIsMin ? sMin : sMax;
  const sHigh = lowIsMin ? sMax : sMin;
  const dir = Math.sign(sHigh - sLow);
  const span = Math.abs(sHigh - sLow);
  const e = overhang[low];
  const [rA, rB] = slopeAlongX ? [overhang.minZ, overhang.maxZ] : [overhang.minX, overhang.maxX];
  if (e + rA + rB <= EPS) {
    return [];
  }
  const f = eaves.fasciaDepth;
  const slope = span > EPS ? roofHeight / span : 0;
  const sOut = sLow - dir * e;
  const yE = -slope * e;
  const lA = lMin - rA;
  const lB = lMax + rB;
  const eaveFlat = eaves.eaveSoffit !== 'sloped';
  const rakeFlat = eaves.rakeSoffit === 'flat';
  const tris = [];
  const F = (s, l, y) => P(s, l, y); // cross=s, along=l

  if (e > EPS) {
    tris.push(...quad(F(sOut, lA, yE), F(sOut, lB, yE), F(sOut, lB, yE - f), F(sOut, lA, yE - f)));
    if (eaveFlat) {
      const along = rakeFlat ? [lMin, lMax] : [lA, lB];
      tris.push(...quad(F(sLow, along[0], yE - f), F(sOut, along[0], yE - f), F(sOut, along[1], yE - f), F(sLow, along[1], yE - f)));
    } else {
      tris.push(...quad(F(sLow, lMin, -f), F(sOut, lMin, yE - f), F(sOut, lMax, yE - f), F(sLow, lMax, -f)));
    }
  }
  const flatLevel = e > EPS ? yE - f : -f;
  [[rA, lMin, lA], [rB, lMax, lB]].forEach(([r, lWall, lOut]) => {
    if (r <= EPS) {
      return;
    }
    // high-edge fascia over the rake extension only (the wall return already closes the wall span)
    const highBottom = rakeFlat ? flatLevel : roofHeight - f;
    tris.push(...quad(F(sHigh, lWall, roofHeight), F(sHigh, lOut, roofHeight), F(sHigh, lOut, highBottom), F(sHigh, lWall, highBottom)));
    if (rakeFlat) {
      tris.push(...fan([F(sOut, lOut, yE), F(sHigh, lOut, roofHeight), F(sHigh, lOut, flatLevel), F(sOut, lOut, flatLevel)]));
      tris.push(...quad(F(sOut, lWall, flatLevel), F(sHigh, lWall, flatLevel), F(sHigh, lOut, flatLevel), F(sOut, lOut, flatLevel)));
      if (e > EPS && !eaveFlat) {
        tris.push([F(sOut, lWall, yE - f), F(sLow, lWall, -f), F(sLow, lWall, flatLevel)]);
      }
      return;
    }
    const strip = (s0, y0, s1, y1, b0, b1) => {
      tris.push(...quad(F(s0, lOut, y0), F(s1, lOut, y1), F(s1, lOut, b1), F(s0, lOut, b0)));
    };
    if (e > EPS && eaveFlat) {
      strip(sOut, yE, sLow, 0, yE - f, yE - f);
      tris.push(...quad(F(sLow, lWall, yE - f), F(sLow, lOut, yE - f), F(sLow, lOut, -f), F(sLow, lWall, -f)));
      strip(sLow, 0, sHigh, roofHeight, -f, roofHeight - f);
      tris.push(...quad(F(sLow, lWall, -f), F(sLow, lOut, -f), F(sHigh, lOut, roofHeight - f), F(sHigh, lWall, roofHeight - f)));
    } else {
      const sStart = e > EPS ? sOut : sLow;
      const yStart = e > EPS ? yE : 0;
      strip(sStart, yStart, sHigh, roofHeight, yStart - f, roofHeight - f);
      tris.push(...quad(F(sStart, lWall, yStart - f), F(sStart, lOut, yStart - f), F(sHigh, lOut, roofHeight - f), F(sHigh, lWall, roofHeight - f)));
    }
  });
  return tris;
}
