/**
 * HTML email sanitization (blueprint 09/12: "HTML email is sanitized; remote images are
 * blocked or proxied; dangerous attachments are quarantined").
 *
 * Allow-list based: anything not explicitly permitted is dropped, so a novel vector
 * fails closed. It runs server-side, so a client bug cannot bypass it.
 */
const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['alt', 'title', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
};

const VOID_TAGS = new Set(['br', 'hr', 'img']);

const REMOVE_WITH_CONTENT =
  /<(script|style|iframe|object|embed|link|meta|base|form|svg|math)\b[\s\S]*?<\/\1\s*>/gi;
const REMOVE_SELF_CLOSING =
  /<(script|style|iframe|object|embed|link|meta|base|form|svg|math)\b[^>]*\/?>/gi;

function safeLinkUrl(value: string): string | null {
  const trimmed = value.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function safeImageUrl(value: string): string | null {
  const trimmed = value.trim();
  return /^https:/i.test(trimmed) ? trimmed : null;
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function sanitizeAttributes(tag: string, raw: string, blockRemoteImages: boolean): string {
  const allowed = ALLOWED_ATTRS[tag];
  const pieces: string[] = [];
  const attrPattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = attrPattern.exec(raw)) !== null) {
    const name = (m[1] ?? '').toLowerCase();
    const value = m[3] ?? m[4] ?? m[5] ?? '';
    // Event handlers, inline style and srcset are never allowed anywhere.
    if (name.startsWith('on') || name === 'style' || name === 'srcset') continue;

    if (tag === 'img' && name === 'src') {
      const url = safeImageUrl(value);
      if (!url) continue;
      // Remote images leak read receipts, so the client asks before loading them.
      pieces.push(
        blockRemoteImages
          ? ` data-blocked-src="${escapeAttr(url)}"`
          : ` src="${escapeAttr(url)}"`,
      );
      continue;
    }
    if (!allowed?.has(name)) continue;
    if (name === 'href') {
      const url = safeLinkUrl(value);
      if (!url) continue;
      pieces.push(` href="${escapeAttr(url)}" rel="noopener noreferrer nofollow" target="_blank"`);
      continue;
    }
    pieces.push(` ${name}="${escapeAttr(value)}"`);
  }
  return pieces.join('');
}

/**
 * Finds the index just past the `>` that closes the tag starting at `start`.
 *
 * Quote-aware on purpose: a `<` or `>` inside a quoted attribute value must not end the
 * tag. A regex that stops at the first `>` desynchronizes from the browser's parser,
 * which is the classic mutation-XSS sanitizer bypass - markup smuggled inside an
 * attribute would otherwise spill out and be re-parsed as live tags.
 *
 * Returns -1 when the tag is never closed.
 */
function findTagEnd(input: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let i = start + 1; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i + 1;
  }
  return -1;
}

const TAG_START = /^<\/?[a-zA-Z]/;
const TAG_PARTS = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)\/?>$/;

export function sanitizeEmailHtml(html: string, blockRemoteImages = true): string {
  if (!html) return '';
  const working = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(REMOVE_WITH_CONTENT, '')
    .replace(REMOVE_SELF_CLOSING, '');

  const out: string[] = [];
  const openStack: string[] = [];
  let i = 0;

  while (i < working.length) {
    const next = working.indexOf('<', i);

    // Plain text up to the next candidate tag.
    if (next === -1) {
      out.push(escapeText(working.slice(i)));
      break;
    }
    if (next > i) out.push(escapeText(working.slice(i, next)));

    // A `<` that does not begin a tag is literal text and must be escaped, never dropped.
    // Three characters are needed so a closing tag (`</p`) is still recognised.
    if (!TAG_START.test(working.slice(next, next + 3))) {
      out.push('&lt;');
      i = next + 1;
      continue;
    }

    const end = findTagEnd(working, next);
    if (end === -1) {
      // Unterminated tag: treat the rest as text rather than trusting a partial tag.
      out.push(escapeText(working.slice(next)));
      break;
    }

    const rawTag = working.slice(next, end);
    i = end;

    const parts = TAG_PARTS.exec(rawTag);
    if (!parts) continue;

    const closing = parts[1] === '/';
    const name = (parts[2] ?? '').toLowerCase();
    // A disallowed tag is dropped along with its markup; its text content still flows
    // through the loop as ordinary escaped text.
    if (!ALLOWED_TAGS.has(name)) continue;

    if (closing) {
      const idx = openStack.lastIndexOf(name);
      if (idx === -1) continue;
      openStack.splice(idx, 1);
      out.push(`</${name}>`);
      continue;
    }

    out.push(`<${name}${sanitizeAttributes(name, parts[3] ?? '', blockRemoteImages)}>`);
    if (!VOID_TAGS.has(name)) openStack.push(name);
  }

  // Close anything the source left open so the fragment cannot escape its container.
  while (openStack.length > 0) out.push(`</${openStack.pop()}>`);
  return out.join('');
}

/** Text nodes keep their characters but can never introduce markup. */
function escapeText(value: string): string {
  return value.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Plain-text projection used for snippets and search indexing. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function snippet(text: string, length = 180): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > length ? `${collapsed.slice(0, length - 1)}…` : collapsed;
}
