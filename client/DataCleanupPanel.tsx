import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { CleanupPolicy as RetentionRule, DataCleanupSettings as CleanupSettings, DataCleanupReport as CleanupReport, DataCleanupState as CleanupView } from '../shared/data-cleanup';
import { api } from './api';
import { Notice, Spinner } from './ui';

type RuleDraft = { maxAgeDays: string; maxCount: string };
type CleanupDraft = { enabled: boolean; history: RuleDraft; requests: RuleDraft; jobs: RuleDraft };
const groups = [
  { key: 'history', label: '历史版本', unit: '每条故事线', description: '清理多余的回退版本。当前版本、章节资料快照、分支及任务仍需使用的版本会保留。' },
  { key: 'requests', label: '模型请求记录', unit: '每部作品', description: '清理旧请求、原始响应和诊断记录。未完成任务仍需使用的记录会保留，已保存的正文与资料不受影响。' },
  { key: 'jobs', label: '已结束的任务', unit: '每部作品', description: '清理已结束任务及其请求、草稿和生成过程。排队、运行、暂停、失败，以及仍待确认或重试的任务会保留。' },
] as const;

function draftOf(settings: CleanupSettings): CleanupDraft {
  const rule = (value: RetentionRule) => ({ maxAgeDays: String(value.maxAgeDays), maxCount: String(value.maxCount) });
  return { enabled: settings.enabled, history: rule(settings.history), requests: rule(settings.requests), jobs: rule(settings.jobs) };
}
function reportText(report: CleanupReport) {
  return `历史版本 ${report.revisions.toLocaleString()} 个、请求记录 ${report.requests.toLocaleString()} 条、任务 ${report.jobs.toLocaleString()} 个`;
}

export function DataCleanupPanel({ onDirtyChange, onBusyChange }: { onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const [draft, setDraft] = useState<CleanupDraft | null>(null);
  const [saved, setSaved] = useState('');
  const [lastRun, setLastRun] = useState<CleanupReport>();
  const [preview, setPreview] = useState<CleanupReport>();
  const [busy, setBusy] = useState<'load' | 'save' | 'preview' | 'run' | null>('load');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => onBusyChange(!!busy), [busy, onBusyChange]);
  useEffect(() => { void reload(); return () => { controller.current?.abort(); controller.current = null; }; }, []);

  function accept(value: CleanupView) {
    const next = draftOf(value.settings); setDraft(next); setSaved(JSON.stringify(next)); setLastRun(value.lastRun); setPreview(undefined);
  }
  async function action(kind: NonNullable<typeof busy>, work: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current;
    setBusy(kind); setError(''); setMessage('');
    try { await work(current.signal); }
    catch (error) { if (!current.signal.aborted) setError((error as Error).message); }
    finally { if (controller.current === current) controller.current = null; if (!current.signal.aborted) setBusy(null); }
  }
  async function reload() { await action('load', async signal => accept(await api<CleanupView>('/data-cleanup', { signal }))); }
  function change(next: CleanupDraft) { setDraft(next); setPreview(undefined); setMessage(''); setError(''); }
  function prepared(): CleanupSettings {
    if (!draft) throw new Error('清理设置尚未加载。');
    const settings: CleanupSettings = { enabled: draft.enabled, history: { maxAgeDays: 0, maxCount: 0 }, requests: { maxAgeDays: 0, maxCount: 0 }, jobs: { maxAgeDays: 0, maxCount: 0 } };
    for (const group of groups) for (const field of ['maxAgeDays', 'maxCount'] as const) {
      const value = draft[group.key][field]; const maximum = field === 'maxAgeDays' ? 36500 : 1000000;
      if (!/^\d+$/.test(value) || Number(value) > maximum) {
        form.current?.querySelector<HTMLInputElement>(`[name="${group.key}.${field}"]`)?.focus();
        throw new Error(`${group.label}的${field === 'maxAgeDays' ? '保留天数' : '保留数量'}需填写 0～${maximum.toLocaleString()} 的整数。`);
      }
      settings[group.key][field] = Number(value);
    }
    return settings;
  }
  async function save() {
    await action('save', async signal => {
      const settings = prepared();
      accept(await api<CleanupView>('/data-cleanup', { method: 'PUT', body: JSON.stringify({ settings }), signal }));
      setMessage(settings.enabled ? '清理设置已保存，自动清理已开启。' : '清理设置已保存，自动清理已关闭。');
    });
  }
  async function inspect() {
    setPreview(undefined);
    await action('preview', async signal => {
      const result = await api<CleanupReport>('/data-cleanup/preview', { method: 'POST', body: JSON.stringify({ settings: prepared() }), signal });
      setPreview(result);
    });
  }
  async function run() {
    if (!preview) return;
    const checked = preview;
    setPreview(undefined);
    await action('run', async signal => {
      const result = await api<CleanupReport>('/data-cleanup/run', { method: 'POST', body: JSON.stringify({ settings: prepared(), expectedFingerprint: checked.fingerprint }), signal });
      setLastRun(result); setMessage(`清理完成：${reportText(result)}。`);
    });
  }
  if (!draft) return <section aria-label="数据清理加载状态">{busy ? <Spinner /> : <><Notice error={error} /><button type="button" className="button secondary" onClick={() => void reload()}><RefreshCw size={15} />重新加载数据清理设置</button></>}</section>;
  const removable = preview && preview.revisions + preview.requests + preview.jobs + preview.chapters + preview.images;
  return <form ref={form} className="form-stack" aria-label="数据清理设置" aria-busy={!!busy} noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
    <div className="settings-section-heading"><h2>数据清理</h2><p>为所有作品设置保留规则，也可以先预览，再手动清理。清理设置单独保存。</p></div>
    <fieldset className="settings-section-fields form-stack" disabled={!!busy}>
      <label className="checkbox"><input type="checkbox" aria-label="开启自动清理" checked={draft.enabled} onChange={event => change({ ...draft, enabled: event.target.checked })} />开启自动清理</label>
      <p className="hint">0 表示不限制该项。只填天数或数量即可；两项都填写时，超过任意一项就清理。需要保留的依赖记录会跳过，实际保留数量可能超过设定值。</p>
      {groups.map(group => <section key={group.key} className="account-security-card form-stack" aria-label={`${group.label}保留规则`}>
        <h3>{group.label}</h3><p className="hint">{group.description}</p>
        <div className="form-grid">
          <label>保留最近多少天<input type="number" name={`${group.key}.maxAgeDays`} aria-label={`${group.label}保留天数`} min={0} max={36500} step={1} required value={draft[group.key].maxAgeDays} onChange={event => change({ ...draft, [group.key]: { ...draft[group.key], maxAgeDays: event.target.value } })} /></label>
          <label>最多保留多少条（{group.unit}）<input type="number" name={`${group.key}.maxCount`} aria-label={`${group.label}保留数量`} min={0} max={1000000} step={1} required value={draft[group.key].maxCount} onChange={event => change({ ...draft, [group.key]: { ...draft[group.key], maxCount: event.target.value } })} /></label>
        </div>
      </section>)}
    </fieldset>
    <div className="settings-feedback" aria-live="polite">{error && <Notice error={error} />}{message && <div className="notice success" role="status"><CheckCircle2 size={17} />{message}</div>}</div>
    <footer className="row between wrap"><p className="hint">{dirty ? '有未保存的清理规则。保存后供自动清理使用。' : '自动清理按已保存的规则执行。'}手动清理使用上方当前规则，不改变已保存设置。</p><button type="submit" className="button primary" disabled={!!busy}><Save size={16} />{busy === 'save' ? '正在保存…' : '保存清理设置'}</button></footer>
    <section className="account-security-card form-stack" aria-label="手动清理">
      <h3>手动清理</h3><p className="hint">先预览本次会删除的记录，确认后再执行。已删除的历史和请求无法通过版本回退恢复，需要保留时先备份作品。</p>
      <button type="button" className="button secondary align-start" disabled={!!busy} onClick={() => void inspect()}><RefreshCw size={16} />{busy === 'preview' ? '正在计算…' : '预览清理范围'}</button>
      {preview && <div className="form-stack" aria-live="polite">
        <p>本次将清理：{reportText(preview)}。</p>
        {(preview.chapters > 0 || preview.images > 0) && <p className="hint">同时清理不再被保留版本或任务使用的章节正文 {preview.chapters.toLocaleString()} 份、图片 {preview.images.toLocaleString()} 张。</p>}
        <p className="hint">因仍被使用而保留：版本 {preview.protectedRevisions.toLocaleString()} 个、请求 {preview.protectedRequests.toLocaleString()} 条、任务 {preview.protectedJobs.toLocaleString()} 个。</p>
        {removable ? <button type="button" className="button danger align-start" disabled={!!busy} onClick={() => void run()}><Trash2 size={16} />确认清理以上记录</button> : <p className="hint">当前规则下没有可清理的记录。</p>}
      </div>}
      {busy === 'run' && <p className="hint" role="status">正在清理，请稍候…</p>}
    </section>
    {lastRun && <section className="account-security-card form-stack" aria-label="最近清理结果"><h3>最近清理结果</h3><p className="hint">{lastRun.completedAt ? `${new Date(lastRun.completedAt).toLocaleString('zh-CN')}：` : ''}{reportText(lastRun)}。</p></section>}
  </form>;
}
