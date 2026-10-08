import { PixCut, SHEET, MAX_JPEG_BYTES, describeAlerts } from './protocol.js';
import { traceSheet, padToRaster, CUT_DEFAULTS } from './cut.js';
import * as usb from './webusb.js';

const $ = (id) => document.getElementById(id);
const PX_PER_MM = 300 / 25.4;
const EDGE = Math.round(3 * PX_PER_MM); // keep art this far from the sheet edge
const HANDLE = 44; // resize handle size, sheet px

/* ═══ theme: one accent, one dark, contrast >= 5.5 ═══ */
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
function generatePair() {
  for (let i = 0; i < 200; i++) {
    const accent = hslToRgb(Math.random() * 360, 45 + Math.random() * 45, 55 + Math.random() * 22);
    const dark = hslToRgb(Math.random() * 360, 20 + Math.random() * 50, 3 + Math.random() * 10);
    if (contrast(accent, dark) >= 5.5) return { accent, dark };
  }
  return { accent: [168, 139, 250], dark: [3, 7, 18] };
}
const theme = generatePair();
document.documentElement.style.setProperty('--a', theme.accent.join(','));
document.documentElement.style.setProperty('--d', theme.dark.join(','));
document.querySelector('meta[name=theme-color]').content = `rgb(${theme.dark.join(',')})`;
const A = `rgb(${theme.accent.join(',')})`, D = `rgb(${theme.dark.join(',')})`;

/* ═══ settings ═══ */
const store = {
  get(k, d) { try { const v = localStorage.getItem('brencut.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('brencut.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const settings = {
  marginMm: store.get('marginMm', CUT_DEFAULTS.marginMm),
  knifePressure: store.get('knifePressure', CUT_DEFAULTS.knifePressure),
  cutHoles: store.get('cutHoles', CUT_DEFAULTS.cutHoles),
  showCut: store.get('showCut', true),
};

/* ═══ stickers ═══ */
let stickers = []; // {id, name, bmp, sw, sh, s (sheet px per source px), rot (quarter turns), x, y}
let selected = null;
let nextId = 1;
const bbox = (k) => {
  const w = k.sw * k.s, h = k.sh * k.s;
  return k.rot % 2 ? { w: h, h: w } : { w, h };
};
const gapPx = () => Math.round((2 * settings.marginMm + 1.5) * PX_PER_MM);

function overlaps(x, y, w, h, others, gap) {
  return others.some((o) => {
    const b = bbox(o);
    return x < o.x + b.w + gap && o.x < x + w + gap && y < o.y + b.h + gap && o.y < y + h + gap;
  });
}
function findSpot(w, h, others) {
  const gap = gapPx();
  for (let y = EDGE; y + h <= SHEET.h - EDGE; y += 8) {
    for (let x = EDGE; x + w <= SHEET.w - EDGE; x += 8) {
      if (!overlaps(x, y, w, h, others, gap)) return { x, y };
    }
  }
  return null;
}
function clampInto(k) {
  const b = bbox(k);
  k.x = Math.round(Math.min(Math.max(k.x, 0), SHEET.w - b.w));
  k.y = Math.round(Math.min(Math.max(k.y, 0), SHEET.h - b.h));
}
function fitScale(k) {
  // never larger than the printable area
  const b = bbox(k);
  const f = Math.min(1, (SHEET.w - 2 * EDGE) / b.w, (SHEET.h - 2 * EDGE) / b.h);
  k.s *= f;
}

function arrange() {
  const gap = gapPx();
  const order = [...stickers].sort((a, b) => bbox(b).h - bbox(a).h);
  let x = EDGE, y = EDGE, rowH = 0, overflow = 0;
  for (const k of order) {
    const b = bbox(k);
    if (x + b.w > SHEET.w - EDGE && x > EDGE) { x = EDGE; y += rowH + gap; rowH = 0; }
    k.x = x; k.y = y;
    if (y + b.h > SHEET.h - EDGE) overflow++;
    x += b.w + gap; rowH = Math.max(rowH, b.h);
    clampInto(k);
  }
  if (overflow) log(`${overflow} sticker(s) don't fit; they overlap the bottom edge. Shrink something or remove one.`);
  changed();
}

/** PNG pHYs chunk -> dots per inch, or null. */
function pngDpi(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 16 || v.getUint32(0) !== 0x89504e47) return null;
  for (let p = 8; p + 12 <= v.byteLength;) {
    const len = v.getUint32(p), type = v.getUint32(p + 4);
    if (type === 0x70485973 /* pHYs */ && len >= 9 && v.getUint8(p + 16) === 1) {
      const dpi = v.getUint32(p + 8) * 0.0254;
      return dpi >= 30 && dpi <= 2400 ? dpi : null;
    }
    if (type === 0x49444154 /* IDAT */) return null;
    p += 12 + len;
  }
  return null;
}

/** Crop to the opaque pixels so stickers pack tightly. Returns {bmp, w, h, opaque}. */
async function trimmed(bmp) {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
  let x0 = bmp.width, y0 = bmp.height, x1 = -1, y1 = -1, opaque = true;
  for (let y = 0; y < bmp.height; y++) {
    for (let x = 0; x < bmp.width; x++) {
      const a = data[(y * bmp.width + x) * 4 + 3];
      if (a < 255) opaque = false;
      if (a >= CUT_DEFAULTS.alphaThreshold) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  if (x0 === 0 && y0 === 0 && x1 === bmp.width - 1 && y1 === bmp.height - 1) return { bmp, w: bmp.width, h: bmp.height, opaque };
  const cropped = await createImageBitmap(bmp, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
  return { bmp: cropped, w: cropped.width, h: cropped.height, opaque };
}

async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const buf = await f.arrayBuffer();
      const src = await createImageBitmap(new Blob([buf], { type: f.type }));
      const t = await trimmed(src);
      if (!t) { log(`${f.name}: fully transparent, skipped`); continue; }
      if (t.opaque) log(`${f.name}: no transparency, so it cuts as a rectangle`);
      const dpi = pngDpi(buf) ?? 300;
      const k = { id: nextId++, name: f.name.replace(/\.[^.]+$/, '') || 'pasted', bmp: t.bmp, sw: t.w, sh: t.h, s: 300 / dpi, rot: 0, x: 0, y: 0 };
      fitScale(k);
      const b = bbox(k);
      const spot = findSpot(b.w, b.h, stickers);
      if (spot) Object.assign(k, spot);
      else { k.x = EDGE; k.y = EDGE; log(`${f.name}: no free space left, placed on top; try arrange or resize`); }
      stickers.push(k);
      selected = k;
    } catch (e) {
      log(`${f.name}: ${e.message}`);
    }
  }
  changed();
}

/* ═══ drawing ═══ */
const view = $('sheet');
const vg = view.getContext('2d');
const comp = new OffscreenCanvas(SHEET.w, SHEET.h);
const cg = comp.getContext('2d', { willReadFrequently: true });

function drawStickers(g) {
  for (const k of stickers) {
    const b = bbox(k);
    g.save();
    g.translate(k.x + b.w / 2, k.y + b.h / 2);
    g.rotate((k.rot * Math.PI) / 2);
    g.imageSmoothingQuality = 'high';
    g.drawImage(k.bmp, (-k.sw * k.s) / 2, (-k.sh * k.s) / 2, k.sw * k.s, k.sh * k.s);
    g.restore();
  }
}

let cut = null; // last trace result
let cutStale = true;

function render() {
  vg.fillStyle = '#fff';
  vg.fillRect(0, 0, SHEET.w, SHEET.h);
  drawStickers(vg);

  // printable-area guide
  vg.save();
  vg.setLineDash([10, 10]);
  vg.strokeStyle = 'rgba(0,0,0,.15)';
  vg.lineWidth = 2;
  vg.strokeRect(EDGE, EDGE, SHEET.w - 2 * EDGE, SHEET.h - 2 * EDGE);
  vg.restore();

  if (settings.showCut && cut?.contours.length) {
    vg.save();
    vg.globalAlpha = cutStale ? 0.35 : 1;
    vg.lineJoin = 'round';
    const path = new Path2D();
    for (const c of cut.contours) {
      for (const poly of [c.outer, ...(settings.cutHoles ? c.inners : [])]) {
        poly.forEach((p, i) => (i ? path.lineTo(p.x + 0.5, p.y + 0.5) : path.moveTo(p.x + 0.5, p.y + 0.5)));
        path.closePath();
      }
    }
    vg.strokeStyle = D; vg.lineWidth = 5; vg.stroke(path);
    vg.strokeStyle = A; vg.lineWidth = 2.5; vg.setLineDash([12, 8]); vg.stroke(path);
    vg.restore();
  }

  if (selected) {
    const b = bbox(selected);
    vg.save();
    vg.strokeStyle = D; vg.lineWidth = 4; vg.strokeRect(selected.x - 2, selected.y - 2, b.w + 4, b.h + 4);
    vg.strokeStyle = A; vg.lineWidth = 2; vg.setLineDash([8, 6]); vg.strokeRect(selected.x - 2, selected.y - 2, b.w + 4, b.h + 4);
    vg.setLineDash([]);
    vg.fillStyle = A; vg.strokeStyle = D; vg.lineWidth = 3;
    vg.fillRect(selected.x + b.w - HANDLE / 2, selected.y + b.h - HANDLE / 2, HANDLE, HANDLE);
    vg.strokeRect(selected.x + b.w - HANDLE / 2, selected.y + b.h - HANDLE / 2, HANDLE, HANDLE);
    vg.restore();
  }
  $('empty').hidden = stickers.length > 0;
}

/* ═══ trace (debounced) ═══ */
let traceTimer = 0;
function scheduleTrace(ms = 120) {
  cutStale = true;
  clearTimeout(traceTimer);
  traceTimer = setTimeout(runTrace, ms);
}
function compositeRaster() {
  cg.clearRect(0, 0, SHEET.w, SHEET.h);
  drawStickers(cg);
  const img = cg.getImageData(0, 0, SHEET.w, SHEET.h);
  return { width: img.width, height: img.height, data: img.data };
}
function runTrace() {
  try {
    const t0 = performance.now();
    cut = traceSheet(compositeRaster(), settings);
    cutStale = false;
    const s = cut.stats;
    $('cutStats').textContent = s
      ? `${s.pathCount} path${s.pathCount === 1 ? '' : 's'} · ${s.pointCount} points · ${(s.cutLengthMm / 10).toFixed(1)} cm of cut · traced in ${Math.round(performance.now() - t0)} ms`
      : 'nothing to cut';
  } catch (e) {
    cut = null;
    $('cutStats').textContent = `trace failed: ${e.message}`;
  }
  render();
  updateButtons();
}

function changed() {
  renderList();
  render();
  scheduleTrace();
  updateButtons();
}

/* ═══ list ═══ */
function renderList() {
  const ul = $('list');
  ul.textContent = '';
  $('count').textContent = stickers.length ? String(stickers.length) : '';
  for (const k of stickers) {
    const b = bbox(k);
    const li = document.createElement('li');
    li.className = k === selected ? 'sel' : '';
    const th = document.createElement('canvas');
    th.width = th.height = 68;
    const tg = th.getContext('2d');
    const f = Math.min(68 / b.w, 68 / b.h);
    tg.translate(34, 34); tg.rotate((k.rot * Math.PI) / 2);
    tg.drawImage(k.bmp, (-k.sw * k.s * f) / 2, (-k.sh * k.s * f) / 2, k.sw * k.s * f, k.sh * k.s * f);
    const mid = document.createElement('div');
    mid.innerHTML = `<div class="name"></div><div class="dims"><input type="number" step="0.5" min="3" aria-label="width mm"> × <input type="number" step="0.5" min="3" aria-label="height mm"> mm</div>`;
    mid.querySelector('.name').textContent = k.name;
    const [wIn, hIn] = mid.querySelectorAll('input');
    wIn.value = (b.w / PX_PER_MM).toFixed(1);
    hIn.value = (b.h / PX_PER_MM).toFixed(1);
    const resize = (mm, cur) => {
      if (!(mm >= 3)) return;
      k.s *= (mm * PX_PER_MM) / cur;
      fitScale(k); clampInto(k); changed();
    };
    wIn.onchange = () => resize(+wIn.value, bbox(k).w);
    hIn.onchange = () => resize(+hIn.value, bbox(k).h);
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.innerHTML = `<button class="btn icon" title="rotate (R)">&#8635;</button><button class="btn icon" title="duplicate (D)">&#10697;</button><button class="btn icon" title="remove (del)">&#10005;</button>`;
    const [rotB, dupB, delB] = acts.children;
    rotB.onclick = (e) => { e.stopPropagation(); rotate(k); };
    dupB.onclick = (e) => { e.stopPropagation(); duplicate(k); };
    delB.onclick = (e) => { e.stopPropagation(); remove(k); };
    li.append(th, mid, acts);
    li.onclick = (e) => { if (e.target.tagName !== 'INPUT') { selected = k; renderList(); render(); } };
    ul.append(li);
  }
}

function rotate(k) {
  const b0 = bbox(k);
  const cx = k.x + b0.w / 2, cy = k.y + b0.h / 2;
  k.rot = (k.rot + 1) % 4;
  fitScale(k);
  const b = bbox(k);
  k.x = cx - b.w / 2; k.y = cy - b.h / 2;
  clampInto(k); changed();
}
function duplicate(k) {
  const c = { ...k, id: nextId++ };
  const b = bbox(c);
  const spot = findSpot(b.w, b.h, stickers);
  if (spot) Object.assign(c, spot);
  else { c.x += 40; c.y += 40; clampInto(c); log('no free space for the copy; placed on top'); }
  stickers.push(c); selected = c; changed();
}
function remove(k) {
  stickers = stickers.filter((o) => o !== k);
  if (selected === k) selected = null;
  changed();
}

/* ═══ pointer ═══ */
const toSheet = (e) => {
  const r = view.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * SHEET.w) / r.width, y: ((e.clientY - r.top) * SHEET.h) / r.height };
};
let drag = null;
view.addEventListener('pointerdown', (e) => {
  const p = toSheet(e);
  view.focus();
  if (selected) {
    const b = bbox(selected);
    if (Math.abs(p.x - (selected.x + b.w)) < HANDLE && Math.abs(p.y - (selected.y + b.h)) < HANDLE) {
      drag = { mode: 'resize', k: selected, s0: selected.s, b0: b };
      view.setPointerCapture(e.pointerId);
      return;
    }
  }
  const hit = [...stickers].reverse().find((k) => { const b = bbox(k); return p.x >= k.x && p.x <= k.x + b.w && p.y >= k.y && p.y <= k.y + b.h; });
  selected = hit ?? null;
  if (hit) {
    stickers = [...stickers.filter((k) => k !== hit), hit]; // bring to front
    drag = { mode: 'move', k: hit, dx: p.x - hit.x, dy: p.y - hit.y };
    view.setPointerCapture(e.pointerId);
  }
  renderList(); render();
});
view.addEventListener('pointermove', (e) => {
  const p = toSheet(e);
  if (!drag) {
    let cur = 'default';
    if (selected) {
      const b = bbox(selected);
      if (Math.abs(p.x - (selected.x + b.w)) < HANDLE && Math.abs(p.y - (selected.y + b.h)) < HANDLE) cur = 'nwse-resize';
    }
    if (cur === 'default' && stickers.some((k) => { const b = bbox(k); return p.x >= k.x && p.x <= k.x + b.w && p.y >= k.y && p.y <= k.y + b.h; })) cur = 'move';
    view.style.cursor = cur;
    return;
  }
  const k = drag.k;
  if (drag.mode === 'move') {
    k.x = p.x - drag.dx; k.y = p.y - drag.dy;
  } else {
    const f = Math.max((p.x - k.x) / drag.b0.w, (p.y - k.y) / drag.b0.h, (3 * PX_PER_MM) / Math.min(drag.b0.w, drag.b0.h));
    k.s = drag.s0 * f;
    const b = bbox(k);
    const lim = Math.min(1, (SHEET.w - k.x) / b.w, (SHEET.h - k.y) / b.h);
    k.s *= lim;
  }
  clampInto(k);
  cutStale = true;
  render();
});
const endDrag = () => { if (drag) { drag = null; changed(); } };
view.addEventListener('pointerup', endDrag);
view.addEventListener('pointercancel', endDrag);

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = selected;
  if (!k) return;
  const step = (e.shiftKey ? 5 : 1) * PX_PER_MM;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) { k.x += moves[e.key][0]; k.y += moves[e.key][1]; clampInto(k); changed(); e.preventDefault(); }
  else if (e.key === 'r' || e.key === 'R') rotate(k);
  else if ((e.key === 'd' || e.key === 'D') && !e.ctrlKey && !e.metaKey) duplicate(k);
  else if (e.key === 'Delete' || e.key === 'Backspace') { remove(k); e.preventDefault(); }
  else if (e.key === 'Escape') { selected = null; renderList(); render(); }
});

/* ═══ file input, drop, paste ═══ */
$('addBtn').onclick = () => $('file').click();
$('file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
const stage = $('stage');
for (const t of ['dragenter', 'dragover']) document.addEventListener(t, (e) => { e.preventDefault(); stage.classList.add('drag'); });
for (const t of ['dragleave', 'drop']) document.addEventListener(t, (e) => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) stage.classList.remove('drag'); });
document.addEventListener('drop', (e) => addFiles([...(e.dataTransfer?.files ?? [])]));
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$('arrangeBtn').onclick = arrange;
$('clearBtn').onclick = () => { if (stickers.length && confirm('Remove all stickers from the sheet?')) { stickers = []; selected = null; changed(); } };

/* ═══ cut settings ═══ */
const marginIn = $('margin'), marginRange = $('marginRange');
marginIn.value = marginRange.value = settings.marginMm;
const setMargin = (v) => {
  settings.marginMm = Math.min(10, Math.max(0, +v || 0));
  marginIn.value = marginRange.value = settings.marginMm;
  store.set('marginMm', settings.marginMm);
  scheduleTrace(200);
};
marginIn.onchange = () => setMargin(marginIn.value);
marginRange.oninput = () => setMargin(marginRange.value);
$('kp').value = settings.knifePressure;
$('kp').onchange = () => {
  settings.knifePressure = Math.max(0, Math.min(99, Math.round(+$('kp').value || 0)));
  $('kp').value = settings.knifePressure;
  store.set('knifePressure', settings.knifePressure);
  scheduleTrace(0);
};
$('holes').checked = settings.cutHoles;
$('holes').onchange = () => { settings.cutHoles = $('holes').checked; store.set('cutHoles', settings.cutHoles); scheduleTrace(0); };
$('showCut').checked = settings.showCut;
$('showCut').onchange = () => { settings.showCut = $('showCut').checked; store.set('showCut', settings.showCut); render(); };

/* ═══ output files ═══ */
async function buildJpeg() {
  const r = padToRaster(compositeRaster());
  const c = new OffscreenCanvas(r.width, r.height);
  c.getContext('2d').putImageData(new ImageData(r.data, r.width, r.height), 0, 0);
  for (const q of [0.95, 0.92, 0.9, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5]) {
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: q });
    if (blob.size <= MAX_JPEG_BYTES) return new Uint8Array(await blob.arrayBuffer());
  }
  throw new Error('could not get the print image under 1 MiB');
}
const pltBytes = () => new TextEncoder().encode(cut?.plt ?? '');
function download(bytes, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
$('jpgBtn').onclick = async () => { try { download(await buildJpeg(), `brencut-${stamp()}.jpg`, 'image/jpeg'); } catch (e) { log(e.message); } };
$('pltBtn').onclick = () => download(pltBytes(), `brencut-${stamp()}.plt`, 'text/plain');

/* ═══ printer ═══ */
let conn = null; // {io, close, device, px: PixCut, info}
let printing = null; // {abort: AbortController, jobId}
let pollTimer = 0;

function log(msg) {
  const el = $('log');
  el.textContent = `${new Date().toLocaleTimeString()}  ${msg}\n` + el.textContent;
}
function setPill(text, mode) {
  $('printerText').textContent = text;
  $('printerPill').className = 'pill ' + (mode ?? '');
}
const MEDIA = { 5013: '4×7 sticker', 5012: '4×6 photo' };

async function connect(dev) {
  try {
    const c = await usb.openPrinter(dev);
    const px = new PixCut(c.io, (kind, o) => log(`${kind}: ${JSON.stringify(o)}`));
    const info = await px.identify();
    conn = { ...c, px, info };
    log(`connected: ${info.model} (${info.sku}), firmware ${info['firmware-revision']}`);
    await pollStatus();
  } catch (e) {
    log(`connect failed: ${e.message}${/access denied|Unable to claim/i.test(e.message) ? ' (is the Liene app or another tab using the printer?)' : ''}`);
    setPill('no printer');
    conn = null;
  }
  updateButtons();
}
async function disconnect() {
  clearTimeout(pollTimer);
  const c = conn;
  conn = null;
  await c?.close();
  setPill('no printer');
  updateButtons();
}
async function pollStatus() {
  clearTimeout(pollTimer);
  if (!conn) return;
  if (!printing) {
    try {
      const s = await conn.px.status();
      const media = MEDIA[conn.info['media-size']] ?? `media ${conn.info['media-size']}`;
      const alert = s.alerts.length ? ` · ${describeAlerts(s.alerts)}` : '';
      setPill(`${conn.info.model} · ${s.label}${alert}`, s.state === 40 ? 'busy' : 'on');
      conn.status = s;
      $('connectBtn').title = `${conn.info.sku} · fw ${conn.info['firmware-revision']} · ${media}`;
    } catch (e) {
      log(`status: ${e.message}`);
    }
  }
  pollTimer = setTimeout(pollStatus, 4000);
}

$('connectBtn').onclick = async () => {
  if (!usb.supported()) return;
  if (conn) return disconnect();
  try { await connect(await usb.requestPrinter()); } catch (e) { if (e.name !== 'NotFoundError') log(e.message); }
};

$('printBtn').onclick = async () => {
  if (!conn || !cut?.plt || printing) return;
  const abort = new AbortController();
  printing = { abort, jobId: null };
  updateButtons();
  setPill(`${conn.info.model} · printing`, 'busy');
  const bar = $('progress').firstElementChild;
  try {
    if (cutStale) runTrace();
    const jpeg = await buildJpeg();
    const plt = pltBytes();
    log(`sending ${(jpeg.length / 1024).toFixed(0)} KiB image + ${plt.length} B cut path (KP${settings.knifePressure})`);
    const res = await conn.px.printAndCut(jpeg, plt, {
      signal: abort.signal,
      onStatus: (s) => {
        if (s.jobId) printing.jobId = s.jobId;
        $('jobText').textContent = s.text;
        if (s.progress != null) bar.style.width = `${Math.round(s.progress * 100)}%`;
        else if (s.phase === 'run') bar.style.width = '100%';
      },
    });
    log(`job ${res.jobId} done${res.cut ? ', printed and cut' : ' (no cut phase seen; check the sheet)'}`);
    $('jobText').textContent = `job ${res.jobId} done`;
  } catch (e) {
    log(`print failed: ${e.message}`);
    $('jobText').textContent = e.message;
  } finally {
    printing = null;
    bar.style.width = '0';
    updateButtons();
    pollStatus();
  }
};
$('cancelBtn').onclick = async () => {
  if (!printing) return;
  printing.abort.abort();
  if (printing.jobId && conn) {
    try { await conn.px.cancel(printing.jobId); log(`asked the printer to cancel job ${printing.jobId}`); } catch (e) { log(`cancel: ${e.message}`); }
  }
};

function updateButtons() {
  const hasCut = !!cut?.plt && stickers.length > 0;
  $('printBtn').disabled = !conn || !hasCut || !!printing;
  $('printBtn').title = !conn ? 'connect the printer first' : !hasCut ? 'add a sticker first' : '';
  $('jpgBtn').disabled = $('pltBtn').disabled = !hasCut;
  $('cancelBtn').hidden = !printing;
  $('connectBtn').textContent = conn ? 'disconnect' : 'connect';
  $('connectBtn').disabled = !usb.supported() || !!printing;
}

if (!usb.supported()) {
  const n = $('usbNote');
  n.hidden = false;
  n.textContent = window.isSecureContext
    ? 'This browser can’t talk to USB printers. Open BrenCut in Chrome or Edge to print, or download the .jpg and .plt here.'
    : 'USB needs a secure page: open BrenCut over https or localhost.';
} else {
  navigator.usb.addEventListener('disconnect', (e) => {
    if (conn && e.device === conn.device) { log('printer unplugged'); conn = null; printing?.abort.abort(); clearTimeout(pollTimer); setPill('no printer'); updateButtons(); }
  });
  navigator.usb.addEventListener('connect', async (e) => {
    if (!conn && e.device.vendorId === 0x302c) connect(e.device);
  });
  usb.findGranted().then((d) => d && connect(d));
}
window.addEventListener('beforeunload', (e) => { if (printing) e.preventDefault(); });

changed();
