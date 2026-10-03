import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Trash2, KeyRound, CheckCircle2, Save, PlugZap, RefreshCw } from 'lucide-react';
import type { CapturedModelResponse, ModelParameters, ModelRole, ProviderConnection, ProviderModel, ProviderProtocol, Settings } from '../shared/types';
import { defaultModelParameters, getModelParameters, upsertModelParameters } from '../shared/model-settings';
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
const roles = [
  { role: 'writing', providerKey: 'writingProviderId', modelKey: 'writingModel', label: '正文写作' },
  { role: 'planning', providerKey: 'planningProviderId', modelKey: 'planningModel', label: '大纲规划' },
  { role: 'extraction', providerKey: 'extractionProviderId', modelKey: 'extractionModel', label: '资料提取' },
] as const;
type Role = typeof roles[number];
type ModelList = { signature: string; loading: boolean; models: ProviderModel[]; error?: string };
type ModelRequest = { signature: string; controller: AbortController; timer?: ReturnType<typeof setTimeout> };
const connectionSignature = (provider: ProviderConnection) => JSON.stringify([provider.id, provider.protocol, provider.baseUrl, provider.apiKey || '', !!provider.clearApiKey, !!provider.hasKey]);

export function SettingsPanel() {
  const [settings, setSettings] = useState<Settings | null>(null); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [modelLists, setModelLists] = useState<Record<string, ModelList>>({});
  const requests = useRef(new Map<string, ModelRequest>());
  const [lastTest, setLastTest] = useState<{ name: string; ok: boolean; message: string; capture?: CapturedModelResponse } | null>(null);
  useEffect(() => { api<Settings>('/settings').then(setSettings).catch(e => setError(e.message)); }, []);
  useEffect(() => () => { for (const request of requests.current.values()) { clearTimeout(request.timer); request.controller.abort(); } }, []);

  function loadModels(provider: ProviderConnection, immediate = false) {
    const signature = connectionSignature(provider);
    const previous = requests.current.get(provider.id);
    if (!immediate && previous?.signature === signature) return;
    if (previous) { clearTimeout(previous.timer); previous.controller.abort(); }
    const request: ModelRequest = { signature, controller: new AbortController() };
    requests.current.set(provider.id, request);
    setModelLists(value => ({ ...value, [provider.id]: { signature, loading: true, models: [] } }));
    const run = async () => {
      try {
        const result = await api<{ models: ProviderModel[] }>('/settings/models', { method: 'POST', body: JSON.stringify({ provider }), signal: request.controller.signal });
        if (request.controller.signal.aborted || requests.current.get(provider.id) !== request) return;
        setModelLists(value => ({ ...value, [provider.id]: { signature, loading: false, models: result.models } }));
      } catch (e) {
        if (request.controller.signal.aborted || requests.current.get(provider.id) !== request) return;
        setModelLists(value => ({ ...value, [provider.id]: { signature, loading: false, models: [], error: (e as Error).message } }));
      }
    };
    if (immediate) void run();
    else request.timer = setTimeout(() => void run(), 300);
  }
  useEffect(() => {
    if (!settings) return;
    const selected = new Set(roles.map(role => settings[role.providerKey]).filter(Boolean));
    for (const [id, request] of requests.current) {
      if (!selected.has(id) || !settings.providers.some(provider => provider.id === id)) {
        clearTimeout(request.timer); request.controller.abort(); requests.current.delete(id);
      }
    }
    for (const provider of settings.providers) if (selected.has(provider.id)) loadModels(provider);
  }, [settings]);

  function updateProvider(index: number, patch: Partial<ProviderConnection>) { setMessage(''); setSettings(value => value && ({ ...value, providers: value.providers.map((p, i) => i === index ? { ...p, ...patch } : p) })); }
  function updateRole(role: Role, providerId: string) { setMessage(''); setSettings(value => value && ({ ...value, [role.providerKey]: providerId, [role.modelKey]: '' })); }
  function updateModel(role: Role, model: string) { setMessage(''); setSettings(value => value && ({ ...value, [role.modelKey]: model })); }
  function updateParameters(role: ModelRole, providerId: string, model: string, patch: Partial<ModelParameters>) {
    setMessage(''); setSettings(value => value && upsertModelParameters(value, role, providerId, model, { ...getModelParameters(value, role, providerId, model), ...patch }));
  }
  function resetParameters(role: ModelRole, providerId: string, model: string) { setMessage(''); setSettings(value => value && upsertModelParameters(value, role, providerId, model, defaultModelParameters())); }
  function deleteProvider(providerId: string) {
    setMessage(''); setSettings(value => {
      if (!value) return value;
      const next = { ...value, providers: value.providers.filter(provider => provider.id !== providerId), modelParameters: value.modelParameters?.filter(profile => profile.providerId !== providerId) };
      for (const role of roles) if (next[role.providerKey] === providerId) { next[role.providerKey] = ''; next[role.modelKey] = ''; }
      return next;
    });
  }
  async function save(testRole?: Role) {
    if (!settings) return;
    const invalid = settings.modelParameters?.map(profile => {
      const provider = settings.providers.find(value => value.id === profile.providerId);
      const roleName = roles.find(value => value.role === profile.role)?.label || '模型设置';
      return { name: `${roleName} · ${provider?.name || '供应商'} · ${profile.model}`, error: provider && parameterError(profile, provider.protocol) };
    }).find(profile => profile.error);
    if (invalid) { setError(`${invalid.name}：${invalid.error}`); return; }
    setBusy(true); setError(''); setMessage(''); if (testRole) setLastTest(null);
    try {
      const saved = await put<Settings>('/settings', settings); setSettings(saved);
      if (testRole) {
        const providerId = saved[testRole.providerKey]; const model = saved[testRole.modelKey];
        const result = await post<{ ok: boolean; message: string; inputTokens: number; outputTokens: number; capture?: CapturedModelResponse }>('/settings/test', { role: testRole.role, providerId, model });
        setLastTest({ name: `${testRole.label} · ${saved.providers.find(provider => provider.id === providerId)?.name || '供应商'} · ${model}`, ok: result.ok, message: result.message, capture: result.capture });
        if (result.ok) setMessage(`${result.message} · 输入 ${result.inputTokens} / 输出 ${result.outputTokens} tokens`);
        else setError(result.message);
      }
      else setMessage('设置已保存。');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (!settings) return error ? <Notice error={error} /> : <Spinner />;
  return <form className="form-stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void save(); }}>
    <p className="muted">先添加供应商连接，再为正文写作、大纲规划和资料提取分别选择模型，并在模型下方设置生成参数。每个任务独立保存参数，同模型用于不同任务也不共用。密钥保存在服务端，作品备份不包含密钥。</p>
    <div className="settings-providers">{settings.providers.map((provider, index) => <section className="provider-card" key={provider.id}>
      <div className="row between"><span className="eyebrow">供应商 {String(index + 1).padStart(2, '0')}</span><button type="button" className="icon-button danger-text" title="删除此供应商" aria-label={`删除供应商 ${provider.name}`} disabled={busy} onClick={() => deleteProvider(provider.id)}><Trash2 size={16} /></button></div>
      <div className="form-grid"><label>供应商名称<input required value={provider.name} onChange={e => updateProvider(index, { name: e.target.value })} placeholder="例如：我的模型服务商" /></label><label>接口协议<select aria-label="接口协议" value={provider.protocol} onChange={e => { const protocol = e.target.value as ProviderProtocol; const wasDefault = provider.baseUrl.replace(/\/+$/, '') === protocols[provider.protocol].url.replace(/\/+$/, ''); updateProvider(index, { protocol, ...(wasDefault ? { baseUrl: protocols[protocol].url } : {}) }); }}>{Object.entries(protocols).map(([key, value]) => <option key={key} value={key}>{value.name}</option>)}</select></label></div>
      <p className="hint">服务地址填写协议前缀（例如 /v1），不要填写完整生成接口。更换服务域名后，需要重新填写密钥。</p><label>服务地址<input required type="url" value={provider.baseUrl} onChange={e => updateProvider(index, { baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label>
      <label><span className="row"><KeyRound size={13} />API 密钥 {provider.hasKey && <span className="positive-text">已保存</span>}</span><input type="password" autoComplete="off" value={provider.apiKey || ''} onChange={e => updateProvider(index, { apiKey: e.target.value })} placeholder={provider.hasKey ? '留空保留现有密钥' : '输入密钥'} /></label>
      {provider.hasKey && <label className="checkbox"><input type="checkbox" checked={!!provider.clearApiKey} onChange={e => updateProvider(index, { clearApiKey: e.target.checked, apiKey: e.target.checked ? '' : provider.apiKey })} />保存时清除现有密钥</label>}
    </section>)}</div>
    <button className="button secondary" type="button" disabled={busy} onClick={() => setSettings({ ...settings, providers: [...settings.providers, { id: crypto.randomUUID(), name: `供应商 ${settings.providers.length + 1}`, protocol: 'openai-chat', baseUrl: protocols['openai-chat'].url, apiKey: '' }] })}><Plus size={16} />添加供应商连接</button>
    <section className="settings-role-card"><h3>任务模型</h3><div className="settings-task-grid">{roles.map(role => {
      const provider = settings.providers.find(value => value.id === settings[role.providerKey]);
      const list = provider && modelLists[provider.id]?.signature === connectionSignature(provider) ? modelLists[provider.id] : undefined;
      const model = settings[role.modelKey] || '';
      const modelName = model.trim();
      return <section className="settings-task-card form-stack" key={role.providerKey} aria-label={`${role.label}模型设置`}>
        <h4>{role.label}</h4>
        <label>供应商<select aria-label={`${role.label}供应商`} value={settings[role.providerKey]} onChange={e => updateRole(role, e.target.value)}><option value="">暂不设置</option>{settings.providers.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
        {provider && <>
          <label>上游模型<select aria-label={`${role.label}上游模型`} value={list?.models.some(value => value.id === model) ? model : ''} disabled={list?.loading || !list?.models.length} onChange={e => updateModel(role, e.target.value)}><option value="">{list?.loading ? '正在获取模型…' : list?.models.length ? '选择上游模型' : '暂无可选模型'}</option>{list?.models.map(value => <option key={value.id} value={value.id}>{value.name && value.name !== value.id ? `${value.name} · ${value.id}` : value.id}</option>)}</select></label>
          <label>模型名称（可自定义）<input aria-label={`${role.label}模型名称`} value={model} onChange={e => updateModel(role, e.target.value)} placeholder="选择上方模型，或输入服务商提供的模型 ID" /></label>
          <div className="model-list-feedback"><span className="hint">{list?.loading ? '正在从供应商获取模型列表…' : list?.models.length ? `已获取 ${list.models.length} 个模型；也可以直接填写自定义模型名称。` : '可直接填写自定义模型名称。'}</span><button type="button" className="text-button" aria-label={`${role.label}刷新模型列表`} disabled={busy || list?.loading} onClick={() => loadModels(provider, true)}><RefreshCw size={13} />刷新列表</button></div>
          {list?.error && <p className="notice error model-list-error">获取模型列表失败：{list.error}</p>}
          {!list?.loading && !list?.error && list && !list.models.length && <p className="hint">供应商未返回可用模型，请填写自定义模型名称。</p>}
          {modelName ? <ProviderParameters key={JSON.stringify([role.role, provider.id, modelName])} protocol={provider.protocol} parameters={getModelParameters(settings, role.role, provider.id, modelName)} onChange={patch => updateParameters(role.role, provider.id, modelName, patch)} onReset={() => resetParameters(role.role, provider.id, modelName)} /> : <p className="hint">选择或填写模型名称后，可设置此任务的模型参数；新模型自动使用通用默认值。</p>}
          <button type="button" className="button secondary small" aria-label={`${role.label}保存并测试连接`} disabled={busy || !model.trim() || !provider.baseUrl} onClick={event => { if (event.currentTarget.form?.reportValidity()) void save(role); }}><PlugZap size={15} />保存并测试连接</button>
        </>}
      </section>;
    })}</div><p className="hint">测试会保存全部设置，并按该任务所选模型的生成参数和输出上限发送一次真实请求，可能产生用量，不会自动重试。</p></section>
    {error && <Notice error={error} />}{message && <div className="notice success" role="status"><CheckCircle2 size={17} />{message}</div>}
    {lastTest && <section className="settings-test-result"><div className="row between wrap"><h3>最近连接测试 · {lastTest.name}</h3><span className={`status-pill ${lastTest.ok ? 'completed' : 'failed'}`}>{lastTest.ok ? '成功' : '失败'}</span></div><p className="hint">以下是这一次测试留下的记录，之后修改设置不会改变它。</p><RequestDiagnostics key={`${lastTest.name}-${lastTest.capture?.request?.startedAt || lastTest.message}`} capture={lastTest.capture} filename="connection-test-diagnostics" showResponse /></section>}
    <div className="sticky-modal-footer"><button type="submit" className="button primary" disabled={busy}><Save size={16} />{busy ? '正在处理…' : '保存设置'}</button></div>
  </form>;
}
