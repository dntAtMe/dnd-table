import type { ClientMessage, ClientRole, ServerMessage, User, WikiAudience, WikiMessage, WikiPageView } from '@dnd/protocol';
import { GameError } from './scenes';
import type { Store, WikiPagePatch, WikiPageRecord } from './store';

export interface WikiConn {
  role: ClientRole;
  campaignId: string;
  user?: User;
}

/** What the wiki module needs from the hub. */
export interface WikiHost<C extends WikiConn> {
  connections(campaignId: string): Iterable<C>;
  send(conn: C, msg: ServerMessage): void;
}

type Msg<T extends WikiMessage['type']> = Extract<WikiMessage, { type: T }>;

export function isWikiMessage(msg: ClientMessage): msg is WikiMessage {
  return msg.type.startsWith('wiki:');
}

/** Whether a player may see a page. GMs see everything; table screens no pages at all. */
export function wikiPageVisibleTo(p: Pick<WikiPageRecord, 'audience' | 'userIds'>, userId: string): boolean {
  return p.audience === 'all' || (p.audience === 'players' && p.userIds.includes(userId));
}

const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** Trimmed, single-spaced, without case-insensitive duplicates (or anything in `except`). */
function cleanList(list: readonly string[], except: readonly string[] = []): string[] {
  const seen = new Set(except.map(nameKey));
  const out: string[] = [];
  for (const raw of list) {
    const item = raw.trim().replace(/\s+/g, ' ');
    const key = nameKey(item);
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Campaign wiki pages. The GM writes them; each player receives only the pages shared with them,
 * always without the GM's secret notes. Lists are re-sent whole, filtered per connection.
 */
export class Wiki<C extends WikiConn> {
  constructor(
    private readonly store: Store,
    private readonly host: WikiHost<C>,
  ) {}

  viewFor(conn: C, all = this.store.wikiPages(conn.campaignId)): WikiPageView[] {
    if (conn.role === 'gm') {
      return all.map((p) => ({
        ...Wiki.publicView(p),
        updatedAt: p.editedAt,
        fileId: p.fileId,
        audience: p.audience,
        userIds: p.userIds,
        secret: p.secret,
      }));
    }
    const userId = conn.user?.id;
    if (conn.role !== 'player' || !userId) return [];
    return all.filter((p) => wikiPageVisibleTo(p, userId)).map(Wiki.publicView);
  }

  /** Exactly what a player may see: never the audience, the recipients or the secret notes. */
  private static publicView(p: WikiPageRecord): WikiPageView {
    return {
      id: p.id,
      title: p.title,
      aliases: p.aliases,
      category: p.category,
      tags: p.tags,
      imageUrl: p.imageUrl,
      body: p.body,
      authorName: p.authorName,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  handle(conn: C & { user: User }, msg: WikiMessage): void {
    if (conn.role !== 'gm') throw new GameError('Only the GM can do that');
    switch (msg.type) {
      case 'wiki:create':
        return this.create(conn, msg);
      case 'wiki:update':
        return this.update(conn, msg);
      case 'wiki:delete':
        this.store.deleteWikiPage(this.pageOf(conn, msg.pageId).id);
        return this.changed(conn.campaignId);
    }
  }

  private pageOf(conn: C, id: string): WikiPageRecord {
    const p = this.store.getWikiPage(id);
    if (!p || p.campaignId !== conn.campaignId) throw new GameError('Page not found');
    return p;
  }

  private checkImage(conn: C, fileId: string | null | undefined): void {
    if (!fileId) return;
    const file = this.store.getFile(fileId);
    if (file?.campaignId !== conn.campaignId || !file.mime.startsWith('image/')) throw new GameError('Image not found');
  }

  /** Recipients only matter for 'players'; each must be a player in this campaign. */
  private recipients(conn: C, audience: WikiAudience, userIds: string[] | undefined): string[] {
    if (audience !== 'players') return [];
    const unique = [...new Set(userIds ?? [])];
    for (const id of unique) {
      if (this.store.roleIn(conn.campaignId, id) !== 'player') throw new GameError('That player is not in this campaign');
    }
    return unique;
  }

  /** [[Title]] links must be unambiguous: no title or alias may name another page of the campaign. */
  private checkNames(conn: C, names: string[], pageId?: string): void {
    const taken = new Map<string, string>();
    for (const p of this.store.wikiPages(conn.campaignId)) {
      if (p.id === pageId) continue;
      for (const n of [p.title, ...p.aliases]) taken.set(nameKey(n), p.title);
    }
    for (const n of names) {
      const owner = taken.get(nameKey(n));
      if (owner !== undefined) {
        throw new GameError(nameKey(owner) === nameKey(n) ? `There is already a page called "${owner}"` : `"${n}" is already another name for "${owner}"`);
      }
    }
  }

  private create(conn: C & { user: User }, msg: Msg<'wiki:create'>): void {
    this.checkImage(conn, msg.fileId);
    const title = cleanList([msg.title])[0]!;
    const aliases = cleanList(msg.aliases ?? [], [title]);
    this.checkNames(conn, [title, ...aliases]);
    this.store.createWikiPage({
      campaignId: conn.campaignId,
      authorUserId: conn.user.id,
      title,
      aliases,
      category: msg.category,
      tags: cleanList(msg.tags ?? []),
      fileId: msg.fileId ?? null,
      body: msg.body,
      secret: msg.secret ?? '',
      audience: msg.audience,
      userIds: this.recipients(conn, msg.audience, msg.userIds),
    });
    this.changed(conn.campaignId);
  }

  private update(conn: C, msg: Msg<'wiki:update'>): void {
    const p = this.pageOf(conn, msg.pageId);
    this.checkImage(conn, msg.fileId);
    const title = msg.title !== undefined ? cleanList([msg.title])[0]! : p.title;
    const aliases = cleanList(msg.aliases ?? p.aliases, [title]);
    this.checkNames(conn, [title, ...aliases], p.id);
    const audience = msg.audience ?? p.audience;
    const patch: WikiPagePatch = {
      title,
      aliases,
      category: msg.category,
      tags: msg.tags && cleanList(msg.tags),
      fileId: msg.fileId,
      body: msg.body,
      secret: msg.secret,
      audience,
      userIds: this.recipients(conn, audience, msg.userIds ?? p.userIds),
    };
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
    const visible =
      title !== p.title ||
      !same(aliases, p.aliases) ||
      (patch.category !== undefined && patch.category !== p.category) ||
      (patch.tags !== undefined && !same(patch.tags, p.tags)) ||
      (patch.fileId !== undefined && patch.fileId !== p.fileId) ||
      (patch.body !== undefined && patch.body !== p.body);
    this.store.updateWikiPage(p.id, patch, visible);
    this.changed(conn.campaignId);
  }

  /** Re-sends the page list to everyone, each filtered for their role. */
  private changed(campaignId: string): void {
    const all = this.store.wikiPages(campaignId);
    for (const conn of this.host.connections(campaignId)) {
      if (conn.role !== 'display') this.host.send(conn, { type: 'wiki', pages: this.viewFor(conn, all) });
    }
  }
}
