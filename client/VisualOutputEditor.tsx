import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, ArrowDownToLine, Check, Plus, Quote, Trash2 } from 'lucide-react';
import type { ModelOutputDetail, OutputIssue, OutputStage } from '../shared/types';
import { kindNames } from './api';
import { displayValue, fieldId, isObject, parseIssuePath, pathKey, replaceAt, valueAt, type FormPath, type OutputObject } from './output-form';

type SourceParagraph = ModelOutputDetail['sourceParagraphs'][number];
type EditorContext = {
  value: OutputObject; issues: OutputIssue[]; sourceParagraphs: SourceParagraph[]; disabled: boolean;
  change: (path: FormPath, value: unknown) => void;
};
const Context = createContext<EditorContext | null>(null);
const useEditor = () => useContext(Context)!;
const hasPrefix = (issue: OutputIssue, path: FormPath) => {
  const candidate = pathKey(parseIssuePath(issue.path)); const expected = pathKey(path);
  return candidate === expected || candidate.startsWith(`${expected}.`);
};

function FieldFrame({ path, label, help, children }: { path: FormPath; label: string; help?: string; children: ReactNode }) {
  const { issues } = useEditor(); const relevant = issues.filter(issue => hasPrefix(issue, path)); const id = fieldId(path);
  return <div id={id} className={`visual-field ${relevant.length ? 'has-issue' : ''}`} tabIndex={-1}>
    <label htmlFor={`${id}-control`}>{label}</label>{children}
    {help && <small className="visual-field-help">{help}</small>}
    {relevant.length > 0 && <div className="visual-field-error" id={`${id}-error`}><AlertCircle size={13} /><span>上次校验：{relevant.map(issue => issue.message).join('；')}</span></div>}
  </div>;
}

function TextField({ path, label, help, rows, placeholder, omitEmpty = false }: { path: FormPath; label: string; help?: string; rows?: number; placeholder?: string; omitEmpty?: boolean }) {
  const { value, change, disabled, issues } = useEditor(); const id = fieldId(path); const invalid = issues.some(issue => hasPrefix(issue, path)); const current = valueAt(value, path);
  const common = { id: `${id}-control`, value: displayValue(current), readOnly: disabled, placeholder, 'aria-invalid': invalid, 'aria-describedby': invalid ? `${id}-error` : undefined, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => change(path, omitEmpty && event.target.value === '' ? undefined : event.target.value) };
  return <FieldFrame path={path} label={label} help={help}>{rows ? <textarea {...common} rows={rows} /> : <input {...common} />}{current === null && <><small className="visual-field-error">原值为 null，请重新填写；允许留空的内容也可明确设为空文本。</small><button className="text-button" type="button" disabled={disabled} onClick={() => change(path, omitEmpty ? undefined : '')}>设为空文本</button></>}</FieldFrame>;
}

function SelectField({ path, label, help, options, optional = false }: { path: FormPath; label: string; help?: string; options: Record<string, string>; optional?: boolean }) {
  const { value, change, disabled } = useEditor(); const raw = valueAt(value, path); const current = raw === null ? '__null-value' : displayValue(raw);
  return <FieldFrame path={path} label={label} help={help}><select id={`${fieldId(path)}-control`} value={current} disabled={disabled} onChange={event => change(path, event.target.value || undefined)}>
    <option value="">{optional ? '不指定' : '未指定（保存时由系统处理）'}</option>
    {current && !(current in options) && <option value={current} disabled={raw === null}>{raw === null ? '原值为 null，请重新选择' : `原有值：${current}`}</option>}
    {Object.entries(options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
  </select></FieldFrame>;
}

function NumberField({ path, label, help }: { path: FormPath; label: string; help?: string }) {
  const { value, change, disabled } = useEditor(); const current = valueAt(value, path); const malformed = current !== undefined && (typeof current !== 'number' || !Number.isFinite(current));
  return <FieldFrame path={path} label={label} help={help}><input id={`${fieldId(path)}-control`} type="number" min={1} step={1} readOnly={disabled} value={typeof current === 'number' && Number.isFinite(current) ? current : ''} onChange={event => change(path, event.target.value === '' ? undefined : Number(event.target.value))} />{malformed && <><small className="visual-field-error">当前值“{current === null ? 'null' : displayValue(current)}”不是数字，请重新填写；可选项也可清空。</small><button type="button" className="text-button" disabled={disabled} onClick={() => change(path, undefined)}>清空此值</button></>}</FieldFrame>;
}

function StringListField({ path, label, help }: { path: FormPath; label: string; help?: string }) {
  const { value, change, disabled } = useEditor(); const current = valueAt(value, path); const touched = useRef(false);
  const text = Array.isArray(current) ? current.map(displayValue).join('\n') : displayValue(current);
  return <FieldFrame path={path} label={label} help={help}><textarea id={`${fieldId(path)}-control`} rows={2} readOnly={disabled} value={text}
    onChange={event => { touched.current = true; change(path, event.target.value === '' ? [] : event.target.value.split('\n')); }}
    onBlur={event => { if (touched.current) { change(path, event.target.value.split('\n').map(line => line.trim()).filter(Boolean)); touched.current = false; } }} />
    {current !== undefined && !Array.isArray(current) && <><small className="visual-field-error">原来的格式不是名称列表。请按一行一个名称填写，修改后会转为列表；没有名称时可以明确设为空列表。</small><button className="text-button" type="button" disabled={disabled} onClick={() => change(path, [])}>设为空列表</button></>}
  </FieldFrame>;
}

function DeleteItem({ path, label }: { path: FormPath; label: string }) {
  const { value, change, disabled } = useEditor();
  return <button className="text-button danger-text" type="button" disabled={disabled} onClick={() => { const parent = path.slice(0, -1); const list = valueAt(value, parent); if (Array.isArray(list)) change(parent, list.filter((_, index) => index !== path.at(-1))); }}><Trash2 size={13} />{label}</button>;
}

function ListSection({ path, title, help, empty, addLabel, newItem, children }: { path: FormPath; title: string; help?: string; empty: string; addLabel: string; newItem: () => OutputObject; children: (item: unknown, path: FormPath, index: number) => ReactNode }) {
  const { value, change, disabled, issues } = useEditor(); const current = valueAt(value, path); const array = Array.isArray(current) ? current : []; const malformed = current !== undefined && !Array.isArray(current);
  return <section className="visual-list-section" id={fieldId(path)} tabIndex={-1}>
    <div className="visual-section-heading"><div><h3>{title} <span>{array.length}</span></h3>{help && <p>{help}</p>}</div><button className="button secondary small" disabled={disabled || malformed} type="button" onClick={() => change(path, [...array, newItem()])}><Plus size={13} />{addLabel}</button></div>
    {malformed ? <div className="notice"><AlertCircle size={16} /><div><p>这一项原本不是列表，无法安全展示为表单。可切到高级 JSON 保留并修复，也可移除错误内容后重新添加。</p><button type="button" className="text-button" disabled={disabled} onClick={() => { if (window.confirm(`清空“${title}”中的格式错误内容？未修改的原始响应仍会保留。`)) change(path, []); }}>清空这一项并重新填写</button></div></div> : array.length ? array.map((item, index) => children(item, [...path, index], index)) : <p className="visual-empty-hint">{empty}</p>}
    {issues.filter(issue => pathKey(parseIssuePath(issue.path)) === pathKey(path)).map((issue, index) => <p className="visual-field-error" key={index}>上次校验：{issue.message}</p>)}
  </section>;
}

function InvalidItem({ path, label }: { path: FormPath; label: string }) {
  return <div id={fieldId(path)} className="visual-invalid-item" tabIndex={-1}><p>{label}不是有效的资料对象。可删除这一项后重新添加，或切到高级 JSON 修复。</p><DeleteItem path={path} label={`删除${label}`} /></div>;
}

function CitationPicker({ path }: { path: FormPath }) {
  const { value, change, sourceParagraphs, disabled } = useEditor();
  const item = valueAt(value, path); const record = isObject(item) ? item : {};
  const chosen = sourceParagraphs.find(paragraph => paragraph.paragraph === record.paragraph);
  const invalidNumber = record.paragraph !== undefined && (typeof record.paragraph !== 'number' || !Number.isInteger(record.paragraph) || record.paragraph < 1);
  const sourceControl = useRef<HTMLTextAreaElement>(null);
  const [snippet, setSnippet] = useState(''); const [used, setUsed] = useState<{ quote: string; message: string } | null>(null);
  useEffect(() => { setSnippet(''); setUsed(null); }, [chosen?.paragraph, chosen?.text]);
  useEffect(() => {
    const control = sourceControl.current;
    if (!control || !chosen) return;
    // Native selection events also cover touch handles and programmatic accessible selection;
    // React's onSelect alone does not forward every native textarea select event.
    const capture = () => setSnippet(control.selectionEnd > control.selectionStart ? control.value.slice(control.selectionStart, control.selectionEnd) : '');
    const selectionChanged = () => { if (document.activeElement === control) capture(); };
    control.addEventListener('select', capture);
    document.addEventListener('selectionchange', selectionChanged);
    return () => { control.removeEventListener('select', capture); document.removeEventListener('selectionchange', selectionChanged); };
  }, [chosen?.paragraph, chosen?.text]);
  const hasQuote = typeof record.quote === 'string' && record.quote.length > 0;
  const matches = Boolean(chosen && hasQuote && chosen.text.includes(String(record.quote)));
  function captureSelection(control: HTMLTextAreaElement) {
    if (!chosen || control.value !== chosen.text) return;
    setSnippet(control.selectionEnd > control.selectionStart ? control.value.slice(control.selectionStart, control.selectionEnd) : '');
  }
  function useQuote(text: string, selected: boolean) {
    if (!chosen || !text || !chosen.text.includes(text) || disabled) return;
    change(path, { ...record, paragraph: chosen.paragraph, quote: text });
    setUsed({ quote: text, message: selected ? '已填入你选中的原文，保留了原始标点。' : '已填入所选段落的原文，保留了原始标点。' });
  }
  function useSelectedQuote() {
    const control = sourceControl.current;
    const current = control && control.selectionEnd > control.selectionStart ? control.value.slice(control.selectionStart, control.selectionEnd) : snippet;
    useQuote(current, true);
  }
  const paragraphPath = [...path, 'paragraph'];
  return <div className="visual-citation-picker">
    <div className="visual-citation-heading"><Quote size={14} /><strong>给这条信息找到原文依据</strong>{matches && <span><Check size={12} />引文与当前段落一致</span>}</div>
    <FieldFrame path={paragraphPath} label="引用段落" help="先选能证明这条信息的段落，再直接取用原文，避免标点或字词抄错。">
      <select id={`${fieldId(paragraphPath)}-control`} value={invalidNumber ? '__invalid-paragraph' : displayValue(record.paragraph)} disabled={disabled} onChange={event => { change(path, { ...record, paragraph: event.target.value ? Number(event.target.value) : undefined }); setSnippet(''); setUsed(null); }}>
        <option value="">请选择原文段落</option>
        {invalidNumber ? <option value="__invalid-paragraph" disabled>原有段落编号无效，请重新选择</option> : record.paragraph !== undefined && !chosen && <option value={displayValue(record.paragraph)}>第 {displayValue(record.paragraph)} 段（本次片段中不可用）</option>}
        {sourceParagraphs.map((paragraph, index) => <option key={`${paragraph.paragraph}-${index}`} value={paragraph.paragraph}>第 {paragraph.paragraph} 段 · {paragraph.text.slice(0, 42)}{paragraph.text.length > 42 ? '…' : ''}</option>)}
      </select>
    </FieldFrame>
    {chosen ? <div className="visual-quote-source">
      <label htmlFor={`${fieldId(path)}-source`}>第 {chosen.paragraph} 段原文（只读，可选中文字）</label>
      <textarea ref={sourceControl} id={`${fieldId(path)}-source`} aria-label={`第 ${chosen.paragraph} 段原文（只读，可选中文字）`} value={chosen.text} readOnly rows={Math.min(7, Math.max(3, Math.ceil(chosen.text.length / 55)))} onSelect={event => captureSelection(event.currentTarget)} onMouseUp={event => captureSelection(event.currentTarget)} onKeyUp={event => captureSelection(event.currentTarget)} onTouchEnd={event => captureSelection(event.currentTarget)} />
      <div className="row wrap"><button className="button secondary small" type="button" disabled={disabled} onClick={() => useQuote(chosen.text, false)}><ArrowDownToLine size={13} />使用整段原文</button><button className="button secondary small" type="button" disabled={disabled || !snippet} onMouseDown={event => event.preventDefault()} onClick={useSelectedQuote}><Quote size={13} />使用选中文字</button></div>
      <p className="hint">只想引用一句话？在上面的原文框中选中它，再点击“使用选中文字”。这里只显示本次任务可见的原文范围，不会修改原文。</p>
    </div> : <p className="visual-empty-hint">{sourceParagraphs.length ? '选定段落后，会在这里显示对应原文。' : '当前没有可用于核对的原文片段。请检查任务上下文，或保留现有引用并在高级 JSON 中处理；系统不会替你猜测原文。'}</p>}
    <TextField path={[...path, 'quote']} label="引用原文（可留空）" rows={3} help="留空时，保存校验会按选定段落回填证据。手动填写时，文字和标点必须逐字出自所选原文。" />
    {hasQuote && chosen && !matches && <p className="visual-inline-warning"><AlertCircle size={13} />当前引文不是这段原文中的逐字片段，建议使用上方取用原文的按钮。</p>}
    {used && record.quote === used.quote && <p className="visual-citation-success" aria-live="polite"><Check size={13} />{used.message}</p>}
  </div>;
}

const visibilityOptions = { public: '读者可见', secret: '仅作者可见' };
const temporalOptions = { current: '当前正在发生 / 当前状态', past: '过去发生的事 / 回忆', future: '未来计划 / 预告', unknown: '暂时无法确定时间' };
const certaintyOptions = { fact: '原文明确说明', inference: '根据原文推测', conflict: '与其他说法存在冲突' };
const foreshadowOptions = { planned: '计划中', planted: '已埋下', resolved: '已揭晓', abandoned: '已放弃' };
const newFact = () => ({ text: '', temporal: 'unknown', certainty: 'inference', visibility: 'secret' });
const newForeshadow = () => ({ title: '', detail: '', status: 'planned', revealCondition: '', relatedNames: [] });

function FactCard({ item, path, index }: { item: unknown; path: FormPath; index: number }) {
  if (!isObject(item)) return <InvalidItem path={path} label={`事实 ${index + 1}`} />;
  return <article id={fieldId(path)} className="visual-fact-card" tabIndex={-1}>
    <div className="row between"><h4>事实 {index + 1}</h4><DeleteItem path={path} label="删除这条事实" /></div>
    <TextField path={[...path, 'text']} label="事实内容" rows={2} help="用一句话写清人物、地点或规则发生了什么，不把猜测写成确定事实。" />
    <div className="visual-form-grid"><SelectField path={[...path, 'temporal']} label="发生时间" options={temporalOptions} help="回忆里的位置或身份，不应覆盖人物当前状态。" /><SelectField path={[...path, 'certainty']} label="可信程度" options={certaintyOptions} /></div>
    <div className="visual-form-grid"><SelectField path={[...path, 'visibility']} label="事实可见范围" options={visibilityOptions} /><TextField path={[...path, 'attribute']} label="状态类别（可选）" help="同类状态使用同一名称，方便更新。不了解当前分类时，可保持原值或留空。" omitEmpty /></div>
    <CitationPicker path={path} />
  </article>;
}

function EntityCard({ item, path, index }: { item: unknown; path: FormPath; index: number }) {
  const { issues } = useEditor();
  if (!isObject(item)) return <InvalidItem path={path} label={`资料 ${index + 1}`} />;
  return <details className="visual-record-card" id={fieldId(path)} open={index === 0 || issues.some(issue => hasPrefix(issue, path))}>
    <summary><span>{displayValue(item.name) || `资料 ${index + 1}（未命名）`}</span><small>{kindNames[item.kind as keyof typeof kindNames] || '类型未指定'} · {Array.isArray(item.facts) ? item.facts.length : 0} 条事实</small></summary>
    <div className="visual-record-body">
      <div className="row end"><DeleteItem path={path} label="删除这条资料" /></div>
      <div className="visual-form-grid"><TextField path={[...path, 'name']} label="名称" help="同一人物尽量使用统一名称，其他称呼填写到别名。" /><SelectField path={[...path, 'kind']} label="资料类型" options={kindNames} /></div>
      <StringListField path={[...path, 'aliases']} label="别名（每行一个）" help="例如另一个称呼、名字缩写。不需要时可留空。" />
      <TextField path={[...path, 'description']} label="资料描述" rows={3} help="概述原文已经说明的信息。尚未揭晓的秘密应标成仅作者可见。" />
      <SelectField path={[...path, 'visibility']} label="整条资料可见范围" options={visibilityOptions} />
      <ListSection path={[...path, 'facts']} title="事实与变化" empty="这条资料暂无事实。需要记录状态或变化时，可以添加。" addLabel="添加事实" newItem={newFact}>{(fact, factPath, factIndex) => <FactCard key={factIndex} item={fact} path={factPath} index={factIndex} />}</ListSection>
    </div>
  </details>;
}

function RelationCard({ item, path, index }: { item: unknown; path: FormPath; index: number }) {
  const { issues } = useEditor();
  if (!isObject(item)) return <InvalidItem path={path} label={`关系 ${index + 1}`} />;
  return <details className="visual-record-card" id={fieldId(path)} open={index === 0 || issues.some(issue => hasPrefix(issue, path))}>
    <summary><span>{displayValue(item.from) || '起点未填'} → {displayValue(item.to) || '终点未填'}</span><small>{displayValue(item.label) || `关系 ${index + 1}`}</small></summary>
    <div className="visual-record-body"><div className="row end"><DeleteItem path={path} label="删除这条关系" /></div>
      <div className="visual-form-grid"><TextField path={[...path, 'from']} label="关系起点" help="填写已有人物、地点等资料的名称或别名。" /><TextField path={[...path, 'to']} label="关系终点" help="必须能对应到唯一资料，不确定时先核对名称。" /></div>
      <TextField path={[...path, 'label']} label="关系说明" placeholder="例如：居住于、隶属于、师徒" />
      <SelectField path={[...path, 'visibility']} label="关系可见范围" options={visibilityOptions} />
      <CitationPicker path={path} />
    </div>
  </details>;
}

function ForeshadowCard({ item, path, index }: { item: unknown; path: FormPath; index: number }) {
  const { issues } = useEditor();
  if (!isObject(item)) return <InvalidItem path={path} label={`伏笔 ${index + 1}`} />;
  return <details className="visual-record-card" id={fieldId(path)} open={index === 0 || issues.some(issue => hasPrefix(issue, path))}>
    <summary><span>{displayValue(item.title) || `伏笔 ${index + 1}（未命名）`}</span><small>{foreshadowOptions[item.status as keyof typeof foreshadowOptions] || '状态未指定'}</small></summary>
    <div className="visual-record-body"><div className="row end"><DeleteItem path={path} label="删除这条伏笔" /></div>
      <TextField path={[...path, 'title']} label="伏笔标题" /><TextField path={[...path, 'detail']} label="隐藏内容与安排" rows={3} help="记录尚未向读者揭晓的真相，供后续创作参考。" />
      <div className="visual-form-grid"><SelectField path={[...path, 'status']} label="伏笔状态" options={foreshadowOptions} /><NumberField path={[...path, 'dueChapter']} label="计划揭晓章节（可选）" help="填写章节序号；还没决定时留空。" /></div>
      <TextField path={[...path, 'revealCondition']} label="揭晓条件" rows={2} help="什么发生时，就该让读者知道答案？" />
      <StringListField path={[...path, 'relatedNames']} label="关联资料名称（每行一个）" help="填写已有人物或其他资料的名称。暂时没有明确关联时可留空。" />
    </div>
  </details>;
}

function FineOutlineCard({ item, path, index }: { item: unknown; path: FormPath; index: number }) {
  if (!isObject(item)) return <InvalidItem path={path} label={`细纲 ${index + 1}`} />;
  return <article className="visual-fact-card" id={fieldId(path)} tabIndex={-1}>
    <div className="row between"><h4>章节安排 {index + 1}</h4><DeleteItem path={path} label="删除这条细纲" /></div>
    <div className="visual-form-grid"><NumberField path={[...path, 'chapter']} label="章节序号" /><TextField path={[...path, 'title']} label="章节标题" /></div>
    <TextField path={[...path, 'goal']} label="本章安排" rows={4} help="说明本章推进的剧情、人物变化，以及需要处理的伏笔。" />
  </article>;
}

export function VisualOutputEditor({ value, stage, issues, sourceParagraphs, disabled, onChange, focusRequest, onCannotFocus }: {
  value: OutputObject; stage: OutputStage; issues: OutputIssue[]; sourceParagraphs: SourceParagraph[]; disabled: boolean;
  onChange: (value: OutputObject) => void; focusRequest: { path: string; nonce: number } | null; onCannotFocus: () => void;
}) {
  const root = useRef<HTMLDivElement>(null); const fallback = useRef(onCannotFocus); fallback.current = onCannotFocus;
  useEffect(() => {
    if (!focusRequest) return;
    const path = parseIssuePath(focusRequest.path);
    let target: HTMLElement | null = null;
    while (path.length && !target) { const element = document.getElementById(fieldId(path)); if (element && root.current?.contains(element)) target = element; else path.pop(); }
    if (!target) { fallback.current(); return; }
    let parent: HTMLElement | null = target;
    while (parent && parent !== root.current) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
    target.classList.add('visual-field-target');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const control = target.querySelector<HTMLElement>('input, textarea, select, button');
    (control || target).focus({ preventScroll: true });
    const timer = window.setTimeout(() => target?.classList.remove('visual-field-target'), 2500);
    return () => { clearTimeout(timer); target?.classList.remove('visual-field-target'); };
  }, [focusRequest]);
  const context: EditorContext = { value, issues, sourceParagraphs, disabled, change: (path, next) => { if (!disabled) onChange(replaceAt(value, path, next)); } };
  return <Context.Provider value={context}><div className="visual-output-editor" ref={root}>
    {stage === 'extraction' ? <>
      <TextField path={['summary']} label="本段摘要" rows={3} help="用几句话概括本次原文片段中已经发生的事，不写未来剧情或未揭晓的答案。" />
      <ListSection path={['entities']} title="人物、地点与其他资料" help="每张卡片对应一项资料；需要修改的具体变化放在卡片内的事实中。" empty="本次没有提取到资料。需要补充人物、地点或规则时，可以添加。" addLabel="添加资料" newItem={() => ({ kind: 'character', name: '', aliases: [], description: '', visibility: 'secret', facts: [] })}>{(item, path, index) => <EntityCard key={index} item={item} path={path} index={index} />}</ListSection>
      <ListSection path={['relations']} title="资料之间的关系" help="例如人物位于某地、组织隶属、师徒或亲属关系。" empty="本次没有需要新增的关系，可保持为空。" addLabel="添加关系" newItem={() => ({ from: '', to: '', label: '', visibility: 'secret' })}>{(item, path, index) => <RelationCard key={index} item={item} path={path} index={index} />}</ListSection>
    </> : <>
      <TextField path={['coarse']} label="故事粗大纲" rows={6} help="提供故事的大致方向，可随发展调整。" />
      <ListSection path={['fine']} title="章节细纲" help="核对当前待写章节与接下来三章的安排，章节序号应与故事进度一致。" empty="暂时没有章节安排，请添加需要规划的章节。" addLabel="添加细纲" newItem={() => ({ chapter: Array.isArray(value.fine) ? Math.max(0, ...value.fine.filter(isObject).map(item => typeof item.chapter === 'number' ? item.chapter : 0)) + 1 : 1, title: '', goal: '' })}>{(item, path, index) => <FineOutlineCard key={index} item={item} path={path} index={index} />}</ListSection>
    </>}
    <ListSection path={['foreshadows']} title="伏笔与隐藏安排" help="这里的内容只供作者查看，不会出现在普通阅读资料中。" empty="本次没有新增伏笔，可保持为空。" addLabel="添加伏笔" newItem={newForeshadow}>{(item, path, index) => <ForeshadowCard key={index} item={item} path={path} index={index} />}</ListSection>
  </div></Context.Provider>;
}
