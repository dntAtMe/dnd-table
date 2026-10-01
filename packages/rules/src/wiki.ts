// Pure helpers for campaign wiki pages: which pages link to which (backlinks) and the `[[`
// autocomplete used while writing a page.
import { refKey, type Compendium, type EntryRef, type IndexEntry } from './compendium';

export interface LinkSource {
  /** The page (or other text) the body belongs to; it never counts as linking to itself. */
  ref: EntryRef;
  body: string;
}

/**
 * Every link in a set of texts, inverted: refKey of the target → the sources that mention it, via an
 * explicit [[link]] or a name the linker finds on its own (title or alias), in source order.
 * Uses the same linker the UI renders with, so a backlink is exactly a link the reader can click.
 */
export function linkGraph(compendium: Compendium, sources: readonly LinkSource[]): Map<string, EntryRef[]> {
  const graph = new Map<string, EntryRef[]>();
  for (const source of sources) {
    const self = refKey(source.ref);
    const seen = new Set<string>([self]);
    for (const seg of compendium.linkify(source.body, { self: source.ref })) {
      if (!seg.ref) continue;
      const key = refKey(seg.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      const list = graph.get(key);
      if (list) list.push(source.ref);
      else graph.set(key, [source.ref]);
    }
  }
  return graph;
}

/** The sources linking to `target`. */
export function backlinks(compendium: Compendium, target: EntryRef, sources: readonly LinkSource[]): EntryRef[] {
  return linkGraph(compendium, sources).get(refKey(target)) ?? [];
}

/** Targets of broken explicit links in a text ([[Somebody]] with no entry of that name), deduplicated ignoring case. */
export function brokenLinks(compendium: Compendium, text: string): string[] {
  const out = new Map<string, string>();
  for (const seg of compendium.linkify(text)) {
    const target = seg.broken ? (seg.target ?? seg.text) : undefined;
    if (target && !out.has(target.toLowerCase())) out.set(target.toLowerCase(), target);
  }
  return [...out.values()];
}

// ---------- [[ autocomplete ----------

export interface LinkQuery {
  /** Index of the opening `[[`. */
  start: number;
  /** What has been typed after it, up to the caret. */
  query: string;
}

/**
 * The link being typed at the caret: an opening `[[` before it on the same line with no `]]` (or a
 * `|` label separator, after which names no longer matter) in between. Null when not inside one.
 */
export function linkQueryAt(text: string, caret: number): LinkQuery | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf('[[');
  if (start < 0) return null;
  const query = before.slice(start + 2);
  if (/[\]\n|[]/.test(query) || query.length > 80) return null;
  return { start, query };
}

/**
 * How to write a link to an entry: `[[Name]]` when the name alone resolves to it, otherwise the
 * unambiguous `[[kind:id|Name]]`.
 */
export function linkMarkup(compendium: Compendium, entry: IndexEntry): string {
  const byName = compendium.byName(entry.name);
  return byName && byName.kind === entry.kind && byName.id === entry.id && !/[\][|]/.test(entry.name)
    ? `[[${entry.name}]]`
    : `[[${entry.kind}:${entry.id}|${entry.name.replace(/[\][|]/g, '')}]]`;
}

/** Suggestions for a `[[` query: campaign pages first when nothing is typed yet, then anything. */
export function linkSuggestions(compendium: Compendium, query: string, limit = 8): IndexEntry[] {
  if (!query.trim()) return compendium.search('', { kinds: ['page'], limit });
  return compendium.search(query, { limit });
}

/**
 * Replaces the `[[query` being typed (from `q.start` to the caret, plus a `]]` already right after
 * the caret) with the finished link, and returns the new text and caret.
 */
export function completeLink(text: string, caret: number, q: LinkQuery, markup: string): { text: string; caret: number } {
  const end = text.startsWith(']]', caret) ? caret + 2 : caret;
  const next = text.slice(0, q.start) + markup + text.slice(end);
  return { text: next, caret: q.start + markup.length };
}
