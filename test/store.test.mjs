import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseFrontmatter,
  slugify,
  loadEntries,
  loadCandidates,
  saveEntry,
  deleteEntry,
  saveCandidate,
  promoteCandidate,
  formatEntry,
} from '../src/store.js';

test('parseFrontmatter 解析标量、行内数组与列表', () => {
  const a = parseFrontmatter('---\ntitle: 提交信息\ntags: [git, 约定]\norder: 5\n---\n正文一\n正文二');
  assert.equal(a.data.title, '提交信息');
  assert.deepEqual(a.data.tags, ['git', '约定']);
  assert.equal(a.data.order, '5');
  assert.equal(a.body, '正文一\n正文二');

  const b = parseFrontmatter('---\ntitle: X\ntags:\n  - a\n  - b\n---\nbody');
  assert.deepEqual(b.data.tags, ['a', 'b']);
});

test('parseFrontmatter 无 frontmatter 时整体当正文', () => {
  const r = parseFrontmatter('就是一段话');
  assert.deepEqual(r.data, {});
  assert.equal(r.body, '就是一段话');
});

test('parseFrontmatter 去引号与 BOM', () => {
  const r = parseFrontmatter('\uFEFF---\ntitle: "带引号"\n---\nbody');
  assert.equal(r.data.title, '带引号');
});

test('slugify 处理空白、路径与中文', () => {
  assert.equal(slugify('提交信息 用中文'), '提交信息-用中文');
  assert.equal(slugify('a/b\\c:d'), 'a-b-c-d');
  assert.equal(slugify('  '), 'memory');
});

test('formatEntry 往返一致', () => {
  const text = formatEntry({ title: 'T', body: 'B', tags: ['x'], order: 2 });
  const parsed = parseFrontmatter(text);
  assert.equal(parsed.data.title, 'T');
  assert.deepEqual(parsed.data.tags, ['x']);
  assert.equal(parsed.body, 'B');
});

test('保存 / 读取 / 删除闭环', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wm-'));
  try {
    await saveEntry(dir, { id: 'git-commit', title: '提交信息', body: '用中文', tags: ['git'] });
    await saveEntry(dir, { id: 'no-curl', title: '工具', body: '别用 curl' });
    const all = await loadEntries(dir);
    assert.deepEqual(Object.keys(all).sort(), ['git-commit', 'no-curl']);
    assert.equal(all['git-commit'].body, '用中文');
    assert.deepEqual(all['git-commit'].tags, ['git']);

    await deleteEntry(dir, 'no-curl');
    assert.deepEqual(Object.keys(await loadEntries(dir)), ['git-commit']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('候选：写入、列出、晋升', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wm-'));
  try {
    await saveCandidate(dir, { id: 'cand-1', title: '新约定', body: '正文' });
    let cands = await loadCandidates(dir);
    assert.equal(cands.length, 1);
    assert.equal(cands[0].id, 'cand-1');

    const promoted = await promoteCandidate(dir, 'cand-1');
    assert.equal(promoted, 'cand-1');
    assert.equal((await loadCandidates(dir)).length, 0);
    const entries = await loadEntries(dir);
    assert.equal(entries['cand-1'].title, '新约定');

    assert.equal(await promoteCandidate(dir, 'nope'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('空目录返回空集合而非抛错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wm-'));
  try {
    assert.deepEqual(await loadEntries(dir), {});
    assert.deepEqual(await loadCandidates(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
