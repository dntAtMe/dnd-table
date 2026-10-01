// Campaign wiki state shared by the whole UI. It lives outside React context so the pages can be
// looked up from anywhere, including knowledge base popups rendered outside the campaign page.
import { WIKI_CATEGORY_LABELS, type ClientMessage, type Member, type WikiPageView } from '@dnd/protocol';
import { linkGraph, type Compendium, type IndexEntry } from '@dnd/rules';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useKnowledge, useKnowledgeSource } from '../../lib/knowledge';

export type WikiPage = WikiPageView;
type Send = (msg: ClientMessage) => void;

export interface WikiState {
  campaignId: string | null;
  /** The pages this user may see (GMs: all of them, with secret notes). */
  pages: WikiPage[];
  isGm: boolean;
  userId?: string;
  members: Member[];
  send: Send | null;
}

/** A request to show a page in the Wiki view; `nonce` changes on every request. */
export interface WikiOpenRequest {
  pageId: string;
  edit: boolean;
  nonce: number;
}

const EMPTY: WikiState = { campaignId: null, pages: [], isGm: false, members: [], send: null };

let state: WikiState = EMPTY;
let byId = new Map<string, WikiPage>();
let openRequest: WikiOpenRequest | null = null;
let seen: Record<string, string> = {};
/** Title of a page we asked the server to create, to open once it arrives. */
let pending: { key: string; edit: boolean; until: number } | null = null;
let nonce = 0;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Same normalisation as the server's uniqueness check. */
export const pageNameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

const seenKey = (s: WikiState) => (s.campaignId && s.userId ? `dnd-wiki-seen:${s.campaignId}:${s.userId}` : null);

function loadSeen(s: WikiState): Record<string, string> {
  const key = seenKey(s);
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Replaces the wiki state. The campaign page does this through useWikiSync; exported for tests and other hosts. */
export function setWikiState(next: WikiState): void {
  const campaignChanged = next.campaignId !== state.campaignId || next.userId !== state.userId;
  state = next;
  byId = new Map(next.pages.map((p) => [p.id, p]));
  if (campaignChanged) {
    seen = loadSeen(next);
    openRequest = null;
    pending = null;
  }
  if (pending) {
    const key = pending.key;
    const found = next.pages.find((p) => pageNameKey(p.title) === key);
    if (found) {
      const edit = pending.edit;
      pending = null;
      openRequest = { pageId: found.id, edit, nonce: ++nonce };
    } else if (Date.now() > pending.until) {
      pending = null;
    }
  }
  notify();
}

// ---------- reading ----------

export function useWiki(): WikiState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** One page by id, or undefined when it doesn't exist or this user can't see it. */
export function useWikiPage(id: string | null | undefined): WikiPage | undefined {
  const get = () => (id ? byId.get(id) : undefined);
  return useSyncExternalStore(subscribe, get, get);
}

/** A page by title or alias, ignoring case. */
export function findPageByName(name: string, pages: readonly WikiPage[] = state.pages): WikiPage | undefined {
  const key = pageNameKey(name);
  return pages.find((p) => pageNameKey(p.title) === key || p.aliases.some((a) => pageNameKey(a) === key));
}

// ---------- the knowledge base ----------

/** "[[Gundren|our patron]] hired **you**" → "our patron hired you", for one-line summaries. */
function plainLine(body: string): string {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return '';
  const plain = line
    .replace(/\[\[([^\][|]+)\|([^\][]+)\]\]/g, '$2')
    .replace(/\[\[(?:[a-z-]+:)?([^\][]+)\]\]/g, '$1')
    .replace(/\*\*/g, '');
  return plain.length > 140 ? `${plain.slice(0, 139).trimEnd()}…` : plain;
}

/** How a page appears in the knowledge base: searchable by title, aliases and tags, and auto-linked. */
export function pageEntry(page: WikiPage): IndexEntry {
  return {
    kind: 'page',
    id: page.id,
    name: page.title,
    aliases: page.aliases,
    summary: [WIKI_CATEGORY_LABELS[page.category], plainLine(page.body)].filter(Boolean).join(' · '),
    keywords: [WIKI_CATEGORY_LABELS[page.category], ...page.tags].join(' '),
  };
}

/**
 * Called once by the campaign page: publishes the pages (and what's needed to edit them) to the
 * wiki components, and registers the visible pages in the knowledge base so they're searchable and
 * linked everywhere (handouts, chat, sheet notes, other pages).
 */
export function useWikiSync(input: WikiState): void {
  const { campaignId, pages, isGm, userId, members, send } = input;
  useEffect(() => {
    setWikiState({ campaignId, pages, isGm, userId, members, send });
  }, [campaignId, pages, isGm, userId, members, send]);
  useEffect(() => () => setWikiState(EMPTY), []);
  const entries = useMemo(() => (campaignId ? pages.map(pageEntry) : null), [campaignId, pages]);
  useKnowledgeSource('campaign-pages', entries);
}

// ---------- navigation ----------

/** Asks the Wiki view to show a page (and the campaign page to switch to it). */
export function openWikiPage(pageId: string, opts: { edit?: boolean } = {}): void {
  openRequest = { pageId, edit: Boolean(opts.edit), nonce: ++nonce };
  notify();
}

/** The latest request to show a page; react to changes of its `nonce`. */
export function useWikiOpenRequest(): WikiOpenRequest | null {
  return useSyncExternalStore(subscribe, () => openRequest, () => openRequest);
}

/** Opens the page with this title as soon as the server sends it (after creating it). */
export function awaitWikiPage(title: string, edit: boolean): void {
  pending = { key: pageNameKey(title), edit, until: Date.now() + 10_000 };
}

/**
 * GM only (null for everyone else): turns a broken [[Name]] link into a page. Creates a GM-only
 * page called Name and opens it in the editor, or just opens the page if one has that name.
 */
export function useCreatePageFromLink(): ((name: string) => void) | null {
  const { isGm, send } = useWiki();
  const create = useCallback(
    (name: string) => {
      const title = name.replace(/[[\]|]/g, '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!title || !send) return;
      const existing = findPageByName(title);
      if (existing) return openWikiPage(existing.id);
      awaitWikiPage(title, true);
      send({ type: 'wiki:create', title, category: 'other', body: '', audience: 'gm' });
    },
    [send],
  );
  return isGm && send ? create : null;
}

// ---------- backlinks ----------

let graphCache: { compendium: Compendium; pages: readonly WikiPage[]; graph: Map<string, { id: string }[]> } | null = null;

/** The visible pages that link to this one, by [[link]] or by naming its title or an alias. */
export function useWikiBacklinks(pageId: string): WikiPage[] {
  const { compendium } = useKnowledge();
  const { pages } = useWiki();
  return useMemo(() => {
    if (!graphCache || graphCache.compendium !== compendium || graphCache.pages !== pages) {
      const graph = linkGraph(
        compendium,
        pages.map((p) => ({ ref: { kind: 'page' as const, id: p.id }, body: p.body })),
      );
      graphCache = { compendium, pages, graph };
    }
    const refs = graphCache.graph.get(`page:${pageId}`) ?? [];
    return refs.map((r) => pages.find((p) => p.id === r.id)).filter((p): p is WikiPage => Boolean(p));
  }, [compendium, pages, pageId]);
}

// ---------- "new" markers (players) ----------

/** Players: pages shared since they last opened them, or changed since. Always false for the GM. */
export function isPageNew(page: WikiPage, s: WikiState = state): boolean {
  if (s.isGm) return false;
  const at = seen[page.id];
  return !at || at < page.updatedAt;
}

export function markWikiSeen(page: WikiPage): void {
  if (state.isGm || !isPageNew(page)) return;
  seen = { ...seen, [page.id]: page.updatedAt };
  // Forget pages that are gone so the record doesn't grow forever.
  for (const id of Object.keys(seen)) if (!byId.has(id)) delete seen[id];
  const key = seenKey(state);
  try {
    if (key) localStorage.setItem(key, JSON.stringify(seen));
  } catch {
    // Private mode or full storage: markers just won't persist.
  }
  // A fresh object so subscribers re-render.
  state = { ...state };
  notify();
}

/** How many pages are new to this player. */
export function useWikiUnreadCount(): number {
  const s = useWiki();
  return useMemo(() => s.pages.filter((p) => isPageNew(p, s)).length, [s]);
}
