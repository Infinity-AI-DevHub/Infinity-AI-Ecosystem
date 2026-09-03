/**
 * Shared state components (blueprint 16: "loading, empty, offline, error, forbidden,
 * suspended and degraded-provider states are designed for every module").
 *
 * Centralising them means no module ships a blank screen or a raw error string, and
 * every state is announced to assistive technology.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, Inbox, LockKeyhole, RefreshCw, WifiOff } from 'lucide-react';
import { ApiError, NetworkError } from '../lib/api';

/** Skeleton rows keep layout stable so content does not jump when it arrives. */
export function Loading({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="state-block" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      <div className="skeleton-stack" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div className="skeleton-row" key={index} />
        ))}
      </div>
    </div>
  );
}

export function Empty({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="state-block state-empty">
      <span className="state-icon" aria-hidden="true">{icon ?? <Inbox size={22} />}</span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function Forbidden({ message }: { message?: string }) {
  return (
    <div className="state-block state-forbidden" role="alert">
      <span className="state-icon" aria-hidden="true"><LockKeyhole size={22} /></span>
      <h3>You do not have access to this</h3>
      <p>{message ?? 'Ask an administrator if you believe you should be able to see it.'}</p>
    </div>
  );
}

/**
 * Renders the right state for a failure, distinguishing "not permitted" from "broken"
 * from "offline" - each needs a different response from the reader.
 */
export function ErrorState({
  error,
  onRetry,
}: {
  error: ApiError | NetworkError;
  onRetry?: () => void;
}) {
  if (error instanceof ApiError && error.isForbidden) {
    return <Forbidden message={error.message} />;
  }

  const offline = error instanceof NetworkError;
  const rateLimited = error instanceof ApiError && error.isRateLimited;

  return (
    <div className="state-block state-error" role="alert">
      <span className="state-icon" aria-hidden="true">
        {offline ? <WifiOff size={22} /> : <AlertTriangle size={22} />}
      </span>
      <h3>
        {offline
          ? 'You appear to be offline'
          : rateLimited
            ? 'Too many requests'
            : 'This section could not be loaded'}
      </h3>
      <p>
        {offline
          ? 'Check your connection. Your work is not lost.'
          : rateLimited
            ? `Please wait ${error instanceof ApiError ? (error.retryAfterSeconds ?? 60) : 60} seconds and try again.`
            : error.message}
      </p>
      {error instanceof ApiError && error.correlationId ? (
        <p className="state-reference">
          Reference <code>{error.correlationId}</code> — quote this to your administrator.
        </p>
      ) : null}
      {onRetry ? (
        <button type="button" className="ghost-button" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" /> Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * A provider is unavailable but the module still works in reduced form - the blueprint
 * requires this to be visible rather than silently degraded.
 */
export function DegradedNotice({ reason, children }: { reason: string; children?: ReactNode }) {
  return (
    <div className="degraded-notice" role="status">
      <AlertTriangle size={15} aria-hidden="true" />
      <div>
        <strong>Working in reduced mode</strong>
        <p>{reason}</p>
        {children}
      </div>
    </div>
  );
}

/** Inline validation message tied to a field by aria-describedby. */
export function FieldMessage({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p className="field-error" id={id} role="alert">
      {message}
    </p>
  );
}

/** Async section wrapper: one place decides loading vs error vs empty vs content. */
export function AsyncSection<T>({
  query,
  empty,
  children,
}: {
  query: { data: T | undefined; loading: boolean; error: ApiError | NetworkError | null; reload: () => void };
  empty?: { title: string; description?: string; action?: ReactNode } | ((data: T) => boolean);
  children: (data: T) => ReactNode;
}) {
  if (query.loading) return <Loading />;
  if (query.error) return <ErrorState error={query.error} onRetry={query.reload} />;
  if (query.data === undefined) return <Loading />;

  if (empty && typeof empty !== 'function') {
    const value = query.data as unknown;
    const isEmpty = Array.isArray(value) ? value.length === 0 : false;
    if (isEmpty) return <Empty {...empty} />;
  }
  return <>{children(query.data)}</>;
}

/**
 * Summary of a failed write, above the form that caused it.
 *
 * Six modules each carried their own copy of this block, which is how they drifted: the
 * server often repeats the summary message as the sole field error, and every copy
 * printed it twice ("Current password is not correct" - twice, in a row). Field messages
 * that merely restate the summary are dropped here, once, for all of them.
 */
export function FormError({ error }: { error: ApiError | NetworkError | null }) {
  const box = useRef<HTMLDivElement>(null);

  /*
   * Bring the message into view when it appears.
   *
   * These sit at the top of their form, while the button that triggers them is often far
   * below in a dialog that scrolls - so a rejected submit rendered an explanation the
   * person never saw, and the form read as simply not responding. Announced to assistive
   * technology by role="alert" either way; this is for everyone else.
   */
  useEffect(() => {
    if (error) box.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  if (!error) return null;

  const fields =
    'fields' in error
      ? error.fields.filter((field) => field.message.trim() !== error.message.trim())
      : [];

  return (
    <div className="auth-error" role="alert" ref={box}>
      <p>{error.message}</p>
      {fields.length > 0 ? (
        <ul>
          {fields.map((field) => (
            <li key={`${field.field}-${field.message}`}>{field.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
