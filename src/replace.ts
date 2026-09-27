import * as vscode from 'vscode';
import { LineMatch } from './rg';
import { Replacer } from './replaceText';

export interface ReplaceResult {
  replaced: number;
  files: number;
  /** Occurrences left alone because the text changed since the search (or the regex couldn't be reproduced). */
  skipped: number;
}

/**
 * Replace the given matches as a single workspace edit (one undo step across files).
 * Each occurrence is re-checked against the document's current text; stale ones are skipped.
 * Files that had no unsaved changes are saved afterwards, like IntelliJ; dirty ones are left dirty.
 */
export async function applyReplacements(matches: LineMatch[], replacer: Replacer): Promise<ReplaceResult> {
  const byUri = new Map<string, LineMatch[]>();
  for (const m of matches) {
    const k = m.uri.toString();
    byUri.set(k, [...(byUri.get(k) ?? []), m]);
  }

  const edit = new vscode.WorkspaceEdit();
  const toSave: vscode.TextDocument[] = [];
  let replaced = 0;
  let skipped = 0;
  let files = 0;

  for (const list of byUri.values()) {
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(list[0].uri);
    } catch {
      skipped += list.reduce((n, m) => n + m.ranges.length, 0);
      continue;
    }
    const wasDirty = doc.isDirty;
    let inFile = 0;
    for (const m of list) {
      if (m.line >= doc.lineCount) { skipped += m.ranges.length; continue; }
      const current = doc.lineAt(m.line).text;
      for (const [s, e] of m.ranges) {
        const rep = current.slice(s, e) === m.text.slice(s, e) ? replacer.replace(current, s, e) : undefined;
        if (rep === undefined) { skipped++; continue; }
        edit.replace(doc.uri, new vscode.Range(m.line, s, m.line, e), rep);
        inFile++;
      }
    }
    if (inFile) {
      replaced += inFile;
      files++;
      if (!wasDirty) toSave.push(doc);
    }
  }

  if (replaced && !(await vscode.workspace.applyEdit(edit))) return { replaced: 0, files: 0, skipped: replaced + skipped };
  await Promise.all(toSave.map((d) => d.save()));
  return { replaced, files, skipped };
}
