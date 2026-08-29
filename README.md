# dsh-plugins

所有 dsh 插件的**总仓库**（monorepo）。只需建这一个库，以后全部插件都收编在这里，新插件直接推进来，不需要再单独建库。

## 插件

| 目录 | 插件 | 说明 |
|---|---|---|
| `plugins/dsh-feishu-cli-bridge` | 飞书桥 | 飞书 <-> dsh 消息桥 |
| `plugins/dsh-github-toolkit` | GitHub 工具箱 | `gh_publish_plugin` / `gh_sync_plugins` / `gh_new_plugin` |
| `plugins/dsh-cloud-server` | 云服务器运维 | `cloud_ssh` / `cloud_status`，随时远程调用云服务器 |
| `plugins/dsh-web-search-tavily` | Tavily 搜索 | web search 提供方 |

## 工作方式（总库模式）

在 `github-toolkit` 插件（即本总库内的 `dsh-github-toolkit`）配置：

```yaml
- insert:
    - id: github-toolkit
      name: 'dsh-github-toolkit'
      config:
        user: hhzzpp2493
        keyPath: <本机 SSH 私钥>
        monorepo: dsh-plugins          # ← 总库模式：不再为每个插件单独建库
        monorepoDir: <本地总库工作区，可选>
```

- **推新插件/更新**：`gh_publish_plugin plugin_dir=<插件目录>` → 自动收进 `plugins/<名字>` 并 push 本总库。
- **新机器装全部**：`gh_sync_plugins dsh_home=<DSH_HOME>` → clone 总库，把 `plugins/` 下全部插件软链进 `profiles/node_modules`，重启 dsh 即全部可用。

## 新插件入库流程

1. `gh_new_plugin name=<插件名>` 生成骨架。
2. 开发完 → `gh_publish_plugin plugin_dir=<目录>`（总库模式自动入总库）。
3. 目标机器 `gh_sync_plugins` + 重启对应 profile。

无需 PAT、无需手动建任何新仓库。