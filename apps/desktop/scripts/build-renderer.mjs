/**
 * Builds the renderer for the desktop client.
 *
 * The renderer's API origin is a build-time constant - Vite inlines import.meta.env at
 * compile time, so there is no runtime lookup to fall back on. Building it without
 * VITE_API_URL silently produces a bundle that calls http://localhost, which then fails
 * on every employee's machine as "Cannot reach Infinity Workspace" while the server,
 * CORS and the app itself are all healthy. There is nothing in that symptom pointing at
 * the build, which is what makes it expensive.
 *
 * The URL is read from main/config.ts so the two cannot drift, and the built output is
 * checked before it can be packaged.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const configSource = readFileSync(resolve(here, '..', 'src', 'main', 'config.ts'), 'utf8');

const match = configSource.match(/PRODUCTION_API\s*=\s*'([^']+)'/);
if (!match) {
  console.error('Could not read PRODUCTION_API from src/main/config.ts.');
  process.exit(1);
}
const apiUrl = match[1];
console.log(`Building renderer against ${apiUrl}`);

const webDir = resolve(here, '..', '..', 'web');
execFileSync('npm', ['--prefix', webDir, 'run', 'build'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_API_URL: apiUrl },
});

// Verify rather than trust: a missing env var fails silently and looks identical to a
// working build until someone tries to sign in.
const assets = resolve(here, '..', '..', 'web', 'dist', 'assets');
const offenders = [];
for (const file of readdirSync(assets).filter((f) => f.endsWith('.js'))) {
  const source = readFileSync(join(assets, file), 'utf8');
  // 'localhost:' with the colon, deliberately: react-router carries a bare
  // "http://localhost" default internally, and matching that would fail every build.
  if (source.includes('localhost:')) offenders.push(file);
}
if (offenders.length > 0) {
  console.error(`\nThe built renderer still points at localhost: ${offenders.join(', ')}`);
  console.error('It would ship unable to reach the API. Refusing to continue.');
  process.exit(1);
}
console.log(`Renderer verified: no localhost origin in the bundle.`);
