/**
 * The PixCut cut coordinate system.
 *
 * One unit is 0.025 mm, i.e. 40 units per millimetre, which is the classic HPGL
 * plotter unit. Verified by generating a full-bleed 4x7 path with the stock
 * `ht_plt_core.dll`: the emitted rectangle is exactly 0..4061 by 0..7109, which
 * pins the sheet at 4064 x 7112 units = 101.6 x 177.8 mm.
 */
export const UNITS_PER_MM = 40;

/** Millimetres per cut unit. */
export const MM_PER_UNIT = 1 / UNITS_PER_MM;

/** Cut units per inch. */
export const UNITS_PER_INCH = 1016;

/** The raster resolution of the print engine, in dots per inch. */
export const PRINT_DPI = 300;

/**
 * Cut units per 300 dpi pixel, when a sheet-filling image is mapped onto the sheet.
 * 1016 / 300 = 3.38666...
 */
export const UNITS_PER_PRINT_PIXEL = UNITS_PER_INCH / PRINT_DPI;

/** Sheet geometry in cut units. */
export interface SheetGeometry {
  /** Human-readable label. */
  readonly label: string;
  /** Extent along the carriage axis, the second coordinate in a PLT pair. */
  readonly widthUnits: number;
  /** Extent along the feed axis, the first coordinate in a PLT pair. */
  readonly heightUnits: number;
}

/** 4 x 6 inch sheet. */
export const SHEET_4X6: SheetGeometry = { label: '4x6', widthUnits: 4064, heightUnits: 6096 };

/** 4 x 7 inch sheet. */
export const SHEET_4X7: SheetGeometry = { label: '4x7', widthUnits: 4064, heightUnits: 7112 };

/**
 * The cut canvas the generator always works in.
 *
 * The stock generator ignores the media-type argument and letterboxes the image
 * into the 4x7 sheet regardless, so a 4x6 image is centred on a 4x7 canvas.
 * Confirmed by generating from 1200x1800 and 1200x2100 sources: both produce the
 * same path centre, and both are byte-identical across media types 2010 and 2030.
 */
export const CUT_CANVAS: SheetGeometry = SHEET_4X7;

/**
 * Where the carriage parks at the end of every file, emitted as `U6476,0`.
 * 6476 units is 161.9 mm along the feed axis.
 */
export const PARK_UNITS = 6476;

/** Convert cut units to millimetres. */
export function unitsToMm(units: number): number {
  return units * MM_PER_UNIT;
}

/** Convert millimetres to cut units, rounded to the nearest unit. */
export function mmToUnits(mm: number): number {
  return Math.round(mm * UNITS_PER_MM);
}

/** Convert cut units to inches. */
export function unitsToInches(units: number): number {
  return units / UNITS_PER_INCH;
}
