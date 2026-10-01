import { randomUUID } from 'node:crypto';
import type { CampaignSummary, CharacterRecord, HandoutAudience, LogEntry, MapTemplate, Role, SceneSummary, Token, Track, TrackKind, User, Visibility, WikiAudience, WikiCategory } from '@dnd/protocol';
import { DEFAULT_SCENE_VISION, type Character, type Grid, type SceneVision } from '@dnd/rules';
import type { Encounter } from './combat';
import type { DB } from './db';
import { hashToken, newToken, randomCode } from './security';

const SESSION_DAYS = 90;

export interface Campaign {
  id: string;
  name: string;
  inviteCode: string;
}

export interface MemberRow {
  userId: string;
  name: string;
  role: Role;
}

export interface Display {
  id: string;
  name: string;
  code: string;
  campaignId: string | null;
}

export interface StoredFile {
  id: string;
  campaignId: string;
  /** Name on disk inside the uploads directory; also its public path under /files/. */
  filename: string;
  mime: string;
  bytes: number;
}

/** A scene as stored: the unfiltered source for every client's SceneView. */
export interface SceneRecord extends SceneSummary {
  campaignId: string;
  width: number;
  height: number;
  grid: Grid;
  fogEnabled: boolean;
  fog: string;
  /** Encoded MapData (walls, doors, terrain); '' for none. */
  map: string;
}

/** A token's light source and senses, kept beside the token row. */
export type TokenVision = Pick<Token, 'light' | 'senses'>;

/** A handout as stored: the unfiltered source for every client's HandoutView. */
export interface HandoutRecord {
  id: string;
  campaignId: string;
  title: string;
  text: string;
  fileId: string | null;
  imageUrl: string | null;
  audience: HandoutAudience;
  /** Recipients when audience is 'players'. */
  userIds: string[];
  /** When it was last (re)shared or changed while shared; null while it's a draft. */
  revisedAt: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;

/** A campaign wiki page as stored: the unfiltered source for every client's WikiPageView. */
export interface WikiPageRecord {
  id: string;
  campaignId: string;
  title: string;
  aliases: string[];
  category: WikiCategory;
  tags: string[];
  fileId: string | null;
  imageUrl: string | null;
  body: string;
  secret: string;
  audience: WikiAudience;
  /** Recipients when audience is 'players'. */
  userIds: string[];
  authorName: string;
  createdAt: string;
  /** Last change players can see. */
  updatedAt: string;
  /** Last change of any kind, secret notes included. */
  editedAt: string;
}

export type WikiPagePatch = Partial<Pick<WikiPageRecord, 'title' | 'aliases' | 'category' | 'tags' | 'fileId' | 'body' | 'secret' | 'audience' | 'userIds'>>;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/.test(err.message);
}

/** All database access goes through here. */
export class Store {
  constructor(private readonly db: DB) {}

  // ---------- users & sessions ----------

  createUser(username: string, displayName: string, passwordHash: string): User | null {
    const id = randomUUID();
    try {
      this.db
        .prepare('INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)')
        .run(id, username, displayName, passwordHash);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    return { id, username, displayName };
  }

  findUserForLogin(username: string): (User & { passwordHash: string }) | undefined {
    const row = this.db
      .prepare('SELECT id, username, display_name, password_hash FROM users WHERE username = ?')
      .get(username) as Row | undefined;
    if (!row) return undefined;
    return {
      id: row.id as string,
      username: row.username as string,
      displayName: row.display_name as string,
      passwordHash: row.password_hash as string,
    };
  }

  createSession(userId: string): { token: string; expiresAt: Date } {
    const token = newToken();
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hashToken(token), userId, expiresAt.toISOString());
    return { token, expiresAt };
  }

  userForSession(token: string): User | undefined {
    const row = this.db
      .prepare(
        `SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(hashToken(token), new Date().toISOString()) as Row | undefined;
    if (!row) return undefined;
    return { id: row.id as string, username: row.username as string, displayName: row.display_name as string };
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  // ---------- campaigns ----------

  createCampaign(name: string, gmUserId: string): Campaign {
    const id = randomUUID();
    for (;;) {
      const inviteCode = randomCode(6);
      try {
        this.db.exec('BEGIN');
        this.db.prepare('INSERT INTO campaigns (id, name, invite_code) VALUES (?, ?, ?)').run(id, name, inviteCode);
        this.db
          .prepare(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES (?, ?, 'gm')`)
          .run(id, gmUserId);
        this.db.exec('COMMIT');
        return { id, name, inviteCode };
      } catch (err) {
        this.db.exec('ROLLBACK');
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  getCampaign(id: string): Campaign | undefined {
    const row = this.db.prepare('SELECT id, name, invite_code FROM campaigns WHERE id = ?').get(id) as Row | undefined;
    return row && { id: row.id as string, name: row.name as string, inviteCode: row.invite_code as string };
  }

  findCampaignByInvite(code: string): Campaign | undefined {
    const row = this.db.prepare('SELECT id, name, invite_code FROM campaigns WHERE invite_code = ?').get(code) as
      | Row
      | undefined;
    return row && { id: row.id as string, name: row.name as string, inviteCode: row.invite_code as string };
  }

  campaignsForUser(userId: string): CampaignSummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, m.role,
                (SELECT COUNT(*) FROM campaign_members x WHERE x.campaign_id = c.id) AS member_count
         FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
         WHERE m.user_id = ? ORDER BY c.rowid DESC`,
      )
      .all(userId) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      role: r.role as Role,
      memberCount: Number(r.member_count),
    }));
  }

  roleIn(campaignId: string, userId: string): Role | undefined {
    const row = this.db
      .prepare('SELECT role FROM campaign_members WHERE campaign_id = ? AND user_id = ?')
      .get(campaignId, userId) as Row | undefined;
    return row?.role as Role | undefined;
  }

  /** Adds the user as a player; returns false if they were already a member. */
  addPlayer(campaignId: string, userId: string): boolean {
    const res = this.db
      .prepare(`INSERT OR IGNORE INTO campaign_members (campaign_id, user_id, role) VALUES (?, ?, 'player')`)
      .run(campaignId, userId);
    return res.changes > 0;
  }

  members(campaignId: string): MemberRow[] {
    const rows = this.db
      .prepare(
        `SELECT u.id, u.display_name, m.role FROM campaign_members m JOIN users u ON u.id = m.user_id
         WHERE m.campaign_id = ? ORDER BY m.role = 'gm' DESC, m.rowid`,
      )
      .all(campaignId) as Row[];
    return rows.map((r) => ({ userId: r.id as string, name: r.display_name as string, role: r.role as Role }));
  }

  // ---------- table displays ----------

  createDisplay(): { display: Display; token: string } {
    const id = randomUUID();
    const token = newToken();
    for (;;) {
      const code = randomCode(6);
      try {
        this.db
          .prepare('INSERT INTO displays (id, token_hash, pairing_code) VALUES (?, ?, ?)')
          .run(id, hashToken(token), code);
        return { display: { id, name: 'Table display', code, campaignId: null }, token };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  private static toDisplay(row: Row): Display {
    return {
      id: row.id as string,
      name: row.name as string,
      code: row.pairing_code as string,
      campaignId: (row.campaign_id as string | null) ?? null,
    };
  }

  displayForToken(token: string): Display | undefined {
    const row = this.db
      .prepare('SELECT id, name, pairing_code, campaign_id FROM displays WHERE token_hash = ?')
      .get(hashToken(token)) as Row | undefined;
    return row && Store.toDisplay(row);
  }

  unpairedDisplayByCode(code: string): Display | undefined {
    const row = this.db
      .prepare('SELECT id, name, pairing_code, campaign_id FROM displays WHERE pairing_code = ? AND campaign_id IS NULL')
      .get(code) as Row | undefined;
    return row && Store.toDisplay(row);
  }

  displaysFor(campaignId: string): Display[] {
    const rows = this.db
      .prepare('SELECT id, name, pairing_code, campaign_id FROM displays WHERE campaign_id = ? ORDER BY rowid')
      .all(campaignId) as Row[];
    return rows.map(Store.toDisplay);
  }

  pairDisplay(displayId: string, campaignId: string): void {
    this.db.prepare('UPDATE displays SET campaign_id = ? WHERE id = ?').run(campaignId, displayId);
  }

  /** Unpairs and issues a fresh pairing code; returns it, or undefined if not paired to this campaign. */
  unpairDisplay(displayId: string, campaignId: string): string | undefined {
    for (;;) {
      const code = randomCode(6);
      try {
        const res = this.db
          .prepare('UPDATE displays SET campaign_id = NULL, pairing_code = ? WHERE id = ? AND campaign_id = ?')
          .run(code, displayId, campaignId);
        return res.changes > 0 ? code : undefined;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
  }

  // ---------- files ----------

  addFile(file: StoredFile): void {
    this.db
      .prepare('INSERT INTO files (id, campaign_id, filename, mime, bytes) VALUES (?, ?, ?, ?, ?)')
      .run(file.id, file.campaignId, file.filename, file.mime, file.bytes);
  }

  getFile(id: string): StoredFile | undefined {
    const row = this.db.prepare('SELECT id, campaign_id, filename, mime, bytes FROM files WHERE id = ?').get(id) as
      | Row
      | undefined;
    return (
      row && {
        id: row.id as string,
        campaignId: row.campaign_id as string,
        filename: row.filename as string,
        mime: row.mime as string,
        bytes: Number(row.bytes),
      }
    );
  }

  // ---------- handouts ----------

  /** Every handout in the campaign, newest first. */
  handouts(campaignId: string): HandoutRecord[] {
    const rows = this.db.prepare(`${HANDOUT_SELECT} WHERE h.campaign_id = ? ORDER BY h.rowid DESC`).all(campaignId) as Row[];
    const recipients = new Map<string, string[]>();
    const recipientRows = this.db
      .prepare(
        `SELECT r.handout_id, r.user_id FROM handout_recipients r JOIN handouts h ON h.id = r.handout_id
         WHERE h.campaign_id = ? ORDER BY r.rowid`,
      )
      .all(campaignId) as Row[];
    for (const r of recipientRows) {
      const list = recipients.get(r.handout_id as string) ?? [];
      list.push(r.user_id as string);
      recipients.set(r.handout_id as string, list);
    }
    return rows.map((r) => Store.toHandout(r, recipients.get(r.id as string) ?? []));
  }

  getHandout(id: string): HandoutRecord | undefined {
    const row = this.db.prepare(`${HANDOUT_SELECT} WHERE h.id = ?`).get(id) as Row | undefined;
    if (!row) return undefined;
    const users = this.db.prepare('SELECT user_id FROM handout_recipients WHERE handout_id = ? ORDER BY rowid').all(id) as Row[];
    return Store.toHandout(
      row,
      users.map((u) => u.user_id as string),
    );
  }

  private static toHandout(row: Row, userIds: string[]): HandoutRecord {
    return {
      id: row.id as string,
      campaignId: row.campaign_id as string,
      title: row.title as string,
      text: row.text as string,
      fileId: (row.file_id as string | null) ?? null,
      imageUrl: row.filename ? `/files/${row.filename as string}` : null,
      audience: row.audience as HandoutAudience,
      userIds,
      revisedAt: (row.revised_at as string | null) ?? null,
      createdAt: row.created_at as string,
    };
  }

  createHandout(h: Pick<HandoutRecord, 'campaignId' | 'title' | 'text' | 'fileId' | 'audience' | 'userIds'> & { shared: boolean }): string {
    const id = randomUUID();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO handouts (id, campaign_id, title, text, file_id, audience, revised_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, h.campaignId, h.title, h.text, h.fileId, h.audience, h.shared ? stamp() : null);
      this.setRecipients(id, h.userIds);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return id;
  }

  /** `revise`: true stamps it as newly shared/changed, false makes it a draft, undefined leaves it. */
  updateHandout(
    id: string,
    patch: Partial<Pick<HandoutRecord, 'title' | 'text' | 'fileId' | 'audience' | 'userIds'>> & { revise?: boolean },
  ): void {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (patch.title !== undefined) sets.push('title = ?'), values.push(patch.title);
    if (patch.text !== undefined) sets.push('text = ?'), values.push(patch.text);
    if (patch.fileId !== undefined) sets.push('file_id = ?'), values.push(patch.fileId);
    if (patch.audience !== undefined) sets.push('audience = ?'), values.push(patch.audience);
    if (patch.revise !== undefined) sets.push('revised_at = ?'), values.push(patch.revise ? stamp() : null);
    this.db.exec('BEGIN');
    try {
      if (sets.length) this.db.prepare(`UPDATE handouts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      if (patch.userIds !== undefined) this.setRecipients(id, patch.userIds);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private setRecipients(handoutId: string, userIds: string[]): void {
    this.db.prepare('DELETE FROM handout_recipients WHERE handout_id = ?').run(handoutId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO handout_recipients (handout_id, user_id) VALUES (?, ?)');
    for (const userId of userIds) insert.run(handoutId, userId);
  }

  deleteHandout(id: string): void {
    this.db.prepare('DELETE FROM handouts WHERE id = ?').run(id);
  }

  /** When this user last opened each handout of the campaign. */
  handoutReads(campaignId: string, userId: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT r.handout_id, r.read_at FROM handout_reads r JOIN handouts h ON h.id = r.handout_id
         WHERE h.campaign_id = ? AND r.user_id = ?`,
      )
      .all(campaignId, userId) as Row[];
    return new Map(rows.map((r) => [r.handout_id as string, r.read_at as string]));
  }

  markHandoutRead(handoutId: string, userId: string): void {
    this.db
      .prepare(
        `INSERT INTO handout_reads (handout_id, user_id, read_at) VALUES (?, ?, ?)
         ON CONFLICT (handout_id, user_id) DO UPDATE SET read_at = excluded.read_at`,
      )
      .run(handoutId, userId, stamp());
  }

  // ---------- wiki pages ----------

  /** Every wiki page in the campaign, by title. */
  wikiPages(campaignId: string): WikiPageRecord[] {
    const rows = this.db.prepare(`${WIKI_SELECT} WHERE p.campaign_id = ? ORDER BY p.title COLLATE NOCASE`).all(campaignId) as Row[];
    const recipients = new Map<string, string[]>();
    const recipientRows = this.db
      .prepare(`SELECT r.page_id, r.user_id FROM wiki_recipients r JOIN wiki_pages p ON p.id = r.page_id WHERE p.campaign_id = ? ORDER BY r.rowid`)
      .all(campaignId) as Row[];
    for (const r of recipientRows) {
      const list = recipients.get(r.page_id as string) ?? [];
      list.push(r.user_id as string);
      recipients.set(r.page_id as string, list);
    }
    return rows.map((r) => Store.toWikiPage(r, recipients.get(r.id as string) ?? []));
  }

  getWikiPage(id: string): WikiPageRecord | undefined {
    const row = this.db.prepare(`${WIKI_SELECT} WHERE p.id = ?`).get(id) as Row | undefined;
    if (!row) return undefined;
    const users = this.db.prepare('SELECT user_id FROM wiki_recipients WHERE page_id = ? ORDER BY rowid').all(id) as Row[];
    return Store.toWikiPage(
      row,
      users.map((u) => u.user_id as string),
    );
  }

  private static toWikiPage(row: Row, userIds: string[]): WikiPageRecord {
    return {
      id: row.id as string,
      campaignId: row.campaign_id as string,
      title: row.title as string,
      aliases: JSON.parse(row.aliases as string) as string[],
      category: row.category as WikiCategory,
      tags: JSON.parse(row.tags as string) as string[],
      fileId: (row.file_id as string | null) ?? null,
      imageUrl: row.filename ? `/files/${row.filename as string}` : null,
      body: row.body as string,
      secret: row.secret as string,
      audience: row.audience as WikiAudience,
      userIds,
      authorName: (row.author_name as string | null) ?? '',
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      editedAt: row.edited_at as string,
    };
  }

  createWikiPage(p: Required<WikiPagePatch> & { campaignId: string; authorUserId: string }): string {
    const id = randomUUID();
    const now = stamp();
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT INTO wiki_pages (id, campaign_id, title, aliases, category, tags, file_id, body, secret, audience, author_user_id, created_at, updated_at, edited_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, p.campaignId, p.title, JSON.stringify(p.aliases), p.category, JSON.stringify(p.tags), p.fileId, p.body, p.secret, p.audience, p.authorUserId, now, now, now);
      this.setWikiRecipients(id, p.userIds);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return id;
  }

  /** `visible`: whether the change is one players can see (bumps updatedAt as well as editedAt). */
  updateWikiPage(id: string, patch: WikiPagePatch, visible: boolean): void {
    const now = stamp();
    const sets: string[] = ['edited_at = ?'];
    const values: (string | null)[] = [now];
    if (visible) sets.push('updated_at = ?'), values.push(now);
    if (patch.title !== undefined) sets.push('title = ?'), values.push(patch.title);
    if (patch.aliases !== undefined) sets.push('aliases = ?'), values.push(JSON.stringify(patch.aliases));
    if (patch.category !== undefined) sets.push('category = ?'), values.push(patch.category);
    if (patch.tags !== undefined) sets.push('tags = ?'), values.push(JSON.stringify(patch.tags));
    if (patch.fileId !== undefined) sets.push('file_id = ?'), values.push(patch.fileId);
    if (patch.body !== undefined) sets.push('body = ?'), values.push(patch.body);
    if (patch.secret !== undefined) sets.push('secret = ?'), values.push(patch.secret);
    if (patch.audience !== undefined) sets.push('audience = ?'), values.push(patch.audience);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE wiki_pages SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
      if (patch.userIds !== undefined) this.setWikiRecipients(id, patch.userIds);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private setWikiRecipients(pageId: string, userIds: string[]): void {
    this.db.prepare('DELETE FROM wiki_recipients WHERE page_id = ?').run(pageId);
    const insert = this.db.prepare('INSERT OR IGNORE INTO wiki_recipients (page_id, user_id) VALUES (?, ?)');
    for (const userId of userIds) insert.run(pageId, userId);
  }

  deleteWikiPage(id: string): void {
    this.db.prepare('DELETE FROM wiki_pages WHERE id = ?').run(id);
  }

  // ---------- soundboard ----------

  private static toTrack(row: Row): Track & { campaignId: string } {
    return {
      id: row.id as string,
      campaignId: row.campaign_id as string,
      name: row.name as string,
      fileId: row.file_id as string,
      url: `/files/${row.filename as string}`,
      kind: row.kind as TrackKind,
      loop: Boolean(row.loop),
      volume: Number(row.volume),
      duration: row.duration === null ? null : Number(row.duration),
    };
  }

  tracks(campaignId: string): (Track & { campaignId: string })[] {
    const rows = this.db.prepare(`${TRACK_SELECT} WHERE t.campaign_id = ? ORDER BY t.rowid`).all(campaignId) as Row[];
    return rows.map(Store.toTrack);
  }

  getTrack(id: string): (Track & { campaignId: string }) | undefined {
    const row = this.db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id) as Row | undefined;
    return row && Store.toTrack(row);
  }

  createTrack(t: Omit<Track, 'id' | 'url'> & { campaignId: string }): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO tracks (id, campaign_id, name, file_id, kind, loop, volume, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, t.campaignId, t.name, t.fileId, t.kind, t.loop ? 1 : 0, t.volume, t.duration);
    return id;
  }

  updateTrack(t: Pick<Track, 'id' | 'name' | 'kind' | 'loop' | 'volume'>): void {
    this.db
      .prepare('UPDATE tracks SET name = ?, kind = ?, loop = ?, volume = ? WHERE id = ?')
      .run(t.name, t.kind, t.loop ? 1 : 0, t.volume, t.id);
  }

  deleteTrack(id: string): void {
    this.db.prepare('DELETE FROM tracks WHERE id = ?').run(id);
  }

  // ---------- scenes ----------

  private static toScene(row: Row): SceneRecord {
    return {
      id: row.id as string,
      campaignId: row.campaign_id as string,
      name: row.name as string,
      imageUrl: row.filename ? `/files/${row.filename as string}` : null,
      width: Number(row.width),
      height: Number(row.height),
      grid: JSON.parse(row.grid as string) as Grid,
      fogEnabled: Boolean(row.fog_enabled),
      fog: row.fog as string,
      map: row.map as string,
    };
  }

  createScene(scene: Omit<SceneRecord, 'id' | 'imageUrl'> & { fileId: string | null }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO scenes (id, campaign_id, name, file_id, width, height, grid, fog_enabled, fog, map)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        scene.campaignId,
        scene.name,
        scene.fileId,
        scene.width,
        scene.height,
        JSON.stringify(scene.grid),
        scene.fogEnabled ? 1 : 0,
        scene.fog,
        scene.map,
      );
    return id;
  }

  getScene(id: string): SceneRecord | undefined {
    const row = this.db.prepare(`${SCENE_SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
    return row && Store.toScene(row);
  }

  scenes(campaignId: string): SceneRecord[] {
    const rows = this.db.prepare(`${SCENE_SELECT} WHERE s.campaign_id = ? ORDER BY s.rowid`).all(campaignId) as Row[];
    return rows.map(Store.toScene);
  }

  updateScene(id: string, patch: Partial<Pick<SceneRecord, 'name' | 'grid' | 'fogEnabled' | 'fog' | 'map' | 'width' | 'height'>>): void {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) sets.push('name = ?'), values.push(patch.name);
    if (patch.grid !== undefined) sets.push('grid = ?'), values.push(JSON.stringify(patch.grid));
    if (patch.fogEnabled !== undefined) sets.push('fog_enabled = ?'), values.push(patch.fogEnabled ? 1 : 0);
    if (patch.fog !== undefined) sets.push('fog = ?'), values.push(patch.fog);
    if (patch.map !== undefined) sets.push('map = ?'), values.push(patch.map);
    if (patch.width !== undefined) sets.push('width = ?'), values.push(patch.width);
    if (patch.height !== undefined) sets.push('height = ?'), values.push(patch.height);
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE scenes SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  deleteScene(id: string): void {
    this.db.prepare('DELETE FROM scenes WHERE id = ?').run(id);
  }

  activeSceneId(campaignId: string): string | null {
    const row = this.db.prepare('SELECT active_scene_id FROM campaigns WHERE id = ?').get(campaignId) as Row | undefined;
    return (row?.active_scene_id as string | null | undefined) ?? null;
  }

  setActiveScene(campaignId: string, sceneId: string | null): void {
    this.db.prepare('UPDATE campaigns SET active_scene_id = ? WHERE id = ?').run(sceneId, campaignId);
  }

  // ---------- tokens ----------

  private static toToken(row: Row): Token {
    return {
      id: row.id as string,
      sceneId: row.scene_id as string,
      name: row.name as string,
      color: row.color as string,
      col: Number(row.col),
      row: Number(row.row),
      size: Number(row.size),
      hidden: Boolean(row.hidden),
      ownerUserId: (row.owner_user_id as string | null) ?? null,
      characterId: (row.character_id as string | null) ?? null,
    };
  }

  tokens(sceneId: string): Token[] {
    const rows = this.db.prepare(`${TOKEN_SELECT} WHERE scene_id = ? ORDER BY rowid`).all(sceneId) as Row[];
    return rows.map(Store.toToken);
  }

  getToken(id: string): Token | undefined {
    const row = this.db.prepare(`${TOKEN_SELECT} WHERE id = ?`).get(id) as Row | undefined;
    return row && Store.toToken(row);
  }

  createToken(token: Omit<Token, 'id'>): Token {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO tokens (id, scene_id, name, color, col, row, size, hidden, owner_user_id, character_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        token.sceneId,
        token.name,
        token.color,
        token.col,
        token.row,
        token.size,
        token.hidden ? 1 : 0,
        token.ownerUserId,
        token.characterId,
      );
    return { ...token, id };
  }

  updateToken(token: Token): void {
    this.db
      .prepare(
        `UPDATE tokens SET name = ?, color = ?, col = ?, row = ?, size = ?, hidden = ?, owner_user_id = ?
         WHERE id = ?`,
      )
      .run(token.name, token.color, token.col, token.row, token.size, token.hidden ? 1 : 0, token.ownerUserId, token.id);
  }

  deleteToken(id: string): void {
    this.db.prepare('DELETE FROM tokens WHERE id = ?').run(id);
  }

  /** Keeps map tokens in step with their character's name and colour; returns affected scene ids. */
  syncCharacterTokens(characterId: string, name: string, color: string): string[] {
    const rows = this.db
      .prepare('UPDATE tokens SET name = ?, color = ? WHERE character_id = ? RETURNING scene_id')
      .all(name, color, characterId) as Row[];
    return [...new Set(rows.map((r) => r.scene_id as string))];
  }

  // ---------- lighting & vision ----------

  sceneVision(sceneId: string): SceneVision {
    const row = this.db.prepare('SELECT data FROM scene_vision WHERE scene_id = ?').get(sceneId) as Row | undefined;
    return { ...DEFAULT_SCENE_VISION, ...(row ? (JSON.parse(row.data as string) as Partial<SceneVision>) : {}) };
  }

  setSceneVision(sceneId: string, vision: SceneVision): void {
    this.db
      .prepare('INSERT INTO scene_vision (scene_id, data) VALUES (?, ?) ON CONFLICT (scene_id) DO UPDATE SET data = excluded.data')
      .run(sceneId, JSON.stringify(vision));
  }

  /** Light sources and senses of the tokens on a scene that have any, by token id. */
  tokenVision(sceneId: string): Map<string, TokenVision> {
    const rows = this.db
      .prepare('SELECT v.token_id, v.data FROM token_vision v JOIN tokens t ON t.id = v.token_id WHERE t.scene_id = ?')
      .all(sceneId) as Row[];
    return new Map(rows.map((r) => [r.token_id as string, JSON.parse(r.data as string) as TokenVision]));
  }

  setTokenVision(tokenId: string, vision: TokenVision): void {
    if (!vision.light && !vision.senses) {
      this.db.prepare('DELETE FROM token_vision WHERE token_id = ?').run(tokenId);
      return;
    }
    this.db
      .prepare('INSERT INTO token_vision (token_id, data) VALUES (?, ?) ON CONFLICT (token_id) DO UPDATE SET data = excluded.data')
      .run(tokenId, JSON.stringify(vision));
  }

  // ---------- area templates ----------

  private static toTemplate(row: Row): MapTemplate {
    return {
      ...(JSON.parse(row.data as string) as Omit<MapTemplate, 'id' | 'sceneId' | 'tokenId' | 'ownerUserId'>),
      id: row.id as string,
      sceneId: row.scene_id as string,
      tokenId: (row.token_id as string | null) ?? null,
      ownerUserId: (row.owner_user_id as string | null) ?? null,
    };
  }

  private static templateData({ id: _, sceneId: __, tokenId: ___, ownerUserId: ____, span: _____, ...data }: MapTemplate): string {
    return JSON.stringify(data);
  }

  templates(sceneId: string): MapTemplate[] {
    const rows = this.db.prepare(`${TEMPLATE_SELECT} WHERE scene_id = ? ORDER BY rowid`).all(sceneId) as Row[];
    return rows.map(Store.toTemplate);
  }

  getTemplate(id: string): MapTemplate | undefined {
    const row = this.db.prepare(`${TEMPLATE_SELECT} WHERE id = ?`).get(id) as Row | undefined;
    return row && Store.toTemplate(row);
  }

  createTemplate(template: Omit<MapTemplate, 'id'>): MapTemplate {
    const created = { ...template, id: randomUUID() };
    this.db
      .prepare('INSERT INTO templates (id, scene_id, token_id, owner_user_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(created.id, created.sceneId, created.tokenId, created.ownerUserId, Store.templateData(created));
    return created;
  }

  updateTemplate(template: MapTemplate): void {
    this.db.prepare('UPDATE templates SET data = ? WHERE id = ?').run(Store.templateData(template), template.id);
  }

  deleteTemplate(id: string): void {
    this.db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  }

  /** Removes a scene's templates: all of them, or only one owner's one-shot ones. */
  deleteTemplates(sceneId: string, oneShotOf?: string): number {
    if (oneShotOf === undefined) return Number(this.db.prepare('DELETE FROM templates WHERE scene_id = ?').run(sceneId).changes);
    return Number(
      this.db
        .prepare(`DELETE FROM templates WHERE scene_id = ? AND owner_user_id = ? AND json_extract(data, '$.linger') = 0`)
        .run(sceneId, oneShotOf).changes,
    );
  }

  /** Removes every one-shot template in a campaign; returns the scenes that had any. */
  deleteOneShotTemplates(campaignId: string): string[] {
    const rows = this.db
      .prepare(
        `DELETE FROM templates WHERE json_extract(data, '$.linger') = 0
           AND scene_id IN (SELECT id FROM scenes WHERE campaign_id = ?)
         RETURNING scene_id`,
      )
      .all(campaignId) as Row[];
    return [...new Set(rows.map((r) => r.scene_id as string))];
  }

  // ---------- characters ----------

  private static toCharacter(row: Row): CharacterRecord & { campaignId: string } {
    return {
      id: row.id as string,
      campaignId: row.campaign_id as string,
      ownerUserId: row.owner_user_id as string,
      data: JSON.parse(row.data as string) as Character,
      updatedAt: row.updated_at as string,
    };
  }

  characters(campaignId: string): (CharacterRecord & { campaignId: string })[] {
    const rows = this.db
      .prepare('SELECT id, campaign_id, owner_user_id, data, updated_at FROM characters WHERE campaign_id = ? ORDER BY rowid')
      .all(campaignId) as Row[];
    return rows.map(Store.toCharacter);
  }

  getCharacter(id: string): (CharacterRecord & { campaignId: string }) | undefined {
    const row = this.db.prepare('SELECT id, campaign_id, owner_user_id, data, updated_at FROM characters WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row && Store.toCharacter(row);
  }

  createCharacter(campaignId: string, ownerUserId: string, data: Character): string {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO characters (id, campaign_id, owner_user_id, data) VALUES (?, ?, ?, ?)')
      .run(id, campaignId, ownerUserId, JSON.stringify(data));
    return id;
  }

  updateCharacter(id: string, data: Character): void {
    this.db
      .prepare(`UPDATE characters SET data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(JSON.stringify(data), id);
  }

  deleteCharacter(id: string): void {
    this.db.prepare('DELETE FROM characters WHERE id = ?').run(id);
  }

  // ---------- encounters ----------

  /** The campaign's running encounter, if any (one per campaign). */
  getEncounter(campaignId: string): Encounter | undefined {
    const row = this.db.prepare('SELECT data FROM encounters WHERE campaign_id = ?').get(campaignId) as Row | undefined;
    return row && (JSON.parse(row.data as string) as Encounter);
  }

  saveEncounter(campaignId: string, encounter: Encounter): void {
    this.db
      .prepare(
        `INSERT INTO encounters (campaign_id, data) VALUES (?, ?)
         ON CONFLICT (campaign_id) DO UPDATE SET data = excluded.data, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
      )
      .run(campaignId, JSON.stringify(encounter));
  }

  deleteEncounter(campaignId: string): void {
    this.db.prepare('DELETE FROM encounters WHERE campaign_id = ?').run(campaignId);
  }

  // ---------- log ----------

  addLog(
    campaignId: string,
    userId: string,
    kind: LogEntry['kind'],
    visibility: Visibility,
    payload: object,
  ): LogEntry {
    const row = this.db
      .prepare(
        `INSERT INTO log_entries (campaign_id, user_id, kind, visibility, payload) VALUES (?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(campaignId, userId, kind, visibility, JSON.stringify(payload)) as Row;
    return this.logEntry(Number(row.id))!;
  }

  private logEntry(id: number): LogEntry | undefined {
    const row = this.db.prepare(`${LOG_SELECT} WHERE l.id = ?`).get(id) as Row | undefined;
    return row && toLogEntry(row);
  }

  /** Most recent entries, oldest first. */
  recentLog(campaignId: string, limit: number): LogEntry[] {
    const rows = this.db
      .prepare(`${LOG_SELECT} WHERE l.campaign_id = ? ORDER BY l.id DESC LIMIT ?`)
      .all(campaignId, limit) as Row[];
    return rows.reverse().map(toLogEntry);
  }
}

let lastStamp = 0;
/** ISO timestamps that never repeat within the process, so "shared after read" comparisons and ordering are exact. */
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

const WIKI_SELECT = `
  SELECT p.id, p.campaign_id, p.title, p.aliases, p.category, p.tags, p.file_id, p.body, p.secret, p.audience,
         p.created_at, p.updated_at, p.edited_at, f.filename, u.display_name AS author_name
  FROM wiki_pages p LEFT JOIN files f ON f.id = p.file_id LEFT JOIN users u ON u.id = p.author_user_id`;

const HANDOUT_SELECT = `
  SELECT h.id, h.campaign_id, h.title, h.text, h.file_id, h.audience, h.revised_at, h.created_at, f.filename
  FROM handouts h LEFT JOIN files f ON f.id = h.file_id`;

const TRACK_SELECT = `
  SELECT t.id, t.campaign_id, t.name, t.file_id, t.kind, t.loop, t.volume, t.duration, f.filename
  FROM tracks t JOIN files f ON f.id = t.file_id`;

const SCENE_SELECT = `
  SELECT s.id, s.campaign_id, s.name, s.width, s.height, s.grid, s.fog_enabled, s.fog, s.map, f.filename
  FROM scenes s LEFT JOIN files f ON f.id = s.file_id`;

const TOKEN_SELECT = `
  SELECT id, scene_id, name, color, col, row, size, hidden, owner_user_id, character_id FROM tokens`;

const TEMPLATE_SELECT = `SELECT id, scene_id, token_id, owner_user_id, data FROM templates`;

const LOG_SELECT = `
  SELECT l.id, l.kind, l.visibility, l.payload, l.created_at, l.user_id, u.display_name,
         COALESCE(m.role, 'player') AS role
  FROM log_entries l
  JOIN users u ON u.id = l.user_id
  LEFT JOIN campaign_members m ON m.campaign_id = l.campaign_id AND m.user_id = l.user_id`;

function toLogEntry(row: Row): LogEntry {
  return {
    id: Number(row.id),
    at: row.created_at as string,
    kind: row.kind as LogEntry['kind'],
    visibility: row.visibility as Visibility,
    author: { userId: row.user_id as string, name: row.display_name as string, role: row.role as Role },
    ...JSON.parse(row.payload as string),
  } as LogEntry;
}
