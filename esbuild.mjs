import * as esbuild from 'esbuild';
import { argv } from 'process';

const prod = argv.includes('--prod');
const common = { bundle: true, format: 'cjs', platform: 'node', target: 'node20', external: ['vscode'], logLevel: 'info' };

const builds = argv.includes('--tests')
  ? [
      { ...common, entryPoints: ['test/integration/run.ts'], outfile: 'out/test/run.js', external: ['vscode', '@vscode/test-electron'] },
      { ...common, entryPoints: ['test/integration/suite.ts'], outfile: 'out/test/suite.js', external: ['vscode', 'mocha'], sourcemap: true },
      { ...common, entryPoints: ['test/screenshots/run.ts'], outfile: 'out/test/shots-run.js', external: ['vscode', '@vscode/test-electron'] },
      { ...common, entryPoints: ['test/screenshots/scenes.ts'], outfile: 'out/test/shots.js' },
    ]
  : [{ ...common, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', sourcemap: !prod, minify: prod }];

if (argv.includes('--watch')) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
