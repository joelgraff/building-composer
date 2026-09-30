/**
 * Porch posts in a style: each stands in the same square footprint (see
 * postRect in js/extrusion.js, which railings stop against), from `y0` to
 * `y1`, as triangles of [x, y, z]:
 * - `square`: a plain square post;
 * - `tapered`: a craftsman post, its square shaft narrowing upward, with a
 *   cap block;
 * - `round`: a round (Tuscan) column on a square plinth, its shaft swelling a
 *   little then tapering, under a round capital and a square block;
 * - `turned`: a lathe-turned post between square blocks at its foot and head.
 */

export const POST_STYLES = Object.freeze(['square', 'tapered', 'round', 'turned']);

const SEGMENTS = 12;

/** A post style from partial or older input (plain square unless set). */
export function normalizePostStyle(raw) {
  return POST_STYLES.includes(raw) ? raw : 'square';
}

/** A box from its plan rectangle ({ minX, maxX, minZ, maxZ }) shrunk by `inset` on every side, from `y0` to `y1`. */
function block(rect, inset, y0, y1) {
  return frustum(rect, inset, inset, y0, y1);
}

/** A square frustum: `insetBottom` in from the rectangle at `y0`, `insetTop` at `y1`. */
function frustum(rect, insetBottom, insetTop, y0, y1) {
  const corners = (inset, y) => [
    [rect.minX + inset, y, rect.minZ + inset], [rect.maxX - inset, y, rect.minZ + inset],
    [rect.maxX - inset, y, rect.maxZ - inset], [rect.minX + inset, y, rect.maxZ - inset],
  ];
  const bottom = corners(insetBottom, y0);
  const top = corners(insetTop, y1);
  const out = [[top[0], top[2], top[1]], [top[0], top[3], top[2]], [bottom[0], bottom[1], bottom[2]], [bottom[0], bottom[2], bottom[3]]];
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    out.push([bottom[i], top[j], bottom[j]], [bottom[i], top[i], top[j]]);
  }
  return out;
}

/** A solid of revolution round the rectangle's middle: `profile` is [t, r] from its foot (t = 0, at y0) to its head (t = 1, at y1). */
function lathe(rect, profile, y0, y1) {
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  const rings = profile.map(([t, r]) => Array.from({ length: SEGMENTS }, (_, k) => {
    const angle = (2 * Math.PI * k) / SEGMENTS;
    return [cx + r * Math.cos(angle), y0 + (y1 - y0) * t, cz + r * Math.sin(angle)];
  }));
  const out = [];
  for (let i = 0; i + 1 < rings.length; i += 1) {
    for (let k = 0; k < SEGMENTS; k += 1) {
      const k2 = (k + 1) % SEGMENTS;
      out.push([rings[i][k], rings[i + 1][k2], rings[i][k2]], [rings[i][k], rings[i + 1][k], rings[i + 1][k2]]);
    }
  }
  const cap = (ring, y, up) => ring.forEach((point, k) => {
    const next = ring[(k + 1) % SEGMENTS];
    out.push(up ? [[cx, y, cz], next, point] : [[cx, y, cz], point, next]);
  });
  cap(rings[0], rings[0][0][1], false);
  cap(rings[rings.length - 1], rings[rings.length - 1][0][1], true);
  return out;
}

/** A post in `style` standing in `rect` from `y0` to `y1`. */
export function postTriangles(style, rect, y0, y1) {
  const size = Math.min(rect.maxX - rect.minX, rect.maxZ - rect.minZ);
  const height = y1 - y0;
  const half = size / 2;
  if (style === 'tapered' && height > 0.4) {
    const cap = Math.min(0.12, height * 0.1);
    return [...frustum(rect, 0, size * 0.18, y0, y1 - cap), ...block(rect, 0, y1 - cap, y1)];
  }
  if (style === 'round' && height > 0.5) {
    const plinth = Math.min(0.12, height * 0.08);
    const head = Math.min(0.08, height * 0.06);
    const capital = Math.min(0.08, height * 0.06);
    const shaftTop = y1 - head - capital;
    const r = half * 0.8;
    return [
      ...block(rect, 0, y0, y0 + plinth),
      ...lathe(rect, [[0, r], [0.3, r * 1.03], [1, r * 0.85]], y0 + plinth, shaftTop),
      ...lathe(rect, [[0, r * 0.85], [0.5, half * 0.98], [1, half * 0.98]], shaftTop, shaftTop + capital),
      ...block(rect, 0, y1 - head, y1),
    ];
  }
  if (style === 'turned' && height > 0.8) {
    const foot = Math.min(0.5, height * 0.2);
    const headBlock = Math.min(0.3, height * 0.12);
    return [
      ...block(rect, 0, y0, y0 + foot),
      ...lathe(rect, [
        [0, half * 0.7], [0.05, half * 0.45], [0.15, half * 0.6], [0.4, half * 0.75], [0.65, half * 0.5], [0.85, half * 0.42], [0.93, half * 0.6], [1, half * 0.7],
      ], y0 + foot, y1 - headBlock),
      ...block(rect, 0, y1 - headBlock, y1),
    ];
  }
  return block(rect, 0, y0, y1);
}
