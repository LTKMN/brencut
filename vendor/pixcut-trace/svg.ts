import { CUT_CANVAS, MM_PER_UNIT } from './units.ts';
import type { PltDocument } from './plt.ts';
import type { Contour, Polyline } from './types.ts';
import type { SheetGeometry } from './units.ts';

export interface SvgOptions {
  /** Sheet drawn as the background. Default the 4x7 cut canvas. */
  sheet?: SheetGeometry;
  /** Rendered width in CSS pixels. Height follows the sheet aspect. Default 420. */
  width?: number;
  /** Draw the blade-up moves between paths as dashed lines. Default true. */
  showTravel?: boolean;
  /** Draw a millimetre-labelled border. Default true. */
  showSheet?: boolean;
  /** Cut line colour. Default `'#c2185b'`. */
  cutColor?: string;
  /** Travel line colour. Default `'#9b91a4'`. */
  travelColor?: string;
  /** Sheet fill. Default `'#ffffff'`. */
  sheetColor?: string;
  /** Cut stroke width in cut units. Default 8, about 0.2 mm. */
  strokeWidth?: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toPathData(path: Polyline): string {
  if (path.length === 0) return '';
  const head = path[0]!;
  let out = `M${head.x} ${head.y}`;
  for (let i = 1; i < path.length; i++) {
    const point = path[i]!;
    out += ` L${point.x} ${point.y}`;
  }
  return out;
}

/**
 * Render a cut document as a standalone SVG.
 *
 * The sheet is drawn in cut units with the feed axis running down the page, which is
 * how the paper emerges, so the preview matches what comes out of the machine.
 */
export function renderPltSvg(document: PltDocument, options: SvgOptions = {}): string {
  const {
    sheet = CUT_CANVAS,
    width = 420,
    showTravel = true,
    showSheet = true,
    cutColor = '#c2185b',
    travelColor = '#9b91a4',
    sheetColor = '#ffffff',
    strokeWidth = 8,
  } = options;

  const height = Math.round((width * sheet.heightUnits) / sheet.widthUnits);
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${sheet.widthUnits} ${sheet.heightUnits}" ` +
      `role="img" aria-label="PixCut cut path preview, ${escapeXml(sheet.label)} sheet">`,
  );

  if (showSheet) {
    const widthMm = (sheet.widthUnits * MM_PER_UNIT).toFixed(1);
    const heightMm = (sheet.heightUnits * MM_PER_UNIT).toFixed(1);
    parts.push(
      `<rect x="0" y="0" width="${sheet.widthUnits}" height="${sheet.heightUnits}" ` +
        `fill="${escapeXml(sheetColor)}" stroke="#c6bdcd" stroke-width="6"/>`,
      `<title>${escapeXml(sheet.label)} sheet, ${widthMm} by ${heightMm} mm</title>`,
    );
  }

  if (showTravel) {
    const travel: string[] = [];
    let cursor: { x: number; y: number } | undefined;
    for (const path of document.paths) {
      const first = path[0];
      if (first === undefined) continue;
      if (cursor !== undefined) travel.push(`M${cursor.x} ${cursor.y} L${first.x} ${first.y}`);
      cursor = path[path.length - 1];
    }
    if (document.park !== undefined && cursor !== undefined) {
      travel.push(`M${cursor.x} ${cursor.y} L${document.park.x} ${document.park.y}`);
    }
    if (travel.length > 0) {
      parts.push(
        `<path d="${travel.join(' ')}" fill="none" stroke="${escapeXml(travelColor)}" ` +
          `stroke-width="${strokeWidth / 2}" stroke-dasharray="30 24" opacity="0.7"/>`,
      );
    }
  }

  for (const path of document.paths) {
    if (path.length < 2) continue;
    parts.push(
      `<path d="${toPathData(path)}" fill="none" stroke="${escapeXml(cutColor)}" ` +
        `stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  }

  if (document.park !== undefined) {
    parts.push(
      `<circle cx="${document.park.x}" cy="${document.park.y}" r="${strokeWidth * 2}" ` +
        `fill="${escapeXml(travelColor)}"/>`,
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}

export interface ContourSvgOptions {
  /** Rendered width in CSS pixels. Default 420. */
  width?: number;
  /** Outline colour. Default `'#c2185b'`. */
  outerColor?: string;
  /** Hole colour. Default `'#0f7fa0'`. */
  innerColor?: string;
  /** Background fill. Default `'#ffffff'`. */
  background?: string;
  /** Stroke width in source pixels. Default 3. */
  strokeWidth?: number;
}

/** Render traced contours in source-pixel space, for checking a trace before cutting. */
export function renderContoursSvg(
  contours: readonly Contour[],
  imageWidth: number,
  imageHeight: number,
  options: ContourSvgOptions = {},
): string {
  const {
    width = 420,
    outerColor = '#c2185b',
    innerColor = '#0f7fa0',
    background = '#ffffff',
    strokeWidth = 3,
  } = options;

  const height = Math.round((width * imageHeight) / imageWidth);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
      `viewBox="0 0 ${imageWidth} ${imageHeight}" role="img" aria-label="Traced contours">`,
    `<rect x="0" y="0" width="${imageWidth}" height="${imageHeight}" fill="${escapeXml(background)}"/>`,
  ];

  for (const contour of contours) {
    parts.push(
      `<path d="${toPathData(contour.outer)} Z" fill="none" ` +
        `stroke="${escapeXml(outerColor)}" stroke-width="${strokeWidth}"/>`,
    );
    for (const inner of contour.inners) {
      parts.push(
        `<path d="${toPathData(inner)} Z" fill="none" ` +
          `stroke="${escapeXml(innerColor)}" stroke-width="${strokeWidth}"/>`,
      );
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}
