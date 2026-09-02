import { deflateSync } from 'node:zlib';

/**
 * A minimal PDF writer, enough for a business document.
 *
 * Written by hand rather than pulled in: the alternatives are a headless browser, which
 * is a hundred megabytes and a second runtime to keep patched on the server, or a
 * general-purpose PDF library for what amounts to text, rules and a logo on one page.
 * This produces the subset an invoice needs and nothing else.
 *
 * Only the base-14 fonts are used, so nothing has to be embedded and the file stays a
 * few kilobytes — which matters when it is an email attachment.
 */

/**
 * Helvetica character widths, in units of 1/1000 em.
 *
 * Needed for right-aligned figures. Without real metrics a currency column has to be
 * left-aligned or guessed at, and a guessed column is visibly crooked on the one
 * document a client actually reads.
 */
const REGULAR: Record<string, number> = {};
const BOLD: Record<string, number> = {};

(() => {
  const chars =
    ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`'
    + 'abcdefghijklmnopqrstuvwxyz{|}~';
  const regular = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  ];
  const bold = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  ];
  for (let i = 0; i < chars.length; i += 1) {
    REGULAR[chars[i]!] = regular[i] ?? 556;
    BOLD[chars[i]!] = bold[i] ?? 556;
  }
})();

export type Font = 'regular' | 'bold';

export function textWidth(text: string, size: number, font: Font = 'regular'): number {
  const table = font === 'bold' ? BOLD : REGULAR;
  let total = 0;
  for (const char of text) total += table[char] ?? 556;
  return (total / 1000) * size;
}

/** PDF strings are parenthesised, so those and the escape character must be escaped. */
function escape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Latin-1, because the base-14 fonts are single-byte encoded.
 *
 * Anything outside it — a rupee sign, a curly quote pasted from elsewhere — would render
 * as a wrong glyph rather than nothing, which is worse. Those are transliterated to
 * something readable instead.
 */
function toLatin1(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

export type Colour = [number, number, number];

export const A4 = { width: 595.28, height: 841.89 };

type EmbeddedImage = {
  name: string;
  width: number;
  height: number;
  rgb: Buffer;
  alpha: Buffer | null;
};

export class PdfDocument {
  private readonly ops: string[] = [];
  private readonly images: EmbeddedImage[] = [];

  /** y is measured from the top, which is how a page is described by people. */
  private y(top: number): number {
    return A4.height - top;
  }

  text(
    x: number,
    top: number,
    value: string,
    options: { size?: number; font?: Font; colour?: Colour } = {},
  ): this {
    const size = options.size ?? 10;
    const font = options.font === 'bold' ? '/F2' : '/F1';
    const [r, g, b] = options.colour ?? [0.1, 0.14, 0.19];
    this.ops.push(
      `q ${r} ${g} ${b} rg BT ${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${this.y(top).toFixed(2)} Tm `
        + `(${escape(toLatin1(value))}) Tj ET Q`,
    );
    return this;
  }

  /** Right-aligned to `right`, which is what a column of money needs. */
  textRight(
    right: number,
    top: number,
    value: string,
    options: { size?: number; font?: Font; colour?: Colour } = {},
  ): this {
    const width = textWidth(toLatin1(value), options.size ?? 10, options.font ?? 'regular');
    return this.text(right - width, top, value, options);
  }

  line(x1: number, top: number, x2: number, options: { width?: number; colour?: Colour } = {}): this {
    const [r, g, b] = options.colour ?? [0.85, 0.88, 0.91];
    this.ops.push(
      `q ${r} ${g} ${b} RG ${(options.width ?? 0.6).toFixed(2)} w `
        + `${x1.toFixed(2)} ${this.y(top).toFixed(2)} m ${x2.toFixed(2)} ${this.y(top).toFixed(2)} l S Q`,
    );
    return this;
  }

  rect(x: number, top: number, width: number, height: number, colour: Colour): this {
    const [r, g, b] = colour;
    this.ops.push(
      `q ${r} ${g} ${b} rg ${x.toFixed(2)} ${(this.y(top) - height).toFixed(2)} `
        + `${width.toFixed(2)} ${height.toFixed(2)} re f Q`,
    );
    return this;
  }

  /**
   * Places an image, scaled to a width, preserving its aspect ratio.
   *
   * Returns the height used so a caller can lay out beneath it. Transparency is carried
   * as a soft mask rather than composited onto white — a signature dropped onto a tinted
   * block would otherwise sit in a visible white rectangle.
   */
  image(
    x: number,
    top: number,
    decoded: { width: number; height: number; rgb: Buffer; alpha: Buffer | null },
    drawWidth: number,
  ): number {
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, ...decoded });
    const drawHeight = (decoded.height / decoded.width) * drawWidth;
    this.ops.push(
      `q ${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} `
        + `${x.toFixed(2)} ${(this.y(top) - drawHeight).toFixed(2)} cm /${name} Do Q`,
    );
    return drawHeight;
  }

  /** Wraps to a width and returns the vertical space used, so callers can lay out below. */
  paragraph(
    x: number,
    top: number,
    value: string,
    maxWidth: number,
    options: { size?: number; font?: Font; colour?: Colour; leading?: number } = {},
  ): number {
    const size = options.size ?? 9;
    const leading = options.leading ?? size * 1.45;
    const words = toLatin1(value).split(/\s+/).filter(Boolean);
    let line = '';
    let used = 0;
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, options.font) > maxWidth && line) {
        this.text(x, top + used, line, options);
        used += leading;
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) {
      this.text(x, top + used, line, options);
      used += leading;
    }
    return used;
  }

  toBuffer(): Buffer {
    const content = this.ops.join('\n');

    /*
     * Objects are assembled as byte buffers rather than strings.
     *
     * Image samples are binary and contain every byte value; holding them in a latin1
     * string and converting at the end round-trips cleanly in principle but is easy to
     * get wrong, and a single corrupted byte makes the whole file unreadable.
     */
    const objects: Buffer[] = [];
    const add = (body: string | Buffer) => {
      objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
      return objects.length; // the object number
    };

    const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
    add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');

    // Reserve 3 (page) and 4 (contents); fonts are 5 and 6, images follow.
    const pagePlaceholder = objects.push(Buffer.alloc(0));
    const contentsPlaceholder = objects.push(Buffer.alloc(0));
    const fontRegular = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    );
    const fontBold = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    );

    const xobjects: string[] = [];
    for (const image of this.images) {
      let maskRef = '';
      if (image.alpha) {
        const maskData = deflateSync(image.alpha);
        const maskNumber = add(Buffer.concat([
          Buffer.from(
            `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} `
              + `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode `
              + `/Length ${maskData.length} >>\nstream\n`,
            'latin1',
          ),
          maskData,
          Buffer.from('\nendstream', 'latin1'),
        ]));
        maskRef = ` /SMask ${maskNumber} 0 R`;
      }
      const data = deflateSync(image.rgb);
      const number = add(Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} `
            + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`
            + `${maskRef} /Length ${data.length} >>\nstream\n`,
          'latin1',
        ),
        data,
        Buffer.from('\nendstream', 'latin1'),
      ]));
      xobjects.push(`/${image.name} ${number} 0 R`);
    }

    const resources =
      `<< /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>`
      + (xobjects.length > 0 ? ` /XObject << ${xobjects.join(' ')} >>` : '')
      + ' >>';

    objects[pagePlaceholder - 1] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] `
        + `/Resources ${resources} /Contents ${contentsPlaceholder} 0 R >>`,
      'latin1',
    );
    objects[contentsPlaceholder - 1] = Buffer.from(
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
      'latin1',
    );

    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
    const offsets: number[] = [];
    let position = parts[0]!.length;
    objects.forEach((body, index) => {
      offsets.push(position);
      const chunk = Buffer.concat([
        Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
        body,
        Buffer.from('\nendobj\n', 'latin1'),
      ]);
      parts.push(chunk);
      position += chunk.length;
    });

    let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) tail += `${String(offset).padStart(10, '0')} 00000 n \n`;
    tail += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\n`
      + `startxref\n${position}\n%%EOF\n`;
    parts.push(Buffer.from(tail, 'latin1'));

    return Buffer.concat(parts);
  }
}
