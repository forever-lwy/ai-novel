import type { ModelRole, ProjectModelSettings, ProjectSettingsOverrides, Settings } from './types.js';
import { modelRoles, normalizeModelSettings } from './model-settings.js';
import { normalizeTaskSettings } from './task-settings.js';

export function projectModelSettings(settings: Settings, role: ModelRole): ProjectModelSettings {
  const normalized = normalizeModelSettings(settings);
  return structuredClone({
    providerId: normalized[`${role}ProviderId`], model: normalized[`${role}Model`] ?? '',
    modelParameters: normalized.modelParameters?.filter(profile => profile.role === role) ?? [],
    ...(role === 'extraction' ? { extraction: normalizeTaskSettings(settings.taskSettings).extraction } : {}),
  });
}

/** Replace whole opted-in groups, including intentionally omitted optional parameters. */
export function resolveProjectSettings(global: Settings, overrides: ProjectSettingsOverrides): Settings {
  const result = structuredClone(global);
  for (const role of modelRoles) {
    const task = overrides.tasks?.[role];
    if (!task) continue;
    result[`${role}ProviderId`] = task.providerId;
    result[`${role}Model`] = task.model;
    result.modelParameters = [...(result.modelParameters ?? []).filter(profile => profile.role !== role), ...structuredClone(task.modelParameters)];
    if (role === 'extraction') result.taskSettings = { extraction: normalizeTaskSettings({ extraction: task.extraction }).extraction };
  }
  if (overrides.promptTemplates) result.promptTemplates = structuredClone(overrides.promptTemplates);
  if (overrides.imageSettings) result.imageSettings = structuredClone(overrides.imageSettings);
  return result;
}

/** Save only opted-in groups, never provider addresses, credentials or inherited snapshots. */
export function collectProjectOverrides(settings: Settings, enabled: ProjectSettingsOverrides): ProjectSettingsOverrides {
  const tasks: ProjectSettingsOverrides['tasks'] = {};
  for (const role of modelRoles) if (enabled.tasks?.[role]) tasks[role] = projectModelSettings(settings, role);
  return {
    ...(Object.keys(tasks).length ? { tasks } : {}),
    ...(enabled.promptTemplates ? { promptTemplates: settings.promptTemplates } : {}),
    ...(enabled.imageSettings ? { imageSettings: settings.imageSettings } : {}),
  };
}
