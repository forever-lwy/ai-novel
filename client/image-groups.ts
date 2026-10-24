import type { ChapterRef, Entity, StoryImage, StoryImageKind } from '../shared/types';
import { imageGroupKey } from '../shared/image-groups';

export interface StoryImageGroup {
  id: string;
  kind: StoryImageKind;
  title: string;
  excerpt?: string;
  images: StoryImage[];
  cover: StoryImage;
  searchText: string;
}

export function groupStoryImages(images: StoryImage[], entities: Entity[], chapters: ChapterRef[]): StoryImageGroup[] {
  const entitiesById = new Map(entities.map(entity => [entity.id, entity]));
  const chaptersById = new Map(chapters.map(chapter => [chapter.id, chapter]));
  const groups = new Map<string, StoryImage[]>();
  // Sort a copy: the workspace shares its image list with other views and caches.
  for (const image of [...images].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const id = imageGroupKey(image);
    const group = groups.get(id);
    if (group) group.push(image); else groups.set(id, [image]);
  }
  return [...groups].map(([id, versions]) => {
    const complete = versions.filter(image => image.status === 'completed' && image.url);
    const cover = complete.find(image => image.active !== false) ?? complete[0] ?? versions[0];
    const entity = cover.entityId ? entitiesById.get(cover.entityId) : undefined;
    const chapter = cover.chapterId ? chaptersById.get(cover.chapterId) : undefined;
    const kind = versions.some(image => image.kind === 'portrait') ? 'portrait' : cover.kind;
    const title = cover.bindingStatus === 'pending' ? cover.title : kind === 'map' ? '世界地图' : kind === 'cg'
      ? `${chapter?.title || cover.title.replace(/ · CG$/, '')} · ${cover.selection || cover.sourceSelection ? '选段 CG' : '整章 CG'}`
      : entity ? `${entity.name} · ${kind === 'portrait' ? '立绘' : '资料图'}` : cover.title;
    const excerpt = kind === 'cg' ? cover.sourceText?.replace(/\s+/g, ' ').trim().slice(0, 100) : undefined;
    const searchText = [title, ...versions.flatMap(image => [image.title, chaptersById.get(image.chapterId ?? '')?.title ?? '']), entity?.name, ...(entity?.aliases ?? [])].join(' ').toLowerCase();
    return { id, kind, title, excerpt, images: versions, cover, searchText };
  });
}
