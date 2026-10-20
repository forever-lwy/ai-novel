type ImageEntry = {
  controller: AbortController;
  ready: Promise<string>;
  url?: string;
  bytes: number;
  users: number;
  failed?: boolean;
};

/** Session-local pixel cache. Visible images stay pinned; idle images use a bounded LRU. */
export class ImageContentCache {
  private entries = new Map<string, ImageEntry>();

  constructor(private maxEntries = 96, private maxBytes = 64 * 1024 * 1024) {}

  peek(key: string) {
    const entry = this.entries.get(key);
    return entry?.failed ? undefined : entry?.url;
  }

  acquire(key: string, source: string) {
    let entry = this.entries.get(key);
    if (entry?.failed) entry = undefined;
    if (!entry) {
      const controller = new AbortController();
      const created: ImageEntry = { controller, ready: Promise.resolve(''), bytes: 0, users: 0 };
      created.ready = Promise.resolve().then(async () => {
        const response = await fetch(source, { credentials: 'same-origin', cache: 'no-cache', signal: controller.signal });
        if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('story-session-ended'));
        if (!response.ok) throw new Error(`图片加载失败（${response.status}）`);
        const blob = await response.blob();
        controller.signal.throwIfAborted();
        if (!blob.size || !blob.type.startsWith('image/')) throw new Error('图片内容无效');
        const url = URL.createObjectURL(blob);
        created.url = url; created.bytes = blob.size;
        this.trim();
        return url;
      }).catch(error => {
        created.failed = true;
        if (this.entries.get(key) === created) this.entries.delete(key);
        throw error;
      });
      entry = created;
    }
    entry.users++;
    this.entries.delete(key); this.entries.set(key, entry);
    const held = entry; let released = false;
    return {
      url: held.url, ready: held.ready,
      release: () => {
        if (released) return; released = true; held.users--;
        if (held.failed && !held.users) this.dispose(held);
        this.trim();
      },
    };
  }

  invalidate(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); entry.failed = true; entry.controller.abort();
    if (!entry.users) this.dispose(entry);
  }

  private dispose(entry: ImageEntry) {
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = undefined;
  }

  private trim() {
    const idle = [...this.entries].filter(([, entry]) => !entry.users && entry.url);
    let bytes = idle.reduce((total, [, entry]) => total + entry.bytes, 0);
    let count = idle.length;
    for (const [key, entry] of idle) {
      if (count <= this.maxEntries && bytes <= this.maxBytes) break;
      this.entries.delete(key); bytes -= entry.bytes; count--; this.dispose(entry);
    }
  }

  clear() {
    for (const entry of this.entries.values()) this.dispose(entry);
    this.entries.clear();
  }
}
