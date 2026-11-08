/**
 * 运行时：把「记忆库 + 配置状态」加载进内存快照，供同步的提示词注入使用。
 *
 * 为什么要缓存：systemPrompt 的 context provider 是同步函数，不能 await 磁盘。
 * 所以磁盘读取全部走 refresh()，provider 只读快照；写操作完成后立刻再 refresh 一次。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { loadEntries, loadCandidates } from './store.js';
import { resolveMemoryPlan } from './resolve.js';
import { renderInjection } from './render.js';

/** 默认记忆库位置：$DSH_HOME/workspace-memory，回退到 ~/.dsh/workspace-memory。 */
export function defaultMemoryDir() {
  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  return join(home, 'workspace-memory');
}

export function stateFile(dir) {
  return join(dir, 'state.json');
}

/**
 * 读取状态文件（sets + bindings）。文件不存在时返回 null，由调用方决定用空状态还是种子。
 * 解析失败时抛错，由调用方降级为空状态并记录警告——坏掉的配置不应该让插件起不来。
 */
export function readState(dir) {
  const file = stateFile(dir);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    sets: parsed.sets && typeof parsed.sets === 'object' ? parsed.sets : {},
    bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
  };
}

export function writeState(dir, state) {
  mkdirSync(dir, { recursive: true });
  const payload = { version: 1, sets: state.sets ?? {}, bindings: state.bindings ?? [] };
  writeFileSync(stateFile(dir), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * 记忆库运行时。`refresh()` 是唯一的磁盘入口，`plan()` / `inject()` 只读快照。
 */
export class MemoryRuntime {
  constructor({ dir, maxInjectBytes = 8000, logger }) {
    this.dir = dir;
    this.maxInjectBytes = maxInjectBytes;
    this.logger = logger;
    this.entries = {};
    this.candidates = [];
    this.state = { sets: {}, bindings: [] };
    this.loadedAt = 0;
  }

  /** 重新读取磁盘状态。并发调用合并成一次。 */
  async refresh() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        this.entries = await loadEntries(this.dir);
        this.candidates = await loadCandidates(this.dir);
      } catch (error) {
        this.logger?.warn?.(`workspace-memory: 读取记忆库失败：${error?.message ?? error}`);
      }
      try {
        this.state = readState(this.dir) ?? { sets: {}, bindings: [] };
      } catch (error) {
        this.logger?.warn?.(`workspace-memory: state.json 解析失败，按空状态处理：${error?.message ?? error}`);
        this.state = { sets: {}, bindings: [] };
      }
      this.loadedAt = Date.now();
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** 当前 cwd 的记忆计划（同步，只读快照）。 */
  plan(cwd) {
    return resolveMemoryPlan({
      cwd,
      bindings: this.state.bindings,
      sets: this.state.sets,
      entries: this.entries,
    });
  }

  /** 渲染注入文本（同步）。 */
  inject(cwd) {
    return renderInjection({
      plan: this.plan(cwd),
      entries: this.entries,
      maxBytes: this.maxInjectBytes,
    });
  }

  /** 记忆库版本标记，用于状态展示。 */
  signature() {
    const newest = Object.values(this.entries)
      .map((e) => e.updatedAt)
      .sort()
      .at(-1);
    return { entries: Object.keys(this.entries).length, candidates: this.candidates.length, newest: newest ?? null };
  }
}

/** 便捷判断：记忆库目录是否已经存在。 */
export function memoryDirExists(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
