import { describe, expect, it } from 'vitest';
import { findEntitiesByName, reconcileExtractionEntities } from '../server/entity-resolution.js';
import { CHARACTER_PROFILE_INSTRUCTION, extractionContext, normalizeExtraction, rebuildCharacterProfileDescription, splitExtractionBlocks } from '../server/extraction.js';
import { emptyState, type Entity, type ExtractionResult } from '../shared/types.js';

const extracted = (name: string, aliases: string[] = [], overrides: Partial<ExtractionResult['entities'][number]> = {}): ExtractionResult['entities'][number] => ({
  kind: 'character', name, aliases, description: '', visibility: 'public', facts: [], ...overrides,
});
const entity = (id: string, name: string, overrides: Partial<Entity> = {}): Entity => ({
  id, name, kind: 'character', aliases: [], description: '', visibility: 'public', locked: false, facts: [], ...overrides,
});
const fact = (text: string, paragraph = 1) => ({ text, temporal: 'current' as const, certainty: 'fact' as const, visibility: 'public' as const, paragraph, quote: text });

describe('entity identity resolution', () => {
  it('joins the whole batch by explicit main-name and alias links regardless of output order', () => {
    for (const reversed of [false, true]) {
      const input = [extracted('琥珀', ['混血精灵少女'], { facts: [fact('琥珀来到灯塔。')] }), extracted('混血精灵少女', [], { facts: [fact('少女递出信。', 2)] })];
      if (reversed) input.reverse();
      const original = structuredClone(input); const result = reconcileExtractionEntities(emptyState(), input);
      expect(result.issues).toEqual([]); expect(result.entities).toHaveLength(1); expect(input).toEqual(original);
      expect(result.entities[0].name).toBe('琥珀');
      expect([result.entities[0].name, ...result.entities[0].aliases]).toEqual(expect.arrayContaining(['琥珀', '混血精灵少女']));
      expect(result.entities[0].facts).toHaveLength(2);
    }
  });

  it('keeps the later main name available when matching an earlier unnamed character', () => {
    const state = emptyState(); state.entities.push(entity('unnamed', '混血精灵少女'));
    const result = reconcileExtractionEntities(state, [extracted('琥珀', ['混血精灵少女'])]);
    expect(result.issues).toEqual([]); expect(result.entities).toHaveLength(1);
    expect(state.entities.filter(item => !item.mergedInto)).toHaveLength(1); expect(state.entities[0].name).toBe('琥珀'); expect(state.entities[0].aliases).toContain('混血精灵少女');
    expect(findEntitiesByName(state, '琥珀')[0].id).toBe('unnamed');
  });

  it('promotes a confirmed personal name from an explicit placeholder bridge even when the label has no descriptive suffix', () => {
    const state = emptyState(); state.entities.push(entity('unnamed', '黑袍客', { nameStatus: 'placeholder' }));
    const result = reconcileExtractionEntities(state, [extracted('林舟', ['黑袍客'], { nameStatus: 'confirmed', isMain: true })]);
    expect(result.issues).toEqual([]); expect(result.entities).toHaveLength(1);
    expect(state.entities[0]).toMatchObject({ id: 'unnamed', name: '林舟', nameStatus: 'confirmed', aliases: ['黑袍客'] });
    expect(result.entities[0]).toMatchObject({ name: '林舟', nameStatus: 'confirmed', isMain: true });
    expect(findEntitiesByName(state, '黑袍客')[0].id).toBe('unnamed');
  });

  it('promotes a previously stored alias after an explicit confirmation, while preserving the old placeholder as an alias', () => {
    const state = emptyState(); state.entities.push(entity('unnamed', '甲号', { nameStatus: 'placeholder', aliases: ['林舟'] }));
    const result = reconcileExtractionEntities(state, [extracted('林舟', ['甲号'], { nameStatus: 'confirmed' })]);
    expect(result.issues).toEqual([]); expect(state.entities[0]).toMatchObject({ name: '林舟', nameStatus: 'confirmed' });
    expect(state.entities[0].aliases).toContain('甲号'); expect(state.entities[0].aliases).not.toContain('林舟');
  });

  it('requires the old placeholder in the identity bridge and does not merge unrelated confirmed names', () => {
    const state = emptyState(); state.entities.push(entity('unnamed', '黑袍客', { nameStatus: 'placeholder' }));
    const result = reconcileExtractionEntities(state, [extracted('林舟', [], { nameStatus: 'confirmed', description: '身穿黑袍' })]);
    expect(result.issues).toEqual([]); expect(state.entities[0].name).toBe('黑袍客'); expect(result.nameBindings).toEqual([]);
  });

  it('keeps explicitly confirmed and locked identities when a new alias claims another personal name', () => {
    for (const fixed of [{ nameStatus: 'confirmed' as const }, { nameStatus: 'placeholder' as const, locked: true }]) {
      const state = emptyState(); state.entities.push(entity('fixed', '黑袍客', fixed));
      const result = reconcileExtractionEntities(state, [extracted('林舟', ['黑袍客'], { nameStatus: 'confirmed', isMain: true })]);
      expect(result.issues).toEqual([]); expect(state.entities[0].name).toBe('黑袍客');
      if (fixed.locked) expect(state.entities[0]).toMatchObject({ nameStatus: 'placeholder', aliases: [] });
    }
  });

  it('retains the established personal name when a later fragment learns a new descriptive alias', () => {
    const state = emptyState(); state.entities.push(entity('named', '林舟'));
    const result = reconcileExtractionEntities(state, [extracted('戴兜帽的旅人', ['林舟'])]);
    expect(result.entities[0].name).toBe('林舟'); expect(state.entities[0].name).toBe('林舟'); expect(state.entities[0].aliases).toContain('戴兜帽的旅人');
  });

  it('keeps a known alias from replacing the main name and keeps locked unnamed identities intact', () => {
    const state = emptyState(); state.entities.push(entity('unnamed', '戴兜帽的旅人', { aliases: ['翠弓'] }));
    reconcileExtractionEntities(state, [extracted('翠弓', ['戴兜帽的旅人'])]); expect(state.entities[0].name).toBe('戴兜帽的旅人');
    state.entities[0].locked = true;
    reconcileExtractionEntities(state, [extracted('林舟', ['戴兜帽的旅人'])]); expect(state.entities[0].name).toBe('戴兜帽的旅人');
  });

  it('uses a unique explicit alias bridge to merge saved duplicates and redirect every reference', () => {
    const state = emptyState(); const anonymous = entity('unnamed', '混血精灵少女', { visibility: 'secret', facts: [{ id: 'older', text: '身穿绿色斗篷', temporal: 'past', certainty: 'fact', visibility: 'public' }] });
    const named = entity('named', '琥珀', { facts: [{ id: 'newer', text: '会使用长弓', temporal: 'current', certainty: 'fact', visibility: 'public' }] });
    state.entities.push(anonymous, named, entity('previous-merge', '林间旅人', { mergedInto: 'unnamed' }));
    state.relations.push({ id: 'relation', fromId: 'unnamed', toId: 'harbor', label: '抵达', visibility: 'public' });
    state.foreshadows.push({ id: 'hint', title: '绿色斗篷', detail: '', status: 'planted', revealCondition: '', relatedEntityIds: ['unnamed', 'named'] });
    const result = reconcileExtractionEntities(state, [extracted('琥珀', ['混血精灵少女'])]);
    expect(result.issues).toEqual([]); expect(result.redirects.get('unnamed')).toBe('named'); expect(anonymous.mergedInto).toBe('named');
    expect(named.facts.map(item => item.id)).toEqual(['newer', 'older']); expect(named.visibility).toBe('secret');
    expect(state.relations[0].fromId).toBe('named'); expect(state.foreshadows[0].relatedEntityIds).toEqual(['named']);
    expect(state.entities[2].mergedInto).toBe('named'); expect(findEntitiesByName(state, '林间旅人')[0].id).toBe('named');
  });

  it('preserves manually locked identity fields and facts while returning temporary new-name bindings', () => {
    const state = emptyState(); const locked = entity('fixed', '琥珀', { locked: true, description: '作者确认的描述', aliases: ['翠弓'], facts: [{ id: 'fixed-fact', text: '作者确认的事实', locked: true, temporal: 'current', certainty: 'fact', visibility: 'public' }] });
    state.entities.push(locked, entity('temporary', '混血精灵少女', { facts: [{ id: 'observed', text: '走入港口', temporal: 'current', certainty: 'fact', visibility: 'public' }] }));
    const result = reconcileExtractionEntities(state, [extracted('混血精灵少女', ['琥珀', '林间旅人'])]);
    expect(result.issues).toEqual([]); expect(result.entities[0].name).toBe('琥珀'); expect(locked.description).toBe('作者确认的描述'); expect(locked.aliases).toEqual(['翠弓']);
    expect(locked.facts[0]).toMatchObject({ id: 'fixed-fact', text: '作者确认的事实', locked: true }); expect(locked.facts).toHaveLength(2);
    expect(result.nameBindings).toContainEqual({ kind: 'character', name: '林间旅人', entityId: 'fixed' });
    expect(findEntitiesByName(state, '混血精灵少女')[0].id).toBe('fixed');
  });

  it('retains an authored supporting-role choice when a duplicate AI main-role identity is merged into it', () => {
    const state = emptyState();
    const authored = entity('authored', '林舟', { isMain: false, isMainSource: 'author' });
    const duplicate = entity('duplicate', '黑袍客', { isMain: true, isMainSource: 'extraction', nameStatus: 'placeholder' });
    state.entities.push(authored, duplicate);
    const result = reconcileExtractionEntities(state, [extracted('林舟', ['黑袍客'], { nameStatus: 'confirmed', isMain: true })]);
    expect(result.issues).toEqual([]); expect(result.redirects.get('duplicate')).toBe('authored');
    expect(duplicate.mergedInto).toBe('authored');
    expect(authored).toMatchObject({ locked: false, isMain: false, isMainSource: 'author' });
    expect(result.entities[0]).toMatchObject({ name: '林舟', isMain: false });
  });

  it('inherits an authored supporting-role choice when its old placeholder is merged into a named AI identity', () => {
    const state = emptyState();
    const named = entity('named', '林舟', { isMain: true, isMainSource: 'extraction', nameStatus: 'confirmed' });
    const authored = entity('authored', '黑袍客', { isMain: false, isMainSource: 'author', nameStatus: 'placeholder' });
    state.entities.push(named, authored);
    const result = reconcileExtractionEntities(state, [extracted('林舟', ['黑袍客'], { nameStatus: 'confirmed', isMain: true })]);
    expect(result.issues).toEqual([]); expect(result.redirects.get('authored')).toBe('named');
    expect(authored.mergedInto).toBe('named');
    expect(named).toMatchObject({ isMain: false, isMainSource: 'author' });
    expect(result.entities[0]).toMatchObject({ name: '林舟', isMain: false });
  });

  it.each([false, true])('retains the chosen target authored role %s when both merged records have conflicting author choices', isMain => {
    const state = emptyState();
    const chosen = entity('chosen', '林舟', { isMain, isMainSource: 'author' });
    const other = entity('other', '黑袍客', { isMain: !isMain, isMainSource: 'author' });
    state.entities.push(chosen, other);
    const result = reconcileExtractionEntities(state, [extracted('林舟', ['黑袍客'], { nameStatus: 'confirmed', isMain: true })]);
    expect(result.issues).toEqual([]); expect(result.redirects.get('other')).toBe('chosen');
    expect(chosen).toMatchObject({ isMain, isMainSource: 'author' });
    expect(result.entities[0].isMain).toBe(isMain);
  });

  it('does not merge different people merely because they share a generic alias or description', () => {
    const result = reconcileExtractionEntities(emptyState(), [extracted('林舟', ['队长'], { description: '黑发年轻男子' }), extracted('陈青', ['队长'], { description: '黑发年轻男子' })]);
    expect(result.issues).toEqual([]); expect(result.entities).toHaveLength(2);
  });

  it('does not join characters across chapters merely through alias-to-alias overlap', () => {
    const state = emptyState(); state.entities.push(entity('lin', '林舟', { aliases: ['队长'] })); const original = structuredClone(state);
    const result = reconcileExtractionEntities(state, [extracted('陈青', ['队长'])]);
    expect(result.issues).toEqual([]); expect(result.entities[0].name).toBe('陈青'); expect(result.nameBindings).toEqual([]); expect(state).toEqual(original);
  });

  it('rejects a generic primary record that is the only link between two separately named captains', () => {
    const state = emptyState(); state.entities.push(entity('lin', '林舟'), entity('chen', '陈青')); const original = structuredClone(state);
    const result = reconcileExtractionEntities(state, [extracted('林舟', ['队长']), extracted('陈青', ['队长']), extracted('队长')]);
    expect(result.issues).toHaveLength(1); expect(result.issues[0].message).toContain('缺少唯一身份依据'); expect(state).toEqual(original); expect(result.redirects.size).toBe(0);
  });

  it('accepts a shared primary label when the personal names also have a direct identity alias bridge', () => {
    const result = reconcileExtractionEntities(emptyState(), [extracted('林舟', ['翠弓', '戴兜帽的旅人']), extracted('翠弓', ['戴兜帽的旅人']), extracted('戴兜帽的旅人')]);
    expect(result.issues).toEqual([]); expect(result.entities).toHaveLength(1); expect([result.entities[0].name, ...result.entities[0].aliases]).toEqual(expect.arrayContaining(['林舟', '翠弓', '戴兜帽的旅人']));
  });

  it('accepts shared-label candidates when both names already resolve to the same unique saved identity', () => {
    const state = emptyState(); state.entities.push(entity('lin', '林舟', { aliases: ['翠弓'] }));
    const result = reconcileExtractionEntities(state, [extracted('林舟', ['戴兜帽的旅人']), extracted('翠弓', ['戴兜帽的旅人']), extracted('戴兜帽的旅人')]);
    expect(result.issues).toEqual([]); expect(result.entities).toHaveLength(1); expect(result.entities[0].name).toBe('林舟'); expect(result.redirects.size).toBe(0);
  });

  it('keeps secret source facts and relations secret when their identity joins a locked public character', () => {
    const state = emptyState(); const locked = entity('public-person', '林舟', { locked: true, aliases: ['翠弓'], description: '公开的作者描述' });
    state.entities.push(locked, entity('secret-person', '戴兜帽的旅人', { visibility: 'secret', facts: [{ id: 'hidden', text: '暗中持有钥匙', temporal: 'current', certainty: 'fact', visibility: 'public' }] }));
    state.relations.push({ id: 'hidden-relation', fromId: 'secret-person', toId: 'gate', label: '暗中守卫', visibility: 'public' }, { id: 'ordinary-relation', fromId: 'public-person', toId: 'gate', label: '经过', visibility: 'public' });
    const result = reconcileExtractionEntities(state, [extracted('林舟', ['戴兜帽的旅人'], { visibility: 'secret', facts: [fact('暗中持有钥匙。')] })]);
    expect(result.issues).toEqual([]); expect(locked).toMatchObject({ name: '林舟', locked: true, aliases: ['翠弓'], description: '公开的作者描述', visibility: 'public' });
    expect(locked.facts[0].visibility).toBe('secret'); expect(result.entities[0].facts[0].visibility).toBe('secret');
    expect(state.relations[0]).toMatchObject({ fromId: 'public-person', visibility: 'secret' }); expect(state.relations[1].visibility).toBe('public');
  });

  it('marks copied current facts as conflicts when merging into a locked identity', () => {
    const state = emptyState(); const locked = entity('locked', '林舟', { locked: true, facts: [{ id: 'human-location', text: '位于灯塔', attribute: 'location', temporal: 'current', certainty: 'fact', visibility: 'public' }] });
    state.entities.push(locked, entity('newer', '戴兜帽的旅人', { facts: [{ id: 'new-location', text: '位于港口', attribute: 'location', temporal: 'current', certainty: 'fact', visibility: 'public', citation: { chapterId: 'later', paragraph: 1, quote: '旅人来到港口。' } }] }));
    reconcileExtractionEntities(state, [extracted('林舟', ['戴兜帽的旅人'])]);
    expect(locked.facts.find(item => item.id === 'human-location')).toMatchObject({ temporal: 'current', certainty: 'fact' });
    expect(locked.facts.find(item => item.id === 'new-location')).toMatchObject({ temporal: 'current', certainty: 'conflict' });
  });

  it('does not merge substrings or different entity kinds', () => {
    const result = reconcileExtractionEntities(emptyState(), [extracted('石桥'), extracted('石桥镇'), extracted('石桥', ['石桥镇'], { kind: 'location' })]);
    expect(result.issues).toEqual([]); expect(result.entities).toHaveLength(3);
  });

  it('rejects an ambiguous existing name without changing the state or introducing a third identity', () => {
    const state = emptyState(); state.entities.push(entity('a', '林舟'), entity('b', '林舟')); const original = structuredClone(state);
    const result = reconcileExtractionEntities(state, [extracted('新人物'), extracted('林舟', ['旅人'])]);
    expect(result.issues).toHaveLength(1); expect(result.issues[0].message).toContain('多个已有条目'); expect(state).toEqual(original); expect(result.redirects.size).toBe(0);
  });

  it('requires human confirmation when a bridge would combine two locked identities', () => {
    const state = emptyState(); state.entities.push(entity('a', '林舟', { locked: true }), entity('b', '旅人', { locked: true })); const original = structuredClone(state);
    const result = reconcileExtractionEntities(state, [extracted('林舟', ['旅人'])]);
    expect(result.issues).toHaveLength(1); expect(result.issues[0].message).toContain('人工锁定'); expect(state).toEqual(original);
  });

  it('resolves previously merged names to their target without reviving duplicate records', () => {
    const state = emptyState(); state.entities.push(entity('a', '琥珀'), entity('b', '混血精灵少女', { mergedInto: 'a' }));
    const result = reconcileExtractionEntities(state, [extracted('混血精灵少女')]);
    expect(result.issues).toEqual([]); expect(result.entities[0].name).toBe('琥珀'); expect(state.entities.filter(item => !item.mergedInto)).toHaveLength(1);
  });

  it('deduplicates repeated facts while retaining different evidence or uncertainty', () => {
    const first = fact('抵达港口。'); const second = { ...first, paragraph: 2 }; const inferred = { ...first, certainty: 'inference' as const };
    const result = reconcileExtractionEntities(emptyState(), [extracted('琥珀', [], { facts: [first] }), extracted('琥珀', [], { facts: [first, second, inferred] })]);
    expect(result.entities[0].facts).toHaveLength(3);
  });
});

describe('extraction identity context and explicit attribute normalization', () => {
  it('includes prior unnamed characters for later identity recognition without supplying secret prose or future facts', () => {
    const state = emptyState(); state.entities.push(entity('unnamed', '混血精灵少女', { description: '秘密身份答案', facts: [{ id: 'future', text: '终章计划', temporal: 'future', certainty: 'fact', visibility: 'secret' }] }));
    const context = extractionContext(state, splitExtractionBlocks('琥珀走进港口。')[0]);
    expect(context).toContain('混血精灵少女'); expect(context).not.toContain('秘密身份答案'); expect(context).not.toContain('终章计划');
  });

  it('prioritizes mentioned names while keeping the identity context bounded', () => {
    const state = emptyState(); for (let index = 0; index < 100; index++) state.entities.push(entity(`person-${index}`, `人物${index}`));
    state.entities.push(entity('harbor', '港口', { kind: 'location' })); const context = extractionContext(state, splitExtractionBlocks('港口。')[0]);
    const names = JSON.parse(context.split('\n')[0].slice(context.indexOf('：') + 1)); expect(names).toHaveLength(80); expect(names[0].name).toBe('港口');
  });

  it.each(['位置', '所在地', '当前位置', 'current_location'])('normalizes only explicit location attribute %s and records the change', attribute => {
    const source = '琥珀来到港口。'; const result = normalizeExtraction({ summary: source, entities: [extracted('琥珀', [], { facts: [{ ...fact(source), attribute }] })] }, splitExtractionBlocks(source)[0]);
    expect(result.issues).toEqual([]); expect(result.value?.entities[0].facts[0].attribute).toBe('location'); expect(result.adjustments).toContainEqual(expect.objectContaining({ path: 'entities[0].facts[0].attribute' }));
  });

  it('does not invent an attribute by inspecting narrative text', () => {
    const source = '琥珀来到港口。'; const result = normalizeExtraction({ summary: source, entities: [extracted('琥珀', [], { facts: [fact(source)] })] }, splitExtractionBlocks(source)[0]);
    expect(result.value?.entities[0].facts[0].attribute).toBeUndefined();
  });

  it('accepts explicit name status and role classification without guessing either for an unnamed record', () => {
    const source = '黑袍客说：“我叫林舟。”';
    const result = normalizeExtraction({ summary: source, entities: [extracted('林舟', ['黑袍客'], { nameStatus: 'confirmed', isMain: true })] }, splitExtractionBlocks(source)[0]);
    expect(result.issues).toEqual([]); expect(result.value?.entities[0]).toMatchObject({ nameStatus: 'confirmed', isMain: true });
    const omitted = normalizeExtraction({ summary: source, entities: [extracted('黑袍客')] }, splitExtractionBlocks(source)[0]);
    expect(omitted.value?.entities[0].nameStatus).toBeUndefined(); expect(omitted.value?.entities[0].isMain).toBeUndefined();
  });

  it('normalizes explicit profile fields and stable capability keys without interpreting the narrative', () => {
    const source = '琥珀是混血精灵，擅长射箭。';
    const result = normalizeExtraction({ summary: source, entities: [extracted('琥珀', [], { facts: [{ ...fact(source), attribute: '血统' }, { ...fact(source), attribute: '能力:archery' }] })] }, splitExtractionBlocks(source)[0]);
    expect(result.issues).toEqual([]); expect(result.value?.entities[0].facts.map(item => item.attribute)).toEqual(['bloodline', 'ability:archery']);
  });
});

describe('character profile contract', () => {
  it('keeps current character traits and major past events separate from daily narrative and unconfirmed claims', () => {
    const character = entity('hero', '琥珀', { facts: [
      { id: 'gender', text: '女性', attribute: 'gender', temporal: 'current', certainty: 'fact', visibility: 'public' },
      { id: 'archery', text: '精通长弓', attribute: 'ability:archery', temporal: 'current', certainty: 'fact', visibility: 'public' },
      { id: 'magic', text: '掌握风魔法', attribute: 'ability:wind', temporal: 'current', certainty: 'fact', visibility: 'public' },
      { id: 'old-status', text: '尚未觉醒', attribute: 'status', temporal: 'past', certainty: 'fact', visibility: 'public' },
      { id: 'event', text: '在灯塔觉醒风魔法', attribute: 'major_event', temporal: 'past', certainty: 'fact', visibility: 'public' },
      { id: 'routine', text: '在港口吃早餐', temporal: 'past', certainty: 'fact', visibility: 'public' },
      { id: 'unknown', text: '可能拥有王族血统', attribute: 'bloodline', temporal: 'current', certainty: 'inference', visibility: 'public' },
      { id: 'future', text: '未来成为国王', attribute: 'identity', temporal: 'future', certainty: 'fact', visibility: 'secret' },
    ] });
    const description = rebuildCharacterProfileDescription(character);
    for (const text of ['女性', '精通长弓', '掌握风魔法', '在灯塔觉醒风魔法']) expect(description).toContain(text);
    for (const text of ['尚未觉醒', '吃早餐', '可能拥有王族血统', '未来成为国王']) expect(description).not.toContain(text);
    expect(CHARACTER_PROFILE_INSTRUCTION).toContain('日常经过只保存在 summary');
    expect(CHARACTER_PROFILE_INSTRUCTION).toContain('缺失资料不补造');
  });

  it('preserves human-locked profile prose while new evidence can be reviewed separately', () => {
    const character = entity('hero', '琥珀', { locked: true, description: '作者确认：没有魔法能力', facts: [{ id: 'candidate', text: '掌握风魔法', attribute: 'ability:wind', temporal: 'current', certainty: 'conflict', visibility: 'public' }] });
    expect(rebuildCharacterProfileDescription(character)).toBe('作者确认：没有魔法能力');
  });
});
