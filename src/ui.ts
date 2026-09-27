import * as vscode from 'vscode';
import { displayPath, isWorkspace, Scope, scopeFromDirs, WORKSPACE } from './scope';

export function toggleButton(icon: string, tooltip: string, checked: boolean, location?: vscode.QuickInputButtonLocation): vscode.QuickInputButton {
  return { iconPath: new vscode.ThemeIcon(icon), tooltip, toggle: { checked }, location };
}

export function setBusyContext(key: string, value: boolean): void {
  void vscode.commands.executeCommand('setContext', key, value);
}

const recentDirs: vscode.Uri[] = [];

export function rememberDirs(s: Scope): void {
  for (const d of s.dirs) {
    const i = recentDirs.findIndex((r) => r.toString() === d.toString());
    if (i >= 0) recentDirs.splice(i, 1);
    recentDirs.unshift(d);
  }
  recentDirs.splice(10);
}

type ScopeItem = vscode.QuickPickItem & { pick: () => Promise<Scope | undefined> };

/** Scope chooser: whole workspace, current / recent / parent directories, or browse. */
export async function pickScope(current: Scope): Promise<Scope | undefined> {
  const items: ScopeItem[] = [];
  items.push({
    label: '$(root-folder) Whole workspace',
    description: isWorkspace(current) ? 'current' : undefined,
    pick: async () => WORKSPACE,
  });
  const seen = new Set<string>();
  const addDir = (d: vscode.Uri, desc?: string) => {
    if (seen.has(d.toString())) return;
    seen.add(d.toString());
    items.push({ label: `$(folder) ${displayPath(d)}`, description: desc, pick: () => scopeFromDirs([d]) });
  };
  current.dirs.forEach((d) => addDir(d, 'current'));
  if (current.dirs.length === 1) {
    const folder = vscode.workspace.getWorkspaceFolder(current.dirs[0]);
    const parent = vscode.Uri.joinPath(current.dirs[0], '..');
    if (!folder || parent.path.length >= folder.uri.path.length) addDir(parent, 'parent');
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme !== 'untitled') addDir(vscode.Uri.joinPath(active, '..'), 'directory of current file');
  recentDirs.forEach((d) => addDir(d, 'recent'));
  items.push({
    label: '$(folder-opened) Choose directory…',
    pick: async () => {
      const res = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: true,
        defaultUri: current.dirs[0] ?? vscode.workspace.workspaceFolders?.[0]?.uri,
        openLabel: 'Search in Directory',
      });
      return res?.length ? scopeFromDirs(res) : undefined;
    },
  });
  const chosen = await vscode.window.showQuickPick(items, { title: 'Search Scope', placeHolder: 'Where to search' });
  const scope = chosen ? await chosen.pick() : undefined;
  if (scope) rememberDirs(scope);
  return scope;
}

/** IntelliJ-style file mask editor with recent masks. Returns '' to disable, undefined when cancelled. */
export function promptFileMask(current: string, recent: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    type MaskItem = vscode.QuickPickItem & { mask: string };
    const qp = vscode.window.createQuickPick<MaskItem>();
    qp.title = 'File Mask';
    qp.placeholder = 'e.g. *.ts, *.tsx, !*.test.ts';
    qp.value = current;
    (qp as any).sortByLabel = false;
    const defaults = ['*.ts, *.tsx', '*.js, *.jsx', '*.py', '*.java, *.kt', '*.json', '*.md'];
    const saved = [...new Set([...recent, ...defaults])];
    const refresh = () => {
      const v = qp.value.trim();
      qp.items = [
        ...(v ? [{ label: `$(filter) ${v}`, description: 'use this mask', mask: v, alwaysShow: true }] : []),
        { label: '$(close) No file mask', description: 'search all files', mask: '', alwaysShow: true },
        ...saved.filter((m) => m !== v).map((m) => ({ label: m, mask: m })),
      ];
    };
    refresh();
    let done = false;
    qp.onDidChangeValue(refresh);
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.activeItems[0]?.mask ?? qp.value.trim());
      qp.hide();
    });
    qp.onDidHide(() => { if (!done) resolve(undefined); qp.dispose(); });
    qp.show();
  });
}
