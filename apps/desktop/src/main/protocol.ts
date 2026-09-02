import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { join, normalize, sep } from 'node:path';
import { apiUrl, currentStorageOrigin } from './config';

/**
 * Serving the renderer over a custom `app://` scheme rather than `file://`.
 *
 * `file://` is a poor origin: it defeats a meaningful content security policy, makes
 * every local file same-origin with the application, and breaks the fetch and storage
 * APIs the renderer expects. A registered scheme gets a real, stable origin, so the CSP
 * below actually binds and the renderer behaves the way the browser build did.
 */
export const APP_SCHEME = 'app';

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * The policy the renderer runs under.
 *
 * `connect-src` names the API explicitly, so a script that does get injected cannot post
 * what it finds to an arbitrary host. There is no `unsafe-eval` and no remote script
 * origin: everything executable ships inside the bundle.
 */
function contentSecurityPolicy(): string {
  const api = new URL(apiUrl).origin;
  const socket = api.replace(/^http/, 'ws');
  // Uploads and downloads go directly to object storage, so its origin has to be in
  // connect-src or the fetch is refused before it leaves the renderer - which surfaces
  // as a network failure and reads exactly like a dropped connection.
  const storage = currentStorageOrigin();
  return [
    "default-src 'none'",
    `script-src 'self' ${APP_SCHEME}:`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: ${api}${storage ? ` ${storage}` : ''}`,
    `font-src 'self' data:`,
    `connect-src 'self' ${api} ${socket}${storage ? ` ${storage}` : ''}`,
    `media-src 'self' blob: ${api}${storage ? ` ${storage}` : ''}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Serves the built renderer.
 *
 * Every request is resolved against the bundle directory and then checked to be inside
 * it. Without that check a request for `../../../../etc/passwd` would be honoured, and
 * the renderer would have an arbitrary file read primitive over a scheme it fully
 * controls - which is precisely the bug custom protocol handlers are known for.
 */
export function serveRenderer(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const requested = decodeURIComponent(url.pathname);
    const candidate = normalize(join(rendererRoot, requested));

    if (!candidate.startsWith(rendererRoot + sep) && candidate !== rendererRoot) {
      return new Response('Forbidden', { status: 403 });
    }

    // Deep links are client-side routes: anything without a file extension falls back to
    // the shell, exactly as the SPA history fallback did on the web.
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(requested);
    const target = hasExtension ? candidate : join(rendererRoot, 'index.html');

    const response = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(response.headers);
    headers.set('content-security-policy', contentSecurityPolicy());
    headers.set('x-content-type-options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  });
}
