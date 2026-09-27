import * as assert from 'assert';
import Mocha from 'mocha';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension';
import type { MatchItem } from '../../src/findInFiles';
import { rgPath } from '../../src/rg';

const fixture = vscode.Uri.file(process.env.INTELLIJ_FIND_FIXTURE!);
const f = (rel: string) => vscode.Uri.joinPath(fixture, rel);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeout = 8000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

let api: Api;

/** Optional pause so the popup can be screenshotted during a run (INTELLIJ_FIND_PAUSE=ms). */
async function pause(): Promise<void> {
  const ms = Number(process.env.INTELLIJ_FIND_PAUSE || 0);
  if (ms) await sleep(ms);
}

async function find(query: string, arg?: unknown, multi?: unknown): Promise<MatchItem[]> {
  await vscode.commands.executeCommand('intellijFind.findInFiles', arg, multi);
  const qp = await waitFor(() => api.find.quickPick, 'find popup');
  return search(qp, query);
}

async function search(qp: vscode.QuickPick<MatchItem>, query: string): Promise<MatchItem[]> {
  qp.value = query;
  api.find.lastSummary = '';
  api.find.requery();
  await waitFor(() => api.find.lastSummary, 'search to finish');
  return [...qp.items];
}

async function closePopups(): Promise<void> {
  api.find.quickPick?.hide();
  api.goto.quickPick?.hide();
  await sleep(50);
}

const rels = (items: readonly MatchItem[]) => items.map((i) => `${vscode.workspace.asRelativePath(i.match.uri)}:${i.match.line + 1}`);

function tests(): void {
  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'intellij-find')!;
    api = (await ext.activate()) as Api;
  });
  teardown(closePopups);

  suite('ripgrep', () => {
    test('uses the rg bundled with VS Code', () => {
      assert.ok(rgPath().startsWith(vscode.env.appRoot), rgPath());
      assert.ok(fs.existsSync(rgPath()));
    });
  });

  suite('Find in Files', () => {
    test('whole workspace, case-insensitive, respects .gitignore + search.exclude, stable file order', async () => {
      const items = await find('needle');
      await pause();
      const r = rels(items);
      assert.deepStrictEqual(r, [
        'README.md:2', 'README.md:3',
        'src/app.ts:1', 'src/app.ts:2', 'src/app.ts:3',
        'src/big.min.js:1',
        'src/deep/inner.ts:1', 'src/deep/ünï.ts:1',
      ]);
      assert.match(api.find.quickPick!.title!, /8 matches in 5 files/);
      assert.strictEqual(api.find.quickPick!.prompt, 'In fixture');
    });

    test('labels: trimmed, windowed around far matches, $( escaped, UTF-16 ranges', async () => {
      const items = await find('needle');
      const big = items.find((i) => i.match.relPath === 'src/big.min.js')!;
      assert.ok(big.label.startsWith('…'), big.label.slice(0, 20));
      assert.ok(big.label.includes('needle'));
      assert.ok(big.label.length < 120);
      const icon = items.find((i) => i.match.line === 2 && i.match.relPath === 'src/app.ts')!;
      assert.strictEqual(icon.label, '// \\$(icon) needle');
      const uni = items.find((i) => i.match.relPath.endsWith('ünï.ts'))!;
      const [s, e] = uni.match.ranges[0];
      assert.strictEqual(uni.match.text.slice(s, e), 'needle');
      assert.strictEqual(items[0].description, 'README.md 2');
    });

    test('toggles: match case, words, regex (commands bound to ⌥C ⌥W ⌥X)', async () => {
      const qp = (await find('Needle'), api.find.quickPick!);
      await vscode.commands.executeCommand('intellijFind.toggleMatchCase');
      assert.deepStrictEqual(rels(await search(qp, 'Needle')), ['README.md:3']);
      await vscode.commands.executeCommand('intellijFind.toggleMatchCase');
      await vscode.commands.executeCommand('intellijFind.toggleWords');
      const words = rels(await search(qp, 'needle'));
      assert.ok(!words.includes('src/app.ts:2'), 'needles excluded with whole word');
      assert.ok(words.includes('src/app.ts:1'));
      await vscode.commands.executeCommand('intellijFind.toggleWords');
      await vscode.commands.executeCommand('intellijFind.toggleRegex');
      assert.deepStrictEqual(rels(await search(qp, 'needle(s|Deep)')), ['src/app.ts:2', 'src/deep/inner.ts:1']);
      await vscode.commands.executeCommand('intellijFind.toggleRegex');
      const checked = qp.buttons.filter((b) => b.toggle?.checked).map((b) => b.tooltip);
      assert.deepStrictEqual(checked, ['Use Exclude Settings and Ignore Files']);
    });

    test('scope from explorer right-click (uri, uris): directory and file → parent dir', async () => {
      assert.deepStrictEqual(rels(await find('needle', f('src/deep'), [f('src/deep')])), ['src/deep/inner.ts:1', 'src/deep/ünï.ts:1']);
      assert.strictEqual(api.find.quickPick!.prompt, 'Directory: src/deep');
      await closePopups();
      assert.deepStrictEqual(rels(await find('needle', f('src/deep/inner.ts'))), ['src/deep/inner.ts:1', 'src/deep/ünï.ts:1']);
      await closePopups();
      const multi = rels(await find('needle', f('README.md'), [f('README.md'), f('src/deep')]));
      assert.strictEqual(multi.length, 8, 'README parent is root, which swallows src/deep');
      assert.strictEqual(api.find.quickPick!.prompt, 'Directory: fixture', 'workspace root shows as its name, not an absolute path');
    });

    test('scope from keybinding while explorer focused (explorer selection) and clipboard restored', async function () {
      // The explorer selection only resolves when the explorer has real DOM focus, which needs an OS-focused window.
      this.timeout(Number(process.env.INTELLIJ_FIND_PAUSE || 0) + 20000);
      if (!vscode.window.state.focused) {
        if (process.env.INTELLIJ_FIND_DEBUG) console.log('WAITING_FOR_FOCUS');
        await waitFor(() => vscode.window.state.focused, 'window focus', Number(process.env.INTELLIJ_FIND_PAUSE || 0) + 1).catch(() => undefined);
      }
      if (!vscode.window.state.focused) this.skip();
      await vscode.env.clipboard.writeText('keep me');
      // Wait until the explorer really has inner.ts selected and focused.
      const end = Date.now() + 5000;
      for (;;) {
        await vscode.commands.executeCommand('revealInExplorer', f('src/deep/inner.ts'));
        await vscode.commands.executeCommand('workbench.files.action.focusFilesExplorer');
        await sleep(150);
        await vscode.commands.executeCommand('copyFilePath');
        const clip = await vscode.env.clipboard.readText();
        if (process.env.INTELLIJ_FIND_DEBUG) console.log('CLIP', JSON.stringify(clip));
        if (clip.endsWith('inner.ts') || Date.now() > end) break;
      }
      await vscode.env.clipboard.writeText('keep me');
      assert.deepStrictEqual(rels(await find('needle', { fromExplorer: true })), ['src/deep/inner.ts:1', 'src/deep/ünï.ts:1']);
      assert.strictEqual(await vscode.env.clipboard.readText(), 'keep me');
    });

    test('excludes toggle includes gitignored and search.exclude folders', async () => {
      const qp = (await find('needle'), api.find.quickPick!);
      const btn = qp.buttons.find((b) => b.tooltip === 'Use Exclude Settings and Ignore Files')!;
      (api.find as any).onButton(btn);
      const r = rels(await search(qp, 'needle'));
      assert.ok(r.includes('ignored/secret.txt:1') && r.includes('node_modules/pkg/index.js:1'), r.join());
      assert.match(qp.prompt!, /including ignored files/);
      (api.find as any).onButton(qp.buttons.find((b) => b.tooltip === 'Use Exclude Settings and Ignore Files')!);
    });

    test('file mask', async () => {
      const qp = (await find('needle'), api.find.quickPick!);
      const st = (api.find as any).state;
      st.maskEnabled = true;
      st.fileMask = '*.ts, !inner.ts';
      assert.deepStrictEqual(rels(await search(qp, 'needle')), ['src/app.ts:1', 'src/app.ts:2', 'src/app.ts:3', 'src/deep/ünï.ts:1']);
      st.maskEnabled = false;
    });

    test('navigating previews in the editor; Esc restores the original editor and closes the preview tab', async () => {
      const origin = await vscode.window.showTextDocument(f('lib/extension.ts'), { preview: false });
      const items = await find('needle');
      const qp = api.find.quickPick!;
      const target = items.find((i) => i.match.relPath === 'src/deep/inner.ts')!;
      // Drive the real list navigation (what ↓ does) rather than setting activeItems.
      const idx = items.indexOf(target);
      await waitFor(() => qp.activeItems[0] === items[0], 'initial focus');
      for (let i = 0; i < idx; i++) await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
      await waitFor(() => qp.activeItems[0] === target, 'target active');
      await waitFor(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('inner.ts'), 'preview editor');
      const ed = vscode.window.activeTextEditor!;
      await waitFor(() => ed.selection.active.character === target.match.ranges[0][0] && ed.selection.active.line === 0, 'caret at match', 2000);
      await pause();
      qp.hide();
      await waitFor(() => vscode.window.activeTextEditor?.document.uri.toString() === origin.document.uri.toString(), 'origin restored');
      const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((t) => (t.input as any)?.uri?.path ?? '');
      assert.ok(!open.some((p: string) => p.endsWith('inner.ts')), open.join());
    });

    test('Enter opens the match (pinned tab, match selected)', async () => {
      const items = await find('needleDeep');
      assert.strictEqual(items.length, 1);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      const ed = await waitFor(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('inner.ts') && vscode.window.activeTextEditor, 'opened');
      await waitFor(() => ed.document.getText(ed.selection) === 'needleDeep', 'match selected', 2000);
      await sleep(100);
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab!;
      assert.strictEqual(tab.isPreview, false);
      assert.strictEqual(api.find.quickPick, undefined);
    });

    test('selected editor text pre-fills the query; last query remembered otherwise', async () => {
      const ed = await vscode.window.showTextDocument(f('src/app.ts'));
      ed.selection = new vscode.Selection(1, 6, 1, 13); // "needles"
      await vscode.commands.executeCommand('intellijFind.findInFiles');
      const qp = await waitFor(() => api.find.quickPick, 'popup');
      assert.strictEqual(qp.value, 'needles');
      await closePopups();
      ed.selection = new vscode.Selection(0, 0, 0, 0);
      await vscode.commands.executeCommand('intellijFind.findInFiles');
      assert.strictEqual((await waitFor(() => api.find.quickPick, 'popup')).value, 'needles');
    });

    test('Open in Search View hands the query over', async () => {
      await find('needleDeep', f('src/deep'));
      await vscode.commands.executeCommand('intellijFind.openInSearchView');
      await sleep(500);
      assert.strictEqual(api.find.quickPick, undefined);
    });
  });

  suite('Go to File', () => {
    async function gotoItems(query: string, arg?: unknown) {
      await vscode.commands.executeCommand('intellijFind.gotoFile', arg);
      const qp = await waitFor(() => api.goto.quickPick, 'goto popup');
      await api.goto.lastUpdate;
      qp.value = query;
      api.goto.requery();
      return qp.items.map((i) => (i.entry ? i.entry.rel + (i.entry.isDir ? '/' : '') : `-- ${i.label}`));
    }

    test('fuzzy: substring, camel humps, dir/ prefixes, exact first', async () => {
      assert.deepStrictEqual(await gotoItems('extension.ts'), ['lib/extension.ts', 'lib/extensionHost.ts']);
      await pause();
      assert.deepStrictEqual(await gotoItems('extho'), ['lib/extensionHost.ts']);
      assert.deepStrictEqual((await gotoItems('src/in'))[0], 'src/deep/inner.ts');
      assert.ok((await gotoItems('deep/')).includes('src/deep/'));
      assert.ok(!(await gotoItems('index')).includes('node_modules/pkg/index.js'), 'search.exclude honoured');
    });

    test('empty query lists recent files', async () => {
      await vscode.window.showTextDocument(f('src/deep/inner.ts'));
      await vscode.window.showTextDocument(f('README.md'));
      const items = await gotoItems('');
      assert.deepStrictEqual(items.slice(0, 3), ['-- Recent Files', 'README.md', 'src/deep/inner.ts']);
    });

    test('scoped from explorer right-click', async () => {
      const items = await gotoItems('ts', f('src/deep'));
      assert.deepStrictEqual(items.sort(), ['src/deep/inner.ts', 'src/deep/ünï.ts']);
      assert.strictEqual(api.goto.quickPick!.title, 'Go to File in src/deep');
    });

    test(':line jumps to line', async () => {
      await gotoItems('extensionHost:12:3');
      await waitFor(() => api.goto.quickPick?.activeItems[0]?.entry?.rel === 'lib/extensionHost.ts', 'active item');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      const ed = await waitFor(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('extensionHost.ts') && vscode.window.activeTextEditor, 'opened');
      await waitFor(() => ed.selection.active.line === 11 && ed.selection.active.character === 2, 'caret at 12:3', 2000);
    });

    test('file index refreshes on create', async () => {
      await gotoItems('brandNew');
      await closePopups();
      await vscode.workspace.fs.writeFile(f('src/brandNewFile.ts'), new Uint8Array());
      await sleep(1500);
      assert.deepStrictEqual(await gotoItems('brandNew'), ['src/brandNewFile.ts']);
      await vscode.workspace.fs.delete(f('src/brandNewFile.ts'));
    });
  });
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 20000, grep: process.env.INTELLIJ_FIND_GREP || undefined });
  mocha.suite.emit('pre-require', globalThis, 'suite', mocha);
  tests();
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve()));
  });
}
