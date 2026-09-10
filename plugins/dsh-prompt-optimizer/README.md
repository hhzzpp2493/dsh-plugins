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

2. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加（web profile 为热加载，无需重启）：

   ```yaml
   - insert:
       - id: dsh-prompt-optimizer
         name: 'dsh-prompt-optimizer'
         config:
           apiKeyEnv: DEEPSEEK_API_KEY
           baseUrl: https://api.deepseek.com
           model: deepseek-chat
   ```

3. 浏览器刷新（或等 HMR 推送）即可在输入框看到 ✍️ 按钮。

## 配置

| 配置项 | 缺省 | 说明 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 优化请求的 API Key 凭据名（`~/.dsh/.credentials.yaml` 或环境变量） |
| `baseUrl` | `https://api.deepseek.com` | OpenAI 兼容接口地址（可换任意兼容服务） |
| `model` | `deepseek-chat` | 优化用模型 |
| `maxTokens` | `1024` | 优化输出上限 |
| `timeoutMs` | `60000` | 单次请求超时 |
| `maxRetries` | `3` | 429/5xx/网络抖动的重试次数 |

也可用环境变量覆盖：`DSH_PROMPT_OPTIMIZER_API_KEY_ENV` / `DSH_PROMPT_OPTIMIZER_BASE_URL` / `DSH_PROMPT_OPTIMIZER_MODEL`。

## 许可

MIT