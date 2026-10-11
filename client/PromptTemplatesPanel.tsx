import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Copy, Download, GripVertical, Pencil, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import type { Mode, PromptBlock, PromptFeature, PromptPreset, PromptScope, PromptTask, PromptTemplateSettings, ProviderProtocol, Settings } from '../shared/types';
import type { PromptPreviewInput, PromptPreviewResult } from '../shared/prompt-runtime';
import { normalizeTaskSettings } from '../shared/task-settings';
import { normalizeImageSettings } from '../shared/image-settings';
import { api } from './api';
import { activePromptPreset, compilePrompt, defaultPromptTemplates, promptPresetList, promptPresetVariables, promptScopeLabels, promptScopes, promptTaskLabels, promptTasks, promptVariables, validatePromptTemplates } from '../shared/prompt-templates';
import { Modal, Notice } from './ui';

const roleLabels = { system: '系统', user: '用户', assistant: '助手' };
const modeLabels: Record<Mode, string> = { original: '原创', continuation: '续写', fanfiction: '同人', rewrite: '改写', rpg: '穿越小说 · RPG' };
const modes = Object.keys(modeLabels) as Mode[];
const featureLabels: Record<PromptFeature, string> = { snow: '雪融雪降 · 长文本填充', 'cot-three': '三段输出结构', 'cot-single': '单段输出结构', 'defense-normal': '普通防空回尾段', 'defense-laoda': '牢大防空回尾段' };
const protocolLabels: Record<ProviderProtocol, string> = { 'openai-chat': 'OpenAI Chat', 'openai-responses': 'OpenAI Responses', gemini: 'Gemini', claude: 'Claude' };
type Naming = { kind: 'preset' | 'block' | 'import'; operation: 'create' | 'copy' | 'rename' | 'import'; name: string; blockId?: string;
  imported?: { task: PromptScope; templates: PromptTemplateSettings; presetId: string; generalPresetId?: string; generalName?: string } };

function sampleValue(key: string) {
  const samples: Record<string, string> = {
    mode: 'original', title: '雾港来信', projectTitle: '雾港来信', premise: '一位年轻的信使在封港前收到一封寄给失踪船长的信。',
    instruction: '让信使在码头发现第一个线索，注意环境描写，暂时不要揭晓船长的去向。', maxWords: '1500',
    chapterTitle: '雨夜码头', chapterNumber: '2', chapterIndex: '2', chapterCount: '1', chapterId: 'sample-chapter',
    text: '雨水浸透了信使的斗篷。他把盖着蓝色火漆的信藏进怀里，沿着码头寻找失踪船长。',
    paragraphs: '1. 雨水浸透了信使的斗篷。\n2. 他把盖着蓝色火漆的信藏进怀里，沿着码头寻找失踪船长。',
    summaries: '第一章：信使收到船长失踪前寄出的信，决定赶往码头。', summary: '信使在雨夜来到码头寻找失踪船长。',
    context: '世界观：沿海港城，近代航海背景。\n角色：年轻信使林舟。\n已发生剧情：林舟收到神秘来信。',
    storyMaterials: '世界观：沿海港城，近代航海背景。\n角色：年轻信使林舟。\n已发生剧情：林舟收到神秘来信。',
    worldview: '沿海港城，近代航海背景。', locked: '林舟没有超自然能力。', outline: '第二章：在码头找到船长留下的物件。',
    entities: '[]', relations: '[]', foreshadows: '[]', schema: '{ "summary": "本章摘要", "entities": [], "relations": [], "foreshadows": [] }',
    endChapter: '5', blockText: '[1] 雨水浸透了林舟的斗篷。\n[2] 他把盖着蓝色火漆的信藏进怀里，沿着码头寻找失踪船长。',
    summaryText: '第一章：林舟收到船长失踪前寄出的信，决定赶往码头。\n第二章：林舟在雨夜码头找到船长遗失的怀表。',
    worldRules: '[]', mainCharacters: '[{"name":"林舟","description":"没有超自然能力的年轻信使"}]', mainCharacterRelations: '[]',
    unrevealedForeshadows: '[]', plotSummaries: '第一章：林舟收到船长失踪前寄出的信，决定赶往码头。',
    recentChapters: '林舟拿着神秘来信，在城门关闭之前赶到了雾港。', currentChapterPlan: '{"chapter":2,"title":"雨夜码头","goal":"在码头发现船长留下的怀表"}',
    writingTarget: '请写第 2 章，只写当前这一章。', sourceText: '雨水浸透了林舟的斗篷。他沿着码头寻找失踪船长。', originalReference: '',
  };
  return samples[key] ?? `示例${key}`;
}

function clonePreset(preset: PromptPreset, name: string): PromptPreset {
  return { ...preset, id: crypto.randomUUID(), name, blocks: preset.blocks.map(block => ({ ...block, id: crypto.randomUUID(), modes: block.modes && [...block.modes] })), variables: preset.variables && { ...preset.variables } };
}

function presetExport(task: PromptScope, preset: PromptPreset, templates: PromptTemplateSettings) {
  return {
    format: 'ai-novel-prompt-preset', version: 2, task, preset,
    ...(task !== 'general' && preset.useGeneral !== false ? { generalPreset: templates.general?.presets.find(value => value.id === preset.generalPresetId) ?? activePromptPreset(templates, 'general') } : {}),
  };
}

export function PromptTemplatesPanel({ settings, onChange, disabled = false, embedded = false }: { settings: Settings; onChange: (settings: Settings) => void; disabled?: boolean; embedded?: boolean }) {
  const [task, setTask] = useState<PromptScope>('writing');
  const [generalPreviewTask, setGeneralPreviewTask] = useState<PromptTask>('writing');
  const [actionError, setActionError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [naming, setNaming] = useState<Naming | null>(null);
  const [importText, setImportText] = useState('');
  const [expandedBlock, setExpandedBlock] = useState('');
  const [insertBlock, setInsertBlock] = useState('');
  const [draggedBlock, setDraggedBlock] = useState('');
  const [protocolOverride, setProtocolOverride] = useState<ProviderProtocol | ''>('');
  const [rpgSample, setRpgSample] = useState({ character: { kind: 'original' as 'original' | 'existing', name: '林舟', description: '没有超自然能力的年轻信使。' }, entryInstruction: '从雨夜码头进入故事。' });
  const [chapterAnswer, setChapterAnswer] = useState('');
  const [compiledPreview, setCompiledPreview] = useState<{ key: string; result?: PromptPreviewResult; error?: string }>();
  const [samples, setSamples] = useState<Record<PromptTask, Record<string, string>>>(() => Object.fromEntries(promptTasks.map(value => [value, Object.fromEntries(promptVariables[value].map(variable => [variable.key, value === 'extraction' && variable.key === 'context' ? '名称对照（仅用于统一称呼，不是新增事实的证据）：[{"kind":"character","name":"林舟","aliases":[]}]\n尚未揭晓的伏笔索引（不可据此推断答案）：[]' : sampleValue(variable.key)]))])) as Record<PromptTask, Record<string, string>>);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareas = useRef(new Map<string, HTMLTextAreaElement>());
  const currentSettings = useRef(settings);
  currentSettings.current = settings;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const templates = settings.promptTemplates || defaultPromptTemplates();
  const previewTask = task === 'general' ? generalPreviewTask : task;
  const presets = promptPresetList(templates, task);
  const preset = activePromptPreset(templates, task);
  const variables = promptPresetVariables(task, preset);
  const targetBlock = preset.blocks.find(block => block.id === insertBlock) || preset.blocks[0];
  let validationError = '';
  try { validatePromptTemplates(templates); } catch (error) { validationError = (error as Error).message; }
  let compileError = '';
  try { compilePrompt(templates, previewTask, samples[previewTask]); } catch (error) { compileError = (error as Error).message; }
  const providerId = previewTask === 'writing' ? settings.writingProviderId : previewTask === 'extraction' ? settings.extractionProviderId : settings.planningProviderId;
  const protocol = protocolOverride || settings.providers.find(provider => provider.id === providerId)?.protocol || 'openai-chat';
  const images = normalizeImageSettings(settings.imageSettings);
  const previewTemplates = task === 'general' ? { ...templates, presets: { ...templates.presets, [previewTask]: templates.presets[previewTask].map(value => value.id === templates.selected[previewTask] ? { ...value, useGeneral: true, generalPresetId: preset.id } : value) } } : templates;
  const previewInput: PromptPreviewInput = { task: previewTask, templates: previewTemplates, variables: samples[previewTask], protocol, runtime: {
    extractionOutputMode: normalizeTaskSettings(settings.taskSettings).extraction.outputMode,
    illustrations: { portrait: Boolean(images.providerId && images.model && images.autoPortrait), cg: Boolean(images.providerId && images.model && images.autoCG) },
    ...(previewTask === 'writing' && samples.writing.mode === 'rpg' ? { rpg: rpgSample, chapterAnswer } : {}),
  } };
  const previewKey = JSON.stringify(previewInput);
  const preview = compiledPreview?.key === previewKey ? compiledPreview.result : undefined;
  const previewError = compileError || (compiledPreview?.key === previewKey ? compiledPreview.error : '');
  useEffect(() => {
    if (compileError) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<PromptPreviewResult>('/settings/prompt-preview', { method: 'POST', body: previewKey, signal: controller.signal })
        .then(result => {
          if (!result || !Array.isArray(result.messages) || !Array.isArray(result.runtimeBlocks) || !Array.isArray(result.tools) || typeof result.body !== 'string') throw new Error('预览响应不完整，请刷新页面后重试。');
          JSON.parse(result.body);
          if (!controller.signal.aborted) setCompiledPreview({ key: previewKey, result });
        })
        .catch(error => { if (!controller.signal.aborted) setCompiledPreview({ key: previewKey, error: (error as Error).message }); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [previewKey, compileError]);

  function change(next: PromptTemplateSettings) { if (disabledRef.current) return; setActionError(''); setFeedback(''); onChange({ ...currentSettings.current, promptTemplates: next }); }
  function replaceScope(nextPresets: PromptPreset[], selected = preset.id) {
    change(task === 'general' ? { ...templates, general: { presets: nextPresets, selected } } : { ...templates, presets: { ...templates.presets, [task]: nextPresets }, selected: { ...templates.selected, [task]: selected } });
  }
  function updatePreset(patch: Partial<PromptPreset>) { replaceScope(presets.map(value => value.id === preset.id ? { ...value, ...patch } : value)); }
  function updateBlock(id: string, patch: Partial<PromptBlock>) {
    const target = { ...preset.blocks.find(block => block.id === id)!, ...patch };
    const group = target.feature?.startsWith('cot-') ? 'cot-' : target.feature?.startsWith('defense-') ? 'defense-' : undefined;
    updatePreset({ blocks: preset.blocks.map(block => block.id === id ? target : target.enabled && group && block.feature?.startsWith(group) ? { ...block, enabled: false } : block) });
  }
  function selectTask(value: PromptScope) { setTask(value); setActionError(''); setFeedback(''); setInsertBlock(''); setExpandedBlock(''); }
  function addPreset(copy = false) {
    setNaming({ kind: 'preset', operation: copy ? 'copy' : 'create', name: copy ? `${preset.name}（副本）`.slice(0, 100) : `新预设 ${presets.length + 1}` });
  }
  function submitName(event: FormEvent) {
    event.preventDefault(); event.stopPropagation(); if (!naming || disabledRef.current || !naming.name.trim() || naming.name.trim().length > 100) return;
    const name = naming.name.trim();
    if (naming.kind === 'import' && naming.imported) {
      const incoming = naming.imported; const next = structuredClone(incoming.templates);
      const list = promptPresetList(next, incoming.task); list.find(value => value.id === incoming.presetId)!.name = name;
      if (incoming.generalPresetId) {
        const generalName = incoming.generalName?.trim(); if (!generalName || generalName.length > 100) return;
        next.general!.presets.find(value => value.id === incoming.generalPresetId)!.name = generalName;
      }
      change(next); selectTask(incoming.task); setImportText(''); setFeedback(`已新增“${name}”。点击“保存设置”后生效。`);
    } else if (naming.kind === 'preset') {
      if (naming.operation === 'rename') updatePreset({ name });
      else {
        const next = clonePreset(naming.operation === 'copy' ? preset : activePromptPreset(defaultPromptTemplates(), task), name);
        replaceScope([...presets, next], next.id); setExpandedBlock(next.blocks[0]?.id || ''); setInsertBlock('');
      }
    } else if (naming.kind === 'block') {
      if (naming.operation === 'rename') updateBlock(naming.blockId!, { name });
      else {
        const source = preset.blocks.find(block => block.id === naming.blockId);
        const block: PromptBlock = source ? { ...source, id: crypto.randomUUID(), name, enabled: source.feature?.startsWith('cot-') || source.feature?.startsWith('defense-') ? false : source.enabled } : { id: crypto.randomUUID(), name, role: 'user', enabled: true, content: '' };
        const blocks = [...preset.blocks]; blocks.splice(source ? blocks.indexOf(source) + 1 : blocks.length, 0, block);
        updatePreset({ blocks }); setExpandedBlock(block.id); setInsertBlock(block.id);
      }
    }
    setNaming(null);
  }
  function moveBlock(id: string, target: number) {
    const index = preset.blocks.findIndex(block => block.id === id);
    if (index < 0 || target < 0 || target >= preset.blocks.length || index === target) return;
    const blocks = [...preset.blocks]; const [block] = blocks.splice(index, 1); blocks.splice(target, 0, block); updatePreset({ blocks }); setExpandedBlock(id);
  }
  function insertVariable(key: string) {
    if (!targetBlock || targetBlock.slot) return;
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
    const url = URL.createObjectURL(new Blob([JSON.stringify(presetExport(task, preset, templates), null, 2)], { type: 'application/json;charset=utf-8' }));
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
      if (payload.format !== 'ai-novel-prompt-preset' || ![1, 2].includes(payload.version as number) || !promptScopes.includes(payload.task as PromptScope)) throw new Error('预设格式、版本或任务类型不正确，请使用本项目导出的预设。');
      const importedTask = payload.task as PromptScope;
      if (!payload.preset || typeof payload.preset !== 'object' || Array.isArray(payload.preset)) throw new Error('文件缺少提示词预设。');
      const incoming = { ...payload.preset as PromptPreset, ...(payload.version === 1 ? { useGeneral: false } : {}) };
      const imported = clonePreset(incoming, incoming.name);
      const latestTemplates = currentSettings.current.promptTemplates || defaultPromptTemplates();
      let next = structuredClone(latestTemplates);
      next.general ??= defaultPromptTemplates().general;
      if (importedTask === 'general') next.general = { presets: [...next.general!.presets, imported], selected: imported.id };
      else {
        if (payload.generalPreset) {
          const general = clonePreset(payload.generalPreset as PromptPreset, (payload.generalPreset as PromptPreset).name);
          next.general!.presets.push(general); imported.generalPresetId = general.id;
        }
        next.presets[importedTask].push(imported); next.selected[importedTask] = imported.id;
      }
      validatePromptTemplates(next);
      setNaming({ kind: 'import', operation: 'import', name: imported.name, imported: { task: importedTask, templates: next, presetId: imported.id,
        ...(importedTask !== 'general' && payload.generalPreset ? { generalPresetId: imported.generalPresetId, generalName: next.general!.presets.find(value => value.id === imported.generalPresetId)!.name } : {}) } });
    } catch (error) { setActionError(`导入失败：${(error as Error).message}`); }
  }
  async function readFile(file?: File) {
    if (!file) return;
    try { if (file.size > 700000) throw new Error('预设文件过大，请缩减到 700000 字节以内。'); importPreset(await file.text()); }
    catch (error) { setActionError(`导入失败：${(error as Error).message}`); }
  }

  const body = <div className="prompt-templates-body form-stack">
      <p className="hint">通用预设提供共用框架，任务提示词在插槽处展开，程序再附加本次任务规则。通用层仅保留雪融雪降、CLEAR、输出结构与防空回尾段，角色和任务约束由各任务提示词提供。原有自定义预设保持独立，可自行接入。修改后点击“保存设置”生效。</p>
      <div className="prompt-task-tabs" role="tablist" aria-label="提示词任务">{promptScopes.map(value => <button type="button" key={value} role="tab" aria-selected={task === value} className={task === value ? 'active' : ''} disabled={disabled} onClick={() => selectTask(value)}>{promptScopeLabels[value]}</button>)}</div>
      <section className="prompt-preset-editor form-stack" aria-label={`${promptScopeLabels[task]}提示词预设`}>
        <div className="prompt-preset-heading"><label>当前预设<select aria-label="当前提示词预设" disabled={disabled} value={preset.id} onChange={event => { replaceScope(presets, event.target.value); setInsertBlock(''); setExpandedBlock(''); }}>{presets.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label><div className="row wrap"><button type="button" className="button secondary small" disabled={disabled} onClick={() => addPreset()}><Plus size={14} />新建预设</button><button type="button" className="button secondary small" disabled={disabled} onClick={() => addPreset(true)}><Copy size={14} />复制预设</button><button type="button" className="button secondary small" disabled={disabled} onClick={() => setNaming({ kind: 'preset', operation: 'rename', name: preset.name })}><Pencil size={14} />重命名预设</button><button type="button" className="icon-button danger-text" aria-label="删除当前提示词预设" title="删除当前预设（保留至少一个；被任务引用的通用预设须先解除引用）" disabled={disabled || presets.length <= 1 || task === 'general' && promptTasks.some(value => templates.presets[value].some(entry => entry.generalPresetId === preset.id))} onClick={() => { const remaining = presets.filter(value => value.id !== preset.id); replaceScope(remaining, remaining[0].id); }}><Trash2 size={15} /></button></div></div>
        <label>预设名称<input aria-label="提示词预设名称" maxLength={100} value={preset.name} disabled={disabled} onChange={event => updatePreset({ name: event.target.value })} /></label>
        {task === 'general' && <label>辅助标签处理<select aria-label="辅助标签处理" disabled={disabled} value={preset.textFilter ?? 'off'} onChange={event => updatePreset({ textFilter: event.target.value === 'dramatron' ? 'dramatron' : undefined })}><option value="dramatron">清理 Dramatron 思考、包装与尾段标签</option><option value="off">保留全部输出文本</option></select><span className="hint">清理后的内容进入正文或 JSON 解析；完整返回仍保留在作者侧响应诊断中。</span></label>}
        {task !== 'general' && <label>搭配通用预设<select aria-label="搭配通用预设" disabled={disabled} value={preset.useGeneral === false ? 'off' : preset.generalPresetId ?? 'follow'} onChange={event => updatePreset({ useGeneral: event.target.value !== 'off', generalPresetId: ['off', 'follow'].includes(event.target.value) ? undefined : event.target.value })}><option value="follow">跟随当前通用预设</option><option value="off">独立使用任务提示词</option>{promptPresetList(templates, 'general').map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>}
        {task === 'writing' && <label>正文输出通道<select aria-label="正文输出通道" disabled={disabled} value={preset.writingOutputMode ?? 'text'} onChange={event => updatePreset({ writingOutputMode: event.target.value as 'text' | 'tool' })}><option value="text">普通文本（默认）</option><option value="tool">工具通道 · 正文与工具调用分层提交</option></select><span className="hint">查询、插画与 RPG 询问通过内层工具执行，真实结果从外层返回。此模式跳过普通／牢大尾段；同一响应保留更完整的文本，不重发请求。空回或无效工具参数会保留响应并报错。</span></label>}
        <div className="row wrap between"><span className="hint">{preset.blocks.length} 个块 · {preset.blocks.filter(block => block.enabled).length} 个启用。拖动手柄或使用上下箭头调整顺序。</span><button type="button" className="text-button" disabled={disabled} onClick={() => { const defaults = activePromptPreset(defaultPromptTemplates(), task); const reset = clonePreset(defaults, preset.name); updatePreset({ blocks: reset.blocks, variables: reset.variables, useGeneral: reset.useGeneral, generalPresetId: reset.generalPresetId, writingOutputMode: reset.writingOutputMode, textFilter: reset.textFilter }); setFeedback('当前预设已恢复默认内容；保存后生效。'); }}><RotateCcw size={13} />恢复默认提示词</button></div>
        <div className="prompt-block-list">{preset.blocks.map((block, index) => <details key={`${preset.id}-${block.id}`} className={`prompt-block ${block.enabled ? '' : 'is-disabled'}`} data-testid="prompt-block" data-block-id={block.id} open={index === 0 || expandedBlock === block.id} onDragOver={event => { if (draggedBlock) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (draggedBlock && !disabled) moveBlock(draggedBlock, index); setDraggedBlock(''); }}>
          <summary><span className="prompt-block-handle" draggable={!disabled} title="拖动调整顺序" onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', block.id); setDraggedBlock(block.id); }} onDragEnd={() => setDraggedBlock('')}><GripVertical size={15} /></span><span className="prompt-block-number">{String(index + 1).padStart(2, '0')}</span><strong>{block.name || '未命名块'}</strong><span className="prompt-block-badge">{roleLabels[block.role]}</span>{!block.enabled && <span className="hint">已停用</span>}{task === 'writing' && !!block.modes?.length && <small>{block.modes.map(mode => modeLabels[mode]).join('、')}</small>}</summary>
          <div className="prompt-block-body form-stack">
            <div className="row wrap between"><label className="checkbox"><input type="checkbox" aria-label={`启用提示词块 ${index + 1}`} checked={block.enabled} disabled={disabled || !!block.slot} onChange={event => updateBlock(block.id, { enabled: event.target.checked })} />启用此块</label><div className="row"><button type="button" className="icon-button" aria-label={`上移提示词块 ${index + 1}`} title="上移" disabled={disabled || index === 0} onClick={() => moveBlock(block.id, index - 1)}><ArrowUp size={15} /></button><button type="button" className="icon-button" aria-label={`下移提示词块 ${index + 1}`} title="下移" disabled={disabled || index === preset.blocks.length - 1} onClick={() => moveBlock(block.id, index + 1)}><ArrowDown size={15} /></button><button type="button" className="icon-button" aria-label={`复制提示词块 ${index + 1}`} title="复制此块" disabled={disabled || !!block.slot} onClick={() => setNaming({ kind: 'block', operation: 'copy', blockId: block.id, name: `${block.name}（副本）`.slice(0, 100) })}><Copy size={15} /></button><button type="button" className="icon-button" aria-label={`重命名提示词块 ${index + 1}`} title="重命名此块" disabled={disabled} onClick={() => setNaming({ kind: 'block', operation: 'rename', blockId: block.id, name: block.name })}><Pencil size={15} /></button><button type="button" className="icon-button danger-text" aria-label={`删除提示词块 ${index + 1}`} title="删除此块" disabled={disabled || !!block.slot || preset.blocks.length <= 1} onClick={() => updatePreset({ blocks: preset.blocks.filter(value => value.id !== block.id) })}><Trash2 size={15} /></button></div></div>
            <div className="form-grid"><label>块名称<input aria-label={`提示词块 ${index + 1} 名称`} maxLength={100} value={block.name} disabled={disabled} onChange={event => updateBlock(block.id, { name: event.target.value })} /></label><label>消息角色<select aria-label={`提示词块 ${index + 1} 角色`} value={block.role} disabled={disabled} onChange={event => updateBlock(block.id, { role: event.target.value as PromptBlock['role'] })}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
            {task === 'writing' && <fieldset className="prompt-block-modes"><legend>适用写作模式</legend><label className="checkbox"><input type="checkbox" aria-label={`提示词块 ${index + 1} 所有写作模式`} checked={!block.modes?.length} disabled={disabled} onChange={event => updateBlock(block.id, { modes: event.target.checked ? undefined : ['original'] })} />所有写作模式</label>{modes.map(mode => <label className="checkbox" key={mode}><input type="checkbox" aria-label={`提示词块 ${index + 1} 适用于 ${modeLabels[mode]}`} checked={!block.modes?.length || block.modes.includes(mode)} disabled={disabled || !block.modes?.length} onChange={event => setBlockMode(block, mode, event.target.checked)} />{modeLabels[mode]}</label>)}</fieldset>}
            {!block.slot && <label>块用途<select aria-label={`提示词块 ${index + 1} 用途`} disabled={disabled} value={block.feature ?? 'normal'} onChange={event => updateBlock(block.id, { feature: event.target.value === 'normal' ? undefined : event.target.value as PromptFeature })}><option value="normal">普通提示词块</option>{Object.entries(featureLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
            {task === 'general' && !block.slot && <label>适用任务<select aria-label={`提示词块 ${index + 1} 适用任务`} disabled={disabled} value={block.tasks?.length === 1 ? block.tasks[0] : 'all'} onChange={event => updateBlock(block.id, { tasks: event.target.value === 'all' ? undefined : [event.target.value as PromptTask] })}><option value="all">全部任务</option>{promptTasks.map(value => <option key={value} value={value}>{promptTaskLabels[value]}</option>)}</select></label>}
            {block.feature === 'snow' && <p className="hint">原作者说明：请把附带示例换成自己的普通长文本，至少 7000 token；不要使用成人内容或广泛复用的片段。此块不展开变量，按原文发送并计入上下文长度，不会自动裁剪。</p>}
            {block.feature?.startsWith('cot-') && <p className="hint">三段与单段互斥；三段为原预设默认，单段为格式稳定的替代。默认仅用于正文写作。</p>}
            {block.feature?.startsWith('defense-') && <p className="hint">普通与牢大是互斥替代，原预设默认均关闭。工具通道、工具提交或原生 JSON Schema 模式会跳过这些尾段，最终预览显示实际生效内容。</p>}
            {block.slot ? <p className="hint">此处插入所选任务的全部消息块，保留各自角色与顺序。可移动插槽调整通用框架的前后位置。</p> : <label>提示词内容<textarea ref={element => { if (element) textareas.current.set(block.id, element); else textareas.current.delete(block.id); }} aria-label={`提示词块 ${index + 1} 内容`} rows={Math.min(14, Math.max(4, block.content.split('\n').length))} className="prompt-content-input" value={block.content} disabled={disabled} onFocus={() => setInsertBlock(block.id)} onChange={event => updateBlock(block.id, { content: event.target.value })} placeholder="输入任务要求，使用下方变量按钮插入本次任务的素材。" spellCheck={false} /></label>}
          </div>
        </details>)}</div>
        <button type="button" className="button secondary small align-start" disabled={disabled} onClick={() => setNaming({ kind: 'block', operation: 'create', name: `提示词块 ${preset.blocks.length + 1}` })}><Plus size={14} />添加提示词块</button>
        <details className="prompt-inner-fold"><summary>可用变量与自定义变量</summary><div className="form-stack">
          <p className="hint">变量只替换一次，素材中出现的 {'{{文字}}'} 会保留原样。先选择插入位置，再点击变量；使用过的变量名称需要在重命名后同步修改。</p>
          <label>变量插入位置<select aria-label="变量插入位置" disabled={disabled} value={targetBlock?.id || ''} onChange={event => setInsertBlock(event.target.value)}>{preset.blocks.map((block, index) => <option key={block.id} value={block.id}>{index + 1}. {block.name || '未命名块'}</option>)}</select></label>
          <div className="prompt-variable-list">{variables.map(variable => <button type="button" className="prompt-variable-button" key={variable.key} disabled={disabled || !targetBlock || !!targetBlock.slot} aria-label={`插入变量 ${variable.key}`} title={variable.label} onClick={() => insertVariable(variable.key)}><code>{`{{${variable.key}}}`}</code><span>{variable.label}</span></button>)}</div>
          <div className="row wrap between"><h4>自定义变量</h4><button type="button" className="text-button" disabled={disabled} onClick={addVariable}><Plus size={13} />添加自定义变量</button></div>
          <p className="hint">变量名使用英文字母、数字和下划线，以英文字母开头；不能覆盖内置变量。变量值可写风格规则或常用要求，属于当前预设。</p>
          {Object.entries(preset.variables || {}).map(([key, value], index) => <div className="prompt-custom-variable" key={index}><label>变量名<input aria-label={`自定义变量 ${index + 1} 名称`} value={key} disabled={disabled} onChange={event => renameVariable(index, event.target.value)} spellCheck={false} /></label><label>变量值<textarea aria-label={`自定义变量 ${index + 1} 值`} rows={2} value={value} disabled={disabled} onChange={event => updatePreset({ variables: { ...preset.variables, [key]: event.target.value } })} /></label><button type="button" className="icon-button danger-text" aria-label={`删除自定义变量 ${index + 1}`} disabled={disabled} onClick={() => updatePreset({ variables: Object.fromEntries(Object.entries(preset.variables || {}).filter(([name]) => name !== key)) })}><Trash2 size={15} /></button></div>)}
        </div></details>
        <details className="prompt-inner-fold" open><summary>最终发送预览 · 使用示例素材</summary><div className="form-stack">
          <p className="hint">按实际发送流程展开全部提示词，包括 JSON 格式要求、写作阶段和所选场景的附加规则，不调用模型。这里使用可编辑的示例素材；实际任务会换成对应作品资料。RPG 展示新章首轮，后续真实问答及工具返回可在每轮请求诊断中查看。</p>
          <div className="form-grid">{task === 'general' && <label>预览搭配的任务<select aria-label="预览搭配的任务" value={generalPreviewTask} onChange={event => setGeneralPreviewTask(event.target.value as PromptTask)}>{promptTasks.map(value => <option key={value} value={value}>{promptTaskLabels[value]}</option>)}</select></label>}<label>预览接口协议<select aria-label="预览接口协议" value={protocolOverride} onChange={event => setProtocolOverride(event.target.value as ProviderProtocol | '')}><option value="">跟随任务模型（{protocolLabels[settings.providers.find(provider => provider.id === providerId)?.protocol || 'openai-chat']}）</option>{Object.entries(protocolLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          {previewTask === 'writing' && samples.writing.mode === 'rpg' && <fieldset className="form-stack"><legend>RPG 示例资料</legend><label>角色来源<select aria-label="示例 RPG 角色来源" value={rpgSample.character.kind} onChange={event => setRpgSample(value => ({ ...value, character: { ...value.character, kind: event.target.value as 'original' | 'existing' } }))}><option value="original">原创角色</option><option value="existing">已有角色</option></select></label><label>角色姓名<input aria-label="示例 RPG 角色姓名" value={rpgSample.character.name} onChange={event => setRpgSample(value => ({ ...value, character: { ...value.character, name: event.target.value } }))} /></label><label>角色设定<textarea aria-label="示例 RPG 角色设定" value={rpgSample.character.description} onChange={event => setRpgSample(value => ({ ...value, character: { ...value.character, description: event.target.value } }))} /></label><label>入场要求<textarea aria-label="示例 RPG 入场要求" value={rpgSample.entryInstruction} onChange={event => setRpgSample(value => ({ ...value, entryInstruction: event.target.value }))} /></label><label>上一章已确认的行动（无则留空）<textarea aria-label="示例 RPG 章末行动" value={chapterAnswer} onChange={event => setChapterAnswer(event.target.value)} /></label></fieldset>}
          <details className="prompt-example-values"><summary>编辑示例变量</summary><div className="form-stack">{promptVariables[previewTask].map(variable => <label key={variable.key}>{variable.label} <code>{`{{${variable.key}}}`}</code>{variable.key === 'mode' ? <select aria-label={`示例变量 ${variable.key}`} value={samples[previewTask][variable.key]} onChange={event => setSamples(value => ({ ...value, [previewTask]: { ...value[previewTask], [variable.key]: event.target.value } }))}>{modes.map(mode => <option key={mode} value={mode}>{modeLabels[mode]}</option>)}</select> : <textarea aria-label={`示例变量 ${variable.key}`} rows={2} value={samples[previewTask][variable.key]} onChange={event => setSamples(value => ({ ...value, [previewTask]: { ...value[previewTask], [variable.key]: event.target.value } }))} />}</label>)}</div></details>
          {previewError ? <Notice error={previewError} /> : !preview ? <p className="hint" role="status">正在编排完整预览…</p> : <>
            <p className="hint">本次程序规则（已完整列入下方消息）：{preview.runtimeBlocks.map(block => block.name).join('、')}{previewTask === 'writing' && samples.writing.mode === 'rpg' ? '、本章累计字数提醒' : ''}。这些规则对应程序的任务边界，随任务条件变化。</p>
            <div className="prompt-preview-messages" aria-label="提示词编译预览">{preview.messages.map((message, index) => <section className="prompt-preview-message" key={index} data-role={message.role}><span>{index + 1}. {roleLabels[message.role]}</span><pre>{message.content}</pre></section>)}</div>
            <details className="prompt-example-values"><summary>发送的工具定义（{preview.tools.length}）</summary><div className="prompt-preview-messages" aria-label="提示词工具定义">{preview.tools.length ? preview.tools.map(tool => <section className="prompt-preview-message" key={tool.name}><span>{tool.name}</span><pre>{tool.description}</pre><pre>{JSON.stringify(tool.parameters, null, 2)}</pre></section>) : <p className="hint">本任务不发送工具。</p>}</div></details>
            <details className="prompt-example-values"><summary>完整请求结构 · 示例模型与参数</summary><pre className="prompt-request-body" aria-label="完整提示词请求">{JSON.stringify(JSON.parse(preview.body), null, 2)}</pre></details>
          </>}
          <p className="hint">Chat / Responses 按消息顺序展示；Claude / Gemini 将系统块合并到系统区。提取和压缩继续校验输出结构与证据。预览使用示例模型及参数，实际模型、生成参数与素材以当次请求诊断为准。</p>
        </div></details>
        <details className="prompt-inner-fold"><summary>导入与导出预设 JSON</summary><div className="form-stack">
          <p className="hint">导出当前预设及其搭配的通用预设，不带供应商连接和 API 密钥。导入只新增预设，任务引用导入的通用副本，不改变其他任务的选择。兼容旧版任务预设。</p>
          <div className="row wrap"><button type="button" className="button secondary small" disabled={disabled || !!validationError} onClick={exportPreset}><Download size={14} />导出当前提示词预设</button><button type="button" className="button secondary small" disabled={disabled} onClick={() => fileInput.current?.click()}><Upload size={14} />选择预设 JSON 文件</button><input type="file" className="visually-hidden" ref={fileInput} accept=".json,application/json" aria-label="导入提示词预设文件" disabled={disabled} onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ''; }} /></div>
          <label>或粘贴预设 JSON<textarea aria-label="导入提示词预设 JSON" className="prompt-content-input" rows={5} value={importText} disabled={disabled} onChange={event => setImportText(event.target.value)} spellCheck={false} /></label><button type="button" className="button secondary small align-start" disabled={disabled || !importText.trim()} onClick={() => importPreset(importText)}>从 JSON 新增预设</button>
        </div></details>
      </section>
      {validationError && <Notice error={`提示词暂不能保存：${validationError}`} />}{actionError && <Notice error={actionError} />}{feedback && <p className="hint" role="status">{feedback}</p>}
    </div>;
  return <>{embedded ? <section className="prompt-templates prompt-templates-embedded" data-testid="prompt-templates-panel">{body}</section> : <details className="prompt-templates" data-testid="prompt-templates-panel"><summary>任务提示词与编排 <span>三类任务 · 分块编辑 · 预设</span></summary>{body}</details>}
    {naming && createPortal(<Modal title={`${({ create: '新建', copy: '复制', rename: '重命名', import: '导入' } as const)[naming.operation]}${naming.kind === 'block' ? '提示词块' : '预设'}`} onClose={() => setNaming(null)}><form className="form-stack" onSubmit={submitName}>
      <label>{naming.kind === 'block' ? '提示词名称' : '预设名称'}<input aria-label={naming.kind === 'block' ? '提示词名称' : '预设名称'} autoFocus required maxLength={100} value={naming.name} onChange={event => setNaming(value => value && ({ ...value, name: event.target.value }))} /></label>
      {naming.imported?.generalPresetId && <label>搭配的通用预设名称<input aria-label="搭配的通用预设名称" required maxLength={100} value={naming.imported.generalName || ''} onChange={event => setNaming(value => value?.imported ? { ...value, imported: { ...value.imported, generalName: event.target.value } } : value)} /></label>}
      <p className="hint">名称之后可以继续修改。确认后加入当前编辑，点击“保存设置”生效。</p>
      <div className="row end wrap"><button type="button" className="button secondary" onClick={() => setNaming(null)}>取消</button><button type="submit" className="button primary" disabled={disabled || !naming.name.trim() || !!naming.imported?.generalPresetId && !naming.imported.generalName?.trim()}>确认名称</button></div>
    </form></Modal>, document.body)}
  </>;
}
