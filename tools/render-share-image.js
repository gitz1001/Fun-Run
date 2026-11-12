/**
 * Renders the link-preview card and the home-screen icon:
 *
 *   assets-src/share-image.html -> public/og/share.jpg        (1200 × 630)
 *   public/favicon.svg          -> public/apple-touch-icon.png (180 × 180)
 *
 *   node tools/render-share-image.js
 *
 * Needs Playwright with Chromium. Facebook and Messenger cache a preview for
 * days, so after changing the card, ask them to fetch it again with the
 * Sharing Debugger (developers.facebook.com/tools/debug) and "Scrape Again".
 */
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Playwright is not a dependency of the site: use a local install if there
// is one, otherwise the global one.
async function loadPlaywright() {
  try { return await import('playwright'); } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(path.join(globalRoot, 'noop.js'))('playwright');
  }
}
const { chromium } = await loadPlaywright();

const root = fileURLToPath(new URL('..', import.meta.url));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(`file://${path.join(root, 'assets-src/share-image.html')}`);
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(path.join(root, 'public/og'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'public/og/share.jpg'), type: 'jpeg', quality: 86 });

  const svg = readFileSync(path.join(root, 'public/favicon.svg'), 'utf8');
  const icon = await browser.newPage({ viewport: { width: 180, height: 180 }, deviceScaleFactor: 1 });
  // iOS rounds the corners itself and fills transparency with black, so the
  // icon is drawn full-bleed: the favicon with its own rounding taken off.
  await icon.setContent(`<body style="margin:0">${svg
    .replace('<svg', '<svg width="180" height="180"').replace(/ rx="\d+"/, '')}</body>`);
  await icon.screenshot({ path: path.join(root, 'public/apple-touch-icon.png'), type: 'png' });
  console.log('wrote public/og/share.jpg and public/apple-touch-icon.png');
} finally {
  await browser.close();
}
