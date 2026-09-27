import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Stages each README screenshot in a clean, maximized VS Code window. The scenes script
// writes `<signal>/ready-<name>` and waits for `<signal>/next-<name>` before moving on.
const root = path.resolve(__dirname, '../..');
const theme = process.env.SHOTS_THEME === 'light' ? 'light' : 'dark';
const base = path.join(root, '.vscode-test', 'shots');
const demo = path.join(base, 'intellij-find');
const signal = path.join(base, 'signal');
const userData = path.join(base, 'user-data');

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(signal, { recursive: true });
execSync(`git clone -q "${root}" "${demo}"`);
// Keep the demo workspace to the code itself (no screenshots/tooling in the results).
for (const p of ['media/screenshots', 'test/screenshots']) fs.rmSync(path.join(demo, p), { recursive: true, force: true });
execSync('git -c user.name=demo -c user.email=demo@example.com commit -qam "demo"', { cwd: demo });
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'workbench.colorTheme': theme === 'light' ? 'Default Light Modern' : 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.disableAIFeatures': true,
  'window.newWindowDimensions': 'maximized',
  'window.restoreWindows': 'none',
  'window.zoomLevel': 0.5,
  'security.workspace.trust.enabled': false,
  'git.openRepositoryInParentFolders': 'never',
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  // Native title bar lives outside the page, so captures skip the "[Extension Development Host]" title.
  'window.titleBarStyle': 'native',
  'window.commandCenter': false,
  'workbench.layoutControl.enabled': false,
  'workbench.navigationControl.enabled': false,
  'scm.countBadge': 'off',
  'git.enableStatusBarSync': false,
}, null, 2));

const PORT = 9339;
const outDir = process.env.SHOTS_OUT ?? path.join(root, 'media', 'screenshots');
fs.mkdirSync(outDir, { recursive: true });

/** Capture the workbench page via the Chrome DevTools Protocol (read-only; no input is sent). */
async function capture(name: string): Promise<void> {
  const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === 'page' && t.url.includes('workbench'));
  if (!page) throw new Error('workbench page not found');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const data = await new Promise<string>((resolve, reject) => {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === 1) (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result.data));
    });
    ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
  });
  ws.close();
  fs.writeFileSync(path.join(outDir, `${name}-${theme}.png`), Buffer.from(data, 'base64'));
  console.log(`captured ${name}`);
}

/** Answer each `ready-<name>` from the scenes script with a capture and `next-<name>`. */
async function pump(): Promise<void> {
  const done = new Set<string>();
  for (;;) {
    for (const f of fs.readdirSync(signal)) {
      if (!f.startsWith('ready-') || done.has(f)) continue;
      done.add(f);
      const name = f.slice('ready-'.length);
      await capture(name).catch((e) => console.error(`capture ${name} failed:`, e));
      fs.writeFileSync(path.join(signal, `next-${name}`), '');
      if (name === 'last') return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

const app = process.env.VSCODE_EXEC ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
void pump();
runTests({
  vscodeExecutablePath: fs.existsSync(app) ? app : undefined,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'out', 'test', 'shots.js'),
  launchArgs: [demo, `--remote-debugging-port=${PORT}`, '--extensions-dir', path.join(base, 'extensions'), '--user-data-dir', userData, '--skip-welcome', '--skip-release-notes'],
  extensionTestsEnv: { SHOTS_SIGNAL: signal, SHOTS_SCENES: process.env.SHOTS_SCENES ?? '', SHOTS_ALIGN: process.env.SHOTS_ALIGN ?? '' },
}).catch((e) => { console.error(e); process.exit(1); });
