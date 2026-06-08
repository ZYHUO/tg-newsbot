import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

export interface ItemRow {
  id: number
  feed_url: string
  category: string
  source_name: string
  url: string
  url_hash: string
  title: string
  title_norm: string
  published_at: number | null
  fetched_at: number
  status: 'pending' | 'posting' | 'posted' | 'skipped' | 'seeded' | 'failed'
  summary_json: string | null
  posted_msg_id: number | null
  fail_count: number
  next_retry_at: number | null
  /** normalized Chinese title, set when claimed — for cross-language dedup */
  title_zh_norm: string | null
  /** ms epoch the row was claimed for posting — dedup pool windows on this */
  posted_at: number | null
}

let db: Database.Database | null = null

export function getDb(path = config.dbPath): Database.Database {
  if (db) return db
  mkdirSync(dirname(path), { recursive: true })
  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_url TEXT NOT NULL,
      category TEXT NOT NULL,
      source_name TEXT NOT NULL,
      url TEXT NOT NULL,
      url_hash TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      title_norm TEXT NOT NULL,
      published_at INTEGER,
      fetched_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      summary_json TEXT,
      posted_msg_id INTEGER,
      fail_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
    CREATE INDEX IF NOT EXISTS idx_items_fetched ON items(fetched_at);
    CREATE TABLE IF NOT EXISTS feed_state (
      feed_url TEXT PRIMARY KEY,
      last_fetch_at INTEGER,
      last_ok_at INTEGER,
      etag TEXT,
      last_modified TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      seeded INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `)
  // poor-man migrations for DBs created before a column existed
  const itemCols = new Set(
    (db.prepare(`PRAGMA table_info(items)`).all() as { name: string }[]).map(c => c.name),
  )
  if (!itemCols.has('next_retry_at')) db.exec(`ALTER TABLE items ADD COLUMN next_retry_at INTEGER`)
  if (!itemCols.has('title_zh_norm')) db.exec(`ALTER TABLE items ADD COLUMN title_zh_norm TEXT`)
  if (!itemCols.has('posted_at')) db.exec(`ALTER TABLE items ADD COLUMN posted_at INTEGER`)
  return db
}

export function metaGet(db: Database.Database, k: string): string | null {
  const row = db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string } | undefined
  return row?.v ?? null
}

export function metaSet(db: Database.Database, k: string, v: string): void {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v)
}

/** test helper */
export function resetDbForTest(path: string): Database.Database {
  db = null
  return getDb(path)
}
