import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Sparkles } from 'lucide-react';
import type { BranchView, Job } from '../shared/types';
import { api, post } from './api';
import { Modal, Notice } from './ui';

type Candidate = { text: string; chapterIds: string[]; baseRevisionId: string };
export function SummaryCompression({ branchId, revisionId, jobs, disabled, onJob, onApplied, onDirtyChange }: {
  branchId: string; revisionId: string; jobs: Job[]; disabled: boolean;
  onJob: (job: Job) => void; onApplied: (view: BranchView) => Promise<void>; onDirtyChange: (dirty: boolean) => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null); const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const mounted = useRef(true); const requested = useRef('');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onDirtyChange(!!candidate && text !== candidate.text); return () => onDirtyChange(false); }, [candidate, text, onDirtyChange]);
  const available = jobs.filter(job => job.branchId === branchId && job.purpose === 'compress-summary');
  const active = available.find(job => ['queued', 'running', 'paused'].includes(job.status));
  const selected = available.find(job => job.id === jobId);
  useEffect(() => {
    if (!selected || selected.status !== 'completed' || requested.current === selected.id) return;
    requested.current = selected.id; let alive = true;
    void api<Candidate>(`/jobs/${selected.id}/summary-compression?view=author`).then(value => {
      if (alive) { setCandidate(value); setText(value.text); setError(''); }
    }).catch(e => { if (alive) { requested.current = ''; setError((e as Error).message); } });
    return () => { alive = false; };
  }, [selected?.id, selected?.status]);
  const close = () => { if (!busy && (!candidate || text === candidate.text || window.confirm('放弃尚未保存的压缩摘要修改？'))) { setCandidate(null); setJobId(null); } };
  async function start() {
    setBusy(true); setError('');
    try { const job = await post<Job>(`/branches/${branchId}/summary-compression?view=author`, { baseRevisionId: revisionId }); if (mounted.current) { onJob(job); setJobId(job.id); requested.current = ''; } }
    catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function confirm() {
    if (!candidate || !jobId) return; setBusy(true); setError('');
    try { const value = await post<BranchView>(`/branches/${branchId}/summary-compression/confirm?view=author`, { baseRevisionId: candidate.baseRevisionId, jobId, text }); if (mounted.current) { await onApplied(value); setCandidate(null); setJobId(null); } }
    catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className="summary-compression"><div className="row wrap"><button className="button secondary small" disabled={disabled || busy || !!active} onClick={() => void start()}><Sparkles size={14} />{active ? '正在压缩摘要…' : '生成压缩摘要候选'}</button>{available.find(job => job.status === 'completed') && <button className="text-button" disabled={busy} onClick={() => { requested.current = ''; setJobId(available.find(job => job.status === 'completed')!.id); }}>查看最近压缩候选</button>}</div><p className="hint">保留各章原始摘要。压缩结果经你检查、修改并确认后，才用于之后的写作上下文。</p>{error && !candidate && <Notice error={error} />}{selected && ['failed', 'cancelled', 'stale'].includes(selected.status) && <Notice error={selected.error || selected.message || '摘要压缩未完成，请重新生成候选。'} />}{candidate && <Modal title="确认写作上下文的压缩摘要" wide onClose={close} closeDisabled={busy}><div className="form-stack"><p>这份摘要覆盖 {candidate.chapterIds.length} 章。请检查关键事件、因果关系和人物变化，确认后才会用于写作；各章摘要仍会保留。</p><label>压缩摘要<textarea aria-label="压缩摘要" rows={16} value={text} onChange={event => setText(event.target.value)} /></label>{candidate.baseRevisionId !== revisionId && <p className="notice">故事版本已经变化。请重新生成候选，以免遗漏新剧情。</p>}{error && <Notice error={error} />}<div className="row end"><button className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || !text.trim() || candidate.baseRevisionId !== revisionId} onClick={() => void confirm()}><CheckCircle2 size={15} />确认使用压缩摘要</button></div></div></Modal>}</div>;
}
