import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, '.vscode-test', 'fixture');

function write(rel: string, content: string): void {
  const p = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeFixture(): void {
  fs.rmSync(fixture, { recursive: true, force: true });
  write('README.md', '# Readme\nneedle in readme\nNeedle upper\n');
  write('src/app.ts', 'const needle = 1;\nconst needles = 2;\n// $(icon) needle\n');
  write('src/deep/inner.ts', "export const needleDeep = 'needle';\n");
  write('src/deep/ünï.ts', "const ü = 'needle';\n");
  write('src/big.min.js', 'x'.repeat(4000) + 'needle' + 'y'.repeat(1000) + '\n');
  write('lib/extension.ts', 'export {};\n');
  write('lib/extensionHost.ts', 'export {};\n'.repeat(30));
  write('node_modules/pkg/index.js', 'needle in node_modules\n');
  write('ignored/secret.txt', 'needle ignored\n');
  write('.gitignore', 'ignored/\n');
  write('replace/one.ts', 'const alpha = 1;\nalpha(alpha);\nlet alphabet = 2;\n');
  write('replace/two.ts', 'export function alphaFn(x) { return x; }\n');
  write('replace/three.ts', 'gamma gamma\n');
  write('replace/cancel.ts', 'keepme\n');
  execSync('git init -q', { cwd: fixture });
}

async function main(): Promise<void> {
  makeFixture();
  const app = process.env.VSCODE_EXEC ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  await runTests({
    vscodeExecutablePath: fs.existsSync(app) ? app : undefined,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'test', 'suite.js'),
    launchArgs: [
      fixture,
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir', path.join(root, '.vscode-test', 'user-data'),
    ],
    extensionTestsEnv: {
      INTELLIJ_FIND_FIXTURE: fixture,
      INTELLIJ_FIND_PAUSE: process.env.INTELLIJ_FIND_PAUSE ?? '',
      INTELLIJ_FIND_GREP: process.env.INTELLIJ_FIND_GREP ?? '',
      INTELLIJ_FIND_DEBUG: process.env.INTELLIJ_FIND_DEBUG ?? '',
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
