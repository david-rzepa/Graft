import { parseDocument, isMap, isScalar, visit, YAMLSeq } from 'yaml';

/** Unity can emit a multiline quoted value with its closing quote at column zero.
 * Normalize only a standalone closing delimiter, never string contents or source
 * files. Keep line counts intact for graph spans and retain strict YAML validation.
 */
export function normalizeUnityQuotes(text: string): string {
  const lines = text.split('\n');
  let quote: string | undefined;
  let indent = 0;
  let blockIndent: number | undefined;
  for (let line = 0; line < lines.length; line++) {
    const value = lines[line];
    const leading = /^ */.exec(value)![0].length;
    if (!quote) {
      // A quoted-looking field inside a literal/folded block is just text.
      if (blockIndent !== undefined) {
        if (!value.trim() || leading > blockIndent) continue;
        blockIndent = undefined;
      }
      const prefix = /^( *)(?:-\s+)?[^\s:#][^:\n]*:\s+/.exec(value) ?? /^( *)-\s+/.exec(value);
      if (!prefix) continue;
      const rest = value.slice(prefix[0].length);
      if (/^[|>][\d+-]*(?:\s|$)/.test(rest)) { blockIndent = leading; continue; }
      if (!rest.startsWith("'") && !rest.startsWith('"')) continue;
      quote = rest[0]; indent = leading + 1;
      if (closes(rest, 1, quote)) quote = undefined;
    } else {
      // Do not join across serialized objects when a quote is genuinely missing.
      if (/^--- !u!/.test(value)) { quote = undefined; continue; }
      if (new RegExp(`^ *${quote}\\s*(?:#.*)?$`).test(value) && leading < indent) {
        lines[line] = ' '.repeat(indent - leading) + value;
      }
      if (closes(value, 0, quote)) quote = undefined;
    }
  }
  return lines.join('\n');
}

function closes(text: string, start: number, quote: string): boolean {
  for (let i = start; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') { i++; continue; }
    if (text[i] !== quote) continue;
    if (quote === "'" && text[i + 1] === "'") { i++; continue; }
    return true;
  }
  return false;
}

/** Legacy Unity maps serialize key/value pairs as repeated `data` mappings.
 * Retain all pairs before converting the YAML AST to JS; disabling uniqueKeys
 * alone would silently keep only the last entry and lose graph dependencies.
 */
export function parseUnityYaml(text: string): unknown {
  const doc = parseDocument(normalizeUnityQuotes(text), {
    schema: 'failsafe', logLevel: 'error',
    uniqueKeys: (a, b) => isScalar(a) && isScalar(b)
      ? a.value === b.value && a.value !== 'data'
      : a === b,
  });
  if (doc.errors.length) throw doc.errors[0];
  visit(doc, {
    Map(_, map) {
      const entries = map.items.filter(p => isScalar(p.key) && p.key.value === 'data');
      if (entries.length < 2) return;
      if (!entries.every(p => isMap(p.value) && p.value.items.length === 2 &&
        p.value.has('first') && p.value.has('second'))) {
        throw new Error('Duplicate data keys must contain Unity first/second pairs');
      }
      const values = new YAMLSeq(doc.schema);
      values.items = entries.map(p => p.value);
      entries[0].value = values;
      const removed = new Set(entries.slice(1));
      map.items = map.items.filter(p => !removed.has(p));
    },
  });
  return doc.toJS({ maxAliasCount: 0 });
}
