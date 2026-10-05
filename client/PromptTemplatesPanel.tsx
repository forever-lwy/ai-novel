import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Download, GripVertical, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import type { Mode, PromptBlock, PromptPreset, PromptTask, PromptTemplateSettings, Settings } from '../shared/types';
import { activePromptPreset, compilePrompt, defaultPromptTemplates, promptPresetVariables, promptTaskLabels, promptTasks, promptVariables, validatePromptTemplates } from '../shared/prompt-templates';
import { Notice } from './ui';

const roleLabels = { system: '系统', user: '用户', assistant: '助手' };
const modeLabels: Record<Mode, string> = { original: '原创', continuation: '续写', fanfiction: '同人', rewrite: '改写', rpg: '穿越小说 · RPG' };
const modes = Object.keys(modeLabels) as Mode[];

function sampleValue(key: string) {
  const samples: Record<string, string> = {
    mode: 'original', title: '雾港来信', projectTitle: '雾港来信', premise: '一位年轻的信使在封港前收到一封寄给失踪船长的信。',
    instruction: '让信使在码头发现第一个线索，注意环境描写，暂时不要揭晓船长的去向。', maxWords: '1500',
    chapterTitle: '雨夜码头', chapterNumber: '2', chapterIndex: '2', chapterCount: '1', chapterId: 'sample-chapter',
    text: '雨水浸透了信使的斗篷。他把盖着蓝色火漆的信藏进怀里，沿着码头寻找失踪船长。',
    paragraphs: '1. 雨水浸透了信使的斗篷。\n2. 他把盖着蓝色火漆的信藏进怀里，沿着码头寻找失踪船长。',
    summaries: '第一章：信使收到船长失踪前寄出的信，决定赶往码头。', summary: '信使在雨夜来到码头寻找失踪船长。',
    context: '世界观：沿海港城，近代航海背景。\n角色：年轻信使林舟。\n已发生剧情：林舟收到神秘来信。',
    worldview: '沿海港城，近代航海背景。', locked: '林舟没有超自然能力。', outline: '第二章：在码头找到船长留下的物件。',
    entities: '[]', relations: '[]', foreshadows: '[]', schema: '{ "summary": "本章摘要", "entities": [], "relations": [], "foreshadows": [] }',
    endChapter: '5', blockText: '[1] 雨水浸透了林舟的斗篷。\n[2] 他把盖着蓝色火漆的信藏进怀里，沿着码头寻找失踪船长。',
    summaryText: '第一章：林舟收到船长失踪前寄出的信，决定赶往码头。\n第二章：林舟在雨夜码头找到船长遗失的怀表。',
    worldRules: '[]', mainCharacters: '[{"name":"林舟","description":"没有超自然能力的年轻信使"}]', mainCharacterRelations: '[]',
    unrevealedForeshadows: '[]', plotSummaries: '第一章：林舟收到船长失踪前寄出的信，决定赶往码头。',
    recentChapters: '林舟拿着神秘来信，在城门关闭之前赶到了雾港。', currentChapterPlan: '{"chapter":2,"title":"雨夜码头","goal":"在码头发现船长留下的怀表"}',
    writingTarget: '请写第 2 章，只写当前这一章。', sourceText: '雨水浸透了林舟的斗篷。他沿着码头寻找失踪船长。',
  };
  return samples[key] ?? `示例${key}`;
}

function clonePreset(preset: PromptPreset, name: string): PromptPreset {
  return { id: crypto.randomUUID(), name, blocks: preset.blocks.map(block => ({ ...block, id: crypto.randomUUID(), modes: block.modes && [...block.modes] })), variables: preset.variables && { ...preset.variables } };
}

function presetExport(task: PromptTask, preset: PromptPreset) {
  return {
    format: 'ai-novel-prompt-preset', version: 1, task,
    preset: {
      id: preset.id, name: preset.name,
      blocks: preset.blocks.map(({ id, name, role, enabled, content, modes: blockModes }) => ({ id, name, role, enabled, content, ...(blockModes?.length ? { modes: blockModes } : {}) })),
      ...(preset.variables ? { variables: preset.variables } : {}),
    },
  };
}

export function PromptTemplatesPanel({ settings, onChange, disabled = false, embedded = false }: { settings: Settings; onChange: (settings: Settings) => void; disabled?: boolean; embedded?: boolean }) {
  const [task, setTask] = useState<PromptTask>('writing');
  const [actionError, setActionError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [importText, setImportText] = useState('');
  const [expandedBlock, setExpandedBlock] = useState('');
  const [insertBlock, setInsertBlock] = useState('');
  const [draggedBlock, setDraggedBlock] = useState('');
  const [samples, setSamples] = useState<Record<PromptTask, Record<string, string>>>(() => Object.fromEntries(promptTasks.map(value => [value, Object.fromEntries(promptVariables[value].map(variable => [variable.key, sampleValue(variable.key)]))])) as Record<PromptTask, Record<string, string>>);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareas = useRef(new Map<string, HTMLTextAreaElement>());
  const currentSettings = useRef(settings);
  currentSettings.current = settings;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const templates = settings.promptTemplates || defaultPromptTemplates();
  const preset = activePromptPreset(templates, task);
  const variables = promptPresetVariables(task, preset);
  const targetBlock = preset.blocks.find(block => block.id === insertBlock) || preset.blocks[0];
  let validationError = '';
  try { validatePromptTemplates(templates); } catch (error) { validationError = (error as Error).message; }
  let preview: ReturnType<typeof compilePrompt> | undefined;
  let previewError = '';
  try { preview = compilePrompt(templates, task, { ...preset.variables, ...samples[task] }); } catch (error) { previewError = (error as Error).message; }

  function change(next: PromptTemplateSettings) { if (disabledRef.current) return; setActionError(''); setFeedback(''); onChange({ ...currentSettings.current, promptTemplates: next }); }
  function updatePreset(patch: Partial<PromptPreset>) { change({ ...templates, presets: { ...templates.presets, [task]: templates.presets[task].map(value => value.id === preset.id ? { ...value, ...patch } : value) } }); }
  function updateBlock(id: string, patch: Partial<PromptBlock>) { updatePreset({ blocks: preset.blocks.map(block => block.id === id ? { ...block, ...patch } : block) }); }
  function selectTask(value: PromptTask) { setTask(value); setActionError(''); setFeedback(''); setInsertBlock(''); setExpandedBlock(''); }
  function addPreset(copy = false) {
    const next = clonePreset(copy ? preset : activePromptPreset(defaultPromptTemplates(), task), copy ? `${preset.name}（副本）` : `新预设 ${templates.presets[task].length + 1}`);
    change({ ...templates, presets: { ...templates.presets, [task]: [...templates.presets[task], next] }, selected: { ...templates.selected, [task]: next.id } });
    setExpandedBlock(next.blocks[0]?.id || ''); setInsertBlock('');
  }
  function moveBlock(id: string, target: number) {
    const index = preset.blocks.findIndex(block => block.id === id);
    if (index < 0 || target < 0 || target >= preset.blocks.length || index === target) return;
    const blocks = [...preset.blocks]; const [block] = blocks.splice(index, 1); blocks.splice(target, 0, block); updatePreset({ blocks }); setExpandedBlock(id);
  }
  function insertVariable(key: string) {
    if (!targetBlock) return;
    const textarea = textareas.current.get(targetBlock.id);
    const start = textarea?.selectionStart ?? targetBlock.content.length; const end = textarea?.selectionEnd ?? start;
    const token = `{{${key}}}`;
    updateBlock(targetBlock.id, { content: targetBlock.content.slice(0, start) + token + targetBlock.content.slice(end) });
    setExpandedBlock(targetBlock.id);
    requestAnimationFrame(() => { const field = textareas.current.get(targetBlock.id); field?.focus(); field?.setSelectionRange(start + token.length, start + token.length); });
  }
  function renameVariable(index: number, key: string) {
    const entries = Object.entries(preset.variables || {});
    if (entries.some(([name], i) => i !== index && name === key)) { setActionError(`自定义变量“${key}”已存在，请使用不同的名称。`); return; }
    entries[index] = [key, entries[index][1]]; updatePreset({ variables: Object.fromEntries(entries) });
  }
  function addVariable() {
    const existing = new Set(variables.map(variable => variable.key)); let key = 'custom_variable'; let index = 2;
    while (existing.has(key)) key = `custom_variable_${index++}`;
    updatePreset({ variables: { ...preset.variables, [key]: '' } });
  }
  function setBlockMode(block: PromptBlock, mode: Mode, checked: boolean) {
    const selected = checked ? [...(block.modes || []), mode] : (block.modes || []).filter(value => value !== mode);
    if (!selected.length) { setActionError('至少选择一种写作模式；也可以勾选“所有写作模式”。'); return; }
    updateBlock(block.id, { modes: selected });
  }
  function exportPreset() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(presetExport(task, preset), null, 2)], { type: 'application/json;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${preset.name.replace(/[\\/:*?"<>|]/g, '_') || '提示词预设'}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback('已导出当前预设。文件仅含提示词和自定义变量。');
  }
  function importPreset(text: string) {
    try {
      if (disabledRef.current) return;
      if (new TextEncoder().encode(text).length > 700000) throw new Error('预设文件过大，请缩减到 700000 字节以内。');
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请使用本项目导出的提示词预设 JSON。');
      const payload = parsed as Record<string, unknown>;
      if (payload.format !== 'ai-novel-prompt-preset' || payload.version !== 1 || !promptTasks.includes(payload.task as PromptTask)) throw new Error('预设格式、版本或任务类型不正确，请使用本项目导出的预设。');
      const importedTask = payload.task as PromptTask;
      if (!payload.preset || typeof payload.preset !== 'object' || Array.isArray(payload.preset)) throw new Error('文件缺少提示词预设。');
      const incoming = payload.preset as PromptPreset;
      const candidate = defaultPromptTemplates(); candidate.presets[importedTask] = [incoming]; candidate.selected[importedTask] = incoming.id;
      const checked = validatePromptTemplates(candidate); const imported = clonePreset(activePromptPreset(checked, importedTask), incoming.name);
      const latestTemplates = currentSettings.current.promptTemplates || defaultPromptTemplates();
      const next = { ...latestTemplates, presets: { ...latestTemplates.presets, [importedTask]: [...latestTemplates.presets[importedTask], imported] }, selected: { ...latestTemplates.selected, [importedTask]: imported.id } };
      validatePromptTemplates(next); change(next); selectTask(importedTask); setImportText(''); setFeedback(`已新增“${imported.name}”。点击“保存设置”后生效。`);
    } catch (error) { setActionError(`导入失败：${(error as Error).message}`); }
  }
  async function readFile(file?: File) {
    if (!file) return;
    try { if (file.size > 700000) throw new Error('预设文件过大，请缩减到 700000 字节以内。'); importPreset(await file.text()); }
    catch (error) { setActionError(`导入失败：${(error as Error).message}`); }
  }

  const body = <div className="prompt-templates-body form-stack">
      <p className="hint">为正文写作、剧情规划、资料提取和摘要压缩分别编排提示词。启用的块按顺序发送，使用 {'{{变量名}}'} 引入本次任务的素材。修改后点击下方“保存设置”生效。</p>
      <div className="prompt-task-tabs" role="tablist" aria-label="提示词任务">{promptTasks.map(value => <button type="button" key={value} role="tab" aria-selected={task === value} className={task === value ? 'active' : ''} disabled={disabled} onClick={() => selectTask(value)}>{promptTaskLabels[value]}</button>)}</div>
      <section className="prompt-preset-editor form-stack" aria-label={`${promptTaskLabels[task]}提示词预设`}>
        <div className="prompt-preset-heading"><label>当前预设<select aria-label="当前提示词预设" disabled={disabled} value={preset.id} onChange={event => { change({ ...templates, selected: { ...templates.selected, [task]: event.target.value } }); setInsertBlock(''); setExpandedBlock(''); }}>{templates.presets[task].map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label><div className="row wrap"><button type="button" className="button secondary small" disabled={disabled} onClick={() => addPreset()}><Plus size={14} />新建预设</button><button type="button" className="button secondary small" disabled={disabled} onClick={() => addPreset(true)}><Copy size={14} />复制预设</button><button type="button" className="icon-button danger-text" aria-label="删除当前提示词预设" title="删除当前预设（每个任务至少保留一个）" disabled={disabled || templates.presets[task].length <= 1} onClick={() => { const remaining = templates.presets[task].filter(value => value.id !== preset.id); change({ ...templates, presets: { ...templates.presets, [task]: remaining }, selected: { ...templates.selected, [task]: remaining[0].id } }); }}><Trash2 size={15} /></button></div></div>
        <label>预设名称<input aria-label="提示词预设名称" value={preset.name} disabled={disabled} onChange={event => updatePreset({ name: event.target.value })} /></label>
        <div className="row wrap between"><span className="hint">{preset.blocks.length} 个块 · {preset.blocks.filter(block => block.enabled).length} 个启用。拖动手柄或使用上下箭头调整顺序。</span><button type="button" className="text-button" disabled={disabled} onClick={() => { const defaults = activePromptPreset(defaultPromptTemplates(), task); const reset = clonePreset(defaults, preset.name); updatePreset({ blocks: reset.blocks, variables: reset.variables }); setFeedback('当前预设已恢复默认内容；保存后生效。'); }}><RotateCcw size={13} />恢复默认提示词</button></div>
        <div className="prompt-block-list">{preset.blocks.map((block, index) => <details key={`${preset.id}-${block.id}`} className={`prompt-block ${block.enabled ? '' : 'is-disabled'}`} data-testid="prompt-block" data-block-id={block.id} open={index === 0 || expandedBlock === block.id} onDragOver={event => { if (draggedBlock) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (draggedBlock && !disabled) moveBlock(draggedBlock, index); setDraggedBlock(''); }}>
          <summary><span className="prompt-block-handle" draggable={!disabled} title="拖动调整顺序" onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', block.id); setDraggedBlock(block.id); }} onDragEnd={() => setDraggedBlock('')}><GripVertical size={15} /></span><span className="prompt-block-number">{String(index + 1).padStart(2, '0')}</span><strong>{block.name || '未命名块'}</strong><span className="prompt-block-badge">{roleLabels[block.role]}</span>{!block.enabled && <span className="hint">已停用</span>}{task === 'writing' && !!block.modes?.length && <small>{block.modes.map(mode => modeLabels[mode]).join('、')}</small>}</summary>
          <div className="prompt-block-body form-stack">
            <div className="row wrap between"><label className="checkbox"><input type="checkbox" aria-label={`启用提示词块 ${index + 1}`} checked={block.enabled} disabled={disabled} onChange={event => updateBlock(block.id, { enabled: event.target.checked })} />启用此块</label><div className="row"><button type="button" className="icon-button" aria-label={`上移提示词块 ${index + 1}`} title="上移" disabled={disabled || index === 0} onClick={() => moveBlock(block.id, index - 1)}><ArrowUp size={15} /></button><button type="button" className="icon-button" aria-label={`下移提示词块 ${index + 1}`} title="下移" disabled={disabled || index === preset.blocks.length - 1} onClick={() => moveBlock(block.id, index + 1)}><ArrowDown size={15} /></button><button type="button" className="icon-button" aria-label={`复制提示词块 ${index + 1}`} title="复制此块" disabled={disabled} onClick={() => { const copy = { ...block, id: crypto.randomUUID(), name: `${block.name}（副本）` }; const blocks = [...preset.blocks]; blocks.splice(index + 1, 0, copy); updatePreset({ blocks }); setExpandedBlock(copy.id); }}><Copy size={15} /></button><button type="button" className="icon-button danger-text" aria-label={`删除提示词块 ${index + 1}`} title="删除此块" disabled={disabled || preset.blocks.length <= 1} onClick={() => updatePreset({ blocks: preset.blocks.filter(value => value.id !== block.id) })}><Trash2 size={15} /></button></div></div>
            <div className="form-grid"><label>块名称<input aria-label={`提示词块 ${index + 1} 名称`} value={block.name} disabled={disabled} onChange={event => updateBlock(block.id, { name: event.target.value })} /></label><label>消息角色<select aria-label={`提示词块 ${index + 1} 角色`} value={block.role} disabled={disabled} onChange={event => updateBlock(block.id, { role: event.target.value as PromptBlock['role'] })}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            {task === 'writing' && <fieldset className="prompt-block-modes"><legend>适用写作模式</legend><label className="checkbox"><input type="checkbox" aria-label={`提示词块 ${index + 1} 所有写作模式`} checked={!block.modes?.length} disabled={disabled} onChange={event => updateBlock(block.id, { modes: event.target.checked ? undefined : ['original'] })} />所有写作模式</label>{modes.map(mode => <label className="checkbox" key={mode}><input type="checkbox" aria-label={`提示词块 ${index + 1} 适用于 ${modeLabels[mode]}`} checked={!block.modes?.length || block.modes.includes(mode)} disabled={disabled || !block.modes?.length} onChange={event => setBlockMode(block, mode, event.target.checked)} />{modeLabels[mode]}</label>)}</fieldset>}
            <label>提示词内容<textarea ref={element => { if (element) textareas.current.set(block.id, element); else textareas.current.delete(block.id); }} aria-label={`提示词块 ${index + 1} 内容`} rows={Math.min(14, Math.max(4, block.content.split('\n').length))} className="prompt-content-input" value={block.content} disabled={disabled} onFocus={() => setInsertBlock(block.id)} onChange={event => updateBlock(block.id, { content: event.target.value })} placeholder="输入任务要求，使用下方变量按钮插入本次任务的素材。" spellCheck={false} /></label>
          </div>
        </details>)}</div>
        <button type="button" className="button secondary small align-start" disabled={disabled} onClick={() => { const block: PromptBlock = { id: crypto.randomUUID(), name: `提示词块 ${preset.blocks.length + 1}`, role: 'user', enabled: true, content: '' }; updatePreset({ blocks: [...preset.blocks, block] }); setExpandedBlock(block.id); setInsertBlock(block.id); }}><Plus size={14} />添加提示词块</button>
        <details className="prompt-inner-fold"><summary>可用变量与自定义变量</summary><div className="form-stack">
          <p className="hint">变量只替换一次，素材中出现的 {'{{文字}}'} 会保留原样。先选择插入位置，再点击变量；使用过的变量名称需要在重命名后同步修改。</p>
          <label>变量插入位置<select aria-label="变量插入位置" disabled={disabled} value={targetBlock?.id || ''} onChange={event => setInsertBlock(event.target.value)}>{preset.blocks.map((block, index) => <option key={block.id} value={block.id}>{index + 1}. {block.name || '未命名块'}</option>)}</select></label>
          <div className="prompt-variable-list">{variables.map(variable => <button type="button" className="prompt-variable-button" key={variable.key} disabled={disabled || !targetBlock} aria-label={`插入变量 ${variable.key}`} title={variable.label} onClick={() => insertVariable(variable.key)}><code>{`{{${variable.key}}}`}</code><span>{variable.label}</span></button>)}</div>
          <div className="row wrap between"><h4>自定义变量</h4><button type="button" className="text-button" disabled={disabled} onClick={addVariable}><Plus size={13} />添加自定义变量</button></div>
          <p className="hint">变量名使用英文字母、数字和下划线，以英文字母开头；不能覆盖内置变量。变量值可写风格规则或常用要求，属于当前预设。</p>
          {Object.entries(preset.variables || {}).map(([key, value], index) => <div className="prompt-custom-variable" key={index}><label>变量名<input aria-label={`自定义变量 ${index + 1} 名称`} value={key} disabled={disabled} onChange={event => renameVariable(index, event.target.value)} spellCheck={false} /></label><label>变量值<textarea aria-label={`自定义变量 ${index + 1} 值`} rows={2} value={value} disabled={disabled} onChange={event => updatePreset({ variables: { ...preset.variables, [key]: event.target.value } })} /></label><button type="button" className="icon-button danger-text" aria-label={`删除自定义变量 ${index + 1}`} disabled={disabled} onClick={() => updatePreset({ variables: Object.fromEntries(Object.entries(preset.variables || {}).filter(([name]) => name !== key)) })}><Trash2 size={15} /></button></div>)}
        </div></details>
        <details className="prompt-inner-fold"><summary>编译预览 · 使用示例素材</summary><div className="form-stack">
          <p className="hint">这里展示示例变量替换后的消息，不调用模型。实际任务会填入当前作品、章节和规划资料。正文写作会根据示例 mode 筛选适用的块。</p>
          <details className="prompt-example-values"><summary>编辑示例变量</summary><div className="form-stack">{promptVariables[task].map(variable => <label key={variable.key}>{variable.label} <code>{`{{${variable.key}}}`}</code>{variable.key === 'mode' ? <select aria-label={`示例变量 ${variable.key}`} value={samples[task][variable.key]} onChange={event => setSamples(value => ({ ...value, [task]: { ...value[task], [variable.key]: event.target.value } }))}>{modes.map(mode => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}</select> : <textarea aria-label={`示例变量 ${variable.key}`} rows={2} value={samples[task][variable.key]} onChange={event => setSamples(value => ({ ...value, [task]: { ...value[task], [variable.key]: event.target.value } }))} />}</label>)}</div></details>
          {previewError ? <Notice error={previewError} /> : <div className="prompt-preview-messages" aria-label="提示词编译预览">{preview?.messages.map((message, index) => <section className="prompt-preview-message" key={index}><span>{index + 1}. {roleLabels[message.role]}</span><pre>{message.content}</pre></section>)}</div>}
          <p className="hint">这里只预览自定义消息。OpenAI Chat / Responses 保留消息顺序；Claude / Gemini 将系统块合并到系统区。规划、提取和压缩任务还会附加单个 JSON 对象的输出要求，建议保留默认格式说明。最终请求可在请求诊断中查看。</p>
        </div></details>
        <details className="prompt-inner-fold"><summary>导入与导出预设 JSON</summary><div className="form-stack">
          <p className="hint">只交换当前任务的提示词预设，包括自定义变量，不带供应商连接和 API 密钥。导入会新增预设；文件中的任务类型决定归属。</p>
          <div className="row wrap"><button type="button" className="button secondary small" disabled={disabled || !!validationError} onClick={exportPreset}><Download size={14} />导出当前提示词预设</button><button type="button" className="button secondary small" disabled={disabled} onClick={() => fileInput.current?.click()}><Upload size={14} />选择预设 JSON 文件</button><input type="file" className="visually-hidden" ref={fileInput} accept=".json,application/json" aria-label="导入提示词预设文件" disabled={disabled} onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ''; }} /></div>
          <label>或粘贴预设 JSON<textarea aria-label="导入提示词预设 JSON" className="prompt-content-input" rows={5} value={importText} disabled={disabled} onChange={event => setImportText(event.target.value)} spellCheck={false} /></label><button type="button" className="button secondary small align-start" disabled={disabled || !importText.trim()} onClick={() => importPreset(importText)}>从 JSON 新增预设</button>
        </div></details>
      </section>
      {validationError && <Notice error={`提示词暂不能保存：${validationError}`} />}{actionError && <Notice error={actionError} />}{feedback && <p className="hint" role="status">{feedback}</p>}
    </div>;
  return embedded ? <section className="prompt-templates prompt-templates-embedded" data-testid="prompt-templates-panel">{body}</section> : <details className="prompt-templates" data-testid="prompt-templates-panel"><summary>任务提示词与编排 <span>四类任务 · 分块编辑 · 预设</span></summary>{body}</details>;
}
