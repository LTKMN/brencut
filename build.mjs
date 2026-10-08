// Bundle src/app.js (+ vendored tracer) into a single self-contained dist/index.html.
//   node build.mjs           build once
//   node build.mjs --serve   serve on http://localhost:5174, rebuilding on every page load
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';

// The tracer's PNG codec imports node:zlib; the browser decodes images itself and never calls it.
const stubZlib = {
  name: 'stub-zlib',
  setup(b) {
    b.onResolve({ filter: /^node:zlib$/ }, () => ({ path: 'zlib', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'const no = () => { throw new Error("zlib is not available in the browser"); }; export const inflateSync = no, deflateSync = no;',
    }));
  },
};

export async function build() {
  const r = await esbuild.build({
    entryPoints: ['src/app.js'],
    bundle: true,
    format: 'iife',
    target: 'es2022',
    minify: true,
    legalComments: 'inline',
    banner: { js: '/*! BrenCut. Includes honeymaro/pixcut tracer, MIT (c) its authors; protocol per popcornhax/PixCut-App, MIT. */' },
    write: false,
    plugins: [stubZlib],
  });
  const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const html = readFileSync('index.html', 'utf8').replace('<!--APP-->', () => `<script>\n${js}</script>`);
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/index.html', html);
  return html;
}

if (process.argv.includes('--serve')) {
  createServer(async (req, res) => {
    try {
      const html = await build();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.url === '/' || req.url.startsWith('/?') ? html : '');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e.stack ?? e));
    }
  }).listen(5174, () => console.log('BrenCut on http://localhost:5174'));
} else {
  const html = await build();
  console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KiB`);
}
