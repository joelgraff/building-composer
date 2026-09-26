/** Mesh inspection helpers shared by the geometry tests. */

/** The triangles of a mesh's geometry, in the mesh's own frame. */
export function meshTriangles(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.index;
  const count = index ? index.count : pos.count;
  const out = [];
  for (let i = 0; i < count; i += 3) {
    out.push([0, 1, 2].map((k) => {
      const v = index ? index.getX(i + k) : i + k;
      return [pos.getX(v), pos.getY(v), pos.getZ(v)];
    }));
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
  // (+0 so that -0.000 and 0.000 are the same point)
  const key = (p) => p.map((v) => (Number(v.toFixed(3)) + 0).toFixed(3)).join(',');
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
        if (ka === kb) {
          continue; // a sliver edge, zero length at this precision
        }
        const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    });
  });
  return [...counts].filter(([, n]) => n === 1).map(([k]) => k.split('|').map((s) => s.split(',').map(Number)));
}

const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const unitNormal = ([a, b, c]) => {
  const n = cross(sub(b, a), sub(c, a));
  const length = Math.hypot(...n);
  return length > 0 ? n.map((v) => v / length) : null;
};

/** Whether `point` lies on triangle `tri` (within `tolerance`). */
function onTriangle(point, tri, normal, tolerance) {
  if (Math.abs(dot(sub(point, tri[0]), normal)) > tolerance) {
    return false;
  }
  return [0, 1, 2].every((i) => {
    const a = tri[i];
    const b = tri[(i + 1) % 3];
    return dot(cross(sub(b, a), sub(point, a)), normal) >= -tolerance * Math.hypot(...sub(b, a));
  });
}

/**
 * Open edges with nothing behind them: an open edge where one surface butts
 * into the middle of another (a wall standing on a roof, a roof ending on a
 * wall face) is closed to the eye, so it only counts if some point along it
 * lies on no other, non-coplanar surface.
 */
export function uncoveredEdges(tris, edges = openTriangleEdges(tris), tolerance = 2e-3) {
  const faces = tris.map((tri) => ({ tri, normal: unitNormal(tri) })).filter((face) => face.normal);
  return edges.filter((edge) => {
    // the triangles this edge is a side of (not ones it merely crosses)
    const onSegment = (p, a, b) => {
      const ab = sub(b, a);
      const t = dot(sub(p, a), ab) / dot(ab, ab);
      return t >= -1e-6 && t <= 1 + 1e-6 && Math.hypot(...sub(sub(p, a), ab.map((v) => v * t))) < tolerance;
    };
    const owners = faces.filter(({ tri }) => [0, 1, 2].some((i) => edge.every((p) => onSegment(p, tri[i], tri[(i + 1) % 3]))));
    return [0.2, 0.5, 0.8].some((t) => {
      const point = edge[0].map((v, i) => v + (edge[1][i] - v) * t);
      return !faces.some(({ tri, normal }) => onTriangle(point, tri, normal, tolerance)
        && owners.every((owner) => Math.abs(dot(owner.normal, normal)) < 1 - 1e-6));
    });
  });
}
