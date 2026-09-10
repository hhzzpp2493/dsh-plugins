# dsh-prompt-optimizer

像**华为 OfficeAce** 一样的「提示词优化」：聊天输入框的工具栏加一个 ✍️ 按钮，点击后把当前草稿交给 LLM 改写成**结构清晰、意图明确的高质量提示词**，在输入框上方弹出「原提示词 vs 优化后」对照面板，确认后一键替换回输入框（OfficeAce 同款流程）。

## 功能

- **✍️ 按钮**：位于输入框工具栏（发送按钮前），草稿为空或提交中时自动禁用。
- **对照面板**：输入框上方浮层，左右分栏对比原稿与优化稿。
- **一键应用**：「使用优化结果」把优化稿替换回输入框（可继续编辑再发送）。
- **重新优化 / 关闭**：支持基于当前草稿再次优化。
- **错误提示**：未配置 API Key / 网络失败时给出现因。
- **agent 工具**：同时注册 `optimize_prompt` 工具，agent 自己也能把含糊要求先理顺再执行。

## 工作原理

- **服务端**（cordis 插件）：注册 `POST /plugins/prompt-optimizer/optimize` 路由，收到 `{ text, mode }` 后调 **OpenAI 兼容** `/chat/completions` 接口，system 提示词要求模型只输出优化后的正文、保持原语言与意图。
- **客户端**（web client 插件）：注册两个 Conversation slot——
  - `conversation.input.right`：优化按钮；
  - `conversation.input.dock`：结果面板。
  通过模块级 store（`useSyncExternalStore`）跨 slot 共享状态，点击按钮同源 `fetch` 服务端路由。

## 安装

1. 软链到 profile 的 node_modules：

   ```bash
   ln -s <本插件目录> ~/.dsh/profiles/node_modules/dsh-prompt-optimizer
   ```

2. 把插件加进 profile 的 bundle 列表（客户端部分只有以 bundle 方式加载才会被扫描注入 web 界面）：

   `~/.dsh/profiles/<profile>/package.json`：

   ```json
   "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-prompt-optimizer" ] } }
   ```

3. （可选）在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 覆盖配置（不写则用缺省）：

   ```yaml
   - id: dsh-prompt-optimizer
     config:
       provider: opencode-go
       model: deepseek-v4-flash
   ```

4. 重启 `dsh web`（或等 HMR 推送），刷新浏览器即可在输入框看到 ✍️ 按钮。

## 配置

| 配置项 | 缺省 | 说明 |
|---|---|---|
| `provider` | `opencode-go` | harness `llm` 服务的 provider 路由（复用主对话凭据/重试策略，无需单独配 key） |
| `model` | `deepseek-v4-flash` | 优化用模型 |
| `maxTokens` | `1024` | 优化输出上限 |
| `timeoutMs` | `60000` | 单次请求超时 |
| `maxRetries` | `3` | 直连兜底路径的重试次数 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 仅直连兜底（环境没有 llm 服务时）的 API Key 凭据名 |
| `baseUrl` | `https://api.deepseek.com` | 仅直连兜底的 OpenAI 兼容接口地址 |
| `directModel` | `deepseek-chat` | 仅直连兜底的模型 |

环境变量覆盖：`DSH_PROMPT_OPTIMIZER_PROVIDER` / `DSH_PROMPT_OPTIMIZER_MODEL` / `DSH_PROMPT_OPTIMIZER_API_KEY_ENV` / `DSH_PROMPT_OPTIMIZER_BASE_URL` / `DSH_PROMPT_OPTIMIZER_DIRECT_MODEL`。

> 默认走 harness 的 `llm` 服务（`ctx.llm.stream`），因此用的是你在 dsh 里配置的主力 provider（opencode-go + deepseek-v4-flash），凭据、重试、路由全部复用，无需为优化单独配 API Key。

## 许可

MIT