import { describe, expect, it } from 'vitest';
import type { WritingActivity } from '../shared/types.js';
import { proseFragments, writingTimeline } from '../client/writing-timeline.js';

const activity = (id: string, proseOffset?: number): WritingActivity => ({ id, kind: 'thinking', text: `PRIVATE_PROCESS_${id}`, status: 'completed', ...(proseOffset !== undefined ? { proseOffset } : {}) });
const rawText = (text: string, parts: ReturnType<typeof writingTimeline>) => parts.flatMap(part => part.kind === 'text' ? [text.slice(part.start, part.end)] : []).join('');
const displayedFragments = (text: string, parts: ReturnType<typeof writingTimeline>) => parts.flatMap(part => part.kind === 'text' ? proseFragments(text, part.start, part.end) : []);

describe('writing process anchored in unchanged prose', () => {
  it('keeps paragraph-internal text complete and selectable around separate activity groups', () => {
    const text = '  林舟走向白石城，看到古门。  \r\n\r\n青霜说：“等一等。”\r\n';
    const at = text.indexOf('，'); const parts = writingTimeline(text, [activity('middle', at), activity('next', text.indexOf('青霜'))]);
    expect(rawText(text, parts)).toBe(text);
    const fragments = displayedFragments(text, parts);
    expect(fragments.map(fragment => fragment.text).join('')).toBe('林舟走向白石城，看到古门。青霜说：“等一等。”');
    for (const fragment of fragments) expect(text.slice(fragment.start, fragment.end)).toBe(fragment.text);
    expect(fragments[0]).toMatchObject({ text: '林舟走向白石城', interrupted: true, continued: false, start: 2 });
    expect(fragments[1]).toMatchObject({ text: '，看到古门。', continued: true, interrupted: false });
    expect(fragments[2]).toMatchObject({ index: 1, continued: false });
    expect(fragments.map(fragment => fragment.text).join('')).not.toContain('PRIVATE_PROCESS');
  });

  it('preserves CRLF and blank-line coordinates when an activity lands between newline characters', () => {
    const text = '甲段\r\n\r\n乙段\n丙段\r丁段';
    const parts = writingTimeline(text, [activity('crlf', 3), activity('blank', 6), activity('ending', text.length)]);
    expect(rawText(text, parts)).toBe(text);
    const fragments = displayedFragments(text, parts);
    expect(fragments.map(fragment => [fragment.text, fragment.start])).toEqual([['甲段', 0], ['乙段', 6], ['丙段', 9], ['丁段', 12]]);
  });

  it('never splits an emoji surrogate pair and retains exact remaining characters', () => {
    const text = '门前😀有灯，旅人🚪入城。'; const emoji = text.indexOf('😀');
    const parts = writingTimeline(text, [activity('inside-emoji', emoji + 1), activity('later', text.indexOf('入城'))]);
    expect(rawText(text, parts)).toBe(text);
    expect(parts.find(part => part.kind === 'activities' && part.activities[0].id === 'inside-emoji')).toMatchObject({ start: emoji });
    const visible = displayedFragments(text, parts).map(fragment => fragment.text);
    expect(visible.join('')).toBe(text);
    expect(visible.every(value => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(value))).toBe(true);
  });

  it('orders distinct anchors while preserving activity order at the same position', () => {
    const text = '第一段。\n下一段。';
    const parts = writingTimeline(text, [activity('late', text.length), activity('first-call', 4), activity('first-result', 4), activity('start', 0)]);
    expect(rawText(text, parts)).toBe(text);
    expect(parts.flatMap(part => part.kind === 'activities' ? [part.activities.map(value => value.id)] : [])).toEqual([['start'], ['first-call', 'first-result'], ['late']]);
  });

  it('retains legacy activity without inventing an anchor and bounds future offsets to received prose', () => {
    const text = '已收到的正文'; const legacy = activity('legacy');
    const parts = writingTimeline(text, [activity('future', 1000), legacy, activity('bad', -1)]);
    expect(rawText(text, parts)).toBe(text);
    expect(parts[0]).toMatchObject({ kind: 'activities', legacy: true, activities: [legacy, activity('bad', -1)] });
    expect(parts.at(-1)).toMatchObject({ kind: 'activities', start: text.length });
    expect(legacy).not.toHaveProperty('proseOffset');
  });

  it('keeps completed/tool-result anchors at the choice point as later prose grows', () => {
    const prefix = '你站在城门前。\n\n';
    const records = [{ ...activity('ask-user', prefix.length), kind: 'tool' as const, name: 'ask_user' }, activity('after-choice', prefix.length)];
    const pending = writingTimeline(prefix, records);
    const resumed = writingTimeline(`${prefix}你选择查看石碑。`, records.map(record => ({ ...record, status: 'completed' as const })));
    expect(pending.filter(part => part.kind === 'activities').map(part => part.start)).toEqual([prefix.length]);
    expect(resumed.filter(part => part.kind === 'activities').map(part => part.start)).toEqual([prefix.length]);
    expect(rawText(`${prefix}你选择查看石碑。`, resumed)).toBe(`${prefix}你选择查看石碑。`);
    expect(displayedFragments(`${prefix}你选择查看石碑。`, resumed).map(fragment => fragment.text).join('')).toBe('你站在城门前。你选择查看石碑。');
  });
});
