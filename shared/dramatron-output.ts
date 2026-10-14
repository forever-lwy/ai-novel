/** Same auxiliary envelopes as the preset's display regex. Streaming state
 * keeps split tags and unfinished auxiliary blocks out of story text.
 */
export interface DramatronOutputEvents {
  onText?: (text: string) => void;
  onThinking?: (event: { id: string; text: string } | { id: string; done: true }) => void;
}

export function createDramatronTextFilter(events: DramatronOutputEvents = {}, profile: 'dramatron' | 'v08' = 'dramatron') {
  let pending = '';
  const hidden: string[] = [];
  let thinking: { id: string; depth: number; hasText: boolean } | undefined;
  let thinkingIndex = 0;
  const thinkingTags = new Set(['think', 'thinking', ...(profile === 'v08' ? ['draft'] : [])]);
  const auxiliary = new Set([...thinkingTags, ...(profile === 'dramatron' ? ['disclaimer', 'reference_example'] : [])]);
  const wrappers = new Set(profile === 'dramatron' ? ['interleaving'] : []);
  const tags = [...auxiliary, ...wrappers];
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
    const append = (text: string) => {
      if (!text) return;
      if (!hidden.length) { output += visible(text); events.onText?.(text); }
      else if (thinking && hidden.every(tag => thinkingTags.has(tag))) {
        thinking.hasText = true; events.onThinking?.({ id: thinking.id, text });
      }
    };
    while (pending) {
      const opening = pending.indexOf('<');
      if (opening < 0) { append(pending); pending = ''; break; }
      if (opening > 0) { append(pending.slice(0, opening)); pending = pending.slice(opening); }
      // Tags quoted inside submitted JSON are evidence or field values.
      if (format === 'json' && quoted && !hidden.length) { append('<'); pending = pending.slice(1); continue; }
      const end = pending.indexOf('>');
      if (end < 0) {
        const next = pending.indexOf('<', 1);
        if (next >= 0) { append(pending.slice(0, next)); pending = pending.slice(next); continue; }
        const prefix = pending.toLowerCase().replace(/^<\/?/, '');
        const possible = tags.some(tag => tag.startsWith(prefix) || prefix.startsWith(tag + ' '));
        if (possible && !final) break;
        if (!possible) append(pending);
        pending = ''; break;
      }
      const raw = pending.slice(0, end + 1);
      const match = /^<(\/?)([a-z_]+)(?:\s[^<>]*)?>$/i.exec(raw);
      if (!match) { append('<'); pending = pending.slice(1); continue; }
      const tag = match?.[2].toLowerCase();
      if (tag && auxiliary.has(tag)) {
        if (match![1]) {
          if (hidden[hidden.length - 1] === tag) {
            hidden.pop();
            if (thinking && hidden.length < thinking.depth) {
              if (thinking.hasText) events.onThinking?.({ id: thinking.id, done: true });
              thinking = undefined;
            }
          }
        } else {
          if (!hidden.length && thinkingTags.has(tag)) thinking = { id: `preset:${thinkingIndex++}`, depth: 1, hasText: false };
          hidden.push(tag);
        }
      } else if (!wrappers.has(tag)) append(raw);
      pending = pending.slice(end + 1);
    }
    return output;
  }
  return { feed: (text: string) => { pending += text; return drain(false); }, finish: () => drain(true) };
}

export function cleanDramatronText(text: string, profile: 'dramatron' | 'v08' = 'dramatron'): string {
  const filter = createDramatronTextFilter({}, profile);
  return filter.feed(text) + filter.finish();
}
