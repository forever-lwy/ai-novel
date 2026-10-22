import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Plus, Save, Upload } from 'lucide-react';
import { EXAMPLE_SCRIPT, EXAMPLE_SCRIPT_SCHEMA, type ExtensionSettings, type ImportedSkill, type McpConnection, type ScriptTool } from '../shared/extensions';
import { api } from './api';
import { Notice, Spinner } from './ui';

const tabs = [{ id: 'scripts', label: '脚本工具' }, { id: 'mcpServers', label: 'MCP 服务' }, { id: 'skills', label: '技能' }] as const;
type Tab = typeof tabs[number]['id'];
function json(text: string, name: string, array = false) {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${name}不是有效 JSON。`); }
  if (array ? !Array.isArray(value) || value.some(item => typeof item !== 'string') : !value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}必须是${array ? '字符串数组' : 'JSON 对象'}。`);
  return value;
}
export function ExtensionsPanel({ onDirtyChange, onBusyChange }: { onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const [config, setConfig] = useState<ExtensionSettings | null>(null);
  const [saved, setSaved] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('scripts');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [testArgs, setTestArgs] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [opened, setOpened] = useState<string>();
  const input = useRef<HTMLInputElement>(null); const controller = useRef<AbortController | null>(null);
  const dirty = !!config && (JSON.stringify(config) !== saved || Object.keys(drafts).length > 0);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(busy), [busy, onBusyChange]);
  useEffect(() => { void reload(); return () => { controller.current?.abort(); controller.current = null; }; }, []);
  function accept(value: ExtensionSettings) { setConfig(value); setSaved(JSON.stringify(value)); setDrafts({}); }
  async function action(work: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError(''); setMessage('');
    try { await work(current.signal); } catch (error) { if (!current.signal.aborted) setError((error as Error).message); }
    finally { if (controller.current === current) controller.current = null; if (!current.signal.aborted) { setBusy(false); setLoading(false); } }
  }
  async function reload() { await action(async signal => { accept(await api<ExtensionSettings>('/extensions', { signal })); }); }
  function change<T extends ScriptTool | McpConnection | ImportedSkill>(collection: Tab, item: T) {
    if (!config) return;
    setConfig({ ...config, [collection]: config[collection].map(value => value.id === item.id ? item : value) }); setMessage('');
  }
  function remove(collection: Tab, id: string) {
    if (!config) return;
    setConfig({ ...config, [collection]: config[collection].filter(value => value.id !== id) });
    setDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(`${id}:`))));
    setMessage('已从草稿移除，保存后生效。');
  }
  function draftValue(id: string, key: string, value: unknown) { return drafts[`${id}:${key}`] ?? JSON.stringify(value, null, 2); }
  function draft(id: string, key: string, value: string) { setDrafts(previous => ({ ...previous, [`${id}:${key}`]: value })); setMessage(''); }
  function prepared(): ExtensionSettings {
    if (!config) throw new Error('配置尚未加载。');
    return { ...config,
      scripts: config.scripts.map(script => ({ ...script, inputSchema: json(draftValue(script.id, 'schema', script.inputSchema), `“${script.name}”的参数格式`) as Record<string, unknown> })),
      mcpServers: config.mcpServers.map(server => ({ ...server,
        args: json(draftValue(server.id, 'args', server.args), `“${server.name}”的命令参数`, true) as string[],
        env: json(draftValue(server.id, 'env', server.env), `“${server.name}”的环境变量`) as Record<string, string>,
        headers: json(draftValue(server.id, 'headers', server.headers), `“${server.name}”的请求头`) as Record<string, string>,
      })),
    };
  }
  async function save() { await action(async signal => { const value = prepared(); accept(await api<ExtensionSettings>('/extensions', { method: 'PUT', body: JSON.stringify(value), signal })); setMessage('工具与技能已保存。启用的项目会进入之后的写作请求。'); }); }
  function addScript() {
    if (!config) return;
    const tool: ScriptTool = { id: crypto.randomUUID(), name: '文字字数统计', description: '统计指定文字的字数，不含空白；需要核对篇幅时使用。', enabled: false, inputSchema: EXAMPLE_SCRIPT_SCHEMA, code: EXAMPLE_SCRIPT, timeoutMs: 10000 };
    setConfig({ ...config, scripts: [...config.scripts, tool] }); setOpened(tool.id);
  }
  function addMcp() {
    if (!config) return;
    const server: McpConnection = { id: crypto.randomUUID(), name: '我的 MCP 服务', description: '提供创作所需的外部工具。', enabled: false, transport: 'http', url: '', command: '', args: [], env: {}, headers: {}, tools: [], timeoutMs: 30000 };
    setConfig({ ...config, mcpServers: [...config.mcpServers, server] }); setOpened(server.id);
  }
  async function importFile(file: File) {
    await action(async signal => {
      if (file.size > 2 * 1024 * 1024) throw new Error('技能文件最多 2 MiB。');
      const form = new FormData(); form.append('file', file);
      const skill = await api<ImportedSkill>('/extensions/skills/import', { method: 'POST', body: form, signal });
      setConfig(previous => previous ? { ...previous, skills: [...previous.skills, skill] } : previous); setTab('skills'); setOpened(skill.id);
      setMessage('技能已导入草稿，默认停用。检查正文和附件，勾选启用并保存后生效。');
    });
  }
  async function testScript(script: ScriptTool) {
    await action(async signal => {
      const result = await api<unknown>(`/extensions/scripts/${script.id}/test`, { method: 'POST', signal, body: JSON.stringify({ revision: config!.revision, arguments: json(testArgs[script.id] ?? '{"text":"测试文字"}', '测试参数') }) });
      setTestResults(previous => ({ ...previous, [script.id]: JSON.stringify(result, null, 2) })); setMessage('脚本已实际执行，结果见下方。');
    });
  }
  async function discover(server: McpConnection) {
    await action(async signal => {
      const value = await api<ExtensionSettings>(`/extensions/mcp/${server.id}/discover`, { method: 'POST', signal, body: JSON.stringify({ revision: config!.revision }) });
      accept(value); const count = value.mcpServers.find(value => value.id === server.id)?.tools.length ?? 0;
      setMessage(`连接成功，发现 ${count} 个工具。工具完整参数会在模型需要时加载。`);
    });
  }
  const codeInput = (label: string, value: string, onChange: (value: string) => void, rows = 5) => <label>{label}<textarea aria-label={label} className="extension-code" rows={rows} spellCheck={false} value={value} onChange={event => onChange(event.target.value)} /></label>;
  if (!config) return <section aria-label="工具与技能加载状态">{loading ? <Spinner /> : <><Notice error={error} /><button type="button" className="button secondary" disabled={busy} onClick={() => void reload()}>重新加载工具与技能</button></>}</section>;
  return <form className="form-stack extensions-panel" aria-label="工具与技能设置" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="settings-section-heading"><h2>工具与技能</h2><p>为正文写作和穿越体验添加能力。模型先看名称和简介，按需加载完整说明、参数与附件，再调用工具。</p></div>
    <div className="extension-disclosure"><span>1　查看简介</span><span>2　按需加载</span><span>3　调用或读取附件</span></div>
    <div className="extension-tabs" role="tablist" aria-label="扩展类型">{tabs.map((value, index) => <button key={value.id} id={`extensions-tab-${value.id}`} aria-controls={`extensions-${value.id}`} type="button" role="tab" aria-selected={tab === value.id} tabIndex={tab === value.id ? 0 : -1} disabled={busy} onClick={() => setTab(value.id)} onKeyDown={event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
      if (next === undefined) return; event.preventDefault(); setTab(tabs[next].id); document.getElementById(`extensions-tab-${tabs[next].id}`)?.focus();
    }}>{value.label}<span>{config[value.id].length}</span></button>)}</div>
    <fieldset disabled={busy} className="settings-section-fields form-stack">
      <section role="tabpanel" id="extensions-scripts" aria-labelledby="extensions-tab-scripts" hidden={tab !== 'scripts'} className="extension-list">
        <p className="hint">JavaScript 接收 args，使用 return 返回 JSON。代码在服务器以服务进程权限运行，独立进程不等于安全沙箱，请只添加可信代码。默认超时 10 秒，结果最多 64 KiB。</p>
        <button type="button" className="button secondary align-start" onClick={addScript}><Plus size={15} />添加脚本工具</button>
        {!config.scripts.length && <p className="extension-empty">还没有脚本工具。可以从字数统计示例开始修改。</p>}
        {config.scripts.map(script => <article className="extension-card form-stack" key={script.id}>
          <div className="row between"><h3>{script.name}</h3><label className="checkbox"><input type="checkbox" aria-label={`启用脚本 ${script.name}`} checked={script.enabled} onChange={event => change('scripts', { ...script, enabled: event.target.checked })} />启用</label></div>
          <p className="hint">{script.description}</p>
          <details open={opened === script.id} onToggle={event => { if (event.currentTarget.open) setOpened(script.id); else setOpened(value => value === script.id ? undefined : value); }}><summary>编辑说明与脚本</summary><div className="form-stack">
            <label>工具名称<input aria-label="脚本名称" value={script.name} maxLength={100} onChange={event => change('scripts', { ...script, name: event.target.value })} /></label>
            <label>用途与使用时机<textarea aria-label="脚本简介" rows={3} value={script.description} maxLength={4000} onChange={event => change('scripts', { ...script, description: event.target.value })} /></label>
            {codeInput('参数 JSON Schema', draftValue(script.id, 'schema', script.inputSchema), value => draft(script.id, 'schema', value), 7)}
            {codeInput('JavaScript 代码', script.code, code => change('scripts', { ...script, code }), 9)}
            <label>超时（毫秒）<input aria-label="脚本超时" type="number" min={100} max={60000} value={script.timeoutMs} onChange={event => change('scripts', { ...script, timeoutMs: Number(event.target.value) })} /></label>
            <details><summary>测试脚本</summary><div className="form-stack">{codeInput('测试参数 JSON', testArgs[script.id] ?? '{"text":"测试文字"}', value => setTestArgs(previous => ({ ...previous, [script.id]: value })), 3)}<p className="hint">测试会实际运行已保存的脚本；停用的脚本也可手动测试。</p><button type="button" className="button secondary align-start" disabled={dirty} onClick={() => void testScript(script)}>运行测试</button>{dirty && <p className="hint">请先保存工具与技能，再运行测试。</p>}{testResults[script.id] && <pre className="extension-result" aria-label="脚本测试结果">{testResults[script.id]}</pre>}</div></details>
            <button type="button" className="text-button danger-text align-start" onClick={() => remove('scripts', script.id)}>移除脚本</button>
          </div></details>
        </article>)}
      </section>
      <section role="tabpanel" id="extensions-mcpServers" aria-labelledby="extensions-tab-mcpServers" hidden={tab !== 'mcpServers'} className="extension-list">
        <p className="hint">支持远程 Streamable HTTP 和本地 stdio。保存连接后点击“连接并发现工具”；此操作会连接服务或启动本地进程，读取目录，不调用具体工具。本地命令运行在服务器上。</p>
        <button type="button" className="button secondary align-start" onClick={addMcp}><Plus size={15} />添加 MCP 服务</button>
        {!config.mcpServers.length && <p className="extension-empty">还没有 MCP 服务。填写完整的 MCP 地址，或服务器上已安装的启动命令。</p>}
        {config.mcpServers.map(server => <article className="extension-card form-stack" key={server.id}>
          <div className="row between"><h3>{server.name}</h3><label className="checkbox"><input type="checkbox" aria-label={`启用 MCP ${server.name}`} checked={server.enabled} onChange={event => change('mcpServers', { ...server, enabled: event.target.checked })} />启用</label></div>
          <p className="hint">{server.description} · {server.discoveredAt ? `${server.tools.length} 个工具` : '尚未连接'}</p>
          <details open={opened === server.id} onToggle={event => { if (event.currentTarget.open) setOpened(server.id); else setOpened(value => value === server.id ? undefined : value); }}><summary>编辑连接</summary><div className="form-stack">
            <label>服务名称<input aria-label="MCP 名称" maxLength={100} value={server.name} onChange={event => change('mcpServers', { ...server, name: event.target.value })} /></label>
            <label>服务简介<textarea aria-label="MCP 简介" rows={2} maxLength={4000} value={server.description} onChange={event => change('mcpServers', { ...server, description: event.target.value })} /></label>
            <label>连接方式<select aria-label="MCP 连接方式" value={server.transport} onChange={event => change('mcpServers', { ...server, transport: event.target.value as McpConnection['transport'] })}><option value="http">远程 Streamable HTTP</option><option value="stdio">本地 stdio</option></select></label>
            {server.transport === 'http' ? <><label>MCP 完整地址<input aria-label="MCP 地址" type="url" value={server.url} placeholder="https://example.com/mcp" onChange={event => change('mcpServers', { ...server, url: event.target.value })} /></label>{codeInput('MCP 请求头 JSON', draftValue(server.id, 'headers', server.headers), value => draft(server.id, 'headers', value), 3)}<p className="hint">例如 Authorization 请求头。支持手动填写令牌，不提供 OAuth 登录和旧版 SSE。生产环境沿用服务器的出站来源限制。</p></> : <><label>可执行命令<input aria-label="MCP 命令" value={server.command} placeholder="node 或可执行文件的完整路径" onChange={event => change('mcpServers', { ...server, command: event.target.value })} /></label>{codeInput('MCP 命令参数 JSON', draftValue(server.id, 'args', server.args), value => draft(server.id, 'args', value), 3)}{codeInput('MCP 环境变量 JSON', draftValue(server.id, 'env', server.env), value => draft(server.id, 'env', value), 3)}<p className="hint">命令参数填写字符串数组，例如 ["/path/to/server.mjs"]。工作目录是数据目录下的 extension-runtime，脚本文件请填写绝对路径；程序及依赖需先在服务器安装。</p></>}
            <p className="hint">环境变量和请求头加密保存，重新打开不会显示。空对象保留已有值；修改地址或启动命令后须重新填写凭据并发现工具。</p>
            {server.hasSecrets && <label className="checkbox"><input type="checkbox" checked={!!server.clearSecrets} onChange={event => change('mcpServers', { ...server, clearSecrets: event.target.checked })} />已保存凭据，勾选后在保存时清除</label>}
            <label>连接与调用超时（毫秒）<input aria-label="MCP 超时" type="number" min={100} max={60000} value={server.timeoutMs} onChange={event => change('mcpServers', { ...server, timeoutMs: Number(event.target.value) })} /></label>
            <button type="button" className="button secondary align-start" disabled={dirty} onClick={() => void discover(server)}>连接并发现工具</button>{dirty && <p className="hint">请先保存工具与技能，再连接服务。</p>}
            {server.discoveredAt && <details><summary>已发现的工具（{server.tools.length}）</summary><div className="extension-tool-list">{server.tools.map(tool => <details key={tool.name}><summary>{tool.name}</summary><p className="hint">{tool.description}</p><pre className="extension-result">{JSON.stringify(tool.inputSchema, null, 2)}</pre></details>)}</div></details>}
            <button type="button" className="text-button danger-text align-start" onClick={() => remove('mcpServers', server.id)}>移除 MCP 服务</button>
          </div></details>
        </article>)}
      </section>
      <section role="tabpanel" id="extensions-skills" aria-labelledby="extensions-tab-skills" hidden={tab !== 'skills'} className="extension-list">
        <p className="hint">导入 SKILL.md 或包含一个技能的 ZIP。支持 YAML 名称与简介、正文、references 和其他附件；正文按需加载，长文件分段读取。包内脚本保留供查看，不会自动运行。</p>
        <input ref={input} hidden type="file" accept=".md,.zip" aria-label="技能文件" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
        <button type="button" className="button secondary align-start" onClick={() => input.current?.click()}><Upload size={15} />导入技能</button>
        {!config.skills.length && <p className="extension-empty">还没有技能。导入后可以检查内容，再决定是否启用。</p>}
        {config.skills.map(skill => <article className="extension-card form-stack" key={skill.id}>
          <div className="row between"><h3>{skill.name}</h3><label className="checkbox"><input type="checkbox" aria-label={`启用技能 ${skill.name}`} checked={skill.enabled} onChange={event => change('skills', { ...skill, enabled: event.target.checked })} />启用</label></div>
          <p className="hint">{skill.description}</p>
          <details open={opened === skill.id} onToggle={event => { if (event.currentTarget.open) setOpened(skill.id); else setOpened(value => value === skill.id ? undefined : value); }}><summary>查看与编辑技能（{skill.files.length} 个文件）</summary><div className="form-stack">
            {codeInput('SKILL.md 正文', skill.files.find(file => file.path === 'SKILL.md')?.content ?? '', content => change('skills', { ...skill, files: skill.files.map(file => file.path === 'SKILL.md' ? { ...file, content } : file) }), 14)}
            <p className="hint">名称与简介取自顶部 YAML 的 name 和 description，保存时重新解析。附件中的命令不会自动获得执行权限。</p>
            {skill.files.filter(file => file.path !== 'SKILL.md').map(file => <details key={file.path}><summary>{file.path}{file.encoding === 'base64' ? '（二进制附件）' : ''}</summary>{file.encoding === 'utf8' ? <pre className="extension-result">{file.content}</pre> : <p className="hint">二进制原文件已保存，当前模型仅支持读取文本附件。</p>}</details>)}
            <button type="button" className="text-button danger-text align-start" onClick={() => remove('skills', skill.id)}>移除技能</button>
          </div></details>
        </article>)}
      </section>
    </fieldset>
    <div aria-live="polite">{error && <Notice error={error} />}{message && <div role="status" className="notice success"><CheckCircle2 size={17} />{message}</div>}</div>
    <footer className="settings-save-footer"><p className="hint">{dirty ? '有未保存的工具与技能修改。切换分类保留草稿。' : '工具与技能单独保存，全局生效，不包含在单作品备份中。'}</p><div className="extension-actions"><button type="button" className="text-button" disabled={busy} onClick={() => { if (!dirty || window.confirm('重新加载会放弃未保存的工具与技能修改。确定继续吗？')) void reload(); }}>重新加载</button><button type="submit" className="button primary" disabled={busy}><Save size={16} />{busy ? '正在处理…' : '保存工具与技能'}</button></div></footer>
  </form>;
}
