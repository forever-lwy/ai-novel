import { useRef, useState } from 'react';
import { Upload, Scissors, Combine, Check, FileText, ArrowLeft } from 'lucide-react';
import type { Job, Source, SourcePreview } from '../shared/types';
import { api, countText, post } from './api';
import { Notice, Spinner } from './ui';

export function ImportPanel({ projectId, branchId, revisionId, sources, onImported }: { projectId: string; branchId: string; revisionId: string; sources: Source[]; onImported: (job: Job) => void }) {
  const [preview, setPreview] = useState<SourcePreview | null>(null); const [index, setIndex] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const textarea = useRef<HTMLTextAreaElement>(null);
  async function upload(file?: File) {
    if (!file) return; setBusy(true); setError('');
    try { const data = new FormData(); data.append('file', file); setPreview(await api<SourcePreview>(`/projects/${projectId}/import`, { method: 'POST', body: data })); setIndex(0); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function reopen(sourceId: string) { setBusy(true); setError(''); try { setPreview(await api<SourcePreview>(`/sources/${sourceId}/preview`)); setIndex(0); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  function change(patch: { title?: string; text?: string }) { if (preview) setPreview({ ...preview, chapters: preview.chapters.map((chapter, i) => i === index ? { ...chapter, ...patch } : chapter) }); }
  function split() {
    if (!preview || !textarea.current) return;
    const position = textarea.current.selectionStart; const chapter = preview.chapters[index];
    if (position <= 0 || position >= chapter.text.length) { setError('请先在正文中，把光标放到希望分章的位置。'); return; }
    const chapters = [...preview.chapters]; chapters.splice(index, 1, { title: chapter.title, text: chapter.text.slice(0, position).trim() }, { title: `${chapter.title}（下）`, text: chapter.text.slice(position).trim() }); setPreview({ ...preview, chapters }); setError('');
  }
  function merge() { if (!preview || index >= preview.chapters.length - 1) return; const chapters = [...preview.chapters]; chapters.splice(index, 2, { title: chapters[index].title, text: `${chapters[index].text}\n\n${chapters[index + 1].text}` }); setPreview({ ...preview, chapters }); }
  async function confirm() {
    if (!preview) return; setBusy(true); setError('');
    try { const job = await post<Job>(`/sources/${preview.source.id}/confirm`, { branchId, baseRevisionId: revisionId, chapters: preview.chapters }); onImported(job); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const chapter = preview?.chapters[index];
  return <div className="form-stack">{error && <Notice error={error} onClose={() => setError('')} />}{busy && <Spinner text="正在处理原作…" />}
    {!preview ? <><label className={`upload-zone ${busy ? 'disabled' : ''}`}><Upload size={30} strokeWidth={1.4} /><strong>选择一本小说，走进它的世界</strong><span>支持 TXT 和 EPUB；上传后先确认目录，再开始整理。</span><span className="button primary">选择文件</span><input className="visually-hidden" type="file" accept=".txt,.epub,text/plain,application/epub+zip" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} /></label>{sources.length > 0 && <div><h3>已上传原作</h3><div className="source-list">{sources.map(source => <div className="source-row" key={source.id}><FileText size={19} /><div><strong>{source.filename}</strong><small>{source.chapterCount} 章 · {source.confirmed ? '已确认导入' : '待确认目录'}</small></div>{!source.confirmed && <button className="button secondary small" disabled={busy} onClick={() => void reopen(source.id)}>继续分章</button>}<a className="text-button" href={`/api/sources/${source.id}/file`} download>原文件</a></div>)}</div></div>}</> : <>
      <div className="row between wrap"><div><strong>{preview.source.filename}</strong><p className="hint">{preview.chapters.length} 章 · 共 {countText(preview.chapters.reduce((sum, ch) => sum + ch.text.length, 0))} 字。原始文件会完整保留。</p></div><button className="text-button" disabled={busy} onClick={() => setPreview(null)}><ArrowLeft size={15} />返回文件选择</button></div>
      <div className="import-editor"><nav className="import-chapters" aria-label="导入章节目录">{preview.chapters.map((ch, i) => <button key={i} className={i === index ? 'selected' : ''} onClick={() => setIndex(i)}><span>{String(i + 1).padStart(2, '0')}</span>{ch.title}</button>)}</nav>{chapter && <div className="import-content"><label>章节名称<input value={chapter.title} onChange={e => change({ title: e.target.value })} /></label><label>章节正文<textarea ref={textarea} rows={16} value={chapter.text} onChange={e => change({ text: e.target.value })} /></label><div className="row wrap"><button className="button secondary small" onClick={split}><Scissors size={14} />从光标位置分章</button><button className="button secondary small" disabled={index >= preview.chapters.length - 1} onClick={merge}><Combine size={14} />合并下一章</button><span className="hint">{countText(chapter.text.length)} 字</span></div></div>}</div>
      <div className="sticky-modal-footer between"><span className="hint">关闭窗口前请确认；分章调整在确认后保存。</span><button className="button primary" disabled={busy || !preview.chapters.length || preview.chapters.some(ch => !ch.title.trim() || !ch.text.trim())} onClick={() => void confirm()}><Check size={17} />确认目录并整理</button></div>
    </>}
  </div>;
}
