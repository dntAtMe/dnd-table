import { ENTRY_KINDS, KIND_LABELS, SRD_ATTRIBUTION, refKey, type EntryKind, type IndexEntry } from '@dnd/rules';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useKnowledge } from '../../lib/knowledge';
import { EntryCard } from './EntryCard';
import type { EntryHistoryApi } from './history';
import { KindBadge, KIND_SHORT } from './KindBadge';
import './compendium.css';

/** Rows rendered at once; refine the search (or a kind) to see the rest. */
const MAX_ROWS = 200;
const DEBOUNCE_MS = 120;

/**
 * The searchable knowledge base: every SRD entry (and campaign pages) with kind filters on the left
 * and the selected entry, with back/forward history, on the right. On phones one side at a time.
 */
export function CompendiumView({ history }: { history: EntryHistoryApi }) {
  const { compendium, loading } = useKnowledge();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kinds, setKinds] = useState<ReadonlySet<EntryKind>>(new Set());
  const [showList, setShowList] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);
  const current = history.current;
  const currentKey = current ? refKey(current) : null;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // A new selection (from the list, a link or a deep link) shows the entry on phones.
  useEffect(() => {
    if (currentKey) setShowList(false);
  }, [currentKey]);

  const byName = useMemo(() => [...compendium.entries].sort((a, b) => a.name.localeCompare(b.name)), [compendium]);
  const matches = useMemo(() => (debounced.trim() ? compendium.search(debounced, { limit: 10_000 }) : byName), [compendium, debounced, byName]);
  const counts = useMemo(() => {
    const out = new Map<EntryKind, number>();
    for (const e of matches) out.set(e.kind, (out.get(e.kind) ?? 0) + 1);
    return out;
  }, [matches]);
  const results = useMemo(() => (kinds.size ? matches.filter((e) => kinds.has(e.kind)) : matches), [matches, kinds]);

  const toggleKind = (kind: EntryKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const select = (e: IndexEntry) => history.go({ kind: e.kind, id: e.id });

  // ↑/↓ in the search box walk the results; Enter picks the first (or the highlighted) one.
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (!results.length) return;
    const i = results.findIndex((r) => refKey(r) === currentKey);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(results.length - 1, i + 1) : Math.max(0, i - 1);
      select(results[next]!);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      select(results[i >= 0 ? i : 0]!);
    }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector('.is-active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [currentKey]);

  const shownKinds = ENTRY_KINDS.filter((k) => counts.get(k) || kinds.has(k));

  return (
    <div className={`compendium${showList || !current ? ' compendium--list' : ''}`}>
      <aside className="compendium__side">
        <input
          type="search"
          className="compendium__search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder="Search spells, monsters, rules, items…"
          aria-label="Search the compendium"
        />
        <div className="compendium__kinds" role="group" aria-label="Filter by kind">
          <button type="button" className={`chip${kinds.size === 0 ? ' chip--on' : ''}`} onClick={() => setKinds(new Set())} aria-pressed={kinds.size === 0}>
            All <span className="compendium__count">{matches.length}</span>
          </button>
          {shownKinds.map((k) => (
            <button key={k} type="button" className={`chip${kinds.has(k) ? ' chip--on' : ''}`} onClick={() => toggleKind(k)} aria-pressed={kinds.has(k)} title={KIND_LABELS[k]}>
              {KIND_SHORT[k]} <span className="compendium__count">{counts.get(k) ?? 0}</span>
            </button>
          ))}
        </div>
        {loading && <p className="hint compendium__loading">Loading spells, monsters and magic items…</p>}
        <ul className="compendium__results" ref={listRef}>
          {results.slice(0, MAX_ROWS).map((e) => {
            const key = refKey(e);
            return (
              <li key={key}>
                <button type="button" className={`compendium__result${key === currentKey ? ' is-active' : ''}`} onClick={() => select(e)} aria-current={key === currentKey || undefined}>
                  <span className="compendium__result-top">
                    <span className="compendium__result-name">{e.name}</span>
                    <KindBadge kind={e.kind} />
                  </span>
                  <span className="compendium__result-summary">{e.summary}</span>
                </button>
              </li>
            );
          })}
          {results.length === 0 && <li className="hint compendium__empty">Nothing matches “{debounced}”.</li>}
        </ul>
        {results.length > MAX_ROWS && <p className="hint compendium__more">{results.length - MAX_ROWS} more: refine the search or pick a kind.</p>}
      </aside>

      <section className="compendium__detail" aria-live="polite">
        {current ? (
          <EntryCard
            key={currentKey}
            entryRef={current}
            size="full"
            actions={
              <>
                <button type="button" className="kb-icon-btn compendium__to-list" onClick={() => setShowList(true)} aria-label="Back to results" title="Results">
                  ☰
                </button>
                <button type="button" className="kb-icon-btn" onClick={history.back} disabled={!history.canBack} aria-label="Back" title="Back">
                  ‹
                </button>
                <button type="button" className="kb-icon-btn" onClick={history.forward} disabled={!history.canForward} aria-label="Forward" title="Forward">
                  ›
                </button>
              </>
            }
          />
        ) : (
          <div className="compendium__intro">
            <h3>Compendium</h3>
            <p>Everything in the SRD 5.2 (spells, monsters, magic items, classes, species, feats, equipment and rules) and your campaign's pages, in one place.</p>
            <ul>
              <li>Rest the pointer on any underlined name in the app to preview it; click to pin the popup.</li>
              <li>Links inside a popup open more popups beside it. Escape closes the top one.</li>
              <li>
                Press <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd> anywhere to search; Shift-click a link to open it here.
              </li>
            </ul>
          </div>
        )}
        <p className="compendium__license">{SRD_ATTRIBUTION}</p>
      </section>
    </div>
  );
}
