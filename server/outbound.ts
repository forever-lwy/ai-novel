import { lookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { hasUrlCredentials } from './security.js';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) blocked.addSubnet(ip, prefix, 'ipv6');
const linkLocal = new BlockList(); linkLocal.addSubnet('169.254.0.0', 16, 'ipv4'); linkLocal.addSubnet('fe80::', 10, 'ipv6');
linkLocal.addAddress('100.100.100.200', 'ipv4'); linkLocal.addAddress('fd00:ec2::254', 'ipv6');

export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // This also rejects mapped IPv4, NAT64, loopback, multicast and unique-local addresses.
  return family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function checkAddress(address: string, allowPrivate: boolean) {
  const family = isIP(address);
  if (!family || linkLocal.check(address, family === 4 ? 'ipv4' : 'ipv6') || address === '0.0.0.0' || address === '::' || (!allowPrivate && !isPublicAddress(address))) {
    throw new Error('模型服务地址解析到不允许的网络，请配置受信任的供应商来源。');
  }
}

export function providerNetworkPolicy(input: string | URL) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('模型服务地址必须是 HTTP(S)，且不能包含用户名或密码。');
  if (hasUrlCredentials(url.href)) throw new Error('服务地址不能包含密钥或 Token 查询参数，请移到独立密钥字段。');
  const configured = (process.env.OUTBOUND_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const allowed = configured.map(value => {
    const origin = new URL(value);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('OUTBOUND_ALLOWED_ORIGINS 必须填写完整来源，不含路径或凭据。');
    return origin.origin;
  });
  if (allowed.length && !allowed.includes(url.origin)) throw new Error('模型服务来源未列入 OUTBOUND_ALLOWED_ORIGINS。');
  const publicMode = Boolean(process.env.PUBLIC_ORIGIN) || process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(process.env.HOST || '127.0.0.1');
  const explicitlyAllowed = allowed.includes(url.origin);
  if (publicMode && !explicitlyAllowed && url.protocol !== 'https:') throw new Error('生产模型服务必须使用 HTTPS；本地网关需显式配置受信任来源。');
  const allowPrivate = explicitlyAllowed || !publicMode;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) checkAddress(hostname, allowPrivate);
  return { url, allowPrivate, enforce: publicMode || configured.length > 0 };
}

type Address = { address: string; family: number };
export async function checkedProviderAddresses(hostname: string, allowPrivate: boolean, resolver: (host: string) => Promise<Address[]> = host => lookup(host, { all: true, verbatim: true })) {
  const addresses = await resolver(hostname);
  if (!addresses.length) throw new Error('模型服务域名没有可用地址。');
  for (const item of addresses) checkAddress(item.address, allowPrivate);
  return addresses;
}

/** The validated DNS results are the exact addresses used by the socket connector. */
export async function providerFetch(input: string | URL, init: RequestInit): Promise<Response> {
  const policy = providerNetworkPolicy(input);
  if (!policy.enforce) return fetch(policy.url, { ...init, redirect: 'error' });
  const checkedLookup: LookupFunction = (hostname, options, callback) => {
    void checkedProviderAddresses(hostname, policy.allowPrivate).then(addresses => {
      if (options.all) callback(null, addresses as never);
      else { const result = addresses.find(item => !options.family || item.family === options.family) || addresses[0]; callback(null, result.address, result.family); }
    }, error => callback(error as NodeJS.ErrnoException, '', 4));
  };
  const dispatcher = new Agent({ connect: { lookup: checkedLookup }, connections: 2 });
  try {
    const response = await fetch(policy.url, { ...init, redirect: 'error', dispatcher } as RequestInit & { dispatcher: Agent });
    // close drains the response body without retaining an unbounded origin pool.
    void dispatcher.close().catch(() => undefined);
    return response;
  } catch (error) { await dispatcher.destroy(); throw error; }
}
