/**
 * Unit tests: domain rules, validators, policy evaluation and parsing helpers
 * (blueprint 17, "Unit" level). These run without a database.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  hashPassword,
  verifyPassword,
  passwordNeedsRehash,
  encryptField,
  decryptField,
  hashToken,
} from '../src/core/crypto.js';
import { sanitizeEmailHtml, htmlToText, snippet } from '../src/core/sanitize.js';
import {
  safeFilename,
  isDangerousAttachment,
  encodeCursor,
  decodeCursor,
  escapeHtml,
} from '../src/core/validation.js';
import { hasCapability, assertSeparationOfDuties, type Actor } from '../src/core/authz.js';
import { redact } from '../src/core/audit.js';
import { buildMime, assertNoHeaderInjection } from '../src/adapters/notifier.js';
import { sniffMimeType } from '../src/adapters/scanner.js';

function actor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: '11111111-1111-1111-1111-111111111111',
    companyId: '22222222-2222-2222-2222-222222222222',
    email: 'person@example.com',
    displayName: 'Person',
    accessLevel: 'staff',
    status: 'active',
    departmentId: null,
    managerId: null,
    capabilities: new Set(['file.read', 'task.update', 'user.suspend']),
    groupIds: [],
    sessionId: 'session',
    tokenId: null,
    tokenScopes: null,
    ...overrides,
  };
}

describe('password hashing', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    assert.equal(await verifyPassword('correct horse battery staple', hash), true);
    assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
  });

  it('produces a different hash for the same password (unique salt)', async () => {
    const a = await hashPassword('same-password-value');
    const b = await hashPassword('same-password-value');
    assert.notEqual(a, b);
  });

  it('never throws on malformed or missing stored hashes', async () => {
    assert.equal(await verifyPassword('x', null), false);
    assert.equal(await verifyPassword('x', 'not-a-hash'), false);
    assert.equal(await verifyPassword('x', 'scrypt$bad$8$1$zz$zz'), false);
  });

  it('flags weaker stored parameters for rehash', () => {
    assert.equal(passwordNeedsRehash('scrypt$1024$8$1$c2FsdA==$aGFzaA=='), true);
    assert.equal(passwordNeedsRehash(null), true);
  });
});

describe('field encryption', () => {
  it('round-trips a value', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    assert.equal(decryptField(encryptField(secret)), secret);
  });

  it('rejects a tampered ciphertext', () => {
    const payload = encryptField('sensitive');
    const parts = payload.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => decryptField(parts.join('.')));
  });
});

describe('email HTML sanitizer', () => {
  it('removes script elements and their content', () => {
    const out = sanitizeEmailHtml('<p>Hi</p><script>steal(document.cookie)</script>');
    assert.equal(out.includes('script'), false);
    assert.equal(out.includes('steal'), false);
  });

  it('strips event handler attributes', () => {
    const out = sanitizeEmailHtml('<p onclick="alert(1)" onmouseover="x()">text</p>');
    assert.equal(out.includes('onclick'), false);
    assert.equal(out.includes('onmouseover'), false);
    assert.equal(out.includes('text'), true);
  });

  it('drops javascript: and data: URLs but keeps https links', () => {
    assert.equal(
      sanitizeEmailHtml('<a href="javascript:alert(1)">x</a>').includes('javascript'),
      false,
    );
    // Markup smuggled inside an attribute value must not escape as a live tag.
    const smuggled = sanitizeEmailHtml('<a href="data:text/html,<b>">x</a>');
    assert.equal(/href\s*=/.test(smuggled), false);
    assert.equal(smuggled.includes('<b>'), false);
    const safe = sanitizeEmailHtml('<a href="https://example.com">x</a>');
    assert.equal(safe.includes('https://example.com'), true);
    assert.equal(safe.includes('rel="noopener noreferrer nofollow"'), true);
  });

  it('blocks remote images by default to prevent tracking', () => {
    const out = sanitizeEmailHtml('<img src="https://tracker.example/pixel.gif">');
    assert.equal(out.includes('data-blocked-src'), true);
    assert.equal(/\ssrc=/.test(out), false);
  });

  it('removes inline styles and svg payloads', () => {
    const out = sanitizeEmailHtml('<div style="position:fixed">x</div><svg onload="alert(1)"></svg>');
    assert.equal(out.includes('style'), false);
    assert.equal(out.includes('svg'), false);
  });

  it('closes tags the source left open', () => {
    const out = sanitizeEmailHtml('<div><p>unterminated');
    assert.equal(out.endsWith('</p></div>'), true);
  });

  it('escapes stray angle brackets in text', () => {
    assert.equal(sanitizeEmailHtml('a < b').includes('&lt;'), true);
  });

  it('preserves well-formed block structure exactly', () => {
    assert.equal(
      sanitizeEmailHtml('<p>Hello</p><p>World</p>'),
      '<p>Hello</p><p>World</p>',
    );
  });

  it('keeps nested formatting and tables intact', () => {
    assert.equal(
      sanitizeEmailHtml('<table><tr><td><strong>A</strong></td></tr></table>'),
      '<table><tr><td><strong>A</strong></td></tr></table>',
    );
  });

  it('keeps the text of a disallowed tag while dropping the tag', () => {
    const out = sanitizeEmailHtml('<marquee>scrolling</marquee>');
    assert.equal(out.includes('marquee'), false);
    assert.equal(out.includes('scrolling'), true);
  });
});

describe('html to text', () => {
  it('produces readable plain text', () => {
    assert.equal(htmlToText('<p>Hello</p><p>World</p>'), 'Hello\nWorld');
  });

  it('truncates snippets with an ellipsis', () => {
    assert.equal(snippet('a'.repeat(300), 20).length, 20);
  });
});

describe('filename safety', () => {
  it('strips path traversal segments', () => {
    assert.equal(safeFilename('../../etc/passwd'), 'passwd');
    assert.equal(safeFilename('..\\..\\windows\\system32'), 'system32');
  });

  it('removes leading dots and control characters', () => {
    assert.equal(safeFilename('...hidden'), 'hidden');
    assert.equal(safeFilename(`re${String.fromCharCode(7)}port.pdf`), 'report.pdf');
  });

  it('never returns an empty name', () => {
    assert.equal(safeFilename('///'), 'file');
  });

  it('recognises executable attachment types', () => {
    assert.equal(isDangerousAttachment('invoice.pdf.exe'), true);
    assert.equal(isDangerousAttachment('macro.vbs'), true);
    assert.equal(isDangerousAttachment('report.pdf'), false);
  });
});

describe('pagination cursors', () => {
  it('round-trips', () => {
    const cursor = encodeCursor({ at: '2026-01-01T00:00:00.000Z', id: 'abc' });
    assert.deepEqual(decodeCursor(cursor), { at: '2026-01-01T00:00:00.000Z', id: 'abc' });
  });

  it('rejects a malformed cursor', () => {
    assert.throws(() => decodeCursor('!!!not-base64!!!'));
  });
});

describe('authorization', () => {
  it('denies a capability the role does not hold', () => {
    assert.equal(hasCapability(actor(), 'user.create'), false);
    assert.equal(hasCapability(actor(), 'file.read'), true);
  });

  it('denies every capability to a non-active account', () => {
    assert.equal(hasCapability(actor({ status: 'suspended' }), 'file.read'), false);
  });

  it('narrows a service token to its own scopes', () => {
    const service = actor({ tokenScopes: ['task.update'] });
    assert.equal(hasCapability(service, 'task.update'), true);
    assert.equal(hasCapability(service, 'file.read'), false);
  });

  it('blocks a requester approving their own request', () => {
    assert.throws(() => assertSeparationOfDuties('user-a', 'user-a'), /Separation of duties/);
    assert.doesNotThrow(() => assertSeparationOfDuties('user-a', 'user-b'));
  });
});

describe('audit redaction', () => {
  it('removes credentials and tokens from recorded state', () => {
    const out = redact({
      email: 'person@example.com',
      password: 'hunter2',
      token: 'secret-token',
      nested: { recoveryCodes: ['a', 'b'], displayName: 'Person' },
    }) as Record<string, unknown>;
    assert.equal(out.password, '[redacted]');
    assert.equal(out.token, '[redacted]');
    assert.equal((out.nested as Record<string, unknown>).recoveryCodes, '[redacted]');
    assert.equal(out.email, 'person@example.com');
  });

  it('truncates very long strings', () => {
    const out = redact({ note: 'x'.repeat(1000) }) as Record<string, string>;
    assert.equal((out.note ?? '').length <= 513, true);
  });
});

describe('MIME construction', () => {
  it('rejects header injection in an address or subject', () => {
    assert.throws(() => assertNoHeaderInjection('a@b.com\r\nBcc: attacker@evil.com', 'to'));
    assert.throws(() =>
      buildMime({
        from: { address: 'a@b.com' },
        to: ['c@d.com'],
        subject: 'Hi\r\nBcc: attacker@evil.com',
        text: 'body',
      }),
    );
  });

  it('builds a multipart message with the expected headers', () => {
    const { raw, messageId } = buildMime({
      from: { address: 'sender@example.com', name: 'Sender' },
      to: ['a@example.com'],
      cc: ['b@example.com'],
      subject: 'Quarterly report',
      text: 'Plain body',
      html: '<p>HTML body</p>',
    });
    assert.equal(raw.includes('From: Sender <sender@example.com>'), true);
    assert.equal(raw.includes('Cc: b@example.com'), true);
    assert.equal(raw.includes('Subject: Quarterly report'), true);
    assert.equal(raw.includes('multipart/alternative'), true);
    assert.equal(messageId.startsWith('<'), true);
  });

  it('encodes non-ASCII subjects as RFC 2047 words', () => {
    const { raw } = buildMime({
      from: { address: 'a@b.com' },
      to: ['c@d.com'],
      subject: 'Réunion budgétaire',
      text: 'x',
    });
    assert.equal(raw.includes('=?UTF-8?B?'), true);
  });
});

describe('MIME sniffing', () => {
  it('identifies real types regardless of the declared one', () => {
    assert.equal(sniffMimeType(Buffer.from('%PDF-1.7'), 'image/png'), 'application/pdf');
    assert.equal(sniffMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'text/plain'), 'image/png');
    assert.equal(
      sniffMimeType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), 'image/png'),
      'application/x-msdownload',
    );
  });

  it('never serves sniffed HTML as text/html by accident', () => {
    assert.equal(sniffMimeType(Buffer.from('<!doctype html><b>x'), 'text/plain'), 'text/html');
  });
});

describe('output encoding', () => {
  it('escapes HTML metacharacters', () => {
    assert.equal(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
  });
});

/**
 * SQL portability.
 *
 * The schema and queries have to run on both MySQL 8 and MariaDB. Three separate
 * outages this project has already had came from constructs that exist in only one of
 * them - a multi-valued index, SELECT ... FOR UPDATE SKIP LOCKED, and the `->` / `->>`
 * JSON operators - and each was found by a person hitting a 500, not by a test.
 *
 * A grep is a crude check, but it runs in milliseconds without a database and it fails
 * on the developer's machine rather than in production. The constructs below are all
 * avoidable: JSON_EXTRACT and JSON_UNQUOTE say the same thing and parse on both.
 */
describe('SQL portability', () => {
  const FORBIDDEN: { pattern: RegExp; why: string }[] = [
    { pattern: /->>/, why: 'the ->> operator is MySQL-only; use JSON_UNQUOTE(JSON_EXTRACT(col, path))' },
    { pattern: /->'\$\./, why: "the -> operator is MySQL-only; use JSON_EXTRACT(col, '$.path')" },
    { pattern: /SKIP\s+LOCKED/i, why: 'SKIP LOCKED is MySQL-only; claim rows with a lock token' },
    { pattern: /JSON_OVERLAPS/i, why: 'JSON_OVERLAPS is MySQL-only; use jsonArrayOverlaps() from core/db' },
    { pattern: /CAST\([^)]*AS\s+CHAR\([^)]*\)\s+ARRAY/i, why: 'multi-valued indexes are MySQL-only' },
    { pattern: /utf8mb4_0900/i, why: 'utf8mb4_0900_ai_ci does not exist in MariaDB; use utf8mb4_unicode_ci' },
  ];

  it('uses no MySQL-only syntax in source or migrations', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|sql)$/.test(entry) && !full.includes('/test/')) files.push(full);
      }
    };
    walk('src');
    walk('migrations');

    const failures: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        // Comments explain these constructs on purpose; only real SQL counts.
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('--')) return;
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(line)) failures.push(`${file}:${index + 1} — ${why}\n    ${trimmed}`);
        }
      });
    }
    assert.equal(failures.length, 0, `MySQL-only SQL found:\n\n${failures.join('\n\n')}\n`);
  });
});

/**
 * Notification severity.
 *
 * The default must stay quiet. If an unclassified notification defaulted to a warning,
 * every new notification type added later would start out interrupting people, and the
 * banner would stop carrying meaning long before anyone noticed.
 */
describe('notification severity', () => {
  it('classifies by kind and defaults to information', async () => {
    const { severityFor } = await import('../src/domains/notifications.js');
    assert.equal(severityFor('file.quarantined'), 'critical');
    assert.equal(severityFor('approval.awaiting'), 'warning');
    assert.equal(severityFor('approval.progress'), 'success');
    assert.equal(severityFor('task.assigned'), 'info');
    assert.equal(severityFor('meeting.invited'), 'info');
    // The important one: anything unknown is quiet, not loud.
    assert.equal(severityFor('something.invented.later'), 'info');
  });
});

/**
 * Recurrence expansion.
 *
 * A recurring meeting is stored as one row plus a rule, so anything that lists rows
 * shows only the first occurrence — which is exactly how a weekly meeting created in
 * September disappeared from the calendar in October.
 */
describe('recurrence', () => {
  it('expands a weekly series into the window that asks for it', async () => {
    const { parseRecurrence, occurrencesBetween } = await import('../src/core/recurrence.js');
    const rule = parseRecurrence('FREQ=WEEKLY;COUNT=8')!;
    const start = new Date('2026-09-01T09:00:00Z');
    const hour = 3_600_000;

    // A window a month later still finds the series — the original failure, where a
    // September meeting simply did not exist in October.
    //
    // Eight weekly occurrences from 1 September run 1, 8, 15, 22, 29 September and
    // 6, 13, 20 October, so exactly three land in October and the series then stops.
    const october = occurrencesBetween(start, hour, rule,
      new Date('2026-10-01T00:00:00Z'), new Date('2026-10-31T23:59:59Z'));
    assert.equal(october.length, 3, 'the tail of an eight-week series');
    assert.equal(october[0]!.toISOString(), '2026-10-06T09:00:00.000Z');

    // COUNT is counted from the start of the series, not from the window.
    const everything = occurrencesBetween(start, hour, rule,
      new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'));
    assert.equal(everything.length, 8);

    // And the series really does stop.
    const later = occurrencesBetween(start, hour, rule,
      new Date('2027-01-01T00:00:00Z'), new Date('2027-02-01T00:00:00Z'));
    assert.deepEqual(later, []);
  });

  it('honours UNTIL, INTERVAL and daily frequency', async () => {
    const { parseRecurrence, occurrencesBetween } = await import('../src/core/recurrence.js');
    const hour = 3_600_000;
    const start = new Date('2026-09-01T09:00:00Z');

    const until = parseRecurrence('FREQ=DAILY;UNTIL=20260905')!;
    const days = occurrencesBetween(start, hour, until,
      new Date('2026-09-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    assert.equal(days.length, 5, 'the 1st through the 5th inclusive');

    const fortnightly = parseRecurrence('FREQ=WEEKLY;INTERVAL=2;COUNT=3')!;
    const spaced = occurrencesBetween(start, hour, fortnightly,
      new Date('2026-09-01T00:00:00Z'), new Date('2026-12-01T00:00:00Z'));
    assert.equal(spaced.length, 3);
    assert.equal(
      (spaced[1]!.getTime() - spaced[0]!.getTime()) / 86_400_000, 14,
      'two weeks apart',
    );
  });

  it('keeps a monthly series on the last day of a short month', async () => {
    const { parseRecurrence, occurrencesBetween } = await import('../src/core/recurrence.js');
    // The 31st of January: February has no 31st, and skipping it would drop occurrences
    // silently rather than landing on the last day, which is what people expect.
    const rule = parseRecurrence('FREQ=MONTHLY;COUNT=3')!;
    const months = occurrencesBetween(new Date('2026-01-31T09:00:00Z'), 3_600_000, rule,
      new Date('2026-01-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    assert.equal(months.length, 3);
    assert.equal(months[1]!.getUTCMonth(), 1, 'the second occurrence is in February');
    assert.equal(months[1]!.getUTCDate(), 28, 'and lands on the 28th, not in March');
  });

  it('refuses a rule the validator would not have stored', async () => {
    const { parseRecurrence } = await import('../src/core/recurrence.js');
    assert.equal(parseRecurrence('FREQ=FORTNIGHTLY'), null);
    assert.equal(parseRecurrence(null), null);
  });
});

/**
 * PDF output.
 *
 * A malformed PDF is not obviously wrong from the code — it looks like a Buffer of the
 * right size until a client opens it and sees nothing. These assert the structure a
 * reader actually needs.
 */
describe('pdf', () => {
  it('produces a structurally valid document', async () => {
    const { PdfDocument } = await import('../src/core/pdf.js');
    const doc = new PdfDocument();
    doc.text(48, 60, 'INVOICE', { size: 22, font: 'bold' });
    doc.textRight(547, 60, '1,234.56');
    doc.line(48, 80, 547);
    const bytes = doc.toBuffer();
    const text = bytes.toString('latin1');

    assert.ok(text.startsWith('%PDF-1.4'), 'has a PDF header');
    assert.ok(text.includes('/Type /Catalog'), 'has a catalog');
    assert.ok(text.includes('xref'), 'has a cross-reference table');
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'is terminated');

    // The xref offsets must actually point at their objects, or readers reject the file.
    const start = Number(text.slice(text.lastIndexOf('startxref') + 9).trim().split('\n')[0]);
    assert.ok(text.slice(start).startsWith('xref'), 'startxref points at the table');
  });

  it('escapes characters that would break the content stream', async () => {
    const { PdfDocument } = await import('../src/core/pdf.js');
    const doc = new PdfDocument();
    // Unescaped, these would terminate the string early and corrupt every later object.
    doc.text(0, 0, 'Acme (Pvt) Ltd \\ "quoted"');
    const text = doc.toBuffer().toString('latin1');
    assert.ok(text.includes('Acme \\(Pvt\\) Ltd'), 'parentheses escaped');
  });

  it('measures text so right-aligned figures line up', async () => {
    const { textWidth } = await import('../src/core/pdf.js');
    // Every digit in Helvetica is the same width; a money column depends on it.
    assert.equal(textWidth('1111', 10), textWidth('9999', 10));
    assert.ok(textWidth('W', 10, 'bold') > textWidth('i', 10, 'bold'));
    assert.ok(textWidth('Total', 10, 'bold') > textWidth('Total', 10, 'regular'));
  });
});

/**
 * PNG decoding, for signatures on a PDF.
 *
 * PDF cannot carry a PNG as-is, so the bytes are inflated, un-filtered and handed over
 * as raw samples. Every stage of that is silently wrong-looking rather than throwing:
 * a mis-applied filter produces a plausible buffer of the right length containing noise.
 */
describe('png decoding', () => {
  const build = async (colourType: number, bytesPerPixel: number) => {
    const zlib = await import('node:zlib');
    const width = 4;
    const height = 3;
    const raw: number[] = [];
    for (let y = 0; y < height; y += 1) {
      raw.push(0); // filter: none
      for (let x = 0; x < width; x += 1) {
        for (let c = 0; c < bytesPerPixel; c += 1) raw.push((x * 40 + y * 10 + c * 5) & 0xff);
      }
    }
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    const crc = (buf: Buffer) => {
      let c = 0xffffffff;
      for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (tag: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(tag, 'latin1'), data]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const checksum = Buffer.alloc(4);
      checksum.writeUInt32BE(crc(body));
      return Buffer.concat([length, body, checksum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = colourType;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  };

  it('reads an RGBA image and keeps its alpha', async () => {
    const { decodePng } = await import('../src/core/png.js');
    const decoded = decodePng(await build(6, 4));
    assert.ok(decoded, 'decoded');
    assert.equal(decoded!.width, 4);
    assert.equal(decoded!.height, 3);
    assert.equal(decoded!.rgb.length, 4 * 3 * 3, 'three bytes per pixel');
    assert.ok(decoded!.alpha, 'alpha retained — a signature is transparent around the ink');
  });

  it('reports an opaque image as having no mask', async () => {
    const { decodePng } = await import('../src/core/png.js');
    const decoded = decodePng(await build(2, 3));
    assert.ok(decoded);
    assert.equal(decoded!.alpha, null, 'no soft mask needed when nothing is transparent');
  });

  it('refuses anything that is not a PNG rather than emitting noise', async () => {
    const { decodePng } = await import('../src/core/png.js');
    assert.equal(decodePng(Buffer.from('not an image at all')), null);
    assert.equal(decodePng(Buffer.alloc(4)), null);
  });
});
