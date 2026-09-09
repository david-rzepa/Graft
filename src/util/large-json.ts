/** JSON object I/O without constructing one string for a large top-level array.
 * Graph nodes/edges and search documents are independently JSON-serializable.
 */
import { openSync, closeSync, readSync, writeSync, renameSync, rmSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export function writeLargeJson(path: string, value: object): void {
  const temp = `${path}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'w');
    let buffer = '';
    const flush = () => {
      const bytes = Buffer.from(buffer);
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd!, bytes, offset, bytes.length - offset);
      buffer = '';
    };
    const emit = (text: string) => { buffer += text; if (buffer.length >= 65536) flush(); };
    emit('{');
    let first = true;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      if (!first) emit(','); first = false;
      emit(JSON.stringify(key) + ':');
      if (Array.isArray(entry)) {
        emit('[');
        for (let i = 0; i < entry.length; i++) {
          if (i) emit(',');
          emit(JSON.stringify(entry[i]) ?? 'null');
        }
        emit(']');
      } else emit(JSON.stringify(entry));
    }
    emit('}\n'); flush(); closeSync(fd); fd = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Synchronous streaming reader, matching the existing graph/cache reader APIs.
 * Splits only top-level arrays; nested values are parsed by JSON.parse itself.
 */
export function readLargeJson(path: string): Record<string, unknown> {
  const fd = openSync(path, 'r'), bytes = Buffer.allocUnsafe(65536), decoder = new StringDecoder('utf8');
  let chunk = '', at = 0, ended = false;
  const peek = (): string => {
    while (at === chunk.length && !ended) {
      const size = readSync(fd, bytes, 0, bytes.length, null);
      chunk = size ? decoder.write(bytes.subarray(0, size)) : decoder.end();
      ended = size === 0; at = 0;
    }
    return chunk[at] ?? '';
  };
  const take = () => { const c = peek(); if (c) at++; return c; };
  const whitespace = () => { while (' \r\n\t'.includes(peek()) && peek()) take(); };
  const expect = (c: string) => { whitespace(); if (take() !== c) throw new SyntaxError(`Expected ${c} in JSON object`); };
  const value = (): unknown => {
    whitespace(); let text = '', depth = 0, quoted = false, escaped = false;
    while (true) {
      const c = peek();
      if (!c) break;
      if (!quoted && depth === 0 && text && /[\s,\]}]/.test(c)) break;
      text += take();
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') { quoted = false; if (!depth) break; }
      } else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth <= 0) break; }
    }
    return JSON.parse(text);
  };
  try {
    expect('{'); whitespace(); const result: Record<string, unknown> = {};
    if (peek() !== '}') while (true) {
      if (peek() !== '"') throw new SyntaxError('Expected JSON object key');
      const key = value() as string; expect(':'); whitespace();
      let entry: unknown;
      if (peek() === '[') {
        take(); whitespace(); const array: unknown[] = [];
        if (peek() !== ']') while (true) {
          array.push(value()); whitespace();
          if (peek() !== ',') break;
          take(); whitespace();
          if (peek() === ']') throw new SyntaxError('Trailing array comma');
        }
        expect(']'); entry = array;
      } else entry = value();
      Object.defineProperty(result, key, { value: entry, enumerable: true, configurable: true, writable: true });
      whitespace(); if (peek() !== ',') break;
      take(); whitespace();
    }
    expect('}'); whitespace();
    if (peek()) throw new SyntaxError('Trailing JSON content');
    return result;
  } finally { closeSync(fd); }
}
