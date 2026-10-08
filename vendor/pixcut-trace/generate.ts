import { findContours, rotateToNearest } from './contours.ts';
import { binarize, dilateMask } from './mask.ts';
import { applyOvercut } from './overcut.ts';
import { decodePng } from './png.ts';
import { PLT_VERSION, encodePlt, pltStats } from './plt.ts';
import { simplifyContour } from './simplify.ts';
import { pathToUnits, resolvePlacement } from './transform.ts';
import type { ChainApproximation } from './contours.ts';
import type { BinarizeOptions, KernelShape } from './mask.ts';
import type { OvercutOptions } from './overcut.ts';
import type { PltDocument, PltStats } from './plt.ts';
import type { SimplifyOptions } from './simplify.ts';
import type { FillMethod, Placement } from './transform.ts';
import type { BinaryMask, Contour, Point, Polyline, RasterImage } from './types.ts';
import { PARK_UNITS, PRINT_DPI } from './units.ts';
import type { SheetGeometry } from './units.ts';

/** Where each closed path starts, which is where the blade enters and leaves. */
export type SeamAnchor =
  /** The corner nearest the sheet origin: bottom-left of the source image. Matches the stock generator. */
  | 'sheet-origin'
  /** Wherever boundary tracing began, which is the topmost then leftmost pixel. */
  | 'trace-start'
  /** A specific source-pixel location. */
  | Point;

export interface GenerateOptions {
  /** Knife pressure written to the `KP` header. Firmware accepts 0 to 3. Default 1. */
  knifePressure?: number;
  /**
   * Grow the mask outward by this many **millimetres** before tracing, widening the
   * sticker margin. Default 0.
   *
   * The stock generator's `dilation` argument is in millimetres too: passing 12
   * widens the cut by 478 cut units on each side, which is 11.95 mm.
   */
  dilation?: number;
  /** Structuring element used for `dilation`. Default `'ellipse'`. */
  dilationShape?: KernelShape;
  /** Rotate the finished path about the sheet centre, in degrees. Default 0. */
  angle?: number;

  /** Sheet to lay the path out on. Defaults to the 4x7 cut canvas. */
  sheet?: SheetGeometry;
  /** Default `'fit'`. */
  fillMethod?: FillMethod;
  /** Overscan factor so the blade tracks outside the printed edge. Default 1.01333. */
  scaleRatio?: number;
  /** Inset the placement box by this many print pixels per side. Default 0. */
  margin?: number;

  /** How the image is reduced to a mask. */
  binarize?: BinarizeOptions;
  /** Minimum region area in square pixels, or `'auto'`. Default `'auto'`. */
  minArea?: number | 'auto';
  /** Keep every boundary pixel, or only the endpoints of straight runs. Default `'simple'`. */
  chainApproximation?: ChainApproximation;
  /** Cut holes as well as outlines. Default false. */
  includeHoles?: boolean;
  /** Cap on regions, largest first. Default 100. */
  maxContours?: number;

  /** Path simplification. */
  simplify?: SimplifyOptions;
  /** Lead-in and lead-out ramps. Pass `false` to emit bare outlines. */
  overcut?: OvercutOptions | false;
  /** Add ramps to hole paths too. Default true, matching `extension.inner-enabled`. */
  overcutHoles?: boolean;
  /** Default `'sheet-origin'`. */
  seam?: SeamAnchor;

  /** Override the `VER` string. */
  version?: string;
  /** Final park move. Pass `null` to omit it. */
  park?: Point | null;
}

export interface GenerateResult {
  /** The PLT file contents. */
  plt: string;
  /** The same cut data in structured form. */
  document: PltDocument;
  /** Measurements of the result. */
  stats: PltStats;
  /** Simplified regions in source-pixel space, before placement. Useful for previews. */
  contours: Contour[];
  /** The binarized mask the trace ran on. */
  mask: BinaryMask;
  /** How the image was laid onto the sheet. */
  placement: Placement;
}

function seamAnchorFor(seam: SeamAnchor, width: number, height: number): Point | undefined {
  if (seam === 'trace-start') return undefined;
  if (seam === 'sheet-origin') return { x: 0, y: height - 1 };
  void width;
  return seam;
}

/**
 * Turn a raster image into a cut path.
 *
 * The pipeline mirrors the stock generator: binarize, optionally dilate, trace region
 * boundaries, simplify in two passes, add the seam ramps, then place onto the sheet
 * and serialize. Every stage is exposed individually if you need to intervene.
 */
export function generateCutPath(
  image: RasterImage,
  options: GenerateOptions = {},
): GenerateResult {
  const {
    knifePressure = 1,
    dilation = 0,
    dilationShape = 'ellipse',
    angle = 0,
    minArea = 'auto',
    chainApproximation = 'simple',
    includeHoles = false,
    maxContours = 100,
    overcutHoles = true,
    seam = 'sheet-origin',
  } = options;

  const { width, height } = image;
  const placement = resolvePlacement(width, height, options);

  let mask = binarize(image, options.binarize);
  if (dilation > 0) {
    // Millimetres on the sheet, converted back through the placement so the margin is
    // a physical distance rather than a fraction of whatever the source resolution is.
    const gridPixelsPerMm = PRINT_DPI / 25.4;
    const radius = Math.floor((dilation * gridPixelsPerMm) / placement.scale);
    mask = dilateMask(mask, radius, dilationShape);
  }

  const traced = findContours(mask, { minArea, chainApproximation, includeHoles, maxContours });
  const anchor = seamAnchorFor(seam, width, height);

  const prepare = (path: Polyline): Polyline => {
    const simplified = simplifyContour(path, options.simplify);
    return anchor === undefined ? simplified : rotateToNearest(simplified, anchor);
  };

  const contours: Contour[] = traced
    .map((contour) => ({
      outer: prepare(contour.outer),
      inners: contour.inners.map(prepare).filter((inner) => inner.length >= 3),
    }))
    // Anything left with fewer than three vertices is a line, not an outline, and
    // cutting it would drive the blade out and back along itself.
    .filter((contour) => contour.outer.length >= 3);

  const toUnits = (path: Polyline): Polyline =>
    pathToUnits(path, width, height, { ...options, angle, placement });

  const paths: Polyline[] = [];
  for (const contour of contours) {
    const outer =
      options.overcut === false ? [...contour.outer, contour.outer[0]!] : applyOvercut(contour.outer, options.overcut);
    const mapped = toUnits(outer);
    if (mapped.length >= 2) paths.push(mapped);

    for (const inner of contour.inners) {
      const ramped =
        options.overcut === false || !overcutHoles
          ? [...inner, inner[0]!]
          : applyOvercut(inner, options.overcut);
      const mappedInner = toUnits(ramped);
      if (mappedInner.length >= 2) paths.push(mappedInner);
    }
  }

  const document: PltDocument = {
    version: options.version ?? PLT_VERSION,
    knifePressure,
    paths,
  };
  const park = options.park === undefined ? { x: 0, y: PARK_UNITS } : options.park;
  if (park !== null) document.park = park;

  const encodeInput: Parameters<typeof encodePlt>[0] = {
    knifePressure,
    paths,
    park,
  };
  if (options.version !== undefined) encodeInput.version = options.version;

  return {
    plt: encodePlt(encodeInput),
    document,
    stats: pltStats(document),
    contours,
    mask,
    placement,
  };
}

/** Decode a PNG and generate its cut path in one call. */
export function generateCutPathFromPng(
  png: Uint8Array,
  options: GenerateOptions = {},
): GenerateResult {
  return generateCutPath(decodePng(png), options);
}
