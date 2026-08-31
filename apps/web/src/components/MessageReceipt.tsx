/**
 * Sent / delivered / read, as ticks.
 *
 * State is derived from two room-level cursors rather than a per-message record: the
 * cursors are monotonic, so a message's state is just its sequence number compared
 * against how far everyone else has got.
 *
 * Only shown on your own messages. A tick beside someone else's message would be
 * telling them what you already know.
 */
export type Delivery = { members: number; deliveredThrough: number; readThrough: number };

export function MessageReceipt({ seq, delivery }: { seq: number; delivery: Delivery | null }) {
  if (!delivery || delivery.members === 0) return null;

  const state =
    seq <= delivery.readThrough ? 'read'
    : seq <= delivery.deliveredThrough ? 'delivered'
    : 'sent';

  const label =
    state === 'read'
      ? delivery.members > 1 ? 'Read by everyone' : 'Read'
      : state === 'delivered'
        ? delivery.members > 1 ? 'Delivered to everyone' : 'Delivered'
        : 'Sent';

  return (
    <span className={`receipt receipt-${state}`} title={label}>
      {/* Two ticks for delivered and read, one for sent. Colour alone does not carry
          the difference, because it is the one distinction people check at a glance. */}
      <span aria-hidden="true">{state === 'sent' ? '✓' : '✓✓'}</span>
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
