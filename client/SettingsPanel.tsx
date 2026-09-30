import { useEffect, useState, type FormEvent } from 'react';
import { Plus, Trash2, KeyRound, CheckCircle2, Save, PlugZap } from 'lucide-react';
import type { CapturedModelResponse, ProviderConfig, ProviderProtocol, Settings } from '../shared/types';
import { api, post, put } from './api';
import { Notice, Spinner } from './ui';
import { ProviderParameters, parameterError } from './ProviderParameters';
import { RequestDiagnostics } from './RequestDiagnostics';

const protocols: Record<ProviderProtocol, { name: string; url: string }> = {
  'openai-chat': { name: 'OpenAI · Chat Completions', url: 'https://api.openai.com/v1' },
  'openai-responses': { name: 'OpenAI · Responses', url: 'https://api.openai.com/v1' },
  gemini: { name: 'Google · Gemini', url: 'https://generativelanguage.googleapis.com/v1beta' },
  claude: { name: 'Anthropic · Claude', url: 'https://api.anthropic.com/v1' },
};
export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [lastTest, setLastTest] = useState<{ name: string; ok: boolean; message: string; capture?: CapturedModelResponse } | null>(null);
  useEffect(() => { api<Settings>('/settings').then(setSettings).catch(e => setError(e.message)); }, []);
  function updateProvider(index: number, patch: Partial<ProviderConfig>) { setMessage(''); setSettings(value => value && ({ ...value, providers: value.providers.map((p, i) => i === index ? { ...p, ...patch } : p) })); }
  async function save(testId?: string) {
    if (!settings) return;
    const invalid = settings.providers.map(provider => ({ name: provider.name, error: parameterError(provider) })).find(provider => provider.error);
    if (invalid) { setError(`${invalid.name}：${invalid.error}`); return; }
    setBusy(true); setError(''); setMessage(''); if (testId) setLastTest(null);
    try {
      const saved = await put<Settings>('/settings', settings); setSettings(saved);
      if (testId) {
        const result = await post<{ ok: boolean; message: string; inputTokens: number; outputTokens: number; capture?: CapturedModelResponse }>('/settings/test', { providerId: testId });
        setLastTest({ name: saved.providers.find(provider => provider.id === testId)?.name || '模型连接', ok: result.ok, message: result.message, capture: result.capture });
        if (result.ok) setMessage(`${result.message} · 输入 ${result.inputTokens} / 输出 ${result.outputTokens} tokens`);
        else setError(result.message);
      }
      else setMessage('设置已保存。');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (!settings) return error ? <Notice error={error} /> : <Spinner />;
  return <form className="form-stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void save(); }}>
    <p className="muted">为写作、规划和资料整理选择合适的模型。密钥保存在服务端，作品备份不包含密钥。</p>
    <div className="settings-providers">{settings.providers.map((provider, index) => <section className="provider-card" key={provider.id}>
      <div className="row between"><span className="eyebrow">连接 {String(index + 1).padStart(2, '0')}</span><button type="button" className="icon-button danger-text" title="删除此连接" aria-label={`删除连接 ${provider.name}`} disabled={busy} onClick={() => setSettings({ ...settings, providers: settings.providers.filter(p => p.id !== provider.id), writingProviderId: settings.writingProviderId === provider.id ? '' : settings.writingProviderId, planningProviderId: settings.planningProviderId === provider.id ? '' : settings.planningProviderId, extractionProviderId: settings.extractionProviderId === provider.id ? '' : settings.extractionProviderId })}><Trash2 size={16} /></button></div>
      <div className="form-grid"><label>连接名称<input required value={provider.name} onChange={e => updateProvider(index, { name: e.target.value })} placeholder="例如：日常写作" /></label><label>接口协议<select aria-label="接口协议" value={provider.protocol} onChange={e => { const protocol = e.target.value as ProviderProtocol; const wasDefault = provider.baseUrl.replace(/\/+$/, '') === protocols[provider.protocol].url.replace(/\/+$/, ''); updateProvider(index, { protocol, ...(wasDefault ? { baseUrl: protocols[protocol].url } : {}) }); }}>{Object.entries(protocols).map(([key, value]) => <option key={key} value={key}>{value.name}</option>)}</select></label></div>
      <p className="hint">服务地址填写协议前缀（例如 /v1），不要填写完整生成接口。更换服务域名后，需要重新填写密钥。</p><label>服务地址<input required type="url" value={provider.baseUrl} onChange={e => updateProvider(index, { baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label>
      <div className="form-grid"><label>模型名称<input required value={provider.model} onChange={e => updateProvider(index, { model: e.target.value })} placeholder="服务商提供的模型 ID" /></label><label><span className="row"><KeyRound size={13} />API 密钥 {provider.hasKey && <span className="positive-text">已保存</span>}</span><input type="password" autoComplete="off" value={provider.apiKey || ''} onChange={e => updateProvider(index, { apiKey: e.target.value })} placeholder={provider.hasKey ? '留空保留现有密钥' : '输入密钥'} /></label></div>
      {provider.hasKey && <label className="checkbox"><input type="checkbox" checked={!!provider.clearApiKey} onChange={e => updateProvider(index, { clearApiKey: e.target.checked, apiKey: e.target.checked ? "" : provider.apiKey })} />保存时清除现有密钥</label>}
      <div className="form-grid"><label>单次最大输出 tokens<input required type="number" min={256} max={128000} value={provider.maxOutputTokens} onChange={e => updateProvider(index, { maxOutputTokens: Number(e.target.value) })} /></label><label>模型上下文窗口 tokens<input required type="number" min={2048} max={2000000} value={provider.contextTokens} onChange={e => updateProvider(index, { contextTokens: Number(e.target.value) })} /></label></div>
      <ProviderParameters provider={provider} onChange={patch => updateProvider(index, patch)} />
      <button type="button" className="button secondary small" disabled={busy || !provider.model || !provider.baseUrl} onClick={event => { if (event.currentTarget.form?.reportValidity()) void save(provider.id); }}><PlugZap size={15} />保存并测试连接</button><span className="hint">测试会按当前参数和输出上限发送一次真实请求，可能产生用量，不会自动重试。</span>
    </section>)}</div>
    <button className="button secondary" type="button" disabled={busy} onClick={() => setSettings({ ...settings, providers: [...settings.providers, { id: crypto.randomUUID(), name: `模型连接 ${settings.providers.length + 1}`, protocol: 'openai-chat', baseUrl: protocols['openai-chat'].url, model: '', apiKey: '', maxOutputTokens: 4096, contextTokens: 64000 }] })}><Plus size={16} />添加模型连接</button>
    <section className="settings-role-card"><h3>分配模型用途</h3><div className="form-grid">{([{ key: 'writingProviderId', label: '正文写作' }, { key: 'planningProviderId', label: '大纲规划' }, { key: 'extractionProviderId', label: '资料提取' }] as const).map(role => <label key={role.key}>{role.label}<select value={settings[role.key]} onChange={e => setSettings({ ...settings, [role.key]: e.target.value })}><option value="">暂不设置</option>{settings.providers.map(p => <option key={p.id} value={p.id}>{p.name} · {p.model || '未指定模型'}</option>)}</select></label>)}<label>每项任务用量上限（tokens）<input type="number" min={1000} max={100000000} value={settings.taskTokenLimit} onChange={e => setSettings({ ...settings, taskTokenLimit: Number(e.target.value) })} /><span className="hint">至少 1000 tokens，包含输入与输出；未返回用量时会作估算。</span></label></div></section>
    {error && <Notice error={error} />}{message && <div className="notice success" role="status"><CheckCircle2 size={17} />{message}</div>}
    {lastTest && <section className="settings-test-result"><div className="row between wrap"><h3>最近连接测试 · {lastTest.name}</h3><span className={`status-pill ${lastTest.ok ? 'completed' : 'failed'}`}>{lastTest.ok ? '成功' : '失败'}</span></div><p className="hint">以下是这一次测试留下的记录，之后修改设置不会改变它。</p><RequestDiagnostics key={`${lastTest.name}-${lastTest.capture?.request?.startedAt || lastTest.message}`} capture={lastTest.capture} filename="connection-test-diagnostics" showResponse /></section>}
    <div className="sticky-modal-footer"><button type="submit" className="button primary" disabled={busy}><Save size={16} />{busy ? '正在处理…' : '保存设置'}</button></div>
  </form>;
}
