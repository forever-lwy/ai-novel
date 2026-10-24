import type { StoryImage } from './types.js';

/** The same object or CG range shares one active image and one gallery group. */
export function imageGroupKey(image: StoryImage, entityId = image.entityId): string {
  if (image.bindingStatus === 'pending') return `writing:${image.writingJobId}:${image.kind}:${image.kind === 'portrait' ? image.pendingEntityName : image.id}`;
  if (image.kind === 'portrait' || image.kind === 'entity') return `entity:${entityId || image.id}`;
  if (image.kind === 'map') return 'map';
  if (image.sourceSelection && !image.selection) return `cg:${image.chapterId}:source:${image.sourceChapterId}:${image.sourceSelection.start}:${image.sourceSelection.end}`;
  return `cg:${image.chapterId}:${image.selection ? `${image.selection.start}:${image.selection.end}` : 'full'}`;
}
