import { useEffect, useRef, useState } from 'react';
import { Check, Sparkles } from 'lucide-react';
import { MAX_TITLE_REPAIR_CHAPTERS, type ChapterTitlePreview, type ChapterTitleSuggestion } from '../shared/chapter-titles';
import { Notice, Spinner } from './ui';
import { RequestDiagnostics } from './RequestDiagnostics';

export type ChapterTitleChange = Pick<ChapterTitleSuggestion, 'chapterId' | 'originalTitle' | 'title'>;
export function ChapterTitleRepairPanel({ chapters, initialChapterId, busy: outsideBusy = false, onBusy, onPreview, onApply, applyLabel = '应用所选标题' }: {
  chapters: { id: string; title: string }[]; initialChapterId?: string; busy?: boolean; onBusy?: (value: boolean) => void;
  onPreview: (ids: string[], instruction: string, signal: AbortSignal) => Promise<ChapterTitlePreview>;
  onApply: (changes: ChapterTitleChange[]) => Promise<void>; applyLabel?: string;
}) {
  const initial = Math.max(0, chapters.findIndex(chapter => chapter.id === initialChapterId));
  const [start, setStart] = useState(Math.max(1, initial)); const [end, setEnd] = useState(Math.min(chapters.length, initial + 3));
  const [instruction, setInstruction] = useState(''); const [result, setResult] = useState<ChapterTitlePreview | null>(null);
  const [suggestions, setSuggestions] = useState<ChapterTitleSuggestion[]>([]); const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [note, setNote] = useState('');
  const alive = useRef(true); const request = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); }; }, []);
  const disabled = outsideBusy || busy;
  const validRange = Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end <= chapters.length && end >= start && end - start < MAX_TITLE_REPAIR_CHAPTERS;
  const changes = suggestions.filter(suggestion => selected.includes(suggestion.chapterId) && suggestion.title.trim() !== suggestion.originalTitle).map(suggestion => ({ chapterId: suggestion.chapterId, originalTitle: suggestion.originalTitle, title: suggestion.title.trim() }));
  async function run(action: () => Promise<void>) {
    if (disabled) return; setBusy(true); onBusy?.(true); setError(''); setNote('');
    try { await action(); } catch (error) { if (alive.current && !request.current?.signal.aborted) setError((error as Error).message); }
    finally { if (alive.current) { setBusy(false); onBusy?.(false); } }
  }
  async function preview() {
    if (!validRange) return;
    await run(async () => {
      const controller = new AbortController(); request.current = controller; setResult(null); setSuggestions([]); setSelected([]);
      const value = await onPreview(chapters.slice(start - 1, end).map(chapter => chapter.id), instruction, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      setResult(value); setSuggestions(value.suggestions ?? []);
      setSelected((value.suggestions ?? []).filter(suggestion => suggestion.title !== suggestion.originalTitle && suggestion.confidence === 'high' && !suggestion.multipleChapters).map(suggestion => suggestion.chapterId));
      if (!value.ok) setError(value.error || '未能生成标题建议。');
      else setNote('建议已生成，请核对原标题、原文依据和修改范围，再应用所选标题。');
    });
  }
  return <div className="form-stack title-repair" data-testid="chapter-title-repair">
    <p className="hint">根据本章开头、结尾及相邻正文核对标题；能在原文件中唯一定位时，也核对原始标题。每次最多 {MAX_TITLE_REPAIR_CHAPTERS} 章，保留原文编号的跳号；合并了多章的正文仍需检查分章。</p>
    <div className="form-grid"><label>起始目录位置<input type="number" min={1} max={chapters.length} value={start} disabled={disabled} onChange={event => setStart(Number(event.target.value))} /></label><label>结束目录位置<input type="number" min={start} max={chapters.length} value={end} disabled={disabled} onChange={event => setEnd(Number(event.target.value))} /></label></div>
    <p className="hint">{validRange ? `本次检查：${chapters[start - 1].title} → ${chapters[end - 1].title}。目录位置只用于选择范围，不发送给 AI。` : `请选择连续的 1～${MAX_TITLE_REPAIR_CHAPTERS} 章。`}</p>
    <label>标题修复要求（可选）<textarea rows={2} maxLength={2000} value={instruction} disabled={disabled} onChange={event => setInstruction(event.target.value)} placeholder="例如：标题错移到了下一章，以正文开头的实际标题为准。" /></label>
    <div><button className="button secondary" disabled={disabled || !validRange} onClick={() => void preview()}><Sparkles size={15} />生成标题修复建议</button></div>
    {busy && <Spinner text="正在处理章节标题…" />}{error && <Notice error={error} />}{note && <p className="hint" role="status">{note}</p>}
    {suggestions.map(suggestion => <section className="title-repair-card form-stack" key={suggestion.chapterId}>
      <label className="checkbox"><input type="checkbox" aria-label={`应用标题：${suggestion.originalTitle}`} disabled={disabled} checked={selected.includes(suggestion.chapterId)} onChange={event => setSelected(values => event.target.checked ? [...values, suggestion.chapterId] : values.filter(id => id !== suggestion.chapterId))} />原标题：{suggestion.originalTitle}</label>
      <label>建议标题<input aria-label={`建议标题：${suggestion.originalTitle}`} value={suggestion.title} maxLength={500} disabled={disabled} onChange={event => setSuggestions(values => values.map(value => value.chapterId === suggestion.chapterId ? { ...value, title: event.target.value } : value))} /></label>
      <p className="hint">{suggestion.confidence === 'high' ? '依据较充分' : suggestion.confidence === 'medium' ? '需要核对' : '依据不足，默认不选'}{suggestion.multipleChapters ? ' · 正文可能合并了多章，默认不选' : ''} · {suggestion.reason}</p>
      {suggestion.evidence && <blockquote className="title-repair-evidence">{suggestion.evidence}</blockquote>}
    </section>)}
    {result?.ok && <div className="row end wrap"><button className="button primary" disabled={disabled || !changes.length || changes.some(change => !change.title)} onClick={() => void run(async () => { await onApply(changes); if (alive.current) { setResult(null); setSuggestions([]); setSelected([]); setNote('所选标题已应用。'); } })}><Check size={15} />{applyLabel}（{changes.length}）</button></div>}
    {result?.capture && <RequestDiagnostics capture={result.capture} filename="chapter-title-repair" showResponse />}
  </div>;
}
