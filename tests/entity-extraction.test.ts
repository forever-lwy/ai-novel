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
  it('persists a placeholder identity, promotes its confirmed name, and retains role metadata across a saved revision', () => {
    const { store, branchId } = createStory();
    const firstCharacter = character('黑袍客', '身披黑袍', '黑袍客出现在港口。', [], 'appearance'); firstCharacter.nameStatus = 'placeholder';
    const first = append(store, branchId, '黑袍客出现在港口。', extraction(firstCharacter));
    const entityId = first.state.entities[0].id;
    const named = character('林舟', '姓名为林舟', '黑袍客说：“我叫林舟。”', ['黑袍客'], 'name'); named.nameStatus = 'confirmed'; named.isMain = true;
    const next = append(store, branchId, '黑袍客说：“我叫林舟。”', extraction(named));
    expect(next.state.entities.filter(entity => !entity.mergedInto)).toHaveLength(1);
    expect(next.state.entities[0]).toMatchObject({ id: entityId, name: '林舟', nameStatus: 'confirmed', isMain: true, aliases: ['黑袍客'] });
    expect(store.state(branchId).entities[0]).toMatchObject({ name: '林舟', nameStatus: 'confirmed', isMain: true });
    expect(store.revisionState(first.branch.revisionId).entities[0]).toMatchObject({ name: '黑袍客', nameStatus: 'placeholder' });
    const restored = store.rollback(branchId, { baseRevisionId: next.branch.revisionId, revisionId: first.branch.revisionId });
    expect(restored.state.entities[0]).toMatchObject({ name: '黑袍客', nameStatus: 'placeholder' }); expect(restored.state.entities[0].isMain).toBeUndefined();
  });

  it('updates profile fields without losing unrelated abilities or turning daily narrative into character history', () => {
    const { store, branchId } = createStory();
    const source = '琥珀是精灵族的女性，精通长弓，并在灯塔觉醒风魔法。';
    const profile = character('琥珀', '女性', source, [], 'gender');
    profile.nameStatus = 'confirmed'; profile.isMain = true;
    profile.facts.push(
      { ...profile.facts[0], text: '精灵族血统', attribute: 'bloodline' },
      { ...profile.facts[0], text: '精通长弓', attribute: 'ability:archery' },
      { ...profile.facts[0], text: '在灯塔觉醒风魔法', attribute: 'major_event', temporal: 'past' },
    );
    append(store, branchId, source, extraction(profile));
    const later = '琥珀在港口吃过早餐，得知自己也有人类血统，并学会控制风魔法。';
    const updated = character('琥珀', '精灵与人类混合血统', later, [], 'bloodline');
    updated.facts.push({ ...updated.facts[0], text: '能够控制风魔法', attribute: 'ability:wind' });
    const result = extraction(updated); result.summary = '琥珀在港口吃过早餐，确认混合血统并学会控制风魔法。';
    const next = append(store, branchId, later, result); const current = next.state.entities[0];
    for (const text of ['女性', '精灵与人类混合血统', '精通长弓', '能够控制风魔法', '在灯塔觉醒风魔法']) expect(current.description).toContain(text);
    expect(current.description).not.toContain('精灵族血统'); expect(current.description).not.toContain('早餐');
    expect(current.facts.find(fact => fact.text === '精灵族血统')?.temporal).toBe('past');
    expect(current.facts.filter(fact => fact.attribute === 'bloodline' && fact.temporal === 'current')).toHaveLength(1);
    expect(current.facts.some(fact => fact.text.includes('早餐'))).toBe(false);
    expect(next.state.chapters.at(-1)!.summary).toContain('早餐');
    expect(current.isMain).toBe(true);
  });

  it('retains author-locked placeholder names, role choice, and prose when extraction confirms a new name', () => {
    const { store, branchId } = createStory();
    const initial = character('黑袍客', '身披黑袍', '黑袍客出现在港口。', [], 'appearance'); initial.nameStatus = 'placeholder'; initial.isMain = false;
    let view = append(store, branchId, '黑袍客出现在港口。', extraction(initial));
    const fixed = view.state.entities[0];
    view = store.updateEntity(branchId, view.branch.revisionId, { ...fixed, locked: true, description: '作者暂时保留黑袍客的身份' });
    const confirmed = character('林舟', '姓名为林舟', '黑袍客说：“我叫林舟。”', ['黑袍客'], 'name'); confirmed.nameStatus = 'confirmed'; confirmed.isMain = true;
    const next = append(store, branchId, '黑袍客说：“我叫林舟。”', extraction(confirmed));
    expect(next.state.entities[0]).toMatchObject({ id: fixed.id, name: '黑袍客', nameStatus: 'placeholder', isMain: false, aliases: [], description: '作者暂时保留黑袍客的身份' });
    expect(next.state.entities[0].facts.find(fact => fact.attribute === 'name')?.certainty).toBe('conflict');
  });

  it('normalizes a manually entered Chinese property before applying its fact lock to later extraction', () => {
    const { store, branchId } = createStory();
    let view = append(store, branchId, '琥珀是女性。', extraction(character('琥珀', '女性', '琥珀是女性。', [], 'gender')));
    const original = view.state.entities[0]; const factId = original.facts[0].id;
    view = store.updateEntity(branchId, view.branch.revisionId, { ...original, locked: false, facts: original.facts.map(fact => ({ ...fact, attribute: '性别', locked: true })) });
    expect(view.state.entities[0].locked).toBe(false);
    expect(view.state.entities[0].facts[0]).toMatchObject({ id: factId, attribute: 'gender', locked: true });
    const later = append(store, branchId, '琥珀被误认为男性。', extraction(character('琥珀', '男性', '琥珀被误认为男性。', [], 'gender')));
    const facts = later.state.entities[0].facts;
    expect(facts.find(fact => fact.id === factId)).toMatchObject({ text: '女性', attribute: 'gender', locked: true, temporal: 'current', certainty: 'fact' });
    expect(facts.find(fact => fact.text === '男性')).toMatchObject({ attribute: 'gender', temporal: 'current', certainty: 'conflict' });
    expect(facts.filter(fact => fact.attribute === 'gender' && fact.temporal === 'current' && fact.certainty === 'fact')).toHaveLength(1);
    expect(later.state.entities[0].description).toContain('女性'); expect(later.state.entities[0].description).not.toContain('男性');
  });

  it('upgrades an extracted supporting role but retains an explicitly authored supporting-role choice', () => {
    const { store, branchId } = createStory();
    const supporting = character('林舟', '港口船员', '林舟是港口的一名船员。', [], 'identity'); supporting.isMain = false;
    let view = append(store, branchId, '林舟是港口的一名船员。', extraction(supporting));
    expect(view.state.entities[0]).toMatchObject({ isMain: false, isMainSource: 'extraction' });
    const leading = character('林舟', '追查旧塔的核心人物', '林舟从此独自追查旧塔的秘密。', [], 'identity'); leading.isMain = true;
    view = append(store, branchId, '林舟从此独自追查旧塔的秘密。', extraction(leading));
    expect(view.state.entities[0]).toMatchObject({ isMain: true, isMainSource: 'extraction' });
    view = store.updateEntity(branchId, view.branch.revisionId, { ...view.state.entities[0], isMain: false, locked: false });
    expect(view.state.entities[0]).toMatchObject({ isMain: false, isMainSource: 'author', locked: false });
    const recurring = character('林舟', '继续追查旧塔', '林舟继续追查旧塔。', [], 'identity'); recurring.isMain = true;
    view = append(store, branchId, '林舟继续追查旧塔。', extraction(recurring));
    expect(view.state.entities[0]).toMatchObject({ isMain: false, isMainSource: 'author', locked: false });
    expect(view.state.entities[0].facts.find(fact => fact.text === '继续追查旧塔')).toMatchObject({ temporal: 'current', certainty: 'fact' });
  });

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
