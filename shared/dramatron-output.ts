import type { PromptTextFilter } from './types.js';

/** Same auxiliary envelopes as the preset's display regex. Streaming state
 * keeps split tags and unfinished auxiliary blocks out of story text.
 */
export interface DramatronOutputEvents {
  onText?: (text: string) => void;
  onThinking?: (event: { id: string; text: string } | { id: string; done: true }) => void;
}

export function createDramatronTextFilter(events: DramatronOutputEvents = {}, profile: PromptTextFilter = 'dramatron') {
  let pending = '';
  const hidden: string[] = [];
  let thinking: { id: string; depth: number; hasText: boolean } | undefined;
  let thinkingIndex = 0;
  const thinkingTags = new Set(['think', 'thinking', ...(['v08', 'tavern'].includes(profile) ? ['draft'] : []), ...(['reborn', 'tavern'].includes(profile) ? ['think_nya~'] : []), ...(profile === 'tavern' ? ['review', 'dice_calculation', 'talk'] : [])]);
  const auxiliary = new Set([...thinkingTags, ...(['dramatron', 'tavern'].includes(profile) ? ['disclaimer', 'reference_example'] : []), ...(profile === 'tavern' ? ['safety_check', 'summary', 'sumup', 'pose', 'choices', 'options', 'action', 'scene_time', 'roll_number'] : [])]);
  const wrappers = new Set(profile === 'tavern' ? ['interleaving', 'game', 'now_plot', 'content'] : profile === 'dramatron' ? ['interleaving'] : profile === 'reborn' ? ['game'] : []);
  const tags = [...auxiliary, ...wrappers];
  let format: 'json' | 'text' | undefined;
  let formatLead = '';
  let quoted = false; let escaped = false;
  let checkedHeader = !['reborn', 'tavern'].includes(profile);
  let checkedTerminal = profile !== 'tavern'; let terminal = false; let terminalClosed = false; let terminalFinished = false;
  let comment: { id: string; text: string } | undefined;
  function visible(text: string): string {
    for (const char of text) {
      if (!format && char.trim()) {
        if (profile !== 'tavern') format = char === '{' || char === '[' ? 'json' : 'text';
        else {
          formatLead += char;
          if (formatLead === '{' || formatLead === '[' || formatLead.toLowerCase() === '```json') format = 'json';
          else if (!'```json'.startsWith(formatLead.toLowerCase())) format = 'text';
        }
      }
      if (format === 'json') {
        if (escaped) escaped = false;
        else if (quoted && char === '\\') escaped = true;
        else if (char === '"') quoted = !quoted;
      }
    }
    return text;
  }
  function drain(final: boolean): string {
    if (terminalFinished) { pending = ''; return ''; }
    // Reborn's helper consumes leading status lines, including split field names.
    // Only touch the beginning of the response; quoted JSON evidence stays literal.
    while (!checkedHeader) {
      const head = pending.trimStart().toLowerCase();
      const labels = ['finishreason:', 'finishmessage:'];
      if (!final && labels.some(label => label.startsWith(head))) return '';
      if (!labels.some(label => head.startsWith(label))) { checkedHeader = true; break; }
      const line = /^\s*(?:finishReason|finishMessage):[^\r\n]*(?:\r\n|\r|\n)/i.exec(pending);
      if (line) {
        if (!final && line[0].endsWith('\r') && pending.length === line[0].length) return '';
        pending = pending.slice(line[0].length); continue;
      }
      if (!final && pending.length < 4096) return '';
      if (final) pending = '';
      checkedHeader = true;
    }
    if (!checkedTerminal) {
      const head = pending.trimStart();
      const starts = ['```bash', '```terminal', 'user@', 'root@', '[system@'];
      if (!final && starts.some(value => value.startsWith(head))) return '';
      terminal = starts.some(value => head.startsWith(value)); checkedTerminal = true;
    }
    if (terminal) {
      // Original Linux output prints a simulated terminal before <content>.
      // Wait only for the tagged payload; never save commands or file analysis.
      if (terminalClosed) { pending = ''; return ''; }
      const content = /<content(?:\s[^<>]*)?>/i.exec(pending);
      if (!content) { if (final) pending = ''; return ''; }
      pending = pending.slice(content.index + content[0].length); terminal = false; terminalClosed = true;
    } else if (terminalClosed && !hidden.length && /^\s*```\s*$/.test(pending)) {
      if (final) pending = ''; return '';
    }
    let output = '';
    const append = (text: string) => {
      if (!text) return;
      if (!hidden.length) { output += visible(text); events.onText?.(text); }
      else if (thinking && hidden.every(tag => thinkingTags.has(tag))) {
        thinking.hasText = true; events.onThinking?.({ id: thinking.id, text });
      }
    };
    while (pending) {
      if (comment) {
        const end = pending.indexOf('-->');
        if (end < 0) {
          if (!final) break;
          comment.text += pending; pending = '';
        } else { comment.text += pending.slice(0, end); pending = pending.slice(end + 3); }
        if (comment.text) { events.onThinking?.({ id: comment.id, text: comment.text }); events.onThinking?.({ id: comment.id, done: true }); }
        comment = undefined; continue;
      }
      const opening = pending.indexOf('<');
      if (opening < 0) { append(pending); pending = ''; break; }
      if (opening > 0) { append(pending.slice(0, opening)); pending = pending.slice(opening); }
      // Tags quoted inside submitted JSON are evidence or field values.
      if (format === 'json' && quoted && !hidden.length) { append('<'); pending = pending.slice(1); continue; }
      if (profile === 'tavern' && !final && '<!--'.startsWith(pending)) break;
      if (profile === 'tavern' && pending.startsWith('<!--')) {
        const marker = /^<!--\s*(?:charThink|plotThink|jp)\s*:/i.exec(pending);
        if (marker) { comment = { id: `preset:${thinkingIndex++}`, text: '' }; pending = pending.slice(marker[0].length); continue; }
        if (!final && !pending.includes('-->') && pending.length < 40) break;
      }
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
      const match = /^<(\/?)([a-z_~]+)(?:\s[^<>]*)?>$/i.exec(raw);
      if (!match) { append('<'); pending = pending.slice(1); continue; }
      const tag = match?.[2].toLowerCase();
      if (terminalClosed && tag === 'content' && match[1]) { terminalFinished = true; pending = ''; break; }
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

export function cleanDramatronText(text: string, profile: PromptTextFilter = 'dramatron'): string {
  const filter = createDramatronTextFilter({}, profile);
  return filter.feed(text) + filter.finish();
}
