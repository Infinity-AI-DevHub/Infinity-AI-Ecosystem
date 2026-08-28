/**
 * One-shot handoff for a message that must survive a redirect.
 *
 * Router state cannot carry it: signing out navigates to /sign-in, then the route guard
 * sees no session and redirects to /sign-in again with its own state, discarding
 * whatever the first navigation attached.
 *
 * Nor can the read clear it. That redirect remounts the sign-in screen, and StrictMode
 * mounts it twice again in development, so a read-and-clear is consumed before anything
 * paints. The note is held in module scope until the reader is finished with it - which
 * is when the person signs in - and never survives a page load, so it cannot be replayed
 * into a later session.
 */
let pending: string | null = null;

export function setNotice(message: string): void {
  pending = message;
}

export function readNotice(): string | null {
  return pending;
}

export function clearNotice(): void {
  pending = null;
}
