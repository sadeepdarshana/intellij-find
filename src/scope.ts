import * as path from 'path';
import * as vscode from 'vscode';
import { SearchRoot } from './rg';

/** Either the whole workspace (dirs empty) or a set of directories. */
export interface Scope {
  dirs: vscode.Uri[];
}

export const WORKSPACE: Scope = { dirs: [] };

export interface CommandArgs {
  /** Set by the keybinding that fires while the explorer has focus. */
  fromExplorer?: boolean;
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    return ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

/** Files resolve to their parent directory; nested dirs collapse into their ancestor. */
async function toScope(uris: vscode.Uri[]): Promise<Scope> {
  const dirs: vscode.Uri[] = [];
  for (const u of uris) dirs.push((await isDirectory(u)) ? u : vscode.Uri.joinPath(u, '..'));
  const unique = [...new Map(dirs.map((d) => [d.toString(), d])).values()];
  const within = (a: vscode.Uri, b: vscode.Uri) =>
    a.scheme === b.scheme && a.authority === b.authority && a.path !== b.path && a.path.startsWith(b.path.replace(/\/?$/, '/'));
  return { dirs: unique.filter((d) => !unique.some((o) => within(d, o))) };
}

/**
 * There is no API for the explorer selection, so when invoked by keybinding from the
 * explorer we let the built-in `copyFilePath` resolve it and restore the clipboard after.
 */
async function explorerSelection(): Promise<vscode.Uri[]> {
  const saved = await vscode.env.clipboard.readText();
  try {
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('copyFilePath');
    const text = await vscode.env.clipboard.readText();
    return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map(fsPathToUri);
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
}

function fsPathToUri(p: string): vscode.Uri {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    const rel = path.relative(f.uri.fsPath, p);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel ? vscode.Uri.joinPath(f.uri, ...rel.split(path.sep)) : f.uri;
  }
  return vscode.Uri.file(p);
}

/** Resolve the scope from however the command was invoked. */
export async function scopeFromInvocation(arg?: unknown, multi?: unknown): Promise<Scope> {
  if (arg instanceof vscode.Uri) {
    const uris = Array.isArray(multi) && multi.length && multi.every((u) => u instanceof vscode.Uri) ? (multi as vscode.Uri[]) : [arg];
    return toScope(uris);
  }
  if (arg && typeof arg === 'object' && (arg as CommandArgs).fromExplorer) {
    const sel = await explorerSelection();
    if (sel.length) return toScope(sel);
  }
  return WORKSPACE;
}

export function scopeFromDirs(dirs: vscode.Uri[]): Promise<Scope> {
  return toScope(dirs);
}

export function isWorkspace(s: Scope): boolean {
  return s.dirs.length === 0;
}

/** Short human label: "workspace" or "~/…/dir". */
export function scopeLabel(s: Scope): string {
  if (isWorkspace(s)) {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length === 1 ? folders[0].name : 'Workspace';
  }
  return s.dirs.map((d) => displayPath(d)).join(', ');
}

export function displayPath(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
  if (rel !== uri.fsPath && rel !== uri.toString()) return rel || '.';
  const home = process.env.HOME;
  return home && uri.fsPath.startsWith(home) ? '~' + uri.fsPath.slice(home.length) : uri.fsPath;
}

/**
 * Physical rg roots for a scope. Scoped dirs inside a workspace folder run from that
 * folder (so workspace-relative exclude globs stay anchored correctly).
 */
export function searchRoots(s: Scope): SearchRoot[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (isWorkspace(s)) {
    if (folders.length) return folders.map((f) => ({ root: f.uri, folder: f, paths: [] }));
    const active = vscode.window.activeTextEditor?.document.uri;
    return active && active.scheme === 'file' ? [{ root: vscode.Uri.joinPath(active, '..'), paths: [] }] : [];
  }
  const byRoot = new Map<string, SearchRoot>();
  for (const d of s.dirs) {
    const folder = vscode.workspace.getWorkspaceFolder(d);
    if (folder) {
      const rel = path.posix.relative(folder.uri.path, d.path);
      const r = byRoot.get(folder.uri.toString()) ?? { root: folder.uri, folder, paths: [] };
      if (rel) r.paths.push(rel);
      else r.paths = [];
      byRoot.set(folder.uri.toString(), r);
    } else {
      byRoot.set(d.toString(), { root: d, paths: [] });
    }
  }
  return [...byRoot.values()];
}
