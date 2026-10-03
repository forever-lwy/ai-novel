import { describe, expect, it } from 'vitest';
import { defaultModelParameters, getModelParameters, normalizeModelSettings, resolveModelConfig, upsertModelParameters } from '../shared/model-settings.js';
import type { ModelParameterProfile, ModelParameters, Settings } from '../shared/types.js';

const roles = ['writing', 'planning', 'extraction'] as const;

function settings(): Settings {
  return {
    providers: [
      { id: 'first', name: '首个连接', protocol: 'gemini', baseUrl: 'https://first.example.invalid/v1beta' },
      { id: 'second', name: '另一个连接', protocol: 'gemini', baseUrl: 'https://second.example.invalid/v1beta' },
    ],
    writingProviderId: 'first', planningProviderId: 'first', extractionProviderId: 'first',
    writingModel: 'writer', planningModel: 'planner', extractionModel: 'extractor',
  };
}

describe('parameters for each task, connection and model', () => {
  it('gives unconfigured models useful fresh defaults without sharing a mutable object', () => {
    const defaults = { maxOutputTokens: 4096, contextTokens: 64000, temperature: 1, topP: 1, presencePenalty: 0, frequencyPenalty: 0, timeoutMs: 180000, stream: false };
    const first = defaultModelParameters();
    first.maxOutputTokens = 999;
    first.temperature = 0;
    expect(defaultModelParameters()).toEqual(defaults);
    const missing = getModelParameters(settings(), 'writing', 'first', 'new-model');
    missing.contextTokens = 1000;
    for (const role of roles) expect(getModelParameters(settings(), role, 'first', 'new-model')).toEqual(defaults);
    expect(getModelParameters(settings(), 'writing', 'second', 'new-model')).toEqual(defaults);
  });

  it('restores a task profile when switching models or connections without reading another task profile', () => {
    let config = upsertModelParameters(settings(), 'writing', 'first', 'writer', { maxOutputTokens: 2048, contextTokens: 32000, temperature: 0.4 });
    config = upsertModelParameters(config, 'writing', 'first', 'other-model', { maxOutputTokens: 8192, contextTokens: 128000, temperature: 0.9 });
    config = upsertModelParameters(config, 'writing', 'second', 'writer', { maxOutputTokens: 1024, contextTokens: 16000, temperature: 0.2 });
    config = upsertModelParameters(config, 'extraction', 'first', 'writer', { maxOutputTokens: 64000, contextTokens: 512000, temperature: 0 });
    config = normalizeModelSettings({ ...config, writingModel: 'other-model' });
    expect(resolveModelConfig(config, config.providers[0], config.writingModel!, 'writing')).toMatchObject({ model: 'other-model', maxOutputTokens: 8192, temperature: 0.9 });
    config = normalizeModelSettings({ ...config, writingProviderId: 'second', writingModel: 'writer' });
    expect(resolveModelConfig(config, config.providers[1], config.writingModel!, 'writing')).toMatchObject({ model: 'writer', maxOutputTokens: 1024, temperature: 0.2 });
    config = normalizeModelSettings({ ...config, writingProviderId: 'first', writingModel: 'writer' });
    expect(resolveModelConfig(config, config.providers[0], config.writingModel!, 'writing')).toMatchObject({ model: 'writer', maxOutputTokens: 2048, temperature: 0.4 });
    expect(getModelParameters(config, 'extraction', 'first', 'writer')).toEqual({ maxOutputTokens: 64000, contextTokens: 512000, temperature: 0 });
    expect(getModelParameters(config, 'writing', 'first', 'other-model').maxOutputTokens).toBe(8192);
  });

  it('keeps planning and extraction independent when all tasks select the same connection and model', () => {
    let config = normalizeModelSettings({ ...settings(), planningModel: 'writer', extractionModel: 'writer' });
    config = upsertModelParameters(config, 'planning', 'first', 'writer', { maxOutputTokens: 8192, contextTokens: 128000, temperature: 0.6, stopSequences: ['规划停止'], geminiThinking: { mode: 'budget', budget: 2048 } });
    config = upsertModelParameters(config, 'extraction', 'first', 'writer', { maxOutputTokens: 64000, contextTokens: 512000, temperature: 0, stopSequences: ['提取停止'], geminiThinking: { mode: 'budget', budget: 4096 } });
    const extraction = getModelParameters(config, 'extraction', 'first', 'writer');
    const planning = getModelParameters(config, 'planning', 'first', 'writer');
    planning.stopSequences!.push('规划新停止');
    if (planning.geminiThinking?.mode === 'budget') planning.geminiThinking.budget = 1024;
    config = upsertModelParameters(config, 'planning', 'first', 'writer', planning);
    expect(getModelParameters(config, 'writing', 'first', 'writer')).toEqual(defaultModelParameters());
    expect(getModelParameters(config, 'extraction', 'first', 'writer')).toEqual(extraction);
    expect(getModelParameters(config, 'planning', 'first', 'writer')).toMatchObject({ stopSequences: ['规划停止', '规划新停止'], geminiThinking: { mode: 'budget', budget: 1024 } });
    expect(config.modelParameters!.filter(profile => profile.providerId === 'first' && profile.model === 'writer')).toHaveLength(3);
  });

  it('keeps cleared optional fields cleared when legacy connection values are still present', () => {
    const original = settings();
    original.providers[0] = { ...original.providers[0], maxOutputTokens: 64000, contextTokens: 512000, temperature: 0.2, topP: 0.8, stream: true, geminiThinking: { mode: 'budget', budget: 4096 } };
    original.modelParameters = [{ role: 'writing', providerId: 'first', model: 'writer', maxOutputTokens: 2048, contextTokens: 32000 }];
    const normalized = normalizeModelSettings(original);
    expect(getModelParameters(normalized, 'writing', 'first', 'writer')).toEqual({ maxOutputTokens: 2048, contextTokens: 32000 });
    const resolved = resolveModelConfig(normalized, normalized.providers[0], 'writer', 'writing');
    for (const key of ['role', 'temperature', 'topP', 'stream', 'geminiThinking']) expect(resolved).not.toHaveProperty(key);
    expect(normalizeModelSettings(normalized)).toEqual(normalized);
  });

  it('migrates legacy connection parameters only to assigned task models with independent nested values', () => {
    const original = { ...settings(), planningModel: 'writer', extractionModel: 'writer' };
    original.providers[0] = { ...original.providers[0], model: 'legacy-unassigned-model', maxOutputTokens: 8192, contextTokens: 128000, temperature: 0, stopSequences: ['终章'], geminiThinking: { mode: 'budget', budget: 1024 } };
    const normalized = normalizeModelSettings(original);
    for (const role of roles) expect(getModelParameters(normalized, role, 'first', 'writer')).toEqual({ maxOutputTokens: 8192, contextTokens: 128000, temperature: 0, stopSequences: ['终章'], geminiThinking: { mode: 'budget', budget: 1024 } });
    expect(normalized.providers[0]).toEqual(settings().providers[0]);
    expect(getModelParameters(normalized, 'writing', 'first', 'legacy-unassigned-model')).toEqual(defaultModelParameters());
    const planning = normalized.modelParameters!.find(profile => profile.role === 'planning')!;
    planning.stopSequences!.push('后记');
    if (planning.geminiThinking?.mode === 'budget') planning.geminiThinking.budget = 2048;
    expect(getModelParameters(normalized, 'extraction', 'first', 'writer')).toMatchObject({ stopSequences: ['终章'], geminiThinking: { mode: 'budget', budget: 1024 } });
    expect(original.providers[0]).toMatchObject({ stopSequences: ['终章'], geminiThinking: { mode: 'budget', budget: 1024 } });
    expect(normalizeModelSettings(normalized)).toEqual(normalized);
  });

  it('does not mutate saved profiles when a caller edits returned or submitted nested parameters', () => {
    const submitted: ModelParameters = { maxOutputTokens: 4096, contextTokens: 64000, stopSequences: ['终章'], geminiThinking: { mode: 'budget', budget: 1024 } };
    const original = settings();
    const config = upsertModelParameters(original, 'writing', 'first', ' writer ', submitted);
    submitted.stopSequences!.push('提交后修改');
    if (submitted.geminiThinking?.mode === 'budget') submitted.geminiThinking.budget = 2048;
    const returned = getModelParameters(config, 'writing', 'first', 'writer');
    returned.stopSequences!.push('读取后修改');
    if (returned.geminiThinking?.mode === 'budget') returned.geminiThinking.budget = 4096;
    expect(getModelParameters(config, 'writing', 'first', ' writer ')).toEqual({ maxOutputTokens: 4096, contextTokens: 64000, stopSequences: ['终章'], geminiThinking: { mode: 'budget', budget: 1024 } });
    expect(getModelParameters(config, 'planning', 'first', 'writer')).toEqual(defaultModelParameters());
    expect(config.modelParameters![0]).toMatchObject({ role: 'writing', model: 'writer' });
    expect(original.modelParameters).toBeUndefined();
  });

  it.each([true, false])('prioritizes explicit task profiles over shared legacy profiles regardless of order (modern first=%s)', modernFirst => {
    const legacy: ModelParameterProfile = { providerId: 'first', model: 'writer', maxOutputTokens: 8192, contextTokens: 128000, temperature: 0.2, stopSequences: ['旧停止'], geminiThinking: { mode: 'budget', budget: 1024 } };
    const modern: ModelParameterProfile = { role: 'writing', providerId: 'first', model: 'writer', maxOutputTokens: 2048, contextTokens: 32000 };
    const original: Settings = { ...settings(), planningModel: 'writer', extractionModel: 'writer', modelParameters: modernFirst ? [modern, legacy] : [legacy, modern] };
    const normalized = normalizeModelSettings(original);
    expect(getModelParameters(normalized, 'writing', 'first', 'writer')).toEqual({ maxOutputTokens: 2048, contextTokens: 32000 });
    for (const role of ['planning', 'extraction'] as const) expect(getModelParameters(normalized, role, 'first', 'writer')).toMatchObject({ maxOutputTokens: 8192, contextTokens: 128000, temperature: 0.2, stopSequences: ['旧停止'], geminiThinking: { mode: 'budget', budget: 1024 } });
    expect(normalized.modelParameters).toHaveLength(3);
    expect(normalized.modelParameters!.every(profile => roles.includes(profile.role!))).toBe(true);
    const planning = normalized.modelParameters!.find(profile => profile.role === 'planning')!;
    planning.stopSequences!.push('新停止');
    if (planning.geminiThinking?.mode === 'budget') planning.geminiThinking.budget = 2048;
    expect(getModelParameters(normalized, 'extraction', 'first', 'writer')).toMatchObject({ stopSequences: ['旧停止'], geminiThinking: { mode: 'budget', budget: 1024 } });
    expect(legacy.stopSequences).toEqual(['旧停止']);
    expect(normalizeModelSettings(normalized)).toEqual(normalized);
  });

  it('preserves dormant shared legacy profiles for later model selection without repopulating cleared optional fields', () => {
    const original: Settings = { ...settings(), modelParameters: [{ providerId: 'first', model: 'dormant', maxOutputTokens: 1024, contextTokens: 16000 }] };
    const normalized = normalizeModelSettings(original);
    for (const role of roles) expect(getModelParameters(normalized, role, 'first', 'dormant')).toEqual({ maxOutputTokens: 1024, contextTokens: 16000 });
    const switched = normalizeModelSettings({ ...normalized, planningModel: 'dormant' });
    expect(resolveModelConfig(switched, switched.providers[0], switched.planningModel!, 'planning')).toMatchObject({ model: 'dormant', maxOutputTokens: 1024, contextTokens: 16000 });
    expect(switched.modelParameters).toHaveLength(normalized.modelParameters!.length);
    expect(normalizeModelSettings(switched)).toEqual(switched);
  });
});
