import { z } from 'zod';
import type { Entity, ExtractionResult, OutputIssue, StoryState } from '../shared/types.js';
import { paragraphs } from './store.js';

const visibility = z.enum(['public', 'secret']);
export const extractionSchema = z.object({
  summary: z.string(),
  entities: z.array(z.object({ kind: z.enum(['character', 'faction', 'location', 'item', 'ability', 'rule', 'event']), name: z.string().min(1), nameStatus: z.enum(['placeholder', 'confirmed']).optional(), isMain: z.boolean().optional(), aliases: z.array(z.string()), description: z.string(), visibility,
    facts: z.array(z.object({ text: z.string().min(1), attribute: z.string().min(1).max(100).optional(), temporal: z.enum(['current', 'past', 'future', 'unknown']), certainty: z.enum(['fact', 'inference', 'conflict']), visibility, paragraph: z.number().int().positive(), quote: z.string().min(1) })) })),
  relations: z.array(z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().min(1), visibility, paragraph: z.number().int().positive(), quote: z.string().min(1) })),
  foreshadows: z.array(z.object({ title: z.string().min(1), detail: z.string(), status: z.enum(['planned', 'planted', 'resolved', 'abandoned']), dueChapter: z.number().int().positive().optional(), revealCondition: z.string(), relatedNames: z.array(z.string()) })),
});
export interface SourceSlice { paragraph: number; text: string }
export interface ExtractionBlock { start: number; text: string; sources: SourceSlice[] }

export const ENTITY_RESOLUTION_INSTRUCTION = '同一个人物或地点只输出一个实体。先对照已有名称与别名，姓名、本名、旧名以及原文明确指向同一人的描述性称呼应统一到同一实体，优先用本名作为 name，其他称呼写入 aliases；比如原文确认“戴兜帽的旅人”名叫“林舟”，应以“林舟”为 name，把“戴兜帽的旅人”写入 aliases。描述性称呼在后续片段获得本名时，也要保留之前的称呼以便归并。只有原文足以确认同一身份时才建立别名，不凭外貌、职业相似或名字包含关系合并；“他”“少女”“队长”等无法唯一指向的泛称不要作为别名。别名对照仅辅助统一身份，不是事实证据，也不能据此提前揭晓身份秘密。';

export const CHARACTER_PROFILE_INSTRUCTION = '人物资料要回答“这个人是谁、有什么特点和能力、目前处于什么状态”，不能写成逐段行动流水账。正文明确披露的姓名、性别、种族、血统、年龄、外貌、身份、所属势力、能力、性格、目标、弱点、当前状态与所在地分别使用稳定属性 name、gender、race、bloodline、age、appearance、identity、affiliation、ability、personality、goal、weakness、status、location；缺失资料不补造，也不按称呼、外貌推测性别、种族或血统。可并存的能力、性格等使用稳定子属性，例如 ability:archery、ability:fire_magic、personality:courage，同一项后续变化继续使用相同子属性。只有改变身份、能力、关系、命运或后续剧情的重大/关键经历才写为 attribute=major_event 的 past 事实；吃饭、走路、递物、普通对话等日常经过只保存在 summary，不放入人物 facts 或 description。description 是已明确资料的简洁介绍，不能塞进普通经历或尚未发生的规划。nameStatus=placeholder 表示正文未披露姓名、暂用唯一称呼定位；得知明确本名后使用本名作为 name、nameStatus=confirmed，并在 aliases 中保留正文明确对应的旧称呼，不能把本名仅写进 aliases。isMain 仅在作者指定或正文明确呈现持续核心视角/主线地位时设为 true；仅出现一次、参与一段对话或与主角相识不等于主要角色；不能确定时省略该字段。每条资料仍必须引用当前正文的精确证据，已有名称索引只辅助身份对照。';

const profileLabels: Record<string, string> = { name: '姓名', gender: '性别', race: '种族', bloodline: '血统', age: '年龄', appearance: '外貌', identity: '身份', affiliation: '所属', ability: '能力', personality: '性格', goal: '目标', weakness: '弱点', status: '状态', location: '所在地' };
const attributeAliases: Record<string, string> = { 姓名: 'name', 性别: 'gender', 种族: 'race', 血统: 'bloodline', 年龄: 'age', 外貌: 'appearance', 身份: 'identity', 所属势力: 'affiliation', 所属: 'affiliation', 能力: 'ability', 性格: 'personality', 目标: 'goal', 弱点: 'weakness', 状态: 'status', 位置: 'location', 所在地: 'location', 当前位置: 'location', current_location: 'location', 重大经历: 'major_event', 关键经历: 'major_event', 重大事件: 'major_event', 关键事件: 'major_event' };

/** Only normalize explicit field labels. Narrative wording is not a reliable classifier. */
export function normalizeProfileAttribute(attribute: string): string {
  const value = attribute.trim(); const separator = value.indexOf(':');
  const prefix = separator < 0 ? value : value.slice(0, separator).trim();
  const normalized = attributeAliases[prefix.toLocaleLowerCase()] ?? prefix;
  return separator < 0 ? normalized : `${normalized}:${value.slice(separator + 1).trim()}`;
}

/** Run after current-attribute reconciliation; human-locked prose is never reconstructed. */
export function rebuildCharacterProfileDescription(entity: Entity): string {
  if (entity.kind !== 'character' || entity.locked) return entity.description;
  const fields = new Map<string, string[]>(); const events: string[] = [];
  for (const fact of entity.facts) {
    if (fact.certainty !== 'fact' || fact.temporal === 'future' || !fact.attribute || !fact.text.trim()) continue;
    const attribute = normalizeProfileAttribute(fact.attribute); const prefix = attribute.split(':')[0];
    if (prefix === 'major_event' && fact.temporal !== 'unknown') { if (!events.includes(fact.text)) events.push(fact.text); continue; }
    if (fact.temporal !== 'current' || !profileLabels[prefix]) continue;
    const values = fields.get(prefix) ?? []; if (!values.includes(fact.text)) values.push(fact.text); fields.set(prefix, values);
  }
  const parts = Object.entries(profileLabels).flatMap(([attribute, label]) => fields.has(attribute) ? [`${label}：${fields.get(attribute)!.join('；')}`] : []);
  if (events.length) parts.push(`关键经历：${events.join('；')}`);
  return parts.length ? parts.join('\n') : entity.description;
}

/** Keep the established 5,500-character boundaries unchanged for durable job checkpoints. */
export function splitExtractionBlocks(text: string, maxChars = 5500): ExtractionBlock[] {
  const blocks: ExtractionBlock[] = []; let sources: SourceSlice[] = []; let size = 0; let start = 1;
  const flush = () => { blocks.push({ start, text: sources.map(source => `[${source.paragraph}] ${source.text}`).join('\n'), sources }); sources = []; size = 0; };
  paragraphs(text).forEach((line, index) => {
    const pieces = line.length > maxChars ? line.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g'))! : [line];
    for (const piece of pieces) { if (sources.length && size + piece.length > maxChars) flush(); if (!sources.length) start = index + 1; sources.push({ paragraph: index + 1, text: piece }); size += piece.length; }
  });
  if (sources.length) flush(); return blocks;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const pathString = (path: readonly PropertyKey[]) => path.reduce<string>((text, part) => text + (typeof part === 'number' ? `[${part}]` : `${text ? '.' : ''}${String(part)}`), '') || '$';
// Do not fold words, punctuation, width, case or apostrophes inside words. Only spacing and quotation typography are equivalent.
function comparable(text: string) {
  let value = ''; const positions: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (/\s/.test(char)) {
      let end = index + 1; while (end < text.length && /\s/.test(text[end])) end++;
      const wordLike = (part: string) => /[\p{L}\p{N}]/u.test(part) && !/\p{Script=Han}/u.test(part);
      let before = index - 1; let after = end;
      while (before >= 0 && /[\s"“”‘’「」『』']/.test(text[before])) before--;
      while (after < text.length && /[\s"“”‘’「」『』']/.test(text[after])) after++;
      // English and other space-delimited languages must keep word boundaries: "now here" is not "nowhere".
      if (wordLike(text[before] ?? '') && wordLike(text[after] ?? '')) { if (!value.endsWith(' ')) { value += ' '; positions.push(index); } }
      index = end - 1; continue;
    }
    if (/[‘’']/.test(char) && /[\p{L}\p{N}]/u.test(text[index - 1] ?? '') && /[\p{L}\p{N}]/u.test(text[index + 1] ?? '')) { value += "'"; positions.push(index); continue; }
    if (/["“”‘’「」『』']/.test(char)) continue;
    value += char; positions.push(index);
  }
  return { value, positions };
}
function matches(needle: string, sources: SourceSlice[], typography: boolean): { paragraph: number; quote: string }[] {
  const requested = typography ? comparable(needle).value : needle; if (!requested.length) return [];
  const found: { paragraph: number; quote: string }[] = [];
  for (const source of sources) {
    const index = typography ? comparable(source.text) : undefined; const haystack = index?.value ?? source.text;
    let cursor = 0;
    for (;;) { const at = haystack.indexOf(requested, cursor); if (at < 0) break; const start = index ? index.positions[at] : at; const end = index ? index.positions[at + requested.length - 1] + 1 : at + requested.length; found.push({ paragraph: source.paragraph, quote: source.text.slice(start, end) }); if (found.length > 1) return found; cursor = at + 1; }
  }
  return found;
}

/** Normalize deterministic representation details; never drop a record or invent a missing substantive claim. */
export function normalizeExtraction(input: unknown, block: ExtractionBlock): { value?: ExtractionResult; normalizedText: string; adjustments: OutputIssue[]; issues: OutputIssue[] } {
  const candidate: unknown = structuredClone(input); const adjustments: OutputIssue[] = []; const issues: OutputIssue[] = [];
  const addDefault = (target: Record<string, unknown>, name: string, fallback: unknown, path: string) => {
    if (target[name] !== undefined) return; target[name] = structuredClone(fallback); adjustments.push({ path: `${path ? path + '.' : ''}${name}`, message: `省略字段已补为 ${JSON.stringify(fallback)}` });
  };
  const cite = (target: Record<string, unknown>, path: string) => {
    const paragraph = target.paragraph; const quote = target.quote;
    const declared = block.sources.filter(source => source.paragraph === paragraph);
    if (quote === undefined || quote === '') {
      if (!Number.isInteger(paragraph) || declared.length !== 1) { issues.push({ path: `${path}.paragraph`, message: '无引文时必须提供当前片段中有效且唯一的段落编号', ...(typeof paragraph === 'number' ? { paragraph } : {}) }); return; }
      target.quote = declared[0].text; adjustments.push({ path: `${path}.quote`, message: '已根据段落编号填入当前片段可见的精确原文', paragraph: declared[0].paragraph, sourceText: declared[0].text }); return;
    }
    if (typeof quote !== 'string') return; // The strict schema reports wrong types, rather than converting them.
    if (declared.length === 1 && declared[0].text.includes(quote)) return;
    let found = matches(quote, block.sources, false);
    let adjustedTypography = false;
    if (!found.length) { found = matches(quote, block.sources, true); adjustedTypography = true; }
    if (found.length !== 1) {
      issues.push({ path: `${path}.quote`, message: found.length ? '当前片段存在多个匹配，不能自动决定引用位置' : '当前片段找不到这段引文；仅可自动对齐空白和引号差异，不能修改实际文字或其他标点', ...(typeof paragraph === 'number' ? { paragraph } : {}), quote, sourceText: declared.map(source => source.text).join('\n') }); return;
    }
    target.paragraph = found[0].paragraph; target.quote = found[0].quote;
    if (paragraph !== found[0].paragraph) adjustments.push({ path: `${path}.paragraph`, message: '已通过当前片段内唯一的原文匹配定位段落', paragraph: found[0].paragraph });
    if (adjustedTypography) adjustments.push({ path: `${path}.quote`, message: '仅按空白与引号差异唯一对齐，并恢复原文的精确写法', paragraph: found[0].paragraph, quote, sourceText: found[0].quote });
  };
  if (record(candidate)) {
    // summary and entities are intentionally required: {} or a provider error object must not turn into success.
    addDefault(candidate, 'relations', [], ''); addDefault(candidate, 'foreshadows', [], '');
    if (Array.isArray(candidate.entities)) candidate.entities.forEach((entity, index) => {
      if (!record(entity)) return; const path = `entities[${index}]`;
      addDefault(entity, 'aliases', [], path); addDefault(entity, 'description', '', path); addDefault(entity, 'visibility', 'secret', path); addDefault(entity, 'facts', [], path);
      if (Array.isArray(entity.facts)) entity.facts.forEach((fact, factIndex) => { if (!record(fact)) return; const factPath = `${path}.facts[${factIndex}]`; addDefault(fact, 'temporal', 'unknown', factPath); addDefault(fact, 'certainty', 'inference', factPath); addDefault(fact, 'visibility', 'secret', factPath);
        if (typeof fact.attribute === 'string') { const normalized = normalizeProfileAttribute(fact.attribute); if (normalized !== fact.attribute) { fact.attribute = normalized; adjustments.push({ path: `${factPath}.attribute`, message: `明确的资料属性名称已统一为 ${normalized}` }); } }
        cite(fact, factPath); });
    });
    if (Array.isArray(candidate.relations)) candidate.relations.forEach((relation, index) => { if (!record(relation)) return; addDefault(relation, 'visibility', 'secret', `relations[${index}]`); cite(relation, `relations[${index}]`); });
    if (Array.isArray(candidate.foreshadows)) candidate.foreshadows.forEach((foreshadow, index) => { if (!record(foreshadow)) return; const path = `foreshadows[${index}]`; addDefault(foreshadow, 'detail', '', path); addDefault(foreshadow, 'status', 'planned', path); addDefault(foreshadow, 'revealCondition', '', path); addDefault(foreshadow, 'relatedNames', [], path); });
  }
  const parsed = extractionSchema.safeParse(candidate);
  if (!parsed.success) for (const issue of parsed.error.issues) issues.push({ path: pathString(issue.path), message: issue.message });
  return { value: parsed.success && !issues.length ? parsed.data : undefined, normalizedText: JSON.stringify(parsed.success ? parsed.data : candidate, null, 2), adjustments, issues };
}

/** Reference names assist entity matching; author plans and unrevealed answers are never extraction evidence. */
export function extractionContext(state: StoryState, block: ExtractionBlock): string {
  const chapterOrder = new Map(state.chapters.map((chapter, index) => [chapter.id, index]));
  const entityNames = new Map(state.entities.map(entity => [entity.id, [entity.name, ...entity.aliases]]));
  for (const merged of state.entities) if (merged.mergedInto) entityNames.get(merged.mergedInto)?.push(merged.name, ...merged.aliases);
  // A new personal name may refer to an earlier unnamed character, so references are not limited to literal block matches.
  const entities = state.entities.filter(entity => !entity.mergedInto).map(entity => ({ entity, names: entityNames.get(entity.id)!, mentioned: entityNames.get(entity.id)!.some(name => name && block.text.includes(name)), recent: entity.facts.reduce((latest, fact) => Math.max(latest, chapterOrder.get(fact.citation?.chapterId ?? '') ?? -1), -1) }))
    .filter(({ entity, mentioned }) => mentioned || entity.kind === 'character' || entity.kind === 'faction')
    .sort((left, right) => Number(right.mentioned) - Number(left.mentioned) || right.recent - left.recent)
    .slice(0, 80).map(({ entity, names }) => ({ kind: entity.kind, name: entity.name, nameStatus: entity.nameStatus, isMain: entity.isMain, aliases: [...new Set(names.filter(name => name !== entity.name))] }));
  const foreshadows = state.foreshadows.filter(item => item.status === 'planted').slice(-30).map(item => ({ title: item.title, status: item.status }));
  return `名称对照（仅用于统一称呼，不是新增事实的证据）：${JSON.stringify(entities)}\n尚未揭晓的伏笔索引（不可据此推断答案）：${JSON.stringify(foreshadows)}`;
}
