import { CUT_CANVAS, UNITS_PER_PRINT_PIXEL } from './units.ts';
import type { Point, Polyline } from './types.ts';
import type { SheetGeometry as Sheet } from './units.ts';

/** How the source image is placed on the sheet. */
export type FillMethod =
  /** Contain: scale until the whole image fits, letterboxing the remainder. */
  | 'fit'
  /** Cover: scale until the sheet is covered, cropping the overflow. */
  | 'fill';

export interface PlacementOptions {
  /** Sheet to place onto. Defaults to the 4x7 cut canvas the generator always uses. */
  sheet?: Sheet;
  /** Default `'fit'`. */
  fillMethod?: FillMethod;
  /**
   * Overscan factor applied on top of the fit scale, so the blade tracks marginally
   * outside the printed edge. Default 1.01333, the stock `scale-ratio`.
   */
  scaleRatio?: number;
  /**
   * Inset the placement box by this many print pixels on every side.
   * The stock generator carries a `margin` field but ignores it; this honours it.
   */
  margin?: number;
  /**
   * Clamp points that fall outside the sheet back onto its edge, which is what the
   * stock generator's raster crop does. Default true. Set false to keep overscanned
   * coordinates as they are.
   */
  clip?: boolean;
}

/** A resolved source-pixel to cut-unit mapping. */
export interface Placement {
  readonly sheet: Sheet;
  /** Print-grid size of the sheet, in pixels at 300 dpi. */
  readonly gridWidth: number;
  readonly gridHeight: number;
  /** Scale from source pixels to print-grid pixels, including `scaleRatio`. */
  readonly scale: number;
  /** Size of the placed image on the print grid, in whole pixels. */
  readonly placedWidth: number;
  readonly placedHeight: number;
  /** Offset of the placed image on the print grid. Negative means the image is cropped. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Resolve how a source image of the given size lands on the sheet.
 *
 * Mirrors the stock generator, which resizes the mask onto the sheet's 300 dpi print
 * grid before tracing, then maps that grid to cut units with one uniform scale.
 */
export function resolvePlacement(
  imageWidth: number,
  imageHeight: number,
  options: PlacementOptions = {},
): Placement {
  const {
    sheet = CUT_CANVAS,
    fillMethod = 'fit',
    scaleRatio = 1.01333,
    margin = 0,
  } = options;

  if (imageWidth < 2 || imageHeight < 2) {
    throw new RangeError(`Image must be at least 2x2 pixels, got ${imageWidth}x${imageHeight}`);
  }

  const gridWidth = Math.round(sheet.widthUnits / UNITS_PER_PRINT_PIXEL);
  const gridHeight = Math.round(sheet.heightUnits / UNITS_PER_PRINT_PIXEL);
  const boxWidth = gridWidth - 2 * margin;
  const boxHeight = gridHeight - 2 * margin;
  if (boxWidth <= 0 || boxHeight <= 0) {
    throw new RangeError(`Margin ${margin} leaves no room on a ${gridWidth}x${gridHeight} grid`);
  }

  const byWidth = boxWidth / imageWidth;
  const byHeight = boxHeight / imageHeight;
  const base = fillMethod === 'fill' ? Math.max(byWidth, byHeight) : Math.min(byWidth, byHeight);
  const scale = base * scaleRatio;

  const placedWidth = Math.round(imageWidth * scale);
  const placedHeight = Math.round(imageHeight * scale);

  return {
    sheet,
    gridWidth,
    gridHeight,
    scale,
    placedWidth,
    placedHeight,
    offsetX: (gridWidth - placedWidth) / 2,
    offsetY: (gridHeight - placedHeight) / 2,
  };
}

/** Map one source pixel onto the print grid. Fractional, before rounding to units. */
function toGrid(
  point: Point,
  placement: Placement,
  imageWidth: number,
  imageHeight: number,
): { x: number; y: number } {
  const { offsetX, offsetY, placedWidth, placedHeight } = placement;
  return {
    x: offsetX + (point.x * (placedWidth - 1)) / (imageWidth - 1),
    y: offsetY + (point.y * (placedHeight - 1)) / (imageHeight - 1),
  };
}

/**
 * Rotate a point about the sheet origin.
 *
 * Matches the stock generator, which rotates in place and lets coordinates go
 * negative rather than re-centring on the sheet: a 90 degree turn of a path spanning
 * x 1016..3048, y 2029..5077 lands on x 2029..5077, y -3048..-1016.
 */
export function rotateAboutOrigin(point: Point, degrees: number): Point {
  if (degrees === 0) return point;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: Math.round(point.x * cos + point.y * sin),
    y: Math.round(-point.x * sin + point.y * cos),
  };
}

export interface ToUnitsOptions extends PlacementOptions {
  /** Rotation about the sheet origin, in degrees. Default 0. */
  angle?: number;
  /** Reuse a placement already resolved for this image size. */
  placement?: Placement;
}

/**
 * Convert a source-pixel path to cut units.
 *
 * The feed axis is flipped, because the sheet's origin sits at the far end of the
 * paper path from the image's top-left. Coordinates are rounded to whole units.
 *
 * Verified against `ht_plt_core.dll`: for sources at or below the sheet's 300 dpi
 * print grid, the emitted extents match exactly. Sources that must be scaled down to
 * fit can differ by up to about 1.5 px, because the stock generator resamples and
 * re-thresholds the mask where this maps the traced path directly.
 */
export function pathToUnits(
  path: Polyline,
  imageWidth: number,
  imageHeight: number,
  options: ToUnitsOptions = {},
): Polyline {
  const { angle = 0, clip = true } = options;
  const placement = options.placement ?? resolvePlacement(imageWidth, imageHeight, options);
  const { sheet, gridHeight } = placement;
  const canvasScale = sheet.widthUnits / placement.gridWidth;

  const clamp = (value: number, limit: number): number =>
    value < 0 ? 0 : value > limit ? limit : value;
  // The crop happens on the print grid, so the far edge is the last grid pixel
  // expressed in units, not the sheet's last unit.
  const maxX = Math.round((placement.gridWidth - 1) * canvasScale);
  const maxY = Math.round((gridHeight - 1) * canvasScale);

  const out: Point[] = [];
  for (const point of path) {
    const grid = toGrid(point, placement, imageWidth, imageHeight);
    let x = Math.round(grid.x * canvasScale);
    let y = Math.round((gridHeight - 1 - grid.y) * canvasScale);
    // Overscan pushes part of the image off the sheet. The stock generator crops the
    // mask, so the boundary lands on the sheet edge rather than disappearing.
    if (clip) {
      x = clamp(x, maxX);
      y = clamp(y, maxY);
    }
    out.push(rotateAboutOrigin({ x, y }, angle));
  }
  return out;
}

/** Convert a cut-unit path back to source-pixel space. Inverse of {@link pathToUnits}. */
export function pathToPixels(
  path: Polyline,
  imageWidth: number,
  imageHeight: number,
  options: PlacementOptions = {},
): Polyline {
  const placement = resolvePlacement(imageWidth, imageHeight, options);
  const { sheet, gridHeight, offsetX, offsetY, placedWidth, placedHeight } = placement;
  const canvasScale = sheet.widthUnits / placement.gridWidth;

  return path.map((point) => {
    const gridX = point.x / canvasScale;
    const gridY = gridHeight - 1 - point.y / canvasScale;
    return {
      x: ((gridX - offsetX) * (imageWidth - 1)) / (placedWidth - 1),
      y: ((gridY - offsetY) * (imageHeight - 1)) / (placedHeight - 1),
    };
  });
}

/** Axis-aligned bounds of a path, or undefined when it is empty. */
export function boundsOf(paths: readonly Polyline[]):
  | { minX: number; minY: number; maxX: number; maxY: number }
  | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const point of path) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (minX === Infinity) return undefined;
  return { minX, minY, maxX, maxY };
}
