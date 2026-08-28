#!/usr/bin/env bash
# Launch the dsh-feishu-cli-bridge PLUGIN inside the host profile:
#   dsh --profile feishu-bridge
# The bridge plugin boots in-process; it spawns the nested agent runtime
# profile (feishu-agent) on the first Feishu message.
set -euo pipefail

export DSH_HOME="${DSH_FEISHU_DSH_HOME:-/home/ubuntu/dsh/.dsh}"  # forced: ambient DSH_HOME may point elsewhere
# lark-cli keychain path is hardcoded to $HOME/.local/share/lark-cli.
export HOME="${DSH_FEISHU_CLI_HOME:-/home/ubuntu/dsh/.home}"
# lark-cli data/config go under the workspace so sandbox and systemd both work.
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/home/ubuntu/dsh/.xdg/config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/dsh/.xdg/data}"
# Host profile that runs the bridge plugin.
export DSH_FEISHU_HOST_PROFILE="${DSH_FEISHU_HOST_PROFILE:-feishu-bridge}"
# Nested agent runtime profile (spawned by the bridge via dsh-sdk-client).
export DSH_FEISHU_PROFILE="${DSH_FEISHU_PROFILE:-feishu-agent}"
export DSH_FEISHU_DSH_BIN="${DSH_FEISHU_DSH_BIN:-/usr/bin/dsh}"
export DSH_FEISHU_WORKSPACE="${DSH_FEISHU_WORKSPACE:-/home/ubuntu/dsh/feishu-workspace}"
export DSH_FEISHU_MEDIA_DIR="${DSH_FEISHU_MEDIA_DIR:-/home/ubuntu/dsh/feishu-media}"
export DSH_FEISHU_CLI_BIN="${DSH_FEISHU_CLI_BIN:-/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli}"
export DSH_FEISHU_PROVIDER="${DSH_FEISHU_PROVIDER:-opencode-go}"
export DSH_FEISHU_MODEL="${DSH_FEISHU_MODEL:-deepseek-v4-flash}"
export DSH_FEISHU_NOTIFY_PORT="${DSH_FEISHU_NOTIFY_PORT:-48680}"
export DSH_FEISHU_ACK="${DSH_FEISHU_ACK:-1}"

exec node "$DSH_FEISHU_DSH_BIN" --profile "$DSH_FEISHU_HOST_PROFILE" "$@"