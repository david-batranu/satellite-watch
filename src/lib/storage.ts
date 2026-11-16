/**
 * Minimal key/value cache: IndexedDB first, localStorage as a fallback (private
 * mode, older browsers, or a blocked storage partition). All operations fail
 * soft — a cache miss must never break the app.
 */

const DB_NAME = 'satellite-watch';
const DB_VERSION = 1;
const STORE_NAME = 'cache';
const LS_PREFIX = 'sw:';

let dbPromise: Promise<IDBDatabase> | null = null;

function canUseIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!canUseIndexedDb()) return Promise.reject(new Error('IndexedDB unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  // Do not cache a rejected promise forever.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function lsGet<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* quota exceeded or storage disabled */
  }
}

export async function storageGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDatabase();
    const value = await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('read failed'));
    });
    if (value !== null) return value;
  } catch {
    /* fall through to localStorage */
  }
  return lsGet<T>(key);
}

export async function storageSet<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('write aborted'));
    });
    return;
  } catch {
    /* fall through to localStorage */
  }
  lsSet(key, value);
}

export async function storageDelete(key: string): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('delete failed'));
    });
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** JSON helpers used for settings and the last known location. */
export async function storageGetJson<T>(key: string): Promise<T | null> {
  return storageGet<T>(key);
}

export async function storageSetJson<T>(key: string, value: T): Promise<void> {
  await storageSet(key, value);
}
