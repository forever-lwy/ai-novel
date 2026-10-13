/** RPG chapter targets count visible prose characters, without whitespace. */
export function normalizeChapterWords(value?: number): number {
  const requested = typeof value === 'number' && Number.isFinite(value) && value !== 0 ? Math.trunc(value) : 2000;
  return Math.min(20000, Math.max(100, requested));
}

export function countProseWords(text: string): number {
  // Import previews can contain a whole unchaptered novel; avoid a character array.
  const whitespace = /\s/u;
  let words = 0;
  for (const character of text) if (!whitespace.test(character)) words++;
  return words;
}

export function chapterBudgetReached(text: string, targetWords: number): boolean {
  return countProseWords(text) >= normalizeChapterWords(targetWords);
}

export function chapterBudgetInstruction(text: string, targetWords: number): string {
  const target = normalizeChapterWords(targetWords), written = countProseWords(text), remaining = Math.max(0, target - written);
  const closing = written >= target * 0.85;
  return `本章目标 ${target} 字，已累计生成正文 ${written} 字，剩余约 ${remaining} 字。字数按正文去除空白后的字符数计算，所有选择后的续写共用本章预算。\n`
    + (closing ? '本章已进入收尾阶段：只完成眼前的动作、对话或场景，不再展开新的事件；在自然的段落或选择节点结束本章。' : '按剩余字数安排本轮篇幅；关键行动仍交给玩家决定，接近目标时在自然的段落或选择节点结束本章。')
    + '\n不要为了凑字数重复内容，不要替玩家执行尚未选择的行动，不要在正文中显示预算说明。';
}
