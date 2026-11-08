/**
 * 记忆库持久化：一个条目一个 Markdown 文件，人可读、可 git 版本化。
 *
 * 目录结构（默认 $DSH_HOME/workspace-memory）：
 *   memories/<id>.md      正式记忆
 *   candidates/<id>.md    自动提炼的候选，待人工确认
 *
 * 文件格式：
 *   ---
 *   title: 提交信息用中文
 *   tags: [git, 约定]
 *   order: 10
 *   ---
 *   正文……
 */

import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** 解析极简 frontmatter：只支持 `key: value`、行内数组 `[a, b]` 与 `- item` 列表。 */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  const m = FRONTMATTER.exec(src);
  if (!m) return { data: {}, body: src.trim() };

  const data = {};
  let currentKey = null;
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentKey) {
      const prev = data[currentKey];
      data[currentKey] = Array.isArray(prev) ? [...prev, unquote(item[1])] : [prev, unquote(item[1])].filter((v) => v !== undefined);
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    currentKey = kv[1];
    const raw = kv[2].trim();
    if (raw === '') {
      data[currentKey] = [];
      continue;
    }
    const inline = /^\[(.*)\]$/.exec(raw);
    if (inline) {
      data[currentKey] = inline[1]
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter((s) => s !== '');
    } else {
      data[currentKey] = unquote(raw);
    }
  }
  return { data, body: (m[2] ?? '').trim() };
}

function unquote(v) {
  const s = String(v ?? '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

/** 把 id 规范成文件名安全的形式（保留中文，去掉路径与空白风险）。 */
export function slugify(input, fallback = 'memory') {
  const s = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s === '' ? fallback : s;
}

export function memoryFile(dir, id) {
  return join(dir, 'memories', `${id}.md`);
}

export function candidateFile(dir, id) {
  return join(dir, 'candidates', `${id}.md`);
}

async function ensureDirs(dir) {
  await mkdir(join(dir, 'memories'), { recursive: true });
  await mkdir(join(dir, 'candidates'), { recursive: true });
}

async function loadDir(dir, sub) {
  const base = join(dir, sub);
  let names = [];
  try {
    names = (await readdir(base)).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    const id = name.slice(0, -3);
    try {
      const text = await readFile(join(base, name), 'utf8');
      const { data, body } = parseFrontmatter(text);
      const info = await stat(join(base, name));
      out.push({
        id,
        title: String(data.title ?? id),
        tags: Array.isArray(data.tags) ? data.tags : data.tags ? [String(data.tags)] : [],
        order: Number.isFinite(Number(data.order)) ? Number(data.order) : 0,
        body,
        updatedAt: info.mtime.toISOString(),
      });
    } catch {
      // 单个文件读失败不应拖垮整个记忆库
    }
  }
  return out;
}

/** 读取全部正式记忆，返回 { id: entry }。 */
export async function loadEntries(dir) {
  const list = await loadDir(dir, 'memories');
  return Object.fromEntries(list.map((e) => [e.id, e]));
}

export async function loadCandidates(dir) {
  return loadDir(dir, 'candidates');
}

export function formatEntry({ title, body, tags = [], order = 0 }) {
  const lines = ['---', `title: ${title ?? ''}`];
  if (tags.length) lines.push(`tags: [${tags.join(', ')}]`);
  if (order) lines.push(`order: ${order}`);
  lines.push('---', '', String(body ?? '').trim(), '');
  return lines.join('\n');
}

/** 写入或覆盖一个正式记忆。 */
export async function saveEntry(dir, { id, title, body, tags, order }) {
  await ensureDirs(dir);
  const finalId = slugify(id || title);
  await writeFile(memoryFile(dir, finalId), formatEntry({ title: title ?? finalId, body, tags, order }), 'utf8');
  return finalId;
}

export async function deleteEntry(dir, id) {
  await rm(memoryFile(dir, id), { force: true });
}

export async function saveCandidate(dir, { id, title, body, tags, order }) {
  await ensureDirs(dir);
  const finalId = slugify(id || title);
  await writeFile(candidateFile(dir, finalId), formatEntry({ title: title ?? finalId, body, tags, order }), 'utf8');
  return finalId;
}

export async function deleteCandidate(dir, id) {
  await rm(candidateFile(dir, id), { force: true });
}

/** 候选晋升为正式记忆，返回新 id。 */
export async function promoteCandidate(dir, id) {
  const candidates = await loadCandidates(dir);
  const found = candidates.find((c) => c.id === id);
  if (!found) return null;
  await ensureDirs(dir);
  const finalId = await saveEntry(dir, { id: found.id, title: found.title, body: found.body, tags: found.tags, order: found.order });
  await deleteCandidate(dir, id);
  return finalId;
}
