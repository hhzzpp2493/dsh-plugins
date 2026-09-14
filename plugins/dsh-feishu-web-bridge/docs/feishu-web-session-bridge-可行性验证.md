# 飞书桥接重构：消息进 Web 会话 —— 可行性验证与设计决定

> 验证时间：2026-08-30
> 结论：**方案可行，推荐采用「A. 桥接插件内嵌 web profile（同进程）」架构**。
> 依据：dsh 本机安装源码（`/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/*`）逐项核对 + Tavily 研究发现交叉验证。

---

## 1. 现状（当前飞书插件怎么工作的）

`dsh-feishu-cli-bridge` v0.2 当前是「**独立嵌套运行时**」架构：

- 桥接是 `dsh --profile feishu-bridge` 的 cordis 插件（`bridge/plugin.js`），独立进程；
- 收到飞书消息后，用 `@deepseek-ai/dsh-sdk-client` 再拉起一个**嵌套的** `dsh --profile feishu-agent` 子进程；
- 会话 id 为 `feishu2:{chatId}`，落在 `.dsh-feishu/sessions`（**与 web 的会话完全隔离**）；
- `/new`、`/model` 由桥接自己实现；模型可选、可持久化（`feishu-chat-models.json`）。

问题：会话在浏览器里看不到、也不共享 web 的机制（preset、workspace、归档、模型选择 UI）。

## 2. 目标架构（你要的）

> 飞书端 = 传话筒/收话筒；消息落到 **web 界面的会话**；工作运行在 web 端（同一个 `dsh web` 进程）。

## 3. 关键前提：web 端就是一个单进程 dsh 进程

本机实际运行：`node /usr/bin/dsh web --no-open --port 3080`（pid 31）。

- `dsh web` = `dsh --profile web`，**一个进程同时承载**：HTTP/WebSocket 服务、agent loop、session 注册表、workspace 注册表、agent preset 服务、模型默认值、会话持久化（`$DSH_HOME/sessions`）、归档状态（`$DSH_HOME/storages/workspace.json`）。
- 浏览器只是通过 `/api`（`dsh-client-connection`，WebSocket mux）连接 host 的半客户端；**agent/session 全在服务端进程里**，没有浏览器连上也照常跑（`dsh --profile headless` 就是无浏览器跑同样机制的官方证明）。
- 本机 web profile 的 `cordis.patch.yml` 已经在用「insert 插件进 web profile」的机制（web-search-tavily / github-toolkit / dsh-cloud-server 都是这么装进去的）——**给 web profile 塞插件是已验证、正在使用的受支持方式**。

→ 因此「飞书桥接插件装进 web profile、同进程驱动同一套会话机制」在架构上完全成立。

## 4. 五个需求逐项验证（含具体 dsh 原语）

| 需求 | 可行性 | dsh 原生机制（源码核对） |
|---|---|---|
| ① 飞书消息 → web 会话 | ✅ | `dsh-headless` 是官方同款范例：`agents.create({sessionId, meta:{cwd}, agentOptions:{provider,model}})` → `agent.followup(createUserMessage(...))` → `await agent.whenIdle()` → `sessions.flush(session)`。插件在同进程调同一套服务，会话就在 web 的 session registry 里，浏览器侧边栏 `api.sessions.list` 直接列出来，事件经 `/api/events.mux` 实时流到浏览器。 |
| ② 新建会话 | ✅ | host API `session.create`（进程内即 `agents.create` / sessions 服务），可关联 workspace（`workspace.create` → `session.create({workspaceId})`），自动生成标题（`dsh-session-title-*` 包都在 web profile 里）。 |
| ③ 模型选择 | ✅ | `session.selectModel` 的机制 = `installModelSelection(agent.ctx, selection)`（`@deepseek-ai/dsh-agent` 导出，headless 与 apiproxy 都这么用），会话级生效、实时可改；新建会话时也可直接 `agentOptions:{provider,model}`。模型列表读 `settings.yaml` 的 `llm-pi-ai.providers`（现有 `listModels()` 已实现，与 web 同一个来源）。 |
| ④ 旧对话自动归档 | ✅ | web 原生 `workspace.archiveSession(sessionId)`（`ctx.workspaces.archiveSession`）：持久化进 `storages/workspace.json`，从所有分组界面隐藏、保留位置可恢复。桥接做「N 天无飞书活动 → 归档」的定时清扫即可。 |
| ⑤ 标准模式 / PTC 模式 | ✅ | 就是 **agent presets**：`standard`=标准模式、`code`=PTC 模式（另有 `minimal` 极简、`cordis` 创造）。会话创建时 `agentPresets.resolve(id)` + `agentPresets.mount(agentCtx, id)`（apiproxy `composeAgent()` 同款）；host API 有 `agentPreset.list/select/read`。⚠️ 注意：**已跑过的会话不能换 preset**（`AgentPresetConflict`，`assertPresetUnchanged()` 强制）——换模式 = 开新会话 + 归档旧会话。 |

## 5. 架构选型与决定

### A. 桥接插件内嵌 web profile（同进程）—— **推荐 ✅**
- 装进 `$DSH_HOME/profiles/node_modules` + `profiles/web/cordis.patch.yml` insert（现有机制）。
- 插件直接持有 `ctx.sessions / ctx.agents / ctx.workspaces / ctx.agentPresets / ctx.agentDefaultModel`。
- 会话就是 web 会话：浏览器实时可见、同一持久化目录、同一模型/preset/归档体系。
- 回复回传：followup 后 `whenIdle()`，按 `dsh-headless` 的 `summarize()` 取最终文本，分片发回飞书；同时浏览器实时看到完整过程。
- 返回路径：agent 侧注册 `feishu_send_message / feishu_send_file` 工具（现有 tools 改造挂到 web agent），经桥接 notify/sender 回飞书。

### B. 桥接保持独立进程，用 HTTP 调 web 的 /api —— 不推荐 ❌
- `/api` 是浏览器 mux/typert 协议（`dsh-client-connection`），虽然后端是 HTTP 且 loopback Host 可通过信任围栏（`isTrustedApiRequest`），但需要自己实现 RPC 信封、事件订阅、会话生命周期同步——等于重写半个浏览器客户端，且这是给浏览器用的内部通道，不是给第三方用的 SDK，升级易碎。

### C. 维持现状（嵌套独立运行时）—— 与你目标不符
- 会话在 `.dsh-feishu/sessions`，web 看不到。

**决定：A。** 改动面收敛为一个插件（复用现有 bridge 的 lark-cli 收发、事件消费、文件下载、notify server），只是把「嵌套 SDK 运行时」换成「同进程 session/agent 服务」。

## 6. 设计要点与注意项

1. **聊天 ↔ 会话映射**：`chatId → {sessionId, workspaceId, preset, model, lastActivity}` 持久化到 `$DSH_HOME/feishu-chat-sessions.json`（沿用现有 chat-models.json 思路）。飞书首次来消息 → 建/复用会话；会话名可用飞书群名/用户名。
2. **一个飞书工作区**：给飞书会话建独立 workspace（如 `$DSH_HOME/feishu-workspace`），浏览器侧边栏归类清晰，隔离 agent 工作目录。
3. **preset 切换**：已跑过的会话直接拒绝换 preset（dsh 强制）→ 飞书侧 `/mode standard|ptc` 实现为「新会话 + 归档旧会话」，回复里说明。
4. **模型切换**：会话级实时可改（selectModel 机制）；模型名从 `llm.providers`/`llm.models` 拉。
5. **并发与忙碌**：每个会话同一时刻一个 agent；飞书消息进时若 agent 正忙，回「上一条还在处理中」；必要时做按聊天串行队列。
6. **自动归档**：daily timer 扫描映射表，`lastActivity` 超过阈值（默认 7 天）→ `workspaces.archiveSession` + 解绑映射；飞书侧 /archive 手动归档。
7. **回传**：`whenIdle()` 后取最终文本分片回飞书；超长回复按现有 `splitLongText` 规则。
8. **工具注册**：`feishu_send_message` 等要挂进 web agent 的工具集（桥接工具按 session → chatId 取上下文，无需在提示词里重复塞 chat_id 即可定位目标聊天）。
9. **存量会话**：旧的 `feishu2:*` 会话在 `.dsh-feishu/sessions`（嵌套运行时），新架构不迁移，随旧 profile 弃用。
10. **HMR/升级**：dsh 是 rc 版、插件 API 可能变；以 apiproxy/headless 为参照实现，保持与官方用法一致。

## 7. 实施步骤（获批后）

1. 新建 `dsh-feishu-web-bridge`（或改造现有插件）：cordis 插件，`inject: ["sessions","agents","workspaces","agentPresets","agentDefaultModel"]`。
2. 桥接逻辑（EventConsumer / FeishuSender / notify server）从现有 engine.js 抽出复用。
3. 消息管道：接收 → 映射/建会话 → 选 preset → 选模型 → followup → whenIdle → summarize → 分片回飞书；浏览器实时可见。
4. 命令：`/new`（归档旧 + 开新）、`/model`（列/选）、`/mode standard|ptc`（开新会话 + 归档）、`/archive`。
5. 自动归档定时器。
6. 安装到 `$DSH_HOME/profiles/node_modules` + `profiles/web/cordis.patch.yml` insert（与现有插件同方式）。
7. 端到端验证：飞书发消息 → 浏览器出现会话并实时流式显示 → 飞书收到最终回复 → /new、/mode、/model、自动归档全链路。

## 8. 参考资料（Tavily 研究）

- DeepSeek Harness 预设/模式说明（standard=标准模式, code=PTC 模式, minimal=极简, cordis=创造）：https://openclawlaunch.com/guides/deepseek-harness
- headless profile 一次性持久化会话：`dsh --profile headless "task"`（官方 README + https://explainx.ai/blog/deepseek-harness-v0-1-plugin-first-agent-stack-august-2026）
- 归档能力社区印证（dsh-session-archive / dsh-session-cleaner-cli）：https://github.com/0xsline/awesome-deepseek-harness
- 模式与 Plan Mode 的区别（preset 是运行时组合，Plan mode 是 per-agent 协作状态）：https://shop.zimaspace.com/blogs/tech-ai-hub/de-minimal-and-creator-explained
- dsh 源码级核对：`dsh-host-apiproxy`（session.create/prompt/selectModel、workspace.archiveSession、agentPreset.select 全套 host API）、`dsh-headless`、`dsh-agent-presets`（config/agent-presets/{standard,code}/preset.yml）、`dsh-session-query`、`dsh-workspace`、`dsh-client-connection`（/api 信任围栏）。