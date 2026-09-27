// Replacement text computation (no vscode dependency, unit-tested).
//
// rg finds matches (Rust regex); replacements are expanded with an equivalent JS RegExp run
// at the exact position rg reported. If JS can't reproduce that match the occurrence is
// skipped rather than guessed.

export interface ReplaceSpec {
  pattern: string;
  replacement: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface Replacer {
  /** Replacement for `line.slice(start, end)`, or undefined when it can't be computed safely. */
  replace(line: string, start: number, end: number): string | undefined;
}

/** Expand `$&`, `$0`–`$99`, `$<name>`, `$$` and `\n` `\t` `\\` escapes in a regex replacement. */
export function expand(template: string, m: RegExpExecArray): string {
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    const n = template[i + 1];
    if (c === '\\' && n !== undefined) {
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === 't') { out += '\t'; i++; continue; }
      if (n === '\\') { out += '\\'; i++; continue; }
      out += c;
      continue;
    }
    if (c !== '$' || n === undefined) { out += c; continue; }
    if (n === '$') { out += '$'; i++; continue; }
    if (n === '&') { out += m[0]; i++; continue; }
    if (n === '<') {
      const close = template.indexOf('>', i + 2);
      const name = close > 0 ? template.slice(i + 2, close) : '';
      if (name && m.groups && name in m.groups) { out += m.groups[name] ?? ''; i = close; continue; }
      out += c;
      continue;
    }
    if (n >= '0' && n <= '9') {
      const two = template.slice(i + 1, i + 3);
      if (/^\d\d$/.test(two) && Number(two) < m.length) { out += m[Number(two)] ?? ''; i += 2; continue; }
      if (Number(n) < m.length) { out += m[Number(n)] ?? ''; i++; continue; }
    }
    out += c;
  }
  return out;
}

/** Build a replacer, or return an error message when the pattern has no JS equivalent. */
export function makeReplacer(spec: ReplaceSpec): Replacer | { error: string } {
  if (!spec.regex) return { replace: () => spec.replacement };
  const source = spec.wholeWord ? `\\b(?:${spec.pattern})\\b` : spec.pattern;
  const flags = (spec.caseSensitive ? '' : 'i') + 'y';
  let re: RegExp;
  try {
    re = new RegExp(source, flags + 'u');
  } catch {
    try {
      re = new RegExp(source, flags);
    } catch (e) {
      return { error: `Can't use this regex for replacing: ${(e as Error).message}` };
    }
  }
  return {
    replace(line, start, end) {
      re.lastIndex = start;
      const m = re.exec(line);
      if (!m || m.index !== start || m[0].length !== end - start) return undefined;
      return expand(spec.replacement, m);
    },
  };
}

/** Line text after replacing the given spans (used for previews). Unresolvable spans are left as-is. */
export function replaceInLine(line: string, ranges: [number, number][], r: Replacer): string {
  let out = line;
  for (const [s, e] of [...ranges].sort((a, b) => b[0] - a[0])) {
    const rep = r.replace(line, s, e);
    if (rep !== undefined) out = out.slice(0, s) + rep + out.slice(e);
  }
  return out;
}
