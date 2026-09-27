// IntelliJ-style "Go to File" matcher.
//
// A pattern is split into fragments; each fragment is a contiguous run in the name.
// The first fragment may start anywhere, every following fragment must start at a
// word boundary (camelHump, after - _ . space, digit boundary). This mirrors
// IntelliJ's MinusculeMatcher with its implicit leading '*'.

export type Range = [start: number, end: number];

export interface NameMatch {
  score: number;
  ranges: Range[];
}

const SEPARATORS = new Set(['-', '_', '.', ' ', '/', '\\', '$', '@', '+', '(', ')', '[', ']']);

function isUpper(c: string): boolean {
  return c !== c.toLowerCase() && c === c.toUpperCase();
}
function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

export function wordStarts(name: string): boolean[] {
  const out = new Array<boolean>(name.length).fill(false);
  for (let i = 0; i < name.length; i++) {
    const c = name[i];
    if (i === 0) { out[i] = true; continue; }
    const p = name[i - 1];
    if (SEPARATORS.has(c)) continue;
    if (SEPARATORS.has(p)) { out[i] = true; continue; }
    if (isUpper(c) && !isUpper(p)) { out[i] = true; continue; }
    if (isUpper(c) && isUpper(p) && i + 1 < name.length && !isUpper(name[i + 1]) && !SEPARATORS.has(name[i + 1]) && !isDigit(name[i + 1])) { out[i] = true; continue; }
    if (isDigit(c) && !isDigit(p)) { out[i] = true; continue; }
  }
  return out;
}

/** Cheap pre-filter: is the (lower-cased) pattern a subsequence of the (lower-cased) name? */
function isSubsequence(p: string, n: string): boolean {
  let j = 0;
  for (let i = 0; i < n.length && j < p.length; i++) if (n[i] === p[j]) j++;
  return j === p.length;
}

export function matchName(pattern: string, name: string): NameMatch | undefined {
  if (!pattern) return { score: 0, ranges: [] };
  const pl = pattern.toLowerCase();
  const nl = name.toLowerCase();
  if (!isSubsequence(pl, nl)) return undefined;

  const P = pl.length;
  const N = nl.length;
  const starts = wordStarts(name);
  const memo = new Map<number, NameMatch | null>();

  const best = (pi: number, ni: number): NameMatch | null => {
    if (pi === P) return { score: 0, ranges: [] };
    const key = pi * (N + 1) + ni;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: NameMatch | null = null;
    const first = pi === 0;
    for (let s = ni; s <= N - (P - pi); s++) {
      if (nl[s] !== pl[pi]) continue;
      // Later fragments start at a word boundary, or at a separator the pattern names explicitly ("ext.ts").
      if (!first && !starts[s] && !SEPARATORS.has(pl[pi])) continue;
      let maxLen = 0;
      while (pi + maxLen < P && s + maxLen < N && nl[s + maxLen] === pl[pi + maxLen]) maxLen++;
      for (let len = maxLen; len >= 1; len--) {
        const rest = best(pi + len, s + len);
        if (!rest) continue;
        let score = len + (len - 1) * 3;
        if (starts[s]) score += 8;
        if (s === 0) score += 10;
        if (first && !starts[s]) score -= 4;
        for (let k = 0; k < len; k++) if (pattern[pi + k] === name[s + k]) score += 0.5;
        score -= 3; // per-fragment cost: fewer, longer fragments win
        score += rest.score;
        if (!result || score > result.score) result = { score, ranges: [[s, s + len], ...rest.ranges] };
        break; // longest viable fragment at this start is good enough
      }
    }
    memo.set(key, result);
    return result;
  };

  const m = best(0, 0);
  if (!m) return undefined;
  let score = m.score;
  const dot = nl.lastIndexOf('.');
  const stem = dot > 0 ? nl.slice(0, dot) : nl;
  if (nl === pl) score += 100;
  else if (stem === pl) score += 80;
  else if (nl.startsWith(pl)) score += 40;
  score -= name.length * 0.05;
  return { score, ranges: m.ranges };
}

export interface ParsedQuery {
  /** Patterns for directory components, in order. */
  dirs: string[];
  /** Pattern for the file (or directory) name. May be empty when query ends with '/'. */
  name: string;
  line?: number;
  column?: number;
  /** Normalised query without the line suffix, for exact-path comparison. */
  raw: string;
}

export function parseQuery(input: string): ParsedQuery {
  let q = input.trim().replace(/\\/g, '/');
  let line: number | undefined;
  let column: number | undefined;
  const lm = /(?::|\()(\d+)(?:[:,](\d+))?\)?$/.exec(q);
  if (lm) {
    line = parseInt(lm[1], 10);
    column = lm[2] ? parseInt(lm[2], 10) : undefined;
    q = q.slice(0, lm.index);
  }
  q = q.replace(/^\.?\/+/, '').replace(/\s+/g, '');
  const parts = q.split('/');
  const name = parts.pop() ?? '';
  return { dirs: parts.filter(Boolean), name, line, column, raw: q };
}

export interface PathMatch {
  score: number;
  nameRanges: Range[];
}

/** Match a parsed query against a relative path ("a/b/c.ts"). */
export function matchPath(q: ParsedQuery, relPath: string): PathMatch | undefined {
  const slash = relPath.lastIndexOf('/');
  const name = relPath.slice(slash + 1);
  const dirPart = slash >= 0 ? relPath.slice(0, slash) : '';

  const nm = matchName(q.name, name);
  if (!nm) return undefined;
  let score = nm.score;

  if (q.dirs.length) {
    const comps = dirPart ? dirPart.split('/') : [];
    let ci = 0;
    let lastMatched = -1;
    for (const dp of q.dirs) {
      let found = false;
      for (; ci < comps.length; ci++) {
        const dm = matchName(dp, comps[ci]);
        if (dm) {
          score += dm.score * 0.5;
          lastMatched = ci;
          ci++;
          found = true;
          break;
        }
      }
      if (!found) return undefined;
    }
    // Prefer the last directory pattern matching the immediate parent.
    if (lastMatched === comps.length - 1) score += 15;
    else score -= (comps.length - 1 - lastMatched) * 2;
  }

  if (q.raw && relPath.toLowerCase() === q.raw.toLowerCase()) score += 200;
  else if (q.raw.includes('/') && relPath.toLowerCase().endsWith(q.raw.toLowerCase())) score += 60;

  score -= relPath.split('/').length * 0.5;
  return { score, nameRanges: nm.ranges };
}
