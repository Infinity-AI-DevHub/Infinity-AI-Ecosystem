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

function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
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
      const url = safeUrl(value);
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
      const url = safeUrl(value);
      if (!url) continue;
      pieces.push(` href="${escapeAttr(url)}" rel="noopener noreferrer nofollow" target="_blank"`);
      continue;
    }
    pieces.push(` ${name}="${escapeAttr(value)}"`);
  }
  return pieces.join('');
}

export function sanitizeEmailHtml(html: string, blockRemoteImages = true): string {
  if (!html) return '';
  const working = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(REMOVE_WITH_CONTENT, '')
    .replace(REMOVE_SELF_CLOSING, '');

  const out: string[] = [];
  const openStack: string[] = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\/?>|([^<]+)/g;

  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(working)) !== null) {
    const full = match[0];
    const text = match[3];
    if (text !== undefined) {
      out.push(text.replaceAll('<', '&lt;'));
      continue;
    }
    const name = (match[1] ?? '').toLowerCase();
    if (!ALLOWED_TAGS.has(name)) continue;

    if (full.startsWith('</')) {
      const idx = openStack.lastIndexOf(name);
      if (idx === -1) continue;
      openStack.splice(idx, 1);
      out.push(`</${name}>`);
      continue;
    }

    const attrs = sanitizeAttributes(name, match[2] ?? '', blockRemoteImages);
    out.push(`<${name}${attrs}>`);
    if (!VOID_TAGS.has(name)) openStack.push(name);
  }
  // Close anything the source left open so the fragment cannot escape its container.
  while (openStack.length > 0) out.push(`</${openStack.pop()}>`);
  return out.join('');
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
