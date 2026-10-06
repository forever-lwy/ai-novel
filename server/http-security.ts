import { isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';

export function httpSecurityConfig() {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  let publicOrigin: string | undefined;
  if (configured) {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_ORIGIN 必须是完整的 HTTPS 来源，例如 https://novel.example.com。');
    publicOrigin = url.origin;
  }
  if (publicOrigin && process.env.COOKIE_SECURE === 'false') throw new Error('公网 HTTPS 部署不能关闭安全 Cookie，请移除 COOKIE_SECURE=false 或改为 true。');
  const proxies = (process.env.TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean);
  for (const proxy of proxies) {
    const [address, mask, ...extra] = proxy.split('/'); const family = isIP(address);
    if (!family || extra.length || (mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) === 0 || Number(mask) > (family === 4 ? 32 : 128)))) throw new Error('TRUSTED_PROXIES 只能包含明确的代理 IP 或 CIDR，不能信任任意地址。');
  }
  return { publicOrigin, secureCookies: Boolean(publicOrigin) || process.env.COOKIE_SECURE === 'true', trustedProxies: proxies.length ? proxies : false as const };
}

export function safeRequestLog(request: FastifyRequest) {
  // Log route templates, never query strings, bodies, Cookie or Authorization.
  let path = '/';
  try { path = new URL(request.url, 'http://request.invalid').pathname.slice(0, 300); } catch { /* Use a fixed path for invalid request targets. */ }
  return { method: request.method, url: request.routeOptions?.url || path, remoteAddress: request.ip };
}

export class RequestRateLimit {
  private entries = new Map<string, { since: number; count: number }>();
  constructor(private maximum: number, private period = 60_000, private capacity = 4096) {}
  accept(key: string, now = Date.now()) {
    for (const [ip, value] of this.entries) if (now - value.since >= this.period) this.entries.delete(ip);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.capacity) return false;
      entry = { since: now, count: 0 }; this.entries.set(key, entry);
    }
    return ++entry.count <= this.maximum;
  }
}
