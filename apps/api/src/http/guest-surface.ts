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
  // Their own identity and session.
  /^\/api\/v1\/me$/,
  /^\/api\/v1\/auth\/(logout|password)$/,
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

  // Their own notifications.
  /^\/api\/v1\/notifications(\/.*)?$/,
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
