import type { Entity, StoryState } from '../shared/types.js';
import { normalizeProfileAttribute, rebuildCharacterProfileDescription } from './extraction.js';

/** The same public facts supply reader cards and public illustration prompts. */
export function readerEntityMaterial(entity: Entity, chapters: StoryState['chapters']): Entity | undefined {
  const included = new Set(chapters.map(chapter => chapter.id));
  const facts = entity.facts.filter(fact => fact.visibility === 'public' && fact.temporal !== 'future' && (!fact.citation || included.has(fact.citation.chapterId))).sort((a, b) => Number(b.temporal === 'current') - Number(a.temporal === 'current'));
  if (entity.visibility !== 'public' || entity.mergedInto || !entity.locked && !facts.length) return undefined;
  const profile = facts.filter(fact => fact.temporal !== 'past' || fact.attribute && normalizeProfileAttribute(fact.attribute) === 'major_event');
  const description = entity.facts.length ? rebuildCharacterProfileDescription({ ...entity, locked: false, facts, description: (profile.length ? profile : facts).map(fact => fact.text).join('；') }) : entity.locked ? entity.description : '';
  return { ...entity, description, facts };
}
