import type { Entity, ExtractionResult, ModelOutputRecord, StoryState, Visibility } from '../shared/types.js';
import { extractionSchema, inferredEntityVisibility } from './extraction.js';
import { findEntitiesByName } from './entity-resolution.js';

const factKey = (text: string, attribute: string | undefined, chapterId: string, paragraph: number, quote: string) => JSON.stringify([text, attribute ?? '', chapterId, paragraph, quote]);

/** Recover documented defaults and evidenced public appearances without rewriting saved records. */
export function repairLegacyExtractionVisibility(state: StoryState, outputs: ModelOutputRecord[], authorSecrets: Set<string>, options: { cumulativePublic?: boolean; authorEdits?: Set<string>; authorSecretFacts?: Set<string> } = {}): StoryState {
  const { cumulativePublic = false, authorEdits = new Set<string>(), authorSecretFacts = new Set<string>() } = options;
  const facts = new Map<string, { entity: Entity; fact: Entity['facts'][number] }[]>();
  for (const entity of state.entities) for (const fact of entity.facts) if (fact.citation) {
    const key = factKey(fact.text, fact.attribute, fact.citation.chapterId, fact.citation.paragraph, fact.citation.quote);
    const values = facts.get(key) ?? []; values.push({ entity, fact }); facts.set(key, values);
  }
  const affected = new Set<string>(); const legacyAffected = new Set<string>(); const policy = new Map<string, Visibility>();
  const publicNames = new Map<string, Set<string>>(); const secretNames = new Map<string, Set<string>>();
  const publicRelations: { chapterId: string; relation: ExtractionResult['relations'][number] }[] = [];
  for (const output of outputs) {
    if (!output.chapterId || !output.normalizedText) continue;
    let value: unknown; try { value = JSON.parse(output.normalizedText); } catch { continue; }
    const parsed = extractionSchema.safeParse(value); if (!parsed.success) continue;
    const defaults = new Set(output.adjustments?.filter(change => change.message === '省略字段已补为 "secret"').map(change => change.path));
    parsed.data.entities.forEach((source, index) => {
      const omitted = defaults.has(`entities[${index}].visibility`) && source.visibility === 'secret';
      const named = findEntitiesByName(state, source.name, source.kind); if (named.length !== 1) return;
      const matches = source.facts.flatMap(fact => facts.get(factKey(fact.text, fact.attribute, output.chapterId!, fact.paragraph, fact.quote)) ?? []).filter(match => match.entity.id === named[0].id);
      const owners = new Set(matches.map(match => match.entity.id));
      for (const entityId of owners) {
        const entity = state.entities.find(entity => entity.id === entityId)!;
        if (entity.locked || authorSecrets.has(entityId)) continue;
        // A secret-only update with no entity flag cannot erase an earlier public appearance.
        const publicEvidence = source.facts.some(original => original.visibility === 'public' && original.temporal !== 'future' && (facts.get(factKey(original.text, original.attribute, output.chapterId!, original.paragraph, original.quote)) ?? []).some(match => match.entity.id === entityId && match.fact.visibility === 'public' && match.fact.temporal !== 'future'));
        const visibility = omitted ? inferredEntityVisibility(source.facts) === 'public' || policy.get(entityId) === 'public' ? 'public' : 'secret' : source.visibility;
        if (cumulativePublic) {
          const names = (omitted ? inferredEntityVisibility(source.facts) : source.visibility) === 'public' && (omitted || publicEvidence) ? publicNames : secretNames;
          const known = names.get(entityId) ?? new Set<string>(); for (const name of [source.name, ...source.aliases]) known.add(name); names.set(entityId, known);
          if (visibility === 'public' && publicEvidence) { affected.add(entityId); policy.set(entityId, 'public'); }
          // A later secret update cannot retract facts and appearances already disclosed.
          if (policy.get(entityId) === 'public' && (!omitted || visibility !== 'public')) continue;
        }
        policy.set(entityId, visibility);
        if (!omitted || visibility !== 'public') continue;
        affected.add(entityId);
        legacyAffected.add(entityId);
        for (const original of source.facts.filter(fact => fact.visibility === 'public')) {
          for (const match of facts.get(factKey(original.text, original.attribute, output.chapterId!, original.paragraph, original.quote)) ?? []) {
            if (match.entity.id === entityId && !match.fact.locked && !authorSecretFacts.has(match.fact.id)) match.fact.visibility = 'public';
          }
        }
      }
    });
    for (const relation of parsed.data.relations) if (relation.visibility === 'public') publicRelations.push({ chapterId: output.chapterId, relation });
  }
  for (const entity of state.entities) if (affected.has(entity.id)) entity.visibility = policy.get(entity.id)!;
  if (cumulativePublic) for (const entity of state.entities) {
    if (entity.locked || authorEdits.has(entity.id) || entity.visibility !== 'public') continue;
    const disclosed = publicNames.get(entity.id); const hidden = secretNames.get(entity.id);
    if (!disclosed || !hidden) continue;
    entity.aliases = entity.aliases.filter(name => !hidden.has(name) || disclosed.has(name));
    if (hidden.has(entity.name) && !disclosed.has(entity.name)) entity.name = [...disclosed][0];
  }
  for (const { chapterId, relation } of publicRelations) {
    const from = findEntitiesByName(state, relation.from); const to = findEntitiesByName(state, relation.to);
    if (from.length !== 1 || to.length !== 1 || !legacyAffected.has(from[0].id) && !legacyAffected.has(to[0].id) || from[0].visibility !== 'public' || to[0].visibility !== 'public' || authorSecrets.has(from[0].id) || authorSecrets.has(to[0].id)) continue;
    for (const saved of state.relations) if (saved.fromId === from[0].id && saved.toId === to[0].id && saved.label === relation.label && saved.citation?.chapterId === chapterId && saved.citation.paragraph === relation.paragraph && saved.citation.quote === relation.quote) saved.visibility = 'public';
  }
  return state;
}
