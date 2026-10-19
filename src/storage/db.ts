// Minimal promise wrapper around IndexedDB. One database, a few object stores:
//   kv        - settings and small flags (key -> value)
//   sessions  - ClassSession
//   lines     - Line            (index: sessionId)
//   reviews   - SessionReview   (key: sessionId)
//   items     - ReviewItem      (index: due)
//   audio     - AudioChunk      (index: sessionId)
// Only what a screen needs is loaded: lines and audio are always queried by session.

import type { AudioChunk, ClassSession, Line, ReviewItem, SessionReview } from '../types';

const DB_NAME = 'classpilot';
const DB_VERSION = 1;

type StoreName = 'kv' | 'sessions' | 'lines' | 'reviews' | 'items' | 'audio';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('lines')) {
        db.createObjectStore('lines', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      }
      if (!db.objectStoreNames.contains('reviews')) db.createObjectStore('reviews', { keyPath: 'sessionId' });
      if (!db.objectStoreNames.contains('items')) {
        db.createObjectStore('items', { keyPath: 'id' }).createIndex('due', 'due');
      }
      if (!db.objectStoreNames.contains('audio')) {
        db.createObjectStore('audio', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async kvGet<T>(key: string): Promise<T | undefined> {
    return wrap((await store('kv')).get(key)) as Promise<T | undefined>;
  },
  async kvSet(key: string, value: unknown): Promise<void> {
    await wrap((await store('kv', 'readwrite')).put(value, key));
  },

  async putSession(s: ClassSession): Promise<void> {
    await wrap((await store('sessions', 'readwrite')).put(s));
  },
  async getSession(id: string): Promise<ClassSession | undefined> {
    return wrap((await store('sessions')).get(id));
  },
  async listSessions(): Promise<ClassSession[]> {
    const all = await wrap((await store('sessions')).getAll());
    return (all as ClassSession[]).sort((a, b) => b.startedAt - a.startedAt);
  },

  async putLine(l: Line): Promise<void> {
    await wrap((await store('lines', 'readwrite')).put(l));
  },
  async linesFor(sessionId: string): Promise<Line[]> {
    const s = await store('lines');
    const rows = (await wrap(s.index('sessionId').getAll(sessionId))) as Line[];
    return rows.sort((a, b) => a.t - b.t);
  },

  async putReview(r: SessionReview): Promise<void> {
    await wrap((await store('reviews', 'readwrite')).put(r));
  },
  async getReview(sessionId: string): Promise<SessionReview | undefined> {
    return wrap((await store('reviews')).get(sessionId));
  },

  async putItems(items: ReviewItem[]): Promise<void> {
    const s = await store('items', 'readwrite');
    await Promise.all(items.map((i) => wrap(s.put(i))));
  },
  async allItems(): Promise<ReviewItem[]> {
    return wrap((await store('items')).getAll()) as Promise<ReviewItem[]>;
  },

  async putAudio(a: AudioChunk): Promise<void> {
    await wrap((await store('audio', 'readwrite')).put(a));
  },
  async audioFor(sessionId: string): Promise<AudioChunk[]> {
    const s = await store('audio');
    const rows = (await wrap(s.index('sessionId').getAll(sessionId))) as AudioChunk[];
    return rows.sort((a, b) => a.index - b.index);
  },
  async deleteAudio(ids: string[]): Promise<void> {
    const s = await store('audio', 'readwrite');
    await Promise.all(ids.map((id) => wrap(s.delete(id))));
  },
  async allAudioMeta(): Promise<{ id: string; sessionId: string; startedAt: number }[]> {
    const rows = (await wrap((await store('audio')).getAll())) as AudioChunk[];
    return rows.map(({ id, sessionId, startedAt }) => ({ id, sessionId, startedAt }));
  },

  /** Everything except audio, for the JSON backup in Settings. */
  async exportAll(): Promise<Record<string, unknown>> {
    const [sessions, reviews, items] = await Promise.all([
      wrap((await store('sessions')).getAll()),
      wrap((await store('reviews')).getAll()),
      wrap((await store('items')).getAll()),
    ]);
    const lines = await wrap((await store('lines')).getAll());
    return { version: DB_VERSION, exportedAt: new Date().toISOString(), sessions, lines, reviews, items };
  },
  async importAll(data: { sessions?: ClassSession[]; lines?: Line[]; reviews?: SessionReview[]; items?: ReviewItem[] }): Promise<void> {
    for (const s of data.sessions ?? []) await db.putSession(s);
    for (const l of data.lines ?? []) await db.putLine(l);
    for (const r of data.reviews ?? []) await db.putReview(r);
    await db.putItems(data.items ?? []);
  },
};

/** Ask the browser not to evict our data (Safari may otherwise clear unused sites). */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
