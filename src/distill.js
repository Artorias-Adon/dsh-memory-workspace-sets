/**
 * 自动提炼：把一轮对话压成「候选记忆」。
 *
 * 两条纪律：
 *   1. 只产出草稿，绝不直接写进生效区（记忆会进系统提示，错一条的代价高于漏十条）；
 *   2. 解析要宽容：模型爱在 JSON 外面套代码块或加解释，先剥外壳再校验字段。
 */

const MAX_INPUT_BYTES = 24000;

function truncate(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let acc = '';
  for (const ch of text) {
    if (Buffer.byteLength(acc + ch, 'utf8') > maxBytes - 3) break;
    acc += ch;
  }
  return `${acc}...`;
}

/**
 * @param {object} input
 * @param {string} input.cwd
 * @param {Array<{ role: string, text: string }>} input.messages 本轮消息（已按时间序）
 * @param {number} [input.maxCandidates]
 * @param {string[]} [input.existingTitles] 已有记忆标题，避免重复
 * @returns {string} 送给模型的完整提示
 */
export function buildDistillPrompt({ cwd, messages = [], maxCandidates = 3, existingTitles = [] }) {
  const transcript = messages
    .filter((m) => String(m.text ?? '').trim().length > 3)
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${String(m.text ?? '').trim()}`)
    .join('\n\n');

  const known = existingTitles.length ? `\n已有记忆（不要重复产出同义条目）：${existingTitles.slice(0, 60).join('；')}\n` : '';

  return [
    '你是记忆整理器。阅读下面这一轮开发对话，提炼出「以后在这个工作区能复用的上下文」。',
    '',
    '判定标准（宁缺毋滥）：',
    '1. 只保留稳定的约定、偏好、环境事实、踩过的坑；一次性的任务细节全部丢弃。',
    '2. 每条必须能独立读懂，不依赖对话上下文；单条 1-3 句，不写代码块。',
    '3. 与已有记忆同义的不要重复；拿不准就不要产出。',
    '4. 最多产出 ' + maxCandidates + ' 条；没有值得记的就返回空数组。',
    '',
    '输出格式：只输出 JSON 数组，不要解释、不要代码块。字段：',
    '{"title": "不超过 20 字的短标题", "body": "正文", "tags": ["标签"], "scope": "global 或 workspace"}',
    known,
    `当前工作区：${cwd}`,
    '',
    '--- 对话开始 ---',
    truncate(transcript, MAX_INPUT_BYTES),
    '--- 对话结束 ---',
    '',
    'JSON：',
  ].join('\n');
}

/** 从模型输出里抽出 JSON 数组，允许 ```json 包裹或前后有废话。 */
export function parseCandidates(text) {
  const raw = String(text ?? '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [fenced ? fenced[1] : raw, raw];
  for (const source of candidates) {
    const start = source.indexOf('[');
    const end = source.lastIndexOf(']');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      if (!Array.isArray(parsed)) continue;
      return parsed.map(normalizeCandidate).filter((c) => c !== null);
    } catch {
      // 试下一个候选文本
    }
  }
  return [];
}

function normalizeCandidate(item) {
  if (!item || typeof item !== 'object') return null;
  const title = String(item.title ?? '').trim();
  const body = String(item.body ?? '').replace(/\s*\n\s*/g, ' ').trim();
  if (title === '' || body === '') return null;
  const tags = Array.isArray(item.tags) ? item.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  const scope = item.scope === 'global' ? 'global' : 'workspace';
  return { title: title.slice(0, 40), body: body.slice(0, 600), tags: tags.slice(0, 6), scope };
}
