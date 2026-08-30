/**
 * The banner stack.
 *
 * Rendered in a live region so the same message reaches a screen reader as reaches the
 * screen. Critical alerts are assertive - they interrupt - and everything else is
 * polite, which is the difference between "the invoice is overdue" and "saved".
 */
import { useNotify, type Severity } from '../lib/notify';

const ICON: Record<Severity, string> = {
  info: 'i',
  success: '✓',
  warning: '!',
  critical: '!',
};

export function Toasts() {
  const { toasts, dismiss } = useNotify();
  if (toasts.length === 0) return null;

  return (
    <>
      <div className="toast-stack" role="region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast toast-${toast.severity}`}
            role={toast.severity === 'critical' ? 'alert' : 'status'}
            aria-live={toast.severity === 'critical' ? 'assertive' : 'polite'}
          >
            <span className="toast-icon" aria-hidden="true">{ICON[toast.severity]}</span>
            <div className="toast-text">
              <strong>{toast.title}</strong>
              {toast.body ? <span>{toast.body}</span> : null}
              {toast.link ? (
                <a href={`#${toast.link}`} onClick={() => dismiss(toast.id)}>Open</a>
              ) : null}
            </div>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(toast.id)}
              aria-label={`Dismiss: ${toast.title}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
