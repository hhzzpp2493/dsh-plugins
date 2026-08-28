#!/usr/bin/env bash
# Run AFTER config init + auth login: verify everything is ready to launch.
set -uo pipefail
export HOME="${HOME:-/home/ubuntu/dsh/.home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/home/ubuntu/dsh/.xdg/config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/dsh/.xdg/data}"
LC=/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli
echo "=== 1. config ==="; "$LC" config show 2>&1 | head -8
echo "=== 2. auth status ==="; "$LC" auth status 2>&1 | head -12
echo "=== 3. event keys (im domain) ==="; "$LC" event list --domain im --json 2>&1 | head -15
echo "=== 4. dry-run send (chat-id needed later) ==="; "$LC" im +messages-send --help >/dev/null 2>&1 && echo "im +messages-send OK"
echo "=== 5. drive search dry check ==="; "$LC" drive +search --help >/dev/null 2>&1 && echo "drive +search OK"
