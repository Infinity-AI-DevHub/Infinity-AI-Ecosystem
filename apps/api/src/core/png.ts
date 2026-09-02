/**
 * Enough PNG decoding to put a signature into a PDF.
 *
 * PDF cannot carry a PNG as-is. A JPEG can be handed over untouched because PDF speaks
 * DCTDecode, but PNG applies per-scanline filters before compressing, so the bytes have
 * to be inflated, un-filtered, and handed back as raw samples for PDF to re-compress.
 *
 * Signatures are the reason this exists, and they are almost always 8-bit RGBA with a
 * transparent background — which is the case handled most carefully, since the alpha
 * becomes a separate soft mask in the PDF.
 */
import { inflateSync } from 'node:zlib';

export type DecodedImage = {
  width: number;
  height: number;
  /** Three bytes per pixel. */
  rgb: Buffer;
  /** One byte per pixel, or null when the image is fully opaque. */
  alpha: Buffer | null;
};

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Paeth, from the PNG specification. Reproduced rather than approximated. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buffer: Buffer): DecodedImage | null {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null;

  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let palette: Buffer | null = null;
  let paletteAlpha: Buffer | null = null;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      colourType = data[9]!;
      // Interlaced images need a seven-pass reconstruction. Refusing is better than
      // rendering a scrambled signature onto a document.
      if (data[12] !== 0) return null;
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') paletteAlpha = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    offset += 12 + length;
  }

  if (!width || !height || depth !== 8) return null;
  const channels = CHANNELS[colourType];
  if (!channels) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const bpp = channels;
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);

  // Un-filter. Each scanline is prefixed with the filter used to encode it, and each is
  // decoded against the line above, so this has to run in order.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? out[x - bpp]! : 0;
      const up = prior ? prior[x]! : 0;
      const upLeft = prior && x >= bpp ? prior[x - bpp]! : 0;
      const value = line[x]!;
      out[x] =
        filter === 0 ? value
        : filter === 1 ? (value + left) & 0xff
        : filter === 2 ? (value + up) & 0xff
        : filter === 3 ? (value + ((left + up) >> 1)) & 0xff
        : filter === 4 ? (value + paeth(left, up, upLeft)) & 0xff
        : value;
    }
  }

  const rgb = Buffer.alloc(width * height * 3);
  const alpha = Buffer.alloc(width * height);
  let opaque = true;

  for (let i = 0; i < width * height; i += 1) {
    const source = i * bpp;
    let r: number; let g: number; let b: number; let a = 255;
    if (colourType === 0) { r = g = b = pixels[source]!; }
    else if (colourType === 4) { r = g = b = pixels[source]!; a = pixels[source + 1]!; }
    else if (colourType === 2) { r = pixels[source]!; g = pixels[source + 1]!; b = pixels[source + 2]!; }
    else if (colourType === 6) {
      r = pixels[source]!; g = pixels[source + 1]!; b = pixels[source + 2]!; a = pixels[source + 3]!;
    } else {
      // Indexed colour: the sample is a palette entry.
      const index = pixels[source]!;
      if (!palette) return null;
      r = palette[index * 3]!; g = palette[index * 3 + 1]!; b = palette[index * 3 + 2]!;
      a = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index]! : 255;
    }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    alpha[i] = a;
    if (a !== 255) opaque = false;
  }

  return { width, height, rgb, alpha: opaque ? null : alpha };
}
