import * as vscode from 'vscode';
import { EditorPreview, ReplacementFor } from './preview';
import { applyReplacements } from './replace';
import { makeReplacer, Replacer, replaceInLine } from './replaceText';
import { LineMatch, maskGlobs, searchText, TextQuery } from './rg';
import { displayPath, isWorkspace, Scope, scopeFromDirs, scopeLabel, searchRoots, WORKSPACE } from './scope';
import { pickScope, promptFileMask, setBusyContext, toggleButton } from './ui';

export interface MatchItem extends vscode.QuickPickItem {
  match: LineMatch;
}

export type Mode = 'find' | 'replace';

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
  lastReplacement: string;
}

const STATE_KEY = 'intellijFind.find.state';
const CONTEXT_KEY = 'intellijFind.findPopupVisible';
const REPLACE_CONTEXT_KEY = 'intellijFind.replaceMode';
const OPEN_TO_SIDE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open to the Side' };
const REPLACE_ONE: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('replace'), tooltip: 'Replace This Occurrence (⌥↵)' };

type ButtonId = 'case' | 'word' | 'regex' | 'mask' | 'scope' | 'excludes' | 'history' | 'pin' | 'searchView' | 'replaceEdit' | 'replaceAll';

/** Escape `$(` so line text is never rendered as a codicon. */
function escapeIcons(s: string): string {
  return s.replace(/\$\(/g, '\\$(');
}

/** Keep labels short enough that the file/line description stays visible. */
const MAX_LABEL = 110;

/** Visible window of a line: trimmed, and scrolled so a far-right first match stays in view. */
function windowed(text: string, firstMatch: number): string {
  const raw = text.replace(/\t/g, '  ');
  const lead = raw.length - raw.trimStart().length;
  let start = lead;
  if (firstMatch - start > 60) start = firstMatch - 25;
  let s = raw.slice(start, start + MAX_LABEL).trimEnd();
  if (start > lead) s = '…' + s;
  if (raw.length > start + MAX_LABEL) s += '…';
  return escapeIcons(s);
}

function lineLabel(m: LineMatch): string {
  return windowed(m.text, m.ranges[0]?.[0] ?? 0);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : word.endsWith('ch') ? 'es' : 's'}`;
}

export class FindInFilesPopup implements vscode.Disposable {
  private qp?: vscode.QuickPick<MatchItem>;
  private state: FindState;
  private scope: Scope = WORKSPACE;
  private mode: Mode = 'find';
  /** Undefined until the user sets one: an empty string is a deliberate "delete matches". */
  private replacement?: string;
  private searchCts?: vscode.CancellationTokenSource;
  private debounce?: NodeJS.Timeout;
  private previewTimer?: NodeJS.Timeout;
  private preview?: EditorPreview;
  private suspended = false; // true while a nested picker (scope / mask / history) is showing
  /** Hides we triggered ourselves (nested pickers, confirm dialog); their onDidHide must not close the popup. */
  private expectedHides = 0;
  private lastSig = '';
  private pendingForce = false;
  private restoreActiveIndex?: number;
  private buttonIds = new Map<vscode.QuickInputButton, ButtonId>();
  private disposables: vscode.Disposable[] = [];
  /** Completes whenever a search run finishes; used by tests. */
  lastSearch: Promise<void> = Promise.resolve();
  lastSummary = '';
  /** Replace All confirmation; replaceable by tests. */
  confirmReplace = async (message: string, detail: string): Promise<boolean> =>
    (await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Replace All')) === 'Replace All';

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.state = {
      query: '', caseSensitive: false, wholeWord: false, regex: false, fileMask: '*.ts',
      maskEnabled: false, useExcludes: true, pinned: false, history: [], masks: [], lastReplacement: '',
      ...ctx.workspaceState.get<Partial<FindState>>(STATE_KEY),
    };
  }

  get quickPick(): vscode.QuickPick<MatchItem> | undefined {
    return this.qp;
  }

  get currentMode(): Mode {
    return this.mode;
  }

  get currentReplacement(): string | undefined {
    return this.replacement;
  }

  /**
   * Open the popup (or, if open, switch mode / adopt a new explicit scope).
   * ⇧⌘R while already in replace mode edits the replacement.
   */
  async show(scope: Scope, mode: Mode = 'find'): Promise<void> {
    const sel = vscode.window.activeTextEditor?.selection;
    const doc = vscode.window.activeTextEditor?.document;
    const selected = sel && doc && !sel.isEmpty && sel.isSingleLine ? doc.getText(sel) : undefined;

    if (this.qp) {
      // A bare keypress (no explorer/context-menu scope) keeps the current scope.
      if (scope !== WORKSPACE) this.scope = scope;
      if (selected) this.qp.value = selected;
      if (mode === 'replace' && this.mode === 'replace') {
        await this.editReplacement();
        return;
      }
      this.setMode(mode);
      this.render();
      this.schedule(0);
      return;
    }

    this.scope = scope;
    const query = selected ?? this.state.query;
    const qp = vscode.window.createQuickPick<MatchItem>();
    this.qp = qp;
    this.lastSig = '';
    this.expectedHides = 0;
    this.preview = new EditorPreview();
    this.setMode(mode);
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
      qp.onDidTriggerItemButton((e) => {
        if (e.button === OPEN_TO_SIDE) this.open(e.item, true);
        if (e.button === REPLACE_ONE) void this.replaceOne(e.item);
      }),
      qp.onDidHide(() => this.onDidHide(qp)),
    );
    this.render();
    qp.show();
    setBusyContext(CONTEXT_KEY, true);
    this.schedule(0);
    // Select-then-⇧⌘R: the search is already known, go straight to the replacement.
    if (mode === 'replace' && selected) await this.editReplacement();
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    if (mode === 'replace' && this.replacement === undefined && this.state.lastReplacement) this.replacement = this.state.lastReplacement;
    setBusyContext(REPLACE_CONTEXT_KEY, mode === 'replace');
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
      case 'replaceEdit':
        await this.editReplacement();
        break;
      case 'replaceAll':
        await this.replaceAll();
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
    this.hideTemporarily(this.qp);
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
    const replacing = this.mode === 'replace';
    this.buttonIds.clear();
    const btn = (id: ButtonId, b: vscode.QuickInputButton) => { this.buttonIds.set(b, id); return b; };
    const inline = vscode.QuickInputButtonLocation.Input;
    qp.buttons = [
      btn('case', toggleButton('case-sensitive', 'Match Case (⌥C)', s.caseSensitive, inline)),
      btn('word', toggleButton('whole-word', 'Words (⌥W)', s.wholeWord, inline)),
      btn('regex', toggleButton('regex', 'Regex (⌥X)', s.regex, inline)),
      ...(replacing ? [
        btn('replaceEdit', { iconPath: new vscode.ThemeIcon('replace'), tooltip: 'Edit Replacement (⇧⌘R)' }),
        btn('replaceAll', { iconPath: new vscode.ThemeIcon('replace-all'), tooltip: 'Replace All (⌥A)' }),
      ] : []),
      btn('mask', toggleButton('filter', s.maskEnabled ? `File mask: ${s.fileMask}` : 'File mask…', s.maskEnabled)),
      btn('scope', toggleButton('folder', `Scope: ${scopeLabel(this.scope)} — change…`, !isWorkspace(this.scope))),
      btn('excludes', toggleButton('exclude', 'Use Exclude Settings and Ignore Files', s.useExcludes)),
      btn('history', { iconPath: new vscode.ThemeIcon('history'), tooltip: 'Recent searches' }),
      btn('pin', toggleButton('pin', 'Pin Window (keep open on focus loss)', s.pinned)),
      btn('searchView', { iconPath: new vscode.ThemeIcon('link-external'), tooltip: 'Open in Search View (⌘↵)' }),
    ];
    const bits: string[] = [];
    if (replacing) {
      bits.push(this.replacement === undefined
        ? 'Replace with: (not set — press ⇧⌘R)'
        : this.replacement === '' ? 'Replace with: (empty — deletes matches)' : `Replace with: ${this.replacement}`);
    }
    bits.push(isWorkspace(this.scope) ? `In ${scopeLabel(this.scope)}` : `Directory: ${scopeLabel(this.scope)}`);
    if (s.maskEnabled) bits.push(`Mask: ${s.fileMask}`);
    if (!s.useExcludes) bits.push('including ignored files');
    qp.prompt = bits.join('   ·   ');
    if (!qp.busy) qp.title = `${this.titlePrefix}   ${this.lastSummary}`;
  }

  private get titlePrefix(): string {
    return this.mode === 'replace' ? 'Replace in Files' : 'Find in Files';
  }

  // ------------------------------------------------------------------ search

  private textQuery(pattern: string): TextQuery {
    return {
      pattern,
      caseSensitive: this.state.caseSensitive,
      wholeWord: this.state.wholeWord,
      regex: this.state.regex,
      useExcludes: this.state.useExcludes,
      fileMask: this.state.maskEnabled ? this.state.fileMask : undefined,
    };
  }

  /** Replacer for the current query + replacement, or an error, or undefined when not replacing. */
  private replacer(): Replacer | { error: string } | undefined {
    const pattern = this.qp?.value;
    if (this.mode !== 'replace' || this.replacement === undefined || !pattern) return undefined;
    if (pattern.includes('\n')) return { error: 'Multi-line patterns can\'t be replaced here; use the Search view (⌘↵).' };
    return makeReplacer({ ...this.textQuery(pattern), replacement: this.replacement });
  }

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
    const sig = JSON.stringify([qp.value, s.caseSensitive, s.wholeWord, s.regex, s.useExcludes, s.maskEnabled && s.fileMask,
      this.scope.dirs.map(String), this.mode, this.replacement]);
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
      this.lastSummary = '';
      qp.title = this.titlePrefix;
      qp.busy = false;
      return;
    }
    const r = this.replacer();
    const replacer = r && !('error' in r) ? r : undefined;
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
      qp.title = `${this.titlePrefix}   ${summary}`;
      if (final) {
        this.lastSummary = summary;
        qp.busy = false;
        if (r && 'error' in r) qp.title += `   ⚠ ${r.error}`;
        if (!items.length) this.preview?.clear();
        if (this.restoreActiveIndex !== undefined && items.length) {
          qp.activeItems = [items[Math.min(this.restoreActiveIndex, items.length - 1)]];
        }
        this.restoreActiveIndex = undefined;
      }
    };
    const timer = setInterval(() => publish(false), 60);
    qp.busy = true;

    await searchText(roots, this.textQuery(pattern), (m, rootIndex) => {
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
        detail: replacer ? `→ ${windowed(replaceInLine(m.text, m.ranges, replacer), m.ranges[0]?.[0] ?? 0)}` : undefined,
        iconPath: vscode.ThemeIcon.File,
        resourceUri: m.uri,
        alwaysShow: true,
        buttons: this.mode === 'replace' ? [REPLACE_ONE, OPEN_TO_SIDE] : [OPEN_TO_SIDE],
        match: m,
      });
      count++;
      dirty = true;
    }, rgCts.token);

    clearInterval(timer);
    link.dispose();
    publish(true);
  }

  // ------------------------------------------------------------------ replace

  /** Ask for the replacement text (⇧⌘R inside the popup). */
  async editReplacement(): Promise<void> {
    await this.nested(async () => {
      const regex = this.state.regex;
      const v = await vscode.window.showInputBox({
        title: 'Replace in Files',
        prompt: regex
          ? `Replace /${this.qp?.value ?? ''}/ with…   $1, $<name>, $& insert captured text; \\n is a newline`
          : `Replace "${this.qp?.value ?? ''}" with…`,
        placeHolder: 'Replacement text (leave empty to delete the matches)',
        value: this.replacement ?? '',
      });
      if (v === undefined) return;
      this.replacement = v;
      if (v) this.state.lastReplacement = v;
      this.save();
    });
  }

  /** Resolve a usable replacer, prompting for the replacement first if needed. */
  private async readyReplacer(): Promise<Replacer | undefined> {
    if (this.replacement === undefined) await this.editReplacement();
    const r = this.replacer();
    if (!r) return undefined;
    if ('error' in r) {
      void vscode.window.showErrorMessage(r.error);
      return undefined;
    }
    return r;
  }

  /** Replace the active occurrence(s) on the selected row, then refresh the results. */
  async replaceSelected(): Promise<void> {
    const item = this.qp?.activeItems[0] ?? this.qp?.items[0];
    if (item) await this.replaceOne(item);
  }

  private async replaceOne(item: MatchItem): Promise<void> {
    const replacer = await this.readyReplacer();
    if (!replacer || !this.qp) return;
    const index = this.qp.items.indexOf(item);
    const res = await applyReplacements([item.match], replacer);
    vscode.window.setStatusBarMessage(res.replaced
      ? `Replaced ${plural(res.replaced, 'occurrence')}`
      : 'Nothing replaced: the line changed since the search', 3000);
    this.restoreActiveIndex = Math.max(0, index);
    this.schedule(0);
  }

  /** Replace every match (not just the displayed ones) after confirmation, then close. */
  async replaceAll(): Promise<void> {
    const replacer = await this.readyReplacer();
    const qp = this.qp;
    if (!replacer || !qp || !qp.value) return;
    const pattern = qp.value;
    qp.busy = true;
    const all: LineMatch[] = [];
    await searchText(searchRoots(this.scope), this.textQuery(pattern), (m) => all.push(m), new vscode.CancellationTokenSource().token);
    qp.busy = false;
    const occurrences = all.reduce((n, m) => n + m.ranges.length, 0);
    if (!occurrences) {
      void vscode.window.showInformationMessage(`Nothing to replace: "${pattern}" was not found.`);
      return;
    }
    const files = new Set(all.map((m) => m.uri.toString())).size;
    const shown = this.replacement === '' ? 'nothing (delete)' : `"${this.replacement}"`;

    // The modal steals focus, which would close the popup; suspend it while asking.
    this.suspended = true;
    this.hideTemporarily(qp);
    const ok = await this.confirmReplace(
      `Replace ${plural(occurrences, 'occurrence')} of "${pattern}" in ${plural(files, 'file')} with ${shown}?`,
      `Scope: ${scopeLabel(this.scope)}. Files without unsaved changes are saved; the whole replacement is one undo step.`,
    );
    this.suspended = false;
    if (!ok) {
      if (this.qp) { this.render(); this.qp.show(); }
      return;
    }
    this.rememberQuery();
    const preview = this.preview;
    this.preview = undefined;
    await preview?.restore();
    this.close();
    const res = await applyReplacements(all, replacer);
    const skipped = res.skipped ? ` (${plural(res.skipped, 'occurrence')} skipped: changed since the search)` : '';
    void vscode.window.showInformationMessage(`Replaced ${plural(res.replaced, 'occurrence')} in ${plural(res.files, 'file')}${skipped}.`);
  }

  // ------------------------------------------------------------------ preview / open

  private schedulePreview(item: MatchItem | undefined): void {
    clearTimeout(this.previewTimer);
    if (!item || !vscode.workspace.getConfiguration('intellijFind').get<boolean>('previewOnNavigate', true)) return;
    this.previewTimer = setTimeout(() => {
      if (!this.qp || this.suspended) return;
      const siblings = (this.qp.items as MatchItem[]).filter((i) => i.match.uri.toString() === item.match.uri.toString());
      const r = this.replacer();
      const replacement: ReplacementFor | undefined = r && !('error' in r) ? (m, [s, e]) => r.replace(m.text, s, e) : undefined;
      void this.preview?.show(item.match, siblings.map((i) => i.match), replacement);
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
    this.close();
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
    const replacing = this.mode === 'replace';
    const args = {
      query: qp.value,
      ...(replacing ? { replace: this.replacement ?? '' } : {}),
      isRegex: s.regex,
      isCaseSensitive: s.caseSensitive,
      matchWholeWord: s.wholeWord,
      filesToInclude: include.join(', '),
      filesToExclude: neg.join(', '),
      useExcludeSettingsAndIgnoreFiles: s.useExcludes,
      triggerSearch: true,
      focusResults: true,
    };
    this.close();
    void vscode.commands.executeCommand(replacing ? 'workbench.action.replaceInFiles' : 'workbench.action.findInFiles', args);
  }

  private rememberQuery(): void {
    const q = this.qp?.value;
    if (!q) return;
    this.state.history = [q, ...this.state.history.filter((h) => h !== q)].slice(0, 30);
    this.save();
  }

  private hideTemporarily(qp: vscode.QuickPick<MatchItem>): void {
    this.expectedHides++;
    qp.hide();
  }

  private onDidHide(qp: vscode.QuickPick<MatchItem>): void {
    if (qp !== this.qp) return; // late event from a popup we already closed
    if (this.expectedHides > 0) { this.expectedHides--; return; }
    this.close();
  }

  /** Close the popup now (Esc, open, Replace All…); undoes the preview unless it was committed. */
  close(): void {
    const qp = this.qp;
    if (!qp) return;
    this.qp = undefined;
    this.suspended = false;
    if (qp.value) { this.state.query = qp.value; this.save(); } // remembered even if no search ran yet
    this.searchCts?.cancel();
    clearTimeout(this.debounce);
    clearTimeout(this.previewTimer);
    const preview = this.preview;
    this.preview = undefined;
    void preview?.restore();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    qp.dispose();
    this.mode = 'find';
    this.replacement = undefined;
    setBusyContext(CONTEXT_KEY, false);
    setBusyContext(REPLACE_CONTEXT_KEY, false);
  }

  private save(): void {
    void this.ctx.workspaceState.update(STATE_KEY, this.state);
  }

  dispose(): void {
    this.close();
  }

  /** For tests. */
  async setScopeDirs(dirs: vscode.Uri[]): Promise<void> {
    this.scope = await scopeFromDirs(dirs);
    this.render();
    this.schedule(0);
  }

  /** For tests: set the replacement without the input box. */
  setReplacement(v: string | undefined): void {
    this.replacement = v;
    this.render();
    this.schedule(0);
  }

  get scopeDescription(): string {
    return isWorkspace(this.scope) ? 'workspace' : this.scope.dirs.map(displayPath).join(', ');
  }
}
