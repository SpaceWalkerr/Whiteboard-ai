/**
 * Ramer–Douglas–Peucker simplification of a flat [x0, y0, x1, y1, ...] polyline. Freehand
 * strokes produce a point per pointer event; this keeps the stored shape small.
 */
export function simplifyPoints(points: readonly number[], epsilon: number): number[] {
  const count = Math.floor(points.length / 2);
  if (count <= 2) return points.slice(0, count * 2);

  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const stack: [number, number][] = [[0, count - 1]];

  while (stack.length > 0) {
    const range = stack.pop();
    if (!range) break;
    const [first, last] = range;
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points, i, first, last);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }
    if (index !== -1 && maxDistance > epsilon) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    if (keep[i]) result.push(points[i * 2] ?? 0, points[i * 2 + 1] ?? 0);
  }
  return result;
}

function perpendicularDistance(points: readonly number[], i: number, a: number, b: number): number {
  const px = points[i * 2] ?? 0;
  const py = points[i * 2 + 1] ?? 0;
  const ax = points[a * 2] ?? 0;
  const ay = points[a * 2 + 1] ?? 0;
  const bx = points[b * 2] ?? 0;
  const by = points[b * 2 + 1] ?? 0;
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
}
