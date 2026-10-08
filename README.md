# BrenCut

**https://brencut.brennan.computer**

Print and kiss-cut sticker sheets on a **Liene PixCut S1**, straight from the browser over USB, with no
vendor app. No accounts, no logins, no ads, no nothing. Drop in transparent PNGs, arrange them on the 4×7 in sheet, press print & cut. The cut line
follows each image's transparency, plus a white border with adjustable thickness.

## Use

1. Plug the PixCut S1 in over USB and open BrenCut in **Chrome or Edge** (any Chromium browser; WebUSB is
   needed to reach the printer). Firefox and Safari can lay out a sheet and download the `.jpg` + `.plt`
   but CANNOT PRINT. Sorry! This is their fault.
2. Click **connect** (top right) and pick the printer.
3. Add PNGs (drop, paste or pick). Either:
   - **separate stickers**: each is trimmed to its art and sized from its DPI (300 if unset); drag,
     resize, rotate, duplicate, or hit **arrange**; or
   - **a whole sheet**: a 1200×2100 px (4×7 in at 300 DPI) PNG is placed exactly as drawn. Use a
     transparent background, keep art ~5 mm from the edges and ~5 mm between stickers.
4. Set the border and knife pressure, then **print & cut**.

**Knife pressure** runs 1–100. The official app uses 42 for Liene sticker paper so that's our default.

Windows needs no driver install: the printer's control and data interfaces come up on WinUSB.
Only one program can hold the printer at a time, so close the Liene app (or another BrenCut tab) first.

## Develop

Live version is at **https://brencut.brennan.computer**

```sh
npm install
npm run dev        # http://localhost:5174, rebuilds on reload
npm test           # protocol framing, tracer conformance, sheet tracing
npm run build      # self-contained dist/index.html
node tools/status.mjs   # read-only printer check from the terminal (node-usb)
```

`src/protocol.js` is the printer protocol, written against a tiny `io` interface so the same code runs over
WebUSB (`src/webusb.js`) and node-usb (`tools/node-usb.mjs`). `src/cut.js` turns the composited sheet into a
PLT cut file. `src/app.js` is the UI. See `CLAUDE.md` for protocol notes.

## Credits

- Cut-path tracer: [honeymaro/pixcut](https://github.com/honeymaro/pixcut) (MIT), vendored unmodified in
  `vendor/pixcut-trace`; its fixtures in `test/fixtures` come from the vendor's own generator.
- USB protocol: reverse-engineered by [popcornhax/PixCut-App](https://github.com/popcornhax/PixCut-App) (MIT).

Not affiliated with Liene or Hannto. "PixCut" and "Liene" are their owners' trademarks, used only to name
the hardware this works with. Use at your own risk.

## License

MIT. Please reach out with ideas and feature requests. Please don't just fork this and charge money or add ads or whatever, your mother will be very disappointed in you. This is free software.
