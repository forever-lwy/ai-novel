import { useEffect, useState } from 'react';
import type { ModelParameters, ProviderConfig, ProviderProtocol } from '../shared/types';

const effortLabels = { none: 'none · 关闭', minimal: 'minimal · 最少', low: 'low · 较低', medium: 'medium · 中等', high: 'high · 较高', xhigh: 'xhigh · 更高', max: 'max · 最大' };
const activeThinking = (parameters: ModelParameters, protocol: ProviderProtocol) => protocol === 'claude' && ['enabled', 'adaptive'].includes(parameters.claudeThinking?.type || '');

export function parameterError(parameters: ModelParameters, protocol: ProviderProtocol): string | undefined;
export function parameterError(provider: ProviderConfig): string | undefined;
export function parameterError(parameters: ModelParameters & { protocol?: ProviderProtocol }, protocol = parameters.protocol): string | undefined {
  if (protocol === 'openai-chat' && parameters.stopSequences && parameters.stopSequences.length > 4) return 'Chat 接口最多填写 4 条停止序列。';
  if (protocol === 'gemini' && parameters.stopSequences && parameters.stopSequences.length > 5) return 'Gemini 接口最多填写 5 条停止序列。';
  if (protocol !== 'openai-responses' && parameters.stopSequences && parameters.stopSequences.length > 16) return '最多填写 16 条停止序列。';
  if (protocol !== 'openai-responses' && parameters.stopSequences?.some(value => value.length > 1000)) return '每条停止序列最多 1000 个字符。';
  if (protocol && activeThinking(parameters, protocol)) {
    if (parameters.temperature !== undefined && parameters.temperature !== 1) return 'Claude 开启思考时，温度需留空或设为 1。';
    if (parameters.topK !== undefined) return 'Claude 开启思考时，请清空 Top K，使它不随请求发送。';
    if (parameters.topP !== undefined && parameters.topP < 0.95) return 'Claude 开启思考时，Top P 需留空或不小于 0.95。';
    if (parameters.claudeThinking?.type === 'enabled' && parameters.claudeThinking.budgetTokens >= parameters.maxOutputTokens) return 'Claude 的思考预算必须小于单次最大输出 tokens。';
  }
  return undefined;
}

function OptionalNumber({ label, value, min, max, step = 'any', hint, onChange }: { label: string; value: number | undefined; min?: number; max?: number; step?: number | 'any'; hint?: string; onChange: (value: number | undefined) => void }) {
  return <label>{label}<input aria-label={label} type="number" value={value ?? ''} min={min} max={max} step={step} placeholder="不发送，使用服务默认值" onChange={event => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />{hint && <span className="hint">{hint}</span>}</label>;
}

function RequiredInteger({ label, value, min, max, onChange }: { label: string; value: number; min: number; max?: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <input aria-label={label} required type="number" step={1} min={min} max={max} value={text} onChange={event => { const next = event.target.value; setText(next); if (next !== '' && Number.isSafeInteger(Number(next))) onChange(Number(next)); }} />;
}

export function ProviderParameters({ parameters, protocol, onChange, onReset }: { parameters: ModelParameters; protocol: ProviderProtocol; onChange: (patch: Partial<ModelParameters>) => void; onReset: () => void }) {
  const openai = protocol === 'openai-chat' || protocol === 'openai-responses';
  const gemini = protocol === 'gemini'; const claude = protocol === 'claude'; const thinking = activeThinking(parameters, protocol);
  const hasOtherSettings = (!openai && parameters.reasoningEffort !== undefined)
    || (!gemini && (parameters.geminiThinking !== undefined || parameters.geminiIncludeThoughts !== undefined))
    || (!claude && (parameters.claudeThinking !== undefined || parameters.claudeEffort !== undefined))
    || (protocol !== 'openai-chat' && parameters.openaiMaxTokensField !== undefined)
    || (openai && parameters.topK !== undefined)
    || ((protocol === 'openai-responses' || claude) && (parameters.seed !== undefined || parameters.presencePenalty !== undefined || parameters.frequencyPenalty !== undefined))
    || (protocol === 'openai-responses' && parameters.stopSequences !== undefined);
  const issue = parameterError(parameters, protocol);
  return <div className="model-parameters form-stack">
    <div className="row between wrap"><span className="hint">每个任务独立保存参数，同模型用于不同任务也不共用。</span><button type="button" className="text-button" onClick={onReset}>恢复通用默认值</button></div>
    <div className="form-grid model-limits"><label>单次最大输出 tokens<RequiredInteger label="单次最大输出 tokens" min={256} max={128000} value={parameters.maxOutputTokens} onChange={maxOutputTokens => onChange({ maxOutputTokens })} /></label><label>上下文上限 tokens<RequiredInteger label="上下文上限 tokens" min={2048} max={2000000} value={parameters.contextTokens} onChange={contextTokens => onChange({ contextTokens })} /></label></div>
    <p className="hint">上下文上限限制每次请求输入与预留输出的合计，请按模型实际支持范围填写。历史用量只统计，不累计限额。</p>
    <details className="provider-parameters">
    <summary>生成参数与思考设置<span className="model-parameter-summary">通用默认：温度 1、Top P 1、惩罚 0、超时 180 秒、非流式</span></summary>
    <div className="provider-parameter-body form-stack">
      <p className="hint">新模型先使用通用默认值。可选参数清空后不随请求发送，数值 0 会原样保留。思考、Top K、随机种子和停止序列默认使用服务设置，请按模型实际支持范围调整。</p>
      <div className="form-grid">
        <OptionalNumber label="温度（temperature）" value={parameters.temperature} min={thinking ? 1 : 0} max={claude ? 1 : 2} step="any" onChange={temperature => onChange({ temperature })} hint={thinking ? 'Claude 开启思考时仅可留空或填 1。' : '控制措辞变化程度；0 通常更稳定。部分推理模型不接受自定义温度。'} />
        <OptionalNumber label="Top P" value={parameters.topP} min={thinking ? 0.95 : 0} max={1} onChange={topP => onChange({ topP })} hint={thinking ? 'Claude 开启思考时需留空或至少 0.95。' : '控制候选词范围。一般先调整温度，不必同时修改两项。'} />
        {(gemini || claude) && <OptionalNumber label="Top K" value={parameters.topK} min={gemini ? 1 : 0} max={1000000} step={1} onChange={topK => onChange({ topK })} hint={thinking ? '当前思考方式不允许 Top K，请清空已有值。' : '限制候选词数量；仅向支持的接口发送。'} />}
        {(protocol === 'openai-chat' || gemini) && <OptionalNumber label="随机种子（seed）" value={parameters.seed} min={Number.MIN_SAFE_INTEGER} max={Number.MAX_SAFE_INTEGER} step={1} onChange={seed => onChange({ seed })} hint="相同种子有助于对照请求，但不保证每次结果完全相同。" />}
      </div>
      {(protocol === 'openai-chat' || gemini) && <div className="form-grid">
        <OptionalNumber label="存在惩罚（presence penalty）" value={parameters.presencePenalty} min={-2} max={2} onChange={presencePenalty => onChange({ presencePenalty })} hint="调整重复话题的倾向；通用默认 0 表示不施加惩罚。" />
        <OptionalNumber label="频率惩罚（frequency penalty）" value={parameters.frequencyPenalty} min={-2} max={2} onChange={frequencyPenalty => onChange({ frequencyPenalty })} hint="调整重复词句的倾向；通用默认 0 表示不施加惩罚。" />
      </div>}
      {protocol !== 'openai-responses' && <label>停止序列（每行一条）<textarea aria-label="停止序列（每行一条）" rows={3} value={parameters.stopSequences?.join('\n') ?? ''} placeholder="留空不发送，例如输入一个明确的结束标记" onChange={event => onChange({ stopSequences: event.target.value === '' ? undefined : event.target.value.split('\n') })} onBlur={event => { const values = event.target.value.split('\n').filter(value => value.length > 0); onChange({ stopSequences: values.length ? values : undefined }); }} /><span className="hint">{protocol === 'openai-chat' ? '最多 4 条。' : gemini ? '最多 5 条。' : '最多 16 条。'}每条最多 1000 字符。按原样发送，不自动解释转义字符；命中后模型可能提前结束正文。</span></label>}
      {openai && <label>思考等级（OpenAI）<select aria-label="思考等级（OpenAI）" value={parameters.reasoningEffort ?? ''} onChange={event => onChange({ reasoningEffort: event.target.value ? event.target.value as ModelParameters['reasoningEffort'] : undefined })}><option value="">服务默认（不发送）</option>{Object.entries(effortLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><span className="hint">这些值供支持推理参数的模型选择，不代表当前模型全部支持。留空可避免发送 reasoning 参数。</span></label>}
      {protocol === 'openai-chat' && <label>输出上限字段（Chat）<select aria-label="输出上限字段（Chat）" value={parameters.openaiMaxTokensField ?? ''} onChange={event => onChange({ openaiMaxTokensField: event.target.value ? event.target.value as ModelParameters['openaiMaxTokensField'] : undefined })}><option value="">应用默认（max_tokens）</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select><span className="hint">根据服务实际支持的字段选择。只发送一个输出上限字段，不会同时发送两种。</span></label>}
      {gemini && <div className="thinking-config form-stack">
        <label>Gemini 返回思考摘要<select aria-label="Gemini 返回思考摘要" value={parameters.geminiIncludeThoughts === undefined ? '' : parameters.geminiIncludeThoughts ? 'true' : 'false'} onChange={event => onChange({ geminiIncludeThoughts: event.target.value === '' ? undefined : event.target.value === 'true' })}><option value="">服务默认（不发送）</option><option value="true">返回摘要（includeThoughts: true）</option><option value="false">不返回摘要（includeThoughts: false）</option></select><span className="hint">控制响应是否包含思考摘要，不改变思考等级；正文整理会排除思考片段。流式代理可在正文之前收到摘要，但这不能保证解决网关超时或内容拦截。</span></label>
        <label>Gemini 思考方式<select aria-label="Gemini 思考方式" value={parameters.geminiThinking?.mode ?? ''} onChange={event => onChange({ geminiThinking: event.target.value === 'level' ? { mode: 'level', level: 'low' } : event.target.value === 'budget' ? { mode: 'budget', budget: -1 } : undefined })}><option value="">服务默认（不发送）</option><option value="level">按等级设置</option><option value="budget">按 token 预算设置</option></select><span className="hint">等级和预算只使用一种；切换会替换另一种设置。Gemini 3 优先使用等级，并建议先保留默认采样参数。</span></label>
        {parameters.geminiThinking?.mode === 'level' && <label>Gemini 思考等级<select aria-label="Gemini 思考等级" value={parameters.geminiThinking.level} onChange={event => onChange({ geminiThinking: { mode: 'level', level: event.target.value as 'minimal' | 'low' | 'medium' | 'high' } })}>{(['minimal', 'low', 'medium', 'high'] as const).map(value => <option key={value} value={value}>{effortLabels[value]}</option>)}</select><span className="hint">可用等级取决于模型；切回服务默认可完全不发送。</span></label>}
        {parameters.geminiThinking?.mode === 'budget' && <label>Gemini 思考预算 tokens<RequiredInteger label="Gemini 思考预算 tokens" min={-1} max={1000000} value={parameters.geminiThinking.budget} onChange={budget => onChange({ geminiThinking: { mode: 'budget', budget } })} /><span className="hint">-1 表示自动预算，0 表示关闭，正整数表示预算上限；具体支持范围以所用模型为准。</span></label>}
      </div>}
      {claude && <div className="thinking-config form-stack">
        <label>Claude 思考方式<select aria-label="Claude 思考方式" value={parameters.claudeThinking?.type ?? ''} onChange={event => onChange({ claudeThinking: event.target.value === 'enabled' ? { type: 'enabled', budgetTokens: 1024 } : event.target.value === 'adaptive' ? { type: 'adaptive' } : event.target.value === 'disabled' ? { type: 'disabled' } : undefined })}><option value="">服务默认（不发送）</option><option value="disabled">明确关闭思考</option><option value="enabled">开启思考并指定预算</option><option value="adaptive">自适应思考（adaptive）</option></select><span className="hint">不同型号支持的方式不同。预算方式与自适应方式互斥，不会混合发送。</span></label>
        {parameters.claudeThinking?.type === 'enabled' && <label>Claude 思考预算 tokens<RequiredInteger label="Claude 思考预算 tokens" min={1024} max={parameters.maxOutputTokens - 1} value={parameters.claudeThinking.budgetTokens} onChange={budgetTokens => onChange({ claudeThinking: { type: 'enabled', budgetTokens } })} /><span className="hint">至少 1024，且必须小于单次最大输出 tokens。思考也占用输出预算。</span></label>}
        <label>推理强度（Claude effort）<select aria-label="推理强度（Claude effort）" value={parameters.claudeEffort ?? ''} onChange={event => onChange({ claudeEffort: event.target.value ? event.target.value as ModelParameters['claudeEffort'] : undefined })}><option value="">服务默认（不发送）</option>{(['low', 'medium', 'high', 'xhigh', 'max'] as const).map(value => <option key={value} value={value}>{effortLabels[value]}</option>)}</select><span className="hint">仅适用于支持 effort 的型号；不确定时留空，不会根据模型名称自动猜测。</span></label>
      </div>}
      <div className="form-grid">
        <OptionalNumber label="请求超时（秒）" value={parameters.timeoutMs === undefined ? undefined : parameters.timeoutMs / 1000} min={1} max={3600} step={0.001} onChange={seconds => onChange({ timeoutMs: seconds === undefined ? undefined : Math.round(seconds * 1000) })} hint="留空使用默认 180 秒。范围 1–3600 秒；服务自身仍可能更早中断。" />
        <label>返回方式<select aria-label="返回方式" value={parameters.stream === undefined ? '' : parameters.stream ? 'true' : 'false'} onChange={event => onChange({ stream: event.target.value === '' ? undefined : event.target.value === 'true' })}><option value="">应用默认（非流式）</option><option value="false">非流式 · 完整响应</option><option value="true">流式 · 分段接收后汇总</option></select><span className="hint">只改变向模型请求的方式，工作台仍在内容完整后保存。代理可能只支持其中一种方式。</span></label>
      </div>
      {hasOtherSettings && <p className="notice">其他协议的设置仍保留，切回对应协议可继续编辑。当前请求不会发送不属于本协议的参数。</p>}
      {issue && <p className="notice error">{issue}</p>}
    </div>
    </details>
  </div>;
}
