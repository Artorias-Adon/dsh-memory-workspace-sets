import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDistillPrompt, parseCandidates } from '../src/distill.js';

test('buildDistillPrompt 带工作区、条数上限与已有标题', () => {
  const p = buildDistillPrompt({
    cwd: 'D:\\w',
    messages: [
      { role: 'user', text: '以后提交信息都用中文' },
      { role: 'assistant', text: '好的，记住了' },
    ],
    maxCandidates: 2,
    existingTitles: ['提交信息用中文'],
  });
  assert.match(p, /当前工作区：D:\\w/);
  assert.match(p, /最多产出 2 条/);
  assert.match(p, /已有记忆/);
  assert.match(p, /用户：以后提交信息都用中文/);
});

test('buildDistillPrompt 过滤过短消息并截断超长输入', () => {
  const p = buildDistillPrompt({
    cwd: '/w',
    messages: [{ role: 'user', text: 'hi' }, { role: 'user', text: '长'.repeat(20000) }],
  });
  assert.ok(!p.includes('用户：hi'));
  assert.ok(Buffer.byteLength(p, 'utf8') < 30000);
});

test('parseCandidates 解析裸 JSON 数组', () => {
  const out = parseCandidates('[{"title":"T","body":"B","tags":["x"],"scope":"global"}]');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { title: 'T', body: 'B', tags: ['x'], scope: 'global' });
});

test('parseCandidates 容忍代码块与前后废话', () => {
  const text = '好的，结果如下：\n```json\n[{"title":"A","body":"a"}]\n```\n希望有用。';
  const out = parseCandidates(text);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, 'A');
  assert.equal(out[0].scope, 'workspace');
});

test('parseCandidates 丢弃缺字段项并规范化', () => {
  const out = parseCandidates(
    '[{"title":"","body":"x"},{"title":"ok","body":"b","tags":"nope"},{"body":"no title"}]',
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].tags, []);
});

test('parseCandidates 对垃圾输出返回空数组', () => {
  assert.deepEqual(parseCandidates('完全不是 JSON'), []);
  assert.deepEqual(parseCandidates(''), []);
  assert.deepEqual(parseCandidates('{"title":"对象不是数组"}'), []);
});

test('parseCandidates 限制条数与字段长度', () => {
  const long = 'b'.repeat(2000);
  const out = parseCandidates(`[{"title":"${'t'.repeat(80)}","body":"${long}","tags":["1","2","3","4","5","6","7","8"]}]`);
  assert.equal(out[0].title.length, 40);
  assert.equal(out[0].body.length, 600);
  assert.equal(out[0].tags.length, 6);
});
