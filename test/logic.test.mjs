import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePath, matchWorkspace, matchBindings } from '../src/match.js';
import { resolveMemoryPlan, expandSet } from '../src/resolve.js';
import { renderInjection, condenseBody } from '../src/render.js';

test('normalizePath 统一分隔符、去尾斜杠、Windows 小写', () => {
  assert.equal(normalizePath('D:\\Work\\Foo\\', { platform: 'win32' }), 'd:/work/foo');
  assert.equal(normalizePath('/home/user/proj/', { platform: 'linux' }), '/home/user/proj');
  assert.equal(normalizePath('', { platform: 'win32' }), '');
});

test('matchWorkspace 前缀匹配（该目录及其子目录）', () => {
  const p = { platform: 'win32' };
  assert.equal(matchWorkspace('D:\\work\\proj', 'D:\\work\\proj', p), true);
  assert.equal(matchWorkspace('D:\\work\\proj\\sub', 'D:\\work\\proj', p), true);
  assert.equal(matchWorkspace('D:\\work\\proj2', 'D:\\work\\proj', p), false);
  assert.equal(matchWorkspace('D:\\work\\other', 'D:\\work\\proj', p), false);
});

test('matchWorkspace 通配与大小写', () => {
  const p = { platform: 'win32' };
  assert.equal(matchWorkspace('D:\\work\\foo', 'd:/work/*', p), true);
  assert.equal(matchWorkspace('D:\\work\\foo\\bar', 'd:/work/*', p), true);
  assert.equal(matchWorkspace('D:\\other\\foo', 'd:/work/*', p), false);
  assert.equal(matchWorkspace('D:\\work\\a\\b', 'd:/work/**', p), true);
});

test('expandSet 处理嵌套与循环引用', () => {
  const sets = {
    a: { entries: ['x', 'y'] },
    b: { entries: ['@a', 'z'] },
    loop1: { entries: ['@loop2'] },
    loop2: { entries: ['@loop1'] },
  };
  assert.deepEqual(expandSet('b', sets), ['x', 'y', 'z']);
  assert.deepEqual(expandSet('loop1', sets), []);
  assert.deepEqual(expandSet('nope', sets), []);
});

test('resolveMemoryPlan 合并多绑定、去重、扣除 exclude', () => {
  const sets = { abc: { entries: ['a', 'b', 'c'] }, bcd: { entries: ['b', 'c', 'd'] } };
  const entries = { a: {}, b: {}, c: {}, d: {}, e: {} };
  const plan = resolveMemoryPlan({
    cwd: 'D:\\w\\proj',
    bindings: [
      { match: 'D:\\w\\proj', sets: ['abc'] },
      { match: 'D:\\w\\proj', sets: ['bcd'], entries: ['e'], exclude: ['c'] },
    ],
    sets,
    entries,
    options: { platform: 'win32' },
  });
  assert.deepEqual(plan.entryIds, ['a', 'b', 'd', 'e']);
  assert.deepEqual(plan.excluded, ['c']);
  assert.deepEqual(plan.setIds, ['abc', 'bcd']);
  assert.deepEqual(plan.bindings.map((b) => b.match), ['D:\\w\\proj', 'D:\\w\\proj']);
});

test('resolveMemoryPlan 标记缺失条目', () => {
  const plan = resolveMemoryPlan({
    cwd: '/w',
    bindings: [{ match: '/w', entries: ['ghost'] }],
    sets: {},
    entries: {},
    options: { platform: 'linux' },
  });
  assert.deepEqual(plan.entryIds, ['ghost']);
  assert.deepEqual(plan.missing, ['ghost']);
});

test('matchBindings 忽略非法绑定', () => {
  const out = matchBindings('/w', [{ match: '/w' }, { note: 'no match' }, null], { platform: 'linux' });
  assert.equal(out.length, 1);
});

test('condenseBody 压平换行并按字节截断', () => {
  assert.equal(condenseBody('a\n\nb  \nc'), 'a b c');
  const long = '字'.repeat(1000);
  const out = condenseBody(long, 30);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 30);
  assert.ok(out.endsWith('…'));
});

test('renderInjection 渲染头尾、条目与来源信息', () => {
  const plan = { cwd: 'D:\\w', entryIds: ['a', 'b'], setIds: ['abc'], excluded: [], missing: [], bindings: [], sources: {} };
  const entries = { a: { title: '提交信息', body: '用中文写提交信息' }, b: { title: '工具', body: '别用 curl' } };
  const { text, included, omitted } = renderInjection({ plan, entries });
  assert.deepEqual(included, ['a', 'b']);
  assert.deepEqual(omitted, []);
  assert.match(text, /<workspace-memory workspace="D:\\w"/);
  assert.match(text, /- \[a\] 提交信息：用中文写提交信息/);
  assert.match(text, /<\/workspace-memory>$/);
});

test('renderInjection 预算不足时截断并声明', () => {
  const plan = { cwd: '/w', entryIds: ['a', 'b', 'c'], setIds: [], excluded: [], missing: [], bindings: [], sources: {} };
  const entries = {
    a: { title: 'A', body: 'x'.repeat(200) },
    b: { title: 'B', body: 'y'.repeat(200) },
    c: { title: 'C', body: 'z'.repeat(200) },
  };
  const { included, omitted, text } = renderInjection({ plan, entries, maxBytes: 400 });
  assert.ok(included.length >= 1);
  assert.ok(omitted.length >= 1);
  assert.ok(omitted.every((o) => o.reason === 'budget'));
  assert.match(text, /超出 maxInjectBytes 预算/);
});

test('renderInjection 无条目时不注入', () => {
  const out = renderInjection({ plan: { cwd: '/w', entryIds: [], setIds: [] }, entries: {} });
  assert.deepEqual(out, { text: '', included: [], omitted: [] });
});
