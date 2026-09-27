import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension';

const signal = process.env.SHOTS_SIGNAL!;
const root = vscode.workspace.workspaceFolders![0].uri;
const f = (rel: string) => vscode.Uri.joinPath(root, rel);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cmd = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(id, ...args);
let api: Api;

async function waitFor<T>(fn: () => T | undefined | false, timeout = 10000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timeout');
    await sleep(30);
  }
}

async function scene(name: string, stage: () => Promise<void>): Promise<void> {
  await stage();
  await sleep(700);
  fs.writeFileSync(path.join(signal, `ready-${name}`), '');
  await waitFor(() => fs.existsSync(path.join(signal, `next-${name}`)), 600000);
  // Nested pickers (scope) re-open their parent popup when closed, so close until nothing is left.
  for (let i = 0; i < 3; i++) {
    await cmd('workbench.action.closeQuickOpen');
    await sleep(300);
    api.find.quickPick?.hide();
    api.goto.quickPick?.hide();
    await sleep(300);
  }
}

async function findQuery(q: string, arg?: unknown): Promise<void> {
  await cmd('intellijFind.findInFiles', arg);
  const qp = await waitFor(() => api.find.quickPick);
  qp.value = q;
  api.find.lastSummary = '';
  api.find.requery();
  await waitFor(() => api.find.lastSummary);
}

async function down(n: number): Promise<void> {
  for (let i = 0; i < n; i++) { await cmd('workbench.action.quickOpenSelectNext'); await sleep(60); }
}

async function gotoQuery(q: string, arg?: unknown): Promise<void> {
  await cmd('intellijFind.gotoFile', arg);
  const qp = await waitFor(() => api.goto.quickPick);
  await api.goto.lastUpdate;
  qp.value = q;
  api.goto.requery();
}

export async function run(): Promise<void> {
  api = (await vscode.extensions.all.find((e) => e.packageJSON.name === 'intellij-find')!.activate()) as Api;
  await cmd('workbench.action.closeAuxiliaryBar');
  await cmd('workbench.action.closePanel');
  await cmd('workbench.view.explorer');
  await cmd('revealInExplorer', f('src/findInFiles.ts'));
  await vscode.window.showTextDocument(f('src/extension.ts'), { preview: false });
  await sleep(1500);

  await scene('find-in-files', async () => {
    await findQuery('scope');
    await down(4);
  });

  await scene('find-directory-regex', async () => {
    await cmd('revealInExplorer', f('src'));
    const st = (api.find as any).state;
    st.regex = true; st.caseSensitive = true;
    await findQuery('show\\w*\\(', f('src'));
    await down(2);
  });

  await scene('go-to-file', async () => {
    const st = (api.find as any).state;
    st.regex = false; st.caseSensitive = false;
    await gotoQuery('fi');
  });

  await scene('go-to-file-path', async () => {
    await gotoQuery('te/in/');
  });

  await scene('go-to-file-recent', async () => {
    for (const p of ['src/scope.ts', 'src/rg.ts', 'src/gotoFile.ts', 'README.md', 'src/findInFiles.ts']) {
      await vscode.window.showTextDocument(f(p), { preview: false });
      await sleep(150);
    }
    await gotoQuery('');
  });

  await scene('scope-picker', async () => {
    await findQuery('rememberDirs', f('src'));
    void (api.find as any).onButton((api.find.quickPick!.buttons as vscode.QuickInputButton[]).find((b) => b.tooltip?.startsWith('Scope')));
    await sleep(600);
  });

  await scene('editor-context-menu', async () => {
    await sleep(1200); // let the previous popup's editor restore settle
    const doc = await vscode.workspace.openTextDocument(f('src/scope.ts'));
    const i = doc.getText().indexOf('scopeFromInvocation');
    const sel = new vscode.Selection(doc.positionAt(i), doc.positionAt(i + 'scopeFromInvocation'.length));
    const ed = await vscode.window.showTextDocument(doc, { preview: false, selection: sel });
    ed.revealRange(sel, vscode.TextEditorRevealType.InCenter);
    await waitFor(() => !vscode.window.activeTextEditor?.selection.isEmpty);
    await sleep(400);
    await cmd('editor.action.showContextMenu');
  });

  fs.writeFileSync(path.join(signal, 'ready-last'), '');
}
