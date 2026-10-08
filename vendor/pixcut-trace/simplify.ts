import { pathLength, polygonArea } from './contours.ts';
import type { Point, Polyline } from './types.ts';

/** Convex hull by Andrew's monotone chain, returned counterclockwise in a y-up reading. */
export function convexHull(points: Polyline): Polyline {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const build = (input: Polyline): Polyline => {
    const stack: Point[] = [];
    for (const p of input) {
      while (stack.length >= 2 && cross(stack[stack.length - 2]!, stack[stack.length - 1]!, p) <= 0) {
        stack.pop();
      }
      stack.push(p);
    }
    return stack;
  };

  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Perpendicular distance from `p` to the segment `a`-`b`. */
function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer-Douglas-Peucker simplification of an open polyline.
 *
 * Closed contours are handled by {@link simplifyClosedDouglasPeucker}, which anchors
 * the split so the result stays closed.
 */
export function simplifyDouglasPeucker(path: Polyline, epsilon: number): Polyline {
  const n = path.length;
  if (n < 3 || epsilon <= 0) return [...path];

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    let farthest = -1;
    let maxDistance = epsilon;
    const a = path[first]!;
    const b = path[last]!;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(path[i]!, a, b);
      if (d > maxDistance) {
        maxDistance = d;
        farthest = i;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i] === 1) out.push(path[i]!);
  }
  return out;
}

/**
 * Douglas-Peucker for a closed contour.
 *
 * The contour is split at its two most distant vertices so simplification cannot
 * collapse the seam, then the halves are simplified independently and rejoined.
 */
export function simplifyClosedDouglasPeucker(path: Polyline, epsilon: number): Polyline {
  const n = path.length;
  if (n < 4 || epsilon <= 0) return [...path];

  const first = path[0]!;
  let opposite = 0;
  let best = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(path[i]!.x - first.x, path[i]!.y - first.y);
    if (d > best) {
      best = d;
      opposite = i;
    }
  }

  const head = simplifyDouglasPeucker(path.slice(0, opposite + 1), epsilon);
  const tail = simplifyDouglasPeucker([...path.slice(opposite), first], epsilon);
  const simplified = [...head.slice(0, -1), ...tail.slice(0, -1)];

  // A large epsilon can flatten both halves down to their shared endpoints, leaving a
  // two-vertex path. That is not a shape: cutting it drives the blade out and back
  // along one line. Keep the vertex that departs furthest from that line so the result
  // stays a closed figure, matching the floor Visvalingam-Whyatt already enforces.
  if (simplified.length >= 3) return simplified;
  return restoreMinimumVertices(path, simplified);
}

/** Re-add the most significant vertices until a closed path has at least three. */
function restoreMinimumVertices(path: Polyline, simplified: Polyline): Polyline {
  const out = [...simplified];
  while (out.length < 3 && out.length < path.length) {
    const a = out[0]!;
    const b = out[out.length - 1] ?? a;
    let best: Point | undefined;
    let bestDistance = -1;
    for (const candidate of path) {
      if (out.some((kept) => kept.x === candidate.x && kept.y === candidate.y)) continue;
      const d = out.length >= 2 ? perpendicularDistance(candidate, a, b) : Math.hypot(candidate.x - a.x, candidate.y - a.y);
      if (d > bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    if (best === undefined) break;
    out.push(best);
  }
  return out;
}

interface HeapEntry {
  index: number;
  area: number;
  version: number;
}

/**
 * Visvalingam-Whyatt simplification: drop vertices whose effective triangle area is
 * below `maxArea`, recomputing neighbours as the shape changes.
 *
 * The stock generator ships `max-area: 15`, in square pixels.
 */
export function simplifyVisvalingamWhyatt(path: Polyline, maxArea: number): Polyline {
  const n = path.length;
  if (n < 4 || maxArea <= 0) return [...path];

  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const version = new Int32Array(n);
  const alive = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  prev[0] = n - 1;
  next[n - 1] = 0;

  const triangleArea = (i: number): number => {
    const a = path[prev[i]!]!;
    const b = path[i]!;
    const c = path[next[i]!]!;
    return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  };

  const heap: HeapEntry[] = [];
  const push = (entry: HeapEntry): void => {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.area <= heap[i]!.area) break;
      const tmp = heap[parent]!;
      heap[parent] = heap[i]!;
      heap[i] = tmp;
      i = parent;
    }
  };
  const pop = (): HeapEntry | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heap.length && heap[left]!.area < heap[smallest]!.area) smallest = left;
        if (right < heap.length && heap[right]!.area < heap[smallest]!.area) smallest = right;
        if (smallest === i) break;
        const tmp = heap[smallest]!;
        heap[smallest] = heap[i]!;
        heap[i] = tmp;
        i = smallest;
      }
    }
    return top;
  };

  for (let i = 0; i < n; i++) push({ index: i, area: triangleArea(i), version: 0 });

  let remaining = n;
  for (;;) {
    const entry = pop();
    if (entry === undefined) break;
    const { index } = entry;
    if (alive[index] === 0 || entry.version !== version[index]) continue;
    if (entry.area >= maxArea) break;
    if (remaining <= 3) break;

    alive[index] = 0;
    remaining--;
    const p = prev[index]!;
    const q = next[index]!;
    next[p] = q;
    prev[q] = p;
    for (const neighbour of [p, q]) {
      version[neighbour] = version[neighbour]! + 1;
      push({ index: neighbour, area: triangleArea(neighbour), version: version[neighbour]! });
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    if (alive[i] === 1) out.push(path[i]!);
  }
  return out;
}

/** Shape descriptors used to pick a simplification strength. */
export interface ContourMetrics {
  vertexCount: number;
  /** Closed perimeter in pixels. */
  perimeter: number;
  /** Enclosed area in square pixels. */
  area: number;
  /** Convex-hull perimeter divided by contour perimeter, in (0, 1]. 1 means fully convex. */
  convexity: number;
  /** Mean absolute turn angle per vertex, in radians. */
  meanCurvature: number;
  /** Isoperimetric ratio, 1 for a circle and lower for elongated or ragged shapes. */
  circularity: number;
}

/**
 * Measure a closed contour.
 *
 * These are this library's own definitions. The stock generator blends four
 * similarly named quantities (`circumference`, `curvature`, `convexity`, `gradient`)
 * into a single score, but the exact weighting is not recoverable from its binary,
 * so the epsilon it picks is not reproduced here. Use {@link simplifyToPointCount}
 * when you need a deterministic vertex budget.
 */
export function contourMetrics(path: Polyline): ContourMetrics {
  const n = path.length;
  const perimeter = pathLength(path, true);
  const area = polygonArea(path);
  const hullPerimeter = n >= 3 ? pathLength(convexHull(path), true) : perimeter;

  let turn = 0;
  if (n >= 3) {
    for (let i = 0; i < n; i++) {
      const a = path[(i - 1 + n) % n]!;
      const b = path[i]!;
      const c = path[(i + 1) % n]!;
      const angle = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
      let normalised = angle;
      while (normalised > Math.PI) normalised -= 2 * Math.PI;
      while (normalised < -Math.PI) normalised += 2 * Math.PI;
      turn += Math.abs(normalised);
    }
  }

  return {
    vertexCount: n,
    perimeter,
    area,
    convexity: perimeter > 0 ? Math.min(1, hullPerimeter / perimeter) : 1,
    meanCurvature: n > 0 ? turn / n : 0,
    circularity: perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0,
  };
}

export interface PointCountOptions {
  /** Lower bound of the epsilon search, as a fraction of the contour perimeter. Default 1e-6. */
  minEpsilonRatio?: number;
  /** Upper bound of the epsilon search, as a fraction of the contour perimeter. Default 0.05. */
  maxEpsilonRatio?: number;
  /** Binary-search iterations. Default 40. */
  iterations?: number;
}

/**
 * Simplify a closed contour to approximately `targetPoints` vertices by binary
 * searching the Douglas-Peucker epsilon.
 *
 * Returns the tightest result that does not exceed the target, so the output has at
 * most `targetPoints` vertices whenever that is achievable above the 3-vertex floor.
 */
export function simplifyToPointCount(
  path: Polyline,
  targetPoints: number,
  options: PointCountOptions = {},
): Polyline {
  const { minEpsilonRatio = 1e-6, maxEpsilonRatio = 0.05, iterations = 40 } = options;
  if (path.length <= Math.max(3, targetPoints)) return [...path];

  const perimeter = pathLength(path, true);
  if (perimeter === 0) return [...path];

  let low = minEpsilonRatio * perimeter;
  let high = maxEpsilonRatio * perimeter;
  let best = simplifyClosedDouglasPeucker(path, high);

  for (let i = 0; i < iterations; i++) {
    const mid = (low + high) / 2;
    const candidate = simplifyClosedDouglasPeucker(path, mid);
    if (candidate.length > targetPoints) {
      low = mid;
    } else {
      best = candidate;
      high = mid;
    }
  }
  return best;
}

/** Resample a closed contour to exactly `count` points at equal arc-length spacing. */
export function resampleUniform(path: Polyline, count: number): Polyline {
  const n = path.length;
  if (n < 3 || count < 3 || count >= n) return [...path];

  const cumulative = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = path[i]!;
    const b = path[(i + 1) % n]!;
    cumulative[i + 1] = cumulative[i]! + Math.hypot(b.x - a.x, b.y - a.y);
  }
  const total = cumulative[n]!;
  if (total === 0) return [...path];

  const out: Point[] = [];
  let segment = 0;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / count;
    while (segment < n - 1 && cumulative[segment + 1]! < target) segment++;
    const spanStart = cumulative[segment]!;
    const spanLength = cumulative[segment + 1]! - spanStart;
    const t = spanLength > 0 ? (target - spanStart) / spanLength : 0;
    const a = path[segment]!;
    const b = path[(segment + 1) % n]!;
    out.push({
      x: Math.round(a.x + (b.x - a.x) * t),
      y: Math.round(a.y + (b.y - a.y) * t),
    });
  }
  return out;
}

export interface SimplifyOptions {
  /** Visvalingam-Whyatt effective-area threshold in square pixels. 0 disables the pass. Default 15. */
  maxArea?: number;
  /**
   * Douglas-Peucker epsilon as a fraction of the contour perimeter. 0 disables the
   * pass. Default 0.00055, the midpoint of the stock generator's 0.0001 to 0.001
   * range, which is also what `fromStockConfig` derives from a stock config.
   */
  epsilonRatio?: number;
  /** When set, overrides `epsilonRatio` and searches for an epsilon hitting this vertex budget. */
  targetPoints?: number;
}

/** Run the two-pass simplification the generator uses: Visvalingam-Whyatt, then Douglas-Peucker. */
export function simplifyContour(path: Polyline, options: SimplifyOptions = {}): Polyline {
  const { maxArea = 15, epsilonRatio = 0.00055, targetPoints } = options;
  let out = maxArea > 0 ? simplifyVisvalingamWhyatt(path, maxArea) : [...path];
  if (targetPoints !== undefined) {
    out = simplifyToPointCount(out, targetPoints);
  } else if (epsilonRatio > 0) {
    out = simplifyClosedDouglasPeucker(out, epsilonRatio * pathLength(out, true));
  }
  return out;
}
