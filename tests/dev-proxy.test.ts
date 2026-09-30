import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createViteServer, loadConfigFromFile, type ProxyOptions, type ViteDevServer } from 'vite';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('real Vite development proxy routing', () => {
  let backend: Server | undefined;
  let vite: ViteDevServer | undefined;
  let origin = '';
  const backendRequests: string[] = [];
  const apiBody = { initialized: true, authenticated: false, fixture: 'dev-proxy-backend' };

  beforeAll(async () => {
    backend = createHttpServer((request, response) => {
      backendRequests.push(request.url || '');
      if (request.url === '/api/auth/status') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(apiBody));
      } else {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('Frontend module incorrectly forwarded to the API backend');
      }
    });
    await new Promise<void>((resolveListen, reject) => {
      backend!.once('error', reject);
      backend!.listen(0, '127.0.0.1', () => { backend!.off('error', reject); resolveListen(); });
    });
    const address = backend.address();
    if (!address || typeof address === 'string') throw new Error('测试后端未取得监听端口');
    const target = `http://127.0.0.1:${address.port}`;

    // Load the actual application config. Retarget its existing proxy entries,
    // keeping their real keys and matching/rewrite rules unchanged.
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(workspace, 'vite.config.ts'));
    if (!loaded?.config.server?.proxy) throw new Error('开发服务器未配置 API 代理');
    const proxy = Object.fromEntries(Object.entries(loaded.config.server.proxy).map(([key, value]) => [key, {
      ...(typeof value === 'string' ? {} : value), target,
    } satisfies ProxyOptions]));
    // Vite treats port=0 as its default 5173, so obtain an OS-assigned port first.
    const reservation = createHttpServer();
    await new Promise<void>((resolveListen, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', () => { reservation.off('error', reject); resolveListen(); });
    });
    const reservedAddress = reservation.address();
    await new Promise<void>((resolveClose, reject) => reservation.close(error => error ? reject(error) : resolveClose()));
    if (!reservedAddress || typeof reservedAddress === 'string') throw new Error('测试未取得可用的随机端口');
    vite = await createViteServer({
      ...loaded.config,
      configFile: false,
      root: resolve(workspace, loaded.config.root || '.'),
      cacheDir: mkdtempSync(join(tmpdir(), 'ai-novel-vite-proxy-')),
      logLevel: 'silent',
      server: { ...loaded.config.server, host: '127.0.0.1', port: reservedAddress.port, strictPort: true, open: false, proxy },
    });
    await vite.listen();
    const frontendAddress = vite.httpServer?.address();
    if (!frontendAddress || typeof frontendAddress === 'string') throw new Error('Vite 未取得监听端口');
    origin = `http://127.0.0.1:${frontendAddress.port}`;
  });

  afterAll(async () => {
    try { await vite?.close(); }
    finally {
      if (backend) {
        backend.closeAllConnections();
        await new Promise<void>((resolveClose, reject) => backend!.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolveClose()));
      }
    }
  });

  it.each(['/api.ts', '/api.ts?t=1723456789012'])('serves %s as a transformed frontend module without proxying it', async path => {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10_000) });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript/);
    expect(body).toContain('class ApiError');
    expect(body).toContain('function api(');
    expect(body).not.toContain('function api<T>');
    expect(backendRequests).not.toContain(path);
  });

  it('forwards /api/auth/status to the API backend and preserves its response', async () => {
    const response = await fetch(`${origin}/api/auth/status`, { signal: AbortSignal.timeout(10_000) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
    expect(await response.json()).toEqual(apiBody);
    expect(backendRequests.filter(path => path === '/api/auth/status')).toHaveLength(1);
  });
});
