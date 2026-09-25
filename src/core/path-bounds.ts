import type { PathElement } from '../shared/types';
import { normalizedSegments } from './schema';

function extrema(p0: number, p1: number, p2: number, p3?: number): number[] {
  const candidates = [0, 1];
  if (p3 === undefined) {
    const denominator = p0 - 2 * p1 + p2;
    if (Math.abs(denominator) > 1e-12) candidates.push((p0 - p1) / denominator);
    return candidates.filter((t) => t >= 0 && t <= 1).map((t) => (1 - t) ** 2 * p0 + 2 * (1 - t) * t * p1 + t ** 2 * p2);
  }
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2); const c = p1 - p0;
  if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) candidates.push(-c / b); }
  else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) { candidates.push((-b + Math.sqrt(discriminant)) / (2 * a)); candidates.push((-b - Math.sqrt(discriminant)) / (2 * a)); }
  }
  return candidates.filter((t) => t >= 0 && t <= 1).map((t) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3);
}

/** Exact extrema of the normalized line/quadratic/cubic path, excluding stroke. */
export function pathBounds(element: PathElement) {
  let x = 0; let y = 0; let startX = 0; let startY = 0;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  const include = (xs: number[], ys: number[]) => {
    minX = Math.min(minX, ...xs); maxX = Math.max(maxX, ...xs);
    minY = Math.min(minY, ...ys); maxY = Math.max(maxY, ...ys);
  };
  for (const [command, ...v] of normalizedSegments(element)) {
    if (command === 'M' || command === 'L') {
      [x, y] = v;
      if (command === 'M') { startX = x; startY = y; }
      include([x], [y]);
    } else if (command === 'Q') {
      include(extrema(x, v[0], v[2]), extrema(y, v[1], v[3])); [x, y] = v.slice(-2);
    } else if (command === 'C') {
      include(extrema(x, v[0], v[2], v[4]), extrema(y, v[1], v[3], v[5])); [x, y] = v.slice(-2);
    } else if (command === 'Z') { x = startX; y = startY; include([x], [y]); }
  }
  return { minX, minY, maxX, maxY };
}
