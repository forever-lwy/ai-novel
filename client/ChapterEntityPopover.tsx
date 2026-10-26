import { useMemo, useState } from 'react';
import type { Entity, Relation, StoryImage } from '../shared/types';
import { kindNames } from './api';
import { CachedImage } from './CachedImage';
import { ImageViewer } from './ImageViewer';
import { Modal } from './ui';
import { EntityFacts, EntityRelations } from './WorldPanel';

export function ChapterEntityPopover({ entity, entities, relations, images, chapterTitle, onClose }: {
  entity: Entity;
  entities: Entity[];
  relations: Relation[];
  images: StoryImage[];
  chapterTitle: string;
  onClose: () => void;
}) {
  const [openedImageId, setOpenedImageId] = useState<string | null>(null);
  const entityImages = useMemo(() => images.filter(image => image.entityId === entity.id && image.active !== false && image.bindingStatus !== 'pending' && image.status === 'completed' && image.url).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [images, entity.id]);
  const openedImage = entityImages.find(image => image.id === openedImageId);
  return <>
    <Modal title={`章节资料 · ${entity.name}`} onClose={onClose}>
      <div className="entity-detail chapter-entity-popover" data-testid="chapter-entity-popover" data-entity-id={entity.id}>
        <p className="hint chapter-material-boundary">截至《{chapterTitle}》的资料</p>
        <div className="row"><span className={`entity-type type-${entity.kind}`}>{kindNames[entity.kind]}{entity.kind === 'character' && entity.isMain ? ' · 主要角色' : ''}</span></div>
        {entity.aliases.length > 0 && <div className="alias-list">{entity.aliases.map(alias => <span key={alias}>{alias}</span>)}</div>}
        <p className="entity-description">{entity.description || '暂无描述'}</p>
        <div className="entity-images">
          <h3>{entity.kind === 'character' ? '人物立绘' : '资料图片'}</h3>
          {entityImages.length ? <div className="chapter-entity-images">{entityImages.map(image => <button key={image.id} type="button" className="chapter-entity-image-button" aria-label={`查看资料图片 ${image.title}`} onClick={() => setOpenedImageId(image.id)}>
            <CachedImage src={image.previewUrl || image.url} alt={image.title} loading="lazy" />
            <span>{image.title}</span>
          </button>)}</div> : <p className="hint">截至本章还没有已启用的图片。</p>}
        </div>
        <EntityFacts facts={entity.facts} />
        <EntityRelations entity={entity} entities={entities} relations={relations} />
      </div>
    </Modal>
    {openedImage && <ImageViewer key={openedImage.id} image={openedImage} onClose={() => setOpenedImageId(null)} />}
  </>;
}
