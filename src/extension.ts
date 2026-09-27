import * as vscode from 'vscode';
import { FileIndex } from './fileIndex';
import { FindInFilesPopup } from './findInFiles';
import { GotoFilePopup, RecentFiles } from './gotoFile';
import { scopeFromInvocation } from './scope';
import { rememberDirs } from './ui';

export interface Api {
  find: FindInFilesPopup;
  goto: GotoFilePopup;
}

export function activate(ctx: vscode.ExtensionContext): Api {
  const index = new FileIndex();
  const recent = new RecentFiles(ctx);
  const find = new FindInFilesPopup(ctx);
  const goto = new GotoFilePopup(ctx, index, recent);
  ctx.subscriptions.push(index, recent, find, goto);

  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // Explorer / tab context menus pass (uri, uris); the explorer keybinding passes { fromExplorer: true }.
  reg('intellijFind.findInFiles', async (arg?: unknown, multi?: unknown) => {
    const scope = await scopeFromInvocation(arg, multi);
    rememberDirs(scope);
    await find.show(scope);
  });
  reg('intellijFind.gotoFile', async (arg?: unknown, multi?: unknown) => {
    const scope = await scopeFromInvocation(arg, multi);
    rememberDirs(scope);
    await goto.show(scope);
  });
  reg('intellijFind.toggleMatchCase', () => find.toggle('case'));
  reg('intellijFind.toggleWords', () => find.toggle('word'));
  reg('intellijFind.toggleRegex', () => find.toggle('regex'));
  reg('intellijFind.openInSearchView', () => find.openInSearchView());

  return { find, goto };
}

export function deactivate(): void {}
