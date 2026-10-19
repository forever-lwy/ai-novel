import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.js';
import { ImageService } from '../server/images.js';
import { mixedVisibilityStory, readingPng } from './fixtures/reading-progress.js';
import { defaultImageSettings } from '../shared/image-settings.js';
import type { Settings } from '../shared/types.js';
import type { ImagePromptInput } from '../server/image-prompts.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
function setup(legacy = false) {
  const directory = mkdtempSync(join(tmpdir(), 'novel-reader-visibility-')); const store = new Store(directory);
  cleanup.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, ...mixedVisibilityStory(store, legacy) };
}
const fingerprint = (store: Store) => createHash('sha256').update(JSON.stringify(store.db.prepare('SELECT id,hex(state) AS state FROM revisions ORDER BY rowid').all())).update(JSON.stringify(store.db.prepare('SELECT id,data FROM model_outputs ORDER BY rowid').all())).digest('hex');
function service(store: Store) {
  const inputs: ImagePromptInput[] = [];
  const settings: Settings = { providers: [{ id: 'local', name: 'local', protocol: 'openai-chat', baseUrl: 'http://fixture.test', apiKey: 'fixture' }], writingProviderId: 'local', planningProviderId: 'local', extractionProviderId: 'local', imageSettings: { ...defaultImageSettings(), providerId: 'local', model: 'fixture-image' } };
  const images = new ImageService(store, () => settings, async () => ({ bytes: readingPng, mimeType: 'image/png' }), async (_settings, input) => { inputs.push(input); return { prompt: input.material, referenceEntityIds: [], parameters: {} }; });
  cleanup.unshift(() => images.close()); return { images, inputs };
}
async function completed(store: Store, id: string) {
  for (let index = 0; index < 100 && store.images.get(id)?.status !== 'completed'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(store.images.get(id)?.status).toBe('completed');
}

describe('public appearances and illustrations share the reader boundary', () => {
  it('reveals an initially secret character after public evidence and retains an earlier public character through secret updates', () => {
    const { store, branchId, chapters, personId, allyId } = setup();
    expect(store.view(branchId, false, chapters[0]).state.entities.map(entity => entity.id)).toContain(personId);
    expect(store.view(branchId, false, chapters[0]).state.entities.map(entity => entity.id)).not.toContain(allyId);
    const middle = store.view(branchId, false, chapters[1]);
    expect(middle.state.entities.filter(entity => entity.kind === 'character').map(entity => entity.id)).toEqual([personId, allyId]);
    expect(JSON.stringify(middle)).not.toMatch(/幕后身份答案|未来登塔安排|密信中的身份答案|未揭晓称号/);
    expect(store.state(branchId).entities.find(entity => entity.id === personId)?.visibility).toBe('public');
    expect(store.state(branchId).entities.find(entity => entity.id === allyId)?.visibility).toBe('public');
  });

  it('repairs old sticky-secret records only in the reader projection, with consistent search, forks and restored backups', () => {
    const { store, project, branchId, chapters, personId, allyId } = setup(true); const before = fingerprint(store);
    const reader = store.view(branchId); expect(reader.state.entities.filter(entity => entity.kind === 'character')).toHaveLength(2);
    expect(JSON.stringify(reader)).not.toMatch(/幕后身份答案|密信中的身份答案|未揭晓称号|未来登塔安排/);
    expect(store.search(branchId, '林舟').entities.map(entity => entity.id)).toEqual([personId]);
    expect(store.search(branchId, '未揭晓称号').entities).toEqual([]);
    const author = store.state(branchId); expect(author.entities.find(entity => entity.id === personId)?.aliases).toContain('未揭晓称号');
    expect(author.entities.filter(entity => entity.kind === 'character').every(entity => entity.visibility === 'secret')).toBe(true);
    expect(fingerprint(store)).toBe(before);
    const fork = store.fork(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, chapterId: chapters[1], name: '公开出场支线' });
    expect(store.view(fork.branch.id).state.entities.map(entity => entity.id)).toContain(allyId);
    const restored = store.restoreProject(store.exportProject(project.id));
    expect(store.view(restored.mainBranchId).state.entities.filter(entity => entity.kind === 'character')).toHaveLength(2);
  });

  it('preserves author secrets even after a new public extraction and keeps earlier reading history intact', () => {
    const { store, branchId, chapters, personId } = setup(true);
    const current = store.view(branchId, true); const person = current.state.entities.find(entity => entity.id === personId)!;
    const edited = store.updateEntity(branchId, current.branch.revisionId, { ...person, visibility: 'secret', locked: false, description: '人工指定私密' });
    expect(store.view(branchId).state.entities.some(entity => entity.id === personId)).toBe(false);
    const output = store.outputs.all(edited.branch.projectId).find(output => output.chapterId === chapters[2])!;
    store.applyExtraction(branchId, edited.branch.revisionId, chapters[2], JSON.parse(output.normalizedText!), true);
    expect(store.state(branchId).entities.find(entity => entity.id === personId)?.visibility).toBe('secret');
    expect(store.view(branchId, false, chapters[0]).state.entities.some(entity => entity.id === personId)).toBe(true);
    const first = store.outputs.all(edited.branch.projectId).find(output => output.chapterId === chapters[0])!;
    store.applyExtraction(branchId, store.getBranch(branchId).revisionId, chapters[0], JSON.parse(first.normalizedText!), true);
    expect(store.view(branchId, false, chapters[0]).state.entities.some(entity => entity.id === personId)).toBe(true);
    expect(store.view(branchId).state.entities.some(entity => entity.id === personId)).toBe(false);
  });

  it.each(['invalid', 'foreign-lineage', 'changed-citation'] as const)('does not use %s evidence to publish a legacy character', scenario => {
    const { store, branchId, outputIds, personId } = setup(true);
    for (const id of outputIds) {
      const output = store.outputs.get(id)!;
      if (scenario === 'invalid') store.outputs.update(id, { status: 'invalid' });
      if (scenario === 'changed-citation') { const result = JSON.parse(output.normalizedText!); for (const entity of result.entities) for (const fact of entity.facts) fact.quote = '不一致的引用'; store.outputs.update(id, { normalizedText: JSON.stringify(result) }); }
      if (scenario === 'foreign-lineage') { const other = store.createProject({ title: '另一作品' }); store.db.prepare('UPDATE model_outputs SET data=? WHERE id=?').run(JSON.stringify({ ...output, baseRevisionId: store.getBranch(other.mainBranchId).revisionId }), id); }
    }
    expect(store.view(branchId).state.entities.some(entity => entity.id === personId)).toBe(false);
  });

  it('uses only disclosed facts for portraits and CGs of a character with secret and future facts', async () => {
    const { store, branchId, chapters, personId } = setup(); const { images, inputs } = service(store);
    const portrait = images.generate(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, kind: 'portrait', entityId: personId, chapterId: chapters[0] }).image;
    await completed(store, portrait.id);
    const cg = images.generate(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, kind: 'cg', chapterId: chapters[0] }).image;
    await completed(store, cg.id);
    expect(JSON.stringify(inputs)).not.toMatch(/幕后身份答案|未来登塔安排|密信中的身份答案|未揭晓称号|手持青伞/);
    expect(inputs[0].material).toContain('身穿青衣'); expect(inputs[1].characters.map(character => character.name)).toEqual(['林舟']);
    expect(images.list(branchId, false, chapters[0]).map(image => image.id)).toEqual([portrait.id, cg.id]);
    expect(images.content(branchId, cg.id, false, chapters[0]).bytes).toEqual(readingPng);
    const restored = store.restoreProject(store.exportProject(store.getBranch(branchId).projectId));
    const restoredImages = images.list(restored.mainBranchId); expect(restoredImages).toHaveLength(2);
    const restoredPortrait = store.images.all(restored.id).find(image => image.kind === 'portrait')!;
    expect(restoredPortrait.materialFactIds).toEqual(expect.arrayContaining(store.readingState(restored.mainBranchId, store.state(restored.mainBranchId).chapters[0].id).entities.find(entity => entity.name === '林舟')!.facts.filter(fact => fact.visibility === 'public' && fact.temporal !== 'future').map(fact => fact.id)));
    const changed = store.state(branchId); changed.entities.find(entity => entity.id === personId)!.facts.find(fact => fact.id === store.images.get(portrait.id)!.materialFactIds![0])!.visibility = 'secret';
    store.commit(branchId, store.getBranch(branchId).revisionId, changed, '公开外貌改为私密');
    expect(images.list(branchId).some(image => image.id === portrait.id)).toBe(false);
    expect(() => images.content(branchId, portrait.id)).toThrow('不包含');
  });

  it('keeps late chapter images, activation and deletion consistent with forks and rollback', async () => {
    const { store, branchId, chapters } = setup(); const { images } = service(store);
    const before = store.getBranch(branchId).revisionId;
    const cg = images.generate(branchId, { baseRevisionId: before, kind: 'cg', chapterId: chapters[1] }).image; await completed(store, cg.id);
    expect(images.list(branchId, false, chapters[0])).toEqual([]);
    expect(store.view(branchId, false, chapters[1]).state.imageIds).toEqual([cg.id]);
    const fork = store.fork(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, chapterId: chapters[1], name: '插画支线' });
    const active = images.setActive(branchId, cg.id, store.getBranch(branchId).revisionId, false);
    expect(images.list(branchId, false, chapters[1])).toEqual([]); expect(images.list(fork.branch.id)).toHaveLength(1);
    images.setActive(branchId, cg.id, active.view.branch.revisionId, true);
    const enabled = store.getBranch(branchId).revisionId;
    images.delete(branchId, cg.id, enabled); expect(images.list(branchId, false, chapters[1])).toEqual([]);
    expect(() => images.content(branchId, cg.id, false, chapters[1])).toThrow('不包含');
    store.rollback(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, revisionId: enabled });
    expect(images.content(branchId, cg.id, false, chapters[1]).bytes).toEqual(readingPng);
    store.rollback(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, revisionId: before });
    expect(images.list(branchId, false, chapters[1])).toEqual([]);
  });

  it('does not promote legacy private pixels or unknown old public materials automatically', async () => {
    const { store, branchId, chapters, personId } = setup(); const { images } = service(store);
    const portrait = images.generate(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, kind: 'portrait', entityId: personId }).image; await completed(store, portrait.id);
    const saved = store.images.get(portrait.id)!;
    store.images.update({ ...saved, publicMaterial: undefined, materialFactIds: undefined, materialRelationIds: undefined });
    expect(images.list(branchId)).toEqual([]); expect(() => images.content(branchId, portrait.id)).toThrow('不包含');
    store.images.update({ ...saved, visibility: 'secret' });
    expect(images.list(branchId)).toEqual([]); expect(images.list(branchId, true)).toHaveLength(1);
    expect(store.view(branchId, false, chapters[2]).state.entities.some(entity => entity.id === personId)).toBe(true);
  });

  it('restores the selected visibility lineage after rollback and rejects forged restore targets', () => {
    const { store, project, branchId, personId } = setup(true); const before = store.getBranch(branchId).revisionId;
    const person = store.state(branchId).entities.find(entity => entity.id === personId)!;
    store.updateEntity(branchId, before, { ...person, description: '人工隐藏', visibility: 'secret' });
    expect(store.view(branchId).state.entities.some(entity => entity.id === personId)).toBe(false);
    const restored = store.rollback(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, revisionId: before });
    expect(store.view(branchId).state.entities.some(entity => entity.id === personId)).toBe(true);
    const backup = store.exportProject(project.id);
    const recovered = store.restoreProject(backup); expect(store.view(recovered.mainBranchId).state.entities.some(entity => entity.name === '林舟')).toBe(true);
    const invalid = structuredClone(backup); invalid.revisions.find(entry => entry.revision.id === restored.branch.revisionId)!.revision.restoredFromRevisionId = restored.branch.revisionId;
    expect(() => store.restoreProject(invalid)).toThrow('备份回退来源');
  });
});
