/**
 * Knowledge base: browse, read, write.
 *
 * One component serves the workspace (/service/knowledge) and the client portal
 * (/portal/knowledge). The server decides what each reader may see - drafts only for
 * writers, internal articles never for clients - and returns `canWrite`, which is the only
 * thing that makes editing controls appear.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, Plus, Search as SearchIcon, ThumbsDown, ThumbsUp } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { invalidate, useQuery } from '../../lib/query';
import { useDebounced } from '../../lib/useDebounced';
import { relativeTime } from '../../lib/format';
import { Empty, ErrorState, Loading } from '../../components/States';
import { RichText } from '../../components/RichText';
import type { Queue } from '../../lib/service';
import '../../styles/command.css';
import '../../styles/service.css';

export type ArticleSummary = {
  id: string; title: string; summary: string; audience: 'internal' | 'public'; status: 'draft' | 'published' | 'archived';
  queueId: string | null; categoryId: string | null; queueName: string | null; categoryName: string | null;
  authorName: string | null; publishedAt: string | null; updatedAt: string; helpful: number; unhelpful: number; views: number; version: number;
};
type Article = ArticleSummary & { body: string; editorName: string | null; myVote: boolean | null; canEdit: boolean };

const STATUS_TEXT = { draft: 'Draft', published: 'Published', archived: 'Archived' } as const;

export default function KnowledgeList({ portal = false }: { portal?: boolean }) {
  const base = portal ? '/portal/knowledge' : '/service/knowledge';
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const q = useDebounced(search.trim(), 250);
  const key = portal
    ? `/portal/knowledge${q ? `?q=${encodeURIComponent(q)}` : ''}`
    : `/service/knowledge?limit=100${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}`;
  const list = useQuery<{ canWrite: boolean; items: ArticleSummary[] }>(key, (signal) => api.get(key, signal));

  const header = (
    <>
      {portal ? (
        <header className="portal-head portal-head-row">
          <div><h1>Help articles</h1><p>Answers to common questions, before you raise a request.</p></div>
        </header>
      ) : (
        <header className="cc-header">
          <div><p className="cc-eyebrow">Service</p><h2>Knowledge base</h2></div>
          <div className="cc-header-side">
            {list.data?.canWrite ? <Link to="/service/knowledge/new" className="primary-button"><Plus size={15} aria-hidden="true" /> New article</Link> : null}
          </div>
        </header>
      )}
      <div className="sd-toolbar">
        <label className="sd-search sd-search-wide">
          <SearchIcon size={14} aria-hidden="true" />
          <span className="visually-hidden">Search articles</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search articles" />
        </label>
        {!portal && list.data?.canWrite ? (
          <div className="sd-filters">
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Drafts and published</option>
              <option value="published">Published</option>
              <option value="draft">Drafts</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        ) : null}
      </div>
    </>
  );

  return (
    <div className={portal ? '' : 'module-page cc-page'}>
      {header}
      {list.loading && !list.data ? <Loading label="Loading articles" rows={5} />
        : list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} />
        : list.data!.items.length === 0 ? (
          <Empty icon={<BookOpen size={22} />} title={q ? 'No articles match' : 'No articles yet'}
            description={q ? 'Try different words.' : list.data!.canWrite ? 'Write down the answer to the question you are asked most often.' : 'Articles will appear here as the team writes them.'} />
        ) : (
          <ul className="cc-panel cc-rows kb-list">
            {list.data!.items.map((a) => (
              <li key={a.id}>
                <Link to={`${base}/${a.id}`} className="cc-row">
                  <span className="cc-row-main">
                    <strong>{a.title}</strong>
                    <span>{a.summary}</span>
                  </span>
                  {!portal ? (
                    <span className="kb-meta">
                      {a.status !== 'published' ? <span className="cc-tag">{STATUS_TEXT[a.status]}</span> : null}
                      <span className={`cc-tag ${a.audience === 'public' ? 'cc-tag-info' : ''}`}>{a.audience === 'public' ? 'Clients too' : 'Internal'}</span>
                      <span className="cc-meta">{relativeTime(a.updatedAt)}</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

export function KnowledgeArticle({ portal = false }: { portal?: boolean }) {
  const { articleId } = useParams();
  const base = portal ? '/portal/knowledge' : '/service/knowledge';
  const key = `${base}/${articleId}`;
  const article = useQuery<Article>(articleId ? key : null, (signal) => api.get(key, signal));
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  if (article.loading && !article.data) return <Loading label="Loading article" rows={6} />;
  if (article.error && !article.data) {
    return article.error instanceof ApiError && article.error.status === 404
      ? <Empty title="Article not found" description="It may be unpublished or not available to you." action={<Link className="ghost-button" to={base}>All articles</Link>} />
      : <ErrorState error={article.error} onRetry={article.reload} />;
  }
  const a = article.data!;
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError(err instanceof ApiError ? err.message : 'That did not go through.'); }
    invalidate(key); invalidate(`${base}?`); invalidate('/service/knowledge?');
  };
  const voteVia = (helpful: boolean) => act(() => portal
    ? api.post(`/portal/knowledge/${a.id}/vote`, { helpful })
    : api.post(`/service/knowledge/${a.id}/vote`, { helpful }));

  return (
    <div className={portal ? 'kb-article-page' : 'module-page cc-page kb-article-page'}>
      <Link to={base} className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> {portal ? 'Help articles' : 'Knowledge base'}</Link>
      <header className="sd-detail-head">
        <div>
          {!portal ? (
            <p className="cc-eyebrow">
              {a.audience === 'public' ? 'Visible to clients' : 'Internal'} · {STATUS_TEXT[a.status]}
              {a.queueName ? ` · ${a.queueName}` : ''}{a.categoryName ? ` · ${a.categoryName}` : ''}
            </p>
          ) : null}
          <h2>{a.title}</h2>
          <p className="field-hint">Updated {relativeTime(a.updatedAt)}{a.authorName ? ` · by ${a.editorName ?? a.authorName}` : ''}</p>
        </div>
        {a.canEdit && !portal ? (
          <div className="cc-header-side">
            <Link className="ghost-button" to={`/service/knowledge/${a.id}/edit`}>Edit</Link>
            {a.status !== 'published' ? <button type="button" className="primary-button" onClick={() => void act(() => api.post(`/service/knowledge/${a.id}/status`, { status: 'published' }))}>Publish</button> : null}
            {a.status === 'published' ? <button type="button" className="ghost-button" onClick={() => void act(() => api.post(`/service/knowledge/${a.id}/status`, { status: 'draft' }))}>Unpublish</button> : null}
            {a.status !== 'archived' ? <button type="button" className="ghost-button" onClick={() => void act(() => api.post(`/service/knowledge/${a.id}/status`, { status: 'archived' }))}>Archive</button> : null}
            {a.status !== 'published' ? <button type="button" className="ghost-button" onClick={() => { if (window.confirm(`Delete "${a.title}"? This cannot be undone.`)) void act(async () => { await api.delete(`/service/knowledge/${a.id}`); navigate('/service/knowledge'); }); }}>Delete</button> : null}
          </div>
        ) : null}
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <article className="cc-panel kb-body">
        {/* Stored sanitized by the server against the document allow-list. */}
        <div className="doc-body" dangerouslySetInnerHTML={{ __html: a.body }} />
      </article>
      {a.status === 'published' ? (
        <section className="kb-feedback" aria-label="Was this helpful?">
          <span>Was this helpful?</span>
          <button type="button" className={`ghost-button ${a.myVote === true ? 'is-on' : ''}`} aria-pressed={a.myVote === true} onClick={() => void voteVia(true)}>
            <ThumbsUp size={14} aria-hidden="true" /> Yes{!portal ? ` · ${a.helpful}` : ''}
          </button>
          <button type="button" className={`ghost-button ${a.myVote === false ? 'is-on' : ''}`} aria-pressed={a.myVote === false} onClick={() => void voteVia(false)}>
            <ThumbsDown size={14} aria-hidden="true" /> No{!portal ? ` · ${a.unhelpful}` : ''}
          </button>
          {!portal ? <span className="cc-meta">{a.views} views</span> : null}
        </section>
      ) : null}
    </div>
  );
}

export function KnowledgeEditor() {
  const { articleId } = useParams();
  const navigate = useNavigate();
  const editing = Boolean(articleId);
  const existing = useQuery<Article>(editing ? `/service/knowledge/${articleId}` : null, (signal) => api.get(`/service/knowledge/${articleId}`, signal));
  const queues = useQuery<{ items: Queue[] }>('/service/queues', (signal) => api.get('/service/queues', signal));
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState<'internal' | 'public'>('internal');
  const [queueId, setQueueId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [ready, setReady] = useState(!editing);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (existing.data && !ready) {
      setTitle(existing.data.title); setSummary(existing.data.summary ?? ''); setBody(existing.data.body);
      setAudience(existing.data.audience); setQueueId(existing.data.queueId ?? ''); setCategoryId(existing.data.categoryId ?? '');
      setReady(true);
    }
  }, [existing.data, ready]);

  if (editing && !ready) return existing.error ? <ErrorState error={existing.error} onRetry={existing.reload} /> : <Loading label="Loading article" rows={6} />;
  const queue = queues.data?.items.find((q) => q.id === queueId);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true); setError(null);
    const input = { title, summary: summary || null, body, audience, queueId: queueId || null, categoryId: categoryId || null };
    try {
      const saved = editing
        ? await api.patch<Article>(`/service/knowledge/${articleId}`, input, { ifMatch: existing.data!.version })
        : await api.post<Article>('/service/knowledge', input);
      invalidate('/service/knowledge');
      navigate(`/service/knowledge/${saved.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The article was not saved.');
      setPending(false);
    }
  };

  return (
    <form className="module-page cc-page" onSubmit={save}>
      <Link to={editing ? `/service/knowledge/${articleId}` : '/service/knowledge'} className="sd-back"><ArrowLeft size={14} aria-hidden="true" /> {editing ? 'Back to article' : 'Knowledge base'}</Link>
      <header className="cc-header">
        <div><p className="cc-eyebrow">Knowledge base</p><h2>{editing ? 'Edit article' : 'New article'}</h2></div>
        <div className="cc-header-side">
          <button type="submit" className="primary-button" disabled={pending || title.trim().length < 3}>{pending ? 'Saving…' : editing ? 'Save changes' : 'Save draft'}</button>
        </div>
      </header>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <section className="cc-panel sd-panel-pad sd-editor">
        <div className="sd-form-grid">
          <label className="field sd-span-2"><span>Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required placeholder="How to reset your VPN password" /></label>
          <label className="field sd-span-2"><span>Summary</span><input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={500} placeholder="One sentence shown in search results" /></label>
          <label className="field"><span>Who can read it</span>
            <select value={audience} onChange={(e) => setAudience(e.target.value as 'internal' | 'public')}>
              <option value="internal">Employees only</option>
              <option value="public">Employees and clients</option>
            </select>
          </label>
          <label className="field"><span>Queue</span>
            <select value={queueId} onChange={(e) => { setQueueId(e.target.value); setCategoryId(''); }}>
              <option value="">Any</option>
              {queues.data?.items.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          </label>
          {queue && queue.categories.length ? (
            <label className="field"><span>Category</span>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Any</option>
                {queue.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          ) : null}
        </div>
        <div className="field">
          <span id="kb-body-label">Article</span>
          <RichText value={body} onChange={setBody} ariaLabelledBy="kb-body-label" />
        </div>
      </section>
    </form>
  );
}
