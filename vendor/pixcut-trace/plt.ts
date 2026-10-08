import { MM_PER_UNIT, PARK_UNITS } from './units.ts';
import type { Point, Polyline } from './types.ts';

/** Default format version string, as emitted by the stock generator. */
export const PLT_VERSION = '0.1.0';

/**
 * A parsed PLT cut file.
 *
 * Points use `x` for the carriage axis and `y` for the feed axis. Note that the
 * serialized form writes the feed coordinate first: `D2350,1002` is `y=2350, x=1002`.
 */
export interface PltDocument {
  /** The string after `VER`. */
  version: string;
  /** The integer after `KP`. Knife pressure, 0 to 3 on current firmware. */
  knifePressure: number;
  /** One entry per pen-down run. Each starts where its lead-in begins. */
  paths: Polyline[];
  /** Final carriage park position, or undefined when the file has none. */
  park?: Point;
}

/** Raised when a PLT file cannot be parsed. */
export class PltError extends Error {
  override readonly name = 'PltError';
}

/**
 * Coordinates have to survive a round trip through the text format.
 *
 * `Number.isInteger` alone is not enough: 1e21 is an integer to JavaScript but
 * stringifies as `1e+21`, which the move grammar cannot read back. Requiring a safe
 * integer keeps every value both exactly representable and printable in full.
 */
function checkCoordinate(value: number, axis: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new PltError(
      `Cut coordinates must be safe integers, got ${axis}=${value}. ` +
        'Values outside the safe integer range cannot round-trip through PLT text.',
    );
  }
}

function formatPoint(point: Point): string {
  checkCoordinate(point.x, 'x');
  checkCoordinate(point.y, 'y');
  return `${point.y},${point.x}`;
}

export interface EncodeOptions {
  /** Override the version string. Default `'0.1.0'`. */
  version?: string;
  /** Emit a trailing park move. Pass `null` to omit it. Default `{ x: 0, y: 6476 }`. */
  park?: Point | null;
}

/**
 * Serialize a cut document to PLT text.
 *
 * The layout is byte-exact against `ht_plt_core.dll`: single spaces between tokens,
 * two spaces before the `@` terminator, one trailing space, and no newline. Each path
 * opens with a blade-up move to its first point followed by a blade-down move to the
 * same point, which is how the stock generator seats the blade before cutting.
 */
export function encodePlt(
  document: Pick<PltDocument, 'knifePressure' | 'paths'> & EncodeOptions,
): string {
  const { knifePressure, paths } = document;
  const version = document.version ?? PLT_VERSION;
  const park = document.park === undefined ? { x: 0, y: PARK_UNITS } : document.park;

  if (!Number.isInteger(knifePressure) || knifePressure < 0) {
    throw new PltError(`Knife pressure must be a non-negative integer, got ${knifePressure}`);
  }

  const tokens: string[] = ['IN', `VER${version}`, `KP${knifePressure}`];
  for (const path of paths) {
    if (path.length === 0) continue;
    tokens.push(`U${formatPoint(path[0]!)}`);
    for (const point of path) tokens.push(`D${formatPoint(point)}`);
  }
  if (park !== null) tokens.push(`U${formatPoint(park)}`);

  return `${tokens.join(' ')}  @ `;
}

const MOVE = /^([UD])(-?\d+),(-?\d+)$/;

/**
 * Parse PLT text into paths. Tolerates any whitespace between tokens.
 *
 * A file with no trailing park move parses to `park: undefined`, which {@link encodePlt}
 * reads as "use the default". Pass `park: null` when re-encoding if you need the
 * result to stay parkless.
 */
export function parsePlt(text: string): PltDocument {
  const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) throw new PltError('File is empty');
  if (tokens[0] !== 'IN') throw new PltError(`Expected the file to open with IN, got "${tokens[0]}"`);

  let version = PLT_VERSION;
  let knifePressure = 0;
  let sawVersion = false;
  let sawPressure = false;
  // A path is a blade-up move followed by at least one blade-down move; the park is a
  // lone blade-up move. Tracking that flag is the only way to tell a single-vertex
  // path from a park, since both serialize to one coordinate pair.
  const groups: Array<{ points: Point[]; sawDown: boolean }> = [];
  let current: { points: Point[]; sawDown: boolean } | undefined;

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '@') break;

    if (token.startsWith('VER')) {
      version = token.slice(3);
      sawVersion = true;
      continue;
    }
    if (token.startsWith('KP')) {
      const value = Number.parseInt(token.slice(2), 10);
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new PltError(
          `Bad knife pressure token "${token}": expected a non-negative integer`,
        );
      }
      knifePressure = value;
      sawPressure = true;
      continue;
    }

    const match = MOVE.exec(token);
    if (match === null) throw new PltError(`Unrecognised token "${token}" at position ${i}`);
    const pen = match[1]!;
    const point: Point = { x: Number.parseInt(match[3]!, 10), y: Number.parseInt(match[2]!, 10) };
    // parseInt happily returns Infinity or a lossy float for very long digit runs,
    // which would poison pltStats and emit invalid SVG downstream.
    if (!Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) {
      throw new PltError(`Coordinate out of range in token "${token}" at position ${i}`);
    }

    if (pen === 'U') {
      current = { points: [point], sawDown: false };
      groups.push(current);
    } else {
      if (current === undefined) {
        current = { points: [point], sawDown: true };
        groups.push(current);
        continue;
      }
      const seating =
        !current.sawDown &&
        current.points.length === 1 &&
        current.points[0]!.x === point.x &&
        current.points[0]!.y === point.y;
      current.sawDown = true;
      // The blade-down move that seats on the blade-up point is the same vertex.
      if (!seating) current.points.push(point);
    }
  }

  if (!sawVersion) throw new PltError('Missing VER token');
  if (!sawPressure) throw new PltError('Missing KP token');

  let park: Point | undefined;
  const last = groups[groups.length - 1];
  if (last !== undefined && !last.sawDown) {
    park = last.points[0]!;
    groups.pop();
  }

  const result: PltDocument = { version, knifePressure, paths: groups.map((g) => g.points) };
  if (park !== undefined) result.park = park;
  return result;
}

/** Summary measurements for a cut document. */
export interface PltStats {
  pathCount: number;
  pointCount: number;
  /** Blade-down distance, in millimetres. */
  cutLengthMm: number;
  /** Blade-up distance between paths and to the park position, in millimetres. */
  travelLengthMm: number;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Extent of the cut area in millimetres, width across the carriage by length along the feed. */
  extentMm?: { width: number; height: number };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Measure a cut document: path counts, blade-down length, travel length and bounds. */
export function pltStats(document: PltDocument): PltStats {
  let cut = 0;
  let travel = 0;
  let pointCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let cursor: Point | undefined;

  for (const path of document.paths) {
    pointCount += path.length;
    for (let i = 0; i < path.length; i++) {
      const point = path[i]!;
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
      if (i === 0) {
        if (cursor !== undefined) travel += distance(cursor, point);
      } else {
        cut += distance(path[i - 1]!, point);
      }
    }
    cursor = path[path.length - 1];
  }
  if (document.park !== undefined && cursor !== undefined) {
    travel += distance(cursor, document.park);
  }

  const stats: PltStats = {
    pathCount: document.paths.length,
    pointCount,
    cutLengthMm: cut * MM_PER_UNIT,
    travelLengthMm: travel * MM_PER_UNIT,
  };
  if (minX !== Infinity) {
    stats.bounds = { minX, minY, maxX, maxY };
    stats.extentMm = {
      width: (maxX - minX) * MM_PER_UNIT,
      height: (maxY - minY) * MM_PER_UNIT,
    };
  }
  return stats;
}
