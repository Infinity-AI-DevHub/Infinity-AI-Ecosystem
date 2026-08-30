/**
 * Documents: the company's written knowledge.
 *
 * Three panes, because a wiki is read far more than it is written: spaces, the pages in
 * one, and the page itself. Editing is deliberately a mode you enter rather than the
 * default, so the common case - someone looking something up - is not cluttered by a
 * toolbar they will never use.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { BookOpen, FilePlus2, History, Pencil, Plus } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { invalidate, useMutation, useQuery } from '../lib/query';
import { AsyncSection, Empty, FormError } from '../components/States';
import { formatDateTime, relativeTime } from '../lib/format';
import { useSession } from '../lib/session';
import { RichText } from '../components/RichText';
import { Attachments } from '../components/Attachments';

type Space = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  visibility: string;
  colour: string;
  page_count: number;
};

type PageSummary = {
  id: string;
  parent_id: string | null;
  slug: string;
  title: string;
  excerpt: string | null;
  state: string;
  version: number;
  updated_at: string;
  updated_by_name: string | null;
};

type Page = PageSummary & {
  body: string;
  space_name: string;
  created_by_name: string | null;
};

type Version = {
  version: number;
  title: string;
  change_note: string | null;
  created_at: string;
  author_name: string | null;
};

export default function Docs() {
  const { spaceId, pageId } = useParams();
  const navigate = useNavigate();
  const { can } = useSession();
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [creatingPage, setCreatingPage] = useState(false);

  const spaces = useQuery<{ items: Space[] }>('/docs/spaces', (signal) =>
    api.get('/docs/spaces', signal),
  );

  // Land somewhere useful rather than on an empty pane.
  const activeSpaceId = spaceId ?? spaces.data?.items[0]?.id;
  const pagesKey = activeSpaceId ? `/docs/spaces/${activeSpaceId}/pages` : null;
  const pages = useQuery<{ items: PageSummary[] }>(pagesKey, (signal) => api.get(pagesKey!, signal));

  const pageKey = pageId ? `/docs/pages/${pageId}` : null;
  const page = useQuery<Page>(pageKey, (signal) => api.get(pageKey!, signal));

  const activeSpace = spaces.data?.items.find((s) => s.id === activeSpaceId) ?? null;

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Documents</h2>
          <p>Policies, runbooks and everything else worth writing down.</p>
        </div>
        <div className="header-controls">
          {can('doc.space_manage') ? (
            <button type="button" className="ghost-button" onClick={() => setCreatingSpace(true)}>
              <Plus size={15} aria-hidden="true" /> New space
            </button>
          ) : null}
          {can('doc.write') && activeSpace ? (
            <button type="button" className="primary-button" onClick={() => setCreatingPage(true)}>
              <FilePlus2 size={15} aria-hidden="true" /> New page
            </button>
          ) : null}
        </div>
      </header>

      <div className="docs-layout">
        <nav className="panel docs-spaces" aria-label="Spaces">
          <h3 className="panel-title">Spaces</h3>
          <AsyncSection query={spaces}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty title="No spaces yet" description="A space groups related pages." />
              ) : (
                <ul className="space-list">
                  {data.items.map((space) => (
                    <li key={space.id}>
                      <button
                        type="button"
                        className={`space-button ${space.id === activeSpaceId ? 'space-active' : ''}`}
                        onClick={() => navigate(`/docs/${space.id}`)}
                      >
                        <span className="space-swatch" style={{ background: space.colour }} aria-hidden="true" />
                        <span className="space-label">
                          <strong>{space.name}</strong>
                          <span>
                            {space.page_count} page{Number(space.page_count) === 1 ? '' : 's'}
                            {space.visibility === 'restricted' ? ' · restricted' : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </nav>

        <section className="panel docs-index" aria-label="Pages">
          <h3 className="panel-title">{activeSpace?.name ?? 'Pages'}</h3>
          {activeSpace?.description ? (
            <p className="field-hint">{activeSpace.description}</p>
          ) : null}
          <AsyncSection query={pages}>
            {(data) =>
              data.items.length === 0 ? (
                <Empty title="Nothing written yet" description="Create the first page in this space." />
              ) : (
                <ul className="page-list">
                  {data.items.map((summary) => (
                    <li key={summary.id}>
                      <button
                        type="button"
                        className={`page-button ${summary.id === pageId ? 'page-active' : ''}`}
                        onClick={() => navigate(`/docs/${activeSpaceId}/${summary.id}`)}
                      >
                        <strong>{summary.title}</strong>
                        {summary.state === 'draft' ? (
                          <span className="status-tag status-invited">Draft</span>
                        ) : null}
                        {summary.excerpt ? <span>{summary.excerpt}</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            }
          </AsyncSection>
        </section>

        <section className="panel docs-reader" aria-label="Page">
          {!pageId ? (
            <Empty
              title="Choose a page"
              description="Or start a new one — an empty handbook helps nobody."
            />
          ) : (
            <AsyncSection query={page}>{(data) => <PageView page={data} />}</AsyncSection>
          )}
        </section>
      </div>

      {creatingSpace ? (
        <SpaceDialog
          onClose={() => setCreatingSpace(false)}
          onCreated={(id) => {
            setCreatingSpace(false);
            invalidate('/docs/spaces');
            navigate(`/docs/${id}`);
          }}
        />
      ) : null}

      {creatingPage && activeSpaceId ? (
        <PageDialog
          spaceId={activeSpaceId}
          onClose={() => setCreatingPage(false)}
          onCreated={(id) => {
            setCreatingPage(false);
            invalidate('/docs/spaces');
            navigate(`/docs/${activeSpaceId}/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function PageView({ page }: { page: Page }) {
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Leaving edit mode when the page changes underneath prevents carrying one page's
  // draft into another.
  useEffect(() => {
    setEditing(false);
    setShowHistory(false);
  }, [page.id]);

  if (editing) {
    return <PageEditor page={page} onDone={() => setEditing(false)} />;
  }

  return (
    <article className="doc-page">
      <div className="panel-header">
        <div>
          <BookOpen size={16} aria-hidden="true" />
          <h3>{page.title}</h3>
        </div>
        <div className="header-controls">
          <button type="button" className="ghost-button" onClick={() => setShowHistory((v) => !v)}>
            <History size={15} aria-hidden="true" /> History
          </button>
          {can('doc.write') ? (
            <button type="button" className="primary-button" onClick={() => setEditing(true)}>
              <Pencil size={15} aria-hidden="true" /> Edit
            </button>
          ) : null}
        </div>
      </div>

      <p className="doc-meta">
        {page.state === 'draft' ? <span className="status-tag status-invited">Draft</span> : null}{' '}
        Version {page.version} · updated{' '}
        <time dateTime={page.updated_at}>{relativeTime(page.updated_at)}</time>
        {page.updated_by_name ? ` by ${page.updated_by_name}` : ''}
      </p>

      {showHistory ? <PageHistory pageId={page.id} currentVersion={page.version} /> : null}

      {/* The body is sanitized on write with the same allow-list used for mail, so what
          is stored is already safe to render. Sanitizing again here would only hide it
          if that ever stopped being true. */}
      <div className="doc-body" dangerouslySetInnerHTML={{ __html: page.body }} />
    </article>
  );
}

function PageHistory({ pageId, currentVersion }: { pageId: string; currentVersion: number }) {
  const history = useQuery<{ items: Version[] }>(`/docs/pages/${pageId}/history`, (signal) =>
    api.get(`/docs/pages/${pageId}/history`, signal),
  );

  const restore = useMutation(
    async (version: number) => api.post(`/docs/pages/${pageId}/versions/${version}/restore`, {}),
    {
      invalidates: ['/docs/pages'],
    },
  );

  return (
    <div className="doc-history">
      <h4>History</h4>
      <FormError error={restore.error} />
      <AsyncSection query={history}>
        {(data) => (
          <ul className="version-list">
            {data.items.map((version) => (
              <li key={version.version}>
                <span className="version-number">v{version.version}</span>
                <div>
                  <strong>{version.change_note ?? 'Saved'}</strong>
                  <span>
                    {version.author_name ?? 'Unknown'} ·{' '}
                    <time dateTime={version.created_at}>{formatDateTime(version.created_at)}</time>
                  </span>
                </div>
                {version.version !== currentVersion ? (
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={restore.pending}
                    onClick={() => void restore.mutate(version.version)}
                  >
                    Restore
                  </button>
                ) : (
                  <span className="status-tag status-active">Current</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>
    </div>
  );
}

function PageEditor({ page, onDone }: { page: Page; onDone: () => void }) {
  const [title, setTitle] = useState(page.title);
  const [body, setBody] = useState(page.body);
  const [changeNote, setChangeNote] = useState('');

  const save = useMutation(
    async (publish: boolean) =>
      api.patch<Page>(
        `/docs/pages/${page.id}`,
        { title, body, changeNote: changeNote || null, publish },
        { ifMatch: page.version },
      ),
    {
      invalidates: ['/docs/pages', '/docs/spaces'],
      onSuccess: onDone,
    },
  );

  // A version conflict is the one error worth explaining rather than just reporting:
  // the person has unsaved prose and needs to know it is still in the box.
  const conflicted = save.error instanceof ApiError && save.error.status === 412;

  return (
    <div className="doc-editor">
      <div className="panel-header">
        <div><h3>Editing {page.title}</h3></div>
        <div className="header-controls">
          <button type="button" className="ghost-button" onClick={onDone}>Cancel</button>
          <button
            type="button"
            className="ghost-button"
            disabled={save.pending}
            onClick={() => void save.mutate(false)}
          >
            Save as draft
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={save.pending}
            onClick={() => void save.mutate(true)}
          >
            {save.pending ? 'Saving…' : 'Publish'}
          </button>
        </div>
      </div>

      {conflicted ? (
        <div className="degraded-notice" role="alert">
          <div>
            <strong>Someone else saved this page</strong>
            <p>
              Your changes are still in the box below. Copy anything you need, reload to
              see theirs, and reapply — nothing has been overwritten.
            </p>
          </div>
        </div>
      ) : (
        <FormError error={save.error} />
      )}

      <div className="field">
        <label htmlFor="doc-title">Title</label>
        <input id="doc-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>

      <div className="field">
        <span id="doc-body-label" className="label-row">Content</span>
        <RichText value={body} onChange={setBody} ariaLabelledBy="doc-body-label" />
        <p className="field-hint">
          Write directly, or switch to HTML to edit the markup. Headings, lists, links,
          quotes, tables and code are kept; anything else is stripped when it is saved.
        </p>
      </div>

      <Attachments pageId={page.id} />

      <div className="field">
        <label htmlFor="doc-note">What changed? (optional)</label>
        <input
          id="doc-note"
          value={changeNote}
          onChange={(e) => setChangeNote(e.target.value)}
          placeholder="Added the rollback steps"
        />
        <p className="field-hint">Shown in the history, so the next reader knows why.</p>
      </div>
    </div>
  );
}

function SpaceDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'company' | 'restricted'>('company');

  const create = useMutation(
    async () =>
      api.post<Space>('/docs/spaces', { name, description: description || null, visibility }),
    { invalidates: ['/docs/spaces'], onSuccess: (space) => onCreated(space.id) },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="space-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="space-title">New space</h3>
        <FormError error={create.error} />
        <form onSubmit={(e) => { e.preventDefault(); void create.mutate(); }}>
          <div className="field">
            <label htmlFor="space-name">Name</label>
            <input id="space-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="space-description">What lives here?</label>
            <input id="space-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Engineering runbooks and standards" />
          </div>
          <div className="field">
            <label htmlFor="space-visibility">Who can read it</label>
            <select id="space-visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as 'company' | 'restricted')}>
              <option value="company">Everyone in the company</option>
              <option value="restricted">Only people I grant access to</option>
            </select>
            <p className="field-hint">
              Most spaces should be company-wide — a handbook nobody can read is not one.
            </p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending || !name.trim()}>
              {create.pending ? 'Creating…' : 'Create space'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function PageDialog({ spaceId, onClose, onCreated }: { spaceId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState('');
  const create = useMutation(
    async (publish: boolean) =>
      api.post<Page>('/docs/pages', { spaceId, title, body: '<p></p>', publish }),
    { invalidates: ['/docs/spaces'], onSuccess: (page) => onCreated(page.id) },
  );

  return (
    <div className="dialog-scrim" role="presentation" onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="page-title" onClick={(e) => e.stopPropagation()}>
        <h3 id="page-title">New page</h3>
        <FormError error={create.error} />
        <form onSubmit={(e) => { e.preventDefault(); void create.mutate(false); }}>
          <div className="field">
            <label htmlFor="new-page-title">Title</label>
            <input id="new-page-title" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus placeholder="Deploying to production" />
          </div>
          <div className="dialog-actions">
            <button type="button" className="ghost-button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={create.pending || !title.trim()}>
              {create.pending ? 'Creating…' : 'Create and edit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
