// Class recordings kept on the phone (IndexedDB), not uploaded during class: uploading the whole class over
// mobile data doubled the data use. The after-class review uses the live captions; the recording can be
// uploaded later (on Wi-Fi) from the review page for a recording-based review. Old recordings are removed
// after the "keep audio" setting's number of days.

export interface LocalChunk {
  key: string; // `${sessionId}/${index}`
  sessionId: string;
  index: number;
  startedAt: number;
  savedAt: number;
  blob: Blob;
}

const DB = 'classpilot-audio';
const STORE = 'chunks';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' }).createIndex('session', 'sessionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise<T | undefined>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
    t.onerror = () => reject(t.error);
  }).finally(() => db.close());
}

export async function saveChunk(sessionId: string, index: number, startedAt: number, blob: Blob): Promise<void> {
  await tx('readwrite', (s) => s.put({ key: `${sessionId}/${index}`, sessionId, index, startedAt, savedAt: Date.now(), blob } satisfies LocalChunk));
}

export async function chunksFor(sessionId: string): Promise<LocalChunk[]> {
  try {
    const all = (await tx<LocalChunk[]>('readonly', (s) => s.index('session').getAll(sessionId))) ?? [];
    return all.sort((a, b) => a.index - b.index);
  } catch {
    return [];
  }
}

export async function deleteChunks(sessionId: string): Promise<void> {
  const list = await chunksFor(sessionId);
  await tx('readwrite', (s) => list.forEach((c) => s.delete(c.key)));
}

/** Remove recordings older than `days` (0 = keep none once the class is over). */
export async function cleanupLocal(days: number): Promise<void> {
  try {
    const all = (await tx<LocalChunk[]>('readonly', (s) => s.getAll())) ?? [];
    const cutoff = Date.now() - Math.max(0, days) * 86_400_000;
    const old = all.filter((c) => c.savedAt < cutoff);
    if (old.length) await tx('readwrite', (s) => old.forEach((c) => s.delete(c.key)));
  } catch {
    /* storage unavailable: nothing to clean */
  }
}
