type Entry = { key: string; scope: string; project: string; size: number; used: number };
const databaseName = 'ai-novel-cache-v1';

/** Optional, bounded read cache. Storage errors never prevent opening server content. */
export class PersistentCache {
  private connection?: Promise<IDBDatabase | undefined>;
  private live = true;
  constructor(readonly scope: string, private maxBytes = 48 * 1024 * 1024, private maxEntries = 256) {}

  private open() {
    if (this.connection) return this.connection;
    this.connection = new Promise<IDBDatabase | undefined>(resolve => {
      try { if (typeof indexedDB === 'undefined') { resolve(undefined); return; } } catch { resolve(undefined); return; }
      let settled = false;
      const finish = (db?: IDBDatabase) => {
        if (settled) { db?.close(); return; }
        settled = true; clearTimeout(timer); resolve(db);
      };
      const timer = setTimeout(() => finish(), 1500);
      try {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('values');
          request.result.createObjectStore('entries', { keyPath: 'key' });
        };
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); finish(request.result); };
        request.onerror = () => finish();
        request.onblocked = () => finish();
      } catch { finish(); }
    });
    return this.connection;
  }

  storage<T>(project: string, kind: string) {
    const key = (id: string) => JSON.stringify([this.scope, project, kind, id]);
    return {
      get: (id: string) => this.get<T>(key(id)),
      set: (id: string, value: T) => { void this.set(key(id), project, value); },
    };
  }

  private async get<T>(key: string): Promise<T | undefined> {
    const db = await this.open();
    if (!db || !this.live) return undefined;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(['values', 'entries'], 'readwrite');
        const request = tx.objectStore('values').get(key);
        const meta = tx.objectStore('entries').get(key);
        meta.onsuccess = () => { if (meta.result) tx.objectStore('entries').put({ ...meta.result, used: Date.now() }); };
        tx.oncomplete = () => resolve(this.live ? request.result as T | undefined : undefined);
        tx.onerror = tx.onabort = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }

  private async set(key: string, project: string, value: unknown) {
    let size: number;
    try { size = JSON.stringify(value).length * 2; } catch { return; }
    if (size > this.maxBytes / 2) return;
    const db = await this.open();
    if (!db || !this.live) return;
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(['values', 'entries'], 'readwrite');
        const entries = tx.objectStore('entries'); const values = tx.objectStore('values');
        entries.put({ key, scope: this.scope, project, size, used: Date.now() } satisfies Entry);
        values.put(value, key);
        const request = entries.getAll();
        request.onsuccess = () => {
          const items = (request.result as Entry[]).sort((a, b) => a.used - b.used);
          let bytes = items.reduce((sum, item) => sum + item.size, 0); let count = items.length;
          for (const item of items) {
            if (item.scope === this.scope && bytes <= this.maxBytes && count <= this.maxEntries) continue;
            entries.delete(item.key); values.delete(item.key); bytes -= item.size; count--;
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => resolve();
      } catch { resolve(); }
    });
  }

  async remove(project?: string, otherScopes = false) {
    if (!project && !otherScopes) this.live = false;
    const db = await this.open();
    if (!db) return;
    await new Promise<void>(resolve => {
      try {
        const tx = db.transaction(['values', 'entries'], 'readwrite');
        const request = tx.objectStore('entries').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const entry = cursor.value as Entry;
          if (otherScopes ? entry.scope !== this.scope : entry.scope === this.scope && (!project || entry.project === project)) {
            tx.objectStore('values').delete(entry.key); cursor.delete();
          }
          cursor.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => resolve();
      } catch { resolve(); }
    });
  }
}
