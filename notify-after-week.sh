#!/usr/bin/env bash
# One-week verification complete notification → sent into the Feishu bot chat.
# Reused by both the systemd timer (authoritative) and any manual run.
set -uo pipefail

export HOME="${HOME:-/home/ubuntu/dsh/.home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/home/ubuntu/dsh/.xdg/config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/dsh/.xdg/data}"
export DSH_FEISHU_CLI_BIN="${DSH_FEISHU_CLI_BIN:-/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli}"
CHAT_ID="${DSH_FEISHU_NOTIFY_CHAT_ID:-oc_3af6a0d67edc3161e03184cc047bbc06}"
LOG="/home/ubuntu/dsh/feishu-bridge/logs/notify.log"
mkdir -p "$(dirname "$LOG")"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(stamp) $*" >> "$LOG"; }

# Bridge service health (best effort).
BRIDGE_ACTIVE="unknown"
if command -v systemctl >/dev/null 2>&1; then
  BRIDGE_ACTIVE=$(systemctl is-active dsh-feishu-cli-bridge.service 2>/dev/null || echo "unknown")
fi

# Uptime of the bridge unit (best effort).
UPTIME="unknown"
BRIDGE_PID=$(systemctl show -p MainPID --value dsh-feishu-cli-bridge.service 2>/dev/null || echo "")
if [ -n "${BRIDGE_PID:-}" ] && [ "$BRIDGE_PID" != "0" ]; then
  UPTIME=$(ps -o etime= -p "$BRIDGE_PID" 2>/dev/null | tr -d ' ' || echo "unknown")
fi

# Feishu events received during the whole week (best effort).
EVENTS="unknown"
if "$DSH_FEISHU_CLI_BIN" event status --json >/dev/null 2>&1; then
  EVENTS=$("$DSH_FEISHU_CLI_BIN" event status --json 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    total = 0
    apps = d.get('apps') or []
    for a in apps:
        for c in (a.get('consumers') or []):
            total += int(c.get('received', 0) or 0)
    print(total)
except Exception:
    print('unknown')
")
fi

MSG="【一周验证完成】dsh-feishu-cli-bridge 已持续运行 7 天 ✅

- 桥服务状态: ${BRIDGE_ACTIVE}
- 进程已运行: ${UPTIME}
- 飞书事件累计接收: ${EVENTS}

如需继续使用，组件均正常运行；有任何问题可查看日志：
journalctl -u dsh-feishu-cli-bridge --no-pager -n 50"

log "sending weekly notify to $CHAT_ID (active=$BRIDGE_ACTIVE uptime=$UPTIME events=$EVENTS)"

if HOME="$HOME" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" XDG_DATA_HOME="$XDG_DATA_HOME" \
   "$DSH_FEISHU_CLI_BIN" im +messages-send --chat-id "$CHAT_ID" --text "$MSG" --as bot \
   >/dev/null 2>>"$LOG"; then
  log "notify sent OK"
else
  log "notify send FAILED"
  exit 1
fi

# The notification is one-shot: stop & disable the timer after firing.
if command -v systemctl >/dev/null 2>&1; then
  systemctl stop feishu-notify.timer 2>/dev/null || true
  systemctl disable feishu-notify.timer 2>/dev/null || true
fi
exit 0