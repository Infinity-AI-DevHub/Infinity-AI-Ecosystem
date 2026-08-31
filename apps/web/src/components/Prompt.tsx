/**
 * Asking for one line of text.
 *
 * Exists because `window.prompt` is not implemented in Electron: it returns undefined
 * without showing anything, so every action guarded by one silently did nothing in the
 * desktop client while working in a browser. That is the worst shape of bug - the
 * button appears to work and the reason it needed is quietly discarded.
 *
 * The dialog also carries what a native prompt cannot: a required minimum length, a
 * described purpose, and a label that says what the text is for.
 */
import { useCallback, useRef, useState } from 'react';

type Request = {
  title: string;
  label: string;
  description?: string;
  placeholder?: string;
  minLength?: number;
  confirmLabel?: string;
  destructive?: boolean;
};

export function useTextPrompt() {
  const [request, setRequest] = useState<Request | null>(null);
  const [value, setValue] = useState('');
  const resolver = useRef<((answer: string | null) => void) | null>(null);

  const ask = useCallback((input: Request): Promise<string | null> => {
    setValue('');
    setRequest(input);
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((answer: string | null) => {
    setRequest(null);
    resolver.current?.(answer);
    resolver.current = null;
  }, []);

  const minLength = request?.minLength ?? 1;
  const tooShort = value.trim().length < minLength;

  const element = request ? (
    <div className="dialog-scrim" role="presentation" onClick={() => settle(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!tooShort) settle(value.trim());
        }}
      >
        <h3>{request.title}</h3>
        {request.description ? <p className="field-hint">{request.description}</p> : null}
        <label className="field">
          <span>{request.label}</span>
          <textarea
            rows={3}
            autoFocus
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            // Enter submits, Shift+Enter breaks the line: this is a short reason, not
            // a document, and reaching for the mouse to confirm one sentence is friction.
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !tooShort) {
                event.preventDefault();
                settle(value.trim());
              }
              if (event.key === 'Escape') settle(null);
            }}
          />
          {tooShort && value.length > 0 ? (
            <span className="field-hint">At least {minLength} characters.</span>
          ) : null}
        </label>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={() => settle(null)}>
            Cancel
          </button>
          <button
            type="submit"
            className={request.destructive ? 'danger-button' : 'primary-button'}
            disabled={tooShort}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  ) : null;

  return { ask, element };
}
