/**
 * Utilities for footprint validation, metric calculation, and normalization.
 */

/**
 * Validates the supplied footprint polygon.
 *
 * @param {Array<[number, number]>} vertices - Footprint vertices in X/Z plane.
 * @param {{ expectedWinding?: 'CCW' | 'CW' }} [options] - Winding expectation.
 * @returns {{ valid: boolean, errors: string[], metrics: object }}
 */
export function validateFootprint(vertices, options = {}) {
  const { expectedWinding = 'CCW' } = options;
  const errors = [];
  const ring = ensureClosedRing(vertices);

  if (ring.length < 3) {
    errors.push('Footprint must contain at least three vertices.');
  }

  if (!isClosedRing(ring)) {
    errors.push('Footprint must be closed (first and last vertex must match).');
  }

  if (ring.length >= 4 && hasSelfIntersections(ring)) {
    errors.push('Footprint contains self-intersections.');
  }

  const metrics = computeFootprintMetrics(ring);
  const area = metrics.area;

  if (area <= 0) {
    errors.push('Footprint area must be greater than zero.');
  }

  const isExpectedDirection = expectedWinding === 'CCW' ? metrics.signedArea > 0 : metrics.signedArea < 0;
  if (!isExpectedDirection) {
    errors.push(
      expectedWinding === 'CCW'
        ? 'Footprint winding must be counter-clockwise (CCW).'
        : 'Footprint winding must be clockwise (CW).'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    metrics,
  };
}

/**
 * Returns polygon metrics in the X/Z plane.
 *
 * @param {Array<[number, number]>} vertices - Footprint vertices in X/Z plane.
 * @returns {{ area: number, perimeter: number, centroid: {x: number, z: number}, bbox: {minX: number, minZ: number, maxX: number, maxZ: number}, signedArea: number }}
 */
export function computeFootprintMetrics(vertices) {
  const ring = ensureClosedRing(vertices);
  const signedArea = polygonSignedArea(ring);
  const area = Math.abs(signedArea);

  let perimeter = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[i + 1];
    perimeter += Math.hypot(x2 - x1, z2 - z1);
  }

  const centroid = computeCentroid(ring);
  const bounds = computeBounds(ring);

  return {
    area,
    perimeter,
    centroid,
    bbox: bounds,
    signedArea,
  };
}

/**
 * Reorients a footprint to the expected winding and translates it to centroid origin.
 *
 * @param {Array<[number, number]>} vertices - Footprint vertices in X/Z plane.
 * @param {{ expectedWinding?: 'CCW' | 'CW' }} [options] - Winding expectation.
 * @returns {Array<[number, number]>}
 */
export function normalizeFootprint(vertices, options = {}) {
  const { expectedWinding = 'CCW' } = options;
  const ring = ensureClosedRing(vertices);
  const oriented = orientToWinding(ring, expectedWinding);
  const centroid = computeCentroid(oriented);

  return oriented.map(([x, z]) => [x - centroid.x, z - centroid.z]);
}

function ensureClosedRing(vertices) {
  const ring = vertices.map(([x, z]) => [Number(x), Number(z)]);
  if (ring.length === 0) {
    return ring;
  }

  const first = ring[0];
  const last = ring[ring.length - 1];

  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }

  return ring;
}

function isClosedRing(vertices) {
  if (vertices.length < 2) {
    return false;
  }

  const first = vertices[0];
  const last = vertices[vertices.length - 1];
  return Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6;
}

function polygonSignedArea(vertices) {
  let area = 0;
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const [x1, z1] = vertices[i];
    const [x2, z2] = vertices[i + 1];
    area += x1 * z2 - x2 * z1;
  }
  return area / 2;
}

function orientToWinding(vertices, expectedWinding = 'CCW') {
  const verticesNoDuplicate = isClosedRing(vertices)
    ? vertices.slice(0, -1)
    : [...vertices];

  const signedArea = polygonSignedArea([...verticesNoDuplicate, verticesNoDuplicate[0]]);
  const currentWinding = signedArea > 0 ? 'CCW' : 'CW';

  if (expectedWinding === currentWinding) {
    return [...verticesNoDuplicate];
  }

  return [...verticesNoDuplicate].reverse();
}

function computeCentroid(vertices) {
  const ring = ensureClosedRing(vertices);
  let area = 0;
  let cx = 0;
  let cz = 0;

  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, z1] = ring[i];
    const [x2, z2] = ring[i + 1];
    const cross = x1 * z2 - x2 * z1;
    area += cross;
    cx += (x1 + x2) * cross;
    cz += (z1 + z2) * cross;
  }

  if (Math.abs(area) < 1e-9) {
    return { x: 0, z: 0 };
  }

  const scale = 1 / (3 * area);
  return {
    x: cx * scale,
    z: cz * scale,
  };
}

function computeBounds(vertices) {
  const xs = vertices.map(([x]) => x);
  const zs = vertices.map(([, z]) => z);

  return {
    minX: Math.min(...xs),
    minZ: Math.min(...zs),
    maxX: Math.max(...xs),
    maxZ: Math.max(...zs),
  };
}

function hasSelfIntersections(vertices) {
  const ring = ensureClosedRing(vertices);

  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];

    for (let j = i + 1; j < ring.length - 1; j += 1) {
      if (Math.abs(i - j) <= 1) {
        continue;
      }

      if (i === 0 && j === ring.length - 2) {
        continue;
      }

      const c = ring[j];
      const d = ring[j + 1];

      if (segmentsIntersect(a, b, c, d)) {
        return true;
      }
    }
  }

  return false;
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (o1 === 0 && onSegment(a, c, b)) {
    return true;
  }
  if (o2 === 0 && onSegment(a, d, b)) {
    return true;
  }
  if (o3 === 0 && onSegment(c, a, d)) {
    return true;
  }
  if (o4 === 0 && onSegment(c, b, d)) {
    return true;
  }

  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0);
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, c) {
  return (
    b[0] <= Math.max(a[0], c[0]) + 1e-6 &&
    b[0] >= Math.min(a[0], c[0]) - 1e-6 &&
    b[1] <= Math.max(a[1], c[1]) + 1e-6 &&
    b[1] >= Math.min(a[1], c[1]) - 1e-6
  );
}
