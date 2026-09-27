import * as vscode from 'vscode';
import { LineMatch, maskGlobs, searchText } from './rg';
import { displayPath, isWorkspace, Scope, scopeFromDirs, scopeLabel, searchRoots, WORKSPACE } from './scope';
import { EditorPreview } from './preview';
import { pickScope, promptFileMask, setBusyContext, toggleButton } from './ui';

export interface MatchItem extends vscode.QuickPickItem {
  match: LineMatch;
}

interface FindState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  fileMask: string;
  maskEnabled: boolean;
  useExcludes: boolean;
  pinned: boolean;
  history: string[];
  masks: string[];
}

const STATE_KEY = 'intellijFind.find.state';
const CONTEXT_KEY = 'intellijFind.findPopupVisible';
const OPEN_TO_SIDE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open to the Side' };

type ButtonId = 'case' | 'word' | 'regex' | 'mask' | 'scope' | 'excludes' | 'history' | 'pin' | 'searchView';

/** Escape `$(` so line text is never rendered as a codicon. */
function escapeIcons(s: string): string {
  return s.replace(/\$\(/g, '\\$(');
}

/** Keep labels short enough that the file/line description stays visible. */
const MAX_LABEL = 110;

function lineLabel(m: LineMatch): string {
  const raw = m.text.replace(/\t/g, '  ');
  const lead = raw.length - raw.trimStart().length;
  let start = lead;
  const first = m.ranges[0]?.[0] ?? 0;
  if (first - start > 60) start = first - 25;
  let s = raw.slice(start, start + MAX_LABEL).trimEnd();
  if (start > lead) s = '…' + s;
  if (raw.length > start + MAX_LABEL) s += '…';
  return escapeIcons(s);
}

export class FindInFilesPopup implements vscode.Disposable {
  private qp?: vscode.QuickPick<MatchItem>;
  private state: FindState;
  private scope: Scope = WORKSPACE;
  private searchCts?: vscode.CancellationTokenSource;
  private debounce?: NodeJS.Timeout;
  private previewTimer?: NodeJS.Timeout;
  private preview?: EditorPreview;
  private suspended = false; // true while a nested picker (scope / mask / history) is showing
  private lastSig = '';
  private pendingForce = false;
  private buttonIds = new Map<vscode.QuickInputButton, ButtonId>();
  private disposables: vscode.Disposable[] = [];
  /** Completes whenever a search run finishes; used by tests. */
  lastSearch: Promise<void> = Promise.resolve();
  lastSummary = '';

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.state = {
      query: '', caseSensitive: false, wholeWord: false, regex: false, fileMask: '*.ts',
      maskEnabled: false, useExcludes: true, pinned: false, history: [], masks: [],
      ...ctx.workspaceState.get<Partial<FindState>>(STATE_KEY),
    };
  }

  get quickPick(): vscode.QuickPick<MatchItem> | undefined {
    return this.qp;
  }

  async show(scope: Scope, initial?: string): Promise<void> {
    this.scope = scope;
    const sel = vscode.window.activeTextEditor?.selection;
    const doc = vscode.window.activeTextEditor?.document;
    const selected = sel && doc && !sel.isEmpty && sel.isSingleLine ? doc.getText(sel) : undefined;
    const query = initial ?? selected ?? this.state.query;

    if (this.qp) {
      // Re-invoked while open: adopt the new scope / selection.
      this.qp.value = query;
      this.render();
      this.schedule(0);
      return;
    }

    const qp = vscode.window.createQuickPick<MatchItem>();
    this.qp = qp;
    this.lastSig = '';
    this.preview = new EditorPreview();
    qp.placeholder = 'Search text in files';
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    qp.keepScrollPosition = true;
    // Runtime-settable (proposed typing only): keep our file order instead of label sorting.
    (qp as any).sortByLabel = false;
    qp.ignoreFocusOut = this.state.pinned;
    qp.value = query;
    try { (qp as any).valueSelection = [0, query.length]; } catch { /* older hosts */ }

    this.disposables.push(
      qp.onDidChangeValue(() => this.schedule(120, false)),
      qp.onDidChangeActive((items) => this.schedulePreview(items[0])),
      qp.onDidAccept(() => this.accept(false)),
      qp.onDidTriggerButton((b) => this.onButton(b)),
      qp.onDidTriggerItemButton((e) => { if (e.button === OPEN_TO_SIDE) this.open(e.item, true); }),
      qp.onDidHide(() => this.onHide()),
    );
    this.render();
    qp.show();
    setBusyContext(CONTEXT_KEY, true);
    this.schedule(0);
  }

  /** Re-run the search now (used when the value is set programmatically). */
  requery(): void {
    this.schedule(0);
  }

  // ------------------------------------------------------------------ toggles

  toggle(id: 'case' | 'word' | 'regex' | 'excludes' | 'pin'): void {
    const s = this.state;
    if (id === 'case') s.caseSensitive = !s.caseSensitive;
    if (id === 'word') s.wholeWord = !s.wholeWord;
    if (id === 'regex') s.regex = !s.regex;
    if (id === 'excludes') s.useExcludes = !s.useExcludes;
    if (id === 'pin') { s.pinned = !s.pinned; if (this.qp) this.qp.ignoreFocusOut = s.pinned; }
    this.save();
    this.render();
    if (id !== 'pin') this.schedule(0);
  }

  private async onButton(b: vscode.QuickInputButton): Promise<void> {
    const id = this.buttonIds.get(b);
    switch (id) {
      case 'case': case 'word': case 'regex': case 'excludes': case 'pin':
        this.toggle(id);
        break;
      case 'mask':
        await this.nested(async () => {
          const mask = await promptFileMask(this.state.maskEnabled ? this.state.fileMask : '', this.state.masks);
          if (mask === undefined) return;
          this.state.maskEnabled = mask.trim().length > 0;
          if (this.state.maskEnabled) {
            this.state.fileMask = mask.trim();
            this.state.masks = [this.state.fileMask, ...this.state.masks.filter((m) => m !== this.state.fileMask)].slice(0, 15);
          }
          this.save();
        });
        break;
      case 'scope':
        await this.nested(async () => {
          const s = await pickScope(this.scope);
          if (s) this.scope = s;
        });
        break;
      case 'history':
        await this.nested(async () => {
          const h = await vscode.window.showQuickPick(this.state.history, { placeHolder: 'Recent searches', title: 'Find in Files — History' });
          if (h !== undefined && this.qp) this.qp.value = h;
        });
        break;
      case 'searchView':
        this.openInSearchView();
        break;
    }
  }

  /** Run a nested picker; the main popup is hidden meanwhile and restored afterwards. */
  private async nested(fn: () => Promise<void>): Promise<void> {
    if (!this.qp) return;
    this.suspended = true;
    this.qp.hide();
    try {
      await fn();
    } finally {
      this.suspended = false;
      if (this.qp) {
        this.render();
        this.qp.show();
        this.schedule(0);
      }
    }
  }

  private render(): void {
    const qp = this.qp;
    if (!qp) return;
    const s = this.state;
    this.buttonIds.clear();
    const btn = (id: ButtonId, b: vscode.QuickInputButton) => { this.buttonIds.set(b, id); return b; };
    const inline = vscode.QuickInputButtonLocation.Input;
    qp.buttons = [
      btn('case', toggleButton('case-sensitive', 'Match Case (⌥C)', s.caseSensitive, inline)),
      btn('word', toggleButton('whole-word', 'Words (⌥W)', s.wholeWord, inline)),
      btn('regex', toggleButton('regex', 'Regex (⌥X)', s.regex, inline)),
      btn('mask', toggleButton('filter', s.maskEnabled ? `File mask: ${s.fileMask}` : 'File mask…', s.maskEnabled)),
      btn('scope', toggleButton('folder', `Scope: ${scopeLabel(this.scope)} — change…`, !isWorkspace(this.scope))),
      btn('excludes', toggleButton('exclude', 'Use Exclude Settings and Ignore Files', s.useExcludes)),
      btn('history', { iconPath: new vscode.ThemeIcon('history'), tooltip: 'Recent searches' }),
      btn('pin', toggleButton('pin', 'Pin Window (keep open on focus loss)', s.pinned)),
      btn('searchView', { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open in Search View (⌘↵)' }),
    ];
    const bits = [isWorkspace(this.scope) ? `In ${scopeLabel(this.scope)}` : `Directory: ${scopeLabel(this.scope)}`];
    if (s.maskEnabled) bits.push(`Mask: ${s.fileMask}`);
    if (!s.useExcludes) bits.push('including ignored files');
    qp.prompt = bits.join('   ·   ');
  }

  // ------------------------------------------------------------------ search

  /** `force` = re-run even when nothing changed (explicit refresh, re-open). Value echoes are deduped. */
  private schedule(delay = 120, force = true): void {
    clearTimeout(this.debounce);
    this.pendingForce ||= force;
    this.debounce = setTimeout(() => {
      const f = this.pendingForce;
      this.pendingForce = false;
      this.lastSearch = this.runSearch(f);
    }, delay);
  }

  private async runSearch(force: boolean): Promise<void> {
    const qp = this.qp;
    if (!qp || this.suspended) return;
    const s = this.state;
    const sig = JSON.stringify([qp.value, s.caseSensitive, s.wholeWord, s.regex, s.useExcludes, s.maskEnabled && s.fileMask, this.scope.dirs.map(String)]);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    this.searchCts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.searchCts = cts;
    const pattern = qp.value;
    this.state.query = pattern;
    this.save();

    if (!pattern) {
      qp.items = [];
      qp.title = 'Find in Files';
      qp.busy = false;
      this.lastSummary = '';
      return;
    }
    const max = vscode.workspace.getConfiguration('intellijFind').get<number>('maxResults', 1000);
    const roots = searchRoots(this.scope);
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const byFile = new Map<string, { order: string; items: MatchItem[] }>();
    // `cts` = superseded by a newer search; `rgCts` additionally fires when the result cap is hit.
    const rgCts = new vscode.CancellationTokenSource();
    const link = cts.token.onCancellationRequested(() => rgCts.cancel());
    let count = 0;
    let limited = false;
    let dirty = false;
    let published = false;

    const publish = (final: boolean) => {
      if (cts.token.isCancellationRequested || this.qp !== qp || (!dirty && !final)) return;
      dirty = false;
      const groups = [...byFile.values()].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
      const items = groups.flatMap((g) => g.items);
      const active = qp.activeItems[0];
      qp.items = items;
      if (published && active && items.includes(active)) qp.activeItems = [active];
      published = true;
      const plus = limited ? '+' : '';
      const summary = count
        ? `${count}${plus} match${count === 1 ? '' : 'es'} in ${byFile.size}${plus} file${byFile.size === 1 ? '' : 's'}`
        : final ? 'Nothing found' : '';
      qp.title = `Find in Files   ${summary}`;
      if (final) {
        this.lastSummary = summary;
        qp.busy = false;
        if (!items.length) this.preview?.clear();
      }
    };
    const timer = setInterval(() => publish(false), 60);
    qp.busy = true;

    await searchText(roots, {
      pattern,
      caseSensitive: this.state.caseSensitive,
      wholeWord: this.state.wholeWord,
      regex: this.state.regex,
      useExcludes: this.state.useExcludes,
      fileMask: this.state.maskEnabled ? this.state.fileMask : undefined,
    }, (m, rootIndex) => {
      if (count >= max) { limited = true; rgCts.cancel(); return; }
      const key = m.uri.toString();
      let g = byFile.get(key);
      if (!g) {
        g = { order: `${String(rootIndex).padStart(3, '0')}/${m.relPath.toLowerCase()}`, items: [] };
        byFile.set(key, g);
      }
      const folder = roots[rootIndex].folder;
      const rel = multiRoot && folder ? `${folder.name}/${m.relPath}` : m.relPath;
      g.items.push({
        label: lineLabel(m),
        description: `${rel} ${m.line + 1}`,
        iconPath: vscode.ThemeIcon.File,
        resourceUri: m.uri,
        alwaysShow: true,
        buttons: [OPEN_TO_SIDE],
        match: m,
      });
      count++;
      dirty = true;
    }, rgCts.token);

    clearInterval(timer);
    link.dispose();
    publish(true);
  }

  // ------------------------------------------------------------------ preview / open

  private schedulePreview(item: MatchItem | undefined): void {
    clearTimeout(this.previewTimer);
    if (!item || !vscode.workspace.getConfiguration('intellijFind').get<boolean>('previewOnNavigate', true)) return;
    this.previewTimer = setTimeout(() => {
      if (!this.qp || this.suspended) return;
      const siblings = (this.qp.items as MatchItem[]).filter((i) => i.match.uri.toString() === item.match.uri.toString());
      void this.preview?.show(item.match, siblings.map((i) => i.match));
    }, 40);
  }

  private accept(toSide: boolean): void {
    // Enter can land before the UI reports its focused item; the UI focuses the first result by default.
    const item = this.qp?.activeItems[0] ?? this.qp?.items[0];
    if (!item) return;
    this.open(item, toSide);
  }

  private open(item: MatchItem, toSide: boolean): void {
    this.rememberQuery();
    const preview = this.preview;
    this.preview = undefined; // don't restore on hide
    this.qp?.hide();
    void preview?.commit(item.match, toSide);
  }

  openInSearchView(): void {
    const qp = this.qp;
    if (!qp) return;
    this.rememberQuery();
    const s = this.state;
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const dirs = this.scope.dirs.map((d) => {
      const rel = vscode.workspace.asRelativePath(d, multiRoot);
      return rel === d.fsPath ? d.fsPath : `./${rel}`;
    });
    const masks = s.maskEnabled ? maskGlobs(s.fileMask) : [];
    const pos = masks.filter((m) => !m.startsWith('!'));
    const neg = masks.filter((m) => m.startsWith('!')).map((m) => m.slice(1));
    const include = dirs.length
      ? (pos.length ? dirs.flatMap((d) => pos.map((p) => `${d}/**/${p}`)) : dirs)
      : pos;
    const args = {
      query: qp.value,
      isRegex: s.regex,
      isCaseSensitive: s.caseSensitive,
      matchWholeWord: s.wholeWord,
      filesToInclude: include.join(', '),
      filesToExclude: neg.join(', '),
      useExcludeSettingsAndIgnoreFiles: s.useExcludes,
      triggerSearch: true,
      focusResults: true,
    };
    this.qp?.hide();
    void vscode.commands.executeCommand('workbench.action.findInFiles', args);
  }

  private rememberQuery(): void {
    const q = this.qp?.value;
    if (!q) return;
    this.state.history = [q, ...this.state.history.filter((h) => h !== q)].slice(0, 30);
    this.save();
  }

  private onHide(): void {
    if (this.suspended) return;
    this.searchCts?.cancel();
    clearTimeout(this.debounce);
    clearTimeout(this.previewTimer);
    const preview = this.preview;
    this.preview = undefined;
    void preview?.restore();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    this.qp?.dispose();
    this.qp = undefined;
    setBusyContext(CONTEXT_KEY, false);
  }

  private save(): void {
    void this.ctx.workspaceState.update(STATE_KEY, this.state);
  }

  dispose(): void {
    this.qp?.hide();
  }

  /** For tests. */
  async setScopeDirs(dirs: vscode.Uri[]): Promise<void> {
    this.scope = await scopeFromDirs(dirs);
    this.render();
    this.schedule(0);
  }

  get scopeDescription(): string {
    return isWorkspace(this.scope) ? 'workspace' : this.scope.dirs.map(displayPath).join(', ');
  }
}
