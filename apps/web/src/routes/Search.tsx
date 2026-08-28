/**
 * Cross-module search (blueprint 11).
 *
 * The server applies access filters before returning anything, so this screen never
 * receives a result the reader is not entitled to see. Snippets arrive pre-escaped with
 * highlight markers already applied.
 */
import { useSearchParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useQuery } from '../lib/query';
import { AsyncSection, Empty } from '../components/States';
import { titleCase } from '../lib/format';

type Hit = {
  docType: string;
  resourceId: string;
  title: string;
  snippet: string;
  link: string | null;
  score: number;
};

type Results = { hits: Hit[]; facets: Record<string, number>; total: number };

export default function Search() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const type = params.get('types') ?? '';

  const key = query.length > 1 ? `/search?q=${encodeURIComponent(query)}${type ? `&types=${type}` : ''}` : null;
  const results = useQuery<Results>(key, (signal) => api.get(key!, signal));

  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Search</h2>
          <p>
            {query ? (
              <>Results for “{query}”</>
            ) : (
              'Search across mail, files, chat, tasks, meetings and people.'
            )}
          </p>
        </div>
      </header>

      {!query || query.length < 2 ? (
        <Empty
          title="Type at least two characters"
          description="Use the search box at the top of the page."
        />
      ) : (
        <AsyncSection query={results}>
          {(data) => (
            <>
              <div className="tab-row" role="group" aria-label="Filter by type">
                <button
                  type="button"
                  className={`tab ${type === '' ? 'tab-active' : ''}`}
                  onClick={() => setParams({ q: query })}
                >
                  All ({data.total})
                </button>
                {Object.entries(data.facets).map(([facet, count]) => (
                  <button
                    key={facet}
                    type="button"
                    className={`tab ${type === facet ? 'tab-active' : ''}`}
                    onClick={() => setParams({ q: query, types: facet })}
                  >
                    {titleCase(facet)} ({count})
                  </button>
                ))}
              </div>

              {data.hits.length === 0 ? (
                <Empty
                  title="No results you can access"
                  description="Try different words. Results you are not permitted to see are never shown."
                />
              ) : (
                <ul className="search-results">
                  {data.hits.map((hit) => (
                    <li key={`${hit.docType}-${hit.resourceId}`}>
                      <Link to={hit.link ?? '#'}>
                        <span className="search-type">{titleCase(hit.docType)}</span>
                        <strong>{hit.title}</strong>
                        {/* The server escaped this text and applied <mark> itself. */}
                        <span
                          className="search-snippet"
                          dangerouslySetInnerHTML={{ __html: hit.snippet }}
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </AsyncSection>
      )}
    </div>
  );
}
