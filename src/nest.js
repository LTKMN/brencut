// Shape nesting on a coarse occupancy grid. Pure (no DOM), so it runs in the browser and under node tests.
//
// Each sticker becomes a cell mask (1 = some opaque art in that cell, holes filled). Placed shapes are
// stamped into the grid grown by `gap` cells, so any two shapes end up at least `gap` cells apart, which
// keeps their cut lines from merging. Placement is greedy: biggest first, every quarter turn tried,
// the spot with the lowest bottom edge wins (then leftmost).

/** Summed-area table of a binary mask (w*h, nonzero = set). Size (w+1)*(h+1). */
export function buildSat(bits, w, h) {
  const W = w + 1, sat = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += bits[y * w + x] ? 1 : 0;
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  return { sat, w, h };
}
function satAny({ sat, w, h }, x0, y0, x1, y1) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
  if (x0 >= x1 || y0 >= y1) return false;
  const W = w + 1;
  return sat[y1 * W + x1] - sat[y0 * W + x1] - sat[y1 * W + x0] + sat[y0 * W + x0] > 0;
}

/**
 * Cell mask of a source image drawn at `scale` sheet px per source px and turned `q` quarter turns
 * clockwise (as the app draws it), in cells of `cell` sheet px. A cell is set if any set source pixel
 * lands in it. Enclosed holes are filled.
 */
export function cellMask(s, scale, q, cell) {
  const W = s.w * scale, H = s.h * scale; // unrotated size, sheet px
  const [bw, bh] = q % 2 ? [H, W] : [W, H];
  const w = Math.max(1, Math.ceil(bw / cell - 1e-9)), h = Math.max(1, Math.ceil(bh / cell - 1e-9));
  // rotated point -> unrotated point
  const back = [(X, Y) => [X, Y], (X, Y) => [Y, H - X], (X, Y) => [W - X, H - Y], (X, Y) => [W - Y, X]][q & 3];
  const data = new Uint8Array(w * h);
  for (let Y = 0; Y < h; Y++) {
    for (let X = 0; X < w; X++) {
      const [ax, ay] = back(X * cell, Y * cell), [bx, by] = back((X + 1) * cell, (Y + 1) * cell);
      const x0 = Math.floor(Math.min(ax, bx) / scale), x1 = Math.ceil(Math.max(ax, bx) / scale);
      const y0 = Math.floor(Math.min(ay, by) / scale), y1 = Math.ceil(Math.max(ay, by) / scale);
      if (satAny(s, x0, y0, x1, y1)) data[Y * w + X] = 1;
    }
  }
  return solidify({ w, h, data });
}

/** Fill every unset region not connected (4-way) to the mask's border. */
export function solidify(m) {
  const { w, h, data } = m;
  const out = new Uint8Array(w * h).fill(1);
  const stack = [];
  const push = (x, y) => { const i = y * w + x; if (!data[i] && out[i]) { out[i] = 0; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i - x) / w;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
  return { w, h, data: out };
}

/** Grow a mask by a disc of radius r cells. The result is (w+2r)x(h+2r), offset by -r. */
export function dilate(m, r) {
  if (r <= 0) return m;
  const w = m.w + 2 * r, h = m.h + 2 * r, data = new Uint8Array(w * h);
  const disc = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) disc.push(dy * w + dx);
  const set = (x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.data[y * m.w + x];
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (!set(x, y)) continue;
      const c = (y + r) * w + x + r;
      if (set(x - 1, y) && set(x + 1, y) && set(x, y - 1) && set(x, y + 1)) { data[c] = 1; continue; }
      for (const d of disc) data[c + d] = 1;
    }
  }
  return { w, h, data };
}

export const maskArea = (m) => m.data.reduce((n, v) => n + v, 0);

/** Occupancy grid with, per cell, the length of the free run starting there (0 if occupied). */
class Grid {
  constructor(cols, rows, inset) {
    this.cols = cols; this.rows = rows;
    this.occ = new Uint8Array(cols * rows);
    this.run = new Int32Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (x < inset || y < inset || x >= cols - inset || y >= rows - inset) this.occ[y * cols + x] = 1;
      }
      this.rerun(y);
    }
  }
  rerun(y) {
    const { cols, occ, run } = this;
    let n = 0;
    for (let x = cols - 1; x >= 0; x--) { const i = y * cols + x; n = occ[i] ? 0 : n + 1; run[i] = n; }
  }
  stamp(m, ox, oy) {
    for (let y = 0; y < m.h; y++) {
      const gy = oy + y;
      if (gy < 0 || gy >= this.rows) continue;
      for (let x = 0; x < m.w; x++) {
        const gx = ox + x;
        if (gx >= 0 && gx < this.cols && m.data[y * m.w + x]) this.occ[gy * this.cols + gx] = 1;
      }
      this.rerun(gy);
    }
  }
  /** Top-most then left-most free spot for the spans, or null. */
  fit(spans, w, h) {
    const { cols, rows, run } = this;
    for (let y = 0; y + h <= rows; y++) {
      let x = 0;
      scan: while (x + w <= cols) {
        for (const [r, a, len] of spans) {
          const free = run[(y + r) * cols + x + a];
          if (free < len) { x += free + 1; continue scan; } // anything left of here hits the same blocked cell
        }
        return { x, y };
      }
    }
    return null;
  }
}

/** Horizontal runs of set cells: [row, start, length], longest first so collisions show up early. */
function spansOf(m) {
  const spans = [];
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w;) {
      if (!m.data[y * m.w + x]) { x++; continue; }
      const a = x;
      while (x < m.w && m.data[y * m.w + x]) x++;
      spans.push([y, a, x - a]);
    }
  }
  return spans.sort((p, q) => q[2] - p[2]);
}

/**
 * Nest shapes into a cols x rows grid.
 * items: [{ masks: [mask, ...] }], one mask per allowed orientation.
 * opts: { cols, rows, inset (cells kept clear at the edge), gap (cells between shapes),
 *         obstacles: [{ x, y, mask }] already on the sheet }
 * Returns [{ x, y, option }] in item order (cell coords of each mask's top-left), or null if any won't fit.
 */
export function nest(items, { cols, rows, inset = 0, gap = 0, obstacles = [] }) {
  const grid = new Grid(cols, rows, inset);
  for (const o of obstacles) grid.stamp(dilate(o.mask, gap + 1), o.x - gap - 1, o.y - gap - 1);
  const order = items.map((it, i) => ({ it, i, area: maskArea(it.masks[0]) })).sort((p, q) => q.area - p.area);
  const out = new Array(items.length);
  for (const { it, i } of order) {
    let best = null;
    it.masks.forEach((m, option) => {
      const spot = grid.fit(spansOf(m), m.w, m.h);
      if (!spot) return;
      const score = [spot.y + m.h, spot.x];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { ...spot, option, m, score };
    });
    if (!best) return null;
    grid.stamp(dilate(best.m, gap), best.x - gap, best.y - gap);
    out[i] = { x: best.x, y: best.y, option: best.option };
  }
  return out;
}
