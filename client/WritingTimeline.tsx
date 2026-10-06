import type { MouseEventHandler, KeyboardEventHandler } from 'react';
import type { JobStatus, WritingActivity } from '../shared/types';
import { WritingActivityPanel } from './WritingActivityPanel';
import { proseFragments, proseParagraphs, writingTimeline } from './writing-timeline';

export function WritingTimeline({ text, activities = [], loading, error, status, streaming = false, awaitingChoice = false, highlight, onMouseUp, onKeyUp }: { text: string; activities?: WritingActivity[]; loading?: boolean; error?: string; status: JobStatus; streaming?: boolean; awaitingChoice?: boolean; highlight?: number | null; onMouseUp?: MouseEventHandler<HTMLDivElement>; onKeyUp?: KeyboardEventHandler<HTMLDivElement> }) {
  const paragraphs = proseParagraphs(text); const parts = writingTimeline(text, activities); const hasProcess = !!activities.length || !!loading || !!error;
  const renderText = (start: number, end: number) => proseFragments(text, start, end, paragraphs).map(fragment => <p key={`${fragment.index}:${fragment.start}`} id={!fragment.continued ? `paragraph-${fragment.index + 1}` : undefined} data-prose-start={fragment.start} data-prose-end={fragment.end} className={`${highlight === fragment.index + 1 ? 'highlighted-paragraph ' : ''}${fragment.continued ? 'prose-continuation ' : ''}${fragment.interrupted ? 'prose-interrupted' : ''}`.trim() || undefined}>{fragment.text}</p>);
  const className = `${hasProcess ? 'writing-timeline' : 'prose'}${streaming ? ' streaming-prose' : ''}${awaitingChoice ? ' awaiting-choice' : ''}`;
  return <div className={className} data-prose-length={text.length} onMouseUp={onMouseUp} onKeyUp={onKeyUp} {...(streaming ? { 'aria-live': 'polite' as const, 'aria-busy': ['queued', 'running'].includes(status) } : {})}>
    {!hasProcess ? text ? renderText(0, text.length) : streaming && <p className="streaming-placeholder">正在准备这一章，文字会逐步出现在这里…</p> : <>
      {(loading || error) && <WritingActivityPanel activities={[]} loading={loading} error={error} status={status} inline />}
      {parts.map(part => part.kind === 'activities' ? <WritingActivityPanel key={`activities:${part.legacy ? 'legacy' : part.start}`} activities={part.activities} status={status} inline legacy={part.legacy} proseOffset={part.legacy ? undefined : part.start} /> : <div className="prose" key={`text:${part.start}`} data-prose-range={`${part.start}:${part.end}`}>{text ? renderText(part.start, part.end) : streaming && <p className="streaming-placeholder">正在准备这一章，文字会逐步出现在这里…</p>}</div>)}
    </>}
  </div>;
}
