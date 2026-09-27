import * as vscode from 'vscode';
import { LineMatch } from './rg';

/** Replacement text for one match span, or undefined when it can't be computed. */
export type ReplacementFor = (m: LineMatch, span: [number, number]) => string | undefined;

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  return tab.input instanceof vscode.TabInputText ? tab.input.uri : undefined;
}

function matchRange(m: LineMatch): vscode.Range {
  const [s, e] = m.ranges[0] ?? [0, 0];
  return new vscode.Range(m.line, s, m.line, e);
}

/**
 * Previews matches in the editor area behind the popup (VS Code has no floating editor
 * surface), and on cancel puts the editor area back the way it was.
 */
export class EditorPreview {
  private readonly origin?: {
    uri: vscode.Uri;
    viewColumn?: vscode.ViewColumn;
    selections: readonly vscode.Selection[];
    top?: vscode.Range;
  };
  private readonly openBefore: Set<string>;
  private shown?: vscode.Uri;
  private readonly current = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchBackground'),
    borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
    borderStyle: 'solid',
    borderWidth: '1px',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
    isWholeLine: false,
  });
  private readonly others = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Center,
  });
  /** Replace mode: the old text struck through, with the replacement rendered right after it. */
  private readonly removed = vscode.window.createTextEditorDecorationType({
    textDecoration: 'line-through',
    backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground'),
  });
  private readonly line = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
  });

  constructor() {
    const ed = vscode.window.activeTextEditor;
    if (ed) {
      this.origin = { uri: ed.document.uri, viewColumn: ed.viewColumn, selections: ed.selections, top: ed.visibleRanges[0] };
    }
    this.openBefore = new Set(
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).map(tabUri).filter((u): u is vscode.Uri => !!u).map((u) => u.toString()),
    );
  }

  private get column(): vscode.ViewColumn {
    return this.origin?.viewColumn ?? vscode.ViewColumn.Active;
  }

  // Editor operations are async; run them strictly in order so a late preview can never
  // land after restore/commit, and skip previews superseded by a newer request.
  private queue: Promise<void> = Promise.resolve();
  private latest = 0;
  private closed = false;

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch(() => undefined);
    return this.queue;
  }

  show(m: LineMatch, sameFile: LineMatch[], replacement?: ReplacementFor): Promise<void> {
    const id = ++this.latest;
    return this.enqueue(async () => {
      if (!this.closed && id === this.latest) await this.doShow(m, sameFile, replacement);
    });
  }

  private async doShow(m: LineMatch, sameFile: LineMatch[], replacement?: ReplacementFor): Promise<void> {
    const range = matchRange(m);
    const prev = this.shown;
    let editor: vscode.TextEditor;
    try {
      editor = await vscode.window.showTextDocument(m.uri, {
        preview: true,
        preserveFocus: true,
        viewColumn: this.column,
        selection: new vscode.Range(range.start, range.start),
      });
    } catch {
      return;
    }
    this.shown = m.uri;
    if (prev && prev.toString() !== m.uri.toString()) await this.closeIfTransient(prev);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    const all = sameFile.flatMap((x) => x.ranges.map(([s, e]) => new vscode.Range(x.line, s, x.line, e)));
    editor.setDecorations(this.others, replacement ? [] : all.filter((r) => !r.isEqual(range)));
    editor.setDecorations(this.current, [range]);
    editor.setDecorations(this.removed, replacement ? sameFile.flatMap((x) => x.ranges.map((span) => {
      const rep = replacement(x, span);
      return {
        range: new vscode.Range(x.line, span[0], x.line, span[1]),
        renderOptions: rep === undefined ? undefined : {
          after: {
            contentText: rep.replace(/\n/g, '⏎').replace(/\t/g, '→'),
            backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
          },
        },
      };
    })) : []);
    editor.setDecorations(this.line, [new vscode.Range(m.line, 0, m.line, 0)]);
  }

  /** Close a tab we opened for previewing (only if it wasn't open before and is still untouched). */
  private async closeIfTransient(uri: vscode.Uri): Promise<void> {
    if (this.openBefore.has(uri.toString())) return;
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => tabUri(t)?.toString() === uri.toString() && !t.isDirty);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  clear(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.current, []);
      ed.setDecorations(this.others, []);
      ed.setDecorations(this.line, []);
      ed.setDecorations(this.removed, []);
    }
  }

  private disposeDecorations(): void {
    this.clear();
    this.current.dispose();
    this.others.dispose();
    this.line.dispose();
    this.removed.dispose();
  }

  /** Popup cancelled: undo the preview. */
  restore(): Promise<void> {
    this.closed = true;
    return this.enqueue(() => this.doRestore());
  }

  private async doRestore(): Promise<void> {
    this.disposeDecorations();
    if (!this.shown) return;
    if (!this.origin || this.shown.toString() !== this.origin.uri.toString()) await this.closeIfTransient(this.shown);
    if (this.origin) {
      try {
        const ed = await vscode.window.showTextDocument(this.origin.uri, { viewColumn: this.column, preserveFocus: false });
        ed.selections = [...this.origin.selections];
        if (this.origin.top) ed.revealRange(this.origin.top, vscode.TextEditorRevealType.AtTop);
      } catch { /* origin gone */ }
    }
  }

  /** Popup accepted: open the match for real. */
  commit(m: LineMatch, toSide: boolean): Promise<void> {
    this.closed = true;
    return this.enqueue(() => this.doCommit(m, toSide));
  }

  private async doCommit(m: LineMatch, toSide: boolean): Promise<void> {
    this.disposeDecorations();
    if (toSide && this.shown) await this.closeIfTransient(this.shown);
    const range = matchRange(m);
    const ed = await vscode.window.showTextDocument(m.uri, {
      preview: false,
      preserveFocus: false,
      viewColumn: toSide ? vscode.ViewColumn.Beside : this.column,
      selection: range,
    });
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}
