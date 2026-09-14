/**
 * Chat module (blueprint 04/08).
 *
 * Messages arrive over WebSocket and are reconciled against the durable history by
 * sequence number, so a reconnect catches up without gaps or duplicates. The composer
 * is a plain textarea with an explicit send control - fully keyboard operable.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDebounced } from '../lib/useDebounced';
import { useNavigate, useParams } from 'react-router-dom';
import { Hash, MessageSquarePlus, Plus, Send, UserPlus } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, ErrorState, Loading, FormError } from '../components/States';
import { realtime } from '../lib/realtime';
import { initials, relativeTime } from '../lib/format';
import { useSession } from '../lib/session';
import { MessageReceipt, type Delivery } from '../components/MessageReceipt';

type Room = {
  id: string;
  type: 'channel' | 'group' | 'direct';
  name: string | null;
  topic: string | null;
  last_message_at: string | null;
  unread: number;
  counterpart_name: string | null;
};

type Message = {
  id: string;
  roomId: string;
  seq: number;
  authorId: string | null;
  authorName: string | null;
  body: string;
  deleted: boolean;
  editedAt: string | null;
  createdAt: string;
  reactions?: { emoji: string; count: number; mine: boolean }[];
};

const REACTIONS = ['👍', '✅', '🎉', '👀'];

function roomLabel(room: Room): string {
  if (room.type === 'direct') return room.counterpart_name ?? 'Direct message';
  return `#${room.name ?? 'channel'}`;
}

export default function Chat() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<Message[]>([]);
  const [creating, setCreating] = useState(false);
  const [startingDirect, setStartingDirect] = useState(false);
  const [addingPeople, setAddingPeople] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [messageError, setMessageError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rooms = useQuery<{ items: Room[] }>('/chat/rooms', (signal) => api.get('/chat/rooms', signal));

  const historyKey = roomId ? `/chat/rooms/${roomId}/messages?limit=50` : null;
  const history = useQuery<{ items: Message[] }>(historyKey, (signal) =>
    api.get(`/chat/rooms/${roomId}/messages?limit=50`, signal),
  );

  // Subscribe to this room only; the server authorizes the channel before joining it.
  useEffect(() => {
    if (!roomId) return;
    setLive([]);
    const unsubscribe = realtime.subscribe(`room:${roomId}`);
    const off = realtime.on((frame) => {
      if (frame.channel !== `room:${roomId}`) return;
      if (frame.type === 'message.created') {
        const message = frame.data as unknown as Message;
        // Deduplicate by sequence: the same message may also arrive via a refetch.
        setLive((current) =>
          current.some((m) => m.seq === message.seq) ? current : [...current, message],
        );
      }
      if (frame.type === 'message.deleted') {
        const id = String((frame.data as { id: string }).id);
        setLive((current) => current.filter((m) => m.id !== id));
        invalidate('/chat/rooms');
      }
    });
    return () => {
      unsubscribe();
      off();
    };
  }, [roomId]);

  // Merge durable history with live frames, ordered by sequence.
  const messages: Message[] = (() => {
    const seen = new Map<number, Message>();
    for (const message of history.data?.items ?? []) seen.set(message.seq, message);
    for (const message of live) seen.set(message.seq, message);
    return [...seen.values()].sort((a, b) => a.seq - b.seq);
  })();
  const activeRoom = rooms.data?.items.find((room) => room.id === roomId);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages.length, roomId]);

  // Record the read cursor so unread counts stay accurate across devices.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!roomId || !last) return;
    void api.post(`/chat/rooms/${roomId}/read`, { seq: last.seq }).catch(() => undefined);
  }, [roomId, messages.length]);

  /**
   * Acknowledge delivery separately from reading.
   *
   * This fires when the message arrives in this client, whether or not the room is on
   * screen — that is what distinguishes "it reached their device" from "they looked at
   * it". Failures are swallowed: a lost acknowledgement re-sends on the next message,
   * and an error banner about a tick mark would be noise.
   */
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!roomId || !last) return;
    void api.post(`/chat/rooms/${roomId}/delivered`, { seq: last.seq }).catch(() => undefined);
  }, [roomId, messages.length]);

  // How far everyone else in this room has got. Refetched as messages arrive, since a
  // receipt changing is exactly what the sender is waiting to see.
  const delivery = useQuery<Delivery>(
    roomId ? `/chat/rooms/${roomId}/delivery` : null,
    (signal) => api.get(`/chat/rooms/${roomId}/delivery`, signal),
  );
  useEffect(() => { delivery.reload(); }, [messages.length]);

  const send = useMutation(
    async (body: string) => api.post<Message>(`/chat/rooms/${roomId}/messages`, { body }),
    { invalidates: ['/chat/rooms'] },
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft('');
    const result = await send.mutate(body);
    // Restore the draft if the send failed, so nothing the person typed is lost.
    if (!result) setDraft(body);
  };

  /** Edits, deletions and reactions come back through the history, so the live copy is dropped. */
  const changeMessage = async (message: Message, action: () => Promise<unknown>) => {
    setMessageError(null);
    try { await action(); } catch (err) { setMessageError(err instanceof ApiError ? err.message : 'That did not go through.'); }
    setLive((current) => current.filter((m) => m.id !== message.id));
    history.reload();
  };

  return (
    <div className="module-page chat-module">
      <header className="module-header">
        <div>
          <h2>Chat</h2>
          <p>Conversations with your colleagues.</p>
        </div>
        <div className="header-controls">
          <button type="button" className="ghost-button" onClick={() => setStartingDirect(true)}>
            <MessageSquarePlus size={15} aria-hidden="true" /> Message someone
          </button>
          <button type="button" className="primary-button" onClick={() => setCreating(true)}>
            <Plus size={15} aria-hidden="true" /> New channel
          </button>
        </div>
      </header>

      <div className="chat-layout">
        <nav className="chat-rooms" aria-label="Conversations">
          <div className="chat-rooms-head">
            <span>Conversations</span>
            <span className="chat-room-total">{rooms.data?.items.length ?? 0}</span>
          </div>
          <AsyncSection query={rooms}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty title="No conversations yet" description="Create a channel to get started." />
              ) : (
                <ul>
                  {data.items.map((room) => (
                    <li key={room.id}>
                      <button
                        type="button"
                        className={`room-button ${room.id === roomId ? 'room-active' : ''}`}
                        aria-current={room.id === roomId ? 'true' : undefined}
                        onClick={() => navigate(`/chat/${room.id}`)}
                      >
                        {room.type === 'direct' ? (
                          <span className="thread-avatar" aria-hidden="true">
                            {initials(room.counterpart_name ?? '?')}
                          </span>
                        ) : (
                          <Hash size={15} aria-hidden="true" />
                        )}
                        <span className="room-label">{roomLabel(room)}</span>
                        {room.unread > 0 ? <span className="folder-count">{room.unread}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </nav>

        <section className="chat-thread" aria-label="Messages">
          {roomId ? (
            <header className="chat-thread-header">
              <span className={`chat-thread-symbol chat-thread-${activeRoom?.type ?? 'channel'}`} aria-hidden="true">
                {activeRoom?.type === 'direct'
                  ? initials(activeRoom.counterpart_name ?? '?')
                  : <Hash size={17} />}
              </span>
              <div>
                <strong>{activeRoom ? roomLabel(activeRoom) : 'Conversation'}</strong>
                <span>{activeRoom?.topic || (activeRoom?.type === 'direct' ? 'Direct conversation' : 'Team conversation')}</span>
              </div>
              {activeRoom && activeRoom.type !== 'direct' ? (
                <span className="chat-channel-actions">
                  <button type="button" className="ghost-button" onClick={() => setAddingPeople(true)}>
                    <UserPlus size={14} aria-hidden="true" /> Add people
                  </button>
                  <button type="button" className="link-button" onClick={async () => {
                    const name = window.prompt('Rename channel', activeRoom.name ?? '')?.trim();
                    if (!name || name === activeRoom.name) return;
                    setMessageError(null);
                    try { await api.patch(`/chat/rooms/${activeRoom.id}`, { name }); } catch (err) { setMessageError(err instanceof ApiError ? err.message : 'The channel was not renamed.'); }
                    invalidate('/chat/rooms');
                  }}>Rename</button>
                  <button type="button" className="link-button" onClick={async () => {
                    if (!window.confirm(`Archive #${activeRoom.name}? Nobody can post in it any more.`)) return;
                    setMessageError(null);
                    try { await api.delete(`/chat/rooms/${activeRoom.id}`); invalidate('/chat/rooms'); navigate('/chat'); } catch (err) { setMessageError(err instanceof ApiError ? err.message : 'The channel was not archived.'); }
                  }}>Archive</button>
                </span>
              ) : null}
            </header>
          ) : null}
          {!roomId ? (
            <Empty title="Select a conversation" description="Choose a channel or colleague." />
          ) : history.loading ? (
            <Loading label="Loading conversation" />
          ) : history.error ? (
            <ErrorState error={history.error} onRetry={history.reload} />
          ) : (
            <>
              <div className="chat-scroll" ref={scrollRef} tabIndex={0} aria-label="Message history">
                {messages.length === 0 ? (
                  <p className="panel-empty">No messages yet. Say something.</p>
                ) : (
                  <ul className="message-stream">
                    {messages.map((message) => {
                      const mine = message.authorId === session?.user?.id;
                      return (
                        <li key={message.id} className={mine ? 'message-mine' : ''}>
                          <span className="thread-avatar" aria-hidden="true">
                            {initials(message.authorName ?? '?')}
                          </span>
                          <div>
                            <p className="message-head">
                              <strong>{message.authorName ?? 'Unknown'}</strong>
                              <time dateTime={message.createdAt}>
                                {relativeTime(message.createdAt)}
                              </time>
                              {message.editedAt ? <span className="edited-tag">edited</span> : null}
                              {/* Only on your own messages: a tick beside someone
                                  else's would report what they already know. */}
                              {mine ? (
                                <MessageReceipt seq={message.seq} delivery={delivery.data ?? null} />
                              ) : null}
                            </p>
                            {editingId === message.id ? (
                              <form className="chat-edit" onSubmit={(e) => {
                                e.preventDefault();
                                const body = editText.trim();
                                if (!body) return;
                                setEditingId(null);
                                void changeMessage(message, () => api.patch(`/chat/rooms/${roomId}/messages/${message.id}`, { body }));
                              }}>
                                <label className="visually-hidden" htmlFor={`edit-${message.id}`}>Edit message</label>
                                <textarea id={`edit-${message.id}`} autoFocus rows={2} value={editText} onChange={(e) => setEditText(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Escape') setEditingId(null); }} />
                                <span className="sd-inline"><button type="submit" className="ghost-button">Save</button><button type="button" className="sd-link-button" onClick={() => setEditingId(null)}>Cancel</button></span>
                              </form>
                            ) : (
                              <p className="message-text">
                                {message.deleted ? <em>This message was removed.</em> : message.body}
                              </p>
                            )}
                            {!message.deleted ? (
                              <div className="message-actions">
                                {(message.reactions ?? []).map((r) => (
                                  <button key={r.emoji} type="button" className={`reaction ${r.mine ? 'reaction-mine' : ''}`} aria-pressed={r.mine}
                                    aria-label={`${r.emoji} ${r.count}, ${r.mine ? 'remove your reaction' : 'react'}`}
                                    onClick={() => void changeMessage(message, () => api.post(`/chat/rooms/${roomId}/messages/${message.id}/reactions`, { emoji: r.emoji }))}>
                                    {r.emoji} {r.count}
                                  </button>
                                ))}
                                <span className="message-tools">
                                  {REACTIONS.filter((e) => !(message.reactions ?? []).some((r) => r.emoji === e)).map((emoji) => (
                                    <button key={emoji} type="button" className="reaction reaction-add" aria-label={`React with ${emoji}`}
                                      onClick={() => void changeMessage(message, () => api.post(`/chat/rooms/${roomId}/messages/${message.id}/reactions`, { emoji }))}>{emoji}</button>
                                  ))}
                                  {mine ? <button type="button" className="sd-link-button" onClick={() => { setEditingId(message.id); setEditText(message.body); }}>Edit</button> : null}
                                  {mine ? <button type="button" className="sd-link-button" onClick={() => { if (window.confirm('Delete this message?')) void changeMessage(message, () => api.delete(`/chat/rooms/${roomId}/messages/${message.id}`)); }}>Delete</button> : null}
                                </span>
                              </div>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <form className="chat-composer" onSubmit={submit}>
                <div className="chat-compose-field">
                  <label className="visually-hidden" htmlFor="chat-input">
                    Write a message
                  </label>
                  <textarea
                    id="chat-input"
                    rows={2}
                    value={draft}
                    placeholder="Write a message…"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter sends, Shift+Enter makes a new line - and the button below
                      // remains a full keyboard-accessible alternative.
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void submit(event);
                      }
                    }}
                  />
                  <span className="chat-compose-hint">Enter to send · Shift + Enter for a new line</span>
                </div>
                <button type="submit" className="primary-button" disabled={send.pending}>
                  <Send size={15} aria-hidden="true" />
                  <span className="visually-hidden">Send message</span>
                </button>
              </form>
              {messageError ? <p className="field-error" role="alert">{messageError}</p> : null}
              {send.error ? (
                <p className="field-error" role="alert">{send.error.message}</p>
              ) : null}
            </>
          )}
        </section>
      </div>

      {addingPeople && roomId ? <AddPeopleDialog roomId={roomId} onClose={() => { setAddingPeople(false); invalidate('/chat/rooms'); }} /> : null}
      {startingDirect ? (
        <DirectMessageDialog
          onClose={() => setStartingDirect(false)}
          onOpened={(id) => {
            setStartingDirect(false);
            invalidate('/chat/rooms');
            navigate(`/chat/${id}`);
          }}
        />
      ) : null}

      {creating ? (
        <CreateChannelDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            invalidate('/chat/rooms');
            navigate(`/chat/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function CreateChannelDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'company'>('private');
  const [memberIds, setMemberIds] = useState<string[]>([]);

  const people = useQuery<{ items: { id: string; displayName: string }[] }>(
    '/users?limit=100',
    (signal) => api.get('/users?limit=100', signal),
  );

  const create = useMutation(
    async () => api.post<{ id: string }>('/chat/rooms', { name, topic, visibility, memberIds }),
    { invalidates: ['/chat/rooms'], onSuccess: (room) => onCreated(room.id) },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="channel-title">New channel</h3>
        <FormError error={create.error} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="channel-name">Channel name</label>
            <input
              id="channel-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="site-operations"
              required
              autoFocus
            />
            <p className="field-hint">Letters, numbers and hyphens.</p>
          </div>

          <div className="field">
            <label htmlFor="channel-topic">Topic</label>
            <input
              id="channel-topic"
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="channel-visibility">Who can join</label>
            <select
              id="channel-visibility"
              value={visibility}
              onChange={(event) => setVisibility(event.target.value as 'private' | 'company')}
            >
              <option value="private">Invited people only</option>
              <option value="company">Anyone in the company</option>
            </select>
          </div>

          <fieldset className="field">
            <legend>
              <UserPlus size={14} aria-hidden="true" /> Add people
            </legend>
            <div className="attendee-picker">
              {(people.data?.items ?? []).map((person) => (
                <label key={person.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={memberIds.includes(person.id)}
                    onChange={(event) =>
                      setMemberIds((current) =>
                        event.target.checked
                          ? [...current, person.id]
                          : current.filter((id) => id !== person.id),
                      )
                    }
                  />
                  {person.displayName}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending}>
              {create.pending ? 'Creating…' : 'Create channel'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Opens (or reopens) a direct conversation. The server keys these by the participant
 * pair, so choosing the same person twice returns the existing conversation rather
 * than creating a duplicate.
 */
function DirectMessageDialog({
  onClose,
  onOpened,
}: {
  onClose: () => void;
  onOpened: (roomId: string) => void;
}) {
  const { session } = useSession();
  const [search, setSearch] = useState('');
  const query = useDebounced(search, 250);

  // The directory can exceed one page, so the search runs on the server rather than
  // filtering whatever happened to be in the first page.
  const listKey = `/users?limit=100&status=active${
    query ? `&q=${encodeURIComponent(query)}` : ''
  }`;
  const people = useQuery<{ items: { id: string; displayName: string; email: string }[] }>(
    listKey,
    (signal) => api.get(listKey, signal),
  );

  const open = useMutation(
    async (userId: string) => api.post<{ id: string }>('/chat/direct', { userId }),
    { invalidates: ['/chat/rooms'], onSuccess: (room) => onOpened(room.id) },
  );

  const candidates = (people.data?.items ?? []).filter(
    (person) => person.id !== session?.user?.id,
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="direct-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="direct-title">Message someone</h3>

        <FormError error={open.error} />

        <div className="field">
          <label htmlFor="direct-search">Search colleagues</label>
          <input
            id="direct-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name or email"
            autoFocus
          />
          {candidates.length >= 100 ? (
            <p className="field-hint">
              Showing the first 100 matches. Narrow the search to find someone specific.
            </p>
          ) : null}
        </div>

        <AsyncSection query={people}>
          {() =>
            candidates.length === 0 ? (
              <Empty title="No matches" description="Try a different name." />
            ) : (
              <ul className="person-list dialog-list">
                {candidates.map((person) => (
                  <li key={person.id}>
                    <button
                      type="button"
                      className="person-row"
                      disabled={open.pending}
                      onClick={() => void open.mutate(person.id)}
                    >
                      <span className="thread-avatar" aria-hidden="true">
                        {initials(person.displayName)}
                      </span>
                      <span className="person-body">
                        <strong>{person.displayName}</strong>
                        <span>{person.email}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )
          }
        </AsyncSection>

        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function AddPeopleDialog({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const people = useQuery<{ items: { id: string; displayName: string }[] }>('/users?limit=100', (signal) => api.get('/users?limit=100', signal));
  const members = useQuery<{ items: { userId?: string; user_id?: string; id?: string }[] }>(`/chat/rooms/${roomId}/members`, (signal) => api.get(`/chat/rooms/${roomId}/members`, signal));
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const memberIds = new Set((members.data?.items ?? []).map((m) => m.userId ?? m.user_id ?? m.id));
  const candidates = (people.data?.items ?? []).filter((p) => !memberIds.has(p.id));
  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <form className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-people-title" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        onSubmit={async (e) => {
          e.preventDefault(); setError(null);
          try { await api.post(`/chat/rooms/${roomId}/members`, { userIds: chosen }); onClose(); }
          catch (err) { setError(err instanceof ApiError ? err.message : 'Nobody was added.'); }
        }}>
        <h3 id="add-people-title">Add people to this channel</h3>
        {!people.data || !members.data ? <Loading label="Loading people" /> : candidates.length === 0 ? <p className="field-hint">Everyone is already in this channel.</p> : (
          <div className="field">
            <label htmlFor="add-people-list">People</label>
            <select id="add-people-list" autoFocus multiple size={Math.min(8, candidates.length)} value={chosen} onChange={(e) => setChosen([...e.target.selectedOptions].map((o) => o.value))}>
              {candidates.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
            </select>
            <p className="field-hint">Hold Command or Ctrl to choose more than one.</p>
          </div>
        )}
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={chosen.length === 0}>Add</button></div>
      </form>
    </div>
  );
}
