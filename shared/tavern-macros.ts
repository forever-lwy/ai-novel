/** A small, deterministic interpreter for the macros used by the bundled presets.
 * It only reads preset text. Inserted story data is opaque and is never interpreted.
 * No JavaScript, browser helper, regular-expression replacement or network code runs.
 */
export function createTavernMacroExpander(values: Record<string, string | number | undefined>, seed: string) {
  const locals = new Map<string, string>();
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  const random = (max: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % max; };
  const expand = (source: string, depth = 0): string => {
    if (depth > 20) throw new Error('酒馆宏嵌套超过 20 层。');
    let result = ''; let cursor = 0;
    while (cursor < source.length) {
      const start = source.indexOf('{{', cursor);
      if (start < 0) { result += source.slice(cursor); break; }
      result += source.slice(cursor, start);
      let end = start + 2; let nesting = 1;
      for (; end < source.length && nesting; end++) {
        if (source.startsWith('{{', end)) { nesting++; end++; }
        else if (source.startsWith('}}', end)) { nesting--; if (nesting) end++; }
      }
      if (nesting) throw new Error('酒馆预设中存在未闭合的宏，请检查 {{ 与 }}。');
      const expression = source.slice(start + 2, end - 1).trim();
      cursor = end + 1;
      if (expression.startsWith('//') || expression === 'trim') continue;
      const setter = /^setvar::([^:]+)::([\s\S]*)$/i.exec(expression);
      const getter = /^getvar::(.+)$/i.exec(expression);
      if (setter) locals.set(setter[1].trim(), expand(setter[2], depth + 1));
      else if (getter) result += locals.get(getter[1].trim()) ?? '';
      else if (/^random::/i.test(expression)) {
        const choices = expression.slice(8).split('::'); result += choices[random(choices.length)];
      } else if (/^roll\s+/i.test(expression)) {
        const dice = /^(?:(\d+)d)?(\d+)$/i.exec(expression.replace(/^roll\s+/i, ''));
        if (!dice || Number(dice[1] ?? 1) > 100 || Number(dice[2]) < 1 || Number(dice[2]) > 1e9) throw new Error('不支持的酒馆骰子宏。');
        let total = 0; for (let n = 0; n < Number(dice[1] ?? 1); n++) total += random(Number(dice[2])) + 1;
        result += total;
      } else if (Object.hasOwn(values, expression)) result += String(values[expression] ?? '');
      else if (['思考内容', '正文内容', '可能要求的附加内容'].includes(expression)) result += expression;
      else throw new Error(`不支持的酒馆宏 {{${expression.slice(0, 80)}}}；请改为项目变量或字面文本。`);
      if (result.length > 200000) throw new Error('酒馆宏展开后的单个消息超过 200000 字符。');
    }
    return result;
  };
  return (source: string) => expand(source);
}
