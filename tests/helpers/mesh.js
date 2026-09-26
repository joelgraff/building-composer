/** Mesh inspection helpers shared by the geometry tests. */

/** The triangles of a mesh's (non-indexed) geometry, in the mesh's own frame. */
export function meshTriangles(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const out = [];
  for (let i = 0; i < pos.count; i += 3) {
    out.push([0, 1, 2].map((k) => [pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)]));
  }
  return out;
}

export const triangleArea = ([a, b, c]) => {
  const u = b.map((v, i) => v - a[i]);
  const w = c.map((v, i) => v - a[i]);
  return 0.5 * Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
};

export const totalArea = (tris) => tris.reduce((sum, tri) => sum + triangleArea(tri), 0);

/**
 * Edges used by exactly one triangle, i.e. the boundary of the shell. Edges
 * are split at any vertex lying on them first, so a long edge that meets two
 * shorter neighbors (a T-junction) still counts as closed.
 */
export function openTriangleEdges(tris) {
  const key = (p) => p.map((v) => v.toFixed(3)).join(',');
  const unique = new Map();
  tris.flat().forEach((p) => unique.set(key(p), p));
  const points = [...unique.values()];
  const between = (a, b, p) => {
    const ab = b.map((v, i) => v - a[i]);
    const ap = p.map((v, i) => v - a[i]);
    const len2 = ab.reduce((sum, v) => sum + v * v, 0);
    const t = ap.reduce((sum, v, i) => sum + v * ab[i], 0) / len2;
    if (t <= 1e-6 || t >= 1 - 1e-6) { return null; }
    const off = ap.map((v, i) => v - ab[i] * t);
    return Math.hypot(...off) < 1e-6 ? t : null;
  };
  const counts = new Map();
  tris.forEach((tri) => {
    [[0, 1], [1, 2], [2, 0]].forEach(([i, j]) => {
      const a = tri[i];
      const b = tri[j];
      const stops = points.map((p) => [between(a, b, p), p]).filter(([t]) => t !== null).sort((x, y) => x[0] - y[0]).map(([, p]) => p);
      const chain = [a, ...stops, b];
      for (let k = 0; k < chain.length - 1; k += 1) {
        const ka = key(chain[k]);
        const kb = key(chain[k + 1]);
        const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    });
  });
  return [...counts].filter(([, n]) => n === 1).map(([k]) => k.split('|').map((s) => s.split(',').map(Number)));
}
