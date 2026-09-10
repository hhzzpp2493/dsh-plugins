# dsh-modelscope-toolkit

把**魔搭（ModelScope）生态**接入 dsh：官方 MCP server（模型/数据集搜索、AI 生图等 9 个工具）+ 官方 Agent Skills（`ms-hub`、`ms-studio-deploy`）+ 运维工具。

## 能力

| 通道 | 注入形式 | 能做什么 |
|---|---|---|
| **MCP 工具** | `mcp__modelscope__*` | `search_models` / `search_datasets` / `search_studios` / `search_papers` / `search_mcp_servers` / `get_mcp_server_detail` / `generate_image` / `get_current_user` / `get_environment_info` |
| **Skill** | 会话技能目录 | `ms-hub`（平台全能操作）、`ms-studio-deploy`（部署创空间） |
| **本插件工具** | `modelscope_*` | `modelscope_mcp_status` / `modelscope_mcp_start` / `modelscope_skill_sync` |

## 部署

1. 装 uv：`curl -LsSf https://astral.sh/uv/install.sh | sh`
2. token 进 dsh 进程环境：`MODELSCOPE_API_TOKEN=ms-xxxx`（魔搭「头像 → 访问令牌」创建）
3. 挂载插件（cordis.patch.yml）：

```yaml
- insert:
    - id: dsh-modelscope-toolkit
      name: 'dsh-modelscope-toolkit'
      config:
        port: 8765
```

4. 重启 dsh 后在对话里说：`modelscope_mcp_start`（拉起 MCP）、`modelscope_skill_sync`（同步官方 skill 到 `~/.agents/skills/`）

插件自带 `bundle.patch.yml`，会同时挂上 `@deepseek-ai/dsh-mcp-client`（指向 `http://127.0.0.1:8765/mcp`）。

## 注意

- MCP server 与 dsh 重启会被连带终止时，用 `modelscope_mcp_start` 重新拉起（dsh MCP 桥自动重连）。
- token 是账号钥匙：不要提交到 git；用环境变量或 chmod 600 的 tokenFile。
- 官方 skill（modelscope/modelscope-skills）为 Apache-2.0。