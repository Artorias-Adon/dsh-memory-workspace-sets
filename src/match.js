/**
 * 路径匹配：把「工作区 cwd」和配置里的 match 模式对上。
 *
 * 支持的写法：
 *   D:\work\proj              精确匹配该目录及其子目录
 *   ~/projects/foo            波浪号展开
 *   D:/work/*                 单层通配
 *   D:/work/**                任意层级
 *
 * 语义：Windows 下大小写不敏感；分隔符统一成 `/`；结尾斜杠可省略。
 */

import { homedir } from 'node:os';

/** 归一化路径：展开 ~、统一分隔符、去掉尾部分隔符、Windows 下转小写。 */
export function normalizePath(input, { platform = process.platform } = {}) {
  if (typeof input !== 'string' || input === '') return '';
  let p = input.trim();
  if (p === '~') p = homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = homedir() + p.slice(1);
  p = p.replace(/\\/g, '/');
  p = p.replace(/\/+$/, '');
  // Windows 的盘符与路径都不区分大小写
  if (platform === 'win32') p = p.toLowerCase();
  return p;
}

function hasWildcard(p) {
  return p.includes('*') || p.includes('?');
}

/** 把 glob 片段编译成正则（只支持 * 与 **）。 */
function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

/**
 * 判断 cwd 是否命中 match 模式。
 * 无通配符时视为「该目录或其后代」；有通配符时对整串匹配，并对 `*` 额外放宽一层，
 * 使 `D:/work/*` 也能覆盖其子目录里的更深路径。
 */
export function matchWorkspace(cwd, pattern, { platform = process.platform } = {}) {
  const target = normalizePath(cwd, { platform });
  const rule = normalizePath(pattern, { platform });
  if (target === '' || rule === '') return false;

  if (hasWildcard(rule)) {
    const re = globToRegExp(rule);
    if (re.test(target)) return true;
    // 用模式深度截断后再匹配一次，兼容 `D:/work/*` 命中 `D:/work/a/b`
    const depth = rule.split('/').length;
    return re.test(target.split('/').slice(0, depth).join('/'));
  }
  return target === rule || target.startsWith(`${rule}/`);
}

/** 在一组绑定里挑出匹配当前 cwd 的，按声明顺序返回。 */
export function matchBindings(cwd, bindings, options) {
  return (bindings ?? []).filter((b) => b && typeof b.match === 'string' && matchWorkspace(cwd, b.match, options));
}
