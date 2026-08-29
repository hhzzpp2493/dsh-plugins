# dsh-github-toolkit

把「插件上传 GitHub + 云服务器安装同步 + 新插件脚手架」封装成 **dsh agent 工具**。
以后对 agent 说一句话就能完成，不用再手动走流程：
- 发布/更新插件 → `gh_publish_plugin`
- 云服务器一键安装/同步 → `gh_sync_plugins`
- 新建插件骨架 → `gh_new_plugin`（生成标准 cordis 插件目录，开发完直接发布）

## 安装

### 方式 A：作为 bundle（profile 的 package.json）
```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-github-toolkit"] } }
```

### 方式 B：patch insert（推荐 web profile，写在 cordis.patch.yml）
```yaml
- insert:
    - id: github-toolkit
      name: 'dsh-github-toolkit'
      config:
        user: hhzzpp2493                      # GitHub 用户名（或 DSH_GH_USER）
        keyPath: /home/hzp/deepseek/.ssh/id_ed25519_dsh   # 推送私钥（或 DSH_GH_KEY）
        pat: ''                               # 建仓库 PAT（或 DSH_GH_PAT）；缺省则仅提示网页建仓库
        plugins:                              # gh_sync_plugins 默认同步的仓库（或 DSH_GH_PLUGINS=逗号分隔）
          - dsh-feishu-cli-bridge
          - dsh-web-search-tavily
          - dsh-github-toolkit
```

包来源：本地 pnpm link / git clone（公开仓库），或 npm 发布后直接按包名装。

## 工具说明

| 工具 | 用途 | 关键参数 |
|---|---|---|
| gh_publish_plugin | 把一个插件目录发布/更新到 GitHub | plugin_dir(必填), repo_name?, description?, private?, commit_message? |
| gh_sync_plugins | 把 GitHub 上的插件装/同步到指定 DSH_HOME | dsh_home(必填), user? |
| gh_new_plugin | 生成一个新 dsh 插件骨架 | name(必填), dir? |

> 说明：新建 GitHub 仓库需要一次 PAT（DSH_GH_PAT）或网页 `https://github.com/new` 建空仓库；
> 之后的推送全部走 SSH 私钥（无 PAT）。云服务器拉公开仓库不需要任何认证。

## 依赖安装

`gh_sync_plugins` 只负责代码同步；插件若有 npm 依赖（如 feishu-bridge），在对应目录里装一次即可：

```bash
cd <DSH_HOME>/profiles/node_modules/<插件名> && pnpm install --prod
```
