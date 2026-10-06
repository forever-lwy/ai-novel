import { Pause, Play, RefreshCw, Square } from 'lucide-react';
import type { Job } from '../shared/types';
import { Notice } from './ui';

export function GenerationControls({ job, busy, error, onAction }: { job: Job; busy: boolean; error?: string; onAction: (action: 'pause' | 'resume' | 'retry' | 'cancel') => void }) {
  const running = ['queued', 'running'].includes(job.status); const waitingChoice = job.status === 'paused' && !!job.pendingChoice;
  const saved = !!job.generatedChapterId;
  const retryHint = saved ? '正文已保存；只重试后续规划，不会重新生成正文，仍可能产生模型费用。' : job.generationInput?.mode === 'rpg' ? '重试会从已保存的交互进度再次请求模型，可能再次计费。' : '重试或继续会重新生成这一章，可能再次计费。已收到的草稿可以先下载保存。';
  return <section className="generation-controls" aria-label="生成控制" aria-busy={busy}>
    {job.error && job.status === 'failed' && <Notice error={job.error} />}{error && <Notice error={error} />}
    {['failed', 'paused'].includes(job.status) && !waitingChoice && <p className="hint">{retryHint}</p>}
    {job.status === 'cancelled' && <p className="hint">{saved ? '已停止后续规划，已保存正文仍然保留，可以退出生成查看。' : '已停止生成，收到的正文草稿仍然保留，可以下载或退出查看。'}</p>}
    {job.status === 'stale' && <p className="hint">故事版本已变化，当前草稿仍保留。请对照当前故事线后再开始新的生成。</p>}
    {running && saved && <p className="hint">正文已保存，后续规划正在进行；停止不会删除已保存的正文。</p>}
    <div className="row wrap">
      {job.status === 'failed' && <button className="button primary small" disabled={busy} onClick={() => onAction('retry')}><RefreshCw size={14} />{busy ? '正在提交…' : saved ? '重试后续规划' : '重试生成'}</button>}
      {job.status === 'paused' && !waitingChoice && <button className="button primary small" disabled={busy} onClick={() => onAction('resume')}><Play size={14} />{busy ? '正在提交…' : saved ? '继续后续规划' : '继续生成'}</button>}
      {running && <button className="button secondary small" disabled={busy} onClick={() => onAction('pause')}><Pause size={14} />暂停生成</button>}
      {(running || ['paused', 'failed'].includes(job.status)) && <button className="button secondary small" disabled={busy} onClick={() => onAction('cancel')}><Square size={14} />停止生成</button>}
    </div>
  </section>;
}
