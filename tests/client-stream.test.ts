import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, streamJob } from '../client/api.js';

afterEach(() => vi.unstubAllGlobals());
describe('author writing stream client', () => {
  it('joins fragmented UTF-8 and SSE frames without duplicating snapshot or deltas', async () => {
    const encoder = new TextEncoder(); const source = ': heartbeat\r\n\r\ndata: {"type":"snapshot","text":"林舟"}\r\n\r\ndata: {"type":"delta","text":"进入古城。"}\n\ndata: {"type":"status","status":"completed"}\n\n';
    const bytes = encoder.encode(source); const received: unknown[] = [];
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      // Individual bytes force both multibyte characters and delimiters across reads.
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetcher); const controller = new AbortController();
    await streamJob('writing-job', controller.signal, event => received.push(event));
    expect(fetcher).toHaveBeenCalledWith('/api/jobs/writing-job/events?view=author', expect.objectContaining({ credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'text/event-stream' } }));
    expect(received).toEqual([{ type: 'snapshot', text: '林舟' }, { type: 'delta', text: '进入古城。' }, { type: 'status', status: 'completed' }]);
  });
  it('stops delivering frames when leaving the author or branch view aborts the subscription', async () => {
    const controller = new AbortController(); const received: unknown[] = []; const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('data: {"text":"第一段"}\n\ndata: {"text":"迟到的秘密"}\n\n')); }, cancel }))));
    await streamJob('old-branch-job', controller.signal, event => { received.push(event); controller.abort(); });
    expect(received).toEqual([{ text: '第一段' }]); expect(cancel).toHaveBeenCalled();
  });
  it('surfaces the author access error before trying to parse SSE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '需要作者视图' }), { status: 403, headers: { 'Content-Type': 'application/json' } })));
    await expect(streamJob('secret-job', new AbortController().signal, vi.fn())).rejects.toEqual(new ApiError('需要作者视图', 403));
  });
});
