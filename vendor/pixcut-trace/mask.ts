import type { BinaryMask, RasterImage } from './types.ts';

/** How the source image is reduced to a foreground/background mask. */
export type BinarizeMode =
  /** Use the alpha channel when the image has one that varies, else fall back to luminance. */
  | 'auto'
  /** Always threshold the alpha channel. Fails loudly on fully opaque images. */
  | 'alpha'
  /** Always threshold luminance, treating light pixels as background. */
  | 'luminance';

export interface BinarizeOptions {
  /** Default `'auto'`. */
  mode?: BinarizeMode;
  /**
   * Luminance at or above which a pixel counts as background. Default 240, the
   * value the stock generator ships. Raise it to keep more of a light subject.
   */
  threshold?: number;
  /** Alpha at or above which a pixel counts as foreground. Default 128. */
  alphaThreshold?: number;
  /** Odd side length of a separable Gaussian blur applied before thresholding. 0 disables it. */
  blurKernelSize?: number;
  /** Drop connected foreground regions smaller than this many pixels. Default 0. */
  minBlobArea?: number;
}

/** Raised when the requested binarization cannot be applied to the given image. */
export class MaskError extends Error {
  override readonly name = 'MaskError';
}

/** ITU-R BT.601 luma, matching OpenCV's `COLOR_BGR2GRAY`. */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** True when at least one pixel is not fully opaque. */
export function hasAlphaVariation(image: RasterImage): boolean {
  const { data } = image;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

/** OpenCV's implied sigma for a given `GaussianBlur` kernel size. */
function sigmaForKernel(size: number): number {
  return 0.3 * ((size - 1) * 0.5 - 1) + 0.8;
}

function gaussianKernel(size: number): Float64Array {
  const sigma = sigmaForKernel(size);
  const half = (size - 1) / 2;
  const kernel = new Float64Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - half;
    const v = Math.exp(-(d * d) / (2 * sigma * sigma));
    kernel[i] = v;
    sum += v;
  }
  for (let i = 0; i < size; i++) kernel[i]! /= sum;
  return kernel;
}

/** Separable Gaussian blur on a single-channel plane, with edge clamping. */
export function blurPlane(
  plane: Float64Array,
  width: number,
  height: number,
  size: number,
): Float64Array {
  if (size <= 1) return plane;
  if (size % 2 === 0) throw new MaskError(`Blur kernel size must be odd, got ${size}`);
  const kernel = gaussianKernel(size);
  const half = (size - 1) / 2;
  const tmp = new Float64Array(plane.length);
  const out = new Float64Array(plane.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = 0; k < size; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k - half));
        acc += plane[row + sx]! * kernel[k]!;
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = 0; k < size; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k - half));
        acc += tmp[sy * width + x]! * kernel[k]!;
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

/**
 * Remove connected foreground regions below `minArea` pixels, 8-connected.
 * Mutates and returns the mask.
 */
export function removeSmallBlobs(mask: BinaryMask, minArea: number): BinaryMask {
  if (minArea <= 1) return mask;
  const { width, height, data } = mask;
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const region = new Int32Array(width * height);

  for (let start = 0; start < data.length; start++) {
    if (data[start] === 0 || seen[start] === 1) continue;
    let top = 0;
    let count = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const p = stack[--top]!;
      region[count++] = p;
      const px = p % width;
      const py = (p - px) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
          const q = ny * width + nx;
          if (data[q] === 255 && seen[q] === 0) {
            seen[q] = 1;
            stack[top++] = q;
          }
        }
      }
    }
    if (count < minArea) {
      for (let i = 0; i < count; i++) data[region[i]!] = 0;
    }
  }
  return mask;
}

/**
 * Reduce an RGBA raster to a foreground mask, following the stock generator's rules.
 *
 * An RGBA image whose alpha channel varies is thresholded on alpha: transparent
 * becomes background, opaque becomes foreground. A fully opaque image falls back to
 * luminance, where pixels lighter than the threshold become background. That is why
 * a subject on a white studio background traces without any manual cutout.
 */
export function binarize(image: RasterImage, options: BinarizeOptions = {}): BinaryMask {
  const {
    mode = 'auto',
    threshold = 240,
    alphaThreshold = 128,
    blurKernelSize = 0,
    minBlobArea = 0,
  } = options;

  const { width, height, data } = image;
  const count = width * height;
  const useAlpha =
    mode === 'alpha' || (mode === 'auto' && hasAlphaVariation(image));

  if (mode === 'alpha' && !hasAlphaVariation(image)) {
    throw new MaskError(
      'Alpha binarization was requested but the image is fully opaque. Use mode "luminance" or "auto".',
    );
  }

  const plane = new Float64Array(count);
  if (useAlpha) {
    for (let i = 0; i < count; i++) plane[i] = data[i * 4 + 3]!;
  } else {
    for (let i = 0; i < count; i++) {
      const p = i * 4;
      plane[i] = luma(data[p]!, data[p + 1]!, data[p + 2]!);
    }
  }

  const smoothed = blurPlane(plane, width, height, blurKernelSize);
  const out = new Uint8Array(count);
  if (useAlpha) {
    for (let i = 0; i < count; i++) out[i] = smoothed[i]! >= alphaThreshold ? 255 : 0;
  } else {
    for (let i = 0; i < count; i++) out[i] = smoothed[i]! < threshold ? 255 : 0;
  }

  const mask: BinaryMask = { width, height, data: out };
  return removeSmallBlobs(mask, minBlobArea);
}

/** Shape of a morphological structuring element. */
export type KernelShape = 'ellipse' | 'rectangle' | 'cross';

const INFINITY_COST = 1e20;

/** Felzenszwalb and Huttenlocher's exact 1D squared distance transform. */
function distanceTransform1d(f: Float64Array, n: number, out: Float64Array): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -INFINITY_COST;
  z[1] = INFINITY_COST;

  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INFINITY_COST;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const d = q - v[k]!;
    out[q] = d * d + f[v[k]!]!;
  }
}

/**
 * Squared Euclidean distance from every pixel to the nearest pixel matching `target`.
 *
 * Exact and linear in the pixel count, which matters because a millimetre-scale
 * dilation on a 300 dpi grid means a radius of well over a hundred pixels.
 */
export function squaredDistanceTransform(mask: BinaryMask, target: 0 | 255): Float64Array {
  const { width, height, data } = mask;
  const cost = new Float64Array(width * height);
  for (let i = 0; i < data.length; i++) cost[i] = data[i] === target ? 0 : INFINITY_COST;

  const column = new Float64Array(height);
  const columnOut = new Float64Array(height);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) column[y] = cost[y * width + x]!;
    distanceTransform1d(column, height, columnOut);
    for (let y = 0; y < height; y++) cost[y * width + x] = columnOut[y]!;
  }

  const row = new Float64Array(width);
  const rowOut = new Float64Array(width);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) row[x] = cost[base + x]!;
    distanceTransform1d(row, width, rowOut);
    for (let x = 0; x < width; x++) cost[base + x] = rowOut[x]!;
  }
  return cost;
}

/** Sliding-window extremum over one axis, used for the separable kernel shapes. */
function extremumFilter(
  data: Uint8Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
  maximum: boolean,
): Uint8Array {
  const out = new Uint8Array(data.length);
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const step = horizontal ? 1 : width;

  for (let o = 0; o < outer; o++) {
    const base = horizontal ? o * width : o;
    for (let i = 0; i < inner; i++) {
      let value = maximum ? 0 : 255;
      const from = Math.max(0, i - radius);
      const to = Math.min(inner - 1, i + radius);
      // Outside the frame reads as background, so erosion trims at the border.
      if (!maximum && (i - radius < 0 || i + radius > inner - 1)) value = 0;
      else {
        for (let j = from; j <= to; j++) {
          const sample = data[base + j * step]!;
          if (maximum ? sample > value : sample < value) value = sample;
        }
      }
      out[base + i * step] = value;
    }
  }
  return out;
}

function morph(mask: BinaryMask, radius: number, shape: KernelShape, dilate: boolean): BinaryMask {
  const rounded = Math.round(radius);
  if (rounded <= 0) return mask;
  const { width, height, data } = mask;

  if (shape === 'ellipse') {
    const distances = squaredDistanceTransform(mask, dilate ? 255 : 0);
    const limit = rounded * rounded;
    const out = new Uint8Array(data.length);
    for (let i = 0; i < out.length; i++) {
      out[i] = dilate ? (distances[i]! <= limit ? 255 : 0) : distances[i]! > limit ? 255 : 0;
    }
    if (!dilate) {
      // Erosion must also trim against the frame edge.
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const margin = Math.min(x, y, width - 1 - x, height - 1 - y);
          if (margin < rounded) out[y * width + x] = 0;
        }
      }
    }
    return { width, height, data: out };
  }

  if (shape === 'rectangle') {
    const pass = extremumFilter(data, width, height, rounded, true, dilate);
    return { width, height, data: extremumFilter(pass, width, height, rounded, false, dilate) };
  }

  // A cross is the union of its two arms, so combine the axes rather than chaining them.
  const horizontal = extremumFilter(data, width, height, rounded, true, dilate);
  const vertical = extremumFilter(data, width, height, rounded, false, dilate);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < out.length; i++) {
    const a = horizontal[i]!;
    const b = vertical[i]!;
    out[i] = dilate ? Math.max(a, b) : Math.min(a, b);
  }
  return { width, height, data: out };
}

/**
 * Grow the foreground by `radius` pixels.
 *
 * This is what the generator's `dilation` argument drives: a larger radius pushes the
 * cut line further outside the printed subject, which is the sticker margin control.
 */
export function dilateMask(
  mask: BinaryMask,
  radius: number,
  shape: KernelShape = 'ellipse',
): BinaryMask {
  return morph(mask, radius, shape, true);
}

/** Shrink the foreground by `radius` pixels. */
export function erodeMask(
  mask: BinaryMask,
  radius: number,
  shape: KernelShape = 'ellipse',
): BinaryMask {
  return morph(mask, radius, shape, false);
}

/** Render a mask as an opaque black-and-white RGBA raster, for previews. */
export function maskToImage(mask: BinaryMask): RasterImage {
  const { width, height, data } = mask;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    const d = i * 4;
    rgba[d] = v;
    rgba[d + 1] = v;
    rgba[d + 2] = v;
    rgba[d + 3] = 255;
  }
  return { width, height, data: rgba };
}
