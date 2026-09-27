import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expand, makeReplacer, replaceInLine } from '../../src/replaceText.ts';

const re = (spec) => {
  const r = makeReplacer({ caseSensitive: false, wholeWord: false, regex: true, ...spec });
  assert.ok(!('error' in r), r.error);
  return r;
};

test('literal replacement is verbatim ($ and \\ are not special)', () => {
  const r = makeReplacer({ pattern: 'foo', replacement: '$1 \\n $&', regex: false, caseSensitive: false, wholeWord: false });
  assert.equal(r.replace('a foo b', 2, 5), '$1 \\n $&');
});

test('expand: groups, named groups, $&, $$, escapes', () => {
  const m = /(?<a>x)(y)/.exec('xy');
  assert.equal(expand('[$1|$2|$0|$&|$<a>|$$|$9]', m), '[x|y|xy|xy|x|$|$9]');
  assert.equal(expand('a\\nb\\tc\\\\d\\q', m), 'a\nb\tc\\d\\q');
});

test('regex replace uses the match at the rg-reported position', () => {
  const r = re({ pattern: '(\\w+)\\.show\\(', replacement: '$1.open(' });
  const line = 'find.show(a); goto.show(b);';
  assert.equal(r.replace(line, 0, 10), 'find.open(');
  assert.equal(r.replace(line, 14, 24), 'goto.open(');
  assert.equal(r.replace(line, 10, 13), undefined, 'no match at that position is skipped');
  assert.equal(r.replace(line, 0, 9), undefined, 'length mismatch is skipped');
});

test('case-insensitive and whole-word regexes', () => {
  assert.equal(re({ pattern: 'needle', replacement: 'pin' }).replace('NEEDLE', 0, 6), 'pin');
  assert.equal(re({ pattern: 'needle', replacement: 'pin', caseSensitive: true }).replace('NEEDLE', 0, 6), undefined);
  const w = re({ pattern: 'id', replacement: 'key', wholeWord: true });
  assert.equal(w.replace('id = uid', 0, 2), 'key');
  assert.equal(w.replace('id = uid', 6, 8), undefined);
});

test('invalid JS regex reports an error', () => {
  const r = makeReplacer({ pattern: '(?P<x>a)', replacement: '', regex: true, caseSensitive: false, wholeWord: false });
  assert.ok('error' in r);
});

test('replaceInLine applies right-to-left so earlier spans stay valid', () => {
  const r = re({ pattern: 'a(\\d)', replacement: 'bb$1' });
  assert.equal(replaceInLine('a1 a2 a3', [[0, 2], [3, 5], [6, 8]], r), 'bb1 bb2 bb3');
});
