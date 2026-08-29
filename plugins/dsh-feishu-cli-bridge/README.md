# dsh-feishu-cli-bridge

把 **DeepSeek Harness（dsh）** 接进 **飞书/Lark**：聊天驱动 agent + 官方 `@larksuite/cli` 收发消息、操控云盘与云文档。整个桥是一个 **dsh 插件（cordis bundle）**，随 profile 启停。

> Bridge DeepSeek Harness into Feishu/Lark with the official lark-cli, as one dsh plugin.

## 架构

```
飞书用户 ──> lark-cli event consume im.message.receive_v1 (WebSocket 长连接, NDJSON)
          ──> [宿主 profile: dsh --profile feishu-bridge] 桥插件
          ──> @deepseek-ai/dsh-sdk-client ──> [嵌套 agent 运行时 profile: feishu-agent]

飞书用户 <── lark-cli im +messages-send (bot 身份) <── 桥插件 <── agent 回复

agent 工具 (feishu_send_message / feishu_send_file / feishu_drive_* / feishu_create_doc)
    ──> 本地 notify server (127.0.0.1:48680) 或直接 spawn lark-cli
```

两个 profile、两个进程：
| Profile | 作用 | bundles |
|---|---|---|
| `feishu-bridge`（宿主） | 跑桥插件：事件守护、会话路由、notify server、spawn 运行时 | `dsh-base` + `dsh-feishu-cli-bridge` |
| `feishu-agent`（嵌套） | agent 运行时：接待器请求，加载 6 个 feishu 工具 | `dsh-base` + `sdk-jsonrpc-server` + `dsh-feishu-cli-bridge/tools` |

## 使用

```bash
# 一键启动整套桥（宿主 profile；首次消息即拉起嵌套运行时）
./start-bridge.sh
# 等价于
export DSH_HOME=... HOME=... DSH_FEISHU_PROFILE=feishu-agent ...
node /usr/bin/dsh --profile feishu-bridge

# systemd（备好即用）
sudo cp dsh-feishu-cli-bridge.service /etc/systemd/system/
sudo systemctl enable --now dsh-feishu-cli-bridge
```

## 首次部署（一次性）

```bash
# 1. 官方 CLI 一键创建应用并绑定凭据（浏览器完成）
HOME=/home/ubuntu/dsh/.home lark-cli config init --new --brand feishu
# 2. 授权 scope（浏览器完成；两条命令完成设备流）
HOME=/home/ubuntu/dsh/.home lark-cli auth login --domain im,drive,event,docs --no-wait --json
HOME=/home/ubuntu/dsh/.home lark-cli auth login --device-code <CODE>
# 3. 校验
HOME=/home/ubuntu/dsh/.home lark-cli auth status
```

## 目录

| 路径 | 说明 |
|---|---|
| `bridge/plugin.js` | Cordis 插件入口（Config/生命周期/可选 Web Settings 注册） |
| `bridge/engine.js` | 桥引擎（事件消费、会话路由、notify server、SDK 运行时） |
| `bridge/event-consumer.js` | `lark-cli event consume` 守护（断线重连、指数退避） |
| `bridge/sender.js` / `bridge/cli.js` | lark-cli 调用（异步封装，避免阻塞运行时事件循环） |
| `bridge/notify-server.js` | 本地回调接口（agent 工具发消息用） |
| `bridge/main.js` | 独立运行器（调试用；生产走插件） |
| `tools/index.js` | agent 工具插件：`feishu_send_message` / `feishu_send_file` / `feishu_drive_upload` / `feishu_drive_download` / `feishu_drive_search` / `feishu_create_doc` |
| `bundle.patch.yml` | bundle 自注入补丁（`dsh.bundle.patch`） |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | 环境 | dsh 数据目录（settings/credentials/profiles） |
| `HOME` | 环境 | 必须指向 lark-cli 可写目录（密钥库硬编码 `$HOME/.local/share`） |
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` | 环境 | lark-cli 配置目录 |
| `DSH_FEISHU_HOST_PROFILE` | `feishu-bridge` | 宿主 profile 名 |
| `DSH_FEISHU_PROFILE` | `feishu-agent` | 嵌套 agent 运行时 profile 名 |
| `DSH_FEISHU_DSH_BIN` | `/usr/bin/dsh` | dsh 启动器路径 |
| `DSH_FEISHU_WORKSPACE` / `DSH_FEISHU_MEDIA_DIR` | `feishu-workspace` / `feishu-media` | agent 工作目录 / 附件下载目录 |
| `DSH_FEISHU_CLI_BIN` | `lark-cli` | 官方 CLI 二进制 |
| `DSH_FEISHU_PROVIDER` / `DSH_FEISHU_MODEL` | `opencode-go` / `deepseek-v4-flash` | 模型路由 |
| `DSH_FEISHU_NOTIFY_PORT` / `DSH_FEISHU_NOTIFY_TOKEN` | `48680` / 随机 | 本地回调 |
| `DSH_FEISHU_ACK` | `1` | 先回"收到，正在处理…" |

## 已知坑（已解决，供维护参考）

- **npm 重复包会杀死工具调度**：宿主/运行时 profile 若被 npm 提升出 `@deepseek-ai/dsh-tools` 副本，会与全局副本的私有调度器 Symbol 不匹配，所有 agent 工具调用静默失败。安装依赖后运行 `prune-profile.sh`（删除顶层副本 + 重建 `node_modules/dsh-feishu-cli-bridge` 软链）。
- **被杀进程的残留会话会被恢复成"卡死"状态**：会话 id 已按部署命名空间隔离（`feishu2:`），重启桥不会撞上旧会话；历史遗留脏会话可删除对应 `$DSH_HOME/sessions/...` 目录。
- **lark-cli 密钥库不认 `XDG_DATA_HOME`**：keychain 路径硬编码 `$HOME/.local/share/lark-cli`，必须让所有 lark-cli 进程继承正确的 `HOME`。

## 验证

```bash
node test-boot.js          # 嵌套运行时空转（期望 BOOT-OK）
node test-agent-tool.js    # agent 工具全链路（建文档/上传/搜索，真实落盘飞书）
# 飞书私聊 bot → 观察回复与工具消息（见 /tmp/feishu-host.log）
```

## 限制（v0.2）

- 收消息仅文本 + 图片/文件（附件自动下载注入路径）；富文本暂不解析
- 回复为最终文本（无流式卡片交互）
- `feishu_send_message` / `feishu_send_file` 需显式 `chat_id`（桥每轮注入当前 chat_id）
- 云盘函数默认 `--as user`（用户 OAuth 身份）；bot 身份仅用于收发消息

## 社区

本插件适配 dsh 插件体系（`dsh.bundle.patch`、settings 命名空间、双 profile 托管），元数据完备，可发布至 dsh 插件市场（dshfind / dshbase / dsh-plugin.org）。