/**
 * Placing a signature on a document.
 *
 * Drag it where it belongs, resize it, then commit. Position is stored as fractions of
 * the page rather than pixels, so the same signature lands correctly whether the
 * document is rendered on screen, scaled in a preview, or printed to A4.
 *
 * Nothing is written until the person presses Sign. Moving the image around is not the
 * act of signing — the act is the deliberate confirmation, and the record that goes with
 * it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type Placement = { page: number; posX: number; posY: number; width: number };

export function SignaturePlacer({
  imageUrl,
  children,
  value,
  onChange,
  label,
}: {
  imageUrl: string;
  /** The document to place onto. */
  children: React.ReactNode;
  value: Placement;
  onChange: (next: Placement) => void;
  label: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = (n: number) => Math.min(1, Math.max(0, n));

  const moveTo = useCallback(
    (clientX: number, clientY: number) => {
      const el = surface.current;
      if (!el) return;
      /*
       * Measured against the document element, which is the same box the signature is
       * positioned inside. That matters: `top: 40%` on an absolutely positioned child
       * resolves against its containing block's height, so the fraction stored here and
       * the fraction CSS draws have to be taken from the same element.
       *
       * They were not. The fraction was computed against the scroll height of the
       * scrolling frame while CSS applied it to that frame's much shorter visible box,
       * which put a hard ceiling on how far down the page the signature could go -
       * stopping it short of the signature lines it exists to land on.
       *
       * This element does not scroll, so getBoundingClientRect already accounts for the
       * scroll position and no offset needs adding.
       */
      const box = el.getBoundingClientRect();
      onChange({
        ...value,
        // The pointer holds the centre of the signature, which is where people expect
        // the thing they are dragging to sit.
        posX: clamp((clientX - box.left) / box.width - value.width / 2),
        posY: clamp((clientY - box.top) / box.height - 0.02),
      });
    },
    [onChange, value],
  );

  // Open with the signature in view. It defaults to the signature line near the foot of
  // the document, which on a full page is well below the fold.
  useEffect(() => {
    const frame = scroller.current;
    const content = surface.current;
    if (!frame || !content) return;
    const target = value.posY * content.offsetHeight - frame.clientHeight / 2;
    frame.scrollTop = Math.max(0, target);
    // Deliberately on mount only: re-running on every move would fight the drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dragging) return;
    /*
     * Drag near the top or bottom edge and the frame follows. The document is taller
     * than its frame, so without this a drag simply stops at the edge and the signature
     * lines further down stay out of reach while the pointer is held.
     */
    const onMove = (event: PointerEvent) => {
      const frame = scroller.current;
      if (frame) {
        const box = frame.getBoundingClientRect();
        const EDGE = 40;
        if (event.clientY > box.bottom - EDGE) frame.scrollTop += 12;
        else if (event.clientY < box.top + EDGE) frame.scrollTop -= 12;
      }
      moveTo(event.clientX, event.clientY);
    };
    const onUp = () => setDragging(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, moveTo]);

  /** Keyboard nudging, so placing a signature does not require a pointer. */
  function onKeyDown(event: React.KeyboardEvent) {
    const step = event.shiftKey ? 0.05 : 0.01;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const delta = map[event.key];
    if (!delta) return;
    event.preventDefault();
    onChange({ ...value, posX: clamp(value.posX + delta[0]), posY: clamp(value.posY + delta[1]) });
  }

  return (
    <div className="placer">
      {/* The frame scrolls; the surface inside it is the document at its natural height
          and is what the signature is positioned against. Clicking the document places
          the signature there, because dragging to a line further down the page means
          dragging across a scrolling container. */}
      <div className="placer-scroll" ref={scroller}>
      <div
        className="placer-surface"
        ref={surface}
        onPointerDown={(event) => {
          if (event.target !== surface.current) return;
          moveTo(event.clientX, event.clientY);
        }}
      >
        {children}

        <img
          src={imageUrl}
          alt={label}
          className={`placer-signature ${dragging ? 'placer-dragging' : ''}`}
          style={{
            left: `${value.posX * 100}%`,
            top: `${value.posY * 100}%`,
            width: `${value.width * 100}%`,
          }}
          role="button"
          tabIndex={0}
          aria-label={`${label}. Drag, or use the arrow keys to move.`}
          onPointerDown={(event) => {
            event.preventDefault();
            setDragging(true);
            moveTo(event.clientX, event.clientY);
          }}
          onKeyDown={onKeyDown}
          draggable={false}
        />
      </div>
      </div>

      <div className="placer-controls">
        <label className="field">
          <span>Size</span>
          <input
            type="range"
            min={8}
            max={40}
            value={Math.round(value.width * 100)}
            onChange={(event) => onChange({ ...value, width: Number(event.target.value) / 100 })}
          />
        </label>
        <p className="field-hint">
          Drag the signature onto the document, or select it and use the arrow keys.
          Nothing is recorded until you press Sign.
        </p>
      </div>
    </div>
  );
}
