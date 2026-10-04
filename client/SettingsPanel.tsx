import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Plus, Trash2, KeyRound, CheckCircle2, Save, PlugZap, RefreshCw, SlidersHorizontal, ListOrdered } from 'lucide-react';
import type { CapturedModelResponse, ModelParameters, ModelRole, ProviderConnection, ProviderModel, ProviderProtocol, Settings } from '../shared/types';
import { defaultModelParameters, getModelParameters, upsertModelParameters } from '../shared/model-settings';
import { api, post, put } from './api';
import { Brand, Notice, Spinner } from './ui';
import { ProviderParameters, parameterError } from './ProviderParameters';
import { RequestDiagnostics } from './RequestDiagnostics';
import { PromptTemplatesPanel } from './PromptTemplatesPanel';
import { validatePromptTemplates } from '../shared/prompt-templates';

const protocols: Record<ProviderProtocol, { name: string; url: string }> = {
  'openai-chat': { name: 'OpenAI · Chat Completions', url: 'https://api.openai.com/v1' },
  'openai-responses': { name: 'OpenAI · Responses', url: 'https://api.openai.com/v1' },
  gemini: { name: 'Google · Gemini', url: 'https://generativelanguage.googleapis.com/v1beta' },
  claude: { name: 'Anthropic · Claude', url: 'https://api.anthropic.com/v1' },
};
const roles = [
  { role: 'writing', providerKey: 'writingProviderId', modelKey: 'writingModel', label: '正文写作' },
  { role: 'planning', providerKey: 'planningProviderId', modelKey: 'planningModel', label: '剧情规划' },
  { role: 'extraction', providerKey: 'extractionProviderId', modelKey: 'extractionModel', label: '资料提取' },
] as const;
type Role = typeof roles[number];
type ModelList = { signature: string; loading: boolean; models: ProviderModel[]; error?: string };
type ModelRequest = { signature: string; controller: AbortController; timer?: ReturnType<typeof setTimeout> };
const connectionSignature = (provider: ProviderConnection) => JSON.stringify([provider.id, provider.protocol, provider.baseUrl, provider.apiKey || '', !!provider.clearApiKey, !!provider.hasKey]);
const sections = [
  { id: 'providers', label: '供应商连接', icon: KeyRound, description: '管理服务地址、接口协议和 API 密钥。密钥保存在服务端，作品备份不包含密钥。' },
  { id: 'models', label: '任务模型', icon: SlidersHorizontal, description: '为正文写作、剧情规划和资料提取分别选择模型。每个任务独立保存参数，同模型用于不同任务也不共用。' },
  { id: 'prompts', label: '提示词编排', icon: ListOrdered, description: '为四类任务管理提示词预设、调整消息顺序，并预览编排后的内容。' },
] as const;
type SettingsSection = typeof sections[number]['id'];

function fieldError(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  if (field.disabled || field instanceof HTMLInputElement && field.type === 'file') return '';
  if (field.validity.badInput) return '请填写有效的数字。';
  if (field.validity.valid) return '';
  if (field.validity.valueMissing) return '请填写此项。';
  if (field.validity.typeMismatch) return '请填写有效的地址。';
  if (field.validity.rangeUnderflow) return `数值不能小于 ${field.getAttribute('min')}。`;
  if (field.validity.rangeOverflow) return `数值不能大于 ${field.getAttribute('max')}。`;
  if (field.validity.stepMismatch) return field.getAttribute('step') === '1' ? '请填写整数。' : '请填写符合精度要求的数值。';
  return '请检查此项内容。';
}

export function SettingsPage({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<SettingsSection>('providers');
  const [savedSignature, setSavedSignature] = useState('');
  const [inputDraftInvalid, setInputDraftInvalid] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const form = useRef<HTMLFormElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const dirty = !!settings && (JSON.stringify(settings) !== savedSignature || inputDraftInvalid);
  const [modelLists, setModelLists] = useState<Record<string, ModelList>>({});
  const requests = useRef(new Map<string, ModelRequest>());
  const [lastTest, setLastTest] = useState<{ name: string; ok: boolean; message: string; capture?: CapturedModelResponse } | null>(null);
  useEffect(() => title.current?.focus(), []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    api<Settings>('/settings', { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return;
      setSettings(value); setSavedSignature(JSON.stringify(value)); setInputDraftInvalid(false);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [loadAttempt]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  useEffect(() => () => { for (const request of requests.current.values()) { clearTimeout(request.timer); request.controller.abort(); } }, []);

  function back() { if (!busy && (!dirty || window.confirm('设置尚未保存，返回作品会放弃这些修改。确定返回吗？'))) onBack(); }
  function showIssue(target: SettingsSection, text: string, field?: HTMLElement) {
    setSection(target); setMessage(''); setError(text);
    if (field) requestAnimationFrame(() => {
      let parent = field.parentElement;
      while (parent && parent !== form.current) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
      field.focus(); field.scrollIntoView({ block: 'center' });
    });
  }
  function invalidField() {
    for (const target of sections) {
      const fields = form.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-settings-section="${target.id}"] input, [data-settings-section="${target.id}"] select, [data-settings-section="${target.id}"] textarea`);
      for (const field of fields || []) {
        const issue = fieldError(field);
        if (issue) return { target, field, issue };
      }
    }
  }

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
    if (!settings || busy) return;
    for (const [index, provider] of settings.providers.entries()) {
      const card = form.current?.querySelectorAll('.provider-card')[index];
      if (!provider.name.trim()) { showIssue('providers', `供应商 ${index + 1}：请填写供应商名称。`, card?.querySelector<HTMLInputElement>('input') || undefined); return; }
      let validAddress = false;
      try { const address = new URL(provider.baseUrl); validAddress = ['http:', 'https:'].includes(address.protocol) && !address.username && !address.password; } catch { /* Show the field error below. */ }
      if (!validAddress) { showIssue('providers', `${provider.name}：服务地址需填写完整的 http 或 https 地址，不能包含用户名或密码。`, card?.querySelector<HTMLInputElement>('input[type="url"]') || undefined); return; }
    }
    for (const role of roles) {
      if (settings[role.providerKey] && !settings[role.modelKey]?.trim()) {
        showIssue('models', `${role.label}：已选择供应商，请选择或填写模型名称。`, form.current?.querySelector<HTMLInputElement>(`[aria-label="${role.label}模型名称"]`) || undefined); return;
      }
    }
    const field = invalidField();
    if (field) {
      const label = field.field.getAttribute('aria-label') || field.field.closest('label')?.firstChild?.textContent || '此字段';
      showIssue(field.target.id, `${field.target.label} · ${label}：${field.issue}`, field.field); return;
    }
    try { if (settings.promptTemplates) validatePromptTemplates(settings.promptTemplates); } catch (e) { showIssue('prompts', `提示词设置：${(e as Error).message}`); return; }
    const invalid = settings.modelParameters?.map(profile => {
      const provider = settings.providers.find(value => value.id === profile.providerId);
      const roleName = roles.find(value => value.role === profile.role)?.label || '模型设置';
      return { name: `${roleName} · ${provider?.name || '供应商'} · ${profile.model}`, error: profile.maxOutputTokens >= profile.contextTokens ? '单次最大输出 tokens 必须小于上下文上限 tokens。' : provider && parameterError(profile, provider.protocol) };
    }).find(profile => profile.error);
    if (invalid) { showIssue('models', `${invalid.name}：${invalid.error}`); return; }
    setBusy(true); setError(''); setMessage(''); if (testRole) setLastTest(null);
    try {
      const saved = await put<Settings>('/settings', settings); setSettings(saved); setSavedSignature(JSON.stringify(saved)); setInputDraftInvalid(false);
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
  return <main className="settings-page" data-testid="settings-page" aria-label="设置页面">
    <header className="settings-header"><Brand /><button type="button" className="text-button" disabled={busy} onClick={back}><ArrowLeft size={16} />返回作品</button></header>
    <div className="settings-page-heading"><span className="eyebrow">偏好与创作配置</span><h1 ref={title} tabIndex={-1}>设置</h1><p>配置模型服务、任务参数与提示词，让创作按你的习惯运行。</p></div>
    <div className="settings-layout">
      <nav className="settings-navigation" aria-label="设置分类">{sections.map(item => <button type="button" key={item.id} aria-current={section === item.id ? 'page' : undefined} className={section === item.id ? 'active' : ''} disabled={busy || !settings} onClick={() => { setSection(item.id); setMessage(''); }}><item.icon size={17} /><span>{item.label}</span></button>)}<p className="hint">分类之间可自由切换，修改会保留在当前页面。保存后统一生效。</p></nav>
      <div className="settings-content">
        {!settings ? <section className="settings-loading" aria-label="设置加载状态">{loading ? <Spinner /> : <><Notice error={error} /><button type="button" className="button secondary" onClick={() => setLoadAttempt(value => value + 1)}><RefreshCw size={15} />重新加载设置</button></>}</section> : <form ref={form} className="settings-form form-stack" noValidate onChange={() => setInputDraftInvalid(!!invalidField())} onSubmit={(e: FormEvent) => { e.preventDefault(); void save(); }}>
    <section data-settings-section="providers" hidden={section !== 'providers'} aria-label="供应商连接设置">
    <div className="settings-section-heading"><h2>供应商连接</h2><p>{sections[0].description}</p></div>
    <fieldset className="settings-section-fields form-stack" disabled={busy}>
    <div className="settings-providers">{settings.providers.map((provider, index) => <section className="provider-card" key={provider.id}>
      <div className="row between"><span className="eyebrow">供应商 {String(index + 1).padStart(2, '0')}</span><button type="button" className="icon-button danger-text" title="删除此供应商" aria-label={`删除供应商 ${provider.name}`} disabled={busy} onClick={() => deleteProvider(provider.id)}><Trash2 size={16} /></button></div>
      <div className="form-grid"><label>供应商名称<input required value={provider.name} onChange={e => updateProvider(index, { name: e.target.value })} placeholder="例如：我的模型服务商" /></label><label>接口协议<select aria-label="接口协议" value={provider.protocol} onChange={e => { const protocol = e.target.value as ProviderProtocol; const wasDefault = provider.baseUrl.replace(/\/+$/, '') === protocols[provider.protocol].url.replace(/\/+$/, ''); updateProvider(index, { protocol, ...(wasDefault ? { baseUrl: protocols[protocol].url } : {}) }); }}>{Object.entries(protocols).map(([key, value]) => <option key={key} value={key}>{value.name}</option>)}</select></label></div>
      <p className="hint">服务地址填写协议前缀（例如 /v1），不要填写完整生成接口。更换服务域名后，需要重新填写密钥。</p><label>服务地址<input required type="url" value={provider.baseUrl} onChange={e => updateProvider(index, { baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label>
      <label><span className="row"><KeyRound size={13} />API 密钥 {provider.hasKey && <span className="positive-text">已保存</span>}</span><input type="password" autoComplete="off" value={provider.apiKey || ''} onChange={e => updateProvider(index, { apiKey: e.target.value })} placeholder={provider.hasKey ? '留空保留现有密钥' : '输入密钥'} /></label>
      {provider.hasKey && <label className="checkbox"><input type="checkbox" checked={!!provider.clearApiKey} onChange={e => updateProvider(index, { clearApiKey: e.target.checked, apiKey: e.target.checked ? '' : provider.apiKey })} />保存时清除现有密钥</label>}
    </section>)}</div>
    <button className="button secondary align-start" type="button" disabled={busy} onClick={() => { setMessage(''); setSettings({ ...settings, providers: [...settings.providers, { id: crypto.randomUUID(), name: `供应商 ${settings.providers.length + 1}`, protocol: 'openai-chat', baseUrl: protocols['openai-chat'].url, apiKey: '' }] }); }}><Plus size={16} />添加供应商连接</button>
    {!settings.providers.length && <p className="hint">还没有供应商连接。添加连接后，可前往“任务模型”为各类任务选择模型。</p>}
    </fieldset></section>
    <section className="settings-role-card" data-settings-section="models" hidden={section !== 'models'} aria-label="任务模型设置">
    <div className="settings-section-heading"><h2>任务模型</h2><p>{sections[1].description}</p></div>
    <fieldset className="settings-section-fields form-stack" disabled={busy}>
    <div className="settings-task-grid">{roles.map(role => {
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
          {modelName ? <ProviderParameters writing={role.role === 'writing'} key={JSON.stringify([role.role, provider.id, modelName])} protocol={provider.protocol} parameters={getModelParameters(settings, role.role, provider.id, modelName)} onChange={patch => updateParameters(role.role, provider.id, modelName, patch)} onReset={() => resetParameters(role.role, provider.id, modelName)} /> : <p className="hint">选择或填写模型名称后，可设置此任务的模型参数；新模型自动使用通用默认值。</p>}
          <button type="button" className="button secondary small" aria-label={`${role.label}保存并测试连接`} disabled={busy || !model.trim() || !provider.baseUrl} onClick={() => void save(role)}><PlugZap size={15} />保存并测试连接</button>
        </>}
      </section>;
    })}</div><p className="hint">测试会保存全部设置，并按该任务所选模型的生成参数和输出上限发送一次真实请求，可能产生用量，不会自动重试。</p>
    {lastTest && <section className="settings-test-result"><div className="row between wrap"><h3>最近连接测试 · {lastTest.name}</h3><span className={`status-pill ${lastTest.ok ? 'completed' : 'failed'}`}>{lastTest.ok ? '成功' : '失败'}</span></div><p className="hint">以下是这一次测试留下的记录，之后修改设置不会改变它。</p><RequestDiagnostics key={`${lastTest.name}-${lastTest.capture?.request?.startedAt || lastTest.message}`} capture={lastTest.capture} filename="connection-test-diagnostics" showResponse /></section>}
    </fieldset></section>
    <section data-settings-section="prompts" hidden={section !== 'prompts'} aria-label="提示词编排设置">
      <div className="settings-section-heading"><h2>提示词编排</h2><p>{sections[2].description}</p></div>
      <fieldset className="settings-section-fields" disabled={busy}><PromptTemplatesPanel embedded settings={settings} disabled={busy} onChange={value => { setMessage(''); setSettings(value); }} /></fieldset>
    </section>
    <div className="settings-feedback" aria-live="polite">{error && <Notice error={error} />}{message && <div className="notice success" role="status"><CheckCircle2 size={17} />{message}</div>}</div>
    <footer className="settings-save-footer"><p className="hint">{dirty ? '有未保存的修改。保存会同时应用所有分类的设置。' : '所有分类共用一份设置，保存后统一生效。'}</p><button type="submit" className="button primary" disabled={busy}><Save size={16} />{busy ? '正在处理…' : '保存设置'}</button></footer>
  </form>}
      </div>
    </div>
  </main>;
}
