import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageContentCache } from '../client/image-cache';
import { viewCacheKey } from '../client/workspace-cache';

const response = (size = 4) => new Response(new Blob(['x'.repeat(size)], { type: 'image/png' }));
let fetcher: ReturnType<typeof vi.fn>;
let createUrl: ReturnType<typeof vi.spyOn>;
let revokeUrl: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetcher = vi.fn(async () => response()); vi.stubGlobal('fetch', fetcher);
  let sequence = 0;
  createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:fixture-${++sequence}`);
  revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('workspace image content cache', () => {
  it('shares both in-flight requests and object URLs across thumbnails, references and viewers', async () => {
    const cache = new ImageContentCache();
    const thumbnail = cache.acquire('same-scope-image', '/image');
    const viewer = cache.acquire('same-scope-image', '/image');
    expect(await thumbnail.ready).toBe(await viewer.ready);
    thumbnail.release(); viewer.release();
    const reference = cache.acquire('same-scope-image', '/image');
    expect(reference.url).toBe('blob:fixture-1'); expect(await reference.ready).toBe(reference.url);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(createUrl).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith('/image', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    reference.release(); cache.clear(); expect(revokeUrl).toHaveBeenCalledWith('blob:fixture-1');
  });

  it('does not share an image across author, chapter, branch, project or revision boundaries', async () => {
    const cache = new ImageContentCache();
    const scopes = [
      ['project', viewCacheKey('branch', 'v1', true, 'first')],
      ['project', viewCacheKey('branch', 'v1', false, 'first')],
      ['project', viewCacheKey('branch', 'v1', false, 'second')],
      ['project', viewCacheKey('branch', 'v2', true, 'first')],
      ['project', viewCacheKey('other-branch', 'v1', true, 'first')],
      ['other-project', viewCacheKey('branch', 'v1', true, 'first')],
    ];
    for (const scope of scopes) {
      const lease = cache.acquire(JSON.stringify([JSON.stringify(scope), '/image']), '/image');
      await lease.ready; lease.release();
    }
    expect(fetcher).toHaveBeenCalledTimes(scopes.length); cache.clear();
  });

  it('does not cache network failures, refused access, empty content or non-image responses', async () => {
    const cache = new ImageContentCache();
    fetcher.mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('', { status: 403 }))
      .mockResolvedValueOnce(new Response(new Blob([], { type: 'image/png' })))
      .mockResolvedValueOnce(new Response('login page', { headers: { 'Content-Type': 'text/html' } }));
    for (let i = 0; i < 4; i++) {
      const lease = cache.acquire('key', '/image');
      await expect(lease.ready).rejects.toThrow(); lease.release(); expect(cache.peek('key')).toBeUndefined();
    }
    expect(fetcher).toHaveBeenCalledTimes(4); // No automatic retry.
    const retry = cache.acquire('key', '/image'); await expect(retry.ready).resolves.toBe('blob:fixture-1');
    retry.release(); cache.clear();
  });

  it('evicts idle images by recency and count without revoking an open viewer', async () => {
    const cache = new ImageContentCache(1, 100);
    const open = cache.acquire('open', '/open'); await open.ready;
    const first = cache.acquire('first', '/first'); await first.ready; first.release();
    const second = cache.acquire('second', '/second'); await second.ready; second.release();
    expect(cache.peek('first')).toBeUndefined(); expect(cache.peek('second')).toBeTruthy();
    expect(cache.peek('open')).toBe(open.url ?? await open.ready);
    expect(revokeUrl).not.toHaveBeenCalledWith(await open.ready);
    const again = cache.acquire('second', '/second'); again.release();
    open.release(); expect(cache.peek('open')).toBeUndefined(); expect(cache.peek('second')).toBeTruthy();
    cache.clear();
  });

  it('bounds idle bytes and releases an oversized image after its last visible use', async () => {
    const cache = new ImageContentCache(10, 6);
    const first = cache.acquire('first', '/first'); await first.ready; first.release();
    const second = cache.acquire('second', '/second'); await second.ready; second.release();
    expect(cache.peek('first')).toBeUndefined(); expect(cache.peek('second')).toBeTruthy();
    fetcher.mockResolvedValueOnce(response(8));
    const large = cache.acquire('large', '/large'); await large.ready;
    const otherUse = cache.acquire('large', '/large'); large.release();
    expect(cache.peek('large')).toBeTruthy(); otherUse.release();
    expect(cache.peek('large')).toBeUndefined(); expect(revokeUrl).toHaveBeenCalledWith(await large.ready);
    cache.clear();
  });

  it('keeps a download shared while switching pages before it completes', async () => {
    const cache = new ImageContentCache(); let complete!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    const first = cache.acquire('key', '/image'); await Promise.resolve(); first.release();
    const next = cache.acquire('key', '/image'); complete(response());
    expect(await next.ready).toBe(await first.ready); expect(fetcher).toHaveBeenCalledTimes(1);
    next.release(); cache.clear();
  });

  it('aborts and ignores late downloads when leaving the workspace', async () => {
    const cache = new ImageContentCache(); let complete!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    const old = cache.acquire('key', '/image'); await Promise.resolve(); cache.clear();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    const next = cache.acquire('key', '/image'); await next.ready;
    complete(response()); await expect(old.ready).rejects.toThrow();
    expect(cache.peek('key')).toBe(await next.ready); expect(createUrl).toHaveBeenCalledTimes(1);
    old.release(); next.release(); cache.clear();
  });

  it('forgets undecodable images and releases their URLs after visible consumers leave', async () => {
    const cache = new ImageContentCache();
    const broken = cache.acquire('key', '/image'); await broken.ready;
    cache.invalidate('key'); expect(cache.peek('key')).toBeUndefined();
    expect(revokeUrl).not.toHaveBeenCalled();
    const retry = cache.acquire('key', '/image'); await retry.ready;
    broken.release(); expect(revokeUrl).toHaveBeenCalledWith(await broken.ready);
    expect(cache.peek('key')).toBe(await retry.ready);
    retry.release(); cache.clear();
  });
});
