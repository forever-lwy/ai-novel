/** Bounded memory cache, with optional session-scoped browser persistence. */
export class ResourceCache<T> {
  private values = new Map<string, { value: T; size: number }>();
  private pending = new Map<string, Promise<T>>();
  private size = 0;
  private generation = 0;

  constructor(private maxEntries: number, private maxSize: number, private storage?: { get(key: string): Promise<T | undefined>; set(key: string, value: T): void }) {}

  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key); this.values.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, persist = true) {
    const previous = this.values.get(key);
    if (previous?.value === value) return;
    if (previous) { this.values.delete(key); this.size -= previous.size; }
    // UTF-16 text size is a conservative budget for the JSON payload, not a heap measurement.
    const size = JSON.stringify(value).length * 2;
    if (size > this.maxSize) return;
    this.values.set(key, { value, size }); this.size += size;
    if (persist) this.storage?.set(key, value);
    while (this.values.size > this.maxEntries || this.size > this.maxSize) {
      const oldest = this.values.keys().next().value!;
      this.size -= this.values.get(oldest)!.size; this.values.delete(oldest);
    }
  }
  async read(key: string): Promise<T | undefined> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const generation = this.generation;
    const value = await this.storage?.get(key).catch(() => undefined);
    if (generation !== this.generation) return undefined;
    if (value !== undefined) this.set(key, value, false);
    return value;
  }

  load(key: string, loader: () => Promise<T>, refresh = false, accept: (value: T) => boolean = () => true): Promise<T> {
    const cached = !refresh ? this.get(key) : undefined;
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const request = Promise.resolve().then(() => !refresh && this.storage
      ? this.read(key).then(stored => stored !== undefined ? stored : loader())
      : loader()).then(value => {
      if (generation === this.generation && accept(value)) this.set(key, value);
      return value;
    }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }
  clear() { this.generation++; this.values.clear(); this.pending.clear(); this.size = 0; }
}

/** Reader materials must never share an entry with author materials or another chapter boundary. */
export function viewCacheKey(branchId: string, revisionId: string, author: boolean, chapterId: string | null) {
  return JSON.stringify([branchId, revisionId, author ? 'author' : 'reader', author ? null : chapterId]);
}

export function chapterCacheKey(branchId: string, chapterId: string) { return JSON.stringify([branchId, chapterId]); }
