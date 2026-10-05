import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Settings, ProviderConnection } from '../shared/types.js';
import { connectionOnly, normalizeModelSettings } from '../shared/model-settings.js';
import { normalizePromptTemplates } from '../shared/prompt-templates.js';
import { normalizeImageSettings } from '../shared/image-settings.js';

const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, encoded] = stored.split(':');
  if (!salt || !encoded) return false;
  const hash = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(encoded, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const defaultSettings = (): Settings => ({ providers: [], writingProviderId: '', planningProviderId: '', extractionProviderId: '', writingModel: '', planningModel: '', extractionModel: '', modelParameters: [], promptTemplates: normalizePromptTemplates(), imageSettings: normalizeImageSettings() });
export function normalizeSettings(settings: Settings): Settings {
  return { ...normalizeModelSettings(settings), promptTemplates: normalizePromptTemplates(settings.promptTemplates), imageSettings: normalizeImageSettings(settings.imageSettings) };
}

export class SettingsStore {
  private key: Buffer;
  constructor(private db: DatabaseSync, dataDir: string) {
    db.exec('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    const keyPath = join(dataDir, '.encryption-key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('数据目录中的密钥文件无效，请从完整服务备份恢复。');
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
    const saved = JSON.parse(raw) as Settings;
    return normalizeSettings({ ...saved, providers: saved.providers.map(p => ({ ...p, apiKey: p.apiKey ? this.decrypt(p.apiKey) : '' })) });
  }
  public(): Settings {
    return this.redact(this.get());
  }
  private redact(settings: Settings): Settings {
    return { ...settings, providers: settings.providers.map(({ apiKey, ...p }) => ({ ...p, hasKey: Boolean(apiKey) })) };
  }
  resolveProvider(provider: ProviderConnection): ProviderConnection {
    const { hasKey: _hasKey, clearApiKey: _clearApiKey, ...clean } = connectionOnly(provider);
    const previous = this.get().providers.find(saved => saved.id === provider.id);
    // Reuse a saved key only for the same origin, including when looking up an unsaved draft's models.
    const sameOrigin = previous && new URL(previous.baseUrl).origin === new URL(provider.baseUrl).origin;
    const apiKey = provider.clearApiKey ? '' : provider.apiKey || (sameOrigin ? previous.apiKey : '') || '';
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
