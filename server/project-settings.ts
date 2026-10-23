import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectSettingsOverrides, ProjectSettingsRecord } from '../shared/types.js';
import { parseProjectSettingsOverrides } from './settings-schema.js';

const failure = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export function readProjectSettings(db: DatabaseSync, projectId: string): ProjectSettingsRecord {
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw failure('作品不存在', 404);
  const row = db.prepare('SELECT revision,data FROM project_settings WHERE project_id=?').get(projectId);
  return row ? { revision: String(row.revision), overrides: JSON.parse(String(row.data)) } : { revision: '0', overrides: {} };
}

export function saveProjectSettings(db: DatabaseSync, projectId: string, revision: string, input: unknown): ProjectSettingsRecord {
  const current = readProjectSettings(db, projectId);
  if (current.revision !== revision) throw failure('作品设置已在其他页面修改，请重新打开设置后再保存。', 409);
  let overrides: ProjectSettingsOverrides;
  try { overrides = parseProjectSettingsOverrides(input); }
  catch (error) { throw failure(error instanceof Error ? error.message : '作品设置格式无效。', 400); }
  const next = randomUUID();
  const changed = db.prepare('INSERT INTO project_settings(project_id,revision,data) VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,data=excluded.data WHERE project_settings.revision=?')
    .run(projectId, next, JSON.stringify(overrides), revision).changes;
  if (!changed) throw failure('作品设置已在其他页面修改，请重新打开设置后再保存。', 409);
  return { revision: next, overrides };
}
