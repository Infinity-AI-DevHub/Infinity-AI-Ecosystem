/**
 * Command palette (Cmd/Ctrl+K).
 *
 * One keyboard-first entry point for going anywhere: modules the person can open, their
 * recent pages, shell actions, and live workspace search that deep-links straight to the
 * record. Search hits come from the same server-filtered endpoint as the Search page, so
 * nothing appears here that the person could not already open.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Clock3, CornerDownLeft, Mail, PanelLeft, Search as SearchIcon, Star } from 'lucide-react';
import { api } from '../lib/api';
import { useDebounced } from '../lib/useDebounced';
import { titleCase } from '../lib/format';
import type { NavArea } from '../lib/navigation';
import type { RecentEntry } from '../lib/nav-preferences';

type Hit = { docType: string; resourceId: string; title: string; link: string | null };

type Item = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
};

export function CommandPalette({
  open,
  onClose,
  areas,
  recents,
  favourites,
  canSearch,
  onToggleSidebar,
  onOpenMail,
}: {
  open: boolean;
  onClose: () => void;
  areas: NavArea[];
  recents: RecentEntry[];
  favourites: string[];
  canSearch: boolean;
  onToggleSidebar: () => void;
  /** Present only in the desktop client, where Mail can be launched. */
  onOpenMail?: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const debounced = useDebounced(query.trim(), 220);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    setHits([]);
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => returnFocus.current?.focus?.();
  }, [open]);

  useEffect(() => {
    if (!open || !canSearch || debounced.length < 2) {
      setHits([]);
      setSearchFailed(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    api.get<{ hits: Hit[] }>(`/search?q=${encodeURIComponent(debounced)}`, controller.signal)
      .then((result) => { setHits(result.hits.filter((h) => h.link).slice(0, 6)); setSearchFailed(false); })
      .catch((err) => { if (!controller.signal.aborted) { setHits([]); setSearchFailed(true); void err; } })
      .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    return () => controller.abort();
  }, [open, canSearch, debounced]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => { onClose(); navigate(to); };
    const q = query.trim().toLowerCase();
    const matches = (text: string) => !q || text.toLowerCase().includes(q);
    const out: Item[] = [];

    if (!q) {
      for (const recent of recents.slice(0, 5)) {
        out.push({ id: `recent:${recent.path}`, group: 'Recent', label: recent.label, hint: recent.path,
          icon: <Clock3 size={15} />, run: go(recent.path) });
      }
    }

    const favSet = new Set(favourites);
    const modules = areas.flatMap((area) => area.modules.map((m) => ({ area, m })));
    modules.sort((a, b) => Number(favSet.has(b.m.to)) - Number(favSet.has(a.m.to)));
    for (const { area, m } of modules) {
      if (!matches(`${m.label} ${area.label} ${m.keywords ?? ''}`)) continue;
      out.push({ id: `module:${m.to}`, group: 'Go to', label: m.label, hint: area.label,
        icon: favSet.has(m.to) ? <Star size={15} /> : <m.icon size={15} />, run: go(m.to) });
    }

    if (matches('toggle collapse expand sidebar navigation')) {
      out.push({ id: 'action:sidebar', group: 'Actions', label: 'Toggle sidebar', hint: 'Ctrl/Cmd+\\',
        icon: <PanelLeft size={15} />, run: () => { onClose(); onToggleSidebar(); } });
    }

    if (onOpenMail && matches('infinity mail email inbox open')) {
      out.push({ id: 'action:mail', group: 'Actions', label: 'Open Infinity Mail', hint: 'Separate app',
        icon: <Mail size={15} />, run: () => { onClose(); onOpenMail(); } });
    }

    for (const hit of hits) {
      out.push({ id: `hit:${hit.docType}:${hit.resourceId}`, group: 'Workspace results', label: hit.title,
        hint: titleCase(hit.docType), icon: <ArrowRight size={15} />, run: go(hit.link!) });
    }

    if (canSearch && q.length > 1) {
      out.push({ id: 'action:search', group: 'Workspace results', label: `Search everything for “${query.trim()}”`,
        icon: <SearchIcon size={15} />, run: go(`/search?q=${encodeURIComponent(query.trim())}`) });
    }
    return out;
  }, [areas, recents, favourites, hits, query, canSearch, navigate, onClose, onToggleSidebar, onOpenMail]);

  useEffect(() => { setActive((i) => Math.min(i, Math.max(items.length - 1, 0))); }, [items.length]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((i) => (i + 1) % Math.max(items.length, 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((i) => (i - 1 + items.length) % Math.max(items.length, 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); items[active]?.run(); }
    else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'Tab') { event.preventDefault(); inputRef.current?.focus(); }
  };

  let lastGroup = '';
  return (
    <div className="palette-scrim" role="presentation" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="palette-input">
          <SearchIcon size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            placeholder={canSearch ? 'Go to a module, or search the workspace…' : 'Go to a module…'}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${active}` : undefined}
            aria-autocomplete="list"
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 ? (
            <li className="palette-empty" role="presentation">
              {searching ? 'Searching…' : searchFailed ? 'Search is unavailable right now.' : 'Nothing matches.'}
            </li>
          ) : items.map((item, index) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <li key={item.id} role="presentation">
                {header ? <div className="palette-group" role="presentation">{header}</div> : null}
                <div
                  id={`palette-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={index === active}
                  className={`palette-item ${index === active ? 'palette-item-active' : ''}`}
                  onMouseMove={() => setActive(index)}
                  onClick={item.run}
                >
                  <span className="palette-icon" aria-hidden="true">{item.icon}</span>
                  <span className="palette-label">{item.label}</span>
                  {item.hint ? <span className="palette-hint">{item.hint}</span> : null}
                  {index === active ? <CornerDownLeft size={13} className="palette-enter" aria-hidden="true" /> : null}
                </div>
              </li>
            );
          })}
          {searching && items.length > 0 ? <li className="palette-status" role="presentation">Searching…</li> : null}
        </ul>
      </div>
    </div>
  );
}
