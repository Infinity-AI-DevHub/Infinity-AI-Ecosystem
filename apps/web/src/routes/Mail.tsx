/**
 * Mail module (blueprint 09).
 *
 * Three-pane on desktop, single-pane on narrow screens. Message HTML is already
 * sanitized server-side and arrives with remote images neutralised; the reader opts in
 * to load them per message.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ImageOff, Paperclip, Send, Star, Trash2 } from 'lucide-react';
import { api, idempotencyKey, type Paged } from '../lib/api';
import { useQuery, invalidate, useMutation } from '../lib/query';
import { AsyncSection, DegradedNotice, Empty, ErrorState, Loading } from '../components/States';
import { formatDateTime, initials, relativeTime } from '../lib/format';

type Folder = { id: string; name: string; kind: string; unread: number; total: number };

type MailboxResponse = {
  mailbox: {
    id: string;
    address: string;
    displayName: string;
    provisionState: string;
    quotaBytes: number;
    usedBytes: number;
  };
  folders: Folder[];
  stats: { unread: number; total: number; quarantined: number };
};

type Message = {
  id: string;
  from: { address: string; name: string | null };
  to: string[];
  cc: string[];
  subject: string;
  snippet: string;
  bodyText: string;
  isRead: boolean;
  isFlagged: boolean;
  deliveryState: string;
  deliveryDetail: string | null;
  scanState: string;
  version: number;
  receivedAt: string;
  sentAt: string | null;
};

type MessageDetail = Message & {
  bodyHtml: string | null;
  attachments: { id: string; filename: string; mime_type: string; size_bytes: number; scan_state: string }[];
};

export default function Mail() {
  const { messageId } = useParams();
  const navigate = useNavigate();
  const [folderKind, setFolderKind] = useState('inbox');
  const [composing, setComposing] = useState(false);
  const [showImages, setShowImages] = useState(false);

  const mailbox = useQuery<MailboxResponse>('/mail/mailboxes', (signal) =>
    api.get('/mail/mailboxes', signal),
  );

  const listKey = `/mail/messages?folder=${folderKind}&limit=40`;
  const messages = useQuery<Paged<Message>>(listKey, (signal) => api.get(listKey, signal), {
    ttlMs: 10_000,
  });

  const detailKey = messageId ? `/mail/messages/${messageId}` : null;
  const detail = useQuery<MessageDetail>(detailKey, (signal) =>
    api.get(`/mail/messages/${messageId}`, signal),
  );

  // Opening a message marks it read; the list reconciles from the server afterwards.
  useEffect(() => {
    if (!detail.data || detail.data.isRead) return;
    void api
      .patch(`/mail/messages/${detail.data.id}`, { isRead: true })
      .then(() => {
        invalidate('/mail/messages');
        invalidate('/mail/mailboxes');
      })
      .catch(() => undefined);
  }, [detail.data]);

  // Each message decides afresh whether remote images are loaded.
  useEffect(() => setShowImages(false), [messageId]);

  const provisioning = mailbox.data?.mailbox.provisionState;

  return (
    <div className="module-page mail-module">
      <header className="module-header">
        <div>
          <h2>Mail</h2>
          <p>{mailbox.data?.mailbox.address ?? 'Loading mailbox…'}</p>
        </div>
        <button type="button" className="primary-button" onClick={() => setComposing(true)}>
          <Send size={15} aria-hidden="true" /> New message
        </button>
      </header>

      {provisioning && provisioning !== 'ready' ? (
        <DegradedNotice
          reason={
            provisioning === 'failed'
              ? 'Your mailbox could not be provisioned with the mail provider. An administrator has been notified.'
              : 'Your mailbox is still being provisioned. You can read existing mail; sending becomes available shortly.'
          }
        />
      ) : null}

      <div className="mail-layout">
        <nav className="mail-folders" aria-label="Mail folders">
          <ul>
            {(mailbox.data?.folders ?? []).map((folder) => (
              <li key={folder.id}>
                <button
                  type="button"
                  className={`folder-button ${folderKind === folder.kind ? 'folder-active' : ''}`}
                  aria-current={folderKind === folder.kind ? 'true' : undefined}
                  onClick={() => {
                    setFolderKind(folder.kind);
                    navigate('/mail');
                  }}
                >
                  <span>{folder.name}</span>
                  {folder.unread > 0 ? <span className="folder-count">{folder.unread}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="mail-list" aria-label="Messages">
          <AsyncSection
            query={messages}
            empty={{ title: 'Nothing here', description: 'This folder is empty.' }}
          >
            {(page) =>
              page.items.length === 0 ? (
                <Empty title="Nothing here" description="This folder is empty." />
              ) : (
                <ul>
                  {page.items.map((message) => (
                    <li key={message.id}>
                      <button
                        type="button"
                        className={`thread-row ${message.id === messageId ? 'thread-active' : ''} ${
                          message.isRead ? '' : 'thread-unread'
                        }`}
                        onClick={() => navigate(`/mail/${message.id}`)}
                      >
                        <span className="thread-avatar" aria-hidden="true">
                          {initials(message.from.name ?? message.from.address)}
                        </span>
                        <span className="thread-body">
                          <span className="thread-top">
                            <strong>{message.from.name ?? message.from.address}</strong>
                            <time dateTime={message.receivedAt}>
                              {relativeTime(message.receivedAt)}
                            </time>
                          </span>
                          <span className="thread-subject">{message.subject || '(no subject)'}</span>
                          <span className="thread-snippet">{message.snippet}</span>
                          {message.deliveryState === 'bounced' || message.deliveryState === 'failed' ? (
                            <span className="thread-flag thread-flag-error">
                              <AlertTriangle size={12} aria-hidden="true" /> Delivery failed
                            </span>
                          ) : null}
                          {message.deliveryState === 'quarantined' ? (
                            <span className="thread-flag thread-flag-warn">Quarantined</span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </section>

        <section className="mail-reader" aria-label="Message">
          {!messageId ? (
            <Empty title="Select a message" description="Choose a message to read it here." />
          ) : detail.loading ? (
            <Loading label="Loading message" />
          ) : detail.error ? (
            <ErrorState error={detail.error} onRetry={detail.reload} />
          ) : detail.data ? (
            <article className="message-view">
              <header>
                <h3>{detail.data.subject || '(no subject)'}</h3>
                <p className="message-meta">
                  <strong>{detail.data.from.name ?? detail.data.from.address}</strong>{' '}
                  &lt;{detail.data.from.address}&gt;
                </p>
                <p className="message-meta">
                  To {detail.data.to.join(', ')}
                  {detail.data.cc.length > 0 ? ` · Cc ${detail.data.cc.join(', ')}` : ''}
                </p>
                <time dateTime={detail.data.receivedAt} className="message-meta">
                  {formatDateTime(detail.data.receivedAt)}
                </time>

                <div className="message-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    aria-pressed={detail.data.isFlagged}
                    onClick={async () => {
                      await api.patch(
                        `/mail/messages/${detail.data!.id}`,
                        { isFlagged: !detail.data!.isFlagged },
                        { ifMatch: detail.data!.version },
                      );
                      detail.reload();
                    }}
                  >
                    <Star size={14} aria-hidden="true" />
                    {detail.data.isFlagged ? 'Unflag' : 'Flag'}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={async () => {
                      await api.post(`/mail/messages/${detail.data!.id}/move`, { folder: 'trash' });
                      invalidate('/mail/messages');
                      navigate('/mail');
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" /> Move to trash
                  </button>
                </div>
              </header>

              {detail.data.scanState === 'infected' ? (
                <div className="quarantine-banner" role="alert">
                  <AlertTriangle size={16} aria-hidden="true" />
                  <p>
                    This message was quarantined because it carries a blocked attachment type.
                    Attachments cannot be downloaded.
                  </p>
                </div>
              ) : null}

              {detail.data.bodyHtml ? (
                <>
                  {!showImages && detail.data.bodyHtml.includes('data-blocked-src') ? (
                    <div className="image-blocked-bar">
                      <ImageOff size={15} aria-hidden="true" />
                      <p>Remote images are blocked to protect your privacy.</p>
                      <button type="button" className="ghost-button" onClick={() => setShowImages(true)}>
                        Load images
                      </button>
                    </div>
                  ) : null}
                  <div
                    className="message-body"
                    // The server sanitized this with an allow-list before storing it, and
                    // blocked-image sources are only restored on explicit request.
                    dangerouslySetInnerHTML={{
                      __html: showImages
                        ? detail.data.bodyHtml.replaceAll('data-blocked-src=', 'src=')
                        : detail.data.bodyHtml,
                    }}
                  />
                </>
              ) : (
                <div className="message-body message-body-plain">{detail.data.bodyText}</div>
              )}

              {detail.data.attachments.length > 0 ? (
                <footer className="attachment-list">
                  <h4>Attachments</h4>
                  <ul>
                    {detail.data.attachments.map((attachment) => (
                      <li key={attachment.id}>
                        <Paperclip size={14} aria-hidden="true" />
                        <span>{attachment.filename}</span>
                        {attachment.scan_state === 'infected' ? (
                          <span className="thread-flag thread-flag-error">Blocked</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </footer>
              ) : null}
            </article>
          ) : null}
        </section>
      </div>

      {composing ? (
        <ComposeDialog
          onClose={() => setComposing(false)}
          onSent={() => {
            setComposing(false);
            invalidate('/mail');
          }}
        />
      ) : null}
    </div>
  );
}

function ComposeDialog({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // Generated once per dialog so a retry after a timeout cannot send twice.
  const key = useMemo(() => idempotencyKey(), []);

  const send = useMutation(
    async () =>
      api.post(
        '/mail/messages',
        {
          to: to.split(/[,;]/).map((value) => value.trim()).filter(Boolean),
          subject,
          bodyText: body,
        },
        { idempotencyKey: key },
      ),
    { invalidates: ['/mail'], onSuccess: onSent },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compose-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="compose-title">New message</h3>

        {send.error ? (
          <div className="auth-error" role="alert">
            <p>{send.error.message}</p>
          </div>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="compose-to">To</label>
            <input
              id="compose-to"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder="colleague@company.com"
              required
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="compose-subject">Subject</label>
            <input
              id="compose-subject"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="compose-body">Message</label>
            <textarea
              id="compose-body"
              rows={10}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={send.pending}>
              <Send size={15} aria-hidden="true" />
              {send.pending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
