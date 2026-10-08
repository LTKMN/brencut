/**
 * pixcut: a cut-path toolchain for the Liene PixCut S1 photo sticker printer.
 *
 * The machine is a dye-sublimation printer with a knife plotter in the same paper
 * path, and it has no vectoriser of its own: the host computes the cut outline and
 * ships it as an explicit coordinate list. This library builds that list.
 *
 * ```ts
 * import { readFile, writeFile } from 'node:fs/promises';
 * import { generateCutPathFromPng } from 'pixcut';
 *
 * const png = await readFile('sticker.png');
 * const { plt, stats } = generateCutPathFromPng(png, { knifePressure: 1 });
 * await writeFile('cut.plt', plt);
 * console.log(`${stats.pathCount} paths, ${stats.cutLengthMm.toFixed(1)} mm of cutting`);
 * ```
 *
 * There is no transport layer here. Sending a job to the printer needs USB or
 * Bluetooth plus a Diffie-Hellman handshake, which would pull in native
 * dependencies; {@link TRANSPORT} records what is known about the link instead.
 */

export type {
  BinaryMask,
  Contour,
  Point,
  Polyline,
  RasterImage,
  Winding,
} from './types.ts';

export {
  CUT_CANVAS,
  MM_PER_UNIT,
  PARK_UNITS,
  PRINT_DPI,
  SHEET_4X6,
  SHEET_4X7,
  UNITS_PER_INCH,
  UNITS_PER_MM,
  UNITS_PER_PRINT_PIXEL,
  mmToUnits,
  unitsToInches,
  unitsToMm,
} from './units.ts';
export type { SheetGeometry } from './units.ts';

export { PngError, decodePng, encodePng } from './png.ts';

export {
  MaskError,
  binarize,
  blurPlane,
  dilateMask,
  erodeMask,
  hasAlphaVariation,
  maskToImage,
  removeSmallBlobs,
  squaredDistanceTransform,
} from './mask.ts';
export type { BinarizeMode, BinarizeOptions, KernelShape } from './mask.ts';

export {
  autoMinArea,
  compressChain,
  findContours,
  orient,
  pathLength,
  polygonArea,
  rotateToNearest,
  signedArea,
  windingOf,
} from './contours.ts';
export type { ChainApproximation, FindContoursOptions } from './contours.ts';

export {
  contourMetrics,
  convexHull,
  resampleUniform,
  simplifyClosedDouglasPeucker,
  simplifyContour,
  simplifyDouglasPeucker,
  simplifyToPointCount,
  simplifyVisvalingamWhyatt,
} from './simplify.ts';
export type { ContourMetrics, PointCountOptions, SimplifyOptions } from './simplify.ts';

export { applyOvercut } from './overcut.ts';
export type { OvercutOptions } from './overcut.ts';

export {
  boundsOf,
  pathToPixels,
  pathToUnits,
  resolvePlacement,
  rotateAboutOrigin,
} from './transform.ts';
export type { FillMethod, Placement, PlacementOptions, ToUnitsOptions } from './transform.ts';

export { PLT_VERSION, PltError, encodePlt, parsePlt, pltStats } from './plt.ts';
export type { EncodeOptions, PltDocument, PltStats } from './plt.ts';

export { generateCutPath, generateCutPathFromPng } from './generate.ts';
export type { GenerateOptions, GenerateResult, SeamAnchor } from './generate.ts';

export { renderContoursSvg, renderPltSvg } from './svg.ts';
export type { ContourSvgOptions, SvgOptions } from './svg.ts';

export {
  IGNORED_STOCK_FIELDS,
  STOCK_DEFAULT_CONFIG,
  fromStockConfig,
  withStockDefaults,
} from './config.ts';
export type { StockConfig } from './config.ts';

export {
  JOB_TYPES,
  MEDIA_SIZES,
  MEDIA_TYPES,
  PIXCUT_S1,
  PRINTER_ERRORS,
  PRINTER_MODELS,
  PRINT_LIMITS,
  PROTOCOL_OPERATIONS,
  TRANSPORT,
  findPrinterError,
} from './codes.ts';
export type {
  ErrorCategory,
  ErrorRecovery,
  JobType,
  PrinterError,
  PrinterModel,
  ProtocolOperation,
} from './codes.ts';
