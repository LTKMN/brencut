# BrenCut

Drop transparent PNGs onto a 4×7 in sheet, and BrenCut prints and kiss-cuts them on a Liene PixCut S1,
straight from the browser over USB. The cut follows each image's transparency, plus a border you choose.

- **Browsers:** printing needs WebUSB, which only Chrome, Edge and other Chromium browsers have.
  In other browsers you can still lay out a sheet and download the `.jpg` + `.plt`.
- **Run locally:** `npm install`, then `npm run dev` and open http://localhost:5174.
- **Build:** `npm run build` writes the self-contained `dist/index.html`.
- **Test:** `npm test`. Check the printer from a terminal (read-only): `node tools/status.mjs`.

Credits: the cut-path tracer is [honeymaro/pixcut](https://github.com/honeymaro/pixcut) (MIT, vendored in
`vendor/pixcut-trace`), and the USB protocol follows [popcornhax/PixCut-App](https://github.com/popcornhax/PixCut-App) (MIT).
Not affiliated with Liene or Hannto.
