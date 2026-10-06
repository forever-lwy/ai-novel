export function secretVariants(keys: string[]) {
  return [...new Set(keys.flatMap(key => [key, key.trim()]).filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
}

/** Hold a possible secret prefix until the next text fragment resolves it. */
export function createSecretStreamRedactor(keys: string[], emit: (text: string) => void) {
  const secrets = secretVariants(keys); let pending = '';
  return {
    feed(text: string) {
      pending += text;
      for (const key of secrets) pending = pending.split(key).join('[REDACTED]');
      let keep = 0;
      for (const key of secrets) for (let size = Math.min(key.length - 1, pending.length); size > keep; size--) {
        if (pending.endsWith(key.slice(0, size))) { keep = size; break; }
      }
      const safe = pending.slice(0, pending.length - keep); pending = keep ? pending.slice(-keep) : '';
      if (safe) emit(safe);
    },
    finish() { if (pending) emit('[REDACTED]'); pending = ''; },
  };
}

/** Remove known credentials split across consecutive string fields in SSE frames. */
export function redactSseFragments(text: string, keys: string[]) {
  const secrets = secretVariants(keys); if (!secrets.length) return text;
  const blocks = text.split(/(\r\n\r\n|\n\n|\r\r)/);
  const groups = new Map<string, { owner: Record<string, unknown>; field: string; value: string }[]>();
  const documents: { index: number; lines: string[]; data: unknown; changed: boolean }[] = [];
  for (let index = 0; index < blocks.length; index += 2) {
    const lines = blocks[index].split(/\r\n|\r|\n/); const dataLines = lines.filter(line => line.startsWith('data:'));
    if (!dataLines.length) continue;
    let data: unknown;
    try { data = JSON.parse(dataLines.map(line => line.slice(5).replace(/^ /, '')).join('\n')); } catch { continue; }
    const document = { index, lines, data, changed: false }; documents.push(document);
    const queue = [{ value: data, path: '', depth: 0 }]; let nodes = 0;
    while (queue.length) {
      const { value, path, depth } = queue.pop()!;
      if (depth > 64 || ++nodes > 100000) { document.data = { redacted: '诊断结构超过安全上限' }; document.changed = true; break; }
      if (!value || typeof value !== 'object') continue;
      for (const [field, entry] of Object.entries(value)) {
        const key = `${path}/${field}`;
        if (typeof entry === 'string') { const group = groups.get(key) || []; group.push({ owner: value as Record<string, unknown>, field, value: entry }); groups.set(key, group); }
        else if (entry && typeof entry === 'object') queue.push({ value: entry, path: key, depth: depth + 1 });
      }
    }
  }
  let changed = documents.some(document => document.changed);
  for (const entries of groups.values()) {
    const joined = entries.map(entry => entry.value).join(''); const ranges: { start: number; end: number }[] = [];
    for (const secret of secrets) {
      let position = joined.indexOf(secret);
      while (position !== -1) { ranges.push({ start: position, end: position + secret.length }); position = joined.indexOf(secret, position + secret.length); }
    }
    if (!ranges.length) continue;
    const merged: typeof ranges = [];
    for (const range of ranges.sort((a, b) => a.start - b.start)) {
      const previous = merged.at(-1);
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end); else merged.push({ ...range });
    }
    let offset = 0;
    for (const entry of entries) {
      const masks = merged.filter(range => range.start < offset + entry.value.length && range.end > offset);
      let safe = entry.value;
      for (const range of masks.sort((a, b) => b.start - a.start)) safe = safe.slice(0, Math.max(0, range.start - offset)) + '[REDACTED]' + safe.slice(Math.min(entry.value.length, range.end - offset));
      if (masks.length) { entry.owner[entry.field] = safe; changed = true; }
      offset += entry.value.length;
    }
  }
  if (!changed) return text;
  for (const document of documents) {
    let written = false;
    blocks[document.index] = document.lines.flatMap(line => { if (!line.startsWith('data:')) return [line]; if (written) return []; written = true; return [`data: ${JSON.stringify(document.data)}`]; }).join('\n');
  }
  return blocks.join('');
}
