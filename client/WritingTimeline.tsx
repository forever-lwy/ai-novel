import { memo, useMemo, type MouseEventHandler, type KeyboardEventHandler } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { Entity, JobStatus, StoryImage, WritingActivity } from '../shared/types';
import { WritingActivityPanel } from './WritingActivityPanel';
import { proseFragments, proseParagraphs, writingTimeline } from './writing-timeline';
import { proseCGParagraphs, proseEntityFragments, proseEntityMentions } from './prose-annotations';

const noEntities: Entity[] = []; const noImages: StoryImage[] = [];

export const WritingTimeline = memo(function WritingTimeline({ text, activities = [], originalProcess = false, loading, error, status, streaming = false, awaitingChoice = false, highlight, onClearHighlight, onMouseUp, onKeyUp, entities = noEntities, images = noImages, onOpenEntity, onOpenCG }: { text: string; activities?: WritingActivity[]; originalProcess?: boolean; loading?: boolean; error?: string; status: JobStatus; streaming?: boolean; awaitingChoice?: boolean; highlight?: number | null; onClearHighlight?: () => void; onMouseUp?: MouseEventHandler<HTMLDivElement>; onKeyUp?: KeyboardEventHandler<HTMLDivElement>; entities?: Entity[]; images?: StoryImage[]; onOpenEntity?: (entityId: string) => void; onOpenCG?: (image: StoryImage) => void }) {
  const paragraphs = useMemo(() => proseParagraphs(text), [text]); const parts = useMemo(() => writingTimeline(text, originalProcess ? [] : activities), [text, activities, originalProcess]); const hasProcess = !!activities.length || !!loading || !!error;
  const mentions = useMemo(() => onOpenEntity ? proseEntityMentions(text, entities) : [], [text, entities, onOpenEntity]);
  const names = useMemo(() => new Map(entities.map(entity => [entity.id, entity.name])), [entities]);
  const paragraphImages = useMemo(() => onOpenCG ? proseCGParagraphs(text, images, paragraphs) : new Map<number, StoryImage[]>(), [text, images, paragraphs, onOpenCG]);
  const renderText = (start: number, end: number) => proseFragments(text, start, end, paragraphs).map(fragment => <p key={`${fragment.index}:${fragment.start}`} id={!fragment.continued ? `paragraph-${fragment.index + 1}` : undefined} data-prose-start={fragment.start} data-prose-end={fragment.end} className={`${highlight === fragment.index + 1 ? 'highlighted-paragraph ' : ''}${fragment.continued ? 'prose-continuation ' : ''}${fragment.interrupted ? 'prose-interrupted' : ''}`.trim() || undefined} onClick={highlight === fragment.index + 1 ? onClearHighlight : undefined}>{mentions.length ? proseEntityFragments(text, fragment.start, fragment.end, mentions).map(part => part.entityId ? <button key={part.start} type="button" className="prose-entity-link" data-prose-control="entity" data-entity-id={part.entityId} aria-label={`查看 ${names.get(part.entityId) || part.text} 的资料`} onClick={event => { if (event.detail && window.getSelection()?.isCollapsed === false) return; onOpenEntity?.(part.entityId!); }}>{part.text}</button> : part.text) : fragment.text}{!fragment.interrupted && paragraphImages.get(fragment.index)?.map(image => <button key={image.id} type="button" className="prose-cg-button" data-prose-control="cg" data-cg-image-id={image.id} aria-label={`查看 ${image.title} 的 CG`} title={`查看 ${image.title} 的 CG`} onClick={() => onOpenCG?.(image)}><ImageIcon size={14} aria-hidden="true" /></button>)}</p>);
  const className = `${hasProcess ? 'writing-timeline' : 'prose'}${streaming ? ' streaming-prose' : ''}${awaitingChoice ? ' awaiting-choice' : ''}`;
  return <div className={className} data-prose-length={text.length} onMouseUp={onMouseUp} onKeyUp={onKeyUp} {...(streaming ? { 'aria-live': 'polite' as const, 'aria-busy': ['queued', 'running'].includes(status) } : {})}>
    {!hasProcess ? text ? renderText(0, text.length) : streaming && <p className="streaming-placeholder">正在准备这一章，文字会逐步出现在这里…</p> : <>
      {originalProcess && <WritingActivityPanel activities={activities} loading={loading} error={error} status={status} originalProcess />}
      {!originalProcess && (loading || error) && <WritingActivityPanel activities={[]} loading={loading} error={error} status={status} inline />}
      {parts.map(part => part.kind === 'activities' ? <WritingActivityPanel key={`activities:${part.legacy ? 'legacy' : part.start}`} activities={part.activities} status={status} inline legacy={part.legacy} proseOffset={part.legacy ? undefined : part.start} /> : <div className="prose" key={`text:${part.start}`} data-prose-range={`${part.start}:${part.end}`}>{text ? renderText(part.start, part.end) : streaming && <p className="streaming-placeholder">正在准备这一章，文字会逐步出现在这里…</p>}</div>)}
    </>}
  </div>;
});
