import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import type { ExtractionResult } from '../shared/types.js';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function createStory() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'ai-novel-entity-extraction-'))); stores.push(store);
  const project = store.createProject({ title: '实体归并集成验证' });
  return { store, branchId: project.mainBranchId };
}
const extraction = (...entities: ExtractionResult['entities']): ExtractionResult => ({ summary: '本章剧情摘要。', entities, relations: [], foreshadows: [] });
function character(name: string, text: string, quote: string, aliases: string[] = [], attribute?: string): ExtractionResult['entities'][number] {
  return { kind: 'character', name, aliases, description: '', visibility: 'public', facts: [{ text, quote, paragraph: 1, temporal: 'current', certainty: 'fact', visibility: 'public', attribute }] };
}
function bridge(): ExtractionResult {
  return extraction({ kind: 'character', name: '林舟', aliases: ['戴兜帽的旅人'], description: '', visibility: 'public', facts: [] });
}
function append(store: Store, branchId: string, text: string, result: ExtractionResult) {
  const saved = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title: '章节', text });
  return store.applyExtraction(branchId, saved.branch.revisionId, saved.state.chapters.at(-1)!.id, result, true);
}

describe('committed entity reconciliation', () => {
  it('keeps different characters across chapters when only their aliases overlap', () => {
    const { store, branchId } = createStory();
    append(store, branchId, '林舟率领船队。', extraction(character('林舟', '率领船队', '林舟率领船队。', ['队长'])));
    const next = append(store, branchId, '陈青率领守卫。', extraction(character('陈青', '率领守卫', '陈青率领守卫。', ['队长'])));
    const characters = next.state.entities.filter(entity => entity.kind === 'character' && !entity.mergedInto);
    expect(characters.map(entity => entity.name)).toEqual(['林舟', '陈青']);
    expect(characters[0].aliases).toEqual(['队长']); expect(characters[1].aliases).toEqual(['队长']);
    expect(characters[0].facts.map(fact => fact.text)).toEqual(['率领船队']);
    expect(characters[1].facts.map(fact => fact.text)).toEqual(['率领守卫']);
  });

  it('commits an explicit identity bridge, redirects saved references, and restores both records on rollback', () => {
    const { store, branchId } = createStory();
    const first = extraction(character('林舟', '来到江城', '林舟来到江城。'));
    first.entities.push({ ...character('江城', '旅人本次到达的地点', '林舟来到江城。'), kind: 'location' });
    const original = append(store, branchId, '林舟来到江城。', first);
    const targetId = original.state.entities.find(entity => entity.name === '林舟')!.id;
    const cityId = original.state.entities.find(entity => entity.name === '江城')!.id;
    const second = extraction(character('戴兜帽的旅人', '携带木盒', '戴兜帽的旅人携带木盒来到江城。'));
    second.relations = [{ from: '戴兜帽的旅人', to: '江城', label: '到访', paragraph: 1, quote: '戴兜帽的旅人携带木盒来到江城。', visibility: 'public' }];
    second.foreshadows = [{ title: '木盒内的东西', detail: '', status: 'planted', revealCondition: '', relatedNames: ['戴兜帽的旅人'] }];
    const before = append(store, branchId, '戴兜帽的旅人携带木盒来到江城。', second);
    const sourceId = before.state.entities.find(entity => entity.name === '戴兜帽的旅人')!.id;
    const merged = append(store, branchId, '戴兜帽的旅人说明自己就是林舟。', bridge());
    expect(merged.state.entities.filter(entity => entity.kind === 'character' && !entity.mergedInto)).toHaveLength(1);
    expect(merged.state.entities.find(entity => entity.id === sourceId)?.mergedInto).toBe(targetId);
    expect(merged.state.entities.find(entity => entity.id === targetId)?.facts.map(fact => fact.text)).toEqual(expect.arrayContaining(['来到江城', '携带木盒']));
    expect(merged.state.relations).toMatchObject([{ fromId: targetId, toId: cityId, label: '到访' }]);
    expect(merged.state.foreshadows[0].relatedEntityIds).toEqual([targetId]);
    expect(store.revisionState(before.branch.revisionId)).toEqual(before.state);

    const restored = store.rollback(branchId, { baseRevisionId: merged.branch.revisionId, revisionId: before.branch.revisionId });
    expect(restored.state).toEqual(before.state);
    expect(restored.state.entities.filter(entity => entity.kind === 'character' && !entity.mergedInto)).toHaveLength(2);
    expect(restored.state.relations[0].fromId).toBe(sourceId);
  });

  it('keeps facts and relationships from a secret record hidden when merging into a locked public character', () => {
    const { store, branchId } = createStory();
    const first = extraction(character('林舟', '公开身份是旅人', '林舟来到江城。'));
    first.entities.push({ ...character('江城', '旅人本次到达的地点', '林舟来到江城。'), kind: 'location' });
    let view = append(store, branchId, '林舟来到江城。', first);
    const target = view.state.entities.find(entity => entity.name === '林舟')!;
    view = store.updateEntity(branchId, view.branch.revisionId, { ...target, locked: true });
    const hidden = character('戴兜帽的旅人', '身上藏有秘密信函', '戴兜帽的旅人身上藏有信函。'); hidden.visibility = 'secret';
    const second = extraction(hidden);
    second.relations = [{ from: '戴兜帽的旅人', to: '江城', label: '暗中掌管', paragraph: 1, quote: '戴兜帽的旅人身上藏有信函。', visibility: 'public' }];
    append(store, branchId, '戴兜帽的旅人身上藏有信函。', second);
    expect(JSON.stringify(store.view(branchId))).not.toContain('秘密信函');
    expect(JSON.stringify(store.view(branchId))).not.toContain('暗中掌管');

    const merged = append(store, branchId, '戴兜帽的旅人说明自己就是林舟。', bridge());
    const active = merged.state.entities.find(entity => entity.id === target.id)!;
    expect(active).toMatchObject({ locked: true, visibility: 'public', name: '林舟', aliases: [] });
    expect(merged.state.entities.filter(entity => entity.kind === 'character' && !entity.mergedInto)).toHaveLength(1);
    expect(active.facts.find(fact => fact.text === '身上藏有秘密信函')?.visibility).toBe('secret');
    expect(merged.state.relations.find(relation => relation.label === '暗中掌管')?.visibility).toBe('secret');
    const reader = JSON.stringify(store.view(branchId));
    expect(reader).toContain('公开身份是旅人');
    for (const secret of ['秘密信函', '暗中掌管', '戴兜帽的旅人']) expect(reader).not.toContain(secret);
  });

  it('does not replace a locked character location with a duplicate record current location during a merge', () => {
    const { store, branchId } = createStory();
    let view = append(store, branchId, '林舟在江城。', extraction(character('林舟', '目前位于江城', '林舟在江城。', [], 'location')));
    const target = view.state.entities[0]; const fixedFactId = target.facts[0].id;
    view = store.updateEntity(branchId, view.branch.revisionId, { ...target, locked: true });
    expect(view.state.entities[0].facts[0].locked).toBeUndefined();
    append(store, branchId, '戴兜帽的旅人来到灯塔。', extraction(character('戴兜帽的旅人', '目前位于灯塔', '戴兜帽的旅人来到灯塔。', [], 'location')));
    const merged = append(store, branchId, '戴兜帽的旅人说明自己就是林舟。', bridge());
    const active = merged.state.entities.find(entity => entity.id === target.id)!;
    expect(active.locked).toBe(true);
    expect(active.facts.find(fact => fact.id === fixedFactId)).toMatchObject({ text: '目前位于江城', temporal: 'current', certainty: 'fact' });
    expect(active.facts.filter(fact => fact.attribute === 'location' && fact.temporal === 'current' && fact.certainty === 'fact')).toMatchObject([{ text: '目前位于江城' }]);
    expect(active.facts.find(fact => fact.text === '目前位于灯塔')?.certainty).toBe('conflict');
  });
});
