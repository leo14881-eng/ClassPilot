// SQLite storage (Node's built-in node:sqlite, no extra packages). One file in dataDir.
// Rows keep a few indexed columns plus the full record as JSON, so the schema stays small.
// Audio files are stored on disk under dataDir/audio/<sessionId>/<index>.<ext>.

import { DatabaseSync } from 'node:sqlite';
import type { ClassSession, Line, ReviewItem, SessionReview } from '../shared/types';

export interface AudioRow {
  id: string;
  sessionId: string;
  index: number;
  startedAt: number;
  mime: string;
  path: string;
  transcript: string | null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lines (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, t INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS lines_session ON lines(session_id, t);
      CREATE TABLE IF NOT EXISTS reviews (session_id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, kind_key TEXT NOT NULL, due INTEGER NOT NULL, mastered INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS items_due ON items(mastered, due);
      CREATE UNIQUE INDEX IF NOT EXISTS items_kind_key ON items(kind_key);
      CREATE TABLE IF NOT EXISTS audio (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, idx INTEGER NOT NULL, started_at INTEGER NOT NULL, mime TEXT NOT NULL, path TEXT NOT NULL, transcript TEXT);
      CREATE INDEX IF NOT EXISTS audio_session ON audio(session_id, idx);
    `);
  }

  kvGet<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }
  kvSet(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  putSession(s: ClassSession): void {
    this.db
      .prepare('INSERT INTO sessions(id, started_at, status, json) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, json = excluded.json')
      .run(s.id, s.startedAt, s.status, JSON.stringify(s));
  }
  getSession(id: string): ClassSession | undefined {
    const r = this.db.prepare('SELECT json FROM sessions WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }
  /** Classes not in the bin, newest first. */
  listSessions(limit = 100): ClassSession[] {
    return this.allSessions().filter((s) => !s.deletedAt).slice(0, limit);
  }
  /** Classes in the bin, most recently deleted first. */
  deletedSessions(): ClassSession[] {
    return this.allSessions()
      .filter((s) => s.deletedAt)
      .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  }
  private allSessions(): ClassSession[] {
    return (this.db.prepare('SELECT json FROM sessions ORDER BY started_at DESC').all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }
  /** Permanently remove a class and its lines, review and audio rows (audio files are removed by the caller). */
  purgeSession(id: string): void {
    for (const t of ['lines', 'audio']) this.db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id);
    this.db.prepare('DELETE FROM reviews WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(`bin-items:${id}`);
  }
  sessionsWithStatus(status: ClassSession['status']): ClassSession[] {
    return (this.db.prepare('SELECT json FROM sessions WHERE status = ? ORDER BY started_at').all(status) as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  putLine(l: Line): void {
    this.db
      .prepare('INSERT INTO lines(id, session_id, t, json) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(l.id, l.sessionId, l.t, JSON.stringify(l));
  }
  getLine(id: string): Line | undefined {
    const r = this.db.prepare('SELECT json FROM lines WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }
  linesFor(sessionId: string): Line[] {
    return (this.db.prepare('SELECT json FROM lines WHERE session_id = ? ORDER BY t').all(sessionId) as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  putReview(r: SessionReview): void {
    this.db.prepare('INSERT INTO reviews(session_id, json) VALUES(?, ?) ON CONFLICT(session_id) DO UPDATE SET json = excluded.json').run(r.sessionId, JSON.stringify(r));
  }
  getReview(sessionId: string): SessionReview | undefined {
    const r = this.db.prepare('SELECT json FROM reviews WHERE session_id = ?').get(sessionId) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }

  /** Inserts items; an item whose type+text already exists is skipped (returns how many were new). */
  addItems(items: ReviewItem[]): number {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO items(id, kind_key, due, mastered, json) VALUES(?, ?, ?, ?, ?)');
    let added = 0;
    for (const i of items) {
      const res = stmt.run(i.id, `${i.type}|${i.en.toLowerCase().trim()}`, i.due, i.mastered ? 1 : 0, JSON.stringify(i));
      added += Number(res.changes);
    }
    return added;
  }
  /** Remove a class's review items from the queue and return them (kept by the caller for restore). */
  takeItemsForSession(sessionId: string): ReviewItem[] {
    const rows = (this.db.prepare("SELECT json FROM items WHERE json_extract(json, '$.source.sessionId') = ?").all(sessionId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as ReviewItem,
    );
    this.db.prepare("DELETE FROM items WHERE json_extract(json, '$.source.sessionId') = ?").run(sessionId);
    return rows;
  }
  updateItem(i: ReviewItem): void {
    this.db.prepare('UPDATE items SET due = ?, mastered = ?, json = ? WHERE id = ?').run(i.due, i.mastered ? 1 : 0, JSON.stringify(i), i.id);
  }
  getItem(id: string): ReviewItem | undefined {
    const r = this.db.prepare('SELECT json FROM items WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : undefined;
  }
  allItems(): ReviewItem[] {
    return (this.db.prepare('SELECT json FROM items ORDER BY due').all() as { json: string }[]).map((r) => JSON.parse(r.json));
  }
  dueItems(now: number, limit = 50): ReviewItem[] {
    return (this.db.prepare('SELECT json FROM items WHERE mastered = 0 AND due <= ? ORDER BY due LIMIT ?').all(now, limit) as { json: string }[]).map((r) => JSON.parse(r.json));
  }
  itemCounts(): { total: number; mastered: number } {
    const r = this.db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(mastered), 0) AS mastered FROM items').get() as { total: number; mastered: number };
    return { total: Number(r.total), mastered: Number(r.mastered) };
  }

  putAudio(a: AudioRow): void {
    this.db
      .prepare(
        'INSERT INTO audio(id, session_id, idx, started_at, mime, path, transcript) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, path = excluded.path, transcript = excluded.transcript',
      )
      .run(a.id, a.sessionId, a.index, a.startedAt, a.mime, a.path, a.transcript);
  }
  audioFor(sessionId: string): AudioRow[] {
    return (this.db.prepare('SELECT * FROM audio WHERE session_id = ? ORDER BY idx').all(sessionId) as Record<string, unknown>[]).map(toAudio);
  }
  audioOlderThan(ts: number): AudioRow[] {
    return (this.db.prepare('SELECT * FROM audio WHERE started_at < ?').all(ts) as Record<string, unknown>[]).map(toAudio);
  }
  deleteAudioRow(id: string): void {
    this.db.prepare('DELETE FROM audio WHERE id = ?').run(id);
  }

  exportAll(): Record<string, unknown> {
    const all = (table: string) => (this.db.prepare(`SELECT json FROM ${table}`).all() as { json: string }[]).map((r) => JSON.parse(r.json));
    return { exportedAt: new Date().toISOString(), sessions: all('sessions'), lines: all('lines'), reviews: all('reviews'), items: all('items') };
  }
}

function toAudio(r: Record<string, unknown>): AudioRow {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    index: Number(r.idx),
    startedAt: Number(r.started_at),
    mime: String(r.mime),
    path: String(r.path),
    transcript: r.transcript === null || r.transcript === undefined ? null : String(r.transcript),
  };
}
