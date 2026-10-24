import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpRight, CheckCircle2, CircleSlash, ImagePlus, Images, Layers, RefreshCw, Trash2, WandSparkles, X } from 'lucide-react';
import type { ChapterRef, Entity, ImageGenerateInput, Settings, StoryImage, StoryImageKind } from '../shared/types';
import { imageModelCapabilities, type ImageModelCapabilities } from '../shared/image-capabilities';
import { normalizeImageSettings } from '../shared/image-settings';
import { api, dateText, statusNames } from './api';
import { Empty, Modal, Notice } from './ui';
import { ImageViewer } from './ImageViewer';
import { CachedImage } from './CachedImage';
import { groupStoryImages, type StoryImageGroup } from './image-groups';

export type ImageTarget = Omit<ImageGenerateInput, 'baseRevisionId'>;
export type ImageAction = 'retry' | 'cancel' | 'activate' | 'deactivate' | 'delete';
export const imageKindNames: Record<StoryImageKind, string> = { portrait: '人物立绘', cg: '剧情 CG', entity: '资料图片', map: '世界地图' };
export function latestImage(images: StoryImage[], entityId: string) { return images.filter(image => image.entityId === entityId && image.active !== false && image.status === 'completed' && image.url).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]; }

export function ImageRequestDialog({ target, title, excerpt, reference, images = [], busy, error, onClose, onSubmit }: { target: ImageTarget; title: string; excerpt?: string; reference?: StoryImage; images?: StoryImage[]; busy: boolean; error: string; onClose: () => void; onSubmit: (input: ImageTarget) => Promise<void> }) {
  const [instruction, setInstruction] = useState('');
  const [referenceMode, setReferenceMode] = useState<'auto' | 'manual' | 'none'>(target.selectedReferenceImageIds === undefined ? 'auto' : target.selectedReferenceImageIds.length ? 'manual' : 'none');
  const [selectedIds, setSelectedIds] = useState(target.selectedReferenceImageIds ?? []); const [search, setSearch] = useState('');
  const [caps, setCaps] = useState<ImageModelCapabilities | null>(null); const [settingsError, setSettingsError] = useState(''); const [settingsAttempt, setSettingsAttempt] = useState(0);
  useEffect(() => {
    let alive = true; setSettingsError(''); setCaps(null);
    void api<Settings>('/settings').then(settings => { if (alive) setCaps(imageModelCapabilities(normalizeImageSettings(settings.imageSettings))); }).catch(error => { if (alive) setSettingsError((error as Error).message); });
    return () => { alive = false; };
  }, [settingsAttempt]);
  const candidates = images.filter(image => image.status === 'completed' && image.active !== false && image.url && image.id !== target.referenceImageId);
  const filtered = candidates.filter(image => `${image.title} ${imageKindNames[image.kind]}`.toLowerCase().includes(search.trim().toLowerCase()));
  const limit = Math.max(0, (caps?.maxReferences ?? 0) - (target.referenceImageId ? 1 : 0));
  const invalidSelection = referenceMode === 'manual' && (!selectedIds.length || selectedIds.length > limit || selectedIds.some(id => !candidates.some(image => image.id === id)));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !caps || invalidSelection || reference && !instruction.trim()) return;
    await onSubmit({ ...target, instruction: instruction.trim() || undefined, selectedReferenceImageIds: referenceMode === 'auto' ? undefined : referenceMode === 'none' ? [] : selectedIds });
  }
  return <Modal title={title} onClose={() => !busy && onClose()} closeDisabled={busy}><form className="form-stack image-request" onSubmit={submit}>
    {reference?.url && <CachedImage className="image-reference" src={reference.previewUrl || reference.url} alt={`修改参考：${reference.title}`} />}{excerpt && <blockquote className="image-source-text">{excerpt}</blockquote>}
    <p className="hint">{reference ? '以这张图片为参考，AI 先根据修改要求编写专用提示词，再生成新图片。原图会保留。' : 'AI 根据已保存的正文或资料编写专用提示词，再生成图片。已有图片会保留，完成后可在图册查看本次提示词、尺寸与参考图。'}</p>
    {target.kind === 'cg' && <p className="hint">会一并参考本章完整前后文、前两章全文、此前剧情摘要及相关人物与世界资料；绘制范围仍以本次章节或选段为准。</p>}
    <label>{reference ? '修改要求' : '补充绘制要求（可选）'}<textarea rows={4} disabled={busy} required={!!reference} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder={reference ? '例如：保留服装和五官，把背景改成雨中的城门。' : '例如：全身立绘、简洁背景，或希望表现的光线与构图。'} /></label>
    <label>参考图选择<select aria-label="参考图选择" value={referenceMode} disabled={busy} onChange={event => setReferenceMode(event.target.value as typeof referenceMode)}><option value="auto">自动选择</option><option value="manual">自己选择</option><option value="none">{reference ? '不用其他参考图' : '不用参考图'}</option></select></label>
    {!caps && !settingsError && <p className="hint" role="status">正在读取图片模型的参考图限制…</p>}
    {caps && caps.referenceMode === 'none' && <p className="hint">当前图片模型不支持参考图，请在设置中更换支持图片输入的模型。</p>}
    {referenceMode === 'auto' && <p className="hint">按当前生图设置，由 AI 为剧情 CG 选择合适的人物立绘。{reference ? '修改时始终保留上方原图作为参考。' : ''}</p>}
    {referenceMode === 'none' && <p className="hint">{reference ? '只参考上方待修改的原图，不添加人物立绘或其他图片。' : '本次只按文字资料绘制，不向图片模型发送参考图。'}</p>}
    {referenceMode === 'manual' && <section className="image-reference-picker" aria-label="选择参考图片">
      <p className="hint">严格使用勾选的图片，AI 不会替换或增减。只显示当前故事线已启用且完成的图片；其他版本请先到故事图册启用。</p>
      <div className="row between wrap"><span role="status">已选 {selectedIds.length} 张{caps ? ` / 最多 ${limit} 张` : ''}{reference ? '（另含上方原图）' : ''}</span><button className="text-button" type="button" disabled={busy || !selectedIds.length} onClick={() => setSelectedIds([])}>清空选择</button></div>
      <label>查找参考图片<input aria-label="查找参考图片" value={search} disabled={busy} onChange={event => setSearch(event.target.value)} placeholder="搜索图片名称或类型…" /></label>
      <div className="image-reference-options">{filtered.map(image => {
        const index = selectedIds.indexOf(image.id); const checked = index >= 0;
        return <label className={`image-reference-option ${checked ? 'is-selected' : ''}`} key={image.id} data-reference-image-id={image.id}><CachedImage src={image.previewUrl || image.url} alt={image.title} loading="lazy" /><span className="checkbox"><input type="checkbox" aria-label={`参考图片 ${image.title}`} checked={checked} disabled={busy || !caps || !checked && selectedIds.length >= limit} onChange={() => setSelectedIds(ids => checked ? ids.filter(id => id !== image.id) : [...ids, image.id])} /><span>{image.title}</span></span><small>{imageKindNames[image.kind]}{checked ? ` · 参考图 ${index + 1 + (reference ? 1 : 0)}` : ''}</small></label>;
      })}</div>
      {!filtered.length && <p className="hint">{candidates.length ? '没有匹配的图片，请更换搜索词。' : '暂无可选参考图片，可先绘制并启用图片，或选择不用参考图。'}</p>}
      {selectedIds.some(id => !candidates.some(image => image.id === id)) && <Notice error="部分所选图片已不可用，请清空后重新选择。" />}
      {caps && selectedIds.length > limit && <Notice error={`当前模型最多还可选择 ${limit} 张参考图，请减少选择。`} />}
    </section>}
    {settingsError && <><Notice error={settingsError} /><button className="text-button" type="button" disabled={busy} onClick={() => setSettingsAttempt(value => value + 1)}>重新加载图片设置</button></>}
    {error && <Notice error={error} />}<button className="button primary" disabled={busy || !caps || invalidSelection || (!!reference && !instruction.trim())}><ImagePlus size={16} />{busy ? '正在提交…' : reference ? '开始修改' : '开始绘制'}</button>
  </form></Modal>;
}

export function ImageGenerationDetails({ image }: { image: StoryImage }) {
  const parameters = image.generationParameters; const characters = image.referenceCharacters || [];
  const fromWriting = image.promptSource === 'writing' || !!image.writingPrompt;
  const labels: Record<string, string> = { protocol: '图片接口', model: '图片模型', quality: '生成质量', systemInstruction: '图片模型系统提示词', temperature: 'Temperature', topP: 'Top P', topK: 'Top K', seed: '随机种子', maxOutputTokens: '最大输出 Token', thinkingLevel: '思考等级', includeThoughts: '返回思考内容', searchGrounding: 'Google 搜索', outputFormat: '输出格式', outputCompression: '压缩质量', background: '图片背景', inputFidelity: '参考图保真度', moderation: '内容审核', negativePrompt: '负面提示词', steps: '采样步数', guidanceScale: '提示词引导强度', promptUpsampling: '供应商增强提示词', disableSafetyChecker: '关闭供应商安全检查' };
  const showValue = (key: string, value: unknown) => typeof value === 'boolean' ? value ? '开启' : '关闭' : key === 'protocol' ? ({ 'openai-images': 'OpenAI Images', gemini: 'Gemini', 'together-images': 'Together' } as Record<string, string>)[String(value)] || String(value) : String(value);
  return <div className="image-generation-details form-stack">
    {fromWriting && <p className="hint">提示词由正文写作 AI 结合当时的写作上下文直接生成，没有再次调用提示词优化模型；程序只补充画风要求与实际参考图顺序。</p>}
    {image.selectedReferenceImageIds !== undefined && <p className="hint">{image.selectedReferenceImageIds.length ? `本次由作者指定 ${image.selectedReferenceImageIds.length} 张参考图，按选择顺序发送。` : image.referenceImageId ? '本次只使用待修改的原图，不添加其他参考图。' : '本次由作者选择不用参考图。'}</p>}
    <section><h3>{fromWriting ? '写作 AI 生成的生图提示词' : image.promptStatus === 'completed' ? 'AI 优化后的生图提示词' : image.promptStatus === 'pending' ? '生图提示词尚未完成' : '绘图提示词（历史记录）'}</h3>{image.promptStatus === 'pending' && !fromWriting ? <p className="hint">提示词优化完成后，会保存实际发送给图片模型的提示词与参数。</p> : image.prompt || image.writingPrompt ? <pre className="image-optimized-prompt" data-testid="optimized-image-prompt">{image.prompt || image.writingPrompt}</pre> : <p className="hint">此记录没有已完成的绘图提示词。</p>}{image.optimizedAt && <small>{image.promptSource === 'writing' ? '准备完成于' : '优化完成于'} {dateText(image.optimizedAt)}</small>}</section>{parameters && <section><h3>本次图片参数</h3><dl className="image-actual-parameters" data-testid="image-actual-parameters">{parameters.size && <><dt>图片尺寸</dt><dd>{parameters.size.replace('x', ' × ')}</dd></>}{parameters.aspectRatio && <><dt>画幅比例</dt><dd>{parameters.aspectRatio}</dd></>}{parameters.imageSize && <><dt>图片分辨率</dt><dd>{parameters.imageSize}</dd></>}{parameters.width && parameters.height && <><dt>宽 × 高</dt><dd>{parameters.width} × {parameters.height}</dd></>}{Object.entries(parameters).filter(([key, value]) => key in labels && value !== undefined && value !== '').map(([key, value]) => <div className="image-parameter-row" key={key}><dt>{labels[key]}</dt><dd>{showValue(key, value)}</dd></div>)}</dl></section>}<section className="image-character-references"><h3>本次人物参考</h3>{characters.length ? <ul>{characters.map(character => <li key={`${character.entityId}:${character.imageId}`}><span>{character.name}</span><small>已完成立绘</small></li>)}</ul> : <p className="hint">本次没有使用人物立绘参考图。</p>}{image.referenceImageId && <p className="hint">此次 AI 修改同时参考了原图。</p>}</section>{image.storyContext && <details className="image-story-context"><summary>本次参考上下文</summary><p className="hint">这是生成本次提示词时实际参考的剧情与资料。绘制范围仍以关联场景为准。</p><pre className="image-optimized-prompt" data-testid="image-story-context">{image.storyContext}</pre></details>}</div>;
}

function ImageUseControls({ image, busy, onAction }: { image: StoryImage; busy: boolean; onAction?: (image: StoryImage, action: ImageAction) => void }) {
  if (!onAction) return null;
  return <>{image.status === 'completed' && image.bindingStatus !== 'pending' && <button className="text-button" disabled={busy} onClick={() => onAction(image, image.active === false ? 'activate' : 'deactivate')}>{image.active === false ? <CheckCircle2 size={13} /> : <CircleSlash size={13} />}{image.active === false ? '启用图片' : '停用图片'}</button>}<button className="text-button danger-text" disabled={busy} onClick={() => onAction(image, 'delete')}><Trash2 size={13} />删除图片</button></>;
}

export function StoryImageCards({ images, author = false, busy = false, onGenerate, onAction, onChapter, onEntity, compact = false }: { images: StoryImage[]; author?: boolean; busy?: boolean; onGenerate?: (target: ImageTarget) => void; onAction?: (image: StoryImage, action: ImageAction) => void; onChapter?: (image: StoryImage) => void; onEntity?: (id: string) => void; compact?: boolean }) {
  const [opened, setOpened] = useState<{ id: string; detailsOpen: boolean } | null>(null);
  const listed = author ? images : images.filter(image => image.active !== false);
  const current = opened && listed.find(image => image.id === opened.id);
  useEffect(() => { if (opened && !images.some(image => image.id === opened.id)) setOpened(null); }, [opened?.id, images]);
  const viewerAction = (image: StoryImage, action: ImageAction) => { if (action === 'activate' || action === 'deactivate') setOpened(null); onAction?.(image, action); };
  return <><div className={`story-image-grid ${compact ? 'compact' : ''}`}>{listed.map(image => <article className={`story-image-card image-kind-${image.kind}`} key={image.id} data-image-id={image.id} data-image-active={image.active !== false}>
    <button className="story-image-preview" disabled={!image.url || image.status !== 'completed'} onClick={() => setOpened({ id: image.id, detailsOpen: false })} aria-label={`查看图片 ${image.title}`}>{image.status === 'completed' && image.url ? <CachedImage src={image.previewUrl || image.url} alt={image.title} loading="lazy" /> : <span><Images size={28} className={image.status === 'running' ? 'spin' : ''} /><small>{author && image.status === 'running' && image.promptStatus === 'pending' ? image.writingPrompt ? '正在准备图片与参考' : '正在优化绘图提示词' : statusNames[image.status]}</small></span>}</button>
    <div className="story-image-info"><div className="row between"><span>{imageKindNames[image.kind]}</span><span className={`status-pill ${image.status}`}>{statusNames[image.status]}</span></div><h4>{image.title}</h4>{image.bindingStatus === 'pending' && <p className="hint">与正文同时绘制，正文和资料保存后自动关联。</p>}{image.error && author && <p className="image-error" role="alert">{image.error}</p>}{image.status === 'paused' && author && <p className="hint">任务中断，重新绘制会发起新的生图请求。</p>}{author && image.status === 'completed' && <span className={`image-selection-pill ${image.active === false ? 'is-inactive' : 'is-active'}`}>{image.bindingStatus === 'pending' ? '待关联正文' : image.active === false ? '未启用 · 暂存' : '已启用'}</span>}<small>{dateText(image.createdAt)}{image.automatic ? ' · 自动绘制' : ''}{author && image.visibility === 'secret' ? ' · 含私密素材' : ''}</small>
      <div className="story-image-actions">
        {image.chapterId && onChapter && <button className="text-button" onClick={() => onChapter(image)}>关联剧情<ArrowUpRight size={12} /></button>}{image.entityId && onEntity && <button className="text-button" onClick={() => onEntity(image.entityId!)}>关联资料<ArrowUpRight size={12} /></button>}
        {author && <><button className="text-button" onClick={() => setOpened({ id: image.id, detailsOpen: true })}>生图详情<ArrowUpRight size={12} /></button><ImageUseControls image={image} busy={busy} onAction={onAction} />{image.status === 'completed' && image.bindingStatus !== 'pending' && onGenerate && <><button className="text-button" disabled={busy} onClick={() => onGenerate({ kind: image.kind, entityId: image.entityId, chapterId: image.chapterId, selection: image.selection, selectedReferenceImageIds: image.selectedReferenceImageIds })}><RefreshCw size={12} />重新绘制</button><button className="text-button" disabled={busy || image.active === false} onClick={() => onGenerate({ kind: image.kind, entityId: image.entityId, chapterId: image.chapterId, selection: image.selection, referenceImageId: image.id })}><WandSparkles size={12} />{image.active === false ? '启用后可修改' : 'AI 修改'}</button></>}{onAction && image.bindingStatus !== 'pending' && ['failed', 'paused', 'stale', 'cancelled'].includes(image.status) && <button className="text-button" disabled={busy} onClick={() => onAction(image, 'retry')}><RefreshCw size={12} />{image.status === 'paused' ? '恢复绘制' : '重试绘制'}</button>}{onAction && ['queued', 'running'].includes(image.status) && <button className="text-button" disabled={busy} onClick={() => onAction(image, 'cancel')}><X size={12} />取消绘制</button>}</>}
      </div>
    </div>
  </article>)}</div>{current && (author || current.url && current.status === 'completed') && <ImageViewer key={current.id} image={current} initialDetailsOpen={opened?.detailsOpen} detailsLabel={author ? '生图详情' : '关联剧情'} onClose={() => setOpened(null)}>{(author || current.chapterId && onChapter) && <>{author && <><div className="story-image-actions viewer-image-actions"><ImageUseControls image={current} busy={busy} onAction={onAction ? viewerAction : undefined} />{current.status === 'completed' && <span className={`image-selection-pill ${current.active === false ? 'is-inactive' : 'is-active'}`}>{current.bindingStatus === 'pending' ? '待关联正文' : current.active === false ? '未启用 · 暂存' : '已启用'}</span>}</div><ImageGenerationDetails image={current} /></>}{author && current.sourceText && <blockquote className="image-source-text">{current.sourceText}</blockquote>}{current.chapterId && onChapter && <button className="button secondary small" onClick={() => { setOpened(null); onChapter(current); }}>查看关联剧情<ArrowUpRight size={13} /></button>}</>}</ImageViewer>}</>;
}
export function ChapterImageCards({ images, entities, chapters, ...cardProps }: Parameters<typeof StoryImageCards>[0] & { entities: Entity[]; chapters: ChapterRef[] }) {
  const [openedId, setOpenedId] = useState<string | null>(null);
  const groups = useMemo(() => groupStoryImages(images, entities, chapters), [images, entities, chapters]);
  const current = groups.find(group => group.id === openedId);
  const enabled = groups.filter(group => group.cover.status === 'completed' && group.cover.url && group.cover.active !== false && group.cover.bindingStatus !== 'pending');
  useEffect(() => { if (openedId && !current) setOpenedId(null); }, [openedId, current]);
  return current ? <div className="chapter-image-versions" data-image-group={current.id}>
    <button className="text-button" onClick={() => setOpenedId(null)}><ArrowLeft size={15} />返回本章插画</button>
    <p className="hint">{current.title} · {current.images.length} 个版本，按绘制时间从新到旧排列。</p>
    <StoryImageCards {...cardProps} compact images={current.images} />
  </div> : enabled.length ? <div className="story-image-grid compact image-group-grid">{enabled.map(group => <ImageGroupCard key={group.id} group={group} onOpen={() => setOpenedId(group.id)} onChapter={cardProps.onChapter} onEntity={cardProps.onEntity} />)}</div>
    : <p className="hint">本章暂无启用的插画，可在故事图册中查看和启用其他版本。</p>;
}

export function ImageGallery({ images, entities, chapters, author, busy, onGenerate, onAction, onChapter, onEntity }: { images: StoryImage[]; entities: Entity[]; chapters: ChapterRef[]; author: boolean; busy: boolean; onGenerate: (target: ImageTarget) => void; onAction: (image: StoryImage, action: ImageAction) => void; onChapter: (image: StoryImage) => void; onEntity: (id: string) => void }) {
  const [filter, setFilter] = useState<StoryImageKind | 'all'>('all'); const [search, setSearch] = useState('');
  const [openedId, setOpenedId] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null); const heading = useRef<HTMLHeadingElement>(null);
  const overviewScroll = useRef(0); const previousGroup = useRef<string | null>(null);
  const groups = useMemo(() => groupStoryImages(author ? images : images.filter(image => image.active !== false), entities, chapters), [images, entities, chapters, author]);
  const current = groups.find(group => group.id === openedId);
  const filtered = groups.filter(group => (filter === 'all' || group.images.some(image => image.kind === filter)) && group.searchText.includes(search.trim().toLowerCase()));
  useEffect(() => { if (openedId && !current) setOpenedId(null); }, [openedId, current]);
  useLayoutEffect(() => {
    const id = current?.id ?? null; if (id === previousGroup.current) return;
    const container = panel.current?.closest('.workspace-main');
    if (container) container.scrollTop = id ? 0 : overviewScroll.current;
    if (id) heading.current?.focus({ preventScroll: true });
    else [...(panel.current?.querySelectorAll<HTMLButtonElement>('[data-open-image-group]') ?? [])].find(button => button.dataset.openImageGroup === previousGroup.current)?.focus({ preventScroll: true });
    previousGroup.current = id;
  }, [current?.id]);
  const open = (group: StoryImageGroup) => { overviewScroll.current = panel.current?.closest('.workspace-main')?.scrollTop ?? 0; setOpenedId(group.id); };
  return <section ref={panel} className="data-panel image-gallery">
    {current && <button className="text-button image-gallery-back" onClick={() => setOpenedId(null)}><ArrowLeft size={15} />返回图册</button>}
    <div className="panel-heading"><div><span className="eyebrow">{current ? 'IMAGE VERSIONS' : 'STORY GALLERY'}</span><h2 ref={heading} tabIndex={-1}>{current?.title ?? '故事图册'}</h2><p>{current ? `${current.images.length} 个版本，按绘制时间从新到旧排列。` : '按人物、剧情场景和资料归组，点击封面查看不同版本。'}</p></div></div>
    {current ? <div className="image-group-versions" data-image-group={current.id}>
      {current.excerpt && <blockquote className="image-source-text">{current.excerpt}</blockquote>}
      <StoryImageCards key={current.id} images={current.images} author={author} busy={busy} onGenerate={onGenerate} onAction={onAction} onChapter={onChapter} onEntity={onEntity} />
    </div> : <>
      <div className="world-tools"><div className="filter-chips"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>全部 {groups.length}</button>{Object.entries(imageKindNames).map(([kind, name]) => <button key={kind} className={filter === kind ? 'active' : ''} onClick={() => setFilter(kind as StoryImageKind)}>{name} {groups.filter(group => group.images.some(image => image.kind === kind)).length}</button>)}</div><label className="search-input"><input aria-label="查找故事图片" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索图片、人物或章节…" /></label></div>
      <p className="hint image-gallery-count">{filtered.length} 组 · {filtered.reduce((count, group) => count + group.images.length, 0)} 个版本</p>
      {filtered.length ? <div className="story-image-grid image-group-grid">{filtered.map(group => <ImageGroupCard key={group.id} group={group} onOpen={() => open(group)} onChapter={onChapter} onEntity={onEntity} />)}</div> : <Empty icon={<Images size={30} />} title={groups.length ? '没有匹配的图片' : '故事图册尚未展开'}>{groups.length ? '切换分类，或用人物、章节名称查找。' : author ? '在正文生成剧情 CG，或在世界资料里为人物与其他资料绘制图片。' : '图片完成并公开后，会显示在这里。'}</Empty>}
    </>}
  </section>;
}

function ImageGroupCard({ group, onOpen, onChapter, onEntity }: { group: StoryImageGroup; onOpen: () => void; onChapter?: (image: StoryImage) => void; onEntity?: (id: string) => void }) {
  const cover = group.cover;
  const pending = group.images.filter(image => ['queued', 'running'].includes(image.status)).length;
  const needsAttention = group.images.filter(image => ['failed', 'paused', 'stale'].includes(image.status)).length;
  const active = group.images.some(image => image.status === 'completed' && image.active !== false);
  return <article className={`story-image-card image-group-card image-kind-${group.kind}`} data-image-group={group.id} data-cover-image-id={cover.id}>
    <button className="story-image-preview" data-open-image-group={group.id} onClick={onOpen} aria-label={`打开图片组 ${group.title}`}>
      {cover.status === 'completed' && cover.url ? <CachedImage src={cover.previewUrl || cover.url} alt={group.title} loading="lazy" /> : <span><Images size={28} /><small>{statusNames[cover.status]}</small></span>}
      <span className="image-group-badge"><Layers size={13} />{group.images.length} 个版本</span>
    </button>
    <div className="story-image-info"><div className="row between"><span>{imageKindNames[group.kind]}</span><span className={`image-selection-pill ${active ? 'is-active' : 'is-inactive'}`}>{active ? '已启用' : '暂无启用图片'}</span></div><h4>{group.title}</h4>
      {group.excerpt && <p className="image-group-excerpt">{group.excerpt}</p>}
      {(pending > 0 || needsAttention > 0) && <div className="image-group-status" role="status">{pending > 0 && <span className="status-pill running">{pending} 项绘制中</span>}{needsAttention > 0 && <span className="status-pill failed">{needsAttention} 项待处理</span>}</div>}
      <div className="story-image-actions"><button className="text-button" onClick={onOpen}>查看 {group.images.length} 个版本<ArrowUpRight size={12} /></button>{cover.entityId && onEntity && <button className="text-button" onClick={() => onEntity(cover.entityId!)}>关联资料<ArrowUpRight size={12} /></button>}{cover.chapterId && onChapter && <button className="text-button" onClick={() => onChapter(cover)}>关联剧情<ArrowUpRight size={12} /></button>}</div>
    </div>
  </article>;
}
