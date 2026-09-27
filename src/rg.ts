import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as vscode from 'vscode';

let rgPathCache: string | undefined;

/** Locate the ripgrep binary shipped with VS Code; fall back to `rg` on PATH. */
export function rgPath(): string {
  if (rgPathCache) return rgPathCache;
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const root = vscode.env.appRoot;
  const plat = `${process.platform}-${process.arch}`;
  const candidates: string[] = [];
  for (const nm of ['node_modules.asar.unpacked', 'node_modules']) {
    candidates.push(path.join(root, nm, '@vscode', 'ripgrep-universal', 'bin', plat, exe));
    candidates.push(path.join(root, nm, '@vscode', 'ripgrep', 'bin', exe));
    const uniBin = path.join(root, nm, '@vscode', 'ripgrep-universal', 'bin');
    try {
      for (const d of fs.readdirSync(uniBin)) if (d.startsWith(process.platform)) candidates.push(path.join(uniBin, d, exe));
    } catch { /* not present */ }
  }
  rgPathCache = candidates.find((c) => fs.existsSync(c)) ?? exe;
  return rgPathCache;
}

/** A physical search root: rg runs with cwd = root and searches `paths` (relative to root; empty = whole root). */
export interface SearchRoot {
  root: vscode.Uri;
  folder?: vscode.WorkspaceFolder;
  paths: string[];
}

export interface CommonOptions {
  /** When false, ignore files and search.exclude are bypassed (files.exclude still applies). */
  useExcludes: boolean;
  /** Comma separated IntelliJ-style file mask, e.g. "*.ts, !*.test.ts". */
  fileMask?: string;
}

function excludeGlobs(folder: vscode.WorkspaceFolder | undefined, useExcludes: boolean): string[] {
  const read = (section: string) =>
    vscode.workspace.getConfiguration(section, folder?.uri).get<Record<string, unknown>>('exclude') ?? {};
  const all = { ...read('files'), ...(useExcludes ? read('search') : {}) };
  return Object.entries(all).filter(([, v]) => v === true).map(([k]) => k);
}

export function maskGlobs(mask: string | undefined): string[] {
  if (!mask) return [];
  return mask.split(',').map((s) => s.trim()).filter(Boolean);
}

function commonArgs(r: SearchRoot, o: CommonOptions): string[] {
  const cfg = vscode.workspace.getConfiguration('search', r.folder?.uri);
  const args = ['--hidden', '--no-config'];
  if (!o.useExcludes || !cfg.get<boolean>('useIgnoreFiles', true)) args.push('--no-ignore');
  else {
    if (!cfg.get<boolean>('useParentIgnoreFiles', false)) args.push('--no-ignore-parent');
    if (!cfg.get<boolean>('useGlobalIgnoreFiles', false)) args.push('--no-ignore-global');
  }
  if (cfg.get<boolean>('followSymlinks', true)) args.push('--follow');
  // Later globs win in rg: mask first so excludes always hold.
  for (const g of maskGlobs(o.fileMask)) args.push('-g', g);
  for (const g of excludeGlobs(r.folder, o.useExcludes)) args.push('-g', '!' + g);
  return args;
}

function run(r: SearchRoot, args: string[], onLine: (line: string) => void, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(rgPath(), [...args, ...r.paths], { cwd: r.root.fsPath, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve();
      return;
    }
    const sub = token.onCancellationRequested(() => proc.kill());
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (l) => { if (!token.isCancellationRequested) onLine(l); });
    proc.stderr!.resume();
    const done = () => { sub.dispose(); resolve(); };
    proc.on('error', done);
    proc.on('close', done);
  });
}

// ---------------------------------------------------------------- text search

export interface TextQuery extends CommonOptions {
  pattern: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface LineMatch {
  uri: vscode.Uri;
  relPath: string;
  line: number; // 0-based
  text: string;
  ranges: [number, number][]; // UTF-16 columns within `text`
}

function byteToCharOffsets(text: string, spans: { start: number; end: number }[]): [number, number][] {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text)) return spans.map((s) => [s.start, s.end]);
  const buf = Buffer.from(text, 'utf8');
  const conv = (b: number) => buf.subarray(0, b).toString('utf8').length;
  return spans.map((s) => [conv(s.start), conv(s.end)]);
}

export async function searchText(
  roots: SearchRoot[],
  q: TextQuery,
  onMatch: (m: LineMatch, rootIndex: number) => void,
  token: vscode.CancellationToken,
): Promise<void> {
  await Promise.all(roots.map((r, idx) => {
    const args = ['--json', ...commonArgs(r, q)];
    args.push(q.caseSensitive ? '--case-sensitive' : '--ignore-case');
    if (q.wholeWord) args.push('--word-regexp');
    if (!q.regex) args.push('--fixed-strings');
    if (q.pattern.includes('\n')) args.push('--multiline');
    args.push('-e', q.pattern, '--');
    return run(r, args, (line) => {
      if (!line.startsWith('{"type":"match"')) return;
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      const d = msg.data;
      const p: string | undefined = d.path?.text;
      const text: string | undefined = d.lines?.text;
      if (p === undefined || text === undefined) return;
      const rel = p.replace(/^\.[\\/]/, '').replace(/\\/g, '/');
      const firstLine = text.replace(/\r?\n$/, '').split(/\r?\n/)[0];
      onMatch({
        uri: vscode.Uri.joinPath(r.root, rel),
        relPath: rel,
        line: d.line_number - 1,
        text: firstLine,
        ranges: byteToCharOffsets(text, d.submatches ?? []).filter(([s]) => s <= firstLine.length),
      }, idx);
    }, token);
  }));
}

// ---------------------------------------------------------------- file listing

/** Lists files (relative to each root, '/' separated). */
export async function listFiles(roots: SearchRoot[], o: CommonOptions, token: vscode.CancellationToken): Promise<string[][]> {
  return Promise.all(roots.map(async (r) => {
    const out: string[] = [];
    await run(r, ['--files', ...commonArgs(r, o), '--'], (l) => out.push(l.replace(/^\.[\\/]/, '').replace(/\\/g, '/')), token);
    return out;
  }));
}
