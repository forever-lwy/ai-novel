import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import type { Chapter, StoryImage } from '../shared/types';
import { api } from './api';
import { Modal, Notice, Spinner } from './ui';
import { proseParagraphs } from './writing-timeline';

export function ImagePlacementDialog({ image, branchId, busy, error, onClose, onSave }: {
  image: StoryImage; branchId: string; busy: boolean; error: string; onClose: () => void;
  onSave: (selection?: { start: number; end: number }) => Promise<void>;
}) {
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [loadError, setLoadError] = useState(''); const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<number | null | undefined>(undefined);
  const paragraphs = useMemo(() => proseParagraphs(chapter?.text ?? ''), [chapter?.text]);
  useEffect(() => {
    const controller = new AbortController(); let alive = true;
    setLoadError('');
    void api<Chapter>(`/branches/${branchId}/chapters/${image.chapterId}?view=author`, { signal: controller.signal }).then(value => {
      if (!alive) return;
      setChapter(value);
      setSelected(previous => previous !== undefined ? previous : image.selection ? proseParagraphs(value.text).findIndex(row => row.start < image.selection!.end && row.end > image.selection!.start) : null);
    }).catch(reason => { if (alive) setLoadError(reason instanceof Error ? reason.message : '章节加载失败'); });
    return () => { alive = false; controller.abort(); };
  }, [branchId, image.chapterId, attempt]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !chapter || selected === undefined) return;
    const paragraph = selected === null ? undefined : paragraphs[selected];
    if (selected !== null && !paragraph) return;
    await onSave(paragraph ? { start: paragraph.start, end: paragraph.end } : undefined);
  }
  return <Modal title="修改绑定位置" wide closeDisabled={busy} onClose={() => { if (!busy) onClose(); }}>
    <form className="form-stack image-placement-form" onSubmit={submit}>
      <p className="hint">选择这张 CG 对应的正文段落，也可以只关联章节。保存后以你的选择为准，后台自动定位不会覆盖。</p>
      {image.sceneDescription && <blockquote className="image-source-text">{image.sceneDescription}</blockquote>}
      {loadError ? <><Notice error={loadError} /><button type="button" className="button secondary align-start" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={14} />重新加载章节</button></> : !chapter ? <Spinner text="正在读取关联章节…" /> : <>
        <p className="image-placement-title">{chapter.title}</p>
        <fieldset className="image-placement-options" disabled={busy}>
          <legend>绑定位置</legend>
          <label className={`image-placement-option ${selected === null ? 'is-selected' : ''}`}>
            <input type="radio" name="image-placement" checked={selected === null} onChange={() => setSelected(null)} />
            <span><strong>仅关联章节</strong><small>不指定具体正文位置。</small></span>
          </label>
          {paragraphs.map((paragraph, index) => <label className={`image-placement-option ${selected === index ? 'is-selected' : ''}`} key={paragraph.start}>
            <input type="radio" name="image-placement" checked={selected === index} onChange={() => setSelected(index)} />
            <span><strong>第 {index + 1} 段</strong><span className="image-placement-paragraph">{paragraph.text}</span></span>
          </label>)}
        </fieldset>
      </>}
      {error && <Notice error={error} />}
      <div className="row end wrap"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="button primary" disabled={busy || !chapter || selected === undefined || selected === -1}><Save size={14} />{busy ? '正在保存…' : '保存绑定位置'}</button></div>
    </form>
  </Modal>;
}
