# dsh-feishu-web-bridge

把飞书/Lark 接进 **dsh Web 会话**：桥接插件运行在 `dsh --profile web` 进程内部，飞书端只做「传话筒」（收发消息），所有会话、模型、Agent 模式（标准/PTC）、归档全部使用 web 端原生机制。

```
        ┌──────────────────────────────────┐
        │  dsh web 进程（唯一的大脑和记忆）    │
        │  sessions / workspaces / presets  │
        │  models / archive                 │
        └──────┬───────────────────┬────────┘
               │ /api 流式事件      │ 同进程直调（本插件）
               ▼                   ▼
        浏览器实时界面        飞书桥插件 → lark-cli → 飞书（壳）
```

- 飞书收消息 → 注入该聊天对应的 **web 会话**（浏览器侧边栏实时出现、事件实时流式显示，持久化于 `$DSH_HOME/sessions`）。
- agent 最终文本回复 → 自动转发回飞书聊天。
- 模型选择、Agent 预设切换、归档 = 一律在 web 界面操作。
- 桥的「记忆」（chatId ↔ sessionId、上次活动时间）存 `$DSH_HOME/storages/feishu-bridge.json`（web 端）。

## 安装

1. 把本目录放进 `$DSH_HOME/profiles/node_modules/dsh-feishu-web-bridge/`（真实目录，勿只用裸 symlink——插件要 import dsh 包，需从 profile fallback 解析）。
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 加 insert：

```yaml
- insert:
    - id: dsh-feishu-web-bridge
      name: 'dsh-feishu-web-bridge'
      config:
        cliBin: /home/<you>/.lark-cli/node_modules/.bin/lark-cli
        cliHome: /home/<you>          # 放 ~/.lark-cli 凭据的 HOME
        sendAck: true
        archiveInactiveDays: 7        # 0 = 关闭自动归档
```

3. 重启 web：`kill <web pid>` 后重新 `node /usr/bin/dsh web --no-open --port 3080`（或你的启动脚本），看日志出现 `[feishu-web-bridge] loaded (...)` 与 `[consumer] start lark-cli event consume ...` 与 `[event] ready`。

## 配置项

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `workspace` | `DSH_FEISHU_WORKSPACE` | `$DSH_HOME/feishu-workspace` | 飞书会话工作目录（web 端） |
| `mediaDir` | `DSH_FEISHU_MEDIA_DIR` | `$DSH_HOME/feishu-media` | 飞书图片/文件下载目录 |
| `cliBin` | `DSH_FEISHU_CLI_BIN` | `lark-cli` | lark-cli 可执行文件 |
| `cliHome` | `DSH_FEISHU_CLI_HOME` | `$HOME` | 存放 `~/.lark-cli` 凭据的家目录 |
| `sendAck` | `DSH_FEISHU_ACK` | `true` | 先回「收到，正在处理…」 |
| `archiveInactiveDays` | `DSH_FEISHU_ARCHIVE_DAYS` | `7` | 聊天 N 天无活动 → 自动归档该会话（0=关） |
| `archiveRetentionDays` | `DSH_FEISHU_RETENTION_DAYS` | `45` | 归档超过 N 天 → 物理清理（0=永久保留） |
| `archiveKeepPerChat` | `DSH_FEISHU_KEEP_PER_CHAT` | `20` | 每聊天归档时间戳上限（清理用） |
| `showStats` | `DSH_FEISHU_STATS` | `true` |
| `maxTurnRetries` | `DSH_FEISHU_MAX_TURN_RETRIES` | `10` | 单次运行连续失败 turn 上限：到达即中止 agent 并上报，避免模型/提供方故障时无限重试（重试风暴） |
 回复卡片底部显示 输入/输出/缓存命中 + 模型（`/stats` 可逐聊天覆盖） |

## 飞书端

- 普通文本 / 图片 / 文件 → 投进该聊天的 web 会话；agent 完成后**以交互卡片回复**（蓝色 `🐋 DeepSeek Harness` 卡片，移动端自适应）。
- 卡片最下端（可开关）显示**与 web 界面完全相同的**用量指标：`📊 输入 · 输出 · 缓存命中` + `🖥️ 模型`——直接读取 host 侧 `sessionProjections` 的 `tokenUsage` 投影（正是浏览器渲染的那组数，非桥自己折算），模型取自会话最新的 request header。
- 命令：
  - `/new`（或 `/重置` / `/重开`）：为**本聊天**开新会话——旧会话归档（web 端可恢复），会话 id 从 `feishu-<chatId>` 递增为 `feishu-<chatId>-2`、`-3`…，下一条消息接入全新会话。
  - `/model`：列出可用模型与当前模型；`/model <编号|provider/model|名称>` 切换本聊天模型（对在线 agent 实时生效，原 web 界面操作依然可用）；`/model default` 恢复 web 默认。
  - `/stats`（`/用量` `/统计`）：切换卡片底部用量脚注——`/stats` 翻转、`/stats on|off` 显式设置、`/stats default` 跟随全局（全局默认由 `showStats` 配置）。
- 其余（模式、新建/归档、Agent preset）→ 都在 web 界面操作。

## 归档与保留

- 归档（`/new` 或 `archiveInactiveDays` 天无活动自动归档）只是把会话从侧边栏隐藏，数据留在 web 端可恢复。
- **几百条归档也不会无限堆积**：每次归档时桥在 `feishu-bridge.json` 里记下时间戳（每聊天最多 `archiveKeepPerChat` 条记录），超过 `archiveRetentionDays`（默认 45 天）的归档会话被**物理清理**：删除会话目录 + 从工作区注册表/归档表/投影缓存移除，仅处理 `feishu-*` 会话、跳过仍在线会话。web 重启后状态完全一致。

## 行为与边界

- 每个飞书聊天有独立的会话代际（`gen`，存于 `$DSH_HOME/storages/feishu-bridge.json`），`/new` 与自动归档都会递增代际，避免新消息 resume 回旧会话。
- 模型切换：`/model` 存到该聊天的映射（`rec.model`），新会话创建/恢复直接使用；对当前在线会话通过 `installModelSelection` 实时重指向（与 web `session.selectModel` 同机制），「后操作者生效」。
- web 重启后自动 resume 同一会话（历史不断），id 由映射表决定；映射丢失则重建新会话。
- agent 正忙（如 web 端正在跑任务）时，飞书消息会收到「上一条还在处理中」，不会丢失排队。
- 同聊天的消息按到达顺序串行处理。
- 已跑过的会话不能切 Agent 预设（dsh 原生限制）——切模式请用 web 端新建会话，或用飞书 `/new` 开新会话。
