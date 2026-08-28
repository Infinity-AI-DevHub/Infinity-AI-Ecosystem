/**
 * Announcements (blueprint 04).
 *
 * Company-wide, department or group broadcasts with scheduling, acknowledgement
 * tracking and withdrawal. Reading one records the read; an announcement that requires
 * acknowledgement asks for it explicitly rather than inferring it from a scroll.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BarChart3, Check, Megaphone, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, ErrorState, Loading, FormError } from '../components/States';
import { formatDateTime, relativeTime, titleCase } from '../lib/format';
import { useSession } from '../lib/session';

type Announcement = {
  id: string;
  title: string;
  body: string;
  priority: 'normal' | 'important' | 'critical';
  requires_ack: boolean;
  publish_at: string;
  expires_at: string | null;
  author_name: string | null;
  read_at: string | null;
  acknowledged_at: string | null;
};

type Stats = { reads: number; acks: number; audience_size: number };
type Department = { id: string; name: string };
type Group = { id: string; name: string };

export default function Announcements() {
  const { announcementId } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const [composing, setComposing] = useState(false);

  const announcements = useQuery<{ items: Announcement[] }>('/announcements', (signal) =>
    api.get('/announcements', signal),
  );

  const detailKey = announcementId ? `/announcements/${announcementId}` : null;
  const detail = useQuery<Announcement>(detailKey, (signal) =>
    api.get(`/announcements/${announcementId}`, signal),
  );

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Announcements</h2>
          <p>Company notices addressed to you.</p>
        </div>
        {can('announcement.create') ? (
          <button type="button" className="primary-button" onClick={() => setComposing(true)}>
            <Plus size={15} aria-hidden="true" /> New announcement
          </button>
        ) : null}
      </header>

      <div className="split-layout">
        <section className="panel" aria-label="Announcements">
          <AsyncSection query={announcements}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty
                  title="Nothing announced"
                  description="Company notices addressed to you will appear here."
                  icon={<Megaphone size={22} />}
                />
              ) : (
                <ul className="announcement-rows">
                  {data.items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={`announcement-row ${
                          item.id === announcementId ? 'announcement-active' : ''
                        } ${item.read_at ? '' : 'announcement-unread'}`}
                        onClick={() => navigate(`/announcements/${item.id}`)}
                      >
                        <span className={`priority-bar priority-${item.priority}`} aria-hidden="true" />
                        <span className="announcement-body">
                          <strong>{item.title}</strong>
                          <span>
                            {item.author_name ?? 'Workspace'} ·{' '}
                            <time dateTime={item.publish_at}>{relativeTime(item.publish_at)}</time>
                          </span>
                        </span>
                        {item.priority !== 'normal' ? (
                          <span className={`status-tag status-${item.priority}`}>
                            {titleCase(item.priority)}
                          </span>
                        ) : null}
                        {item.requires_ack && !item.acknowledged_at ? (
                          <span className="status-tag status-pending">Action needed</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </section>

        <section className="panel" aria-label="Announcement detail">
          {!announcementId ? (
            <Empty title="Select an announcement" description="Choose a notice to read it." />
          ) : detail.loading ? (
            <Loading label="Loading announcement" />
          ) : detail.error ? (
            <ErrorState error={detail.error} onRetry={detail.reload} />
          ) : detail.data ? (
            <AnnouncementDetail
              announcement={detail.data}
              onChanged={() => {
                detail.reload();
                invalidate('/announcements');
                invalidate('/me/dashboard');
              }}
              onWithdrawn={() => {
                invalidate('/announcements');
                navigate('/announcements');
              }}
            />
          ) : null}
        </section>
      </div>

      {composing ? (
        <ComposeAnnouncement
          onClose={() => setComposing(false)}
          onCreated={(id) => {
            setComposing(false);
            invalidate('/announcements');
            navigate(`/announcements/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function AnnouncementDetail({
  announcement,
  onChanged,
  onWithdrawn,
}: {
  announcement: Announcement;
  onChanged: () => void;
  onWithdrawn: () => void;
}) {
  const { can } = useSession();
  const [showStats, setShowStats] = useState(false);

  // Opening the notice records the read. Acknowledgement stays a deliberate act.
  const markRead = useMutation(
    async (acknowledge: boolean) =>
      api.post(`/announcements/${announcement.id}/read`, { acknowledge }),
    { onSuccess: onChanged },
  );

  const withdraw = useMutation(async () => api.delete(`/announcements/${announcement.id}`), {
    invalidates: ['/announcements'],
    onSuccess: onWithdrawn,
  });

  const stats = useQuery<Stats>(
    showStats ? `/announcements/${announcement.id}/stats` : null,
    (signal) => api.get(`/announcements/${announcement.id}/stats`, signal),
  );

  // Record the read once the notice is actually on screen. The ref guards against a
  // second write when React re-runs effects in development.
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (announcement.read_at) return;
    if (recorded.current === announcement.id) return;
    recorded.current = announcement.id;
    void markRead.mutate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announcement.id, announcement.read_at]);

  return (
    <article className="announcement-detail">
      <h3>{announcement.title}</h3>
      <p className="task-meta">
        {announcement.author_name ?? 'Workspace'} ·{' '}
        <time dateTime={announcement.publish_at}>{formatDateTime(announcement.publish_at)}</time>
        {announcement.expires_at ? ` · expires ${relativeTime(announcement.expires_at)}` : ''}
      </p>

      {announcement.priority !== 'normal' ? (
        <p className={`announcement-priority priority-${announcement.priority}`} role="note">
          {announcement.priority === 'critical'
            ? 'Critical notice — please read carefully.'
            : 'Important notice.'}
        </p>
      ) : null}

      <div className="announcement-text">
        {announcement.body.split('\n').map((paragraph, index) =>
          paragraph.trim() ? <p key={index}>{paragraph}</p> : null,
        )}
      </div>

      {announcement.requires_ack ? (
        announcement.acknowledged_at ? (
          <p className="save-confirmation" role="status">
            <Check size={14} aria-hidden="true" /> Acknowledged{' '}
            <time dateTime={announcement.acknowledged_at}>
              {relativeTime(announcement.acknowledged_at)}
            </time>
          </p>
        ) : (
          <div className="ack-block">
            <p>This notice asks you to confirm you have read it.</p>
            <button
              type="button"
              className="primary-button"
              disabled={markRead.pending}
              onClick={() => void markRead.mutate(true)}
            >
              <Check size={15} aria-hidden="true" />
              {markRead.pending ? 'Recording…' : 'I acknowledge this'}
            </button>
          </div>
        )
      ) : null}

      {can('announcement.create') ? (
        <section className="announcement-admin">
          <button
            type="button"
            className="ghost-button"
            aria-expanded={showStats}
            onClick={() => setShowStats((open) => !open)}
          >
            <BarChart3 size={14} aria-hidden="true" /> Reach
          </button>

          {can('announcement.manage') ? (
            <button
              type="button"
              className="danger-button"
              disabled={withdraw.pending}
              onClick={() => {
                if (window.confirm('Withdraw this announcement? It will stop being shown.')) {
                  void withdraw.mutate();
                }
              }}
            >
              <Trash2 size={14} aria-hidden="true" /> Withdraw
            </button>
          ) : null}

          {showStats && stats.data ? (
            <dl className="detail-list">
              <div>
                <dt>Audience</dt>
                <dd>{stats.data.audience_size}</dd>
              </div>
              <div>
                <dt>Read</dt>
                <dd>{stats.data.reads}</dd>
              </div>
              {announcement.requires_ack ? (
                <div>
                  <dt>Acknowledged</dt>
                  <dd>{stats.data.acks}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
        </section>
      ) : null}
    </article>
  );
}

function ComposeAnnouncement({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<'normal' | 'important' | 'critical'>('normal');
  const [scope, setScope] = useState<'company' | 'department' | 'group'>('company');
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [requiresAck, setRequiresAck] = useState(false);
  const [expiresAt, setExpiresAt] = useState('');

  const departments = useQuery<{ items: Department[] }>('/departments', (signal) =>
    api.get('/departments', signal),
  );
  const groups = useQuery<{ items: Group[] }>('/admin/groups', (signal) =>
    api.get('/admin/groups', signal),
  );

  const create = useMutation(
    async () => {
      const audience =
        scope === 'company'
          ? { scope: 'company' as const }
          : scope === 'department'
            ? { scope: 'department' as const, departmentIds: targetIds }
            : { scope: 'group' as const, groupIds: targetIds };

      return api.post<{ id: string }>('/announcements', {
        title,
        body,
        priority,
        audience,
        requiresAck,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
    },
    { invalidates: ['/announcements'], onSuccess: (result) => onCreated(result.id) },
  );

  const targets = scope === 'department' ? (departments.data?.items ?? []) : (groups.data?.items ?? []);

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="announcement-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="announcement-title">New announcement</h3>

        <FormError error={create.error} />

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.mutate();
          }}
        >
          <div className="field">
            <label htmlFor="ann-title">Title</label>
            <input
              id="ann-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="ann-body">Message</label>
            <textarea
              id="ann-body"
              rows={8}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              required
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="ann-priority">Priority</label>
              <select
                id="ann-priority"
                value={priority}
                onChange={(event) =>
                  setPriority(event.target.value as 'normal' | 'important' | 'critical')
                }
              >
                <option value="normal">Normal</option>
                <option value="important">Important</option>
                <option value="critical">Critical</option>
              </select>
            </div>

            <div className="field">
              <label htmlFor="ann-scope">Audience</label>
              <select
                id="ann-scope"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value as 'company' | 'department' | 'group');
                  setTargetIds([]);
                }}
              >
                <option value="company">Everyone in the company</option>
                <option value="department">Specific departments</option>
                <option value="group">Specific groups</option>
              </select>
            </div>
          </div>

          {scope !== 'company' ? (
            <fieldset className="field">
              <legend>{scope === 'department' ? 'Departments' : 'Groups'}</legend>
              <div className="attendee-picker">
                {targets.length === 0 ? (
                  <p className="field-hint">None available.</p>
                ) : (
                  targets.map((target) => (
                    <label key={target.id} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={targetIds.includes(target.id)}
                        onChange={(event) =>
                          setTargetIds((current) =>
                            event.target.checked
                              ? [...current, target.id]
                              : current.filter((id) => id !== target.id),
                          )
                        }
                      />
                      {target.name}
                    </label>
                  ))
                )}
              </div>
            </fieldset>
          ) : null}

          <div className="field">
            <label htmlFor="ann-expires">Stop showing after (optional)</label>
            <input
              id="ann-expires"
              type="date"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </div>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={requiresAck}
              onChange={(event) => setRequiresAck(event.target.checked)}
            />
            Ask each person to acknowledge they have read it
          </label>

          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={create.pending || (scope !== 'company' && targetIds.length === 0)}
            >
              {create.pending ? 'Publishing…' : 'Publish'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
