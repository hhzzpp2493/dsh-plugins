# dsh-cloud-server

把「连接云服务器」封装成 dsh 工具：随时通过对话直接远程运维云服务器上的 dsh，不再手动 SSH。

## 工具

| 工具 | 说明 |
|---|---|
| `cloud_ssh command=<shell>` | 在云服务器上执行任意 shell 命令，返回 stdout/stderr/退出码 |
| `cloud_status [web_url] [web_user] [web_pass]` | 一键检查 dsh web / nginx / 飞书桥 / relay 是否在跑、公网 web 是否可访问、磁盘/内存占用 |

## 安装方式（二选一）

### A. bundle 方式（推荐，profile 启动即加载）

在 profile 的 `package.json` 的 `dsh.profile.bundles` 加 `"dsh-cloud-server"`；
本插件自带的 `bundle.patch.yml` 会自动注册两个工具，连接参数在插件的 config 里配：

```yaml
- insert:
    - id: dsh-cloud-server
      name: 'dsh-cloud-server'
      config:
        host: 1.14.169.244               # 你的云服务器地址
        user: ubuntu                     # SSH 用户名（缺省 ubuntu）
        port: 22                         # SSH 端口（缺省 22）
        keyPath: /home/hzp/deepseek/server-key.pem   # SSH 私钥路径
```

### B. 直接 insert（不进 bundles）

在 profile 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: dsh-cloud-server
      name: 'dsh-cloud-server/tools'
      config:
        host: 1.14.169.244
        keyPath: /home/hzp/deepseek/server-key.pem
```

### 环境变量兜底（不配 config 时生效）

- `DSH_CLOUD_HOST` 云服务器地址
- `DSH_CLOUD_USER` SSH 用户名（缺省 ubuntu）
- `DSH_CLOUD_PORT` SSH 端口（缺省 22）
- `DSH_CLOUD_KEY` SSH 私钥路径（缺省 `~/.ssh/id_ed25519_dsh`）

## 使用示例

对 agent 说：

- 「用 cloud_ssh 看看云服务器 dsh 服务状态」→ `cloud_ssh command='systemctl status dsh --no-pager | head -20'`
- 「检查云服务器 dsh 是否健康」→ `cloud_status web_url=https://1.14.169.244:38669 web_user=dsh web_pass=<密码>`
- 「重启云服务器的飞书桥」→ `cloud_ssh command='sudo systemctl restart dsh-feishu-cli-bridge'`

## 安全说明

- 私钥不打包进插件（.gitignore 已排除 *.pem/*.key），每台机器通过 config 或环境变量各自指定。
- 命令以 SSH 用户的权限执行；需要 root 的操作请自行加 `sudo`。
- 云服务器上建议保持默认仅密钥登录。