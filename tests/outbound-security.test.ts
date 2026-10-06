import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { providerNetworkPolicy, checkedProviderAddresses, isPublicAddress, providerFetch } from '../server/outbound.js';
import { createSecretStreamRedactor, redactSseFragments } from '../server/stream-redaction.js';
import { generateText, redactModelPayload } from '../server/providers.js';
import type { CapturedModelResponse } from '../shared/types.js';

const servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

describe('provider network boundary', () => {
  it('restricts production addresses and preserves explicitly configured local providers', () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('PUBLIC_ORIGIN', ''); vi.stubEnv('OUTBOUND_ALLOWED_ORIGINS', '');
    expect(() => providerNetworkPolicy('http://provider.example/v1')).toThrow('HTTPS');
    expect(() => providerNetworkPolicy('https://127.0.0.1/v1')).toThrow('不允许的网络');
    expect(providerNetworkPolicy('https://provider.example/v1').allowPrivate).toBe(false);
    vi.stubEnv('OUTBOUND_ALLOWED_ORIGINS', 'http://127.0.0.1:4329,https://provider.example');
    expect(providerNetworkPolicy('http://127.0.0.1:4329/v1').allowPrivate).toBe(true);
    expect(() => providerNetworkPolicy('http://127.0.0.1:4330/v1')).toThrow('未列入');
    expect(() => providerNetworkPolicy('https://other.example/v1')).toThrow('未列入');
  });
  it('rejects URL credentials while allowing ordinary pagination', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(() => providerNetworkPolicy('https://provider.example/v1?key=fixture-key')).toThrow('独立密钥');
    expect(providerNetworkPolicy('https://provider.example/v1/models?pageToken=next').url.searchParams.get('pageToken')).toBe('next');
  });
  it('allows an explicitly trusted IPv6 loopback and rejects known metadata mappings', async () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('OUTBOUND_ALLOWED_ORIGINS', 'http://[::1]:4329');
    expect(providerNetworkPolicy('http://[::1]:4329/v1').allowPrivate).toBe(true);
    expect(await checkedProviderAddresses('fixture.local', true, async () => [{ address: '::1', family: 6 }])).toEqual([{ address: '::1', family: 6 }]);
    await expect(checkedProviderAddresses('fixture.local', true, async () => [{ address: '::ffff:a9fe:a9fe', family: 6 }])).rejects.toThrow('不允许的网络');
    await expect(checkedProviderAddresses('fixture.local', true, async () => [{ address: '::ffff:6464:64c8', family: 6 }])).rejects.toThrow('不允许的网络');
  });
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '::1', '::ffff:7f00:1', 'fd00:ec2::254', 'fe80::1', '2001:db8::1', '2002::1'])('classifies non-public fixture address %s', address => expect(isPublicAddress(address)).toBe(false));
  it('rejects non-public results at the DNS connector and checks every returned address', async () => {
    const publicAnswer = async () => [{ address: '8.8.8.8', family: 4 }];
    expect(await checkedProviderAddresses('fixture.example', false, publicAnswer)).toEqual(await publicAnswer());
    await expect(checkedProviderAddresses('fixture.example', false, async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])).rejects.toThrow('不允许的网络');
    await expect(checkedProviderAddresses('fixture.example', true, async () => [{ address: '100.100.100.200', family: 4 }])).rejects.toThrow('不允许的网络');
    await expect(checkedProviderAddresses('fixture.example', true, async () => [{ address: 'fd00:ec2::254', family: 6 }])).rejects.toThrow('不允许的网络');
  });
  it('uses the checked connector for an explicitly allowed loopback fixture without following redirects', async () => {
    const url = await fixture((_req, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('fixture-only'); });
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('OUTBOUND_ALLOWED_ORIGINS', url);
    expect(await (await providerFetch(url, { method: 'GET' })).text()).toBe('fixture-only');
    const redirect = await fixture((_req, response) => { response.writeHead(302, { Location: url }); response.end(); });
    vi.stubEnv('OUTBOUND_ALLOWED_ORIGINS', redirect);
    await expect(providerFetch(redirect, { method: 'GET' })).rejects.toThrow();
  });
});

describe('stream credential redaction', () => {
  const key = 'fixture-key-for-stream-only';
  it('holds possible prefixes across text fragments and clears partial prefixes at completion', () => {
    const values: string[] = []; const redact = createSecretStreamRedactor([key], text => values.push(text));
    redact.feed('正文 ' + key.slice(0, 10)); expect(values.join('')).toBe('正文 ');
    redact.feed(key.slice(10) + ' 继续'); redact.finish(); expect(values.join('')).toBe('正文 [REDACTED] 继续');
    const partial: string[] = []; const broken = createSecretStreamRedactor([key], text => partial.push(text)); broken.feed(key.slice(0, 8)); broken.finish(); expect(partial.join('')).toBe('[REDACTED]');
  });
  it('preserves harmless SSE exactly and redacts a known secret spanning frames and nested artifacts', () => {
    const raw = (parts: string[]) => parts.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join('');
    expect(redactSseFragments(raw(['第一段', '第二段']), [key])).toBe(raw(['第一段', '第二段']));
    const safe = redactSseFragments(raw([key.slice(0, 9), key.slice(9)]), [key]);
    const rejoined = safe.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice(6)).choices[0].delta.content).join('');
    expect(rejoined).not.toContain(key); expect(rejoined).toContain('[REDACTED]');
    const wrapped = JSON.parse(redactModelPayload(JSON.stringify({ rawResponse: raw([key.slice(0, 9), key.slice(9)]) }), [key]));
    expect(wrapped.rawResponse).toContain('[REDACTED]');
  });
  it('keeps streamed deltas and a failed response artifact free of cross-frame secrets', async () => {
    const url = await fixture((_req, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); for (const content of [key.slice(0, 9), key.slice(9)]) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`); response.end(); });
    const deltas: string[] = []; let capture: CapturedModelResponse | undefined;
    await expect(generateText({ id: 'fixture', name: 'fixture', protocol: 'openai-chat', baseUrl: url, model: 'fixture', apiKey: key, stream: true, maxOutputTokens: 256, contextTokens: 4096 }, { system: '', prompt: 'fixture', maxOutputTokens: 256, onTextDelta: text => deltas.push(text), onResponse: value => { capture = value; } })).rejects.toThrow();
    expect(deltas.join('')).not.toContain(key); expect(capture!.text).not.toContain(key);
    expect(capture!.rawResponse).toContain('[REDACTED]');
  });
});
