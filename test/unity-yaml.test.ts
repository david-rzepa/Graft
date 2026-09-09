import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { normalizeUnityQuotes } from '../src/plugins/unity-yaml.js';

test('normalizes standalone closing quotes, including CRLF and escaped quotes', () => {
  for (const [quote, content, expected] of [["'", "Don''t", "Don't"], ['"', 'Say \\"hi\\"', 'Say "hi"']]) {
    const input = `Object:\n  text: ${quote}${content}\n\n    next\n\n${quote}\n  after: 123\n`.replace(/\n/g, '\r\n');
    const result = normalizeUnityQuotes(input);
    assert.equal(result.split('\n').length, input.split('\n').length);
    assert.deepEqual(parse(result, { schema: 'failsafe' }), { Object: { text: `${expected}\nnext\n`, after: '123' } });
  }
});

test('leaves valid strings, block contents, and unterminated scalars unchanged', () => {
  for (const input of [
    "Object:\n  text: 'valid'\n  next: 1\n",
    "Object:\n  text: |\n    example: 'not a scalar\n    '\n  next: 1\n",
    "Object:\n  text: 'unterminated\n  next: 1\n",
    "Object:\n  text: plain apostrophe's\n  next: 1\n",
  ]) assert.equal(normalizeUnityQuotes(input), input);
});

test('legacy Unity data maps retain every ordered entry without losing 64-bit IDs', async () => {
  const { parseUnityYaml } = await import('../src/plugins/unity-yaml.js');
  const value = parseUnityYaml(`StateMachine:
  m_OrderedTransitions:
    data:
      first: {fileID: 9223372036854775806}
      second: [{fileID: 111}]
    data:
      first: {fileID: 222}
      second: [{fileID: 333}]
    data:
      first: {fileID: 0}
      second: []
  m_Name: unchanged
`) as any;
  assert.deepEqual(value.StateMachine.m_OrderedTransitions.data, [
    { first: { fileID: '9223372036854775806' }, second: [{ fileID: '111' }] },
    { first: { fileID: '222' }, second: [{ fileID: '333' }] },
    { first: { fileID: '0' }, second: [] },
  ]);
  assert.equal(value.StateMachine.m_Name, 'unchanged');
});

test('legacy-map handling still rejects malformed YAML, aliases, and other duplicate keys', async () => {
  const { parseUnityYaml } = await import('../src/plugins/unity-yaml.js');
  for (const input of [
    'Object:\n  m_Name: one\n  m_Name: two\n',
    'Object:\n  data: one\n  data: two\n',
    'Object:\n  data: {first: 1, second: 2}\n  data: {first: 3}\n',
    'Object:\n  text: "unterminated\n',
    'Object:\n  a: &a [1, 2]\n  b: *a\n',
  ]) assert.throws(() => parseUnityYaml(input), undefined, input);
});
