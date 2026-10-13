import { useEffect, useRef, useState } from 'react';
import { Plus, Sparkles, Search, Save, Trash2 } from 'lucide-react';
import type { Source } from '../shared/types';
import { builtInChapterRules, DEFAULT_WORDS_PER_CHAPTER, MAX_WORDS_PER_CHAPTER, MIN_WORDS_PER_CHAPTER, type ChapterRule, type ChapterRuleInput, type ChapterRulePreview, type GeneratedChapterRule, type HeadingCandidate, type HeadingCandidates } from '../shared/chapter-rules';
import { api } from './api';
import { Notice } from './ui';
import { RequestDiagnostics } from './RequestDiagnostics';

const ruleInput = (rule: ChapterRuleInput): ChapterRuleInput => rule.type === 'length'
  ? { type: 'length', name: rule.name, wordsPerChapter: rule.wordsPerChapter, description: rule.description }
  : { type: rule.type, name: rule.name, pattern: rule.pattern, flags: rule.flags, description: rule.description };
const validWords = (value: number) => Number.isInteger(value) && value >= MIN_WORDS_PER_CHAPTER && value <= MAX_WORDS_PER_CHAPTER;

export function ImportRulesPanel({ source, busy, onBusy, onApply }: { source: Source; busy: boolean; onBusy: (value: boolean) => void; onApply: (value: ChapterRulePreview) => void }) {
  const [rules, setRules] = useState<ChapterRule[]>([...builtInChapterRules]);
  const [selectedId, setSelectedId] = useState(source.format === 'epub' ? 'native' : 'auto');
  const [wordsPerChapter, setWordsPerChapter] = useState(DEFAULT_WORDS_PER_CHAPTER);
  const [editor, setEditor] = useState<ChapterRuleInput | null>(null); const [editingId, setEditingId] = useState('');
  const [error, setError] = useState(''); const [note, setNote] = useState('');
  const [query, setQuery] = useState(''); const [searchedQuery, setSearchedQuery] = useState('');
  const [candidates, setCandidates] = useState<HeadingCandidates | null>(null); const [offsets, setOffsets] = useState([0]);
  const [samples, setSamples] = useState<HeadingCandidate[]>([]); const [instruction, setInstruction] = useState('');
  const [generated, setGenerated] = useState<GeneratedChapterRule | null>(null);
  const alive = useRef(true); const request = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true; const controller = new AbortController();
    void api<{ rules: ChapterRule[] }>('/chapter-rules?view=author', { signal: controller.signal }).then(value => { if (alive.current) setRules(value.rules); }).catch(e => { if (!controller.signal.aborted) setError((e as Error).message); });
    return () => { alive.current = false; controller.abort(); request.current?.abort(); };
  }, []);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController(); request.current = controller;
    onBusy(true); setError(''); setNote('');
    try { await action(controller.signal); }
    catch (e) { if (alive.current && !controller.signal.aborted) setError((e as Error).message); }
    finally { if (alive.current) onBusy(false); request.current = null; }
  }
  async function send<T>(path: string, body: unknown, signal: AbortSignal, method = 'POST') {
    return api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal });
  }
  function edit(copy = false) {
    const rule = rules.find(value => value.id === selectedId) ?? builtInChapterRules[1];
    setEditor(ruleInput({ ...rule, ...(rule.type === 'length' ? { wordsPerChapter } : {}), name: copy || rule.builtIn ? `${rule.name}（自定义）` : rule.name }));
    setEditingId(copy || rule.builtIn ? '' : rule.id); setError('');
  }
  async function apply(rule?: ChapterRuleInput) {
    await run(async signal => {
      const selected = rules.find(value => value.id === selectedId);
      const previewRule = rule ?? (selected?.type === 'length' ? ruleInput({ ...selected, wordsPerChapter }) : undefined);
      const value = await send<ChapterRulePreview>(`/sources/${source.id}/split?view=author`, previewRule ? { rule: previewRule } : selectedId === 'native' ? { native: true } : { ruleId: selectedId }, signal);
      if (!alive.current) return; onApply(value);
      setNote(value.wordsPerChapter !== undefined ? `已按每章 ${value.wordsPerChapter} 字分成 ${value.chapters.length} 章。请核对目录和正文，章节名称可自行修改。` : value.headingCount === undefined ? `已恢复原始分章，共 ${value.chapters.length} 章。` : value.headingCount === 0 ? '没有匹配到标题，全文保留为一章。可换规则、按字数分章，或勾选标题让 AI 生成规则。' : `匹配 ${value.headingCount} 个标题，分成 ${value.chapters.length} 章。请核对目录和正文。`);
    });
  }
  async function save(copy = false) {
    if (!editor) return;
    await run(async signal => {
      const id = copy ? '' : editingId;
      const value = await send<ChapterRule>(id ? `/chapter-rules/${id}?view=author` : '/chapter-rules?view=author', editor, signal, id ? 'PUT' : 'POST');
      const library = await api<{ rules: ChapterRule[] }>('/chapter-rules?view=author', { signal });
      if (!alive.current) return; setRules(library.rules); setSelectedId(value.id); setEditingId(value.id); setEditor(ruleInput(value)); setNote('规则已保存，可在以后导入时选择；点击预览后才会改变当前分章。');
      if (value.type === 'length') setWordsPerChapter(value.wordsPerChapter);
    });
  }
  async function remove() {
    const rule = rules.find(value => value.id === selectedId);
    if (!rule || rule.builtIn) return;
    await run(async signal => {
      await send(`/chapter-rules/${rule.id}?view=author`, undefined, signal, 'DELETE');
      setRules(value => value.filter(item => item.id !== rule.id)); setSelectedId('auto'); setEditor(null); setEditingId(''); setNote('自定义规则已删除，当前分章结果保留。');
    });
  }
  async function loadCandidates(offset = 0, pages = [0], search = query) {
    await run(async signal => {
      const value = await api<HeadingCandidates>(`/sources/${source.id}/heading-candidates?view=author&offset=${offset}&q=${encodeURIComponent(search)}`, { signal });
      if (!alive.current) return; setCandidates(value); setOffsets(pages); setSearchedQuery(search);
    });
  }
  function toggleSample(value: HeadingCandidate) {
    if (samples.some(sample => sample.line === value.line)) setSamples(samples.filter(sample => sample.line !== value.line));
    else if (samples.length >= 20) setError('最多选择 20 个标题样本。');
    else setSamples([...samples, value]);
  }
  async function generate() {
    await run(async signal => {
      const result = await send<GeneratedChapterRule>(`/sources/${source.id}/generate-rule?view=author`, { lines: samples.map(value => value.line), instruction }, signal);
      if (!alive.current) return; setGenerated(result);
      if (!result.ok || !result.rule) { setError(result.error || 'AI 未返回有效规则，请调整样本后重试。'); return; }
      setEditor(result.rule); setEditingId('');
      setNote(`AI 已生成候选规则，匹配 ${result.headingCount} 个标题，预计分成 ${result.chapterCount} 章。可编辑、预览并保存。`);
    });
  }
  const selected = rules.find(value => value.id === selectedId);
  const validEditor = editor && editor.name.trim() && (editor.type === 'length' ? validWords(editor.wordsPerChapter) : editor.pattern.trim());
  return <section className="import-rules" aria-label="分章规则" data-testid="import-rules">
    <div className="import-rule-toolbar">
      <label>分章规则<select value={selectedId} disabled={busy} onChange={e => { setSelectedId(e.target.value); const rule = rules.find(value => value.id === e.target.value); if (rule?.type === 'length') setWordsPerChapter(rule.wordsPerChapter); setEditor(null); setEditingId(''); setNote(''); }}>
        {source.format === 'epub' && <option value="native">EPUB 原有阅读顺序（默认）</option>}
        <optgroup label="内置规则">{rules.filter(rule => rule.builtIn).map(rule => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</optgroup>
        {rules.some(rule => !rule.builtIn) && <optgroup label="我的规则">{rules.filter(rule => !rule.builtIn).map(rule => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</optgroup>}
      </select></label>
      {selected?.type === 'length' && <label>每章字数<input type="number" min={MIN_WORDS_PER_CHAPTER} max={MAX_WORDS_PER_CHAPTER} step={100} disabled={busy} value={wordsPerChapter || ''} onChange={e => setWordsPerChapter(Number(e.target.value))} /></label>}
      <button className="button secondary small" disabled={busy || selected?.type === 'length' && !validWords(wordsPerChapter)} onClick={() => void apply()}>按所选规则重新分章</button>
      <button className="text-button" disabled={busy} onClick={() => edit(true)}><Plus size={14} />添加规则</button>
      {selected && !selected.builtIn && <><button className="text-button" disabled={busy} onClick={() => edit()}>编辑规则</button><button className="text-button danger" disabled={busy} onClick={() => void remove()}><Trash2 size={14} />删除规则</button></>}
    </div>
    <p className="hint">{selectedId === 'native' ? '按 EPUB 自带的正文顺序分章；也可选择其他规则重新分章。' : selected?.description} 重新分章使用原文件，当前手动调整可撤销恢复。</p>
    {selected?.type === 'length' && <p className="hint">每章字数为 {MIN_WORDS_PER_CHAPTER}～{MAX_WORDS_PER_CHAPTER.toLocaleString('zh-CN')} 的整数。空格和换行不计字数，标点计入；优先在目标字数的 80%～100% 范围内找段落末尾，没有合适换行时按字数切开，末章可较短。</p>}
    {error && <Notice error={error} onClose={() => setError('')} />}{note && <p className="import-rule-note" role="status">{note}</p>}
    {editor && <div className="import-rule-editor form-stack" aria-label="自定义分章规则">
      <div className="row between wrap"><strong>{editingId ? '编辑我的规则' : '新规则'}</strong><button className="text-button" disabled={busy} onClick={() => setEditor(null)}>收起编辑</button></div>
      <label>规则名称<input maxLength={80} disabled={busy} value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} /></label>
      <label>分章方式<select aria-label="分章方式" disabled={busy} value={editor.type === 'length' ? 'length' : 'regex'} onChange={e => setEditor(e.target.value === 'length' ? { type: 'length', name: editor.name, description: editor.description, wordsPerChapter } : { name: editor.name, description: editor.description, pattern: '第[0-9]+章.*', flags: 'i' })}><option value="regex">按章节标题</option><option value="length">按字数分章</option></select></label>
      {editor.type === 'length' ? <><label>每章目标字数<input type="number" min={MIN_WORDS_PER_CHAPTER} max={MAX_WORDS_PER_CHAPTER} step={100} disabled={busy} value={editor.wordsPerChapter || ''} onChange={e => setEditor({ ...editor, wordsPerChapter: Number(e.target.value) })} /></label><p className="hint">按正文去除空白后的字符数拆分，优先在接近目标的段落末尾切开；无换行的长段落按字数切开。保存后可在其他小说导入时复用。</p></> : <>
        <label>标题匹配表达式<textarea aria-label="标题匹配表达式" className="import-rule-pattern" rows={3} maxLength={1000} disabled={busy} value={editor.pattern} onChange={e => setEditor({ ...editor, pattern: e.target.value })} spellCheck={false} /></label>
        <p className="hint">表达式匹配整行标题，不用写 / 分隔符。例如「第[0-9]+章.*」匹配第1章、第2章等；「【.+】」匹配括号标题。每行最多 160 字符。</p>
        <label>匹配方式<select disabled={busy} value={editor.flags} onChange={e => setEditor({ ...editor, flags: e.target.value })}><option value="i">不区分大小写</option><option value="">区分大小写</option><option value="iu">Unicode · 不区分大小写</option><option value="u">Unicode · 区分大小写</option></select></label>
      </>}
      <label>规则说明<input maxLength={500} disabled={busy} value={editor.description} onChange={e => setEditor({ ...editor, description: e.target.value })} /></label>
      <div className="row wrap"><button className="button secondary small" disabled={busy || !validEditor} onClick={() => void apply(editor)}>预览这条规则</button><button className="button primary small" disabled={busy || !validEditor} onClick={() => void save()}><Save size={14} />{editingId ? '保存修改' : '保存新规则'}</button>{editingId && <button className="text-button" disabled={busy || !validEditor} onClick={() => void save(true)}>另存为新规则</button>}</div>
    </div>}
    <details className="import-ai-rules" onToggle={e => { if (e.currentTarget.open && !candidates && !busy) void loadCandidates(); }}>
      <summary><Sparkles size={15} />选中章节名，让 AI 生成规则</summary>
      <div className="form-stack">
        <p className="hint">从原文勾选 2～20 个不同的章节名，建议覆盖不同编号和标题格式。短正文也会列出，请只选择标题。仅将选中的标题及补充要求发送给 AI。使用已保存的资料提取模型，未配置时依次使用写作、摘要压缩模型；会产生模型用量。</p>
        <div className="row wrap import-candidate-search"><label className="visually-hidden" htmlFor={`heading-query-${source.id}`}>查找原文标题</label><input id={`heading-query-${source.id}`} placeholder="输入标题关键词，如 Chapter、【、第" disabled={busy} maxLength={160} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void loadCandidates(); } }} /><button className="button secondary small" disabled={busy} onClick={() => void loadCandidates()}><Search size={14} />查找标题</button></div>
        <div className="import-heading-candidates" aria-label="原文标题候选">
          {candidates?.candidates.map(value => <label key={value.line} className="import-heading-option"><input type="checkbox" disabled={busy} aria-label={`勾选章节名：${value.title}（第 ${value.line} 行）`} checked={samples.some(sample => sample.line === value.line)} onChange={() => toggleSample(value)} /><small>{value.line}</small><span>{value.title}</span></label>)}
          {candidates?.candidates.length === 0 && <p className="hint">没有找到符合条件的短行，可换关键词或清空后查找。</p>}
        </div>
        <div className="row between wrap"><span className="hint">原文行号 · 第 {offsets.length} 页</span><div className="row"><button className="text-button" disabled={busy || offsets.length === 1} onClick={() => void loadCandidates(offsets[offsets.length - 2], offsets.slice(0, -1), searchedQuery)}>上一页</button><button className="text-button" disabled={busy || candidates?.nextOffset == null} onClick={() => { const next = candidates?.nextOffset; if (next != null) void loadCandidates(next, [...offsets, next], searchedQuery); }}>下一页</button></div></div>
        <div className="import-heading-selection" aria-label="已选标题样本"><div className="row between"><strong>已选 {samples.length} 个章节名</strong><button className="text-button" disabled={busy || !samples.length} onClick={() => setSamples([])}>清空选择</button></div>{samples.map(sample => <button className="import-sample-chip" key={sample.line} disabled={busy} aria-label={`移除样本：${sample.title}`} onClick={() => toggleSample(sample)}>{sample.title}<span aria-hidden="true">×</span></button>)}</div>
        <label>给 AI 的补充要求（可选）<input disabled={busy} maxLength={1000} placeholder="例如：只按章分，不把卷名作为一章" value={instruction} onChange={e => setInstruction(e.target.value)} /></label>
        <div className="row wrap"><button className="button secondary small" disabled={busy || samples.length < 2} onClick={() => void generate()}><Sparkles size={14} />生成新规则</button><span className="hint">结果先作为候选，不会自动保存或确认导入。</span></div>
        {generated?.examples && <p className="hint">候选规则匹配示例：{generated.examples.join(' ／ ')}</p>}
        {generated?.capture && <RequestDiagnostics capture={generated.capture} filename="chapter-rule-generation" showResponse />}
      </div>
    </details>
  </section>;
}
