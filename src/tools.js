/**
 * Agent 工具面：让「把 abc 组给这个工作区」这种话可以直接落地，而不是让用户手改 JSON。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { loadEntries, loadCandidates, saveEntry, saveCandidate, promoteCandidate, deleteCandidate, slugify } from './store.js';
import { writeState } from './runtime.js';
import { matchWorkspace } from './match.js';

/** 统一把工具结果渲染成模型可读的 JSON 文本。 */
function jsonTool(options) {
  return defineTool({
    name: options.name,
    description: options.description,
    parameters: options.parameters ?? {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      exec.signal?.throwIfAborted?.();
      return options.run(args ?? {}, exec);
    },
  });
}

function textOfMessage(message) {
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
 * @param {import('./runtime.js').MemoryRuntime} deps.runtime
 * @param {object} deps.config
 * @param {object} deps.ctx
 * @param {(session: object, opts?: object) => Promise<object>} deps.distill 提炼函数
 */
export function createTools({ runtime, config, ctx, distill }) {
  const currentCwd = (exec) => {
    const session = exec?.agent?.session;
    if (!session) return null;
    try {
      return ctx.workingDirectory.get(session);
    } catch {
      return session.header?.cwd ?? null;
    }
  };

  const status = jsonTool({
    name: 'memory_status',
    description:
      'List which memories are active for the current workspace (matched bindings, sets, entries, and any missing ids). Use this when the user asks what context is loaded here, or before changing bindings.',
    parameters: {},
    async run(_args, exec) {
      const cwd = currentCwd(exec);
      const plan = runtime.plan(cwd ?? '');
      return {
        cwd,
        enabled: config.enabled !== false,
        memoryDir: runtime.dir,
        active: {
          sets: plan.setIds,
          entries: plan.entryIds.map((id) => ({ id, title: runtime.entries[id]?.title ?? null, sources: plan.sources[id] ?? [] })),
          excluded: plan.excluded,
          missing: plan.missing,
        },
        matchedBindings: plan.bindings,
        library: runtime.signature(),
      };
    },
  });

  const list = jsonTool({
    name: 'memory_list',
    description:
      'List the whole memory library: every entry (id, title, tags, size) and every memory set with its members. Use before binding so you know what ids exist.',
    parameters: {
      includeCandidates: { type: 'boolean', description: 'Also include auto-distilled candidates awaiting review.' },
    },
    async run(args) {
      await runtime.refresh();
      const entries = await loadEntries(runtime.dir);
      const candidates = args.includeCandidates ? await loadCandidates(runtime.dir) : [];
      return {
        entries: Object.values(entries).map((e) => ({
          id: e.id,
          title: e.title,
          tags: e.tags,
          bytes: Buffer.byteLength(e.body, 'utf8'),
        })),
        sets: Object.entries(runtime.state.sets).map(([id, set]) => ({ id, entries: set?.entries ?? [] })),
        bindings: runtime.state.bindings,
        candidates: candidates.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      };
    },
  });

  const setTool = jsonTool({
    name: 'memory_set',
    description:
      'Create, update, or delete a memory set — a named group of entry ids (optionally including other sets as "@setId"). Sets are what get bound to workspaces, so this is how {abc} / {bcd} style combinations are defined.',
    parameters: {
      id: { type: 'string', required: true, description: 'Set id, e.g. abc.' },
      action: { type: 'string', description: 'upsert (default) | delete' },
      entries: { type: 'array', items: { type: 'string' }, description: 'Member entry ids; "@setId" includes another set.' },
      note: { type: 'string', description: 'Optional description kept in state.json.' },
    },
    async run(args) {
      const sets = { ...runtime.state.sets };
      if ((args.action ?? 'upsert') === 'delete') {
        delete sets[args.id];
        writeState(runtime.dir, { ...runtime.state, sets });
        await runtime.refresh();
        return { ok: true, deleted: args.id, sets: Object.keys(sets) };
      }
      if (!Array.isArray(args.entries) || args.entries.length === 0) {
        return { ok: false, error: 'entries is required for upsert' };
      }
      sets[args.id] = { entries: args.entries, ...(args.note ? { note: args.note } : {}) };
      writeState(runtime.dir, { ...runtime.state, sets });
      await runtime.refresh();
      return { ok: true, id: args.id, entries: args.entries, totalSets: Object.keys(sets).length };
    },
  });

  const bind = jsonTool({
    name: 'memory_bind',
    description:
      'Attach memory sets and/or single entries to a workspace. Defaults to the current workspace. mode "add" appends a binding, "replace" overwrites all bindings matching the same workspace, "remove" deletes matching bindings. Changes take effect on the next turn.',
    parameters: {
      match: { type: 'string', description: 'Workspace path or glob. Defaults to the current working directory.' },
      mode: { type: 'string', description: 'add (default) | replace | remove' },
      sets: { type: 'array', items: { type: 'string' }, description: 'Memory set ids to enable.' },
      entries: { type: 'array', items: { type: 'string' }, description: 'Single entry ids to enable.' },
      exclude: { type: 'array', items: { type: 'string' }, description: 'Entry or @set ids to subtract.' },
      note: { type: 'string', description: 'Human note stored with the binding.' },
    },
    async run(args, exec) {
      const cwd = currentCwd(exec);
      const match = args.match ?? cwd;
      if (!match) return { ok: false, error: 'no workspace path available; pass match explicitly' };

      const mode = args.mode ?? 'add';
      const state = {
        sets: { ...runtime.state.sets },
        bindings: [...runtime.state.bindings],
      };

      if (mode === 'remove' || mode === 'replace') {
        state.bindings = state.bindings.filter((b) => !matchWorkspace(match, b.match));
      }
      if (mode !== 'remove') {
        state.bindings.push({
          match,
          sets: args.sets ?? [],
          entries: args.entries ?? [],
          exclude: args.exclude ?? [],
          ...(args.note ? { note: args.note } : {}),
        });
      }

      writeState(runtime.dir, state);
      await runtime.refresh();
      const plan = runtime.plan(cwd ?? match);
      return {
        ok: true,
        mode,
        match,
        activeSets: plan.setIds,
        activeEntries: plan.entryIds,
        bindingCount: state.bindings.length,
      };
    },
  });

  const capture = jsonTool({
    name: 'memory_capture',
    description:
      'Save a new memory entry into the library. Use when the user states a durable preference or fact worth reusing. Body should be 1-3 sentences, self-contained, no code blocks.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short title, under 20 characters.' },
      body: { type: 'string', required: true, description: 'The memory itself; self-contained.' },
      id: { type: 'string', description: 'Explicit id; defaults to a slug of the title.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      bindToCurrentWorkspace: { type: 'boolean', description: 'Also bind this entry to the current workspace.' },
    },
    async run(args, exec) {
      const id = await saveEntry(runtime.dir, {
        id: args.id ?? slugify(args.title),
        title: args.title,
        body: args.body,
        tags: args.tags ?? [],
      });
      if (args.bindToCurrentWorkspace) {
        const cwd = currentCwd(exec);
        if (cwd) {
          const state = {
            sets: { ...runtime.state.sets },
            bindings: [...runtime.state.bindings, { match: cwd, entries: [id] }],
          };
          writeState(runtime.dir, state);
        }
      }
      await runtime.refresh();
      return { ok: true, id, bound: Boolean(args.bindToCurrentWorkspace), memoryDir: runtime.dir };
    },
  });

  const candidates = jsonTool({
    name: 'memory_candidates',
    description:
      'Review auto-distilled candidate memories: action "list" (default), "promote" (turn a candidate into a live memory), or "discard". Candidates never take effect until promoted.',
    parameters: {
      action: { type: 'string', description: 'list (default) | promote | discard' },
      id: { type: 'string', description: 'Candidate id, required for promote/discard.' },
    },
    async run(args) {
      const action = args.action ?? 'list';
      if (action === 'list') {
        const listNow = await loadCandidates(runtime.dir);
        return { candidates: listNow.map((c) => ({ id: c.id, title: c.title, body: c.body, tags: c.tags })) };
      }
      if (!args.id) return { ok: false, error: 'id is required' };
      if (action === 'promote') {
        const promoted = await promoteCandidate(runtime.dir, args.id);
        await runtime.refresh();
        return { ok: promoted !== null, id: promoted, error: promoted === null ? 'candidate not found' : undefined };
      }
      if (action === 'discard') {
        await deleteCandidate(runtime.dir, args.id);
        await runtime.refresh();
        return { ok: true, discarded: args.id };
      }
      return { ok: false, error: `unknown action: ${action}` };
    },
  });

  const distillNow = jsonTool({
    name: 'memory_distill',
    description:
      'Distill the current conversation into candidate memories right now (instead of waiting for turn end). Returns the candidates written; they still need promotion.',
    parameters: {
      focus: { type: 'string', description: 'Optional hint about what to focus on.' },
    },
    async run(args, exec) {
      const session = exec?.agent?.session;
      if (!session) return { ok: false, error: 'no active session' };
      const result = await distill(session, { focus: args.focus });
      await runtime.refresh();
      return { ok: true, ...result };
    },
  });

  return [status, setTool, list, bind, capture, candidates, distillNow];
}

export { textOfMessage };
