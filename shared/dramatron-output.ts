/** Same auxiliary envelopes as the preset's display regex. Streaming state
 * keeps split tags and unfinished auxiliary blocks out of story text.
 */
export function createDramatronTextFilter() {
  let pending = '';
  const hidden: string[] = [];
  const auxiliary = new Set(['think', 'thinking', 'disclaimer', 'reference_example']);
  const tags = [...auxiliary, 'interleaving'];
  let format: 'json' | 'text' | undefined;
  let quoted = false; let escaped = false;
  function visible(text: string): string {
    for (const char of text) {
      if (!format && char.trim()) format = char === '{' || char === '[' ? 'json' : 'text';
      if (format === 'json') {
        if (escaped) escaped = false;
        else if (quoted && char === '\\') escaped = true;
        else if (char === '"') quoted = !quoted;
      }
    }
    return text;
  }
  function drain(final: boolean): string {
    let output = '';
    while (pending) {
      const opening = pending.indexOf('<');
      if (opening < 0) { if (!hidden.length) output += visible(pending); pending = ''; break; }
      if (opening > 0) { if (!hidden.length) output += visible(pending.slice(0, opening)); pending = pending.slice(opening); }
      // Tags quoted inside submitted JSON are evidence or field values.
      if (format === 'json' && quoted && !hidden.length) { output += visible('<'); pending = pending.slice(1); continue; }
      const end = pending.indexOf('>');
      if (end < 0) {
        const next = pending.indexOf('<', 1);
        if (next >= 0) { if (!hidden.length) output += visible(pending.slice(0, next)); pending = pending.slice(next); continue; }
        const prefix = pending.toLowerCase().replace(/^<\/?/, '');
        const possible = tags.some(tag => tag.startsWith(prefix) || prefix.startsWith(tag + ' '));
        if (possible && !final) break;
        if (!hidden.length && !possible) output += visible(pending);
        pending = ''; break;
      }
      const raw = pending.slice(0, end + 1);
      const match = /^<(\/?)([a-z_]+)(?:\s[^<>]*)?>$/i.exec(raw);
      if (!match) { if (!hidden.length) output += visible('<'); pending = pending.slice(1); continue; }
      const tag = match?.[2].toLowerCase();
      if (tag && auxiliary.has(tag)) {
        if (match![1]) { if (hidden[hidden.length - 1] === tag) hidden.pop(); }
        else hidden.push(tag);
      } else if (tag !== 'interleaving' && !hidden.length) output += visible(raw);
      pending = pending.slice(end + 1);
    }
    return output;
  }
  return { feed: (text: string) => { pending += text; return drain(false); }, finish: () => drain(true) };
}

export function cleanDramatronText(text: string): string {
  const filter = createDramatronTextFilter();
  return filter.feed(text) + filter.finish();
}
