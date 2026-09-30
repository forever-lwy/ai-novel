import type { ProviderConfig } from '../shared/types.js';

export const DEFAULT_MODEL_TIMEOUT_MS = 180_000;

/** Validate before saving and again against the effective per-request token limit. */
export function validateProviderOptions(config: ProviderConfig, effectiveTokens = config.maxOutputTokens): void {
  const number = (name: keyof ProviderConfig, label: string, min: number, max: number, integer = false) => {
    const value = config[name];
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`${label}必须是 ${min} 到 ${max} 之间的${integer ? '整数' : '数值'}。`);
    }
  };
  if (!Number.isSafeInteger(effectiveTokens) || effectiveTokens < 1) throw new Error('模型输出上限必须是正整数。');
  number('temperature', '温度', 0, config.protocol === 'claude' ? 1 : 2);
  number('topP', 'Top P', 0, 1);
  number('topK', 'Top K', config.protocol === 'gemini' ? 1 : 0, 1_000_000, true);
  number('presencePenalty', '存在惩罚', -2, 2);
  number('frequencyPenalty', '频率惩罚', -2, 2);
  number('seed', '随机种子', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true);
  number('timeoutMs', '请求超时（毫秒）', 1000, 3_600_000, true);
  if (config.stream !== undefined && typeof config.stream !== 'boolean') throw new Error('流式接收设置必须是布尔值。');
  if (config.geminiIncludeThoughts !== undefined && typeof config.geminiIncludeThoughts !== 'boolean') throw new Error('Gemini 思考摘要设置必须是布尔值。');
  const stopLimit = config.protocol === 'openai-chat' ? 4 : config.protocol === 'gemini' ? 5 : 16;
  if (config.stopSequences !== undefined && (!Array.isArray(config.stopSequences) || config.stopSequences.length > stopLimit || config.stopSequences.some(value => typeof value !== 'string' || !value.length || value.length > 1000))) {
    throw new Error(`停止词必须是非空文本数组，最多 ${stopLimit} 项，每项最多 1000 字符。`);
  }
  if (config.openaiMaxTokensField !== undefined && !['max_tokens', 'max_completion_tokens'].includes(config.openaiMaxTokensField)) throw new Error('OpenAI 输出上限字段无效。');
  if (config.reasoningEffort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(config.reasoningEffort)) throw new Error('OpenAI 思考等级无效。');
  if (config.geminiThinking !== undefined) {
    const thinking = config.geminiThinking;
    if (!thinking || typeof thinking !== 'object') throw new Error('Gemini 思考设置无效。');
    if (thinking.mode === 'level') {
      if (!['minimal', 'low', 'medium', 'high'].includes(thinking.level) || 'budget' in thinking) throw new Error('Gemini 思考等级与预算不能同时设置。');
    } else if (thinking.mode === 'budget') {
      if (!Number.isSafeInteger(thinking.budget) || thinking.budget < -1 || thinking.budget > 1_000_000 || 'level' in thinking) throw new Error('Gemini 思考预算必须是 -1、0 或不超过 1000000 的正整数，且不能同时设置等级。');
    } else throw new Error('Gemini 思考模式无效。');
  }
  if (config.claudeEffort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(config.claudeEffort)) throw new Error('Claude 努力等级无效。');
  if (config.claudeThinking !== undefined) {
    const thinking = config.claudeThinking;
    if (!thinking || typeof thinking !== 'object' || !['disabled', 'enabled', 'adaptive'].includes(thinking.type)) throw new Error('Claude 思考模式无效。');
    if (thinking.type === 'enabled' && (!Number.isSafeInteger(thinking.budgetTokens) || thinking.budgetTokens < 1024 || thinking.budgetTokens > 128000)) throw new Error('Claude 手动思考预算必须是 1024 到 128000 之间的整数。');
    if (thinking.type !== 'enabled' && 'budgetTokens' in thinking) throw new Error('Claude 只有手动思考模式能设置预算。');
    if (config.protocol === 'claude' && thinking.type === 'enabled' && thinking.budgetTokens >= effectiveTokens) throw new Error('Claude 思考预算必须小于本次实际输出上限，请为正文预留空间。');
    if (config.protocol === 'claude' && thinking.type !== 'disabled') {
      if (config.temperature !== undefined && config.temperature !== 1) throw new Error('Claude 开启思考时，温度请留空或设为 1。');
      if (config.topK !== undefined) throw new Error('Claude 开启思考时不能设置 Top K。');
      if (config.topP !== undefined && config.topP < 0.95) throw new Error('Claude 开启思考时，Top P 请留空或设为 0.95 到 1。');
    }
  }
}

/** Only explicitly supplied, protocol-supported settings enter the wire request. */
export function providerWireOptions(config: ProviderConfig): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const put = (field: keyof ProviderConfig, wire: string) => { if (config[field] !== undefined) result[wire] = config[field]; };
  put('temperature', 'temperature');
  put('topP', config.protocol === 'gemini' ? 'topP' : 'top_p');
  if (config.protocol === 'gemini' || config.protocol === 'claude') put('topK', config.protocol === 'gemini' ? 'topK' : 'top_k');
  if (config.protocol === 'openai-chat' || config.protocol === 'gemini') {
    put('presencePenalty', config.protocol === 'gemini' ? 'presencePenalty' : 'presence_penalty');
    put('frequencyPenalty', config.protocol === 'gemini' ? 'frequencyPenalty' : 'frequency_penalty');
    put('seed', 'seed');
  }
  if (config.stopSequences?.length && config.protocol !== 'openai-responses') result[config.protocol === 'gemini' ? 'stopSequences' : config.protocol === 'claude' ? 'stop_sequences' : 'stop'] = config.stopSequences;
  if (config.reasoningEffort !== undefined) {
    if (config.protocol === 'openai-chat') result.reasoning_effort = config.reasoningEffort;
    if (config.protocol === 'openai-responses') result.reasoning = { effort: config.reasoningEffort };
  }
  if (config.protocol === 'gemini' && (config.geminiThinking || config.geminiIncludeThoughts !== undefined)) {
    result.thinkingConfig = { ...(config.geminiThinking ? config.geminiThinking.mode === 'level' ? { thinkingLevel: config.geminiThinking.level } : { thinkingBudget: config.geminiThinking.budget } : {}), ...(config.geminiIncludeThoughts !== undefined ? { includeThoughts: config.geminiIncludeThoughts } : {}) };
  }
  if (config.protocol === 'claude') {
    if (config.claudeThinking) result.thinking = config.claudeThinking.type === 'enabled' ? { type: 'enabled', budget_tokens: config.claudeThinking.budgetTokens } : { type: config.claudeThinking.type };
    if (config.claudeEffort !== undefined) result.output_config = { effort: config.claudeEffort };
  }
  return result;
}
