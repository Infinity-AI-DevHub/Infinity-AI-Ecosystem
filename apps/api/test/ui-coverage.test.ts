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

/**
 * A page size the API will refuse is a silently empty screen.
 *
 * The API caps `limit` at MAX_PAGE_SIZE and answers 422 above it. Three pickers asked
 * for 200: the person to send a message to, the colleague to ask for a countersignature,
 * and the people on a task. Each one 422'd, each one rendered "nobody matches that", and
 * all three features looked built but unusable - which is exactly how they were
 * reported. Nothing in the type system connects the two numbers, so it is checked here.
 */
/**
 * An internal notice must not be emailed to a client.
 *
 * Guests carry the same company_id as colleagues, so any recipient query that selects on
 * company_id alone reaches them too. That is how a company-wide announcement about
 * office closures went out to a client contact - the message composer had always
 * excluded guests here, and the announcement handler never had.
 */
describe('announcement audience', () => {
  it('never selects guests as recipients', () => {
    const src = readFileSync('src/workers/handlers.ts', 'utf8');
    const start = src.indexOf('const onAnnouncementPublished');
    assert.ok(start > -1, 'announcement handler not found - update this test');
    const body = src.slice(start, src.indexOf('\n};', start));

    // Every recipient query inside the handler, as the SQL actually sent.
    const queries = [...body.matchAll(/`(SELECT[\s\S]*?)`/g)].map((m) => m[1]!);
    const fromUsers = queries.filter((q) => /FROM users/i.test(q));
    assert.ok(fromUsers.length > 0, 'no recipient queries found - update this test');

    const leaky = fromUsers.filter((q) => !/access_level\s*<>\s*'guest'/.test(q));
    assert.deepEqual(
      leaky,
      [],
      `these announcement queries would email guests:\n${leaky.join('\n---\n')}`,
    );
  });
});

/**
 * Uploaded files must not render inline on the API's origin.
 *
 * The object route serves everything as `application/octet-stream; attachment` for a
 * reason: an uploaded HTML file rendered inline would execute on this origin. A short
 * allow-list of image types is served inline so logos and signatures display in the app,
 * and it must stay short - SVG in particular can carry script.
 */
describe('inline object serving', () => {
  it('only ever serves a fixed set of image types inline', () => {
    const src = readFileSync('src/http/routes/admin.ts', 'utf8');
    const listed = /const INLINE_IMAGE = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(listed, 'INLINE_IMAGE allow-list not found - update this test');

    const types = [...listed[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    assert.deepEqual(
      types.sort(),
      ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
      'the inline allow-list changed; anything scriptable here executes on the API origin',
    );
    assert.ok(!src.includes("'image/svg+xml'"), 'SVG must never be served inline');
  });
});

describe('client paging', () => {
  it('never asks for more than the API will return', () => {
    const cap = Number(
      /maxPageSize: int\('MAX_PAGE_SIZE', (\d+)\)/.exec(
        readFileSync('src/core/config.ts', 'utf8'),
      )?.[1] ?? 100,
    );

    const offenders: string[] = [];
    for (const file of walk('../web/src')) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/limit=(\d+)/g)) {
        if (Number(m[1]) > cap) offenders.push(`${file}: limit=${m[1]} (max ${cap})`);
      }
    }

    assert.deepEqual(offenders, [], `these requests are refused by the API:\n${offenders.join('\n')}`);
  });
});

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

    /**
     * Paths handed to a component rather than called directly.
     *
     * RecordEditor takes the endpoint as a `path` prop and PATCHes it, so the call site
     * is `api.patch(path, …)` with a variable and the literal never appears next to a
     * verb. Treating those props as PATCH usage is accurate — that component does
     * nothing else — and without it every screen built on it looks unreachable.
     */
    for (const m of client.matchAll(/path=\{`([^`]+)`\}/g)) {
      const stem = m[1]!.replace(/\$\{[^}]*\}/g, ':x').replace(/\/$/, '');
      if (!calls.has(stem)) calls.set(stem, new Set());
      calls.get(stem)!.add('patch');
    }

    /**
     * A route parameter matches any single literal segment.
     *
     * `/signatures/:type/:id/sign` is called as `/signatures/quotation/${id}/sign` — the
     * client fills one parameter with a literal and interpolates the other. Comparing
     * normalised strings misses that, so the route becomes a pattern instead.
     */
    const covered = (verb: string, path: string) => {
      const pattern = new RegExp(
        '^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/:[a-zA-Z]+/g, '/[^/]+'),
      );
      for (const [known, verbs] of calls) {
        if (!verbs.has(verb)) continue;
        if (pattern.test(known)) return true;
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
