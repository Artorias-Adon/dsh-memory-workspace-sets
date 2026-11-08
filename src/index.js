/**
 * dsh-memory-workspace-sets — 按工作区投放可复用的上下文记忆。
 *
 * 插件形态：`apply(ctx, config)` + `inject` + `Config`。
 * 注入点：systemPrompt 的 dynamic context（每轮组装时重新求值）。
 */

import Schema from '@deepseek-ai/schemastery';

import { MemoryRuntime, defaultMemoryDir } from './runtime.js';
import { createTools } from './tools.js';
import { createDistiller } from './llm.js';

export const name = 'workspace-memory';

export const inject = ['systemPrompt', 'workingDirectory', 'tools', 'llm'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('关闭后不再注入记忆，但仍可用工具查询与修改。'),
  memoryDir: Schema.string().default('').description('记忆库目录，留空使用 $DSH_HOME/workspace-memory。'),
  maxInjectBytes: Schema.number()
    .description('单轮注入的字节预算；超出按顺序截断并显式声明。')
    .default(8000),
  order: Schema.number().description('在系统提示上下文中的排序位置，越小越靠前。').default(130),
  contextName: Schema.string().description('注册到 systemPrompt 的唯一名称。').default('workspace-memory'),
  distill: Schema.object({
    enabled: Schema.boolean().default(false).description('轮次结束后自动提炼候选记忆。'),
    maxCandidates: Schema.number().default(3).description('单轮最多产出几条候选。'),
    maxInputMessages: Schema.number().default(12).description('提炼时读取最近多少条消息。'),
    maxTokens: Schema.number().default(700).description('提炼调用的输出 token 上限。'),
    timeoutMs: Schema.number().default(30000).description('提炼超时（毫秒）。'),
    provider: Schema.string().default('').description('提炼用 provider；留空沿用当前会话模型。'),
    model: Schema.string().default('').description('提炼用模型；留空沿用当前会话模型。'),
  }),
});

export function apply(ctx, config) {
  const logger = ctx.logger?.('workspace-memory') ?? console;
  const dir = config.memoryDir && config.memoryDir.trim() !== '' ? config.memoryDir : defaultMemoryDir();

  const runtime = new MemoryRuntime({
    dir,
    maxInjectBytes: config.maxInjectBytes,
    logger,
  });

  // 首次加载（不阻塞激活：加载完成前 provider 返回空串，等于不注入）
  void runtime.refresh();

  // ---- 1) 动态上下文注入 ----
  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: config.contextName ?? 'workspace-memory',
      order: config.order ?? 130,
      required: true,
      // Windows 路径可能含 `{{`，关掉变量插值避免被当模板
      interpolate: false,
      text: (assembleContext) => {
        if (config.enabled === false) return '';
        const agent = assembleContext?.agent;
        if (!agent) return '';
        let cwd;
        try {
          cwd = ctx.workingDirectory.get(agent.session);
        } catch {
          return '';
        }
        try {
          const { text } = runtime.inject(cwd);
          return text;
        } catch (error) {
          logger.warn?.(`workspace-memory: 渲染注入文本失败：${error?.message ?? error}`);
          return '';
        }
      },
    }),
  );

  // ---- 2) 提炼器与 Agent 登记 ----
  const distiller = createDistiller({ ctx, runtime, config: { ...config, distill: { ...(config.distill ?? {}), __logger: logger } } });

  ctx.effect(() =>
    ctx.on('agent/created', ({ agent }) => {
      distiller.remember(agent);
    }),
  );
  ctx.effect(() =>
    ctx.on('agent/disposed', ({ agent }) => {
      distiller.forget(agent);
    }),
  );

  // 轮次结束触发自动提炼（只处理正常完成的轮次）
  ctx.effect(() =>
    ctx.on('session/event', (session, event) => {
      if (config.distill?.enabled !== true) return;
      if (event?.type !== 'turn/end') return;
      const reason = event.data?.reason;
      if (reason && reason.kind !== 'completed') return;
      void distiller.run(session).catch((error) => {
        logger.warn?.(`workspace-memory: 自动提炼异常：${error?.message ?? error}`);
      });
    }),
  );

  // ---- 3) 工具面 ----
  for (const tool of createTools({ runtime, config, ctx, distill: (session, opts) => distiller.run(session, opts) })) {
    ctx.effect(() => ctx.tools.register(tool));
  }

  logger.info?.(`workspace-memory: 记忆库 ${dir}`);
}

export { MemoryRuntime };
