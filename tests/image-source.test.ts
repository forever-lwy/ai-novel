import { describe, expect, it } from 'vitest';
import { matchWritingScene } from '../server/image-source.js';

describe('writing CG source evidence', () => {
  it.each([
    ['actual line breaks', '前段。\n\n后段。', '前段。\n\n后段。'],
    ['double-escaped JSON line breaks', '前段。\n\n后段。', '前段。\\n\\n后段。'],
    ['double-escaped CRLF', '前段。\r\n后段。', '前段。\\r\\n后段。'],
    ['literal backslashes already in prose', '标签写着 \\n。', '标签写着 \\n。'],
  ])('anchors %s to the actual full quote', (_name, quote, source) => {
    const prefix = '清晨，';
    expect(matchWritingScene(`${prefix}${quote}天亮了。`, source)).toEqual({ sourceText: quote, selection: { start: prefix.length, end: prefix.length + quote.length } });
  });

  it.each([
    ['invented wording', '前段。\n后段。', '前段。\\n另一个场景。'],
    ['changed spaces', '前 段。\n后段。', '前段。\\n后段。'],
    ['ambiguous exact quotes', '清晨。清晨。', '清晨。'],
    ['ambiguous recovered quotes', '前段。\n后段。前段。\n后段。', '前段。\\n后段。'],
    ['other JSON escapes', '甲\t乙', '甲\\t乙'],
  ])('rejects %s instead of guessing', (_name, text, source) => {
    expect(matchWritingScene(text, source)).toBeUndefined();
  });
});
