import * as path from 'path';
import * as vscode from 'vscode';
import { FileEntry, FileIndex } from './fileIndex';
import { matchPath, parseQuery } from './fuzzy';
import { isWorkspace, Scope, scopeLabel, WORKSPACE } from './scope';
import { pickScope, setBusyContext, toggleButton } from './ui';

export interface FileItem extends vscode.QuickPickItem {
  entry: FileEntry;
}

const MRU_KEY = 'intellijFind.goto.recent';
const EXCLUDES_KEY = 'intellijFind.goto.useExcludes';
const CONTEXT_KEY = 'intellijFind.gotoPopupVisible';
const LIMIT = 150;
const OPEN_TO_SIDE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open to the Side' };
const REVEAL: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Reveal in Explorer View' };

/** Keeps a most-recently-used list of files, like IntelliJ's Recent Files. */
export class RecentFiles implements vscode.Disposable {
  private list: string[];
  private readonly sub: vscode.Disposable;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.list = ctx.workspaceState.get<string[]>(MRU_KEY, []);
    this.sub = vscode.window.onDidChangeActiveTextEditor((e) => {
      if (!e || e.document.uri.scheme !== 'file') return;
      this.touch(e.document.uri);
    });
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') this.touch(active);
  }

  touch(uri: vscode.Uri): void {
    const k = uri.toString();
    this.list = [k, ...this.list.filter((x) => x !== k)].slice(0, 60);
    void this.ctx.workspaceState.update(MRU_KEY, this.list);
  }

  /** 0 for most recent … 1 for least; undefined when not recent. */
  rank(uri: vscode.Uri): number | undefined {
    const i = this.list.indexOf(uri.toString());
    return i < 0 ? undefined : i / this.list.length;
  }

  get uris(): string[] {
    return this.list;
  }

  dispose(): void {
    this.sub.dispose();
  }
}

export class GotoFilePopup implements vscode.Disposable {
  private qp?: vscode.QuickPick<FileItem>;
  private scope: Scope = WORKSPACE;
  private useExcludes: boolean;
  private entries: FileEntry[] = [];
  private loadSeq = 0;
  private expectedHides = 0;
  private debounce?: NodeJS.Timeout;
  private subs: vscode.Disposable[] = [];
  private scopeButton?: vscode.QuickInputButton;
  private excludesButton?: vscode.QuickInputButton;
  lastUpdate: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly index: FileIndex, private readonly recent: RecentFiles) {
    this.useExcludes = ctx.workspaceState.get<boolean>(EXCLUDES_KEY, true);
  }

  get quickPick(): vscode.QuickPick<FileItem> | undefined {
    return this.qp;
  }

  async show(scope: Scope, initial?: string): Promise<void> {
    this.scope = scope;
    const ed = vscode.window.activeTextEditor;
    const selected = ed && !ed.selection.isEmpty && ed.selection.isSingleLine ? ed.document.getText(ed.selection).trim() : undefined;
    const value = initial ?? (selected && selected.length < 200 ? selected : '');

    if (!this.qp) {
      const qp = vscode.window.createQuickPick<FileItem>();
      this.qp = qp;
      qp.placeholder = 'Enter file name (append :line to go to line, use / for directories)';
      qp.matchOnDescription = true;
      (qp as any).sortByLabel = false;
      this.subs.push(
        qp.onDidChangeValue(() => this.scheduleRank()),
        qp.onDidAccept(() => { const it = qp.activeItems[0] ?? qp.items.find((i) => i.entry); if (it) this.open(it, false); }),
        qp.onDidTriggerButton((b) => this.onButton(b)),
        qp.onDidTriggerItemButton((e) => {
          if (e.button === OPEN_TO_SIDE) this.open(e.item, true);
          if (e.button === REVEAL) { this.close(); void vscode.commands.executeCommand('revealInExplorer', e.item.entry.uri); }
        }),
        qp.onDidHide(() => this.onDidHide(qp)),
      );
      qp.show();
      setBusyContext(CONTEXT_KEY, true);
    }
    this.qp.value = value;
    try { (this.qp as any).valueSelection = [0, value.length]; } catch { /* older hosts */ }
    this.render();
    this.lastUpdate = this.load();
  }

  /** Re-rank now (used when the value is set programmatically). */
  requery(): void {
    this.rank();
  }

  private render(): void {
    const qp = this.qp;
    if (!qp) return;
    this.scopeButton = toggleButton('folder', `Scope: ${scopeLabel(this.scope)} — change…`, !isWorkspace(this.scope));
    this.excludesButton = toggleButton('exclude', 'Use Exclude Settings and Ignore Files', this.useExcludes);
    qp.buttons = [this.scopeButton, this.excludesButton];
    qp.title = isWorkspace(this.scope) ? 'Go to File' : `Go to File in ${scopeLabel(this.scope)}`;
    qp.prompt = [
      isWorkspace(this.scope) ? `In ${scopeLabel(this.scope)}` : `Directory: ${scopeLabel(this.scope)}`,
      ...(this.useExcludes ? [] : ['including ignored files']),
    ].join('   ·   ');
  }

  private async onButton(b: vscode.QuickInputButton): Promise<void> {
    if (b === this.excludesButton) {
      this.useExcludes = !this.useExcludes;
      void this.ctx.workspaceState.update(EXCLUDES_KEY, this.useExcludes);
      this.render();
      this.lastUpdate = this.load();
    } else if (b === this.scopeButton && this.qp) {
      this.expectedHides++; // the scope picker replaces us; that hide must not close the popup
      this.qp.hide();
      try {
        const s = await pickScope(this.scope);
        if (s) this.scope = s;
      } finally {
        this.render();
        this.qp?.show();
        this.lastUpdate = this.load();
      }
    }
  }

  private async load(): Promise<void> {
    const qp = this.qp;
    if (!qp) return;
    const seq = ++this.loadSeq;
    qp.busy = true;
    try {
      const entries = await this.index.entries(this.scope, this.useExcludes);
      if (seq !== this.loadSeq || this.qp !== qp) return;
      this.entries = entries;
      this.rank();
    } finally {
      if (seq === this.loadSeq && this.qp === qp) qp.busy = false;
    }
  }

  private scheduleRank(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.rank(), 25);
  }

  private rank(): void {
    const qp = this.qp;
    if (!qp) return;
    const q = parseQuery(qp.value);
    if (!q.raw) {
      qp.items = this.recentItems();
      return;
    }
    const scored: { e: FileEntry; score: number }[] = [];
    for (const e of this.entries) {
      // "deep/" should list the directory itself: match it as a path ending in '/'.
      const m = matchPath(q, e.isDir && !q.name ? e.rel + '/' : e.rel);
      if (!m) continue;
      let score = m.score;
      if (e.isDir) score -= q.name ? 6 : 0;
      const r = e.isDir ? undefined : this.recent.rank(e.uri);
      if (r !== undefined) score += 25 * (1 - r);
      scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || a.e.rel.length - b.e.rel.length || (a.e.rel < b.e.rel ? -1 : 1));
    qp.items = scored.slice(0, LIMIT).map(({ e }) => this.item(e));
  }

  private recentItems(): FileItem[] {
    const inScope = new Map(this.entries.filter((e) => !e.isDir).map((e) => [e.uri.toString(), e]));
    const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri.toString() : undefined))
      .filter((u): u is string => !!u);
    const ordered = [...new Set([...this.recent.uris, ...open])];
    const items = ordered.map((u) => inScope.get(u)).filter((e): e is FileEntry => !!e).slice(0, LIMIT).map((e) => this.item(e));
    if (items.length) items.unshift({ label: 'Recent Files', kind: vscode.QuickPickItemKind.Separator } as FileItem);
    return items;
  }

  private item(e: FileEntry): FileItem {
    const dir = path.posix.dirname(e.rel);
    return {
      label: path.posix.basename(e.rel),
      description: dir === '.' ? '' : dir,
      iconPath: e.isDir ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File,
      resourceUri: e.uri,
      alwaysShow: true,
      buttons: e.isDir ? [REVEAL] : [OPEN_TO_SIDE, REVEAL],
      entry: e,
    };
  }

  private open(item: FileItem, toSide: boolean): void {
    const q = parseQuery(this.qp?.value ?? '');
    this.close();
    const e = item.entry;
    if (e.isDir) {
      void vscode.commands.executeCommand('revealInExplorer', e.uri);
      return;
    }
    const opts: vscode.TextDocumentShowOptions = { preview: false, viewColumn: toSide ? vscode.ViewColumn.Beside : undefined };
    if (q.line) {
      const pos = new vscode.Position(Math.max(0, q.line - 1), Math.max(0, (q.column ?? 1) - 1));
      opts.selection = new vscode.Range(pos, pos);
    }
    void vscode.commands.executeCommand('vscode.open', e.uri, opts);
  }

  private onDidHide(qp: vscode.QuickPick<FileItem>): void {
    if (qp !== this.qp) return; // late event from a popup we already closed
    if (this.expectedHides > 0) { this.expectedHides--; return; }
    this.close();
  }

  close(): void {
    const qp = this.qp;
    if (!qp) return;
    this.qp = undefined;
    this.expectedHides = 0;
    clearTimeout(this.debounce);
    this.subs.forEach((s) => s.dispose());
    this.subs = [];
    qp.dispose();
    this.entries = [];
    setBusyContext(CONTEXT_KEY, false);
  }

  dispose(): void {
    this.close();
  }
}
