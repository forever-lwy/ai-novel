import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Plus, Trash2, KeyRound, CheckCircle2, Save, PlugZap, RefreshCw, SlidersHorizontal, ListOrdered, Image } from 'lucide-react';
import type { CapturedModelResponse, ImageSettings, ModelParameters, ModelRole, ProviderConnection, ProviderModel, ProviderProtocol, Settings, TaskSettings } from '../shared/types';
import { defaultModelParameters, getModelParameters, upsertModelParameters } from '../shared/model-settings';
import { api, post, put } from './api';
import { Brand, Notice, Spinner } from './ui';
import { ProviderParameters, parameterError } from './ProviderParameters';
import { RequestDiagnostics } from './RequestDiagnostics';
import { PromptTemplatesPanel } from './PromptTemplatesPanel';
import { validatePromptTemplates } from '../shared/prompt-templates';
import { normalizeImageSettings } from '../shared/image-settings';
import { imageModelCapabilities } from '../shared/image-capabilities';
import { normalizeTaskSettings } from '../shared/task-settings';

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
  { id: 'models', label: '任务模型', icon: SlidersHorizontal, description: '为各类任务选择模型，设置资料提取自动重试和剧情规划方式。每个任务独立保存参数，同模型用于不同任务也不共用。' },
  { id: 'prompts', label: '提示词编排', icon: ListOrdered, description: '为四类任务管理提示词预设、调整消息顺序，并预览编排后的内容。' },
  { id: 'images', label: '生图与自动插画', icon: Image, description: '选择图片模型，设置作品画风、新人物立绘与场景 CG 的自动生成。' },
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

function TaskNumber({ label, value, max, step = 1, disabled, onChange }: { label: string; value: number; max: number; step?: number; disabled: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <label>{label}<input aria-label={label} type="number" required min={0} max={max} step={step} disabled={disabled} value={text} onChange={event => { setText(event.target.value); if (event.target.value !== '' && event.target.validity.valid) onChange(Number(event.target.value)); }} /></label>;
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
  function updateTaskSettings<T extends keyof TaskSettings>(task: T, patch: Partial<TaskSettings[T]>) {
    setMessage(''); setSettings(value => {
      if (!value) return value;
      const tasks = normalizeTaskSettings(value.taskSettings);
      return { ...value, taskSettings: { ...tasks, [task]: { ...tasks[task], ...patch } } };
    });
  }
  function resetParameters(role: ModelRole, providerId: string, model: string) { setMessage(''); setSettings(value => value && upsertModelParameters(value, role, providerId, model, defaultModelParameters())); }
  function deleteProvider(providerId: string) {
    setMessage(''); setSettings(value => {
      if (!value) return value;
      const next = { ...value, providers: value.providers.filter(provider => provider.id !== providerId), modelParameters: value.modelParameters?.filter(profile => profile.providerId !== providerId) };
      for (const role of roles) if (next[role.providerKey] === providerId) { next[role.providerKey] = ''; next[role.modelKey] = ''; }
      if (next.imageSettings?.providerId === providerId) next.imageSettings = { ...next.imageSettings, providerId: '', model: '' };
      if (next.imageSettings?.promptProviderId === providerId) next.imageSettings = { ...next.imageSettings, promptProviderId: '', promptModel: '' };
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
    const imageConfig = normalizeImageSettings(settings.imageSettings);
    if (imageConfig.providerId && !imageConfig.model) { showIssue('images', '生图：已选择供应商，请填写图片模型名称。'); return; }
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
  const tasks = normalizeTaskSettings(settings?.taskSettings);
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
        {role.role === 'extraction' && <>
          <label className="checkbox"><input type="checkbox" aria-label="资料提取自动重试" checked={tasks.extraction.autoRetry} onChange={e => updateTaskSettings('extraction', { autoRetry: e.target.checked })} />资料提取失败后自动重试</label>
          <div hidden={!tasks.extraction.autoRetry}><div className="form-grid">
            <TaskNumber label="资料提取最多重试次数" value={tasks.extraction.maxRetries} max={10} disabled={!tasks.extraction.autoRetry} onChange={maxRetries => updateTaskSettings('extraction', { maxRetries })} />
            <TaskNumber label="资料提取重试间隔（秒）" value={tasks.extraction.retryDelayMs / 1000} max={300} step={0.001} disabled={!tasks.extraction.autoRetry} onChange={seconds => updateTaskSettings('extraction', { retryDelayMs: Math.round(seconds * 1000) })} />
          </div></div>
          <p className="hint">只重试资料提取，不重新生成正文。每次重试会再次调用模型，可能产生用量；0 次表示不重试。</p>
        </>}
        {role.role === 'planning' && <>
          <label className="checkbox"><input type="checkbox" aria-label="启用剧情规划" checked={tasks.planning.enabled} onChange={e => updateTaskSettings('planning', { enabled: e.target.checked })} />启用剧情规划</label>
          <label>剧情规划方式<select aria-label="剧情规划方式" value={tasks.planning.mode} disabled={!tasks.planning.enabled} onChange={e => updateTaskSettings('planning', { mode: e.target.value as TaskSettings['planning']['mode'] })}><option value="separate">独立规划模型</option><option value="tool">写作 AI 工具</option></select></label>
          <p className="hint">{!tasks.planning.enabled ? '关闭后，写作不使用预期规划，也不会生成新规划。已有规划仍可查看和手动编辑。' : tasks.planning.mode === 'tool' ? '写作 AI 通过 update_plot_plan 直接提交当前章及后 3 章的规划，随正文一起保存，不调用独立规划模型。' : '使用下面配置的模型，通过“让 AI 规划”单独生成预期规划。'}</p>
          <p className="hint">下面的模型配置同时用于摘要压缩和默认生图提示词优化。关闭规划或切换到工具模式时，配置仍会保留。</p>
        </>}
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
    <section data-settings-section="images" hidden={section !== 'images'} aria-label="生图与自动插画设置">
      <div className="settings-section-heading"><h2>生图与自动插画</h2><p>{sections[3].description}</p></div>
      <fieldset className="settings-section-fields form-stack" disabled={busy}><ImageSettingsEditor settings={settings} onChange={value => { setMessage(''); setSettings(value); }} /></fieldset>
    </section>
    <div className="settings-feedback" aria-live="polite">{error && <Notice error={error} />}{message && <div className="notice success" role="status"><CheckCircle2 size={17} />{message}</div>}</div>
    <footer className="settings-save-footer"><p className="hint">{dirty ? '有未保存的修改。保存会同时应用所有分类的设置。' : '所有分类共用一份设置，保存后统一生效。'}</p><button type="submit" className="button primary" disabled={busy}><Save size={16} />{busy ? '正在处理…' : '保存设置'}</button></footer>
  </form>}
      </div>
    </div>
  </main>;
}

const imageNumberFields = [
  { key: 'temperature', label: '图片模型 Temperature', min: 0, max: 2, step: 0.1 },
  { key: 'topP', label: '图片模型 Top P', min: 0, max: 1, step: 0.01 },
  { key: 'topK', label: '图片模型 Top K', min: 1, max: 1000000, step: 1 },
  { key: 'seed', label: '图片随机种子', min: -2147483648, max: 4294967295, step: 1 },
  { key: 'maxOutputTokens', label: '图片模型最大输出 Token', min: 1, max: 32768, step: 1 },
  { key: 'steps', label: '采样步数', min: 1, max: 100, step: 1 },
  { key: 'guidanceScale', label: '提示词引导强度', min: 0, max: 20, step: 0.1 },
] as const;
const imageQualityNames: Record<string, string> = { auto: '自动', low: '低', medium: '中', high: '高', standard: '标准', hd: '高清', xhigh: '很高', max: '最高' };
const imageThinkingNames: Record<string, string> = { minimal: '最少', low: '低', medium: '中', high: '高' };

export function ImageSettingsEditor({ settings, onChange }: { settings: Settings; onChange: (settings: Settings) => void }) {
  const image = normalizeImageSettings(settings.imageSettings); const capabilities = imageModelCapabilities(image);
  const patch = (value: Partial<ImageSettings>) => onChange({ ...settings, imageSettings: { ...image, ...value } });
  const changeImageModel = (value: Partial<ImageSettings>) => {
    const candidate: ImageSettings = { ...image, ...value }; const next = imageModelCapabilities(candidate);
    const common = new Set<keyof ImageSettings>(['providerId', 'model', 'protocol', 'size', 'quality', 'stylePrompt', 'autoPortrait', 'autoCG', 'timeoutMs', 'promptProviderId', 'promptModel', 'promptSystemPrompt', 'useCharacterReferences']);
    for (const key of Object.keys(candidate) as (keyof ImageSettings)[]) if (!common.has(key) && !next.supportedParams.includes(key)) Object.assign(candidate, { [key]: undefined });
    if (candidate.aspectRatio && candidate.aspectRatio !== 'auto' && !next.aspectRatios.includes(candidate.aspectRatio)) candidate.aspectRatio = undefined;
    if (candidate.imageSize && candidate.imageSize !== 'auto' && !next.imageSizes.includes(candidate.imageSize)) candidate.imageSize = undefined;
    if (candidate.thinkingLevel && !next.thinkingLevels.includes(candidate.thinkingLevel)) candidate.thinkingLevel = undefined;
    if (candidate.outputFormat && !next.outputFormats.includes(candidate.outputFormat)) candidate.outputFormat = undefined;
    if (candidate.inputFidelity && !next.inputFidelities.includes(candidate.inputFidelity)) candidate.inputFidelity = undefined;
    if (!next.qualityOptions.includes(candidate.quality)) candidate.quality = next.qualityOptions.includes('auto') ? 'auto' : (next.qualityOptions[0] || 'auto') as ImageSettings['quality'];
    if (candidate.size !== 'auto' && !next.sizes.includes(candidate.size) && !next.customSize) candidate.size = 'auto';
    onChange({ ...settings, imageSettings: candidate });
  };
  const supports = (key: keyof ImageSettings) => capabilities.supportedParams.includes(key);
  const fallbackId = settings.planningProviderId && settings.planningModel ? settings.planningProviderId : settings.writingProviderId;
  const fallbackName = settings.providers.find(provider => provider.id === fallbackId)?.name;
  const fallbackModel = settings.planningProviderId && settings.planningModel ? settings.planningModel : settings.writingModel;
  const pixelSizes = capabilities.sizes.filter(size => size !== 'auto');
  const currentAspectRatio = image.aspectRatio ?? (image.size === 'auto' ? 'auto' : image.size === '1024x1536' ? '2:3' : image.size === '1536x1024' ? '3:2' : '1:1');
  return <>
    <label>生图供应商<select aria-label="生图供应商" value={image.providerId} onChange={event => changeImageModel({ providerId: event.target.value, model: '' })}><option value="">暂不设置</option>{settings.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
    <label>图片接口<select aria-label="图片接口" value={image.protocol} onChange={event => changeImageModel({ protocol: event.target.value as ImageSettings['protocol'] })}><option value="openai-images">OpenAI 兼容 · Images</option><option value="gemini">Gemini · 图片生成</option><option value="together-images">Together · 图片生成</option></select></label>
    <label>图片模型名称<input aria-label="图片模型名称" maxLength={300} value={image.model} onChange={event => changeImageModel({ model: event.target.value })} placeholder="填写供应商提供的图片生成模型 ID" /></label>
    <p className="hint">图片接口复用供应商连接的服务地址和密钥。下方参数与参考图能力按所选协议和型号显示。</p>
    <section className="image-optimization-settings form-stack"><h3>AI 生图提示词</h3><p className="hint">绘图前，文字 AI 根据剧情、资料、人物参考和画风编写专用提示词。选择“AI 自行决定”时，还会选择适合本次画面的尺寸。</p><div className="form-grid">
      <label>生图提示词优化供应商<select aria-label="生图提示词优化供应商" value={image.promptProviderId || ''} onChange={event => patch({ promptProviderId: event.target.value, promptModel: '' })}><option value="">自动使用剧情规划或正文写作模型</option>{settings.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
      <label>生图提示词优化模型<input aria-label="生图提示词优化模型" maxLength={300} value={image.promptModel || ''} onChange={event => patch({ promptModel: event.target.value })} placeholder={image.promptProviderId ? '填写此供应商的文字模型 ID' : fallbackModel || '自动使用已配置的文字模型'} /></label>
    </div>{!image.promptProviderId && <p className="hint">默认先使用剧情规划模型，再使用正文写作模型。{fallbackName && fallbackModel ? `当前默认：${fallbackName} · ${fallbackModel}。` : '请先配置至少一个文字模型。'}</p>}<label>提示词优化系统要求（可选）<textarea aria-label="提示词优化系统要求" maxLength={10000} rows={3} value={image.promptSystemPrompt || ''} onChange={event => patch({ promptSystemPrompt: event.target.value })} placeholder="例如：按画面主体、构图、服装、环境、光线组织提示词，保留已确认的角色外貌。" /></label></section>
    <div className="form-grid image-dimension-fields">
      {capabilities.dimensionMode !== 'aspect-ratio' && <label>图片尺寸<select aria-label="图片尺寸" value={image.size} onChange={event => patch({ size: event.target.value as ImageSettings['size'], ...(capabilities.dimensionMode === 'width-height' ? { width: undefined, height: undefined } : {}) })}><option value="auto">AI 自行决定</option>{pixelSizes.map(size => <option key={size} value={size}>{size.replace('x', ' × ')}</option>)}{image.size !== 'auto' && !pixelSizes.includes(image.size) && <option value={image.size}>自定义 · {image.size.replace('x', ' × ')}</option>}</select></label>}
      {capabilities.customSize && capabilities.dimensionMode === 'size' && <label>自定义图片尺寸<input aria-label="自定义图片尺寸" pattern="[0-9]+x[0-9]+" value={image.size === 'auto' ? '' : image.size} onChange={event => patch({ size: event.target.value.trim() || 'auto' })} placeholder="例如 2048x2048；留空由 AI 决定" /></label>}
      {capabilities.dimensionMode === 'aspect-ratio' && <label>画幅比例<select aria-label="画幅比例" value={currentAspectRatio} onChange={event => patch({ aspectRatio: event.target.value, size: 'auto' })}><option value="auto">AI 自行决定</option>{capabilities.aspectRatios.map(ratio => <option key={ratio} value={ratio}>{ratio}</option>)}</select></label>}
      {supports('imageSize') && capabilities.imageSizes.length > 0 && <label>图片分辨率<select aria-label="图片分辨率" value={image.imageSize || ''} onChange={event => patch({ imageSize: event.target.value ? event.target.value as ImageSettings['imageSize'] : undefined })}><option value="">模型默认</option><option value="auto">AI 自行决定</option>{capabilities.imageSizes.map(size => <option key={size} value={size}>{size}</option>)}</select></label>}
      {capabilities.qualityOptions.length > 0 && <label>生成质量<select aria-label="生成质量" value={capabilities.qualityOptions.includes(image.quality) ? image.quality : ''} onChange={event => patch({ quality: (event.target.value || 'auto') as ImageSettings['quality'] })}>{!capabilities.qualityOptions.includes(image.quality) && <option value="">模型默认</option>}{capabilities.qualityOptions.map(quality => <option key={quality} value={quality}>{imageQualityNames[quality] || quality}</option>)}</select></label>}
      {capabilities.dimensionMode === 'width-height' && capabilities.customSize && <><label>自定义图片宽度<input aria-label="自定义图片宽度" type="number" min={capabilities.minDimension} max={capabilities.maxDimension} step={capabilities.dimensionMultiple} value={image.width ?? ''} onChange={event => patch({ width: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="留空按上方尺寸或 AI 选择" /></label><label>自定义图片高度<input aria-label="自定义图片高度" type="number" min={capabilities.minDimension} max={capabilities.maxDimension} step={capabilities.dimensionMultiple} value={image.height ?? ''} onChange={event => patch({ height: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="留空按上方尺寸或 AI 选择" /></label></>}
    </div>
    {capabilities.customSize && <p className="hint">自定义宽高需为 {capabilities.dimensionMultiple} 的倍数，单边 {capabilities.minDimension}～{capabilities.maxDimension} 像素。{capabilities.minPixels && capabilities.maxPixels ? `总像素 ${capabilities.minPixels.toLocaleString()}～${capabilities.maxPixels.toLocaleString()}。` : ''}{capabilities.maxAspectRatio ? `长边最多为短边的 ${capabilities.maxAspectRatio} 倍。` : ''}</p>}
    <div className="image-model-parameters form-stack"><h3>图片模型参数</h3><div className="form-grid">
      {imageNumberFields.filter(field => supports(field.key)).map(field => <label key={field.key}>{field.label}<input aria-label={field.label} type="number" min={field.min} max={field.max} step={field.step} value={image[field.key] ?? ''} onChange={event => patch({ [field.key]: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="模型默认" /></label>)}
      {supports('thinkingLevel') && <label>图片模型思考等级<select aria-label="图片模型思考等级" value={image.thinkingLevel || ''} onChange={event => patch({ thinkingLevel: event.target.value ? event.target.value as ImageSettings['thinkingLevel'] : undefined })}><option value="">模型默认</option>{capabilities.thinkingLevels.map(level => <option key={level} value={level}>{imageThinkingNames[level] || level}</option>)}</select></label>}
      {supports('outputFormat') && <label>图片输出格式<select aria-label="图片输出格式" value={image.outputFormat || ''} onChange={event => patch({ outputFormat: event.target.value ? event.target.value as ImageSettings['outputFormat'] : undefined, ...(!['jpeg', 'webp'].includes(event.target.value) ? { outputCompression: undefined } : {}), ...(event.target.value === 'jpeg' && image.background === 'transparent' ? { background: 'opaque' as const } : {}) })}><option value="">模型默认</option>{capabilities.outputFormats.map(format => <option key={format} value={format}>{format.toUpperCase()}</option>)}</select></label>}
      {supports('outputCompression') && ['jpeg', 'webp'].includes(image.outputFormat || '') && <label>JPEG／WebP 压缩质量<input aria-label="图片压缩质量" type="number" min={0} max={100} step={1} value={image.outputCompression ?? ''} onChange={event => patch({ outputCompression: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="模型默认" /></label>}
      {supports('background') && <label>图片背景<select aria-label="图片背景" value={image.background || 'auto'} onChange={event => patch({ background: event.target.value as ImageSettings['background'] })}>{capabilities.backgroundOptions.filter(background => image.outputFormat !== 'jpeg' || background !== 'transparent').map(background => <option key={background} value={background}>{{ auto: '自动', opaque: '不透明', transparent: '透明' }[background as 'auto' | 'opaque' | 'transparent'] || background}</option>)}</select></label>}
      {supports('inputFidelity') && <label>参考图保真度<select aria-label="参考图保真度" value={image.inputFidelity || ''} onChange={event => patch({ inputFidelity: event.target.value ? event.target.value as ImageSettings['inputFidelity'] : undefined })}><option value="">模型默认</option>{capabilities.inputFidelities.map(fidelity => <option key={fidelity} value={fidelity}>{fidelity === 'low' ? '低' : '高'}</option>)}</select></label>}
      {supports('moderation') && <label>图片内容审核<select aria-label="图片内容审核" value={image.moderation || 'auto'} onChange={event => patch({ moderation: event.target.value as ImageSettings['moderation'] })}><option value="auto">自动</option><option value="low">较低</option></select></label>}
    </div>{supports('systemInstruction') && <label>图片模型系统提示词<textarea aria-label="图片模型系统提示词" maxLength={32000} rows={3} value={image.systemInstruction || ''} onChange={event => patch({ systemInstruction: event.target.value })} placeholder="直接发送给图片模型的系统要求" /></label>}{supports('negativePrompt') && <label>负面提示词<textarea aria-label="负面提示词" maxLength={32000} rows={2} value={image.negativePrompt || ''} onChange={event => patch({ negativePrompt: event.target.value })} placeholder="希望避免出现在画面中的内容" /></label>}{supports('includeThoughts') && <label className="checkbox"><input type="checkbox" checked={!!image.includeThoughts} onChange={event => patch({ includeThoughts: event.target.checked })} />返回图片模型的思考内容</label>}{supports('searchGrounding') && <label className="checkbox"><input type="checkbox" checked={!!image.searchGrounding} onChange={event => patch({ searchGrounding: event.target.checked })} />使用 Google 搜索补充图片资料</label>}{supports('promptUpsampling') && <label className="checkbox"><input type="checkbox" checked={!!image.promptUpsampling} onChange={event => patch({ promptUpsampling: event.target.checked })} />供应商继续增强提示词</label>}{supports('disableSafetyChecker') && <label className="checkbox"><input type="checkbox" checked={!!image.disableSafetyChecker} onChange={event => patch({ disableSafetyChecker: event.target.checked })} />关闭供应商安全检查</label>}</div>
    <label>统一画风<textarea aria-label="统一画风" maxLength={10000} rows={3} value={image.stylePrompt} onChange={event => patch({ stylePrompt: event.target.value })} /></label>
    <label>生图超时（毫秒）<input aria-label="生图超时" type="number" min={1000} max={3600000} step={1000} value={image.timeoutMs} onChange={event => patch({ timeoutMs: Number(event.target.value) })} /></label>
    <label className="checkbox"><input type="checkbox" checked={image.useCharacterReferences !== false} onChange={event => patch({ useCharacterReferences: event.target.checked })} />CG 自动参考出场人物的已有立绘</label>
    <p className="hint image-reference-capability">{!capabilities.knownModel ? '自定义型号按所选图片协议发送请求，请使用支持对应生图与参考图能力的图片模型。' : capabilities.referenceMode === 'multiple' ? `当前型号支持多张参考图；本工作台最多使用 ${capabilities.maxReferences} 张，其中人物参考最多 ${capabilities.maxCharacterReferences} 人。` : capabilities.referenceMode === 'single' ? '当前型号支持一张参考图；修改已有 CG 时，这个位置用于原图。' : '当前型号不提供人物参考图，CG 根据人物资料绘制。'}AI 从对应场景选择人物，尚未完成的立绘不会作为参考图。</p>
    <label className="checkbox"><input type="checkbox" checked={image.autoPortrait} onChange={event => patch({ autoPortrait: event.target.checked })} />新人物自动生成立绘</label>
    <label className="checkbox"><input type="checkbox" checked={image.autoCG} onChange={event => patch({ autoCG: event.target.checked })} />场景变化或大场面时自动生成 CG</label>
    <p className="hint">插画请求在正文保存和资料整理完成后绑定到人物或剧情。图片独立生成，作者可在图册查看优化后的提示词、实际画幅与人物参考；失败和中断只由作者手动重试。</p>
  </>;
}
