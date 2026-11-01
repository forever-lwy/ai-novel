import { describe, expect, it } from 'vitest';
import { unpackResponseCarrier } from '../shared/response-carrier.js';
import { unpackWritingResponse, WRITING_RESPONSE_NAME } from '../shared/writing-output.js';
import type { ModelToolCall } from '../shared/types.js';

const writingCall = (args: unknown): ModelToolCall => ({ id: 'outer', name: WRITING_RESPONSE_NAME, arguments: args });
const carrier = { name: 'emit_complete_text', field: 'content', archive: false };
const outputCall = (args: unknown): ModelToolCall => ({ id: 'output', name: carrier.name, arguments: args });

describe('compatible writing tool envelopes', () => {
  it('ignores additional metadata without adding it to prose or executable calls', () => {
    const value = { prose: '旅人来到桥边。', toolCalls: [{ name: 'list_text_files', argumentsJson: '{}', metadata: { source: 'gateway' } }], metadata: { text: '不属于正文' }, toolName: 'unknown_tool' };
    expect(unpackWritingResponse([writingCall(value)], ['list_text_files'])).toEqual({
      prose: '旅人来到桥边。', calls: [{ id: 'outer:0', name: 'list_text_files', arguments: {} }],
    });
    expect(unpackWritingResponse([writingCall(JSON.stringify(value))], ['list_text_files'])).toEqual(unpackWritingResponse([writingCall(value)], ['list_text_files']));
  });

  it.each([undefined, null, '', ' \n\t', 'null', {}, '{}'])('treats empty nested arguments %j as an empty object', argumentsJson => {
    const nested = { name: 'list_text_files', ...(argumentsJson === undefined ? {} : { argumentsJson }) };
    expect(unpackWritingResponse([writingCall({ prose: '', toolCalls: [nested] })], ['list_text_files']).calls).toEqual([
      { id: 'outer:0', name: 'list_text_files', arguments: {} },
    ]);
  });

  it('accepts nested arguments already decoded as an object', () => {
    expect(unpackWritingResponse([writingCall({ prose: '', toolCalls: [{ name: 'read_entity', argumentsJson: { id: 'person' } }] })], ['read_entity']).calls[0].arguments).toEqual({ id: 'person' });
  });

  it.each([[], 0, false, '[]', '0', 'false', '"text"'].map(argumentsJson => ({ argumentsJson })))('rejects non-object nested arguments $argumentsJson', ({ argumentsJson }) => {
    expect(() => unpackWritingResponse([writingCall({ prose: '', toolCalls: [{ name: 'list_text_files', argumentsJson }] })], ['list_text_files'])).toThrow('必须是 JSON 对象');
  });

  it('still rejects invalid JSON, unavailable tools and ambiguous or incomplete envelopes', () => {
    expect(() => unpackWritingResponse([writingCall({ prose: '', toolCalls: [{ name: 'list_text_files', argumentsJson: '{' }] })], ['list_text_files'])).toThrow('不是有效 JSON');
    expect(() => unpackWritingResponse([writingCall({ prose: '', toolCalls: [{ name: 'unknown_tool' }] })], ['list_text_files'])).toThrow('未提供的工具');
    expect(() => unpackWritingResponse([writingCall({ prose: '正文' })], [])).toThrow('必须包含 prose 和 toolCalls');
    expect(() => unpackWritingResponse([writingCall({ toolCalls: [] })], [])).toThrow('必须包含 prose 和 toolCalls');
    expect(() => unpackWritingResponse([writingCall({ prose: '', toolCalls: [] })], [])).toThrow('没有返回正文或工具调用');
    expect(() => unpackWritingResponse([writingCall({ prose: '', toolCalls: Array.from({ length: 5 }, () => ({ name: 'list_text_files' })) })], ['list_text_files'])).toThrow('每轮最多四项');
    expect(() => unpackWritingResponse([writingCall({ prose: '正文', toolCalls: [] }), writingCall({ prose: '另一段', toolCalls: [] })], [])).toThrow('必须提交一次');
  });
});

describe('compatible result carrier envelopes', () => {
  it('uses only the configured output field and keeps actual tool calls separate', () => {
    const output = outputCall({ content: '旅人停了下来。', metadata: { prose: '不能进入正文' }, toolCalls: [{ name: 'unknown_tool' }] });
    const lookup = { id: 'lookup', name: 'list_text_files', arguments: {} };
    expect(unpackResponseCarrier([output, lookup], carrier)).toEqual({ prose: '旅人停了下来。', calls: [lookup], carriers: [output] });
    expect(unpackResponseCarrier([outputCall(JSON.stringify(output.arguments))], carrier).prose).toBe('旅人停了下来。');
  });

  it.each([{}, { content: null }, { content: 1 }, { prose: 'wrong field' }, [], 'null'].map(value => ({ value })))('still requires the configured string field in $value', ({ value }) => {
    expect(() => unpackResponseCarrier([outputCall(value)], carrier)).toThrow('必须包含 content 字符串');
  });

  it('still rejects conflicting submissions and invalid JSON', () => {
    expect(() => unpackResponseCarrier([outputCall({ content: '第一份' }), outputCall({ content: '第二份' })], carrier)).toThrow('每轮只能提交一次');
    expect(() => unpackResponseCarrier([outputCall('{')], carrier)).toThrow('不是完整有效的 JSON');
  });
});
