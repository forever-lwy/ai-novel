import type { FormEvent, Ref } from 'react';
import type { Entity, Job, RpgSetup, RpgCharacter, ChapterRef } from '../shared/types';
import { Notice } from './ui';

export function RpgSetupFields({ value, onChange, onCharacterKind, entities, chapters }: { value: RpgSetup; onChange: (value: RpgSetup) => void; onCharacterKind: (kind: RpgCharacter['kind']) => void; entities: Entity[]; chapters: ChapterRef[] }) {
  const characters = entities.filter(entity => entity.kind === 'character' && !entity.mergedInto);
  const selected = characters.find(entity => entity.id === value.character.entityId);
  return <div className="form-stack rpg-setup">
    <p className="notice">从选定章节的结尾进入小说，在独立故事线中体验；关键剧情会停下来等你选择。</p>
    <label>体验角色<select aria-label="体验角色" value={value.character.kind} onChange={event => onCharacterKind(event.target.value as RpgCharacter['kind'])}><option value="original">原创角色</option><option value="existing" disabled={!characters.length}>小说已有角色{!characters.length ? '（请先整理人物资料）' : ''}</option></select></label>
    {value.character.kind === 'existing' ? <><label>选择已有角色<select aria-label="选择已有角色" required value={selected?.id || ''} onChange={event => { const entity = characters.find(item => item.id === event.target.value); onChange({ ...value, character: { kind: 'existing', entityId: entity?.id, name: entity?.name || '', description: '' } }); }}><option value="">请选择小说中的人物</option>{characters.map(entity => <option key={entity.id} value={entity.id}>{entity.name}</option>)}</select></label>{selected && <p className="hint">{selected.description || '将沿用小说中已确认的角色资料。'}</p>}</> : <><label>角色姓名<input aria-label="角色姓名" required maxLength={100} value={value.character.name} onChange={event => onChange({ ...value, character: { ...value.character, name: event.target.value } })} placeholder="你在小说中的名字" /></label><label>原创角色设定<textarea aria-label="原创角色设定" rows={3} maxLength={10000} value={value.character.description} onChange={event => onChange({ ...value, character: { ...value.character, description: event.target.value } })} placeholder="身份、外貌、能力、性格，以及与原作人物的关系" /></label></>}
    <label>进入小说的起点<select aria-label="进入小说的起点" value={value.entryChapterId || ''} onChange={event => onChange({ ...value, entryChapterId: event.target.value || undefined })}><option value="">当前故事线结尾</option>{chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title} · 章末</option>)}</select></label>
    <label>入场要求（可选）<textarea aria-label="入场要求（可选）" rows={3} maxLength={10000} value={value.entryInstruction || ''} onChange={event => onChange({ ...value, entryInstruction: event.target.value })} placeholder="从哪里出现、是否知道原作剧情，以及希望保留的设定" /></label>
  </div>;
}

export type RpgChoiceDraft = { selected: { optionId?: string; custom: boolean } | null; customText: string };
export function RpgChoicePanel({ job, draft, busy, error, panelRef, onDraft, onSubmit }: { job: Job; draft: RpgChoiceDraft; busy: boolean; error?: string; panelRef: Ref<HTMLHeadingElement>; onDraft: (draft: RpgChoiceDraft) => void; onSubmit: (answer: { optionId?: string; customText?: string }) => Promise<void> }) {
  const { selected, customText } = draft;
  const setSelected = (value: RpgChoiceDraft['selected']) => onDraft({ ...draft, selected: value });
  const setCustomText = (value: string) => onDraft({ ...draft, customText: value });
  const choice = job.pendingChoice;
  if (!choice) return null;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || !selected || (selected.custom && !customText.trim())) return;
    await onSubmit(selected.custom ? { customText: customText.trim() } : { optionId: selected.optionId });
  }
  return <section className="rpg-choice" aria-label="决定接下来的剧情"><h2 ref={panelRef}>决定接下来的剧情</h2><form className="form-stack" onSubmit={submit} aria-busy={busy}>
    <p className="rpg-choice-question">{choice.question}</p>
    <fieldset className="rpg-choice-options" disabled={busy}><legend>选择你的行动</legend>{choice.options.map(option => <label className={`rpg-choice-option ${selected?.optionId === option.id ? 'selected' : ''}`} key={option.id}><input type="radio" name="rpg-action" value={option.id} checked={selected?.optionId === option.id} onChange={() => setSelected({ optionId: option.id, custom: false })} /><span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></label>)}<label className={`rpg-choice-option ${selected?.custom ? 'selected' : ''}`}><input type="radio" name="rpg-action" checked={selected?.custom === true} onChange={() => setSelected({ custom: true })} /><span><strong>自定义行动</strong><small>按自己的想法决定接下来怎么做。</small></span></label></fieldset>
    {selected?.custom && <label>你想怎么做？<textarea aria-label="你想怎么做？" required maxLength={10000} rows={4} value={customText} disabled={busy} onChange={event => setCustomText(event.target.value)} placeholder="写下你的行动、台词或选择" /></label>}
    <p className="hint">可以回看上方正文，再决定怎么做。确认后，AI 会根据你的选择继续。</p>
    {error && <Notice error={error} />}
    <div className="row end wrap"><button className="button primary" type="submit" disabled={busy || !selected || (selected.custom && !customText.trim())}>{busy ? '正在提交…' : '确认选择并继续'}</button></div>
  </form></section>;
}
