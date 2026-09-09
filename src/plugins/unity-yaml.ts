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
