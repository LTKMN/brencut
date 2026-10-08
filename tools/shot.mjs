// Visual check: load dist/index.html headless, add PNGs, screenshot. Usage: node tools/shot.mjs out.png [png...]
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [out = 'shot.png', ...pngs] = process.argv.slice(2);
const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync('dist/index.html')); });
await new Promise((r) => server.listen(0, r));
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`http://localhost:${server.address().port}/`);
  if (pngs.length) {
    const input = await page.$('#file');
    await input.uploadFile(...pngs.map((p) => resolve(p)));
    await page.waitForFunction(() => /path|nothing/.test(document.getElementById('cutStats').textContent), { timeout: 15000 });
    if (process.env.ARRANGE) {
      await page.$eval('#cutStats', (e) => { e.textContent = ''; });
      await page.click('#arrangeBtn');
      await page.waitForFunction(() => /path|nothing/.test(document.getElementById('cutStats').textContent), { timeout: 15000 });
    }
  }
  await page.screenshot({ path: out });
  console.log('stats:', await page.$eval('#cutStats', (e) => e.textContent));
  console.log('log:', await page.$eval('#log', (e) => e.textContent.trim() || '(empty)'));
  console.log('errors:', errors.length ? errors : 'none');
} finally {
  await browser.close();
  server.close();
}
