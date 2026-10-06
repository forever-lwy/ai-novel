import type { ModelParameters, ModelRole, ProviderConfig, ProviderConnection, Settings } from './types.js';

export const modelRoles = ['writing', 'planning', 'extraction'] as const satisfies readonly ModelRole[];

export const modelParameterKeys = [
  'maxOutputTokens', 'contextTokens', 'temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed', 'stopSequences',
  'timeoutMs', 'stream', 'openaiMaxTokensField', 'reasoningEffort', 'geminiThinking', 'geminiIncludeThoughts', 'claudeThinking', 'claudeEffort',
] as const satisfies readonly (keyof ModelParameters)[];

export function defaultModelParameters(): ModelParameters {
  return { maxOutputTokens: 4096, contextTokens: 64000, temperature: 1, topP: 1, presencePenalty: 0, frequencyPenalty: 0, timeoutMs: 180000, stream: false };
}

export function getModelParameters(settings: Settings, role: ModelRole, providerId: string, model: string): ModelParameters {
  const matchesModel = (value: NonNullable<Settings['modelParameters']>[number]) => value.providerId === providerId && value.model.trim() === model.trim();
  const profile = settings.modelParameters?.find(value => value.role === role && matchesModel(value))
    ?? settings.modelParameters?.find(value => value.role === undefined && matchesModel(value));
  if (!profile) return defaultModelParameters();
  const { role: _role, providerId: _providerId, model: _model, ...parameters } = profile;
  // A missing optional field in an existing profile means the user chose the upstream default.
  return structuredClone(parameters);
}

export function upsertModelParameters(settings: Settings, role: ModelRole, providerId: string, model: string, parameters: ModelParameters): Settings {
  const name = model.trim();
  const profile = { ...structuredClone(parameters), role, providerId, model: name };
  const profiles = settings.modelParameters ?? [];
  const index = profiles.findIndex(value => value.role === role && value.providerId === providerId && value.model.trim() === name);
  return { ...settings, modelParameters: index < 0 ? [...profiles, profile] : profiles.map((value, offset) => offset === index ? profile : value) };
}

export function connectionOnly(provider: ProviderConnection): ProviderConnection {
  const { id, name, protocol, baseUrl, apiKey, hasKey, clearApiKey, hasUrlCredentials } = provider;
  return { id, name, protocol, baseUrl, ...(apiKey !== undefined ? { apiKey } : {}), ...(hasKey !== undefined ? { hasKey } : {}), ...(clearApiKey !== undefined ? { clearApiKey } : {}), ...(hasUrlCredentials ? { hasUrlCredentials: true } : {}) };
}

/** Preserve historical models while separating each task's parameters during migration. */
export function normalizeModelSettings(settings: Settings): Settings {
  const { taskTokenLimit: _taskTokenLimit, ...current } = settings as Settings & { taskTokenLimit?: unknown };
  const profiles = settings.modelParameters ?? [];
  let result: Settings = { ...current, providers: settings.providers.map(connectionOnly), modelParameters: profiles.flatMap(profile => {
    if (profile.role !== undefined) return [{ ...structuredClone(profile), model: profile.model.trim() }];
    // An explicit task profile wins even when it occurs after the legacy shared profile.
    return modelRoles.filter(role => !profiles.some(value => value.role === role && value.providerId === profile.providerId && value.model.trim() === profile.model.trim()))
      .map(role => ({ ...structuredClone(profile), role, model: profile.model.trim() }));
  }) };
  for (const role of modelRoles) {
    const providerId = settings[`${role}ProviderId`];
    const provider = settings.providers.find(value => value.id === providerId);
    const model = providerId ? (settings[`${role}Model`] ?? provider?.model ?? '').trim() : '';
    result[`${role}Model`] = model;
    if (!provider || !model || result.modelParameters?.some(value => value.role === role && value.providerId === providerId && value.model === model)) continue;
    const legacy = modelParameterKeys.some(key => provider[key] !== undefined);
    const parameters: ModelParameters = legacy
      ? { maxOutputTokens: provider.maxOutputTokens ?? 4096, contextTokens: provider.contextTokens ?? 64000, ...Object.fromEntries(modelParameterKeys.filter(key => provider[key] !== undefined).map(key => [key, structuredClone(provider[key])])) }
      : defaultModelParameters();
    result = upsertModelParameters(result, role, providerId, model, parameters);
  }
  return result;
}

export function resolveModelConfig(settings: Settings, provider: ProviderConnection, model: string, role: ModelRole): ProviderConfig {
  return { ...connectionOnly(provider), ...getModelParameters(settings, role, provider.id, model), model: model.trim() };
}
