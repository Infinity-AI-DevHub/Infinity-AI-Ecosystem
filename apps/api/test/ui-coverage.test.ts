/**
 * Every write operation the API exposes must be reachable from the interface.
 *
 * This exists because a whole class of bug kept reaching the user: the domain logic,
 * the route and the permission were all correct, and there was simply no button. Leave
 * types could be created by the API and not by an administrator; a client's billing
 * email could be edited by the API and not by anyone, which made the invoice guard
 * impossible to satisfy.
 *
 * A route with no caller is either missing an affordance or is dead code. Both are worth
 * knowing about, so new ones have to be listed here deliberately rather than discovered
 * by someone trying to do their job.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Known gaps, each with the reason it is acceptable. Removing an entry is how a new
 * screen gets built; adding one should need an argument.
 */
const ACCEPTED = new Map<string, string>([
  ['POST /auth/token/refresh', 'called by the token layer, not by a screen'],
  ['POST /files/uploads/:id/content', 'raw multipart fetch, not through the api helper'],
  ['PUT /objects/upload', 'signed upload URL is returned dynamically by the API'],
  ['POST /chat/rooms/:id/typing', 'sent over the realtime channel'],
  ['PATCH /chat/rooms/:id/messages/:messageId', 'message editing UI not built'],
  ['DELETE /chat/rooms/:id/messages/:messageId', 'message deletion UI not built'],
  ['POST /chat/rooms/:id/messages/:messageId/reactions', 'reactions UI not built'],
  ['POST /chat/rooms/:id/members', 'adding people to a channel not built'],
  ['PATCH /calendar/events/:id', 'meeting editing not built'],
  ['DELETE /calendar/events/:id', 'meeting cancellation not built'],
  ['POST /approvals/:id/cancel', 'withdrawing your own request not built'],
  ['POST /expenses/categories', 'expense category admin not built'],
  ['POST /files/:id/share', 'file share dialog not built'],
  ['POST /files/:id/legal-hold', 'legal hold not built'],
  ['DELETE /share-links/:id', 'revoking a share link not built'],
  ['POST /external/guests/:id/grants', 'guest resource grants not built'],
  ['POST /users/:id/invitation', 'resending an invitation not built'],
  ['POST /users/:id/offboard', 'offboarding UI not built'],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('interface coverage', () => {
  it('every write route is reachable, or listed as a known gap', () => {
    const routes: { verb: string; path: string }[] = [];
    for (const file of readdirSync('src/http/routes')) {
      if (!file.endsWith('.ts')) continue;
      const src = readFileSync(join('src/http/routes', file), 'utf8');
      for (const m of src.matchAll(/app\.(get|post|patch|put|delete)\(\s*'([^']+)'/g)) {
        routes.push({ verb: m[1]!.toLowerCase(), path: m[2]! });
      }
    }

    const client = walk('../web/src').map((f) => readFileSync(f, 'utf8')).join('\n');
    const calls = new Map<string, Set<string>>();
    for (const m of client.matchAll(
      /api\.(get|post|patch|put|delete)(?:<[^>]*>)?\(\s*[`'"]([^`'"]+)/g,
    )) {
      const stem = m[2]!.replace(/\$\{[^}]*\}/g, ':x').split('?')[0]!.replace(/\/$/, '');
      if (!calls.has(stem)) calls.set(stem, new Set());
      calls.get(stem)!.add(m[1]!);
    }

    const covered = (verb: string, path: string) => {
      const stem = path.replace(/\/:[a-zA-Z]+/g, '/:x').replace(/\/$/, '');
      for (const [known, verbs] of calls) {
        if (known.startsWith(stem) && verbs.has(verb)) return true;
      }
      return false;
    };

    const unreachable = routes
      .filter((r) => ['post', 'patch', 'put', 'delete'].includes(r.verb))
      .map((r) => `${r.verb.toUpperCase()} ${r.path}`)
      .filter((key, index, all) => all.indexOf(key) === index)
      .filter((key) => {
        const [verb, path] = key.split(' ') as [string, string];
        return !covered(verb.toLowerCase(), path);
      });

    const unexpected = unreachable.filter((key) => !ACCEPTED.has(key));
    assert.deepEqual(
      unexpected,
      [],
      `These write operations have no way to reach them from the interface.\n` +
        `Build the affordance, or add it to ACCEPTED with a reason:\n\n` +
        unexpected.map((k) => `  ${k}`).join('\n'),
    );

    // A stale exemption is its own bug: it hides that the screen now exists.
    const stale = [...ACCEPTED.keys()].filter((key) => !unreachable.includes(key));
    assert.deepEqual(stale, [], `No longer missing — remove from ACCEPTED:\n${stale.join('\n')}`);
  });
});

/**
 * Browser APIs the desktop client does not implement.
 *
 * `window.prompt` is the specific trap: Electron does not implement it, and it fails by
 * returning undefined rather than by throwing. A button guarded by one appears to work
 * and silently discards the value it asked for - which is how "Void invoice" and "Send
 * back" shipped broken in the desktop app while working in a browser.
 *
 * Both hosts run the same renderer, so anything relied on here has to work in both.
 */
describe('desktop host compatibility', () => {
  it('the renderer does not call browser APIs Electron lacks', () => {
    const forbidden = [
      { pattern: /(?<![.\w])prompt\s*\(/, why: 'window.prompt is not implemented in Electron; use useTextPrompt()' },
      { pattern: /document\.execCommand\('paste'/, why: 'clipboard read is blocked; use the clipboard API' },
      { pattern: /window\.showSaveFilePicker/, why: 'not available in Electron; use saveDownload()' },
      { pattern: /window\.showOpenFilePicker/, why: 'not available in Electron; use the desktop bridge' },
    ];

    const files = walk('../web/src');
    const failures: string[] = [];
    for (const file of files) {
      // The replacement component names the API it replaces, in prose.
      if (file.endsWith('components/Prompt.tsx')) continue;
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
        for (const { pattern, why } of forbidden) {
          if (pattern.test(line)) failures.push(`${file}:${index + 1} — ${why}\n    ${trimmed}`);
        }
      });
    }
    assert.deepEqual(failures, [], `Browser-only APIs in the renderer:\n\n${failures.join('\n\n')}`);
  });
});
