import { deflateSync, inflateSync } from 'node:zlib';
import type { RasterImage } from './types.ts';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Raised for any input that is not a PNG this decoder can read. */
export class PngError extends Error {
  override readonly name = 'PngError';
}

/**
 * Refuse images whose declared size alone would exhaust memory.
 *
 * 512 megapixels is far beyond anything a 4x7 inch sheet needs, and rejecting at the
 * header keeps a hostile IHDR from reaching an allocation that throws a bare
 * RangeError instead of a PngError.
 */
const MAX_PIXELS = 512 * 1024 * 1024;

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

function readHeader(bytes: Uint8Array, view: DataView, offset: number, length: number): Header {
  if (length !== 13) throw new PngError(`IHDR must be 13 bytes, got ${length}`);
  const width = view.getUint32(offset);
  const height = view.getUint32(offset + 4);
  const bitDepth = bytes[offset + 8]!;
  const colorType = bytes[offset + 9]!;
  const compression = bytes[offset + 10]!;
  const filter = bytes[offset + 11]!;
  const interlace = bytes[offset + 12]!;

  if (width <= 0 || height <= 0) throw new PngError(`Bad image size ${width}x${height}`);
  if (width * height > MAX_PIXELS) {
    throw new PngError(
      `Image is too large: ${width}x${height} exceeds the ${MAX_PIXELS} pixel limit`,
    );
  }
  if (compression !== 0) throw new PngError(`Unsupported compression method ${compression}`);
  if (filter !== 0) throw new PngError(`Unsupported filter method ${filter}`);
  if (CHANNELS_BY_COLOR_TYPE[colorType] === undefined) {
    throw new PngError(`Unsupported colour type ${colorType}`);
  }
  if (![1, 2, 4, 8, 16].includes(bitDepth)) {
    throw new PngError(`Unsupported bit depth ${bitDepth}`);
  }
  if (colorType !== 0 && colorType !== 3 && bitDepth < 8) {
    throw new PngError(`Bit depth ${bitDepth} is not valid for colour type ${colorType}`);
  }
  if (interlace === 1) {
    throw new PngError(
      'Interlaced (Adam7) PNGs are not supported. Re-save the file without interlacing.',
    );
  }
  if (interlace !== 0) throw new PngError(`Unsupported interlace method ${interlace}`);

  return { width, height, bitDepth, colorType };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverse the per-scanline filters, returning the raw sample bytes. */
function unfilter(raw: Uint8Array, height: number, bytesPerLine: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * bytesPerLine);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const type = raw[src++]!;
    const row = y * bytesPerLine;
    const prev = row - bytesPerLine;
    for (let i = 0; i < bytesPerLine; i++) {
      const x = raw[src + i]!;
      const a = i >= bpp ? out[row + i - bpp]! : 0;
      const b = y > 0 ? out[prev + i]! : 0;
      switch (type) {
        case 0:
          out[row + i] = x;
          break;
        case 1:
          out[row + i] = (x + a) & 0xff;
          break;
        case 2:
          out[row + i] = (x + b) & 0xff;
          break;
        case 3:
          out[row + i] = (x + ((a + b) >> 1)) & 0xff;
          break;
        case 4: {
          const c = i >= bpp && y > 0 ? out[prev + i - bpp]! : 0;
          out[row + i] = (x + paeth(a, b, c)) & 0xff;
          break;
        }
        default:
          throw new PngError(`Unknown scanline filter ${type} on row ${y}`);
      }
    }
    src += bytesPerLine;
  }
  return out;
}

/** Expand a sub-byte-depth image into one byte per sample, scaled to 0..255. */
function expandBits(
  samples: Uint8Array,
  header: Header,
  channels: number,
  isPalette: boolean,
): Uint8Array {
  const { width, height, bitDepth } = header;
  const perLine = Math.ceil((width * channels * bitDepth) / 8);
  const out = new Uint8Array(width * height * channels);
  const max = (1 << bitDepth) - 1;
  const scale = 255 / max;
  let o = 0;
  for (let y = 0; y < height; y++) {
    const base = y * perLine;
    let bit = 0;
    for (let i = 0; i < width * channels; i++) {
      const byte = samples[base + (bit >> 3)]!;
      const shift = 8 - bitDepth - (bit & 7);
      const value = (byte >> shift) & max;
      out[o++] = isPalette ? value : Math.round(value * scale);
      bit += bitDepth;
    }
  }
  return out;
}

/** Take the high byte of each 16-bit sample. */
function narrow16(samples: Uint8Array, count: number): Uint8Array {
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) out[i] = samples[i * 2]!;
  return out;
}

/**
 * Compare an expanded sample against a `tRNS` colour key.
 *
 * The key is stored at the image's own bit depth and is never rescaled, but
 * {@link expandBits} stretches sub-byte samples to 0..255 and {@link narrow16} takes
 * the high byte of 16-bit ones. The key has to make the same trip or it can never
 * match, which is what made colour keying silently inert below 8 bits.
 */
function matchesKey(sample: number, key: number | undefined, bitDepth: number): boolean {
  if (key === undefined) return false;
  if (bitDepth === 16) return sample === key >> 8;
  if (bitDepth < 8) return sample === Math.round((key * 255) / ((1 << bitDepth) - 1));
  return sample === key;
}

/**
 * Decode a non-interlaced PNG to an 8-bit RGBA raster.
 *
 * Supports colour types 0, 2, 3, 4 and 6 at bit depths 1, 2, 4, 8 and 16, plus
 * `tRNS` transparency. 16-bit samples are narrowed to their high byte, which is
 * lossless for the threshold decisions this library makes.
 */
export function decodePng(input: Uint8Array): RasterImage {
  if (input.length < 8) throw new PngError('Input is too short to be a PNG');
  for (let i = 0; i < 8; i++) {
    if (input[i] !== SIGNATURE[i]) throw new PngError('Missing PNG signature');
  }

  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let header: Header | undefined;
  let palette: Uint8Array | undefined;
  let paletteAlpha: Uint8Array | undefined;
  let colorKey: number[] | undefined;
  const idat: Uint8Array[] = [];

  let pos = 8;
  while (pos + 8 <= input.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(
      input[pos + 4]!,
      input[pos + 5]!,
      input[pos + 6]!,
      input[pos + 7]!,
    );
    const body = pos + 8;
    if (body + length + 4 > input.length) throw new PngError(`Chunk ${type} is truncated`);

    if (type === 'IHDR') {
      header = readHeader(input, view, body, length);
    } else if (type === 'PLTE') {
      palette = input.subarray(body, body + length);
    } else if (type === 'tRNS') {
      if (header === undefined) throw new PngError('tRNS appears before IHDR');
      if (header.colorType === 3) {
        paletteAlpha = input.subarray(body, body + length);
      } else {
        colorKey = [];
        for (let i = 0; i + 1 < length; i += 2) colorKey.push(view.getUint16(body + i));
      }
    } else if (type === 'IDAT') {
      idat.push(input.subarray(body, body + length));
    } else if (type === 'IEND') {
      break;
    }
    pos = body + length + 4;
  }

  if (header === undefined) throw new PngError('No IHDR chunk');
  if (idat.length === 0) throw new PngError('No IDAT chunks');

  const { width, height, bitDepth, colorType } = header;
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]!;
  const bytesPerLine = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));

  const expectedRaw = height * (bytesPerLine + 1);
  // Cap the inflate output at what IHDR implies. Without this a few tens of
  // kilobytes of IDAT can expand to hundreds of megabytes before any size check runs.
  let inflated: Uint8Array;
  try {
    inflated = new Uint8Array(
      inflateSync(Buffer.concat(idat), { maxOutputLength: expectedRaw }),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw new PngError(
        `Pixel data expands past the ${expectedRaw} bytes this ${width}x${height} image can hold`,
      );
    }
    throw new PngError(`Could not decompress pixel data: ${(error as Error).message}`);
  }
  if (inflated.length < expectedRaw) {
    throw new PngError(
      `Pixel data is short: expected ${expectedRaw} bytes, got ${inflated.length}`,
    );
  }

  const filtered = unfilter(inflated, height, bytesPerLine, bpp);
  const count = width * height * channels;
  let samples: Uint8Array;
  if (bitDepth === 16) samples = narrow16(filtered, count);
  else if (bitDepth === 8) samples = filtered;
  else samples = expandBits(filtered, header, channels, colorType === 3);

  const rgba = new Uint8Array(width * height * 4);

  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 0) {
      const g = samples[s]!;
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = colorKey !== undefined && matchesKey(g, colorKey[0], bitDepth) ? 0 : 255;
    } else if (colorType === 2) {
      const r = samples[s]!;
      const g = samples[s + 1]!;
      const b = samples[s + 2]!;
      rgba[d] = r;
      rgba[d + 1] = g;
      rgba[d + 2] = b;
      const keyed =
        colorKey !== undefined &&
        matchesKey(r, colorKey[0], bitDepth) &&
        matchesKey(g, colorKey[1], bitDepth) &&
        matchesKey(b, colorKey[2], bitDepth);
      rgba[d + 3] = keyed ? 0 : 255;
    } else if (colorType === 3) {
      if (palette === undefined) throw new PngError('Indexed PNG has no PLTE chunk');
      const index = samples[s]!;
      const p = index * 3;
      if (p + 2 >= palette.length) throw new PngError(`Palette index ${index} is out of range`);
      rgba[d] = palette[p]!;
      rgba[d + 1] = palette[p + 1]!;
      rgba[d + 2] = palette[p + 2]!;
      rgba[d + 3] = paletteAlpha !== undefined ? (paletteAlpha[index] ?? 255) : 255;
    } else if (colorType === 4) {
      const g = samples[s]!;
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = samples[s + 1]!;
    } else {
      rgba[d] = samples[s]!;
      rgba[d + 1] = samples[s + 1]!;
      rgba[d + 2] = samples[s + 2]!;
      rgba[d + 3] = samples[s + 3]!;
    }
  }

  return { width, height, data: rgba };
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(body.length + 8, crc32(out.subarray(4, body.length + 8)));
  return out;
}

/**
 * Encode an 8-bit RGBA raster as a PNG.
 *
 * Every scanline uses filter type 0, which keeps the encoder small at some cost in
 * compression ratio. Intended for previews and mask dumps.
 */
export function encodePng(image: RasterImage): Uint8Array {
  const { width, height, data } = image;
  const expected = width * height * 4;
  if (data.length !== expected) {
    throw new PngError(`Expected ${expected} bytes of RGBA data, got ${data.length}`);
  }
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', ihdr),
      chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}
