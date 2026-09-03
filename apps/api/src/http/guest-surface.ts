/**
 * The routes a guest is permitted to reach.
 *
 * The capability model already confines a guest to explicitly granted records, but it
 * relies on every endpoint asking it. Several company-wide listings legitimately do not:
 * announcements, the project list and the chat room list scope by company and
 * membership, which is exactly right for an employee and exactly wrong for an external
 * contact who happens to hold a row in the same company.
 *
 * Rather than patch those three and hope the next listing remembers, guests are denied
 * everything and allowed back a named surface. A route added later is closed to guests
 * until someone deliberately opens it, which is the failure direction worth having when
 * the people on the other side work for a client.
 *
 * This is a second gate, not a replacement: everything below still performs its own
 * capability and resource checks, and a guest reaches an individual record only through
 * a grant.
 */
const GUEST_GET_ROUTES: RegExp[] = [
  // Their own identity and session. Capabilities belong here too: the client
  // application asks for them immediately after sign-in, so refusing them meant a guest
  // could authenticate successfully and then be bounced straight back to the sign-in
  // screen - the portal was unreachable rather than merely empty.
  /^\/api\/v1\/me$/,
  /^\/api\/v1\/me\/capabilities$/,
  // Reading and revoking their own sessions is account management, not company data.
  /^\/api\/v1\/auth\/sessions(\/[\w-]+)?$/,

  // Files and folders they have been granted. Listing is already grant-scoped, and
  // every individual read authorizes against the specific record.
  /^\/api\/v1\/files$/,
  /^\/api\/v1\/files\/folders$/,
  /^\/api\/v1\/files\/[\w-]+\/(download|versions)$/,

  // Short-lived local-storage downloads are already bound to one object, action and
  // expiry by their HMAC signature. A browser navigation carries the guest cookie too,
  // so this path must remain reachable after the file-specific authorization above.
  /^\/api\/v1\/objects\/download$/,

  // Conversation inside rooms they were added to; membership is enforced per room.
  /^\/api\/v1\/chat\/rooms\/[\w-]+\/messages(\/.*)?$/,
  /^\/api\/v1\/chat\/rooms\/[\w-]+\/members$/,

  // Meetings they were invited to, so a client can actually join a call.
  /^\/api\/v1\/calendar\/events(\/[\w-]+)?$/,

  /*
   * Documents shared with them. The listing is grant-scoped and every individual read
   * authorizes against the specific record.
   *
   * The workspace's own /tasks endpoints are deliberately absent: a client reaches work
   * through /portal/projects, which scopes by the organisation that owns the project.
   * Leaving both open would have meant two routes to the same data with two different
   * rules deciding who may see it, and the narrower one is the one worth keeping.
   */
  /^\/api\/v1\/docs\/pages\/[\w-]+$/,
  /^\/api\/v1\/docs\/pages\/[\w-]+\/attachments$/,

  // Their own notifications.
  /^\/api\/v1\/notifications(\/.*)?$/,

  // The client portal: their organisation's invoices and quotations. Every one of these
  // scopes by the caller's own membership - see domains/portal.ts.
  /^\/api\/v1\/portal\/(overview|invoices|quotations|payments|next-payment|notices|pages|uploads|projects)$/,
  /^\/api\/v1\/portal\/(invoices|quotations|tasks)\/[\w-]+$/,
  /^\/api\/v1\/portal\/projects\/[\w-]+\/tasks$/,
  /^\/api\/v1\/portal\/documents\/(invoice|quotation|receipt)\/[\w-]+\/pdf$/,

];

const GUEST_POST_ROUTES: RegExp[] = [
  /*
   * Authentication remains reachable even while a guest cookie exists. This lets a
   * person sign in again or switch accounts; blocking login at the guest boundary traps
   * the browser in the old guest session rather than protecting company data.
   */
  /^\/api\/v1\/auth\/(login|activate|logout|password|token)$/,
  /^\/api\/v1\/auth\/password\/(forgot|reset)$/,
  /^\/api\/v1\/auth\/token\/refresh$/,
  /^\/api\/v1\/calendar\/events\/[\w-]+\/(join|rsvp)$/,
  /^\/api\/v1\/chat\/rooms\/[\w-]+\/messages$/,
  /^\/api\/v1\/notifications\/[\w-]+\/read$/,
  /^\/api\/v1\/files\/uploads(\/.*)?$/,
  /^\/api\/v1\/portal\/uploads$/,
];

const GUEST_DELETE_ROUTES: RegExp[] = [
  /^\/api\/v1\/auth\/sessions\/[\w-]+$/,
];

const GUEST_PUT_ROUTES: RegExp[] = [
  // Direct uploads use the matching signed object URL. The signature is verified again
  // by the object route before any bytes are stored.
  /^\/api\/v1\/objects\/upload$/,
];

/**
 * Deliberately excluded, and worth naming because their absence is the point: the people
 * directory, search, announcements, approvals and projects, the audit trail, admin
 * of any kind, and the client list itself - a guest must not learn which other companies
 * are clients here.
 */
export function guestMayReach(method: string, url: string): boolean {
  const path = url.split('?')[0] ?? '';
  const routes = method === 'GET' || method === 'HEAD'
    ? GUEST_GET_ROUTES
    : method === 'POST'
      ? GUEST_POST_ROUTES
      : method === 'DELETE'
        ? GUEST_DELETE_ROUTES
        : method === 'PUT'
          ? GUEST_PUT_ROUTES
          : [];
  return routes.some((pattern) => pattern.test(path));
}
