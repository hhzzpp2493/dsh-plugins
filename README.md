# dsh-plugins

所有 dsh 插件的总仓库（monorepo）。每个插件在 plugins/ 子目录下，用 git subtree 保留各自历史。

## 插件
- plugins/dsh-feishu-cli-bridge — 飞书桥
- plugins/dsh-github-toolkit — GitHub 发布/同步工具箱
- plugins/dsh-cloud-server — 连接云服务器运维工具
- plugins/dsh-web-search-tavily — Tavily 搜索提供商

## 同步
- 推代码: gh_publish_plugin（monorepo 模式）
- 装/同步: gh_sync_plugins（monorepo 模式）

