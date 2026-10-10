import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Store } from '../server/store.js';
import { legacyReadingProgressStory } from './fixtures/reading-progress.js';
import { emptyState, type StoryState, type ModelOutputRecord } from '../shared/types.js';
import { repairLegacyExtractionVisibility } from '../server/legacy-extraction-visibility.js';

const stores: Store[] = []; afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const make = () => { const store = new Store(mkdtempSync(join(tmpdir(), 'novel-legacy-visibility-'))); stores.push(store); return { store, ...legacyReadingProgressStory(store) }; };
const raw = (store: Store, revisionId: string): StoryState => JSON.parse(gunzipSync(store.db.prepare('SELECT state FROM revisions WHERE id=?').get(revisionId)!.state as Uint8Array).toString());
const fingerprint = (store: Store) => createHash('sha256').update(JSON.stringify(store.db.prepare('SELECT id,hex(state) AS state FROM revisions ORDER BY rowid').all())).update(JSON.stringify(store.db.prepare('SELECT id,data FROM model_outputs ORDER BY rowid').all())).digest('hex');

describe('compatibility for omitted entity visibility in saved extraction results', () => {
  it('keeps public and secret people separate when they share identical facts and citations', () => {
    const state = emptyState(); const citation = { chapterId: 'shared-chapter', paragraph: 1, quote: '两名旅人抵达港口。' };
    state.entities = ['幕后客', '林舟'].map((name, index) => ({ id: `person-${index}`, kind: 'character', name, aliases: [], description: '', visibility: 'secret', locked: false, facts: [{ id: `fact-${index}`, text: '目前位于港口', attribute: 'location', temporal: 'current', certainty: 'fact', visibility: 'secret', citation }] }));
    const normalized = { summary: '', entities: state.entities.map(entity => ({ ...entity, facts: [{ text: '目前位于港口', attribute: 'location', temporal: 'current', certainty: 'fact', visibility: 'public', paragraph: 1, quote: citation.quote }] })), relations: [], foreshadows: [] };
    const output = { chapterId: citation.chapterId, normalizedText: JSON.stringify(normalized), adjustments: [{ path: 'entities[1].visibility', message: '省略字段已补为 "secret"' }] } as ModelOutputRecord;
    repairLegacyExtractionVisibility(state, [output], new Set());
    expect(state.entities[0]).toMatchObject({ visibility: 'secret', facts: [{ visibility: 'secret' }] });
    expect(state.entities[1]).toMatchObject({ visibility: 'public', facts: [{ visibility: 'public' }] });
  });
  it('recovers cumulative appearances and current positions from saved public evidence without writing snapshots or outputs', () => {
    const { store, branchId, chapters, counts } = make(); const before = fingerprint(store);
    const firstRevision = store.history(branchId).find(revision => revision.chapterCount === 1)!;
    expect(raw(store, firstRevision.id).entities.every(entity => entity.visibility === 'secret' && entity.facts.every(fact => fact.visibility === 'secret'))).toBe(true);
    expect(chapters.map(chapterId => store.view(branchId, false, chapterId).state.entities.length)).toEqual(counts);
    const first = store.view(branchId, false, chapters[0]); expect(first.state.entities.map(entity => entity.name)).toEqual(['林舟', '港口', '铜钥']);
    expect(JSON.stringify(first)).not.toMatch(/隐藏身份答案|未来登塔计划/);
    expect(first.state.relations[0]).toMatchObject({ label: '持有', visibility: 'public' });
    const last = store.view(branchId, false, chapters[4]);
    expect(JSON.stringify(last)).not.toMatch(/幕后客|真正的幕后身份|隐藏身份答案|未来登塔计划/);
    expect(last.state.entities.find(entity => entity.name === '林夏')!.facts.filter(fact => fact.temporal === 'current')).toMatchObject([{ text: '目前位于树林' }]);
    expect(last.state.entities.find(entity => entity.name === '林舟')!.facts.filter(fact => fact.temporal === 'current')).toMatchObject([{ text: '目前位于山城' }]);
    expect(last.state.entities.find(entity => entity.name === '铜钥')).toBeDefined();
    expect(fingerprint(store)).toBe(before);
  });

  it('never turns explicit secret or future facts into public facts', () => {
    const { store, branchId, chapters, outputIds } = make();
    const output = store.outputs.get(outputIds[0])!; const normalized = JSON.parse(output.normalizedText!);
    normalized.entities[0].facts[0].visibility = 'secret';
    store.outputs.update(output.id, { normalizedText: JSON.stringify(normalized) });
    expect(store.view(branchId, false, chapters[0]).state.entities.some(entity => entity.name === '林舟')).toBe(false);
    // The exact citation alone cannot override a future classification stored in the snapshot.
    const state = store.state(branchId); const person = state.entities.find(entity => entity.name === '林夏')!;
    person.facts.find(fact => fact.temporal === 'current')!.temporal = 'future';
    store.commit(branchId, store.getBranch(branchId).revisionId, state, 'future fixture');
    expect(store.view(branchId).state.entities.find(entity => entity.name === '林夏')?.facts.some(fact => fact.temporal === 'future')).toBe(false);
  });

  it('preserves an unlocked author secret, locked facts and the earlier public chapter', () => {
    const { store, branchId, chapters } = make();
    let view = store.view(branchId, true); const person = view.state.entities.find(entity => entity.name === '林夏')!;
    view = store.updateEntity(branchId, view.branch.revisionId, { ...person, visibility: 'secret', locked: false });
    expect(store.view(branchId).state.entities.some(entity => entity.id === person.id)).toBe(false);
    expect(store.view(branchId, false, chapters[3]).state.entities.some(entity => entity.id === person.id)).toBe(true);
    const traveler = view.state.entities.find(entity => entity.name === '林舟')!;
    store.updateEntity(branchId, view.branch.revisionId, { ...traveler, facts: traveler.facts.map(fact => ({ ...fact, locked: true, visibility: 'secret' })) });
    expect(store.view(branchId).state.entities.some(entity => entity.id === traveler.id)).toBe(false);
  });

  it('keeps inherited chapter history, rollback and restored backups compatible', () => {
    const { store, project, branchId, chapters } = make();
    const fork = store.fork(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, chapterId: chapters[2], name: '旧资料支线' });
    expect(store.view(fork.branch.id, false, chapters[0]).state.entities).toHaveLength(3);
    expect(store.view(fork.branch.id).state.entities.some(entity => entity.name === '林夏')).toBe(false);
    const restored = store.restoreProject(store.exportProject(project.id)); const ids = store.state(restored.mainBranchId).chapters.map(chapter => chapter.id);
    expect(ids.map(id => store.view(restored.mainBranchId, false, id).state.entities.length)).toEqual([3, 4, 6, 8, 9]);
    const earlier = store.history(branchId).find(revision => revision.chapterCount === 2)!;
    store.rollback(branchId, { baseRevisionId: store.getBranch(branchId).revisionId, revisionId: earlier.id });
    expect(store.view(branchId).state.entities).toHaveLength(4);
    expect(store.view(branchId, false, chapters[0]).state.entities).toHaveLength(3);
  });

  it('does not use failed outputs, another lineage, missing provenance or changed citations as recovery evidence', () => {
    for (const scenario of ['not-applied', 'foreign-lineage', 'no-provenance', 'changed-citation']) {
      const { store, branchId, chapters, outputIds } = make(); const output = store.outputs.get(outputIds[0])!;
      if (scenario === 'not-applied') store.outputs.update(output.id, { status: 'invalid' });
      if (scenario === 'no-provenance') store.outputs.update(output.id, { adjustments: [] });
      if (scenario === 'changed-citation') { const normalized = JSON.parse(output.normalizedText!); normalized.entities.forEach((entity: { facts: { quote: string }[] }) => entity.facts.forEach(fact => { fact.quote = 'different evidence'; })); store.outputs.update(output.id, { normalizedText: JSON.stringify(normalized) }); }
      if (scenario === 'foreign-lineage') { const unrelated = store.createProject({ title: '其他资料' }); store.db.prepare('UPDATE model_outputs SET data=? WHERE id=?').run(JSON.stringify({ ...output, baseRevisionId: store.getBranch(unrelated.mainBranchId).revisionId }), output.id); }
      expect(store.view(branchId, false, chapters[0]).state.entities, scenario).toHaveLength(0);
    }
  });
});
