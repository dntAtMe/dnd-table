import type { ClientMessage, ClientRole, HandoutAudience, HandoutMessage, HandoutView, ServerMessage, Showcase, User } from '@dnd/protocol';
import { randomUUID } from 'node:crypto';
import { GameError } from './scenes';
import type { HandoutRecord, Store } from './store';

export interface HandoutConn {
  role: ClientRole;
  campaignId: string;
  user?: User;
}

/** What the handouts module needs from the hub. */
export interface HandoutHost<C extends HandoutConn> {
  connections(campaignId: string): Iterable<C>;
  send(conn: C, msg: ServerMessage): void;
}

type Msg<T extends HandoutMessage['type']> = Extract<HandoutMessage, { type: T }>;

export function isHandoutMessage(msg: ClientMessage): msg is HandoutMessage {
  return msg.type.startsWith('handout:') || msg.type.startsWith('showcase:');
}

function isShared(audience: HandoutAudience, userIds: string[]): boolean {
  return audience === 'all' || (audience === 'players' && userIds.length > 0);
}

/** Whether a player may see a handout. GMs see everything; table screens no handouts at all. */
export function handoutVisibleTo(h: HandoutRecord, userId: string): boolean {
  return h.audience === 'all' || (h.audience === 'players' && h.userIds.includes(userId));
}

/**
 * Handouts and the table showcase. Handouts live in the store and are filtered per user; the
 * showcase (what's pushed over the map right now) is kept in memory per campaign.
 */
export class Handouts<C extends HandoutConn> {
  private readonly showcases = new Map<string, Showcase>();

  constructor(
    private readonly store: Store,
    private readonly host: HandoutHost<C>,
  ) {}

  viewFor(conn: C, all = this.store.handouts(conn.campaignId)): HandoutView[] {
    if (conn.role === 'gm') {
      return all.map((h) => ({
        id: h.id,
        title: h.title,
        text: h.text,
        imageUrl: h.imageUrl,
        sharedAt: h.revisedAt,
        fileId: h.fileId,
        audience: h.audience,
        userIds: h.userIds,
        createdAt: h.createdAt,
      }));
    }
    const userId = conn.user?.id;
    if (conn.role !== 'player' || !userId) return [];
    const reads = this.store.handoutReads(conn.campaignId, userId);
    return all
      .filter((h) => handoutVisibleTo(h, userId))
      .sort((a, b) => (b.revisedAt ?? '').localeCompare(a.revisedAt ?? ''))
      .map((h) => {
        const read = reads.get(h.id);
        return {
          id: h.id,
          title: h.title,
          text: h.text,
          imageUrl: h.imageUrl,
          sharedAt: h.revisedAt,
          unread: !read || read < (h.revisedAt ?? ''),
        };
      });
  }

  showcaseFor(conn: C): Showcase | null {
    const showcase = this.showcases.get(conn.campaignId);
    if (!showcase) return null;
    return conn.role === 'player' && !showcase.toPlayers ? null : showcase;
  }

  handle(conn: C & { user: User }, msg: HandoutMessage): void {
    if (msg.type === 'handout:read') return this.read(conn, msg.handoutId);
    if (conn.role !== 'gm') throw new GameError('Only the GM can do that');
    switch (msg.type) {
      case 'handout:create':
        return this.create(conn, msg);
      case 'handout:update':
        return this.update(conn, msg);
      case 'handout:delete': {
        const h = this.handoutOf(conn, msg.handoutId);
        this.store.deleteHandout(h.id);
        if (this.showcases.get(conn.campaignId)?.handoutId === h.id) this.setShowcase(conn.campaignId, null);
        return this.changed(conn.campaignId);
      }
      case 'showcase:show':
        return this.show(conn, msg);
      case 'showcase:clear':
        return this.setShowcase(conn.campaignId, null);
    }
  }

  // ---------- handouts ----------

  private handoutOf(conn: C, id: string): HandoutRecord {
    const h = this.store.getHandout(id);
    if (!h || h.campaignId !== conn.campaignId) throw new GameError('Handout not found');
    return h;
  }

  private checkImage(conn: C, fileId: string | null | undefined): void {
    if (!fileId) return;
    const file = this.store.getFile(fileId);
    if (file?.campaignId !== conn.campaignId || !file.mime.startsWith('image/')) throw new GameError('Image not found');
  }

  /** Recipients only matter for 'players'; each must be a player in this campaign. */
  private recipients(conn: C, audience: HandoutAudience, userIds: string[] | undefined): string[] {
    if (audience !== 'players') return [];
    const unique = [...new Set(userIds ?? [])];
    for (const id of unique) {
      if (this.store.roleIn(conn.campaignId, id) !== 'player') throw new GameError('That player is not in this campaign');
    }
    return unique;
  }

  private create(conn: C, msg: Msg<'handout:create'>): void {
    this.checkImage(conn, msg.fileId);
    const userIds = this.recipients(conn, msg.audience, msg.userIds);
    this.store.createHandout({
      campaignId: conn.campaignId,
      title: msg.title,
      text: msg.text,
      fileId: msg.fileId,
      audience: msg.audience,
      userIds,
      shared: isShared(msg.audience, userIds),
    });
    this.changed(conn.campaignId);
  }

  private update(conn: C, msg: Msg<'handout:update'>): void {
    const h = this.handoutOf(conn, msg.handoutId);
    this.checkImage(conn, msg.fileId);
    const audience = msg.audience ?? h.audience;
    const userIds = this.recipients(conn, audience, msg.userIds ?? h.userIds);
    const contentChanged =
      (msg.title !== undefined && msg.title !== h.title) ||
      (msg.text !== undefined && msg.text !== h.text) ||
      (msg.fileId !== undefined && msg.fileId !== h.fileId);
    const wasShared = isShared(h.audience, h.userIds);
    const nowShared = isShared(audience, userIds);
    // Newly shared or changed while shared shows up as unread again; un-sharing makes it a draft.
    const revise = !nowShared ? (wasShared ? false : undefined) : !wasShared || contentChanged ? true : undefined;
    this.store.updateHandout(h.id, { title: msg.title, text: msg.text, fileId: msg.fileId, audience, userIds, revise });

    const showcase = this.showcases.get(conn.campaignId);
    if (showcase?.handoutId === h.id && contentChanged) {
      const next = this.store.getHandout(h.id)!;
      this.setShowcase(conn.campaignId, { ...showcase, title: next.title, text: next.text, imageUrl: next.imageUrl });
    }
    this.changed(conn.campaignId);
  }

  private read(conn: C & { user: User }, handoutId: string): void {
    const h = this.handoutOf(conn, handoutId);
    if (conn.role !== 'player') return;
    if (!handoutVisibleTo(h, conn.user.id)) throw new GameError('Handout not found');
    this.store.markHandoutRead(h.id, conn.user.id);
    // Only this player's screens change.
    const all = this.store.handouts(conn.campaignId);
    for (const other of this.host.connections(conn.campaignId)) {
      if (other.user?.id === conn.user.id) this.host.send(other, { type: 'handouts', handouts: this.viewFor(other, all) });
    }
  }

  /** Re-sends the handout list to everyone, each filtered for their role. */
  private changed(campaignId: string): void {
    const all = this.store.handouts(campaignId);
    for (const conn of this.host.connections(campaignId)) {
      if (conn.role !== 'display') this.host.send(conn, { type: 'handouts', handouts: this.viewFor(conn, all) });
    }
  }

  // ---------- showcase ----------

  private show(conn: C, msg: Msg<'showcase:show'>): void {
    let content: Pick<Showcase, 'handoutId' | 'title' | 'text' | 'imageUrl'>;
    if (msg.handoutId) {
      const h = this.handoutOf(conn, msg.handoutId);
      content = { handoutId: h.id, title: h.title, text: h.text, imageUrl: h.imageUrl };
    } else if (msg.fileId) {
      this.checkImage(conn, msg.fileId);
      const file = this.store.getFile(msg.fileId)!;
      content = { handoutId: null, title: msg.title ?? '', text: '', imageUrl: `/files/${file.filename}` };
    } else {
      throw new GameError('Nothing to show');
    }
    this.setShowcase(conn.campaignId, { id: randomUUID(), ...content, toPlayers: msg.toPlayers });
  }

  private setShowcase(campaignId: string, showcase: Showcase | null): void {
    if (showcase) this.showcases.set(campaignId, showcase);
    else this.showcases.delete(campaignId);
    for (const conn of this.host.connections(campaignId)) this.host.send(conn, { type: 'showcase', showcase: this.showcaseFor(conn) });
  }
}
