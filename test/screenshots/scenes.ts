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

/** SHOTS_SCENES=a,b limits which scenes run (default: the README ones). */
const only = (process.env.SHOTS_SCENES || 'find-in-files,go-to-file').split(',');

async function scene(name: string, stage: () => Promise<void>): Promise<void> {
  if (!only.includes(name)) return;
  await stage();
  // Center the popup in the window (VS Code's "Align Quick Input Center"), IntelliJ-style.
  await cmd(process.env.SHOTS_ALIGN === 'top' ? 'workbench.action.alignQuickInputTop' : 'workbench.action.alignQuickInputCenter');
  await sleep(700);
  fs.writeFileSync(path.join(signal, `ready-${name}`), '');
  await waitFor(() => fs.existsSync(path.join(signal, `next-${name}`)), 600000);
  // Nested pickers (scope) re-open their parent popup when closed, so close until nothing is left.
  for (let i = 0; i < 3; i++) {
    await cmd('workbench.action.closeQuickOpen');
    await sleep(300);
    api.find.close();
    api.goto.close();
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
    await findQuery('vscode.window');
    await down(5);
  });

  await scene('go-to-file', async () => {
    await gotoQuery('fi');
  });

  await scene('replace-in-files', async () => {
    await cmd('intellijFind.replaceInFiles');
    const qp = await waitFor(() => api.find.quickPick);
    api.find.setReplacement('win');
    qp.value = 'vscode.window';
    api.find.lastSummary = '';
    api.find.requery();
    await waitFor(() => api.find.lastSummary);
    await down(5);
  });

  fs.writeFileSync(path.join(signal, 'ready-last'), '');
}
