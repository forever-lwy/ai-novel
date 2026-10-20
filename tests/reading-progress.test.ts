import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { ImageService } from '../server/images.js';
import { buildApp } from '../server/app.js';
import { readingPng, readingProgressStory } from './fixtures/reading-progress.js';
import type { BranchView, Entity, ExtractionResult, Settings } from '../shared/types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
function story() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'novel-reading-progress-'))); cleanup.push(() => store.close());
  return { store, ...readingProgressStory(store) };
}
const currentFacts = (view: BranchView, name: string) => view.state.entities.find(entity => entity.name === name)!.facts.filter(fact => fact.temporal === 'current').map(fact => fact.text);

describe('chapter-scoped reader materials', () => {
  it('shows cumulative appearances and restores attributes, aliases and relations at each chapter without changing canon', () => {
    const { store, branchId, first, second, third } = story();
    const before = store.exportProject(first.branch.projectId);
    const early = store.view(branchId, false, first.state.chapters[0].id);
    expect(early.readingChapterId).toBe(first.state.chapters[0].id);
    expect(early.state.chapters).toHaveLength(3);
    expect(early.state.entities.map(entity => entity.name)).toEqual(['林舟', '河岸', '铜钥']);
    expect(currentFacts(early, '林舟')).toEqual(['目前位于河岸', '身份是旅人']);
    expect(early.state.entities[0].aliases).toEqual([]);
    expect(early.state.relations.map(relation => relation.label)).toEqual(['持有']);
    expect(JSON.stringify(early)).not.toMatch(/秘密看守的真实身份|尚未发生的战役|灯塔客|当前受伤|铜钥断裂|银灯熄灭/);
    const middle = store.view(branchId, false, second.state.chapters[1].id);
    expect(middle.state.entities.map(entity => entity.name)).toEqual(['林舟', '河岸', '铜钥', '阿岚', '山城', '银灯']);
    expect(currentFacts(middle, '林舟')).toEqual(['目前位于山城', '身份是信使']);
    expect(middle.state.entities[0].description).toContain('目前位于山城');
    expect(middle.state.entities[0].description).not.toContain('目前位于河岸');
    expect(middle.state.entities[0].facts[0].temporal).toBe('current');
    expect(currentFacts(middle, '银灯')).toEqual(['银灯点亮']);
    const late = store.view(branchId, false, third.state.chapters[2].id);
    expect(currentFacts(late, '林舟')).toEqual(['身份是信使', '目前位于灯塔', '当前受伤']);
    expect(currentFacts(late, '阿岚')).toEqual(['目前位于山城']);
    expect(currentFacts(late, '铜钥')).toEqual(['铜钥断裂']);
    expect(late.state.entities.find(entity => entity.name === '铜钥')!.description).toBe('铜钥断裂');
    expect(store.view(branchId, true, first.state.chapters[0].id).state).toEqual(third.state);
    expect(store.exportProject(first.branch.projectId)).toEqual(before);
  });

  it('keeps older chapters fixed while the latest chapter is only partially extracted', () => {
    const { store, branchId, first } = story();
    const text = '林舟走进沙漠。';
    const saved = store.saveChapter(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, title: '第四章 沙漠', text });
    const result: ExtractionResult = { summary: text, entities: [{ kind: 'character', name: '林舟', aliases: [], description: '', visibility: 'public', facts: [{ attribute: 'location', text: '目前位于沙漠', temporal: 'current', certainty: 'fact', visibility: 'public', quote: text, paragraph: 1 }] }], relations: [], foreshadows: [] };
    store.applyExtraction(branchId, saved.branch.revisionId, saved.state.chapters[3].id, result, false);
    expect(currentFacts(store.view(branchId, false, first.state.chapters[0].id), '林舟')).toContain('目前位于河岸');
    const current = store.view(branchId, false, saved.state.chapters[3].id);
    expect(current.state.chapters[3].status).toBe('pending'); expect(currentFacts(current, '林舟')).toContain('目前位于沙漠');
  });

  it('does not apply a later identity merge or visibility change to an earlier chapter', () => {
    const { store, branchId, first, third } = story();
    const traveler = third.state.entities.find(entity => entity.name === '林舟')!;
    const ally = third.state.entities.find(entity => entity.name === '阿岚')!;
    let latest = store.mergeEntities(branchId, third.branch.revisionId, traveler.id, ally.id);
    const early = store.view(branchId, false, first.state.chapters[0].id);
    expect(early.state.entities.map(entity => entity.name)).toContain('林舟');
    expect(early.state.entities.map(entity => entity.name)).not.toContain('阿岚');
    const merged = latest.state.entities.find(entity => entity.id === ally.id)!;
    latest = store.updateEntity(branchId, latest.branch.revisionId, { ...merged, visibility: 'secret' });
    expect(store.view(branchId, false, third.state.chapters[2].id).state.entities.some(entity => entity.kind === 'character')).toBe(false);
    expect(currentFacts(store.view(branchId, false, first.state.chapters[0].id), '林舟')).toContain('目前位于河岸');
  });

  it('uses inherited boundaries on forks and stays separate from the original future', () => {
    const { store, branchId, first, second, third } = story();
    const fork = store.fork(branchId, { baseRevisionId: third.branch.revisionId, chapterId: second.state.chapters[1].id, name: '山城支线' });
    const traveler = fork.state.entities.find(entity => entity.name === '林舟')!;
    const revised: Entity = { ...traveler, facts: traveler.facts.map(fact => fact.attribute === 'location' && fact.temporal === 'current' ? { ...fact, text: '目前留在山城', locked: true } : fact) };
    store.updateEntity(fork.branch.id, fork.branch.revisionId, revised);
    expect(currentFacts(store.view(fork.branch.id, false, first.state.chapters[0].id), '林舟')).toContain('目前位于河岸');
    expect(currentFacts(store.view(fork.branch.id, false, second.state.chapters[1].id), '林舟')).toContain('目前留在山城');
    expect(currentFacts(store.view(branchId, false, third.state.chapters[2].id), '林舟')).toContain('目前位于灯塔');
    expect(() => store.view(fork.branch.id, false, third.state.chapters[2].id)).toThrow('阅读进度章节不属于当前故事线');
  });

  it('preserves chapter progress after rollback and complete backup restoration', () => {
    const { store, project, branchId, first, second, third } = story();
    const restored = store.restoreProject(store.exportProject(project.id));
    const restoredState = store.state(restored.mainBranchId);
    expect(currentFacts(store.view(restored.mainBranchId, false, restoredState.chapters[0].id), '林舟')).toContain('目前位于河岸');
    expect(currentFacts(store.view(restored.mainBranchId, false, restoredState.chapters[2].id), '林舟')).toContain('目前位于灯塔');
    store.rollback(branchId, { baseRevisionId: third.branch.revisionId, revisionId: second.branch.revisionId });
    expect(currentFacts(store.view(branchId, false, first.state.chapters[0].id), '林舟')).toContain('目前位于河岸');
    expect(store.view(branchId).readingChapterId).toBe(second.state.chapters[1].id);
  });

  it('rejects unavailable historical boundaries rather than returning the latest materials', () => {
    const { store, branchId, first } = story();
    for (const revision of store.history(branchId).filter(revision => revision.chapterCount === 1)) store.db.prepare('UPDATE revisions SET data=? WHERE id=?').run(JSON.stringify({ ...revision, chapterCount: 99 }), revision.id);
    expect(() => store.view(branchId, false, first.state.chapters[0].id)).toThrow('不能安全显示阅读资料');
    expect(() => store.view(branchId, false, 'outside-chapter')).toThrow('阅读进度章节不属于当前故事线');
  });

  it('scopes searches, image metadata and pixels to the same chapter state', async () => {
    const { store, branchId, first, third } = story();
    const settings: Settings = { providers: [], writingProviderId: '', planningProviderId: '', extractionProviderId: '' };
    const images = new ImageService(store, () => settings); cleanup.unshift(() => images.close());
    const earlyId = first.state.chapters[0].id; const lateId = third.state.chapters[2].id;
    expect(store.search(branchId, '阿岚', false, earlyId).entities).toEqual([]);
    expect(store.search(branchId, '灯塔客', false, earlyId).entities).toEqual([]);
    expect(store.search(branchId, '灯塔客', false, lateId).entities.map(entity => entity.name)).toEqual(['林舟']);
    const earlyImages = images.list(branchId, false, earlyId); expect(earlyImages.map(image => image.title)).toEqual(['河岸立绘']);
    expect(earlyImages[0].url).toContain(`chapterId=${earlyId}`); expect(earlyImages[0].prompt).toBe('');
    expect(images.content(branchId, earlyImages[0].id, false, earlyId).bytes).toEqual(readingPng);
    const lateImage = images.list(branchId, false, lateId).find(image => image.title === '灯塔场景')!;
    expect(() => images.content(branchId, lateImage.id, false, earlyId)).toThrow('不包含可查看的图片');
    expect(images.content(branchId, lateImage.id, false, lateId).bytes).toEqual(readingPng);
  });

  it('uses complete current materials in every display mode without rewriting history', async () => {
    const app = await buildApp({ initialPassword: 'reading-progress-password', dataDir: mkdtempSync(join(tmpdir(), 'novel-reading-http-')), startEngine: false }); cleanup.push(() => app.app.close());
    const { branchId, first } = readingProgressStory(app.store);
    const login = await app.app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'reading-progress-password' } });
    const cookies = { session: login.cookies.find(cookie => cookie.name === 'session')!.value };
    const baseline = app.store.view(branchId, true);
    const changes = app.store.db.prepare('SELECT total_changes() AS n').get()!.n;
    const images = app.images.list(branchId, true);
    for (const query of ['', '?view=author', '?view=reader', '?view=reader&chapterId=' + first.state.chapters[0].id, '?chapterId=foreign']) {
      const response = await app.app.inject({ url: '/api/branches/' + branchId + query, cookies });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ...baseline, cacheVersion: app.store.cacheVersion() }); expect(response.json()).not.toHaveProperty('readingChapterId');
      expect((await app.app.inject({ url: '/api/branches/' + branchId + '/images' + query, cookies })).json()).toEqual(images);
      for (const image of images) {
        expect((await app.app.inject({ url: '/api/branches/' + branchId + '/images/' + image.id + '/content' + query, cookies })).rawPayload).toEqual(readingPng);
      }
      const search = '/api/branches/' + branchId + '/search' + (query || '?') + (query ? '&' : '') + 'q=' + encodeURIComponent('阿岚');
      expect((await app.app.inject({ url: search, cookies })).json().entities.map((entity: Entity) => entity.name)).toEqual(['阿岚']);
      expect((await app.app.inject({ url: '/api/branches/' + branchId + query })).statusCode).toBe(401);
    }
    expect((await app.app.inject({ url: '/api/branches/' + branchId + '/chapters/foreign', cookies })).statusCode).toBe(404);
    expect(app.store.db.prepare('SELECT total_changes() AS n').get()!.n).toBe(changes);
  });
});
