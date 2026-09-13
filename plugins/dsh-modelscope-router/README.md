# dsh-modelscope-router

把**魔搭（ModelScope）免费推理池**接入 dsh：按档位（strong/main/light/deep）+ fallback 顺序自动路由 + 每日额度本地记账 + SSE 流式聚合 + 中文关键词自动选档。

## 为什么做这个

- ModelScope 免费推理 API 有 2000 次/天配额（含所有模型），深度推理池额外 200 次/天；
- 单个模型不是"2000 次"，是**全体共用 2000**；
- 因此必须做**路由 + fallback + 记账**，把额度花在刀刃上。

## 已验证可调用模型（2026-09-10 用 curl 逐个测）

| 模型 | 可用 | 档位归属 |
|---|---|---|
| `deepseek-ai/DeepSeek-V4-Pro-0813` | ✅ | strong / deep |
| `deepseek-ai/DeepSeek-V4-Pro` | ✅ | strong / deep |
| `deepseek-ai/DeepSeek-V4-Flash-0731` | ✅ | main / light |
| `Qwen/Qwen3.8-27B` | ✅ | strong / main |
| `Qwen/Qwen3-30B-A3B` | ✅ | strong / main |
| `Qwen/Qwen3-8B` | ✅ | main / light |
| `ZhipuAI/GLM-5.2` | ✅ | strong / main |
| `ZhipuAI/GLM-4.7-Flash` | ✅ | light |

⚠️ 以下模型虽在魔搭模型卡标 `support_inference=true`，但 OpenAI 兼容接口**实测 400**，插件已剔除：
`Qwen/Qwen3-32B`、`Qwen/Qwen3-Next-80B-A3B`、`MiniMax/MiniMax-M2.7`、`ZhipuAI/GLM-5.3`、`deepseek-ai/DeepSeek-R1`、`deepseek-ai/DeepSeek-R1-Distill-Qwen-32B`、`deepseek-ai/DeepSeek-R1-Distill-Qwen-7B` 等。

## 路由策略（"优先能力强"版）

- `defaultTier = 'strong'`：普通请求默认走**旗舰档**；
- 关键词命中「推理/证明/算法/调试/策略」等 ≥ 2 个 → `deep` 池（200 次/天）；
- 命中「总结/分析/翻译/解释」等 → `strong`；
- 文本长度 < 30 字 → `light`；
- 主池已用 ≥ 95% × 2000 → 强制 `light` 兜底；
- 单个模型今日调用 ≥ 30 次 → 自动切到下一 fallback。

## 4 个工具

| 工具 | 用途 |
|---|---|
| `ms_chat` | 自动路由调魔搭推理（推荐日常用） |
| `ms_chat_force` | 强制指定档位或具体模型 ID（测试用） |
| `ms_ledger` | 查看今日额度：主池、深推理池、各模型调用数、最近 20 条 |
| `ms_ledger_reset` | 手动清零今日记账（测试用） |

## 部署

前置：装 `dsh-modelscope-toolkit`（提供 `~/.dsh/modelscope-token`）。

1. bundle.patch.yml 里已经写好挂载段；
2. `cordis.patch.yml` 加一行 insert 即可（见 bundle.patch.yml）；
3. 重启 dsh，`ms_ledger` 应能返回"今日无调用"。

## 记账文件

默认 `/home/ubuntu/.dsh/storages/ms-router-ledger.json`：

```json
{
  "date": "2026-09-10",
  "pools": { "main": 12, "deep": 0 },
  "models": { "deepseek-ai/DeepSeek-V4-Pro-0813": 8, ... },
  "calls": [ { "ts": "...", "model": "...", "tier": "...", "tokens": 123, "elapsedMs": 1234 }, ... ]
}
```

跨天自动清零；`calls` 只保留最近 200 条。

## 局限

- SSE 流下 `usage.total_tokens` 返回 0（魔搭当前行为），插件按**调用次数**记账，不精确按 token；
- 魔搭推理 API 只保证 OpenAI 兼容，不保证返回 `reasoning_content`；关闭 thinking 时 `chat_template_kwargs.enable_thinking=false`，Qwen3-8B 实测仍然会输出思考块（服务端行为）；
- 深推理池独立上限 200 次/天，用尽后自动降级到 `main`；主池用尽则彻底停摆。
