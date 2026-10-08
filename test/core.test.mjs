import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePng } from '../vendor/pixcut-trace/png.ts';
import { generateCutPath } from '../vendor/pixcut-trace/generate.ts';
import { fromStockConfig } from '../vendor/pixcut-trace/config.ts';
import { parsePlt } from '../vendor/pixcut-trace/plt.ts';
import { frameJson, frameData, takeJson, alertCodes, SHEET } from '../src/protocol.js';
import { traceSheet, padToRaster } from '../src/cut.js';

const fx = (f) => new URL(`./fixtures/${f}`, import.meta.url);
const png = (f) => decodePng(readFileSync(fx(f)));
const manifest = JSON.parse(readFileSync(fx('manifest.json'), 'utf8'));

test('JSON commands are framed as captured: cmd json line, compact JSON, no trailing newline', () => {
  const s = new TextDecoder().decode(frameJson({ id: 7, method: 'get-prop', params: ['model'] }));
  assert.equal(s, 'cmd json\n{"id":7,"method":"get-prop","params":["model"]}');
});

test('data chunks carry EXTLEN, little-endian job id, and split at 4071 payload bytes', () => {
  const payload = new Uint8Array(5000).map((_, i) => i & 0xff);
  const chunks = [...frameData(payload, 0x01020304)];
  assert.equal(chunks.length, 2);
  const head = 'cmd data EXTLEN=4075\n';
  assert.equal(new TextDecoder().decode(chunks[0].subarray(0, head.length)), head);
  assert.deepEqual([...chunks[0].subarray(head.length, head.length + 4)], [4, 3, 2, 1]);
  assert.equal(chunks[0].length, head.length + 4075);
  const tail = `cmd data EXTLEN=${5000 - 4071 + 4}\n`;
  assert.equal(new TextDecoder().decode(chunks[1].subarray(0, tail.length)), tail);
  const body = new Uint8Array([...chunks[0].subarray(head.length + 4), ...chunks[1].subarray(tail.length + 4)]);
  assert.deepEqual(body, payload);
});

test('reply parser handles split transfers, NULs, and braces inside strings', () => {
  const [a, rest] = takeJson('{"id":1,"result":["{x}"]}\0{"id":2,"res');
  assert.deepEqual(a, [{ id: 1, result: ['{x}'] }]);
  const [b, rest2] = takeJson(rest + 'ult":[1]}');
  assert.deepEqual(b, [{ id: 2, result: [1] }]);
  assert.equal(rest2, '');
});

test('alert codes parse and ::0 means none', () => {
  assert.deepEqual(alertCodes('::0'), []);
  assert.deepEqual(alertCodes(['::8102']), [8102]);
});

// The vendored tracer against the vendor generator's own output (exact cases only).
for (const c of manifest.cases.filter((c) => c.expectation === 'exact' && ['square-exact', 'fullbleed-4x7-exact'].includes(c.name))) {
  test(`vendored tracer reproduces stock ${c.name}`, () => {
    const opts = { ...fromStockConfig(c.config), knifePressure: c.kp ?? 1 };
    if (c.dilation) opts.dilation = c.dilation;
    const want = readFileSync(fx(c.plt), 'latin1');
    assert.equal(generateCutPath(png(c.image), opts).plt, want);
  });
}

test('traceSheet: square sticker gives one closed path inside the 4x7 canvas, with margin', () => {
  const img = png('square-4x7.png'); // opaque square on transparent 1200x2100
  assert.equal(img.width, SHEET.w);
  const tight = traceSheet(img, { marginMm: 0 });
  const wide = traceSheet(img, { marginMm: 2 });
  for (const r of [tight, wide]) {
    assert.match(r.plt, /^IN VER0\.1\.0 KP42 U/);
    assert.match(r.plt, / U6476,0 {2}@ $/);
    const doc = parsePlt(r.plt);
    assert.equal(doc.paths.length, 1);
    for (const p of doc.paths[0]) {
      assert.ok(p.x >= 0 && p.x <= 4064 && p.y >= 0 && p.y <= 7112, `point ${p.x},${p.y} off canvas`);
    }
  }
  const span = (r) => {
    const xs = parsePlt(r.plt).paths[0].map((p) => p.x);
    return Math.max(...xs) - Math.min(...xs);
  };
  // 2 mm margin on each side = 160 units wider (40 units/mm), within a few units of ramps/rounding.
  assert.ok(Math.abs(span(wide) - span(tight) - 160) < 30, `margin grew span by ${span(wide) - span(tight)}`);
});

test('traceSheet: empty sheet gives no cut', () => {
  const blank = { width: SHEET.w, height: SHEET.h, data: new Uint8Array(SHEET.w * SHEET.h * 4) };
  assert.equal(traceSheet(blank).plt, '');
});

test('traceSheet: knife pressure reaches the header', () => {
  assert.match(traceSheet(png('square-4x7.png'), { knifePressure: 55 }).plt, /^IN VER0\.1\.0 KP55 /);
});

test('padToRaster centres the sheet on white at 8,14', () => {
  const r = { width: SHEET.w, height: SHEET.h, data: new Uint8Array(SHEET.w * SHEET.h * 4) };
  r.data.set([10, 20, 30, 255], 0);
  const out = padToRaster(r);
  assert.equal(out.width, 1216);
  assert.equal(out.height, 2128);
  assert.deepEqual([...out.data.subarray(0, 4)], [255, 255, 255, 255]);
  const d = (14 * 1216 + 8) * 4;
  assert.deepEqual([...out.data.subarray(d, d + 3)], [10, 20, 30]);
});
