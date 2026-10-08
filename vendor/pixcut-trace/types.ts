/** A point in some 2D space. Integer-valued in pixel and plotter-unit space. */
export interface Point {
  x: number;
  y: number;
}

/** An open or closed sequence of points. Closed paths repeat the first point at the end. */
export type Polyline = Point[];

/**
 * One traced region: its outer boundary plus the boundaries of any holes inside it.
 * Coordinates are in source-image pixel space, origin top-left.
 */
export interface Contour {
  outer: Polyline;
  inners: Polyline[];
}

/** Winding direction of a closed path, by signed area in a y-down coordinate system. */
export type Winding = 'clockwise' | 'counterclockwise';

/** An 8-bit RGBA raster, row-major, `width * height * 4` bytes. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A single-channel 8-bit image where 255 is foreground (cut region) and 0 is background. */
export interface BinaryMask {
  width: number;
  height: number;
  data: Uint8Array;
}
