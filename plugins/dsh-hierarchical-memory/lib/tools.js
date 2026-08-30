// tools.js — model-invocable memory tools for the hierarchical memory system.
//
//  memory_search      — retrieve salient memories across layers
//  memory_commit      — explicitly store an important fact/lesson
//  memory_learn       — record an experience lesson (self-evolution channel)
//  memory_consolidate — run consolidation & forgetting now
//  memory_state       — overview of layers and evolution statistics

import { defineTool } from "@deepseek-ai/dsh-tools";
import { LAYERS } from "./store.js";
import { consolidate } from "./consolidate.js";
import { learnLesson, renderPlaybook } from "./evolve.js";
import { runReflectionBatch } from "./reflection.js";

const LAYER_VALUES = ["working", "episodic", "semantic", "procedural", "all"];

function jsonTool(name, description, fn, extra = {}) {
  return defineTool({
    name,
    description,
    parameters: {
      ...(extra.parameters ?? {}),
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }],
    },
    async execute(args, exec) {
      const sessionId = exec.agent?.session?.id;
      const result = await fn(args, { sessionId, exec });
      return typeof result === "string" ? result : JSON.stringify(result, null, 2);
    },
  });
}

export function registerMemoryTools(ctx, store, cfg) {
  const tools = [];

  tools.push(jsonTool(
    "memory_search",
    "按查询检索分层记忆（工作/情景/语义/程序记忆），返回带相关度打分的条目，是跨会话记住用户偏好、事实与经验教训的主要入口。",
    (args, { sessionId }) => {
      const layers = args.layer === "all" || !args.layer ? LAYERS : [args.layer];
      const hits = store.query(args.query, {
        layers,
        topK: Math.min(20, Math.max(1, Number(args.topK) || (cfg.searchTopK ?? 5))),
      });
      if (!hits.length) return { query: args.query, hits: [], hint: "无匹配记忆。可用 memory_commit 显式记录重要内容。" };
      return {
        query: args.query,
        layer: args.layer ?? "all",
        hits: hits.map((h) => ({
          layer: h.layer,
          importance: h.importance,
          score: h.score,
          text: h.text,
          tags: h.tags ?? [],
        })),
        hint: "检索会强化命中的记忆（访问次数+1）。重要发现可用 memory_learn 沉淀为经验。",
      };
    },
    {
      parameters: {
        query: { type: "string", required: true, description: "检索查询（关键词即可，中英文均可）" },
        layer: { type: "string", enum: LAYER_VALUES, description: "限定记忆层；默认全部" },
        topK: { type: "integer", description: "返回条数（默认 5，上限 20）" },
      },
    },
  ));

  tools.push(jsonTool(
    "memory_commit",
    "显式写入一条高优先级记忆：重要事实、用户偏好、长期约束。写入 semantic 层。",
    (args, { sessionId }) => {
      const entry = store.add({
        layer: "semantic",
        text: args.text,
        source: "user",
        importance: Math.min(10, Math.max(3, Number(args.importance) || 6)),
        sessionId,
        tags: ["committed"],
      });
      store.logEvolution("commit", { id: entry.id });
      return { ok: true, id: entry.id, layer: "semantic", importance: entry.importance };
    },
    {
      parameters: {
        text: { type: "string", required: true, description: "要长期记住的内容" },
        importance: { type: "number", description: "重要度 1-10，默认 6" },
      },
    },
  ));

  tools.push(jsonTool(
    "memory_learn",
    "自我进化学**核心工具**：把本次会话学到的经验/教训/方法沉淀到程序记忆层；重复学到相同经验会强化其置信度。",
    (args, { sessionId }) => {
      if (!args.lesson || String(args.lesson).trim().length < 8) {
        return { ok: false, error: "lesson 太短（至少 8 字符）" };
      }
      const { entry, reinforced } = learnLesson(store, {
        lesson: String(args.lesson).trim(),
        topic: args.topic ? String(args.topic).trim() : "",
        sessionId,
        cfg,
      });
      return {
        ok: true,
        id: entry.id,
        reinforced,
        confidence: entry.meta?.confirmations ?? 1,
        note: reinforced ? "该经验此前已存在，置信度已提升（强化）。" : "新经验已沉淀。",
      };
    },
    {
      parameters: {
        lesson: { type: "string", required: true, description: "经验/教训内容" },
        topic: { type: "string", description: "所属主题，用于检索标记" },
      },
    },
  ));

  tools.push(jsonTool(
    "memory_consolidate",
    "立即执行一次记忆巩固：合并相似情景记忆为语义记忆、遗忘低重要度旧记忆、执行各层容量裁剪。",
    () => {
      const stats = consolidate(store, cfg);
      return { ok: true, stats, counts: store.counts() };
    },
  ));

  tools.push(jsonTool(
    "memory_state",
    "查看分层记忆规模与自我进化统计（各层条目数、归档数、最近巩固、进化事件数）。",
    () => ({
      counts: store.counts(),
      meta: store.meta,
      recentEvolution: store.evolution.slice(-12),
      playbookLength: renderPlaybook(store, cfg).length,
      reflection: {
        enabled: cfg.reflectionEnabled !== false,
        provider: cfg.llmProvider,
        model: cfg.llmModel,
        lastBatchAt: store.meta.reflectionAt ?? null,
        totalCalls: store.meta.reflectionCalls ?? 0,
      },
    }),
  ));

  tools.push(jsonTool(
    "memory_reflect",
    "立即执行一轮 LLM 反思批次：把未提炼的程序记忆教训升级为可执行经验，并把未蒸馏的语义条目压缩为紧凑事实。受冷却期与每批调用上限约束；LLM 不可用或失败时静默降级（不影响既有记忆）。",
    async (_args, { sessionId }) => {
      try {
        const stats = await runReflectionBatch(ctx, store, { ...cfg, force: true });
        return {
          ok: true,
          stats,
          counts: store.counts(),
          note: stats.reason
            ? `本轮未调用模型：${stats.reason}`
            : `本轮已处理 ${stats.calls} 次模型调用（反思 ${stats.reflected} 条教训、蒸馏 ${stats.distilled} 条语义）。`,
        };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },
    {
      parameters: {
        force: { type: "boolean", description: "忽略冷却期立即执行（默认 true，供手动触发）" },
      },
    },
  ));

  for (const tool of tools) ctx.tools.register(tool);
  return tools;
}