// Run in an isolated Node process with --expose-gc; never contacts a real provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { generateText } from '../../server/providers.ts';
import { providerFetch } from '../../server/outbound.ts';

assert.equal(typeof global.gc, 'function', 'This regression requires --expose-gc');
const protocol = process.argv[2];
const event = value => `data: ${JSON.stringify(value)}\n\n`;
function partialText() {
  if (protocol === 'openai-chat') return event({ choices: [{ delta: { content: '已收到正文。' } }], usage: { prompt_tokens: 8, completion_tokens: 5 } });
  if (protocol === 'openai-responses') return event({ type: 'response.output_text.delta', delta: '已收到正文。', usage: { input_tokens: 8, output_tokens: 5 } });
  if (protocol === 'gemini') return event({ candidates: [{ content: { parts: [{ text: '已收到正文。' }] } }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5 } });
  return event({ type: 'message_start', message: { content: [], usage: { input_tokens: 8 } } })
    + event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已收到正文。' } })
    + event({ type: 'message_delta', delta: {}, usage: { output_tokens: 5 } });
}
async function forceCollection() {
  for (let index = 0; index < 5; index++) { await nextTurn(); global.gc(); await delay(20); }
}
async function bounded(promise, ms, message) {
  const guard = new AbortController();
  try {
    return await Promise.race([promise, delay(ms, null, { signal: guard.signal }).then(() => { throw new Error(message); })]);
  } finally { guard.abort(); }
}

async function run(mode) {
  let requests = 0, capture;
  const sent = Promise.withResolvers(), closed = Promise.withResolvers();
  const server = createServer(async (incoming, response) => {
    for await (const _chunk of incoming) { /* Drain the request before sending headers. */ }
    requests++;
    response.on('close', () => closed.resolve());
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    response.flushHeaders();
    if (mode === 'idle' || mode === 'cancel') response.write(partialText());
    sent.resolve();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController(), deltas = [];
  const started = performance.now();
  try {
    if (mode === 'unmanaged') {
      const response = await providerFetch(url, { signal: controller.signal });
      const reader = response.body.getReader();
      const result = reader.read().then(() => null, error => error);
      await forceCollection(); controller.abort();
      const error = await bounded(result, 1800, 'Unmanaged response ignored abort after GC');
      assert.equal(error?.name, 'AbortError');
      reader.releaseLock();
    } else {
      const result = generateText({ id: 'fixture', name: 'GC regression', protocol, baseUrl: url, model: 'fixture', timeoutMs: 1000, stream: true, maxOutputTokens: 1000, contextTokens: 64000 }, {
        system: '只输出正文。', prompt: '本地取消测试。', signal: controller.signal,
        onResponse: value => { capture = value; }, onTextDelta: text => deltas.push(text),
      }).then(() => null, error => error);
      await bounded(sent.promise, 1800, 'Fixture never received the request');
      // Let the response reach the reader before collecting internal Request objects.
      await delay(40); await forceCollection();
      if (mode === 'cancel') controller.abort();
      const error = await bounded(result, 1800, `${protocol} ${mode}: response read stayed pending after GC`);
      assert.ok(error instanceof Error);
      assert.match(error.message, mode === 'first' ? /等待首段响应内容超时（1 秒）/ : mode === 'idle' ? /流式响应空闲超时（1 秒）/ : /模型请求已取消/);
      assert.equal(capture.diagnostics.transport, mode === 'cancel' ? 'cancelled' : 'timeout');
      assert.equal(capture.incomplete, true);
      assert.equal(capture.text, mode === 'first' ? '' : '已收到正文。');
      assert.equal(deltas.join(''), mode === 'first' ? '' : '已收到正文。');
      assert.equal(capture.inputTokens, mode === 'first' ? 0 : 8);
      assert.equal(capture.outputTokens, mode === 'first' ? 0 : 5);
    }
    await bounded(closed.promise, 800, 'Aborted response left its connection open');
    assert.equal(requests, 1, 'Abort must never retry a billable request');
    console.log(JSON.stringify({ protocol, mode, requests, elapsedMs: Math.round(performance.now() - started), connectionClosed: true }));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

try {
  for (const mode of protocol === 'unmanaged' ? ['unmanaged'] : ['first', 'idle', 'cancel']) await run(mode);
} catch (error) {
  console.error(error.stack);
  // A broken transport can leave unresolved readers; terminate only this fixture process.
  process.exit(1);
}
