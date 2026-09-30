import { describe, expect, it } from 'vitest';
import { buildRequestSnapshot, validateProviderOptions } from '../server/providers.js';
import type { ProviderConfig, ProviderProtocol } from '../shared/types.js';

function config(protocol: ProviderProtocol, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'test', name: 'fixture', protocol, baseUrl: 'https://example.invalid/v1', model: 'fixture-model', maxOutputTokens: 4096, contextTokens: 16000, ...extra };
}
function body(protocol: ProviderProtocol, extra: Partial<ProviderConfig> = {}) { return JSON.parse(buildRequestSnapshot(config(protocol, extra), { system: '小说规则', prompt: '写一段正文' }).body); }

describe('optional provider parameters', () => {
  it('does not invent optional defaults and keeps zero-valued sampling settings', () => {
    const empty = body('openai-chat');
    expect(empty).not.toHaveProperty('temperature'); expect(empty).not.toHaveProperty('reasoning_effort'); expect(empty.stream).toBe(false);
    const mapped = body('openai-chat', { temperature: 0, topP: 0, presencePenalty: 0, frequencyPenalty: 0, seed: 0, stopSequences: ['终章'], reasoningEffort: 'none', openaiMaxTokensField: 'max_completion_tokens' });
    expect(mapped).toMatchObject({ temperature: 0, top_p: 0, presence_penalty: 0, frequency_penalty: 0, seed: 0, stop: ['终章'], reasoning_effort: 'none', max_completion_tokens: 4096 });
    expect(mapped).not.toHaveProperty('max_tokens');
  });
  it('maps Gemini settings only inside generationConfig, including dynamic and disabled thinking', () => {
    expect(body('gemini', { temperature: 0.4, topP: 0.8, topK: 30, presencePenalty: -1, frequencyPenalty: 0.5, seed: 0, stopSequences: ['结束'], geminiThinking: { mode: 'budget', budget: 0 } }).generationConfig).toEqual({ maxOutputTokens: 4096, temperature: 0.4, topP: 0.8, topK: 30, presencePenalty: -1, frequencyPenalty: 0.5, seed: 0, stopSequences: ['结束'], thinkingConfig: { thinkingBudget: 0 } });
    expect(body('gemini', { geminiThinking: { mode: 'budget', budget: -1 } }).generationConfig.thinkingConfig).toEqual({ thinkingBudget: -1 });
    expect(body('gemini', { geminiThinking: { mode: 'level', level: 'low' } }).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
  });
  it('sends Gemini thought summaries independently and keeps explicit false without changing the thinking mode', () => {
    expect(body('gemini').generationConfig).not.toHaveProperty('thinkingConfig');
    expect(body('gemini', { geminiIncludeThoughts: true, geminiThinking: { mode: 'level', level: 'high' } }).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: true });
    expect(body('gemini', { geminiIncludeThoughts: false, geminiThinking: { mode: 'budget', budget: 0 } }).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0, includeThoughts: false });
    expect(body('gemini', { geminiIncludeThoughts: false }).generationConfig.thinkingConfig).toEqual({ includeThoughts: false });
    for (const protocol of ['openai-chat', 'openai-responses', 'claude'] as const) expect(body(protocol, { geminiIncludeThoughts: true })).not.toHaveProperty('thinkingConfig');
    expect(() => validateProviderOptions(config('gemini', { geminiIncludeThoughts: 'true' } as any))).toThrow('布尔值');
  });
  it('maps Responses effort and excludes Chat-only parameters', () => {
    const mapped = body('openai-responses', { topK: 10, temperature: 1, topP: 0.9, seed: 42, presencePenalty: 1, frequencyPenalty: 1, stopSequences: ['stop'], reasoningEffort: 'high', openaiMaxTokensField: 'max_completion_tokens' });
    expect(mapped).toMatchObject({ temperature: 1, top_p: 0.9, reasoning: { effort: 'high' }, max_output_tokens: 4096 });
    for (const key of ['top_k', 'seed', 'presence_penalty', 'frequency_penalty', 'stop', 'max_completion_tokens', 'reasoning_effort']) expect(mapped).not.toHaveProperty(key);
  });
  it('maps Claude budget and effort separately and supports explicit disabled/adaptive modes', () => {
    expect(body('claude', { claudeThinking: { type: 'enabled', budgetTokens: 1024 }, claudeEffort: 'high', topP: 0.95, temperature: 1, stopSequences: ['结束'] })).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'high' }, temperature: 1, top_p: 0.95, stop_sequences: ['结束'] });
    expect(body('claude', { claudeThinking: { type: 'disabled' }, temperature: 0, topK: 0 })).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0, top_k: 0 });
    expect(body('claude', { claudeThinking: { type: 'adaptive' }, claudeEffort: 'max' })).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } });
  });
  it('validates the effective per-request token cap instead of only the saved cap', () => {
    const value = config('claude', { claudeThinking: { type: 'enabled', budgetTokens: 2048 } });
    expect(() => validateProviderOptions(value)).not.toThrow();
    expect(() => validateProviderOptions(value, 2048)).toThrow('本次实际输出上限');
    expect(() => buildRequestSnapshot(value, { system: '', prompt: '短文', maxOutputTokens: 512 })).toThrow('本次实际输出上限');
  });
  it.each([
    { temperature: 2.1 }, { temperature: NaN }, { topP: -0.1 }, { topK: 0.5 }, { presencePenalty: 2.1 }, { frequencyPenalty: Infinity }, { seed: 0.5 }, { timeoutMs: 0 }, { timeoutMs: 3_600_001 }, { stopSequences: [''] }, { stopSequences: ['1', '2', '3', '4', '5'] },
  ])('rejects invalid basic options %j', extra => { expect(() => validateProviderOptions(config('openai-chat', extra))).toThrow(); });
  it.each([
    { claudeThinking: { type: 'enabled', budgetTokens: 100 } },
    { claudeThinking: { type: 'enabled', budgetTokens: 4096 } },
    { claudeThinking: { type: 'adaptive' }, temperature: 0.5 },
    { claudeThinking: { type: 'enabled', budgetTokens: 1024 }, topK: 1 },
    { claudeThinking: { type: 'adaptive' }, topP: 0.94 },
  ] as Partial<ProviderConfig>[])('rejects incompatible Claude thinking options %j', extra => { expect(() => validateProviderOptions(config('claude', extra))).toThrow(); });
  it('rejects mutually present Gemini level and budget even from an untyped JSON input', () => {
    expect(() => validateProviderOptions(config('gemini', { geminiThinking: { mode: 'level', level: 'low', budget: 1000 } } as any))).toThrow('不能同时');
  });
  it('provides a redacted non-network preview of actual headers/body/path', () => {
    const result = buildRequestSnapshot(config('gemini', { apiKey: 'fixture-secret', baseUrl: 'https://example.invalid/v1beta?key=url-secret&route=fixture&access_token=another-secret', stream: true, timeoutMs: 300000, geminiThinking: { mode: 'level', level: 'low' } }), { system: '明确规则', prompt: '完整正文 fixture-secret' });
    expect(result).toMatchObject({ protocol: 'gemini', stream: true, timeoutMs: 300000, headers: { 'x-goog-api-key': '[REDACTED]', Accept: 'text/event-stream' } });
    expect(result.url).toContain('/models/fixture-model:streamGenerateContent'); expect(result.url).toContain('alt=sse'); expect(result.url).toContain('route=fixture');
    expect(result.body).toContain('明确规则'); expect(result.body).toContain('完整正文 [REDACTED]');
    for (const secret of ['fixture-secret', 'url-secret', 'another-secret']) expect(JSON.stringify(result)).not.toContain(secret);
  });
});
