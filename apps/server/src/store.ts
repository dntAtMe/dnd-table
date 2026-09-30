import { randomUUID } from 'node:crypto';
import type { CampaignSummary, CharacterRecord, LogEntry, Role, SceneSummary, Token, User, Visibility } from '@dnd/protocol';
import type { Character, Grid } from '@dnd/rules';
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
}

type Row = Record<string, unknown>;

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
    };
  }

  createScene(scene: Omit<SceneRecord, 'id' | 'imageUrl'> & { fileId: string | null }): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO scenes (id, campaign_id, name, file_id, width, height, grid, fog_enabled, fog)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  updateScene(id: string, patch: Partial<Pick<SceneRecord, 'name' | 'grid' | 'fogEnabled' | 'fog'>>): void {
    const sets: string[] = [];
    const values: (string | number)[] = [];
    if (patch.name !== undefined) sets.push('name = ?'), values.push(patch.name);
    if (patch.grid !== undefined) sets.push('grid = ?'), values.push(JSON.stringify(patch.grid));
    if (patch.fogEnabled !== undefined) sets.push('fog_enabled = ?'), values.push(patch.fogEnabled ? 1 : 0);
    if (patch.fog !== undefined) sets.push('fog = ?'), values.push(patch.fog);
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

const SCENE_SELECT = `
  SELECT s.id, s.campaign_id, s.name, s.width, s.height, s.grid, s.fog_enabled, s.fog, f.filename
  FROM scenes s LEFT JOIN files f ON f.id = s.file_id`;

const TOKEN_SELECT = `
  SELECT id, scene_id, name, color, col, row, size, hidden, owner_user_id, character_id FROM tokens`;

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
