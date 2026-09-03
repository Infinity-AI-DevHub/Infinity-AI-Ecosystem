/**
 * The client portal's boundary.
 *
 * These are the properties that, if they broke, would show one client another client's
 * money. They are asserted against the SQL itself rather than a running server, because
 * the guarantee is structural: the organisation is part of every query, and an unsent
 * document is excluded in the query. A filter applied after the fact — or a route that
 * accepts an organisation id — is the failure mode worth catching at review time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const domain = readFileSync(join(process.cwd(), 'src/domains/portal.ts'), 'utf8');
const routes = readFileSync(join(process.cwd(), 'src/http/routes/portal.ts'), 'utf8');
const guestSurface = readFileSync(join(process.cwd(), 'src/http/guest-surface.ts'), 'utf8');

/** Every SELECT in the portal domain, as a single flattened string each. */
function selects(source: string): string[] {
  return [...source.matchAll(/`(SELECT[\s\S]*?)`/g)].map((m) => m[1]!.replace(/\s+/g, ' '));
}

describe('client portal scope', () => {
  it('reads no commercial table without scoping to one organisation', () => {
    const offenders = selects(domain)
      .filter((sql) => /FROM (invoices|quotations)\b/i.test(sql))
      .filter((sql) => !/(client_org_id|q\.org_id) = \$/i.test(sql));
    assert.deepEqual(offenders, [], 'a portal query reads invoices or quotations company-wide');
  });

  it('never shows a document that was not sent to the client', () => {
    const offenders = selects(domain)
      .filter((sql) => /FROM (invoices|quotations)\b/i.test(sql))
      .filter((sql) => !/sent_at IS NOT NULL/i.test(sql));
    assert.deepEqual(offenders, [], 'a portal query can return an unsent draft');
  });

  it('scopes every query by company as well as organisation', () => {
    const offenders = selects(domain).filter((sql) => !/company_id = \$/i.test(sql));
    assert.deepEqual(offenders, [], 'a portal query is not tenant-scoped');
  });

  it('takes the organisation from the actor, never from the request', () => {
    const code = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    assert.ok(
      !/organisationId|organizationId|orgId/.test(code),
      'a portal route accepts an organisation from the caller',
    );
    // Every read path must go through the one function that resolves it from membership.
    const reads = [...domain.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    for (const name of reads.filter((n) => n !== 'myOrganisation')) {
      const body = domain.slice(domain.indexOf(`export async function ${name}`));
      const end = body.indexOf('\nexport async function', 1);
      assert.match(
        end === -1 ? body : body.slice(0, end),
        /myOrganisation\(actor\)/,
        `${name} does not resolve the organisation from the actor`,
      );
    }
  });

  it('names every portal route it opens, rather than using a wildcard', () => {
    // Asserted as a property, not as a literal: the list of portal routes grows, and a
    // test pinned to the exact string only ever reports that somebody edited it.
    assert.ok(guestSurface.includes('portal'), 'the guest surface opens no portal routes');

    // A wildcard under /portal would admit any route added there later without review,
    // which is the whole point of a deny-by-default surface.
    const portalPatterns = guestSurface
      .split('\n')
      .filter((line) => line.includes('portal') && line.trim().startsWith('/^'));
    assert.ok(portalPatterns.length > 0, 'no portal patterns found');
    for (const line of portalPatterns) {
      assert.ok(!line.includes('.*'), `the guest surface opens /portal with a wildcard: ${line.trim()}`);
    }
  });
});
