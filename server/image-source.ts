/** Match the complete quote; never guess a scene from approximate wording. */
export function matchWritingScene(text: string, source: string | undefined) {
  if (!source) return undefined;
  const locate = (quote: string) => {
    const start = text.indexOf(quote);
    return start >= 0 && text.indexOf(quote, start + 1) < 0 ? { sourceText: quote, selection: { start, end: start + quote.length } } : undefined;
  };
  // A literal backslash-n may be intentional prose, so prefer the original.
  if (text.includes(source)) return locate(source);
  // Some models double-escape JSON line breaks. Only recover those characters,
  // then require the complete quote to occur exactly once in the real prose.
  const decoded = source.replace(/\\r\\n/g, '\r\n').replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  return decoded !== source ? locate(decoded) : undefined;
}
