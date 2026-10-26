import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import type { ChapterMaterials, StoryImage } from '../shared/types';
import { api } from './api';
import { ChapterEntityPopover } from './ChapterEntityPopover';
import { ImageViewer } from './ImageViewer';
import { WritingTimeline } from './WritingTimeline';
import { Notice } from './ui';

type Props = Omit<ComponentProps<typeof WritingTimeline>, 'entities' | 'images' | 'onOpenEntity' | 'onOpenCG'> & {
  branchId: string; chapterId: string; chapterTitle: string; revisionId: string; cacheVersion?: string; images: StoryImage[]; active: boolean; onRefresh: () => Promise<unknown>;
};

/** Reading annotations use chapter-end materials while the workbench keeps its complete archive. */
export function ChapterReader({ branchId, chapterId, chapterTitle, revisionId, cacheVersion, images, active, onRefresh, ...timeline }: Props) {
  const readingScope = JSON.stringify([branchId, chapterId, revisionId]);
  const imageVersion = useMemo(() => images.map(image => [image.id, image.updatedAt, image.status, image.bindingStatus, image.active, image.chapterId, image.entityId, image.url, image.previewUrl].join(':')).join('|'), [images]);
  const scope = JSON.stringify([readingScope, cacheVersion, imageVersion]);
  const currentScope = useRef(scope); currentScope.current = active ? scope : '';
  const [materials, setMaterials] = useState<{ scope: string; readingScope: string; data?: ChapterMaterials; error?: string }>();
  const loadedMaterials = useRef<{ scope: string; readingScope: string; data: ChapterMaterials } | undefined>(undefined);
  const [retry, setRetry] = useState(0);
  const [entitySelection, setEntitySelection] = useState<{ scope: string; id: string }>();
  const [cgSelection, setCGSelection] = useState<{ scope: string; id: string }>();
  const openEntity = useCallback((id: string) => setEntitySelection({ scope: readingScope, id }), [readingScope]);
  const openCG = useCallback((image: StoryImage) => setCGSelection({ scope: readingScope, id: image.id }), [readingScope]);
  const chapterImages = useMemo(() => images.filter(image => image.kind === 'cg' && image.chapterId === chapterId && image.active !== false && image.status === 'completed' && image.url && image.bindingStatus !== 'pending'), [images, chapterId]);

  useEffect(() => {
    if (!active || !branchId || !chapterId || !revisionId) return;
    if (loadedMaterials.current?.scope === scope) { setMaterials(loadedMaterials.current); return; }
    let alive = true; const controller = new AbortController();
    setMaterials(previous => previous?.readingScope === readingScope ? { ...previous, scope, error: undefined } : { scope, readingScope });
    void api<ChapterMaterials>(`/branches/${branchId}/chapters/${chapterId}/materials`, { signal: controller.signal }).then(data => {
      if (!alive) return;
      if (data.branchId !== branchId || data.chapterId !== chapterId || data.revisionId !== revisionId) {
        setMaterials({ scope, readingScope, error: '章节资料版本已变化，请重新加载。' }); return;
      }
      loadedMaterials.current = { scope, readingScope, data }; setMaterials(loadedMaterials.current);
    }).catch(error => { if (alive && !controller.signal.aborted) setMaterials(previous => ({ scope, readingScope, data: previous?.readingScope === readingScope ? previous.data : undefined, error: `本章资料加载失败：${(error as Error).message}` })); });
    return () => { alive = false; controller.abort(); };
  }, [active, branchId, chapterId, revisionId, readingScope, scope, retry]);

  const data = materials?.readingScope === readingScope ? materials.data : undefined;
  const entity = entitySelection?.scope === readingScope ? data?.entities.find(entity => entity.id === entitySelection.id) : undefined;
  const cg = cgSelection?.scope === readingScope ? chapterImages.find(image => image.id === cgSelection.id) : undefined;
  async function reloadMaterials() {
    try { await onRefresh(); if (currentScope.current === scope) setRetry(value => value + 1); }
    catch (error) { if (currentScope.current === scope) setMaterials(previous => ({ ...previous, scope, readingScope, error: (error as Error).message })); }
  }
  return <>
    <WritingTimeline {...timeline} images={chapterImages} entities={data?.entities} onOpenEntity={openEntity} onOpenCG={openCG} />
    {active && materials?.scope === scope && materials.error && <div className="chapter-material-error"><Notice error={materials.error} /><button className="text-button" onClick={() => void reloadMaterials()}>重新加载本章资料</button></div>}
    {active && entity && data && <ChapterEntityPopover entity={entity} entities={data.entities} relations={data.relations} images={data.images} chapterTitle={chapterTitle} onClose={() => setEntitySelection(undefined)} />}
    {active && cg && <ImageViewer key={cg.id} image={cg} onClose={() => setCGSelection(undefined)} />}
  </>;
}
