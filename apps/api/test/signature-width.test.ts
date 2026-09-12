/**
 * A signature prints at the size it was drawn at.
 *
 * The placer let people resize a signature and stored the result; the renderer used a
 * fixed 110pt and never read it, so the size chosen on screen had no effect on the
 * document anyone actually received.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signatureWidth } from '../src/domains/document-render.js';

/** A4 with the renderer's own margins, and one of three signature columns. */
const CONTENT = 595.28 - 40 * 2;
const COLUMN = CONTENT / 3 - 16;

describe('signature width', () => {
  it('uses the fraction the signer chose', () => {
    // 25% of the content width, which fits inside a third of the page.
    assert.equal(Math.round(signatureWidth(0.25, CONTENT, COLUMN)), Math.round(0.25 * CONTENT));
  });

  it('makes a bigger choice actually bigger', () => {
    const small = signatureWidth(0.10, CONTENT, COLUMN);
    const large = signatureWidth(0.25, CONTENT, COLUMN);
    assert.ok(large > small, 'resizing the signature did not change the printed width');
  });

  it('keeps a signature inside its own column', () => {
    // Half the page is wider than a third of it; it must not run over the neighbour.
    assert.ok(signatureWidth(0.5, CONTENT, COLUMN) <= COLUMN);
  });

  it('never prints an illegible smudge', () => {
    assert.ok(signatureWidth(0.001, CONTENT, COLUMN) >= 24);
  });

  it('falls back to the old fixed size for a signature recorded without one', () => {
    for (const missing of [null, 0, Number.NaN]) {
      assert.equal(signatureWidth(missing as number | null, CONTENT, COLUMN), 110);
    }
  });

  it('is what the renderer actually draws with', () => {
    // The helper being correct is no use if the drawing code goes back to a constant,
    // which is exactly what it did before.
    const source = readFileSync(join(process.cwd(), 'src/domains/document-render.ts'), 'utf8');
    // Wide enough to span the comment that explains the bound, so adding prose to the
    // renderer cannot fail this test.
    const draw = source.slice(source.indexOf('if (slot.image)'),
                              source.indexOf('if (slot.image)') + 800);
    assert.match(draw, /signatureWidth\(/, 'the renderer draws the signature at a fixed size');
  });

  it('reads the stored width, which the query has to select', () => {
    // The original bug was one missing column in one SELECT, so it is asserted directly.
    const source = readFileSync(join(process.cwd(), 'src/domains/document-render.ts'), 'utf8');
    const query = source.slice(source.indexOf('FROM document_signatures') - 900,
                               source.indexOf('FROM document_signatures'));
    assert.match(query, /\bs\.width\b/, 'the signature query does not select the stored width');
  });
});
