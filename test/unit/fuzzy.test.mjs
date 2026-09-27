import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchName, matchPath, parseQuery, wordStarts } from '../../src/fuzzy.ts';

const rank = (query, paths) => {
  const q = parseQuery(query);
  return paths
    .map((p) => ({ p, m: matchPath(q, p) }))
    .filter((x) => x.m)
    .sort((a, b) => b.m.score - a.m.score)
    .map((x) => x.p);
};

test('word starts: camel humps, separators, digits, acronyms', () => {
  const ws = (s) => [...s].filter((_, i) => wordStarts(s)[i]).join('');
  assert.equal(ws('findInFiles.ts'), 'fIFt');
  assert.equal(ws('XMLHttpRequest'), 'XHR');
  assert.equal(ws('my-file_name2'), 'mfn2');
});

test('matchName: substring anywhere, then fragments at word starts', () => {
  assert.ok(matchName('ension', 'extension.ts'));
  assert.ok(matchName('fif', 'findInFiles.ts'));
  assert.ok(matchName('extts', 'extension.ts'));
  assert.ok(matchName('FIF', 'findInFiles.ts'));
  assert.equal(matchName('fxz', 'findInFiles.ts'), undefined);
  assert.equal(matchName('exnts', 'extension.ts'), undefined, 'n is not a word start');
  assert.ok(matchName('extension.ts', 'extensionHost.ts'), 'explicit separator matches anywhere');
  assert.ok(matchName('extension.ts', 'extension.ts').score > matchName('extension.ts', 'extensionHost.ts').score);
});

test('matchName: exact > prefix > humps', () => {
  const s = (p, n) => matchName(p, n).score;
  assert.ok(s('rg.ts', 'rg.ts') > s('rg.ts', 'rg.tsx'));
  assert.ok(s('scope', 'scope.ts') > s('scope', 'myScope.ts'));
  assert.ok(s('gfp', 'gotoFilePopup.ts') > 0);
  assert.equal(matchName('gfp', 'gfxplugin.ts'), undefined, 'p is mid-word');
});

test('ranges point at matched characters', () => {
  const m = matchName('fif', 'findInFiles.ts');
  const covered = m.ranges.map(([a, b]) => 'findInFiles.ts'.slice(a, b)).join('').toLowerCase();
  assert.equal(covered, 'fif');
});

test('parseQuery: :line[:col], (line), leading ./, backslashes, spaces', () => {
  assert.deepEqual(parseQuery('foo.ts:12'), { dirs: [], name: 'foo.ts', line: 12, column: undefined, raw: 'foo.ts' });
  assert.deepEqual(parseQuery('src\\a/foo.ts:12:3'), { dirs: ['src', 'a'], name: 'foo.ts', line: 12, column: 3, raw: 'src/a/foo.ts' });
  assert.equal(parseQuery('foo.ts(7)').line, 7);
  assert.equal(parseQuery('./src/').name, '');
  assert.deepEqual(parseQuery('./src/').dirs, ['src']);
  assert.equal(parseQuery('find in').name, 'findin');
});

test('matchPath: directory patterns must match in order', () => {
  const paths = ['src/host/extension.ts', 'test/extension.ts', 'src/webview/main.ts', 'node/src/ext.ts'];
  assert.deepEqual(rank('src/ext', paths).slice(0, 2).sort(), ['node/src/ext.ts', 'src/host/extension.ts']);
  assert.deepEqual(rank('test/ext', paths), ['test/extension.ts']);
  assert.deepEqual(rank('host/', paths), ['src/host/extension.ts']);
  assert.equal(rank('webview/ext', paths).length, 0);
});

test('ranking prefers exact names and shallow paths', () => {
  const paths = ['a/b/c/d/package.json', 'package.json', 'src/packager.json', 'node_modules/x/package.json'];
  assert.equal(rank('package.json', paths)[0], 'package.json');
  const r = rank('extension', ['src/extensionHost.ts', 'src/extension.ts', 'lib/myextension.ts']);
  assert.equal(r[0], 'src/extension.ts');
  assert.equal(r.at(-1), 'lib/myextension.ts');
});

test('full relative path wins', () => {
  const paths = ['git-charm/src/host/extension.ts', 'intellij-find/src/extension.ts'];
  assert.equal(rank('intellij-find/src/extension.ts', paths)[0], 'intellij-find/src/extension.ts');
});

test('performance: 100k paths under 400ms', () => {
  const paths = [];
  for (let i = 0; i < 100000; i++) paths.push(`pkg${i % 97}/src/module${i % 1013}/componentName${i}.tsx`);
  const q = parseQuery('src/cn123');
  const t = performance.now();
  let n = 0;
  for (const p of paths) if (matchPath(q, p)) n++;
  const ms = performance.now() - t;
  assert.ok(n > 0);
  assert.ok(ms < 400, `took ${ms.toFixed(0)}ms`);
});
