/**
 * What each realtime event makes stale.
 *
 * Without this the application only refreshed chat, tasks and the notification list;
 * everything else needed a manual reload, which is why approvals and invoices appeared
 * to be stuck until someone reopened the page.
 *
 * These refreshes are deliberately silent. A banner is for something that needs a
 * person's attention - a row quietly becoming correct is not that, and a toast for every
 * frame trains people to dismiss the ones that matter.
 *
 * Prefixes, not exact keys: `invalidate` matches on the start of a cache key, so
 * '/invoices' also clears '/invoices?bucket=overdue' and '/invoices/{id}'.
 */
export const INVALIDATION_MAP: { match: (type: string) => boolean; keys: string[] }[] = [
  { match: (t) => t.startsWith('chat.'), keys: ['/chat'] },
  { match: (t) => t.startsWith('task.'), keys: ['/tasks'] },
  {
    match: (t) => t.startsWith('approval.'),
    // An approval decision changes the queue, the badge counts and often a claim.
    keys: ['/approvals', '/me/activity', '/finance/claims'],
  },
  { match: (t) => t.startsWith('event.'), keys: ['/calendar', '/meetings'] },
  { match: (t) => t.startsWith('file.'), keys: ['/files', '/folders'] },
  { match: (t) => t.startsWith('invoice.'), keys: ['/invoices', '/me/activity'] },
  { match: (t) => t === 'announcement.published', keys: ['/announcements', '/me/activity'] },
  { match: (t) => t.startsWith('share.'), keys: ['/files', '/docs', '/external'] },
  {
    // A change to a person affects the directory, the org chart and anywhere they are
    // named as an owner or approver.
    match: (t) => t.startsWith('user.'),
    keys: ['/users', '/people', '/admin'],
  },
  { match: (t) => t === 'notification.created', keys: ['/me/notifications', '/me/activity'] },
];

/** Every cache prefix a frame of this type should clear. */
export function keysForEvent(type: string): string[] {
  const keys = new Set<string>();
  for (const rule of INVALIDATION_MAP) {
    if (rule.match(type)) for (const key of rule.keys) keys.add(key);
  }
  return [...keys];
}
