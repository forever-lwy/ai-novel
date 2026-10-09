import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const run = promisify(execFile);
const fixture = fileURLToPath(new URL('./fixtures/provider-abort-gc.mjs', import.meta.url));

it.each(['openai-chat', 'openai-responses', 'gemini', 'claude', 'unmanaged'])('%s still aborts after garbage collection without losing partial output or leaking connections', async protocol => {
  const result = await run(process.execPath, ['--expose-gc', '--import', 'tsx', fixture, protocol], {
    windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024,
    env: { ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PUBLIC_ORIGIN: '', OUTBOUND_ALLOWED_ORIGINS: '' },
  });
  const checks = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(checks.map(check => check.mode)).toEqual(protocol === 'unmanaged' ? ['unmanaged'] : ['first', 'idle', 'cancel']);
  for (const check of checks) expect(check).toMatchObject({ protocol, requests: 1, connectionClosed: true });
});
