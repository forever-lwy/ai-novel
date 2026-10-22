import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { parseDocument } from 'yaml';
import type { ImportedSkill, SkillFile } from '../shared/extensions.js';

export const SKILL_FILE_BYTES = 512 * 1024;
export const SKILL_TOTAL_BYTES = 2 * 1024 * 1024;
export function skillPath(path: string) {
  if (!path || path.length > 240 || /[\\:\x00-\x1f]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('技能文件路径必须是包内相对路径，不能包含 .. 或绝对路径。');
  return path;
}
export function skillMetadata(files: SkillFile[]) {
  const main = files.find(file => file.path === 'SKILL.md');
  if (!main || main.encoding !== 'utf8') throw new Error('技能必须包含 UTF-8 编码的 SKILL.md。');
  const text = main.content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error('SKILL.md 开头需要 --- 包围的 YAML 名称和简介。');
  const document = parseDocument(match[1], { uniqueKeys: true, customTags: [] });
  if (document.errors.length) throw new Error('SKILL.md 的 YAML 元信息格式无效。');
  const meta = document.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null;
  if (!meta || typeof meta.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.name) || meta.name.length > 64) throw new Error('技能 name 须为不超过 64 字符的小写英文、数字和单个连字符。');
  if (typeof meta.description !== 'string' || !meta.description.trim() || meta.description.length > 1024) throw new Error('技能 description 不能为空，最多 1024 字符。');
  if (!match[2].trim()) throw new Error('SKILL.md 需要包含技能正文。');
  return { name: meta.name, description: meta.description.trim() };
}
export function validateSkillFiles(files: SkillFile[]) {
  if (!files.length || files.length > 200) throw new Error('每个技能最多 200 个文件。');
  const paths = new Set<string>(); let total = 0;
  for (const file of files) {
    skillPath(file.path);
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new Error('技能中有重复文件路径。');
    paths.add(key);
    if (file.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new Error('技能二进制附件的 Base64 格式无效。');
    const size = Buffer.byteLength(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    total += size;
    if (size > SKILL_FILE_BYTES || total > SKILL_TOTAL_BYTES) throw new Error('技能单文件最多 512 KiB，全部文件最多 2 MiB。');
  }
  return skillMetadata(files);
}
export function importSkill(filename: string, bytes: Uint8Array): ImportedSkill {
  if (bytes.byteLength > SKILL_TOTAL_BYTES) throw new Error('技能上传文件最多 2 MiB。');
  let entries: Record<string, Uint8Array>;
  if (/\.md$/i.test(filename)) entries = { 'SKILL.md': bytes };
  else if (/\.zip$/i.test(filename)) {
    let count = 0, total = 0; const seen = new Set<string>();
    entries = unzipSync(bytes, { filter: entry => {
      if (++count > 400) throw new Error('技能压缩包文件过多。');
      const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
      skillPath(path);
      if (seen.has(path.toLowerCase())) throw new Error('技能压缩包有重复文件路径。');
      seen.add(path.toLowerCase()); total += entry.originalSize;
      if (entry.originalSize > SKILL_FILE_BYTES || total > SKILL_TOTAL_BYTES) throw new Error('技能解压后超过容量上限。');
      return !entry.name.endsWith('/');
    } });
  } else throw new Error('请选择 SKILL.md 或包含一个技能的 ZIP 文件。');
  const mains = Object.keys(entries).filter(path => /(^|\/)SKILL\.md$/.test(path));
  if (mains.length !== 1) throw new Error('每次导入一个技能，包内必须恰好有一份 SKILL.md。');
  const root = mains[0].slice(0, -'SKILL.md'.length);
  if (Object.keys(entries).some(path => !path.startsWith(root))) throw new Error('所有附件必须位于 SKILL.md 所在的技能目录内。');
  const files: SkillFile[] = Object.entries(entries).map(([path, value]) => {
    let content: string; let encoding: SkillFile['encoding'] = 'utf8';
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(value); if (content.includes('\0')) throw new Error('binary'); }
    catch { content = Buffer.from(value).toString('base64'); encoding = 'base64'; }
    return { path: path.slice(root.length), content, encoding };
  });
  return { id: randomUUID(), ...validateSkillFiles(files), enabled: false, files };
}
