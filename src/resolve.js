/**
 * 解析「当前工作区最终该注入哪些记忆」。
 *
 * 规则：
 *   1. 收起所有匹配 cwd 的绑定，按声明顺序拼接；
 *   2. 绑定里的 `sets` 可引用记忆集，集可嵌套引用另一个集（写成 `@setId`）；
 *   3. 绑定里的 `entries` 直接引用条目；
 *   4. 全部并集去重，保持首次出现的顺序；
 *   5. `exclude` 里的条目最后扣除（无论来自集还是单条）。
 *
 * 返回结构同时用于注入渲染与 memory_status 审计。
 */

import { matchBindings } from './match.js';

const SET_REF = /^@(.+)$/;

/**
 * 展开一个记忆集的成员 id（递归处理 @set 引用）。
 * @param {string} setId
 * @param {Record<string, { entries?: string[] }>} sets
 * @param {{ visiting?: Set<string> }} [state]
 * @returns {string[]}
 */
export function expandSet(setId, sets, state = { visiting: new Set() }) {
  const visiting = state.visiting;
  const set = sets?.[setId];
  if (!set) return [];
  if (visiting.has(setId)) return []; // 循环引用直接断开，避免栈溢出
  visiting.add(setId);
  const out = [];
  for (const member of set.entries ?? []) {
    const ref = typeof member === 'string' ? SET_REF.exec(member.trim()) : null;
    if (ref) out.push(...expandSet(ref[1], sets, state));
    else if (typeof member === 'string' && member.trim() !== '') out.push(member.trim());
  }
  visiting.delete(setId);
  return out;
}

/**
 * @param {object} input
 * @param {string} input.cwd               当前会话工作目录
 * @param {Array<object>} input.bindings   绑定列表
 * @param {Record<string, { entries?: string[] }>} input.sets 记忆集表
 * @param {Record<string, object>} [input.entries] 已知条目表（用于标记缺失）
 * @param {object} [input.options]         传给 matchWorkspace 的平台选项
 */
export function resolveMemoryPlan({ cwd, bindings, sets, entries = {}, options }) {
  const matched = matchBindings(cwd, bindings, options);
  const order = [];
  const seen = new Set();
  const sources = new Map(); // entryId -> 来源标签数组
  const setsUsed = [];
  const missing = new Set();

  const push = (id, sourceLabel) => {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
      sources.set(id, []);
    }
    sources.get(id).push(sourceLabel);
  };

  for (const binding of matched) {
    const label = binding.note || binding.match;
    for (const raw of binding.sets ?? []) {
      const setId = String(raw);
      setsUsed.push(setId);
      for (const id of expandSet(setId, sets)) push(id, `set:${setId}`);
    }
    for (const raw of binding.entries ?? []) {
      if (typeof raw === 'string' && raw.trim() !== '') push(raw.trim(), `binding:${label}`);
    }
  }

  const excluded = new Set();
  for (const binding of matched) {
    for (const raw of binding.exclude ?? []) {
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      const id = raw.trim();
      const ref = SET_REF.exec(id);
      const ids = ref ? expandSet(ref[1], sets) : [id];
      for (const one of ids) {
        excluded.add(one);
        if (seen.has(one)) {
          seen.delete(one);
          const idx = order.indexOf(one);
          if (idx >= 0) order.splice(idx, 1);
        }
      }
    }
  }

  for (const id of order) if (!entries[id]) missing.add(id);

  return {
    cwd,
    entryIds: order,
    setIds: [...new Set(setsUsed)],
    excluded: [...excluded],
    missing: [...missing],
    bindings: matched.map((b) => ({ match: b.match, note: b.note ?? null, sets: b.sets ?? [], entries: b.entries ?? [], exclude: b.exclude ?? [] })),
    sources: Object.fromEntries(order.map((id) => [id, sources.get(id) ?? []])),
  };
}
