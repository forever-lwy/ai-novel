import type { Entity, ExtractionResult, KnowledgeKind, OutputIssue, StoryState } from '../shared/types.js';

type ExtractedEntity = ExtractionResult['entities'][number];
export const normalizeEntityName = (name: string) => name.normalize('NFKC').trim().toLocaleLowerCase();
const namesOf = (entity: Pick<Entity, 'name' | 'aliases'>) => [...new Map([entity.name, ...entity.aliases].filter(name => name.trim()).map(name => [normalizeEntityName(name), name.trim()])).values()];
const key = (kind: KnowledgeKind, name: string) => `${kind}:${normalizeEntityName(name)}`;
const descriptiveCharacterName = (name: string) => /(?:少女|少年|旅人|陌生人|男人|女人|男子|女子|青年|老人|老者|男孩|女孩|小孩|士兵|侍卫|骑士|法师|巫师|商人|学者|店主|队长|船长|战士)$/.test(name.trim());
const placeholderName = (entity: Pick<Entity, 'name' | 'nameStatus'>) => entity.nameStatus === 'placeholder' || entity.nameStatus === undefined && descriptiveCharacterName(entity.name);
const confirmedName = (entity: ExtractedEntity) => entity.nameStatus === 'confirmed' || entity.nameStatus === undefined && !descriptiveCharacterName(entity.name);

export interface EntityNameBinding { name: string; kind: KnowledgeKind; entityId: string }
export interface EntityReconciliation {
  entities: ExtractedEntity[];
  /** The caller should reject the entire extraction if an identity cannot be resolved safely. */
  issues: OutputIssue[];
  redirects: Map<string, string>;
  /** Allows this batch's relations to use new names without changing a locked record's aliases. */
  nameBindings: EntityNameBinding[];
}

function activeTarget(entity: Entity, byId: Map<string, Entity>): Entity | undefined {
  let target: Entity | undefined = entity; const seen = new Set<string>();
  while (target?.mergedInto && !seen.has(target.id)) { seen.add(target.id); target = byId.get(target.mergedInto); }
  return target && !target.mergedInto && target.kind === entity.kind ? target : undefined;
}

/** Resolve retained merge records as well as active names, without guessing from descriptions. */
export function findEntitiesByName(state: StoryState, name: string, kind?: KnowledgeKind): Entity[] {
  const byId = new Map(state.entities.map(entity => [entity.id, entity]));
  const matches = new Map<string, Entity>(); const sought = normalizeEntityName(name);
  if (!sought) return [];
  for (const entity of state.entities) {
    if (kind && entity.kind !== kind || !namesOf(entity).some(value => normalizeEntityName(value) === sought)) continue;
    const target = activeTarget(entity, byId); if (target) matches.set(target.id, target);
  }
  return [...matches.values()];
}

const factKey = (fact: Entity['facts'][number] | ExtractedEntity['facts'][number]) => JSON.stringify([fact.text, fact.attribute, fact.temporal, fact.certainty, fact.visibility, 'citation' in fact ? fact.citation : ['paragraph' in fact ? fact.paragraph : undefined, 'quote' in fact ? fact.quote : undefined]]);

/**
 * Names and explicit aliases form identity links; similar prose and substrings never do.
 * Resolve the complete batch before mutation, so a later alias can join earlier candidates.
 */
export function reconcileExtractionEntities(state: StoryState, input: ExtractedEntity[]): EntityReconciliation {
  const issues: OutputIssue[] = []; const redirects = new Map<string, string>(); const nameBindings: EntityNameBinding[] = [];
  const secretSources = new Set(state.entities.filter(entity => entity.visibility === 'secret').map(entity => entity.id));
  const byId = new Map(state.entities.map(entity => [entity.id, entity])); const knownPrimaryNames = new Map<string, Map<string, Entity>>();
  for (const entity of state.entities) {
    const target = activeTarget(entity, byId); if (!target) continue;
    const identity = key(entity.kind, entity.name); const matches = knownPrimaryNames.get(identity) ?? new Map<string, Entity>(); matches.set(target.id, target); knownPrimaryNames.set(identity, matches);
  }
  const source = structuredClone(input); const parents = source.map((_, index) => index);
  const root = (index: number): number => parents[index] === index ? index : (parents[index] = root(parents[index]));
  const join = (left: number, right: number) => { const first = root(left); const second = root(right); if (first !== second) parents[second] = first; };
  const primary = new Map<string, number[]>();
  source.forEach((entity, index) => { const identity = key(entity.kind, entity.name); primary.set(identity, [...(primary.get(identity) ?? []), index]); });
  source.forEach((entity, index) => {
    for (const name of namesOf(entity)) for (const other of primary.get(key(entity.kind, name)) ?? []) join(index, other);
  });

  const knownIds = source.map(() => new Set<string>()); const knownOwner = new Map<string, number>();
  source.forEach((entity, index) => namesOf(entity).forEach(name => {
    // A shared alias such as "队长" does not identify two differently named people across chapters.
    const matches = normalizeEntityName(name) === normalizeEntityName(entity.name) ? findEntitiesByName(state, name, entity.kind) : [...(knownPrimaryNames.get(key(entity.kind, name))?.values() ?? [])];
    if (matches.length > 1) { issues.push({ path: `entities[${index}].aliases`, message: `名称“${name}”对应多个已有条目，无法确定身份；请补充唯一称呼或人工合并` }); return; }
    if (!matches.length) return;
    const entityId = matches[0].id; knownIds[index].add(entityId);
    const owner = knownOwner.get(entityId); if (owner !== undefined) join(index, owner); else knownOwner.set(entityId, index);
  }));

  // A generic primary record must not be the sole bridge between several separately named people.
  for (const [identity] of primary) {
    const references = source.map((entity, index) => ({ entity, index })).filter(({ entity }) => key(entity.kind, entity.name) !== identity && entity.aliases.some(alias => key(entity.kind, alias) === identity));
    let ambiguous = false;
    for (let left = 0; left < references.length && !ambiguous; left++) for (let right = left + 1; right < references.length; right++) {
      const first = references[left]; const second = references[right];
      if (key(first.entity.kind, first.entity.name) === key(second.entity.kind, second.entity.name)) continue;
      const directIdentity = first.entity.aliases.some(alias => key(first.entity.kind, alias) === key(second.entity.kind, second.entity.name)) || second.entity.aliases.some(alias => key(second.entity.kind, alias) === key(first.entity.kind, first.entity.name));
      const firstIds = knownIds[first.index]; const secondIds = knownIds[second.index];
      const sameKnownIdentity = firstIds.size === 1 && secondIds.size === 1 && [...firstIds][0] === [...secondIds][0];
      if (directIdentity || sameKnownIdentity) continue;
      issues.push({ path: `entities[${second.index}].aliases`, message: `名称“${source[primary.get(identity)![0]].name}”同时关联“${first.entity.name}”与“${second.entity.name}”，缺少唯一身份依据；请统一确认的本名或移除泛称别名` }); ambiguous = true; break;
    }
  }

  const grouped = new Map<number, number[]>();
  source.forEach((_, index) => { const group = root(index); grouped.set(group, [...(grouped.get(group) ?? []), index]); });
  const plans = [...grouped.values()].map(indices => {
    const records = state.entities.filter(entity => !entity.mergedInto && indices.some(index => knownIds[index].has(entity.id)));
    const locked = records.filter(entity => entity.locked);
    if (locked.length > 1) issues.push({ path: `entities[${indices[0]}].aliases`, message: '别名关联了多个人工锁定的条目，请先人工确认并合并，提取不会改写锁定的身份' });
    const target = locked[0] ?? records.find(entity => indices.some(index => normalizeEntityName(source[index].name) === normalizeEntityName(entity.name))) ?? records[0];
    return { indices, records, target };
  });
  if (issues.length) return { entities: source, issues, redirects, nameBindings };

  const entities = plans.map(({ indices, records, target }) => {
    const candidates = indices.map(index => source[index]);
    const allNames = [...new Map([...records, ...candidates].flatMap(namesOf).map(name => [normalizeEntityName(name), name])).values()];
    // Upgrade an unnamed person's descriptive label only after an explicit alias bridge to a new personal name.
    if (target && !target.locked && target.kind === 'character' && placeholderName(target)) {
      const knownNames = new Set(namesOf(target).map(normalizeEntityName));
      const named = candidates.find(candidate => confirmedName(candidate) && (candidate.nameStatus === 'confirmed' || !knownNames.has(normalizeEntityName(candidate.name))) && candidate.aliases.some(alias => normalizeEntityName(alias) === normalizeEntityName(target.name)));
      if (named) { target.name = named.name.trim(); target.nameStatus = 'confirmed'; }
    }
    const canonical = target?.name ?? (candidates[0].kind === 'character' ? candidates.find(candidate => candidate.nameStatus === 'confirmed')?.name ?? candidates.find(confirmedName)?.name : undefined) ?? candidates[0].name.trim();
    const aliases = allNames.filter(name => normalizeEntityName(name) !== normalizeEntityName(canonical));
    if (target) {
      for (const record of records) {
        if (record.id === target.id) continue;
        redirects.set(record.id, target.id); record.mergedInto = target.id;
        const facts = new Set(target.facts.map(factKey));
        for (const fact of record.facts) {
          const retained = { ...structuredClone(fact), visibility: record.visibility === 'secret' ? 'secret' as const : fact.visibility, certainty: target.locked && fact.temporal === 'current' ? 'conflict' as const : fact.certainty };
          if (!facts.has(factKey(retained))) { target.facts.push(retained); facts.add(factKey(retained)); }
        }
        if (!target.locked) {
          if (!target.description) target.description = record.description;
          if (record.visibility === 'secret') target.visibility = 'secret';
          if (target.isMainSource !== 'author') {
            if (record.isMainSource === 'author' && record.isMain !== undefined) { target.isMain = record.isMain; target.isMainSource = 'author'; }
            else if (record.isMain) { target.isMain = true; target.isMainSource = 'extraction'; }
          }
        }
      }
      if (!target.locked) target.aliases = [...new Map([...target.aliases, ...aliases].filter(name => normalizeEntityName(name) !== normalizeEntityName(canonical)).map(name => [normalizeEntityName(name), name])).values()];
      for (const name of allNames) nameBindings.push({ name, kind: target.kind, entityId: target.id });
    }
    const latestDescription = [...candidates].reverse().find(entity => entity.description.trim() && entity.facts.some(fact => fact.temporal === 'current'))?.description ?? '';
    const canonicalCandidate = candidates.find(candidate => normalizeEntityName(candidate.name) === normalizeEntityName(canonical));
    const nameStatus = target?.locked || target?.nameStatus === 'confirmed' ? target.nameStatus : canonicalCandidate?.nameStatus ?? target?.nameStatus;
    const isMain = target?.locked || target?.isMainSource === 'author' ? target.isMain : (target?.isMain || candidates.some(candidate => candidate.isMain)) ? true : target?.isMain ?? candidates.find(candidate => candidate.isMain !== undefined)?.isMain;
    return {
      kind: candidates[0].kind, name: canonical, aliases, description: latestDescription, ...(nameStatus !== undefined ? { nameStatus } : {}), ...(isMain !== undefined ? { isMain } : {}),
      visibility: candidates.some(entity => entity.visibility === 'secret') ? 'secret' as const : 'public' as const,
      facts: [...new Map(candidates.flatMap(entity => entity.facts.map(fact => ({ ...fact, visibility: entity.visibility === 'secret' ? 'secret' as const : fact.visibility }))).map(fact => [factKey(fact), fact])).values()],
    };
  });
  const redirected = (entityId: string): string => redirects.get(entityId) ?? entityId;
  for (const entity of state.entities) if (entity.mergedInto) entity.mergedInto = redirected(entity.mergedInto);
  for (const relation of state.relations) { if (redirects.has(relation.fromId) && secretSources.has(relation.fromId) || redirects.has(relation.toId) && secretSources.has(relation.toId)) relation.visibility = 'secret'; relation.fromId = redirected(relation.fromId); relation.toId = redirected(relation.toId); }
  for (const foreshadow of state.foreshadows) foreshadow.relatedEntityIds = [...new Set(foreshadow.relatedEntityIds.map(redirected))];
  return { entities, issues, redirects, nameBindings };
}
