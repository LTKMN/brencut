import type { Point, Polyline } from './types.ts';

export interface OvercutOptions {
  /** Number of ramp vertices on each side. 0 disables the ramp. Default 3. */
  steps?: number;
  /** Angle of the outermost ramp vertex, in degrees. Default 45. */
  maxDegree?: number;
  /**
   * Radius of the outermost ramp vertex, in tenths of a pixel-decade: the radius in
   * pixels is `maxLength * 10`. Default 1.5, giving a 15 pixel reach.
   * The odd unit is the stock generator's, kept so configs port across unchanged.
   */
  maxLength?: number;
  /** Round ramp vertices to whole pixels, as the stock generator does. Default true. */
  snapToPixels?: boolean;
}

interface Vector {
  x: number;
  y: number;
}

function normalise(v: Vector): Vector {
  const length = Math.hypot(v.x, v.y);
  if (length === 0) return { x: 0, y: 0 };
  return { x: v.x / length, y: v.y / length };
}

/**
 * Unit vector perpendicular to `along`, pointing to the same side as `toward`.
 * Falls back to the left normal when the two are collinear.
 */
function perpendicularToward(along: Vector, toward: Vector): Vector {
  const dot = along.x * toward.x + along.y * toward.y;
  const rejected = { x: toward.x - along.x * dot, y: toward.y - along.y * dot };
  if (Math.hypot(rejected.x, rejected.y) < 1e-9) return { x: -along.y, y: along.x };
  return normalise(rejected);
}

function ramp(
  anchor: Point,
  along: Vector,
  toward: Vector,
  steps: number,
  maxDegree: number,
  radius: number,
  snap: boolean,
): Polyline {
  const perpendicular = perpendicularToward(along, toward);
  const out: Point[] = [];
  for (let k = 1; k <= steps; k++) {
    const angle = ((maxDegree * k) / steps) * (Math.PI / 180);
    const r = (radius * k) / steps;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = anchor.x + r * (along.x * cos + perpendicular.x * sin);
    const y = anchor.y + r * (along.y * cos + perpendicular.y * sin);
    out.push(snap ? { x: Math.floor(x), y: Math.floor(y) } : { x, y });
  }
  return out;
}

/**
 * Close a contour and add the lead-in and lead-out ramps that keep the blade from
 * leaving an uncut tab at the seam.
 *
 * The input is a closed contour given without a repeated final point. The output is
 * the full cutting sequence: the lead-in approaching the seam from outside, the
 * contour itself, the closing point, then the lead-out leaving on the mirror side.
 *
 * Geometry, measured against `ht_plt_core.dll` across four parameter sets: ramp
 * vertex `k` of `steps` sits at radius `maxLength * 10 * k / steps` pixels and angle
 * `maxDegree * k / steps` degrees, swung off the closing-edge direction toward the
 * reverse of the outgoing edge. Radii and angles match the stock generator to better
 * than 1%; individual ramp vertices can differ by up to about 1.5 px because of how
 * it snaps to the pixel grid. Ramp vertices are travel and approach only, so they do
 * not move the cut outline.
 */
export function applyOvercut(contour: Polyline, options: OvercutOptions = {}): Polyline {
  const { steps = 3, maxDegree = 45, maxLength = 1.5, snapToPixels = true } = options;
  const n = contour.length;
  if (n < 2) return [...contour];

  const first = contour[0]!;
  const closed: Point[] = [...contour, first];
  if (steps <= 0 || maxLength <= 0) return closed;

  const previous = contour[n - 1]!;
  const nextPoint = contour[1]!;

  // Direction of the closing edge, and the reverse of the outgoing edge.
  const closingEdge = normalise({ x: first.x - previous.x, y: first.y - previous.y });
  const backAlongOutgoing = normalise({ x: first.x - nextPoint.x, y: first.y - nextPoint.y });
  if (closingEdge.x === 0 && closingEdge.y === 0) return closed;

  const radius = maxLength * 10;
  const inward = { x: -closingEdge.x, y: -closingEdge.y };

  const leadIn = ramp(
    first,
    inward,
    backAlongOutgoing,
    steps,
    maxDegree,
    radius,
    snapToPixels,
  ).reverse();
  const leadOut = ramp(
    first,
    closingEdge,
    backAlongOutgoing,
    steps,
    maxDegree,
    radius,
    snapToPixels,
  );

  return [...leadIn, ...closed, ...leadOut];
}
