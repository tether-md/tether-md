// Headless frame capture for Tether MD scene mockups.
// Run from a scratch dir that has `playwright-core` installed:
//   node capture.mjs <path-to-scene.html> <frames-out-dir> [durationMs] [width] [height]
// Renders scene.html deterministically via window.seek(t) at 15 fps.

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 15;
const DURATION_MS = Number(process.argv[4] ?? 18000);
const WIDTH = Number(process.argv[5] ?? 1000);
const HEIGHT = Number(process.argv[6] ?? 640);

const scenePath = resolve(process.argv[2] ?? 'scene.html');
const outDir = resolve(process.argv[3] ?? 'frames');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars'],
});
const context = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
await page.goto('file://' + scenePath);
await page.waitForFunction(() => window.__ready === true);
await page.evaluate(() => document.fonts.ready);

const totalFrames = Math.round((DURATION_MS / 1000) * FPS);
for (let i = 0; i < totalFrames; i++) {
  const t = (i * 1000) / FPS;
  await page.evaluate((ms) => window.seek(ms), t);
  const name = `frame_${String(i).padStart(4, '0')}.png`;
  await page.screenshot({ path: `${outDir}/${name}` });
  if (i % 30 === 0) console.log(`frame ${i}/${totalFrames} (t=${Math.round(t)}ms)`);
}

await browser.close();
console.log(`done: ${totalFrames} frames -> ${outDir}`);
