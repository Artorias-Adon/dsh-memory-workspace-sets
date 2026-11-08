/**
 * 自动提炼的 LLM 侧实现。
 *
 * 失败策略：提炼是「锦上添花」，任何失败都只记录警告，绝不打断对话或影响注入。
 */

import { buildDistillPrompt, parseCandidates } from './distill.js';
import { saveCandidate, slugify } from './store.js';

const FINISH_ERRORS = new Set(['error', 'aborted']);

function timestampId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * @param {object} deps
 * @param {object} deps.ctx       Cordis context（需要 llm 服务）
 * @param {import('./runtime.js').MemoryRuntime} deps.runtime
 * @param {object} deps.config
 */
export function createDistiller({ ctx, runtime, config }) {
  const settings = config.distill ?? {};
  const logger = config.__logger;
  const inFlight = new Set();
  const agents = new Map(); // sessionId -> agent

  const remember = (agent) => {
    if (agent?.session?.id) agents.set(agent.session.id, agent);
  };

  return {
    remember,
    forget(agent) {
      if (agent?.session?.id) agents.delete(agent.session.id);
    },

    /** 提炼一个会话最近若干条消息，写入 candidates/。 */
    async run(session, { focus } = {}) {
      if (session?.id === undefined) return { error: 'no session' };
      if (inFlight.has(session.id)) return { skipped: true, reason: 'already-running' };
      inFlight.add(session.id);

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), settings.timeoutMs ?? 30000);
      try {
        const agent = agents.get(session.id);
        const all = typeof session.deriveMessages === 'function' ? session.deriveMessages() : [];
        const limit = settings.maxInputMessages ?? 12;
        const messages = all
          .slice(-limit)
          .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: messageText(m) }))
          .filter((m) => m.text.trim() !== '');
        if (messages.length === 0) return { skipped: true, reason: 'empty-transcript' };

        const selection = agent?.model?.current?.() ?? {
          provider: settings.provider,
          model: settings.model,
        };
        if (!selection?.provider || !selection?.model) {
          return { skipped: true, reason: 'no-model' };
        }

        const cwd = (() => {
          try {
            return ctx.workingDirectory.get(session);
          } catch {
            return session.header?.cwd ?? '(unknown)';
          }
        })();

        const existingTitles = (await runtime.refresh(), Object.values(runtime.entries).map((e) => e.title));
        const prompt = buildDistillPrompt({
          cwd,
          messages: focus ? [...messages, { role: 'user', text: `重点：${focus}` }] : messages,
          maxCandidates: settings.maxCandidates ?? 3,
          existingTitles,
        });

        const prepared = await ctx.llm.prepareCall({
          provider: selection.provider,
          model: selection.model,
          maxTokens: settings.maxTokens ?? 700,
        });

        let text = '';
        let failure;
        for await (const chunk of prepared.stream({
          provider: selection.provider,
          model: selection.model,
          maxTokens: settings.maxTokens ?? 700,
          system: '你只输出 JSON 数组，不输出任何解释。',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal: ac.signal,
        })) {
          if (chunk.type === 'text-delta') text += chunk.text;
          else if (chunk.type === 'finish' && FINISH_ERRORS.has(chunk.reason?.kind)) failure = chunk.reason;
        }

        if (failure) return { error: `llm-${failure.kind}`, detail: failure };
        const parsed = parseCandidates(text);
        if (parsed.length === 0) return { written: [], parsed: 0 };

        const written = [];
        for (const candidate of parsed) {
          const id = await saveCandidate(runtime.dir, {
            id: `${timestampId()}-${slugify(candidate.title)}`,
            title: candidate.title,
            body: candidate.body,
            tags: candidate.tags,
          });
          written.push({ id, title: candidate.title, scope: candidate.scope });
        }
        await runtime.refresh();
        return { written, parsed: parsed.length };
      } catch (error) {
        logger?.warn?.(`workspace-memory: 提炼失败：${error?.message ?? error}`);
        return { error: String(error?.message ?? error) };
      } finally {
        clearTimeout(timer);
        inFlight.delete(session.id);
      }
    },
  };
}
