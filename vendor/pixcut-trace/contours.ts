import type { BinaryMask, Contour, Point, Polyline, Winding } from './types.ts';

/** Neighbour offsets in clockwise order for a y-down coordinate system, starting at West. */
const DX = Int8Array.of(-1, -1, 0, 1, 1, 1, 0, -1);
const DY = Int8Array.of(0, -1, -1, -1, 0, 1, 1, 1);

function directionIndex(dx: number, dy: number): number {
  for (let i = 0; i < 8; i++) {
    if (DX[i] === dx && DY[i] === dy) return i;
  }
  throw new Error(`(${dx}, ${dy}) is not an 8-neighbour offset`);
}

/** Signed area of a closed polygon by the shoelace formula. Positive is clockwise when y points down. */
export function signedArea(path: Polyline): number {
  const n = path.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = path[j]!;
    const b = path[i]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Absolute enclosed area of a closed polygon, in square pixels. */
export function polygonArea(path: Polyline): number {
  return Math.abs(signedArea(path));
}

/** Winding direction of a closed polygon. */
export function windingOf(path: Polyline): Winding {
  return signedArea(path) >= 0 ? 'clockwise' : 'counterclockwise';
}

/** Return `path` wound in the requested direction, reversing a copy when needed. */
export function orient(path: Polyline, winding: Winding): Polyline {
  return windingOf(path) === winding ? path : [...path].reverse();
}

/** Total length of a polyline. Set `closed` to include the closing segment. */
export function pathLength(path: Polyline, closed = true): number {
  const n = path.length;
  if (n < 2) return 0;
  let total = 0;
  for (let i = 1; i < n; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (closed) {
    const a = path[n - 1]!;
    const b = path[0]!;
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

/**
 * Rotate a closed path so it begins at the vertex nearest `anchor`.
 *
 * The seam is where the blade enters and leaves, so moving it changes where the
 * lead-in mark lands. The stock generator seams at the sheet origin, which is the
 * bottom-left of the source image once the feed axis is flipped.
 */
export function rotateToNearest(path: Polyline, anchor: Point): Polyline {
  const n = path.length;
  if (n < 2) return [...path];
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < n; i++) {
    const p = path[i]!;
    const d = (p.x - anchor.x) ** 2 + (p.y - anchor.y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }
  if (bestIndex === 0) return [...path];
  return [...path.slice(bestIndex), ...path.slice(0, bestIndex)];
}

/**
 * Moore-neighbour boundary tracing with a state-repetition stop condition.
 *
 * `start` must satisfy `inside`, and `back` must be an 8-neighbour of `start` that
 * does not. Returns the boundary pixels once each, without repeating the first
 * point at the end.
 */
function traceBoundary(
  inside: (x: number, y: number) => boolean,
  start: Point,
  back: Point,
  maxSteps: number,
): Polyline {
  const path: Polyline = [];
  let curX = start.x;
  let curY = start.y;
  let backX = back.x;
  let backY = back.y;
  let firstCurX = -1;
  let firstCurY = -1;
  let firstBackX = -1;
  let firstBackY = -1;
  let steps = 0;

  for (;;) {
    path.push({ x: curX, y: curY });

    const from = directionIndex(backX - curX, backY - curY);
    let prevX = backX;
    let prevY = backY;
    let nextX = -1;
    let nextY = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (from + k) & 7;
      const nx = curX + DX[d]!;
      const ny = curY + DY[d]!;
      if (inside(nx, ny)) {
        nextX = nx;
        nextY = ny;
        break;
      }
      prevX = nx;
      prevY = ny;
    }
    if (nextX < 0) break;

    backX = prevX;
    backY = prevY;
    curX = nextX;
    curY = nextY;

    if (firstCurX < 0) {
      firstCurX = curX;
      firstCurY = curY;
      firstBackX = backX;
      firstBackY = backY;
    } else if (
      curX === firstCurX &&
      curY === firstCurY &&
      backX === firstBackX &&
      backY === firstBackY
    ) {
      break;
    }
    if (++steps > maxSteps) break;
  }

  const last = path[path.length - 1];
  const head = path[0];
  if (path.length > 1 && last !== undefined && head !== undefined) {
    if (last.x === head.x && last.y === head.y) path.pop();
  }
  return path;
}

/**
 * Drop the interior vertices of straight runs, keeping only their endpoints.
 *
 * Equivalent to OpenCV's `CHAIN_APPROX_SIMPLE`: a traced boundary walks one pixel at
 * a time, and every horizontal, vertical or diagonal run collapses to its two ends.
 * A traced rectangle goes from thousands of vertices to four.
 */
export function compressChain(path: Polyline): Polyline {
  const n = path.length;
  if (n < 3) return [...path];
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const previous = path[(i - 1 + n) % n]!;
    const current = path[i]!;
    const next = path[(i + 1) % n]!;
    const inX = Math.sign(current.x - previous.x);
    const inY = Math.sign(current.y - previous.y);
    const outX = Math.sign(next.x - current.x);
    const outY = Math.sign(next.y - current.y);
    if (inX !== outX || inY !== outY) out.push(current);
  }
  return out.length >= 3 ? out : [...path];
}

/** How much of a traced boundary to keep. */
export type ChainApproximation =
  /** Every boundary pixel. */
  | 'none'
  /** Endpoints of straight runs only, like OpenCV's `CHAIN_APPROX_SIMPLE`. */
  | 'simple';

export interface FindContoursOptions {
  /** Default `'simple'`. */
  chainApproximation?: ChainApproximation;
  /**
   * Minimum enclosed area, in square pixels, for a region to be kept.
   * `'auto'` derives a threshold from the image area, matching the stock
   * generator's dynamic filter. Default `'auto'`.
   */
  minArea?: number | 'auto';
  /** Include hole boundaries. Default false, matching the stock `contours.internal` flag. */
  includeHoles?: boolean;
  /** Winding to normalise outer boundaries to. Default `'clockwise'`. */
  outerWinding?: Winding;
  /** Winding to normalise hole boundaries to. Default `'counterclockwise'`. */
  innerWinding?: Winding;
  /** Cap on the number of regions returned, largest first. Default 100. */
  maxContours?: number;
}

/**
 * The stock generator's dynamic minimum-area threshold.
 *
 * Reproduces the value logged by `ht_plt_core.dll`: a 1200x1800 source reports a
 * dynamic minimum area of 1440 square pixels, which is the image area divided by 1500.
 */
export function autoMinArea(width: number, height: number): number {
  return (width * height) / 1500;
}

/**
 * Trace region boundaries out of a binary mask.
 *
 * Foreground regions are 8-connected; holes are 4-connected background regions that
 * do not reach the image border. Coordinates are pixel centres, so a solid
 * rectangle from (10, 10) to (20, 20) traces those exact corners.
 */
export function findContours(mask: BinaryMask, options: FindContoursOptions = {}): Contour[] {
  const {
    chainApproximation = 'simple',
    minArea = 'auto',
    includeHoles = false,
    outerWinding = 'clockwise',
    innerWinding = 'counterclockwise',
    maxContours = 100,
  } = options;
  const approximate = (path: Polyline): Polyline =>
    chainApproximation === 'simple' ? compressChain(path) : path;

  const { width, height, data } = mask;
  const threshold = minArea === 'auto' ? autoMinArea(width, height) : minArea;
  const maxSteps = 8 * width * height + 16;

  const isForeground = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && data[y * width + x] === 255;

  // Label foreground regions, 8-connected, recording each one's first pixel in raster order.
  const labels = new Int32Array(width * height).fill(-1);
  const seeds: Point[] = [];
  const stack = new Int32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (data[index] !== 255 || labels[index] !== -1) continue;
      const label = seeds.length;
      seeds.push({ x, y });
      let top = 0;
      stack[top++] = index;
      labels[index] = label;
      while (top > 0) {
        const p = stack[--top]!;
        const px = p % width;
        const py = (p - px) / width;
        for (let d = 0; d < 8; d++) {
          const nx = px + DX[d]!;
          const ny = py + DY[d]!;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (data[q] === 255 && labels[q] === -1) {
            labels[q] = label;
            stack[top++] = q;
          }
        }
      }
    }
  }

  const outers: Polyline[] = seeds.map((seed) =>
    traceBoundary(isForeground, seed, { x: seed.x - 1, y: seed.y }, maxSteps),
  );
  const holes: Polyline[][] = seeds.map(() => []);

  if (includeHoles) {
    // Label background regions, 4-connected. Anything reaching the border is outside.
    const bg = new Int32Array(width * height).fill(-1);
    const HOLE_DX = Int8Array.of(-1, 1, 0, 0);
    const HOLE_DY = Int8Array.of(0, 0, -1, 1);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = y * width + x;
        if (data[index] === 255 || bg[index] !== -1) continue;
        const region: number[] = [];
        let touchesBorder = false;
        let top = 0;
        stack[top++] = index;
        bg[index] = -2;
        while (top > 0) {
          const p = stack[--top]!;
          region.push(p);
          const px = p % width;
          const py = (p - px) / width;
          if (px === 0 || py === 0 || px === width - 1 || py === height - 1) touchesBorder = true;
          for (let d = 0; d < 4; d++) {
            const nx = px + HOLE_DX[d]!;
            const ny = py + HOLE_DY[d]!;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const q = ny * width + nx;
            if (data[q] !== 255 && bg[q] === -1) {
              bg[q] = -2;
              stack[top++] = q;
            }
          }
        }
        if (touchesBorder) continue;

        // The pixel above the region's topmost-leftmost cell is foreground and on the
        // inner border, because a background pixel there would belong to this region.
        const first = region.reduce((best, p) => (p < best ? p : best), region[0]!);
        const fx = first % width;
        const fy = (first - fx) / width;
        const owner = labels[(fy - 1) * width + fx]!;
        if (owner < 0) continue;
        holes[owner]!.push(
          traceBoundary(isForeground, { x: fx, y: fy - 1 }, { x: fx, y: fy }, maxSteps),
        );
      }
    }
  }

  const contours: Contour[] = [];
  for (let i = 0; i < outers.length; i++) {
    const outer = outers[i]!;
    if (outer.length < 3) continue;
    if (polygonArea(outer) < threshold) continue;
    contours.push({
      outer: orient(approximate(outer), outerWinding),
      inners: holes[i]!
        .filter((hole) => hole.length >= 3 && polygonArea(hole) >= threshold)
        .map((hole) => orient(approximate(hole), innerWinding)),
    });
  }

  contours.sort((a, b) => polygonArea(b.outer) - polygonArea(a.outer));
  return contours.slice(0, Math.max(0, maxContours));
}
