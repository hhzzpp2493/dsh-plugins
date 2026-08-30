# dsh-maintain

给 agent 一双"看得见、够得着维护流程"的手：在 web 界面里直接查看/触发 dsh 双端维护，不必手动跑脚本。

底层复用 `dsh-maintain.sh`（拉总库 → 同步飞书插件部署副本 → 检查 dsh 核心 → 有变更重启 web → 健康检查），本插件只是把它注册成 agent 工具。**零 dsh 内部依赖**（只用 Node 内置），可用软链安装。

## 工具

| 工具 | 作用 |
|---|---|
| `maintain_status` | 双端维护状态：总库 commit、飞书插件 总库↔部署 是否一致、web 存活、lark consumer 数、cron 是否注册、维护日志最近记录；云上（经 ssh 尽力探测：commit / consumer / web） |
| `maintain_now` | 立即执行一次完整维护（最长约 2 分钟；**有变更会重启 web，短暂断连**） |
| `maintain_log` | 读维护日志最近 N 行（默认 30，最大 200） |

## 安装

1. 放进 `$DSH_HOME/profiles/node_modules/dsh-maintain/`（本插件无第三方依赖，`ln -s` 软链也适用，如指向总库 checkout）。
2. web profile `cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-maintain
      name: 'dsh-maintain'
      config:
        maintainScript: /home/<you>/deepseek/dsh-maintain.sh
        maintainLog: /home/<you>/.dsh/storages/dsh-maintain.log
        repoRoot: /home/<you>/deepseek/dsh-plugins
        repoPlugin: /home/<you>/deepseek/dsh-plugins/plugins/dsh-feishu-web-bridge
        dstPlugin: /home/<you>/.dsh/profiles/node_modules/dsh-feishu-web-bridge
        webUrl: http://127.0.0.1:3080/
        # 云上探测（可选；host 留空则跳过）
        cloudHost: 1.14.169.244
        cloudUser: ubuntu
        cloudKey: /home/<you>/deepseek/server-key.pem
        cloudRepoPlugin: /home/ubuntu/.dsh/profiles/.dsh-plugins-src/dsh-plugins/plugins/dsh-feishu-web-bridge
        cloudWebUrl: http://127.0.0.1:38670/
```

3. 重启 web 后，在任意会话里让 agent 调用即可（例如："查一下插件两边是否一致" → `maintain_status`）。

## 注意

- 云上探测通过 SSH（BatchMode，密钥路径可配）；网络/密钥不可达时仅提示跳过，不影响本地状态。
- `maintain_now` 会触发 web 重启（有变更时）——agent 使用前建议先 `maintain_status` 确认。
- 定时维护仍由 crontab（每天 03:37）无人值守执行，本插件只是加一层主动控制。