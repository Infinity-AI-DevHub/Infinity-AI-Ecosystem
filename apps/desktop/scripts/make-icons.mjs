/**
 * Generates every icon asset from build/icon.svg.
 *
 * No rasteriser is assumed to be installed - not rsvg, ImageMagick or Inkscape - so the
 * rendering is done by headless Chrome, which every developer here already has. The
 * alternative was adding a native image dependency to a project that needs one PNG.
 *
 *   node scripts/make-icons.mjs
 *
 * Outputs:
 *   build/icon.png       1024, full bleed        -> Windows .ico, and the fallback
 *   build/icon-mac.png   1024, inset to 824      -> macOS .icns
 *   ../web/public/favicon.svg                    -> web favicon and in-product logo
 *   ../web/public/icon-192.png, icon-512.png     -> installable web-app icons
 *
 * electron-builder converts the PNGs to .icns and .ico itself at package time.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, '..', 'build');
const master = join(buildDir, 'icon.svg');

const CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => existsSync(p));

if (!CHROME) {
  console.error('No Chrome or Chromium found. Install one, or render build/icon.svg to');
  console.error('build/icon.png (1024x1024) with any tool and re-run the package step.');
  process.exit(1);
}

const svg = readFileSync(master, 'utf8');

/**
 * macOS draws icons on a fixed grid: the artwork occupies 824 of 1024 points, and the
 * surrounding margin is what makes it sit level with its neighbours in the dock. A
 * full-bleed icon is not clipped, it just looks oversized next to everything else.
 */
function page(size, inset) {
  const art = size - inset * 2;
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
svg{display:block;position:absolute;left:${inset}px;top:${inset}px;width:${art}px;height:${art}px}</style>
${svg}`;
}

function render(outPath, size, inset) {
  const dir = mkdtempSync(join(tmpdir(), 'icon-'));
  const html = join(dir, 'i.html');
  writeFileSync(html, page(size, inset));
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars',
    '--default-background-color=00000000',
    `--screenshot=${outPath}`,
    `--window-size=${size},${size}`,
    `--force-device-scale-factor=1`,
    `file://${html}`,
  ], { stdio: 'pipe' });
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ${outPath.split('/').pop().padEnd(16)} ${size}x${size}`);
}

console.log('Rendering icons from build/icon.svg');
render(join(buildDir, 'icon.png'), 1024, 0);
render(join(buildDir, 'icon-mac.png'), 1024, 100);

// The web favicon and installable icons use the same artwork as the desktop client.
const webPublic = resolve(here, '..', '..', 'web', 'public');
const favicon = join(webPublic, 'favicon.svg');
writeFileSync(favicon, svg);
console.log(`  favicon.svg      -> apps/web/public`);
render(join(webPublic, 'icon-192.png'), 192, 0);
render(join(webPublic, 'icon-512.png'), 512, 0);
