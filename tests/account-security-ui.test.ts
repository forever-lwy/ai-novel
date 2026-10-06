import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from '@playwright/test';
import { AccountSecurity } from '../client/AccountSecurity';
import { Auth } from '../client/App';

describe('account security form structure', () => {
  it('shows the required installation code only for first-time setup', () => {
    const setup = renderToStaticMarkup(createElement(Auth, { initialized: false, setupTokenRequired: true, onAuthenticated: () => {} }));
    const login = renderToStaticMarkup(createElement(Auth, { initialized: true, setupTokenRequired: true, onAuthenticated: () => {} }));
    expect(setup).toContain('安装码'); expect(setup).toContain('.setup-token'); expect(setup).toContain('minLength="12"');
    expect(login).not.toContain('安装码'); expect(login).not.toContain('确认密码'); expect(login).toContain('minLength="8"');
  });

  it('uses two independent password forms with accessible labels', () => {
    const html = renderToStaticMarkup(createElement(AccountSecurity));
    expect(html.match(/<form\b/g)).toHaveLength(2);
    for (const label of ['当前密码', '新密码', '确认新密码', '验证当前密码']) expect(html).toContain(label);
    expect(html.match(/type="password"/g)).toHaveLength(4);
    expect(html).toContain('autoComplete="current-password"'); expect(html).toContain('autoComplete="new-password"');
    expect(html).toContain('value=""');
  });
});

describe('ordinary account security interactions in an isolated browser fixture', () => {
  let browser: Browser, server: Server, origin: string;
  const pages: Page[] = [];
  beforeAll(async () => {
    const bundle = await build({
      stdin: { contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { AccountSecurity } from './client/AccountSecurity';
        import { Auth } from './client/App';
        import { SettingsPage } from './client/SettingsPanel';
        function Fixture() {
          const [done, setDone] = useState(false);
          const path = location.pathname;
          if (path === '/account') return <AccountSecurity />;
          if (path === '/settings') return <SettingsPage onBack={() => {}} />;
          if (done) return <p role="status">正常认证完成</p>;
          return <Auth initialized={path === '/login'} setupTokenRequired={path === '/setup'} onAuthenticated={() => setDone(true)} />;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      `, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, platform: 'browser', target: 'es2022', jsx: 'automatic', write: false,
    });
    const javascript = bundle.outputFiles[0].text;
    const styles = readFileSync(resolve('client/styles.css'), 'utf8');
    server = createServer((request, response) => {
      if (request.url === '/bundle.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(javascript); }
      else if (request.url === '/styles.css') { response.setHeader('Content-Type', 'text/css'); response.end(styles); }
      else { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>'); }
    });
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  });
  afterAll(async () => {
    for (const page of pages) await page.close();
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  });
  async function pageFor(path: string, callback: (path: string, body: unknown) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>) {
    const page = await browser.newPage({ locale: 'zh-CN' }); pages.push(page);
    await page.route('**/api/**', async route => {
      const request = route.request();
      const result = await callback(new URL(request.url()).pathname, request.postData() ? request.postDataJSON() : undefined);
      await route.fulfill({ status: result.status ?? 200, contentType: 'application/json', body: JSON.stringify(result.body ?? { ok: true }) });
    });
    await page.goto(`${origin}${path}`); return page;
  }

  it('retains values after ordinary validation errors, then clears every password after success', async () => {
    let requests = 0;
    const page = await pageFor('/account', path => {
      expect(path).toBe('/api/auth/password'); requests++;
      return requests === 1 ? { status: 400, body: { error: '当前密码不正确。' } } : {};
    });
    await page.getByLabel('当前密码', { exact: true }).fill('normal-old-passphrase');
    await page.getByLabel('新密码', { exact: true }).fill('normal-new-passphrase');
    await page.getByLabel('确认新密码', { exact: true }).fill('normal-other-passphrase');
    await page.getByLabel('验证当前密码', { exact: true }).fill('normal-old-passphrase');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '两次输入的新密码不一致' }).waitFor(); expect(requests).toBe(0);
    await page.getByLabel('确认新密码', { exact: true }).fill('normal-new-passphrase');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '当前密码不正确' }).waitFor();
    expect(await page.getByLabel('新密码', { exact: true }).inputValue()).toBe('normal-new-passphrase');
    expect(await page.getByLabel('当前密码', { exact: true }).inputValue()).toBe('normal-old-passphrase');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '登录密码已修改' }).waitFor();
    for (const label of ['当前密码', '新密码', '确认新密码', '验证当前密码']) expect(await page.getByLabel(label, { exact: true }).inputValue()).toBe('');
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  });

  it('submits only the current-password field when exiting other sessions', async () => {
    const requests: unknown[] = [];
    const page = await pageFor('/account', (path, body) => { expect(path).toBe('/api/auth/sessions/revoke'); requests.push(body); return {}; });
    await page.getByLabel('验证当前密码', { exact: true }).fill('normal-current-passphrase');
    await page.getByRole('button', { name: '退出其他登录', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '其他登录已退出' }).waitFor();
    expect(requests).toEqual([{ password: 'normal-current-passphrase' }]);
    expect(await page.getByLabel('验证当前密码', { exact: true }).inputValue()).toBe('');
  });

  it('sends the installation code during setup and permits an existing eight-character password at login', async () => {
    const submissions: { path: string; body: unknown }[] = [];
    const setup = await pageFor('/setup', (path, body) => { submissions.push({ path, body }); return {}; });
    await setup.getByLabel('安装码', { exact: true }).fill('fixture-installation-code');
    await setup.getByLabel('登录密码', { exact: true }).fill('normal-first-passphrase');
    await setup.getByLabel('确认密码', { exact: true }).fill('normal-first-passphrase');
    await setup.getByRole('button', { name: '创建私人工作台', exact: true }).click();
    await setup.getByRole('status').filter({ hasText: '正常认证完成' }).waitFor();
    const login = await pageFor('/login', (path, body) => { submissions.push({ path, body }); return {}; });
    await login.getByLabel('登录密码', { exact: true }).fill('old-pass');
    await login.getByRole('button', { name: '进入工作台', exact: true }).click();
    await login.getByRole('status').filter({ hasText: '正常认证完成' }).waitFor();
    expect(submissions).toEqual([{ path: '/api/auth/setup', body: { password: 'normal-first-passphrase', setupToken: 'fixture-installation-code' } }, { path: '/api/auth/login', body: { password: 'old-pass' } }]);
    expect(await setup.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  });

  it('keeps supplier drafts across account navigation and blocks navigation only while a security request is pending', async () => {
    let settingsReads = 0, finish: (() => void) | undefined;
    const page = await pageFor('/settings', async path => {
      if (path === '/api/settings') {
        settingsReads++; return { body: { providers: [{ id: 'normal-provider', name: '原连接', protocol: 'openai-chat', baseUrl: 'https://example.test/v1' }], writingProviderId: '', planningProviderId: '', extractionProviderId: '' } };
      }
      if (path === '/api/auth/password') { await new Promise<void>(done => { finish = done; }); return {}; }
      return { body: { models: [] } };
    });
    await page.getByLabel('供应商名称', { exact: true }).fill('未保存的连接名称');
    await page.getByRole('button', { name: '账号安全', exact: true }).click();
    expect(await page.locator('form form').count()).toBe(0);
    expect(await page.getByRole('button', { name: '保存设置', exact: true }).isVisible()).toBe(false);
    await page.getByLabel('当前密码', { exact: true }).fill('normal-current-passphrase');
    await page.getByLabel('新密码', { exact: true }).fill('normal-updated-passphrase');
    await page.getByLabel('确认新密码', { exact: true }).fill('normal-updated-passphrase');
    await page.getByRole('button', { name: '修改密码', exact: true }).click();
    await expect.poll(() => Boolean(finish)).toBe(true);
    expect(await page.getByRole('button', { name: '供应商连接', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: '返回作品', exact: true }).isDisabled()).toBe(true);
    finish!();
    await page.getByRole('status').filter({ hasText: '登录密码已修改' }).waitFor();
    await page.getByRole('button', { name: '供应商连接', exact: true }).click();
    expect(await page.getByLabel('供应商名称', { exact: true }).inputValue()).toBe('未保存的连接名称'); expect(settingsReads).toBe(1);
    await page.getByRole('button', { name: '账号安全', exact: true }).click();
    expect(await page.getByLabel('当前密码', { exact: true }).inputValue()).toBe('');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
