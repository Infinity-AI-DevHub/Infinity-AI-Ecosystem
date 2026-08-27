/**
 * Chat module (blueprint 04/08).
 *
 * Messages arrive over WebSocket and are reconciled against the durable history by
 * sequence number, so a reconnect catches up without gaps or duplicates. The composer
 * is a plain textarea with an explicit send control - fully keyboard operable.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Hash, MessageSquarePlus, Plus, Send, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, ErrorState, Loading } from '../components/States';
import { realtime } from '../lib/realtime';
import { initials, relativeTime } from '../lib/format';
import { useSession } from '../lib/session';

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
};

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
                            </p>
                            <p className="message-text">
                              {message.deleted ? (
                                <em>This message was removed.</em>
                              ) : (
                                message.body
                              )}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <form className="chat-composer" onSubmit={submit}>
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
                <button type="submit" className="primary-button" disabled={send.pending}>
                  <Send size={15} aria-hidden="true" />
                  <span className="visually-hidden">Send message</span>
                </button>
              </form>
              {send.error ? (
                <p className="field-error" role="alert">{send.error.message}</p>
              ) : null}
            </>
          )}
        </section>
      </div>

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
        {create.error ? (
          <div className="auth-error" role="alert"><p>{create.error.message}</p></div>
        ) : null}

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

  const people = useQuery<{ items: { id: string; displayName: string; email: string }[] }>(
    '/users?limit=200',
    (signal) => api.get('/users?limit=200', signal),
  );

  const open = useMutation(
    async (userId: string) => api.post<{ id: string }>('/chat/direct', { userId }),
    { invalidates: ['/chat/rooms'], onSuccess: (room) => onOpened(room.id) },
  );

  const candidates = (people.data?.items ?? [])
    .filter((person) => person.id !== session?.user?.id)
    .filter((person) =>
      search.trim().length === 0
        ? true
        : `${person.displayName} ${person.email}`.toLowerCase().includes(search.toLowerCase()),
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

        {open.error ? (
          <div className="auth-error" role="alert"><p>{open.error.message}</p></div>
        ) : null}

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
