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
const GUEST_ROUTES: RegExp[] = [
  // Their own identity and session. Capabilities belong here too: the client
  // application asks for them immediately after sign-in, so refusing them meant a guest
  // could authenticate successfully and then be bounced straight back to the sign-in
  // screen - the portal was unreachable rather than merely empty.
  /^\/api\/v1\/me$/,
  /^\/api\/v1\/me\/capabilities$/,
  /*
   * Session management, not data.
   *
   * `login` and `token/refresh` belong here for the same reason as logout: the guard
   * exists to stop a guest reading company-wide listings, and refusing authentication
   * does not protect anything. Leaving login out meant a guest holding a still-valid
   * cookie was refused when they tried to sign in again, with a message about guest
   * accounts that told them nothing they could act on.
   */
  /^\/api\/v1\/auth\/(login|logout|password)$/,
  /^\/api\/v1\/auth\/token\/refresh$/,
  /^\/api\/v1\/auth\/sessions(\/[\w-]+)?$/,

  // Files and folders they have been granted. Listing is already grant-scoped, and
  // every individual read authorizes against the specific record.
  /^\/api\/v1\/files(\/.*)?$/,

  // Conversation inside rooms they were added to; membership is enforced per room.
  /^\/api\/v1\/chat\/rooms\/[\w-]+\/messages(\/.*)?$/,
  /^\/api\/v1\/chat\/rooms\/[\w-]+\/members$/,

  // Meetings they were invited to, so a client can actually join a call.
  /^\/api\/v1\/calendar\/events(\/[\w-]+)?$/,
  /^\/api\/v1\/calendar\/events\/[\w-]+\/(join|rsvp)$/,

  // Tasks and documents shared with them. Both listings are grant-scoped and every
  // individual read authorizes against the specific record, so a guest sees only what
  // was deliberately given to them.
  /^\/api\/v1\/tasks(\/[\w-]+)?$/,
  /^\/api\/v1\/docs\/pages\/[\w-]+$/,
  /^\/api\/v1\/docs\/pages\/[\w-]+\/attachments$/,

  // Their own notifications.
  /^\/api\/v1\/notifications(\/.*)?$/,

  // The client portal: their organisation's invoices and quotations. Every one of these
  // scopes by the caller's own membership - see domains/portal.ts.
  /^\/api\/v1\/portal\/(overview|invoices|quotations|payments|next-payment|notices|pages|uploads)$/,
  /^\/api\/v1\/portal\/(invoices|quotations)\/[\w-]+$/,

  // Uploading their own documents. The file itself goes through /files, already open
  // above; this only records what it was for.
  /^\/api\/v1\/files\/uploads(\/.*)?$/,
];

/**
 * Deliberately excluded, and worth naming because their absence is the point: the people
 * directory, search, announcements, approvals, tasks and projects, the audit trail, admin
 * of any kind, and the client list itself - a guest must not learn which other companies
 * are clients here.
 */
export function guestMayReach(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return GUEST_ROUTES.some((pattern) => pattern.test(path));
}
