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
