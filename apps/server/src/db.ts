import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

// Append-only: each entry runs once, tracked by PRAGMA user_version.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE campaign_members (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('gm', 'player')),
    joined_at TEXT NOT NULL DEFAULT ${NOW},
    PRIMARY KEY (campaign_id, user_id)
  );
  CREATE TABLE displays (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    pairing_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT 'Table display',
    campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE log_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    visibility TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX log_entries_by_campaign ON log_entries (campaign_id, id);
  `,
  `
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  `,
  `
  CREATE TABLE scenes (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    grid TEXT NOT NULL,
    fog_enabled INTEGER NOT NULL DEFAULT 0,
    fog TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX scenes_by_campaign ON scenes (campaign_id, created_at);
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    col INTEGER NOT NULL,
    row INTEGER NOT NULL,
    size INTEGER NOT NULL DEFAULT 1,
    hidden INTEGER NOT NULL DEFAULT 0,
    owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX tokens_by_scene ON tokens (scene_id, created_at);
  ALTER TABLE campaigns ADD COLUMN active_scene_id TEXT REFERENCES scenes(id) ON DELETE SET NULL;
  `,
  `
  CREATE TABLE characters (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX characters_by_campaign ON characters (campaign_id);
  ALTER TABLE tokens ADD COLUMN character_id TEXT REFERENCES characters(id) ON DELETE SET NULL;
  `,
  `
  ALTER TABLE scenes ADD COLUMN map TEXT NOT NULL DEFAULT '';
  `,
  `
  CREATE TABLE encounters (
    campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT ${NOW}
  );
  `,
  `
  CREATE TABLE handouts (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
    audience TEXT NOT NULL DEFAULT 'gm' CHECK (audience IN ('gm', 'all', 'players')),
    revised_at TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX handouts_by_campaign ON handouts (campaign_id, created_at);
  CREATE TABLE handout_recipients (
    handout_id TEXT NOT NULL REFERENCES handouts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (handout_id, user_id)
  );
  CREATE TABLE handout_reads (
    handout_id TEXT NOT NULL REFERENCES handouts(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at TEXT NOT NULL,
    PRIMARY KEY (handout_id, user_id)
  );
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
