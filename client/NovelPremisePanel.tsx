import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { countText } from './api';

export function NovelPremisePanel({ premise, revisionId, busy, onSave, onDirtyChange }: { premise: string; revisionId: string; busy: boolean; onSave: (premise: string, revision: string) => Promise<boolean>; onDirtyChange: (dirty: boolean) => void }) {
  const [draft, setDraft] = useState(premise);
  const [baseRevision, setBaseRevision] = useState(revisionId);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (!dirty) { setDraft(premise); setBaseRevision(revisionId); } }, [premise, revisionId, dirty]);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);

  return <section className="data-panel">
    <div className="panel-heading"><div><span className="eyebrow">STORY PREMISE</span><h2>小说设定</h2><p>保存后用于当前故事线的后续创作，已有章节和资料继续保留。设定随故事版本保存，可在版本历史中恢复。</p></div></div>
    <form className="form-stack planning-form" onSubmit={async event => {
      event.preventDefault();
      if (busy || saving || !dirty) return;
      setSaving(true);
      try { if (await onSave(draft, baseRevision)) setDirty(false); }
      finally { setSaving(false); }
    }}>
      <label>小说设定<textarea aria-label="小说设定" rows={14} maxLength={100000} placeholder="故事发生在怎样的世界？主要人物是谁？你希望故事怎样展开？" value={draft} disabled={saving} onChange={event => { setDraft(event.target.value); setDirty(true); }} /></label>
      <p className="hint">{countText(draft.length)} / 100,000 字符{dirty ? ' · 未保存' : ''}</p>
      {busy && <p className="hint">请先保存其他修改，并完成或停止当前故事线的任务，再保存设定。</p>}
      <button className="button primary align-start" type="submit" disabled={busy || saving || !dirty}><Save size={16} />{saving ? '正在保存…' : '保存小说设定'}</button>
    </form>
  </section>;
}
