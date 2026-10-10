import { randomUUID } from 'node:crypto';
import type { ExtractionResult, StoryImage, Job } from '../../shared/types.js';
import type { Store } from '../../server/store.js';
import { normalizeExtraction, splitExtractionBlocks } from '../../server/extraction.js';

export const readingPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x8AAAAASUVORK5CYII=', 'base64');
type ExtractedEntity = ExtractionResult['entities'][number];
const entity = (kind: ExtractedEntity['kind'], name: string, quote: string, attributes: Record<string, string>): ExtractedEntity => ({
  kind, name, aliases: [], description: '', visibility: 'public',
  facts: Object.entries(attributes).map(([attribute, text]) => ({ attribute, text, quote, paragraph: 1, temporal: 'current', certainty: 'fact', visibility: 'public' })),
});

/** Neutral, deterministic story; no model or production data is used. */
export function readingProgressStory(store: Store) {
  const project = store.createProject({ title: '章节进度验收' }); const branchId = project.mainBranchId;
  function append(title: string, text: string, entities: ExtractedEntity[], relations: ExtractionResult['relations'] = []) {
    const saved = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title, text });
    return store.applyExtraction(branchId, saved.branch.revisionId, saved.state.chapters.at(-1)!.id, { summary: text, entities, relations, foreshadows: [] }, true);
  }
  function illustrate(kind: StoryImage['kind'], title: string, chapterId: string, entityId?: string) {
    const state = store.state(branchId); const stamp = new Date().toISOString();
    const image: StoryImage = { id: randomUUID(), projectId: project.id, branchId, baseRevisionId: store.getBranch(branchId).revisionId, kind, title, entityId, chapterId, status: 'completed', prompt: '作者绘图要求', automatic: false, visibility: 'public', mimeType: 'image/png', createdAt: stamp, updatedAt: stamp };
    if (kind === 'cg') image.sourceText = store.chapter(branchId, chapterId).text;
    store.images.insert(image, { bytes: readingPng, mimeType: 'image/png' });
    state.imageIds = [...(state.imageIds ?? []), image.id]; state.activeImageIds = [...(state.activeImageIds ?? []), image.id];
    return store.commit(branchId, store.getBranch(branchId).revisionId, state, '保存验收插画', revisionId => { image.baseRevisionId = revisionId; store.images.update(image); });
  }
  const firstText = '旅人林舟在河岸捡到铜钥，秘密看守藏在暗处，他梦见未来战役。';
  const hidden = entity('character', '秘密看守', firstText, { identity: '秘密看守的真实身份' }); hidden.visibility = 'secret';
  const future = entity('event', '未来战役', firstText, { major_event: '尚未发生的战役' }); future.facts[0].temporal = 'future';
  let first = append('第一章 河岸', firstText, [entity('character', '林舟', firstText, { location: '目前位于河岸', identity: '身份是旅人' }), entity('location', '河岸', firstText, { identity: '河岸是出发地点' }), entity('item', '铜钥', firstText, { status: '铜钥完好' }), hidden, future], [{ from: '林舟', to: '铜钥', label: '持有', visibility: 'public', paragraph: 1, quote: firstText }]);
  first = illustrate('portrait', '河岸立绘', first.state.chapters[0].id, first.state.entities[0].id);
  const secondText = '林舟成为信使，在山城结识阿岚，阿岚在山城举起点亮的银灯。';
  const second = append('第二章 山城', secondText, [entity('character', '林舟', secondText, { location: '目前位于山城', identity: '身份是信使' }), entity('character', '阿岚', secondText, { location: '目前位于山城' }), entity('location', '山城', secondText, { identity: '山城位于山上' }), entity('item', '银灯', secondText, { status: '银灯点亮' })], [{ from: '林舟', to: '阿岚', label: '结识', visibility: 'public', paragraph: 1, quote: secondText }]);
  const thirdText = '林舟受伤抵达灯塔，被称为灯塔客，他的铜钥断裂，阿岚的银灯已经熄灭。';
  const traveler = entity('character', '林舟', thirdText, { location: '目前位于灯塔', status: '当前受伤' }); traveler.aliases = ['灯塔客'];
  let third = append('第三章 灯塔', thirdText, [traveler, entity('location', '灯塔', thirdText, { identity: '灯塔是新的落脚点' }), entity('item', '铜钥', thirdText, { status: '铜钥断裂' }), entity('item', '银灯', thirdText, { status: '银灯熄灭' })]);
  third = illustrate('cg', '灯塔场景', third.state.chapters[2].id);
  return { project, branchId, first, second, third };
}

/** Reproduce the old default poisoning before enabling compatibility with the saved evidence. */
export function legacyReadingProgressStory(store: Store) {
  const project = store.createProject({ title: '旧提取可见性验收' }); const branchId = project.mainBranchId; const outputIds: string[] = [];
  const stamp = new Date().toISOString(); const job: Job = { id: randomUUID(), projectId: project.id, branchId, baseRevisionId: store.getBranch(branchId).revisionId, kind: 'import', status: 'completed', progress: 5, total: 5, message: 'fixture import', inputTokens: 5, outputTokens: 5, payload: {}, createdAt: stamp, updatedAt: stamp };
  store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?)').run(job.id, branchId, project.id, job.status, JSON.stringify(job));
  const chapters: string[] = []; const counts = [3, 4, 6, 8, 9];
  const texts = ['林舟在港口捡到铜钥。', '林舟带着铜钥来到河岸。', '林舟在山城遇到阿岚。', '林舟留在山城，林夏在灯塔等候。', '林夏来到树林，阿岚仍留在山城。'];
  const contents = [
    [entity('character', '林舟', texts[0], { location: '目前位于港口' }), entity('location', '港口', texts[0], { identity: '港口是出发地点' }), entity('item', '铜钥', texts[0], { status: '铜钥完好' })],
    [entity('character', '林舟', texts[1], { location: '目前位于河岸' }), entity('location', '河岸', texts[1], { identity: '河岸是停留地点' })],
    [entity('character', '林舟', texts[2], { location: '目前位于山城' }), entity('character', '阿岚', texts[2], { location: '目前位于山城' }), entity('location', '山城', texts[2], { identity: '山城在山上' })],
    [entity('character', '林夏', texts[3], { location: '目前位于灯塔' }), entity('location', '灯塔', texts[3], { identity: '灯塔是等候地点' })],
    [entity('character', '林夏', texts[4], { location: '目前位于树林' }), entity('location', '树林', texts[4], { identity: '树林是新的地点' })],
  ];
  contents[0][0].facts.push({ text: '隐藏身份答案', attribute: 'identity', temporal: 'current', certainty: 'fact', visibility: 'secret', paragraph: 1, quote: texts[0] }, { text: '未来登塔计划', attribute: 'goal', temporal: 'future', certainty: 'fact', visibility: 'public', paragraph: 1, quote: texts[0] });
  const hidden = entity('character', '幕后客', texts[3], { identity: '真正的幕后身份' }); hidden.visibility = 'secret'; contents[3].push(hidden);
  for (const [index, text] of texts.entries()) {
    store.db.prepare('INSERT INTO job_import_chapters VALUES(?,?,?,?)').run(job.id, index, `第${['一', '二', '三', '四', '五'][index]}章`, text);
    const saved = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title: `第${['一', '二', '三', '四', '五'][index]}章`, text });
    const chapterId = saved.state.chapters.at(-1)!.id; chapters.push(chapterId);
    const raw = { summary: text, entities: contents[index].map(value => { const copy: Partial<ExtractedEntity> = structuredClone(value); if (index !== 3) delete copy.visibility; return copy; }), relations: index === 0 ? [{ from: '林舟', to: '铜钥', label: '持有', visibility: 'public', paragraph: 1, quote: text }] : [], foreshadows: [] };
    const normalized = normalizeExtraction(raw, splitExtractionBlocks(text)[0]); if (!normalized.value) throw new Error('Invalid fixture');
    const legacy = structuredClone(normalized.value); const adjustments = structuredClone(normalized.adjustments);
    legacy.entities.forEach((value, entityIndex) => { if (!raw.entities[entityIndex].visibility) { value.visibility = 'secret'; const adjustment = adjustments.find(change => change.path === `entities[${entityIndex}].visibility`)!; adjustment.message = '省略字段已补为 "secret"'; } });
    const output = store.outputs.create({ projectId: project.id, branchId, baseRevisionId: saved.branch.revisionId, chapterId, jobId: job.id, stage: 'extraction', blockIndex: 0 }, { text: JSON.stringify(raw), rawResponse: JSON.stringify(raw), inputTokens: 1, outputTokens: 1 });
    outputIds.push(output.id); store.outputs.update(output.id, { normalizedText: JSON.stringify(legacy), adjustments });
    store.applyExtraction(branchId, saved.branch.revisionId, chapterId, legacy, true);
  }
  // No output was marked applied while creating the old snapshots.
  for (const id of outputIds) store.outputs.update(id, { status: 'applied' });
  return { project, branchId, chapters, outputIds, counts };
}
