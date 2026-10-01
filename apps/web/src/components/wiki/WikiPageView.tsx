import { WIKI_CATEGORY_LABELS, type Member } from '@dnd/protocol';
import { parseRefKey, type EntryRef } from '@dnd/rules';
import { useMemo, useRef, useState, type MouseEvent } from 'react';
import { useLinkedText } from '../../lib/knowledge';
import { RichText } from '../knowledge/RichText';
import { openWikiPage, useCreatePageFromLink, useWiki, useWikiBacklinks, type WikiPage } from './wikiStore';
import './wiki.css';

export interface WikiPageViewProps {
  page: WikiPage;
  /** Popup size: smaller header and image, no backlinks or footer. */
  compact?: boolean;
  /**
   * Plain clicks on links to other pages go here (e.g. the Wiki view moving to that page) instead
   * of the knowledge base handlers. Ctrl/Cmd/Shift-clicks always go to the knowledge base.
   */
  onNavigate?: (pageId: string) => void;
  /** GM: shows an Edit button. */
  onEdit?: () => void;
  /** Clicking a tag (e.g. to filter the page list by it). */
  onTag?: (tag: string) => void;
}

export function audienceLabel(page: WikiPage, members: Member[]): string {
  if (page.audience === 'all') return 'Everyone';
  if (page.audience === 'players') {
    const names = members.filter((m) => page.userIds?.includes(m.userId)).map((m) => m.name);
    return names.length ? names.join(', ') : 'Nobody yet';
  }
  return 'GM only';
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
}

/**
 * A campaign wiki page: title, category, tags, image, linked body, backlinks and, for the GM, the
 * audience and secret notes. Works on its own, so it can also be a knowledge base popup.
 */
export function WikiPageView({ page, compact = false, onNavigate, onEdit, onTag }: WikiPageViewProps) {
  const { isGm, members } = useWiki();
  const self = useMemo<EntryRef>(() => ({ kind: 'page', id: page.id }), [page.id]);
  const go = onNavigate ?? ((id: string) => openWikiPage(id));

  return (
    <article className={`wiki-page${compact ? ' wiki-page--compact' : ''}`}>
      <header className="wiki-page__head">
        <div className="wiki-page__kicker">
          <span className={`badge wiki-cat wiki-cat--${page.category}`}>{WIKI_CATEGORY_LABELS[page.category]}</span>
          {isGm && page.audience && (
            <span className={`badge${page.audience === 'gm' ? ' badge--gm' : ''}`} title="Who can see this page">
              {audienceLabel(page, members)}
            </span>
          )}
          {isGm && onEdit && (
            <button type="button" className="btn btn--sm wiki-page__edit" onClick={onEdit}>
              Edit
            </button>
          )}
        </div>
        <h2 className="wiki-page__title">{page.title}</h2>
        {page.aliases.length > 0 && <p className="wiki-page__aliases">Also known as {page.aliases.join(', ')}</p>}
        {page.tags.length > 0 && (
          <ul className="wiki-tags" aria-label="Tags">
            {page.tags.map((t) => (
              <li key={t}>
                {onTag ? (
                  <button type="button" className="wiki-tag" onClick={() => onTag(t)}>
                    #{t}
                  </button>
                ) : (
                  <span className="wiki-tag">#{t}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </header>

      {page.imageUrl && (
        <a href={page.imageUrl} target="_blank" rel="noreferrer" className="wiki-page__image-link">
          <img src={page.imageUrl} alt={page.title} className="wiki-page__image" />
        </a>
      )}

      {page.body.trim() ? (
        <WikiBody text={page.body} self={self} onNavigate={onNavigate} />
      ) : (
        <p className="hint">{isGm ? 'Nothing written yet.' : 'Nothing here yet.'}</p>
      )}

      {isGm && page.secret?.trim() && (
        <section className="wiki-secret" aria-label="Secret notes">
          <h3 className="wiki-secret__title">
            Secret notes <span className="badge badge--gm">Only you</span>
          </h3>
          <WikiBody text={page.secret} self={self} onNavigate={onNavigate} />
        </section>
      )}

      {!compact && <Backlinks pageId={page.id} onNavigate={go} />}

      {!compact && (
        <footer className="wiki-page__meta">
          Updated {formatWhen(page.updatedAt)}
          {page.authorName && ` · by ${page.authorName}`}
        </footer>
      )}
    </article>
  );
}

/**
 * Page text with knowledge base links (RichText), plus wiki behaviour layered on top: with
 * `onNavigate`, plain clicks on page links navigate (otherwise links behave as anywhere else), and
 * the GM can click a broken [[link]] to create that page.
 */
function WikiBody({ text, self, onNavigate }: { text: string; self: EntryRef; onNavigate?: (pageId: string) => void }) {
  const segments = useLinkedText(text, self);
  const broken = useMemo(() => segments.filter((s) => s.broken).map((s) => s.target ?? s.text), [segments]);
  const create = useCreatePageFromLink();
  const [prompt, setPrompt] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const onClickCapture = (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const link = el.closest<HTMLElement>('[data-entry]');
    if (link && onNavigate && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const ref = parseRefKey(link.dataset.entry ?? '');
      if (ref?.kind === 'page') {
        e.preventDefault();
        e.stopPropagation();
        onNavigate(ref.id);
        return;
      }
    }
    const missing = el.closest('.entity-link--broken');
    if (missing && create && box.current) {
      // RichText renders segments in order, so the nth broken link is the nth broken segment.
      const index = [...box.current.querySelectorAll('.entity-link--broken')].indexOf(missing);
      const name = broken[index];
      if (name) setPrompt(name);
    }
  };

  const unique = useMemo(() => [...new Map(broken.map((n) => [n.toLowerCase(), n])).values()], [broken]);

  return (
    <div ref={box} className={`wiki-body${create ? ' wiki-body--gm' : ''}`} onClickCapture={onClickCapture}>
      <RichText text={text} self={self} className="wiki-text" />
      {create && prompt && (
        <div className="wiki-create-prompt" role="dialog" aria-label="Create page">
          <span>No page called "{prompt}" yet.</span>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => {
              create(prompt);
              setPrompt(null);
            }}
          >
            Create page
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPrompt(null)}>
            Cancel
          </button>
        </div>
      )}
      {create && unique.length > 0 && (
        <p className="wiki-missing">
          <span className="hint">Links to missing pages:</span>
          {unique.map((name) => (
            <button key={name} type="button" className="wiki-missing__add" onClick={() => create(name)} title={`Create a page called "${name}"`}>
              + {name}
            </button>
          ))}
        </p>
      )}
    </div>
  );
}

function Backlinks({ pageId, onNavigate }: { pageId: string; onNavigate: (pageId: string) => void }) {
  const links = useWikiBacklinks(pageId);
  if (links.length === 0) return null;
  return (
    <section className="wiki-backlinks" aria-label="Linked from">
      <h3 className="wiki-backlinks__title">Linked from</h3>
      <ul>
        {links.map((p) => (
          <li key={p.id}>
            <button type="button" className="wiki-backlinks__link" onClick={() => onNavigate(p.id)}>
              {p.title}
            </button>
            <span className="wiki-backlinks__cat">{WIKI_CATEGORY_LABELS[p.category]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
