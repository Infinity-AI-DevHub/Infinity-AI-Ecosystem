/**
 * The invoice filter tabs must ask for something the API accepts.
 *
 * The Finance page offered an "Awaiting approval" tab, the domain had a clause for it,
 * and the route's schema did not list it — so the tab returned a validation error and
 * the section rendered as broken. Three lists have to agree, and nothing was checking.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const domain = readFileSync(join(process.cwd(), 'src/domains/invoicing.ts'), 'utf8');
const route = readFileSync(join(process.cwd(), 'src/http/routes/finance.ts'), 'utf8');
const ui = readFileSync(
  join(process.cwd(), '../web/src/components/Invoices.tsx'),
  'utf8',
);

/** The keys of the BUCKETS map in the domain. */
function domainBuckets(): string[] {
  const block = domain.slice(domain.indexOf('const BUCKETS'), domain.indexOf('};', domain.indexOf('const BUCKETS')));
  return [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!);
}

/** The values the route's bucket enum admits. */
function routeBuckets(): string[] {
  const start = route.indexOf('bucket: z');
  const block = route.slice(start, route.indexOf('.default(', start));
  return [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** The bucket values the interface actually asks for. */
function uiBuckets(): string[] {
  const start = ui.indexOf('const buckets:');
  if (start === -1) return [];
  const block = ui.slice(start, ui.indexOf('];', start));
  return [...block.matchAll(/\['([a-z_]+)',/g)].map((m) => m[1]!);
}

describe('invoice buckets', () => {
  it('offers the interface nothing the route will refuse', () => {
    const accepted = new Set(routeBuckets());
    const refused = uiBuckets().filter((bucket) => !accepted.has(bucket));
    assert.deepEqual(refused, [], 'the Finance page asks for a bucket the API rejects');
  });

  it('accepts nothing the domain cannot answer', () => {
    const known = new Set(domainBuckets());
    const unanswerable = routeBuckets().filter((bucket) => !known.has(bucket));
    assert.deepEqual(unanswerable, [], 'the route admits a bucket with no clause behind it');
  });

  it('finds all three lists, so a rename cannot make this test vacuous', () => {
    assert.ok(domainBuckets().length >= 8, 'no domain buckets found');
    assert.ok(routeBuckets().length >= 8, 'no route buckets found');
    assert.ok(uiBuckets().length >= 5, 'no interface buckets found');
  });
});
