import { z } from 'zod';
import type { ModelRequest } from '../shared/types.js';

/** Offsets stay in the saved chapter's UTF-16 coordinates, including CRLF. */
export function sceneParagraphs(text: string) {
  return [...text.matchAll(/[^\r\n]+/g)].filter(match => match[0].trim()).map((match, index) => ({ paragraph: index + 1, text: match[0], start: match.index!, end: match.index! + match[0].length }));
}

export function scenePlacementRequest(text: string, scenes: { id: string; sceneDescription: string }[]): ModelRequest {
  return {
    system: '根据场景描述，为本章插画选择对应的正文位置。这是独立的插画定位任务。每张图选择最能体现画面且该场景已经发生的一个段落，图片关联在该段之后。只依据本章正文；找不到可靠对应时 paragraph 填 null，不猜测、不修改正文、不提取人物资料。返回 JSON：{"placements":[{"imageId":"原图片标识","paragraph":段号或null}]}。每个图片标识恰好返回一次。',
    prompt: `# 待定位的插画\n${JSON.stringify(scenes)}\n\n# 本章正文（带段号）\n${sceneParagraphs(text).map(row => `[${row.paragraph}] ${row.text}`).join('\n')}`,
  };
}

export function parseScenePlacements(value: unknown, imageIds: string[], paragraphCount: number) {
  const parsed = z.object({ placements: z.array(z.object({ imageId: z.string(), paragraph: z.number().int().min(1).max(paragraphCount).nullable() }).strict()).length(imageIds.length) }).strict().parse(value);
  const ids = new Set(parsed.placements.map(row => row.imageId));
  if (ids.size !== imageIds.length || imageIds.some(id => !ids.has(id))) throw new Error('插画定位结果的图片标识重复或不完整');
  return parsed;
}
