import { defineConfig } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 14328);
export default defineConfig({
  testDir: './tests', testMatch: ['browser.spec.ts', 'rpg-browser.spec.ts'], fullyParallel: false, workers: 1,
  retries: 0, timeout: 60_000, expect: { timeout: 15_000 },
  outputDir: 'test-results', reporter: [['list'], ['html', { open: 'never' }]],
  globalTeardown: './tests/e2e-teardown.mjs',
  use: {
    baseURL: `http://127.0.0.1:${port}`, channel: 'msedge', headless: true,
    viewport: { width: 1440, height: 1000 }, locale: 'zh-CN',
    actionTimeout: 15_000,
    trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off',
  },
  webServer: {
    command: 'node tests/e2e-server.mjs', url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false, timeout: 30_000,
    env: { E2E_PORT: String(port), E2E_MODEL_PORT: process.env.E2E_MODEL_PORT || '4329' },
  },
});
