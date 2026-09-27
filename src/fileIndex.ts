import * as path from 'path';
import * as vscode from 'vscode';
import { listFiles } from './rg';
import { isWorkspace, Scope, searchRoots } from './scope';

export interface FileEntry {
  uri: vscode.Uri;
  /** Path used for matching and display: workspace-relative, '/' separated (folder-prefixed in multi-root). */
  rel: string;
  isDir: boolean;
}

/** Workspace file list from rg, cached until files are created/deleted. */
export class FileIndex implements vscode.Disposable {
  private cache = new Map<boolean, Promise<FileEntry[]>>();
  private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  private readonly subs: vscode.Disposable[];

  constructor() {
    const invalidate = () => this.cache.clear();
    this.subs = [
      this.watcher.onDidCreate(invalidate),
      this.watcher.onDidDelete(invalidate),
      vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('files.exclude') || e.affectsConfiguration('search')) invalidate();
      }),
    ];
  }

  private build(scope: Scope, useExcludes: boolean): Promise<FileEntry[]> {
    const roots = searchRoots(scope);
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const cts = new vscode.CancellationTokenSource();
    return listFiles(roots, { useExcludes }, cts.token).then((perRoot) => {
      const out: FileEntry[] = [];
      perRoot.forEach((files, i) => {
        const r = roots[i];
        const prefix = r.folder ? (multiRoot ? r.folder.name + '/' : '') : '';
        const dirs = new Set<string>();
        for (const f of files) {
          out.push({ uri: vscode.Uri.joinPath(r.root, f), rel: prefix + f, isDir: false });
          for (let d = path.posix.dirname(f); d !== '.' && d !== '/' && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
        }
        for (const d of dirs) out.push({ uri: vscode.Uri.joinPath(r.root, d), rel: prefix + d, isDir: true });
      });
      return out;
    });
  }

  /** Entries within the scope. Workspace scopes (and dirs inside it) are served from the cache. */
  async entries(scope: Scope, useExcludes: boolean): Promise<FileEntry[]> {
    const inWorkspace = scope.dirs.every((d) => vscode.workspace.getWorkspaceFolder(d));
    if (!inWorkspace) return this.build(scope, useExcludes);
    let all = this.cache.get(useExcludes);
    if (!all) {
      all = this.build({ dirs: [] }, useExcludes);
      this.cache.set(useExcludes, all);
      all.catch(() => this.cache.delete(useExcludes));
    }
    const list = await all;
    if (isWorkspace(scope)) return list;
    const prefixes = scope.dirs.map((d) => d.toString().replace(/\/?$/, '/'));
    return list.filter((e) => prefixes.some((p) => e.uri.toString().startsWith(p)));
  }

  dispose(): void {
    this.watcher.dispose();
    this.subs.forEach((s) => s.dispose());
  }
}
