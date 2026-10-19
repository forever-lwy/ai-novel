import { describe, expect, it, vi } from 'vitest';
import { ResourceCache, chapterCacheKey, viewCacheKey } from '../client/workspace-cache';

describe('workspace navigation cache', () => {
  it('isolates reader chapters, author data, story lines and revisions', () => {
    const cache = new ResourceCache<string>(8, 4096);
    const key = viewCacheKey('branch', 'revision', false, 'first');
    cache.set(key, 'only the first chapter materials');
    expect(cache.get(key)).toBe('only the first chapter materials');
    for (const other of [
      viewCacheKey('branch', 'revision', true, 'first'),
      viewCacheKey('branch', 'revision', false, 'second'),
      viewCacheKey('branch', 'new-revision', false, 'first'),
      viewCacheKey('other-branch', 'revision', false, 'first'),
    ]) expect(cache.get(other)).toBeUndefined();
    expect(chapterCacheKey('branch', 'first')).not.toBe(chapterCacheKey('other-branch', 'first'));
  });

  it('shares an in-flight request and reuses a successful chapter on return', async () => {
    const cache = new ResourceCache<string>(2, 4096);
    let finish!: (value: string) => void;
    const loader = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const first = cache.load('chapter', loader); const second = cache.load('chapter', loader);
    await Promise.resolve(); finish('saved prose');
    expect(await first).toBe('saved prose'); expect(await second).toBe('saved prose');
    expect(await cache.load('chapter', loader)).toBe('saved prose'); expect(loader).toHaveBeenCalledTimes(1);
  });

  it('does not retain failures or responses from an unexpected revision', async () => {
    const cache = new ResourceCache<string>(2, 4096);
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('recovered');
    await expect(cache.load('chapter', loader)).rejects.toThrow('offline');
    expect(await cache.load('chapter', loader)).toBe('recovered'); expect(loader).toHaveBeenCalledTimes(2);
    await cache.load('old-revision', async () => 'new-revision', false, value => value === 'old-revision');
    expect(cache.get('old-revision')).toBeUndefined();
  });

  it('bounds retained entries and text, evicting the least recently used entry', () => {
    const cache = new ResourceCache<string>(2, 32);
    cache.set('first', 'one'); cache.set('second', 'two'); cache.get('first'); cache.set('third', 'three');
    expect(cache.get('second')).toBeUndefined(); expect(cache.get('first')).toBe('one');
    cache.set('large', 'x'.repeat(100)); expect(cache.get('large')).toBeUndefined();
    expect(cache.get('first')).toBe('one');
    cache.set('third', 'x'.repeat(12));
    expect(cache.get('first')).toBeUndefined(); expect(cache.get('third')).toBe('x'.repeat(12));
  });

  it('can refresh an existing entry without discarding it during the request', async () => {
    const cache = new ResourceCache<string>(2, 4096); cache.set('chapter', 'old');
    let finish!: (value: string) => void;
    const pending = cache.load('chapter', () => new Promise<string>(resolve => { finish = resolve; }), true);
    await Promise.resolve(); expect(cache.get('chapter')).toBe('old'); finish('latest');
    expect(await pending).toBe('latest'); expect(cache.get('chapter')).toBe('latest');
  });
});
