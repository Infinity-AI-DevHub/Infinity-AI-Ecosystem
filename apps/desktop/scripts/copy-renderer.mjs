/**
 * Copies the built renderer into the Electron bundle.
 *
 * The main process serves `dist/renderer` over the app:// scheme, so the React build has
 * to physically live inside the packaged application rather than being referenced from a
 * sibling directory that will not exist on an employee's machine.
 */
import { cp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '../../web/dist');
const target = join(here, '../dist/renderer');

try {
  await stat(source);
} catch {
  console.error(
    'The renderer has not been built. Run `npm run build` in apps/web first — packaging ' +
      'an application with no interface in it is not a useful thing to produce.',
  );
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log(`renderer copied into ${target}`);
