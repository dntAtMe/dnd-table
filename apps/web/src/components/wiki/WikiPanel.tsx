import { WIKI_CATEGORIES, WIKI_CATEGORY_LABELS, type WikiCategory } from '@dnd/protocol';
import { normalize } from '@dnd/rules';
import { useEffect, useMemo, useState } from 'react';
import { WikiEditor } from './WikiEditor';
import { WikiPageView, audienceLabel } from './WikiPageView';
import { findPageByName, isPageNew, markWikiSeen, useWiki, useWikiOpenRequest, type WikiPage } from './wikiStore';
import './wiki.css';

/** Open requests already acted on, so a panel that mounts later doesn't replay an old one. */
let handledRequest = 0;

/**
 * The campaign wiki: pages grouped by category with a filter box, the page being read (links and
 * backlinks move between pages) and, for the GM, the editor. Reads everything from the wiki store,
 * so it can be dropped into any view.
 */
export function WikiPanel({ active = true }: { /** Whether it is on screen; pages only count as seen while it is. */ active?: boolean }) {
  const wiki = useWiki();
  const { pages, isGm, members } = wiki;
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<WikiCategory | null>(null);
  const request = useWikiOpenRequest();

  const current = selected ? pages.find((p) => p.id === selected) : undefined;

  const go = (pageId: string, edit = false) => {
    if (selected && selected !== pageId) setHistory((h) => [...h.slice(-30), selected]);
    setSelected(pageId);
    setCreating(null);
    setEditing(edit);
  };
  const back = () => {
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setSelected(prev ?? null);
    setEditing(false);
  };
  const close = () => {
    setSelected(null);
    setCreating(null);
    setEditing(false);
    setHistory([]);
  };

  useEffect(() => {
    if (!request || request.nonce <= handledRequest) return;
    handledRequest = request.nonce;
    go(request.pageId, request.edit && isGm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // A page that was deleted or unshared while open.
  useEffect(() => {
    if (selected && !current) {
      setSelected(null);
      setEditing(false);
    }
  }, [selected, current]);

  useEffect(() => {
    if (active && current) markWikiSeen(current);
  }, [active, current]);

  const haystacks = useMemo(
    () => new Map(pages.map((p) => [p.id, normalize([p.title, ...p.aliases, ...p.tags, WIKI_CATEGORY_LABELS[p.category], p.body].join(' '))])),
    [pages],
  );
  const tokens = normalize(query).split(' ').filter(Boolean);
  const filtered = pages.filter((p) => (!category || p.category === category) && tokens.every((t) => haystacks.get(p.id)!.includes(t)));
  const groups = WIKI_CATEGORIES.map((c) => [c, filtered.filter((p) => p.category === c)] as const).filter(([, list]) => list.length > 0);
  const present = WIKI_CATEGORIES.filter((c) => pages.some((p) => p.category === c));
  const exact = query.trim() ? findPageByName(query, pages) : undefined;
  const open = Boolean(current || creating !== null);

  return (
    <div className={`wiki${open ? ' wiki--open' : ''}`}>
      <div className="wiki__side">
        <div className="wiki__head">
          <h2>Wiki</h2>
          {isGm && (
            <button type="button" className="btn btn--sm btn--primary" onClick={() => setCreating('')}>
              New page
            </button>
          )}
        </div>
        {pages.length > 0 && (
          <input type="search" className="wiki__search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter pages, tags, text…" aria-label="Filter pages" />
        )}
        {present.length > 1 && (
          <div className="chips wiki__cats" role="group" aria-label="Category">
            <button type="button" className={`chip${category === null ? ' chip--on' : ''}`} aria-pressed={category === null} onClick={() => setCategory(null)}>
              All
            </button>
            {present.map((c) => (
              <button key={c} type="button" className={`chip${category === c ? ' chip--on' : ''}`} aria-pressed={category === c} onClick={() => setCategory(category === c ? null : c)}>
                {WIKI_CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        )}

        {pages.length === 0 ? (
          <p className="hint">
            {isGm
              ? 'Your campaign notes: NPCs, places, factions, lore and session recaps. Link them with [[Title]]; share each page with everyone, some players, or nobody.'
              : 'Nothing yet. Pages the GM shares with you (people, places, lore) will appear here.'}
          </p>
        ) : (
          <nav className="wiki__groups" aria-label="Pages">
            {groups.map(([c, list]) => (
              <section key={c} className="wiki__group">
                <h3 className="wiki__group-title">
                  {WIKI_CATEGORY_LABELS[c]} <span className="muted">{list.length}</span>
                </h3>
                <ul className="wiki__list">
                  {list.map((p) => (
                    <li key={p.id}>
                      <PageItem page={p} active={p.id === selected} isNew={isPageNew(p, wiki)} audience={isGm ? audienceLabel(p, members) : undefined} onOpen={() => go(p.id)} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {groups.length === 0 && <p className="hint">No pages match.</p>}
          </nav>
        )}
        {isGm && query.trim() && !exact && (
          <button type="button" className="btn btn--sm wiki__create-from-search" onClick={() => setCreating(query.trim())}>
            Create page "{query.trim()}"
          </button>
        )}
      </div>

      <div className="wiki__main">
        {creating !== null ? (
          <>
            <button type="button" className="btn btn--ghost btn--sm wiki__back" onClick={close}>
              ← All pages
            </button>
            <WikiEditor key={`new:${creating}`} initialTitle={creating} onClose={() => setCreating(null)} />
          </>
        ) : current ? (
          <>
            <div className="wiki__nav">
              <button type="button" className="btn btn--ghost btn--sm wiki__back" onClick={close}>
                ← All pages
              </button>
              {history.length > 0 && !editing && (
                <button type="button" className="btn btn--ghost btn--sm" onClick={back} title={`Back to ${pages.find((p) => p.id === history[history.length - 1])?.title ?? 'the previous page'}`}>
                  ← Back
                </button>
              )}
            </div>
            {editing && isGm ? (
              <WikiEditor key={current.id} page={current} onClose={() => setEditing(false)} />
            ) : (
              <WikiPageView
                key={current.id}
                page={current}
                onNavigate={(id) => go(id)}
                onEdit={isGm ? () => setEditing(true) : undefined}
                onTag={(t) => {
                  setQuery(t);
                  setCategory(null);
                }}
              />
            )}
          </>
        ) : (
          pages.length > 0 && <p className="hint wiki__placeholder">Choose a page to read it.</p>
        )}
      </div>
    </div>
  );
}

function PageItem({ page, active, isNew, audience, onOpen }: { page: WikiPage; active: boolean; isNew: boolean; audience?: string; onOpen: () => void }) {
  return (
    <button type="button" className={`wiki-item${active ? ' is-active' : ''}`} onClick={onOpen} aria-current={active ? 'page' : undefined}>
      {page.imageUrl ? <img src={page.imageUrl} alt="" className="wiki-item__thumb" /> : <span className={`wiki-item__thumb wiki-item__thumb--${page.category}`} aria-hidden="true" />}
      <span className="wiki-item__body">
        <span className="wiki-item__title">{page.title}</span>
        {(audience || page.aliases.length > 0) && (
          <span className="wiki-item__meta">
            {audience && <span className={`badge${page.audience === 'gm' ? ' badge--gm' : ''}`}>{audience}</span>}
            {page.aliases.length > 0 && <span className="wiki-item__aliases">{page.aliases.join(', ')}</span>}
          </span>
        )}
      </span>
      {isNew && <span className="wiki-item__new" aria-label="new or updated" title="New or updated" />}
    </button>
  );
}
