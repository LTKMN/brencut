# brencut

Browser app that turns transparent PNGs into a print-and-cut sticker sheet and sends it straight to a
**Liene PixCut S1** over WebUSB. No vendor app needed. Ships as one self-contained `dist/index.html`
(built by `node build.mjs`; `npm run dev` serves it on http://localhost:5174 and rebuilds on reload).

## Layout

- `src/protocol.js`: the printer protocol, transport-agnostic (`io.write(ep, bytes)`, `io.read(ep, len, timeoutMs)`).
- `src/webusb.js`: WebUSB adapter (browser). `tools/node-usb.mjs`: node `usb` adapter for terminal testing.
- `src/cut.js`: sheet raster → PLT via the vendored tracer, plus padding to the printer raster.
- `src/app.js` + `index.html`: UI. `build.mjs` inlines the bundle at `<!--APP-->`.
- `vendor/pixcut-trace/`: honeymaro/pixcut `src/` (MIT), unmodified; see its `SOURCE.md`. Re-copy to update, don't edit.
- `tools/status.mjs`: read-only printer check. `tools/shot.mjs`: headless screenshot for visual checks.

## Printer facts (verified on our unit)

- USB VID 0x302C PID 0x3101, composite. Interface 2 (JSON control, 0x06/0x86) and 3 (data, 0x04/0x84)
  are bound to WinUSB on Windows, so WebUSB works without a driver install. Interface 0 is usbprint.
- Our unit: model DHP700, SKU DHP700W#US1, firmware 1.0.15_0054, hardware x05.
- `cmd json\n` + compact JSON (no trailing newline). Data chunks: `cmd data EXTLEN=n\n` + u32 LE job id + n-4 bytes.
- Print image: JPEG ≤ 1 MiB, 1200x2100 sheet padded 8/14 px onto 1216x2128 white. Cut: PLT, 40 units/mm,
  feed axis first, overscan 1.01333 (stock). Job type 600 = print + cut, media-size 5013 = 4x7 sticker.

## Open questions

(Settled 2026-10-08: knife pressure is 1-100 and the official sticker value is 42. On our printer KP1
never lowered the blade, while printing and cut-path placement both worked on the first real sheet.)

- `get-prop media-size` reported 5009 with the printer asleep; unknown whether that reflects loaded paper.

## Conventions

- Two-colour UI (`--a` accent, `--d` dark, random pair, contrast ≥ 5.5), monospace stack, no emoji.
  The sheet preview shows real art colours on white paper; that's content, not UI.
- Never send calibration, firmware, factory or `set-prop` commands; only job, status and cancel.
- `npm test` (node --test) must pass; verify UI with `node tools/shot.mjs out.png some.png`.
