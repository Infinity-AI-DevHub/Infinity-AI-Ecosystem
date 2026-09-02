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
  const surface = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = (n: number) => Math.min(1, Math.max(0, n));

  const moveTo = useCallback(
    (clientX: number, clientY: number) => {
      const box = surface.current?.getBoundingClientRect();
      if (!box) return;
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

  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent) => moveTo(event.clientX, event.clientY);
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
      <div className="placer-surface" ref={surface}>
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
