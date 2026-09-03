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
  /** Pre-filled, for renaming something that already has a name. */
  initialValue?: string;
  /** A name or a reference rather than a sentence: one line, no line breaks. */
  singleLine?: boolean;
};

export function useTextPrompt() {
  const [request, setRequest] = useState<Request | null>(null);
  const [value, setValue] = useState('');
  const resolver = useRef<((answer: string | null) => void) | null>(null);

  const ask = useCallback((input: Request): Promise<string | null> => {
    setValue(input.initialValue ?? '');
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
          {request.singleLine ? (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(event) => setValue(event.target.value)}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => { if (event.key === 'Escape') settle(null); }}
            />
          ) : (
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
          )}
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


type Confirmation = {
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
};

/**
 * Yes or no, in the application's own styling.
 *
 * `window.confirm` blocks the renderer, cannot be styled, and in Electron produces a
 * system dialog that looks nothing like the app around it. This is the same shape as
 * useTextPrompt so the two read alike at the call site.
 */
export function useConfirm() {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const resolver = useRef<((answer: boolean) => void) | null>(null);

  const confirm = useCallback((input: Confirmation): Promise<boolean> => {
    setRequest(input);
    return new Promise((resolve) => { resolver.current = resolve; });
  }, []);

  const settle = useCallback((answer: boolean) => {
    setRequest(null);
    resolver.current?.(answer);
    resolver.current = null;
  }, []);

  const element = request ? (
    <div className="dialog-scrim" role="presentation" onClick={() => settle(false)}>
      <div
        className="dialog dialog-compact"
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{request.title}</h3>
        {request.description ? <p className="field-hint">{request.description}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={() => settle(false)}>Cancel</button>
          <button
            type="button"
            autoFocus
            className={request.destructive ? 'danger-button' : 'primary-button'}
            onClick={() => settle(true)}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { confirm, element };
}
