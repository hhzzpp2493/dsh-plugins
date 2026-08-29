#!/usr/bin/env bash
# 一键把 dsh 插件从 GitHub 总库（dsh-plugins monorepo）安装/同步到 DSH_HOME。
# 用法: ./install-plugins-from-github.sh <DSH_HOME> <GITHUB_USER> [分支]
# 示例: ./install-plugins-from-github.sh /home/ubuntu/.dsh hhzzpp2493 main
# 重复运行 = git pull 拉取最新（两台机器代码同步）。
# 总库模式：所有插件在 dsh-plugins 的 plugins/<name> 子目录，一次拉取全部。
set -euo pipefail

DSH_HOME="${1:?用法: $0 <DSH_HOME> <GITHUB_USER> [分支]}"
GH_USER="${2:?用法: $0 <DSH_HOME> <GITHUB_USER> [分支]}"
BRANCH="${3:-main}"
MONOREPO="${MONOREPO:-dsh-plugins}"
FALLBACK="$DSH_HOME/profiles/node_modules"
SRC_ROOT="$DSH_HOME/profiles/.dsh-plugins-src"
REPO_DIR="$SRC_ROOT/$MONOREPO"

if ! command -v git >/dev/null; then echo "缺少 git，请先安装: apt install -y git"; exit 1; fi

# 连通性检查（用本机或目标机器的 SSH；公网 HTTPS 也可用则用 HTTPS）
if ! timeout 15 git ls-remote "https://github.com/$GH_USER/$MONOREPO.git" HEAD >/dev/null 2>&1; then
  echo "⚠️  无法访问 github.com（HTTPS），改用 SSH 探测..."
  if ! timeout 15 git ls-remote "git@github.com:$GH_USER/$MONOREPO.git" HEAD >/dev/null 2>&1; then
    echo "⚠️  SSH 也不可达。请检查网络/密钥。"
    exit 1
  fi
fi

mkdir -p "$SRC_ROOT"

# 克隆或拉取总库
if [ -d "$REPO_DIR/.git" ]; then
  echo ">> 同步总库 $MONOREPO ..."
  git -C "$REPO_DIR" fetch --quiet origin
  git -C "$REPO_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH" 2>/dev/null || true
  git -C "$REPO_DIR" pull --quiet --ff-only
else
  echo ">> 克隆总库 $MONOREPO ..."
  if ! git clone --quiet -b "$BRANCH" --depth 1 "git@github.com:$GH_USER/$MONOREPO.git" "$REPO_DIR"; then
    git clone --quiet -b "$BRANCH" --depth 1 "https://github.com/$GH_USER/$MONOREPO.git" "$REPO_DIR"
  fi
fi

mkdir -p "$FALLBACK"

# 把 plugins/ 下每个插件软链进 node_modules 回退目录
count=0
for d in "$REPO_DIR"/plugins/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  [ -f "$d/package.json" ] || continue
  ln -sfn "$d" "$FALLBACK/$name"
  echo "   ✓ $name"
  count=$((count + 1))
done

echo
echo "✅ 已同步 $count 个插件到 $FALLBACK（总库 $MONOREPO@$BRANCH）。"
echo "   接下来：把需要的插件注册到 profile（bundle 或 cordis.patch.yml insert），重启 dsh 生效。"
echo "   之后同步代码：重跑本脚本即可。"