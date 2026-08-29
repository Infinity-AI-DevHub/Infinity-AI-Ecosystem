/**
 * Writes the update feed the client reads.
 *
 * A static JSON document rather than a release service: there is nothing to run, nothing
 * to keep patched, and it is served by the same nginx that serves the installers. The
 * client refuses a download URL that does not live on the update host, so the feed cannot
 * redirect anyone to a binary from somewhere else.
 *
 *   node scripts/make-feed.mjs > release/latest.json
 */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const releaseDir = join(dirname(fileURLToPath(import.meta.url)), '../release');

const files = await readdir(releaseDir).catch(() => []);
const find = (pattern) => files.find((name) => pattern.test(name));

const dmg = find(/\.dmg$/);
const exe = find(/\.exe$/);

if (!dmg && !exe) {
  console.error('No installers found in release/. Run `npm run package` first.');
  process.exit(1);
}

const downloads = {};
// Both macOS architectures ship in one universal-ish dmg here; the platform key is what
// the client matches on, and it only ever asks about its own.
if (dmg) downloads.darwin = dmg;
if (exe) downloads.win32 = exe;

process.stdout.write(
  `${JSON.stringify({ version, released: new Date().toISOString(), downloads }, null, 2)}\n`,
);
