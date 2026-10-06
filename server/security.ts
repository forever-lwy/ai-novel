import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createCipheriv, createDecipheriv, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Settings, ProviderConnection } from '../shared/types.js';
import { connectionOnly, normalizeModelSettings } from '../shared/model-settings.js';
import { normalizePromptTemplates } from '../shared/prompt-templates.js';
import { normalizeImageSettings } from '../shared/image-settings.js';
import { normalizeTaskSettings } from '../shared/task-settings.js';

const scrypt = promisify(scryptCallback) as (password: string, salt: string, length: number, options?: ScryptOptions) => Promise<Buffer>;
const passwordParameters = { N: 16384, r: 8, p: 5 } as const;
const passwordPrefix = `scrypt$v1$${passwordParameters.N}$${passwordParameters.r}$${passwordParameters.p}$`;
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, passwordParameters) as Buffer;
  return `${passwordPrefix}${salt}$${hash.toString('hex')}`;
}
export async function verifyPasswordWithUpgrade(password: string, stored: string): Promise<{ valid: boolean; upgradedHash?: string }> {
  const legacy = /^([a-f0-9]{32}):([a-f0-9]{128})$/.exec(stored);
  const current = stored.startsWith(passwordPrefix) ? /^([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(stored.slice(passwordPrefix.length)) : null;
  const match = current || legacy;
  if (!match || password.length > 256) return { valid: false };
  const [, salt, encoded] = match;
  const hash = await scrypt(password, salt, 64, current ? passwordParameters : { N: 16384, r: 8, p: 1 }) as Buffer;
  const expected = Buffer.from(encoded, 'hex');
  const valid = hash.length === expected.length && timingSafeEqual(hash, expected);
  return valid ? { valid: true, upgradedHash: legacy ? await hashPassword(password) : undefined } : { valid: false };
}
export async function verifyPassword(password: string, stored: string) { return (await verifyPasswordWithUpgrade(password, stored)).valid; }
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const sensitiveQueryName = (name: string) => name.toLowerCase() !== 'pagetoken' && /(?:key|token|secret|password|signature|credential|authorization|session|^sid$|^sig$|^jwt$)/i.test(name);
export function hasUrlCredentials(baseUrl: string) {
  try { return [...new URL(baseUrl).searchParams.keys()].some(sensitiveQueryName); }
  catch { return false; }
}
function withoutUrlCredentials(baseUrl: string) {
  if (!hasUrlCredentials(baseUrl)) return baseUrl;
  const url = new URL(baseUrl);
  for (const name of [...url.searchParams.keys()]) if (sensitiveQueryName(name)) url.searchParams.delete(name);
  return url.toString();
}
type StoredProviderConnection = ProviderConnection & { baseUrlEncrypted?: string };
type StoredSettings = Omit<Settings, 'providers'> & { providers: StoredProviderConnection[] };
export const defaultSettings = (): Settings => ({ providers: [], writingProviderId: '', planningProviderId: '', extractionProviderId: '', writingModel: '', planningModel: '', extractionModel: '', modelParameters: [], promptTemplates: normalizePromptTemplates(), imageSettings: normalizeImageSettings(), taskSettings: normalizeTaskSettings() });
export function normalizeSettings(settings: Settings): Settings {
  return { ...normalizeModelSettings(settings), promptTemplates: normalizePromptTemplates(settings.promptTemplates), imageSettings: normalizeImageSettings(settings.imageSettings), taskSettings: normalizeTaskSettings(settings.taskSettings) };
}

export class SettingsStore {
  private key: Buffer;
  constructor(private db: DatabaseSync, dataDir: string) {
    db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    const keyPath = join(dataDir, '.encryption-key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('数据目录中的密钥文件无效，请从完整服务备份恢复。');
    const saved = this.meta('settings');
    if (saved) {
      const settings = JSON.parse(saved) as StoredSettings;
      let changed = false;
      for (const provider of settings.providers) if (hasUrlCredentials(provider.baseUrl)) {
        provider.baseUrlEncrypted = this.encrypt(provider.baseUrl);
        provider.baseUrl = withoutUrlCredentials(provider.baseUrl);
        changed = true;
      }
      if (changed || this.meta('url-credentials-cleanup') === '1') {
        const previousSecureDelete = Number(db.prepare('PRAGMA secure_delete').get()!.secure_delete);
        db.exec('PRAGMA secure_delete=ON');
        try {
          if (changed) { this.setMeta('url-credentials-cleanup', '1'); this.setMeta('settings', JSON.stringify(settings)); }
          const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
          if (checkpoint?.busy !== 0) throw new Error('旧地址凭据已加密，但数据库仍被占用，请关闭其他数据库连接后重启以清理旧记录。');
          db.prepare('DELETE FROM app_meta WHERE key=?').run('url-credentials-cleanup');
        } finally { db.exec(`PRAGMA secure_delete=${[0, 1, 2].includes(previousSecureDelete) ? previousSecureDelete : 0}`); }
      }
    }
  }
  meta(name: string): string | undefined {
    return (this.db.prepare('SELECT value FROM app_meta WHERE key=?').get(name) as { value: string } | undefined)?.value;
  }
  setMeta(name: string, value: string) { this.db.prepare('INSERT INTO app_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, value); }
  private encrypt(value: string) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  private decrypt(value: string) {
    const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
  get(): Settings {
    const raw = this.meta('settings');
    if (!raw) return defaultSettings();
    const saved = JSON.parse(raw) as StoredSettings;
    return normalizeSettings({ ...saved, providers: saved.providers.map(({ baseUrlEncrypted, ...provider }) => ({ ...provider, baseUrl: baseUrlEncrypted ? this.decrypt(baseUrlEncrypted) : provider.baseUrl, apiKey: provider.apiKey ? this.decrypt(provider.apiKey) : '' })) });
  }
  public(): Settings {
    return this.redact(this.get());
  }
  private redact(settings: Settings): Settings {
    return { ...settings, providers: settings.providers.map(({ apiKey, ...provider }) => ({ ...provider, baseUrl: withoutUrlCredentials(provider.baseUrl), hasKey: Boolean(apiKey), ...(hasUrlCredentials(provider.baseUrl) ? { hasUrlCredentials: true } : {}) })) };
  }
  resolveProvider(provider: ProviderConnection): ProviderConnection {
    if (hasUrlCredentials(provider.baseUrl)) throw Object.assign(new Error('服务地址不能包含密钥、令牌等查询参数，请将凭据移到独立 API 密钥字段。'), { statusCode: 400 });
    const { hasKey: _hasKey, clearApiKey: _clearApiKey, hasUrlCredentials: _hasUrlCredentials, ...clean } = connectionOnly(provider);
    const previous = this.get().providers.find(saved => saved.id === provider.id);
    const requestedKey = provider.apiKey?.trim();
    if (previous && hasUrlCredentials(previous.baseUrl) && !requestedKey && !provider.clearApiKey) throw Object.assign(new Error('该连接原地址中的凭据已加密保留，请填写独立 API 密钥或明确清除凭据后保存。'), { statusCode: 400 });
    // Reuse a saved key only for the same origin, including when looking up an unsaved draft's models.
    const sameOrigin = previous && new URL(previous.baseUrl).origin === new URL(provider.baseUrl).origin;
    const apiKey = provider.clearApiKey ? '' : requestedKey || (sameOrigin ? previous.apiKey : '') || '';
    return { ...clean, apiKey };
  }
  save(settings: Settings) {
    const normalized = normalizeSettings(settings);
    const providers = normalized.providers.map(provider => {
      const resolved = this.resolveProvider(provider);
      return { ...resolved, apiKey: resolved.apiKey ? this.encrypt(resolved.apiKey) : '' };
    });
    this.setMeta('settings', JSON.stringify({ ...normalized, providers }));
    return this.public();
  }
  provider(id: string): ProviderConnection | undefined { return this.get().providers.find(p => p.id === id); }
}
