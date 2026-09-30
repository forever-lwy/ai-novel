import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, CheckCircle2, ClipboardPaste, Copy, Download, EyeOff, FileCode2, RefreshCw, Save, ListChecks, Code2, ArrowRight, BookOpen } from 'lucide-react';
import type { Job, ModelOutputDetail, ModelOutputRecord, ModelOutputSummary, OutputStage } from '../shared/types';
import { api, ApiError, countText, dateText, jobNames, post } from './api';
import { Empty, Modal, Notice, Spinner } from './ui';
import { VisualOutputEditor } from './VisualOutputEditor';
import { humanIssuePath, parseVisualOutput, unwrapVisualText } from './output-form';
import { RequestDiagnostics } from './RequestDiagnostics';

const stageNames: Record<OutputStage, string> = { planning: '大纲规划', writing: '正文生成', extraction: '资料提取' };
const outputStatusNames: Record<ModelOutputRecord['status'], string> = { received: '已收到', invalid: '校验未通过', applied: '已应用' };

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function summaryOf(output: ModelOutputRecord): ModelOutputSummary {
  const { rawResponse: _raw, text: _text, editedText: _edited, normalizedText: _normalized, adjustments: _adjustments, issues: _issues, request: _request, diagnostics: _diagnostics, ...summary } = output;
  return summary;
}

export function ModelOutputsPanel({ job, branchName, onClose, onApplied, onDirtyChange }: {
  job: Job;
  branchName: string;
  onClose: () => void;
  onApplied: (job: Job) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [outputs, setOutputs] = useState<ModelOutputSummary[]>([]);
  const [detail, setDetail] = useState<ModelOutputDetail | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState('');
  const [savedDraft, setSavedDraft] = useState('');
  const [pasteMode, setPasteMode] = useState(false);
  const [pastedText, setPastedText] = useState('');
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editorMode, setEditorMode] = useState<'form' | 'json'>('form');
  const [focusRequest, setFocusRequest] = useState<{ path: string; nonce: number } | null>(null);
  const [focusHelp, setFocusHelp] = useState('');
  const mounted = useRef(false);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const selection = useRef('');
  const editor = useRef({ draft: '', savedDraft: '', pasteMode: false, pastedText: '' });
  const mutationInFlight = useRef(false);
  editor.current = { draft, savedDraft, pasteMode, pastedText };
  const dirty = draft !== savedDraft || pastedText.length > 0;
  const canImport = ['failed', 'paused'].includes(job.status);
  const ownerPath = `/jobs/${job.id}/outputs`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++listSequence.current; ++detailSequence.current; };
  }, []);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty || busy) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty, busy]);

  const loadDetail = useCallback(async (outputId: string, preserveDraft = false) => {
    const sequence = ++detailSequence.current;
    setLoadingDetail(true);
    try {
      const value = await api<ModelOutputDetail>(`${ownerPath}/${outputId}?view=author`);
      if (!mounted.current || sequence !== detailSequence.current || selection.current !== outputId) return;
      setDetail(value);
      const text = value.output.editedText ?? value.output.normalizedText ?? value.output.text;
      const hasDraft = editor.current.draft !== editor.current.savedDraft;
      if (!preserveDraft || !hasDraft) { setDraft(text); setSavedDraft(text); }
      else if (text === editor.current.draft) setSavedDraft(text);
      return value;
    } catch (e) {
      if (mounted.current && sequence === detailSequence.current) setError((e as Error).message);
    } finally {
      if (mounted.current && sequence === detailSequence.current) setLoadingDetail(false);
    }
  }, [ownerPath]);

  const loadList = useCallback(async () => {
    const sequence = ++listSequence.current;
    try {
      const values = await api<ModelOutputSummary[]>(`${ownerPath}?view=author`);
      if (!mounted.current || sequence !== listSequence.current) return;
      const sorted = [...values].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setOutputs(sorted);
      if (!selection.current && !editor.current.pasteMode && sorted.length) {
        const first = sorted[0].id;
        selection.current = first; setSelectedId(first);
        await loadDetail(first);
      }
    } catch (e) {
      if (mounted.current && sequence === listSequence.current) setError((e as Error).message);
    } finally {
      if (mounted.current && sequence === listSequence.current) setLoadingList(false);
    }
  }, [ownerPath, loadDetail]);

  useEffect(() => {
    if (mutationInFlight.current) return;
    void loadList();
    if (selection.current) void loadDetail(selection.current, true);
  }, [job.updatedAt, loadList, loadDetail]);

  function confirmDiscard() {
    return !dirty || window.confirm('有尚未保存的模型输出修改。确定放弃这些修改吗？可先下载当前草稿。');
  }
  function close() { if (!busy && confirmDiscard()) onClose(); }
  async function chooseOutput(outputId: string) {
    if (busy || (selectedId === outputId && !pasteMode) || !confirmDiscard()) return;
    ++detailSequence.current;
    selection.current = outputId; setSelectedId(outputId);
    setPasteMode(false); setPastedText(''); setDetail(null);
    setDraft(''); setSavedDraft(''); setError(''); setMessage(''); setEditorMode('form'); setFocusRequest(null); setFocusHelp('');
    await loadDetail(outputId);
  }
  function startPaste() {
    if (busy || !canImport || !confirmDiscard()) return;
    ++detailSequence.current;
    selection.current = ''; setSelectedId(''); setDetail(null); setLoadingDetail(false);
    editor.current.pasteMode = true;
    setPasteMode(true); setDraft(''); setSavedDraft(''); setError(''); setMessage('');
  }
  async function copy(text: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持直接复制。请使用下载按钮，或选中文本后手动复制。');
      await navigator.clipboard.writeText(text);
      if (mounted.current) setMessage('已复制到剪贴板。');
    } catch (e) { if (mounted.current) setError((e as Error).message); }
  }
  async function refresh() {
    setError('');
    await loadList();
    if (selection.current) await loadDetail(selection.current, true);
  }
  async function importResponse(event: FormEvent) {
    event.preventDefault();
    if (!pastedText.trim() || busy || !canImport) return;
    setBusy(true); mutationInFlight.current = true; setError(''); setMessage('');
    try {
      const output = await post<ModelOutputRecord>(`${ownerPath}?view=author`, { text: pastedText });
      if (!mounted.current) return;
      setOutputs(value => [summaryOf(output), ...value.filter(item => item.id !== output.id)]);
      setPastedText(''); setPasteMode(false); setEditorMode('form'); setFocusRequest(null); setFocusHelp('');
      selection.current = output.id; setSelectedId(output.id);
      setDraft(output.editedText ?? output.normalizedText ?? output.text); setSavedDraft(output.editedText ?? output.normalizedText ?? output.text);
      await loadDetail(output.id);
      if (mounted.current) setMessage('历史响应已保存，尚未应用。核对文本后，可在本地重新校验。此操作没有调用模型。');
    } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { mutationInFlight.current = false; if (mounted.current) setBusy(false); }
  }
  async function apply() {
    if (!detail || !detail.canApply || busy || loadingDetail) return;
    const outputId = detail.output.id;
    const text = draft;
    const baseRevisionId = detail.output.baseRevisionId;
    setBusy(true); mutationInFlight.current = true; setError(''); setMessage('');
    try {
      const updatedJob = await post<Job>(`${ownerPath}/${outputId}/apply?view=author`, { text, baseRevisionId });
      if (!mounted.current || selection.current !== outputId) return;
      setSavedDraft(text);
      await loadDetail(outputId, true);
      await loadList();
      if (!mounted.current) return;
      onApplied(updatedJob);
      setMessage(updatedJob.status === 'completed'
        ? '本地校验通过，已应用修正，任务已完成。没有重新调用模型。'
        : '本地校验通过，已应用修正，任务保持暂停。没有重新调用模型；需要后续处理时，请关闭窗口并点击任务的“继续”。');
    } catch (e) {
      if (!mounted.current || selection.current !== outputId) return;
      if (e instanceof ApiError && e.status === 422) {
        setError('本地校验未通过。提交的修正已留存，请按下方具体问题继续修改；没有重新调用模型。');
        await loadDetail(outputId, true);
        await loadList();
      } else if (e instanceof ApiError && e.status === 409) {
        setError(`${e.message} 当前草稿仍在，可先下载保存。请核对任务和故事线的最新状态，刷新不会覆盖草稿。`);
        await loadDetail(outputId, true);
      } else setError((e as Error).message);
    } finally { mutationInFlight.current = false; if (mounted.current) setBusy(false); }
  }

  const output = detail?.output;
  const parsed = useMemo(() => output && output.stage !== 'writing' ? parseVisualOutput(draft, output.stage) : null, [draft, output?.stage]);
  const prose = useMemo(() => { if (output?.stage !== 'writing') return draft; try { return unwrapVisualText(draft).text; } catch { return draft; } }, [draft, output?.stage]);
  function showJson(help = '') {
    setEditorMode('json'); setFocusHelp(help); setFocusRequest(null);
    requestAnimationFrame(() => { const field = document.getElementById('model-output-draft'); field?.scrollIntoView({ block: 'center' }); field?.focus({ preventScroll: true }); });
  }
  function locateIssue(path: string) {
    if (output?.stage === 'writing' || !parsed?.ok) { showJson('请在下方检查这条问题；当前内容尚不能定位到可视化字段。'); return; }
    setEditorMode('form'); setFocusHelp(''); setFocusRequest({ path, nonce: Date.now() });
  }

  return <Modal title="模型输出 / 手工修正" wide onClose={close}>
    <div className="output-panel">
      <div className="output-intro">
        <div><span className="eyebrow">MODEL RESPONSE ARCHIVE</span><p><strong>{jobNames[job.kind]}</strong> · {branchName} · {dateText(job.createdAt)}</p></div>
        <span className="output-private"><EyeOff size={13} />仅作者可见</span>
      </div>
      <p className="hint">原始响应和最初文本会分别保留。手工修正只在本地保存、校验并应用，不会重新调用模型。</p>
      {error && <Notice error={error} onClose={() => setError('')} />}
      {message && <div className="notice success" role="status"><CheckCircle2 size={16} /><span>{message}</span></div>}
      <div className="output-toolbar row between wrap">
        <button className="button secondary small" disabled={busy || !canImport} title={canImport ? '保存历史响应，不调用模型' : '任务暂停或失败后，可以粘贴历史响应'} onClick={startPaste}><ClipboardPaste size={15} />粘贴历史响应</button>
        <button className="text-button" disabled={busy || loadingList} onClick={() => void refresh()}><RefreshCw size={14} />刷新输出记录</button>
      </div>
      <div className="output-layout">
        <nav className="output-history" aria-label="模型输出记录">
          <h3>响应记录 <span>{outputs.length}</span></h3>
          {loadingList ? <Spinner text="读取记录…" /> : outputs.length ? outputs.map(item => <button
            key={item.id}
            className={`output-history-item ${selectedId === item.id && !pasteMode ? 'selected' : ''}`}
            disabled={busy}
            onClick={() => void chooseOutput(item.id)}
          >
            <span className="row between"><strong>{stageNames[item.stage]}</strong><span className={`status-pill ${item.status === 'invalid' ? 'failed' : item.status === 'applied' ? 'completed' : ''}`}>{outputStatusNames[item.status]}</span></span>
            <span className="output-history-meta">{dateText(item.createdAt)}{item.blockIndex !== undefined ? ` · 片段 ${item.blockIndex + 1}` : ''}</span>
            {item.incomplete && <span className="output-incomplete">响应可能不完整</span>}
          </button>) : <p className="hint">尚无已保存的输出。旧任务可粘贴历史响应；新任务收到模型结果后会自动留存。</p>}
        </nav>
        <div className="output-workbench">
          {pasteMode ? <form className="form-stack" onSubmit={importResponse}>
            <div><h3>保存历史模型响应</h3><p className="hint">可粘贴服务商返回的完整响应、JSON，或模型输出文本。先保存一份记录，再核对和修正，不会立即改动故事资料。</p></div>
            <label htmlFor="historical-output">历史响应或输出文本</label>
            <textarea id="historical-output" className="output-code-editor" spellCheck={false} rows={17} value={pastedText} onChange={event => setPastedText(event.target.value)} placeholder="在这里粘贴需要保留的历史响应或输出文本。" disabled={busy} />
            {!canImport && <div className="notice">任务状态已变化。只能为已暂停或失败的任务导入响应；粘贴的草稿仍保留，可以先下载。</div>}
            <div className="row wrap between"><button className="text-button" type="button" disabled={!pastedText} onClick={() => downloadText(pastedText, `model-output-${job.id}-pasted-draft.txt`)}><Download size={14} />下载粘贴草稿</button><button className="button primary" type="submit" disabled={busy || !canImport || !pastedText.trim()}><Save size={15} />{busy ? '正在保存…' : '保存为输出记录'}</button></div>
          </form> : loadingDetail && !detail ? <Spinner text="正在读取模型输出…" /> : !output || !detail ? <Empty icon={<FileCode2 size={30} />} title="保留结果，再继续修正">从左侧选择一条响应，或粘贴历史输出。校验失败的内容也可以在这里找回。</Empty> : <div className="form-stack">
            <div className="row between wrap"><h3 className="output-detail-title">{stageNames[output.stage]}{output.blockIndex !== undefined ? ` · 片段 ${output.blockIndex + 1}` : ''}</h3><span className={`status-pill ${output.status === 'invalid' ? 'failed' : output.status === 'applied' ? 'completed' : ''}`}>{outputStatusNames[output.status]}</span></div>
            <div className="output-meta"><span>{dateText(output.createdAt)}</span><span>输入 {countText(output.inputTokens)} / 输出 {countText(output.outputTokens)} tokens</span>{output.httpStatus !== undefined && <span>HTTP {output.httpStatus}</span>}</div>
            <RequestDiagnostics key={output.id} capture={output} filename={`model-output-${output.id}-request`} />
            {output.incomplete && <div className="notice"><AlertCircle size={16} /><span>该次响应可能被截断。请核对完整结构与引文后再应用。</span></div>}
            {output.adjustments && output.adjustments.length > 0 && <details className="output-fold output-adjustments"><summary>系统已整理 {output.adjustments.length} 处 · 展开查看说明</summary><ul>{output.adjustments.map((adjustment, index) => <li key={index}><strong>{humanIssuePath(adjustment.path)}</strong><span>{adjustment.message}</span></li>)}</ul><p className="hint">这些是自动补全或对齐说明，不代表校验错误；原响应与最初文本仍保留。</p></details>}
            <div className="output-editor-modes" role="group" aria-label="修正方式"><button className={editorMode === 'form' ? 'active' : ''} onClick={() => { setEditorMode('form'); setFocusHelp(''); setFocusRequest(null); }}><ListChecks size={15} />可视化修正</button><button className={editorMode === 'json' ? 'active' : ''} onClick={() => showJson()}><Code2 size={15} />高级 JSON</button>{draft !== savedDraft && <span className="draft-badge">未保存</span>}</div>
            <div className="visual-help"><BookOpen size={18} /><div><strong>{output.stage === 'extraction' ? '按资料卡片修改，不需要编辑代码' : output.stage === 'planning' ? '按故事规划修改，不需要编辑代码' : '直接修改正文，再保存到故事中'}</strong><ol><li>有错误时，从“需要修正的地方”点击“去修改”。</li><li>{output.stage === 'extraction' ? '引用有误时先选原文段落，再用整段或选中的文字填入。' : output.stage === 'planning' ? '核对粗大纲、章节细纲和伏笔安排，保留原有设定。' : '核对下方正文并直接修改，原始响应不会被覆盖。'}</li><li>点击底部“保存并校验应用”。这一步不会调用模型。</li></ol>{output.issues.length > 0 && <p>问题标记来自上次校验；修改后再次保存，系统才会重新检查。</p>}</div></div>
            {output.issues.length > 0 ? <section className="output-issues" aria-label="具体校验问题">
              <h3><AlertCircle size={16} />需要修正的地方 <span>{output.issues.length}</span></h3>
              {output.issues.map((issue, index) => <article className="output-issue" key={`${issue.path}-${index}`}>
                <div className="output-issue-heading"><strong>{humanIssuePath(issue.path)}</strong><button type="button" className="button secondary small" onClick={() => locateIssue(issue.path)}>去修改<ArrowRight size={13} /></button></div><p>{issue.message}</p><code>{issue.path || '输出内容'}</code>
                {(issue.quote !== undefined || issue.sourceText !== undefined) && <dl className="output-issue-comparison">
                  {issue.quote !== undefined && <><dt>模型提供的引文</dt><dd className="output-quote">{issue.quote || '（空引文）'}</dd></>}
                  {issue.sourceText !== undefined && <><dt>对应原文{issue.paragraph ? ` · 第 ${issue.paragraph} 段` : ''}</dt><dd className="output-source-text">{issue.sourceText || '（此段不存在或为空）'}</dd></>}
                </dl>}
                {issue.paragraph !== undefined && issue.sourceText === undefined && <p className="hint">涉及原文第 {issue.paragraph} 段。</p>}
              </article>)}
            </section> : output.error && <Notice error={output.error} />}
            {focusHelp && <div className="notice"><AlertCircle size={14} /><span>{focusHelp}</span></div>}
            {editorMode === 'json' ? <><div className="output-edit-heading row between wrap"><label htmlFor="model-output-draft">修正后的文本 / JSON</label></div><textarea id="model-output-draft" className="output-code-editor" spellCheck={false} rows={17} value={draft} onChange={event => setDraft(event.target.value)} readOnly={!detail.canApply} disabled={busy} /><p className="hint">高级模式保留完整结构。修改后可切回“可视化修正”；不会清空或丢弃当前内容。只改输出，不覆盖原响应。</p></> : output.stage === 'writing' ? <div className="visual-field"><label htmlFor="model-prose-draft">修正后的正文</label><textarea id="model-prose-draft" className="output-prose-editor" rows={17} value={prose} onChange={event => setDraft(event.target.value)} readOnly={!detail.canApply} disabled={busy} /></div> : parsed?.ok ? <VisualOutputEditor value={parsed.value} stage={output.stage} issues={output.issues} sourceParagraphs={detail.sourceParagraphs} disabled={busy || !detail.canApply} onChange={value => setDraft(JSON.stringify(value, null, 2))} focusRequest={focusRequest} onCannotFocus={() => showJson('这个问题没有对应的表单字段。请在高级 JSON 中检查标记的结构或内容。')} /> : <div className="visual-parse-help" role="status"><AlertCircle size={23} /><h3>内容仍在，但暂时无法显示成表单</h3><p>{parsed && !parsed.ok ? parsed.message : '请先检查模型输出的内容。'}</p><div className="row wrap"><button className="button primary small" onClick={() => showJson()}>去高级 JSON 修复</button><button className="button secondary small" disabled={busy || !canImport} onClick={startPaste}>粘贴另一份完整输出</button></div><p className="hint">没有替换为空白内容。你也可以先下载当前草稿，保留修改。</p></div>}
            <div className="row wrap between"><button className="text-button" onClick={() => downloadText(draft, `model-output-${output.id}-edited-draft.txt`)}><Download size={14} />下载当前输出草稿</button><button className="text-button" onClick={() => void copy(draft)}><Copy size={14} />复制当前文本</button></div>
            <details className="output-fold">
              <summary>查看原始响应（只读）</summary>
              <div className="row end wrap output-copy-actions"><button className="text-button" onClick={() => void copy(output.rawResponse)}><Copy size={13} />复制原始响应</button><button className="text-button" onClick={() => downloadText(output.rawResponse, `model-output-${output.id}-raw.txt`)}><Download size={13} />下载原始响应</button></div>
              <pre className="output-raw" aria-label="原始响应">{output.rawResponse || '没有原始响应内容。'}</pre>
            </details>
            <details className="output-fold">
              <summary>查看最初的模型文本（只读）</summary>
              <div className="row end wrap output-copy-actions"><button className="text-button" onClick={() => void copy(output.text)}><Copy size={13} />复制最初文本</button><button className="text-button" onClick={() => downloadText(output.text, `model-output-${output.id}-original.txt`)}><Download size={13} />下载最初文本</button></div>
              <pre className="output-raw" aria-label="最初的模型文本">{output.text || '没有提取到模型文本，可检查上方完整响应。'}</pre>
            </details>
            {detail.sourceParagraphs.length > 0 && <details className="output-fold" open>
              <summary>核对原文段落 · {detail.sourceParagraphs.length} 段</summary>
              <div className="output-source-paragraphs" aria-label="引用原文段落">{detail.sourceParagraphs.map(paragraph => <div className="output-source-paragraph" key={paragraph.paragraph}><span>第 {paragraph.paragraph} 段</span><p>{paragraph.text}</p><button className="icon-button" aria-label={`复制原文第 ${paragraph.paragraph} 段`} onClick={() => void copy(paragraph.text)}><Copy size={13} /></button></div>)}</div>
            </details>}
            {!detail.canApply && <div className="notice"><AlertCircle size={15} /><span>{detail.unavailableReason || '当前任务状态不允许应用这条输出。仍可查看、复制或下载留存的内容。'}</span></div>}
            <div className="output-apply-footer"><p className="hint">仅在本地校验和应用，不调用模型。应用成功后不会自动继续运行后续步骤。</p><button className="button primary" disabled={busy || loadingDetail || !detail.canApply || !draft.trim()} onClick={() => void apply()}><Save size={15} />{busy ? '正在校验…' : '保存并校验应用'}</button></div>
          </div>}
        </div>
      </div>
    </div>
  </Modal>;
}
