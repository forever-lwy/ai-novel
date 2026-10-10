import type { StoryState } from '../shared/types.js';
import { rebuildCharacterProfileDescription } from './extraction.js';

/** Remove references from this snapshot only; immutable text, images and old versions stay intact. */
export function removeEntities(state: StoryState, entityIds: Set<string>, imageEntityId: (id: string) => string | undefined) {
  for (;;) {
    const aliases = state.entities.filter(entity => entity.mergedInto && entityIds.has(entity.mergedInto) && !entityIds.has(entity.id));
    if (!aliases.length) break;
    for (const entity of aliases) entityIds.add(entity.id);
  }
  state.entities = state.entities.filter(entity => !entityIds.has(entity.id));
  state.relations = state.relations.filter(relation => !entityIds.has(relation.fromId) && !entityIds.has(relation.toId));
  for (const clue of state.foreshadows) clue.relatedEntityIds = clue.relatedEntityIds.filter(id => !entityIds.has(id));
  state.imageIds = state.imageIds?.filter(id => !entityIds.has(imageEntityId(id) ?? ''));
  state.activeImageIds = state.activeImageIds?.filter(id => state.imageIds?.includes(id));
  if (state.rpg?.character.entityId && entityIds.has(state.rpg.character.entityId)) {
    // The player's authored role survives deletion of an archive entry.
    state.rpg.character.kind = 'original'; delete state.rpg.character.entityId;
  }
}

/** Undo this chapter's discoveries while retaining later evidence and deliberate author locks. */
export function clearChapterMaterials(state: StoryState, chapterId: string, before: StoryState, after: StoryState, deleting: boolean, imageEntityId: (id: string) => string | undefined) {
  const removed = new Set<string>();
  const chapterIndex = state.chapters.findIndex(chapter => chapter.id === chapterId);
  for (const entity of state.entities) {
    const prior = before.entities.find(item => item.id === entity.id);
    const discovered = after.entities.find(item => item.id === entity.id);
    const hasEvidence = entity.facts.some(fact => fact.citation?.chapterId === chapterId);
    entity.facts = entity.facts.filter(fact => fact.citation?.chapterId !== chapterId || fact.locked).map(fact => {
      if (deleting && fact.citation?.chapterId === chapterId) return { ...fact, citation: undefined };
      const old = prior?.facts.find(item => item.id === fact.id);
      return old && !fact.locked && fact.temporal === 'past' && old.temporal === 'current' ? { ...fact, temporal: 'current' as const } : fact;
    });
    if (!entity.locked && discovered) {
      const introducedAliases = discovered.aliases.filter(alias => !prior?.aliases.includes(alias));
      entity.aliases = entity.aliases.filter(alias => !introducedAliases.includes(alias));
      const laterEvidence = entity.facts.some(fact => state.chapters.findIndex(chapter => chapter.id === fact.citation?.chapterId) > chapterIndex);
      if (!laterEvidence) {
        for (const field of ['name', 'nameStatus', 'description', 'visibility', 'mergedInto'] as const) {
          if (entity[field] === discovered[field] && prior) Object.assign(entity, { [field]: prior[field] });
        }
        if (entity.isMainSource !== 'author' && entity.isMain === discovered.isMain) {
          entity.isMain = prior?.isMain; entity.isMainSource = prior?.isMainSource;
        }
        if (!prior && hasEvidence) entity.description = '';
      }
      if (!prior && !entity.facts.length && !entity.mergedInto && entity.isMainSource !== 'author') removed.add(entity.id);
    }
    entity.description = rebuildCharacterProfileDescription(entity);
  }
  state.relations = state.relations.filter(relation => relation.citation?.chapterId !== chapterId);
  state.foreshadows = state.foreshadows.flatMap(clue => {
    const prior = before.foreshadows.find(item => item.id === clue.id);
    const discovered = after.foreshadows.find(item => item.id === clue.id);
    if (discovered && JSON.stringify(discovered) !== JSON.stringify(prior) && JSON.stringify(clue) === JSON.stringify(discovered)) return prior ? [structuredClone(prior)] : [];
    if (clue.plantedChapterId === chapterId) delete clue.plantedChapterId;
    if (clue.resolvedChapterId === chapterId) { delete clue.resolvedChapterId; clue.status = prior?.status ?? 'planned'; }
    return [clue];
  });
  removeEntities(state, removed, imageEntityId);
  const chapter = state.chapters.find(item => item.id === chapterId);
  if (chapter) { chapter.summary = ''; chapter.status = 'pending'; }
  // An old compressed summary includes the removed evidence and must no longer guide writing.
  if (state.outline.summaryCompression?.chapterIds.includes(chapterId)) delete state.outline.summaryCompression;
}
