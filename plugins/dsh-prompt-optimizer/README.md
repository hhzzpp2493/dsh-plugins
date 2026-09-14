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

- **服务端**（cordis 插件）：注册 `POST /plugins/prompt-optimizer/optimize` 路由，收到 `{ text, mode }` 后独立调用硅基流动的 **OpenAI 兼容** `/v1/chat/completions` 接口；不读取当前会话的 provider/model，因此不会阻塞新建对话主流程。
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
       provider: siliconflow
       model: Qwen/Qwen3-8B
   ```

4. 重启 `dsh web`（或等 HMR 推送），刷新浏览器即可在输入框看到 ✍️ 按钮。

## 配置

| 配置项 | 缺省 | 说明 |
|---|---|---|
| `provider` | `siliconflow` | 独立供应商标识，不参与主对话模型联动 |
| `model` | `Qwen/Qwen3-8B` | 硅基流动优化模型 |
| `maxTokens` | `1024` | 优化输出上限 |
| `timeoutMs` | `30000` | 单次请求超时 |
| `maxRetries` | `2` | 429/5xx/网络超时重试次数 |
| `apiKeyEnv` | `SILICONFLOW_API_KEY` | 硅基流动 API Key 凭据名 |
| `baseUrl` | `https://api.siliconflow.cn/v1` | 硅基流动 OpenAI 兼容接口地址 |

环境变量覆盖：`DSH_PROMPT_OPTIMIZER_PROVIDER` / `DSH_PROMPT_OPTIMIZER_MODEL` / `DSH_PROMPT_OPTIMIZER_API_KEY_ENV` / `DSH_PROMPT_OPTIMIZER_BASE_URL`。

> 提示词优化独立调用硅基流动，不读取当前会话模型。推荐的 `Qwen/Qwen3-8B` 适合短文本改写；是否免费、免费额度、并发和速率以硅基流动控制台当前账户与模型页面为准，免费额度用尽后需按平台规则付费或停用。

## 许可

MIT