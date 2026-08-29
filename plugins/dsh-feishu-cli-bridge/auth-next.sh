#!/usr/bin/env bash
# After `config init` completes: request scope authorization (im/drive/event/docs).
set -euo pipefail
export HOME="${HOME:-/home/ubuntu/dsh/.home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/home/ubuntu/dsh/.xdg/config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/home/ubuntu/dsh/.xdg/data}"
LC=/home/ubuntu/dsh/.lark-cli/node_modules/.bin/lark-cli
echo "--- auth status ---"
"$LC" auth status 2>&1 | head -5
echo "--- requesting scopes (im,drive,event,docs) ---"
"$LC" auth login --domain im,drive,event,docs --no-wait --json 2>&1 | head -40
echo
echo ">>> 把上面的 verification_url 发给用户，引导其浏览器打开并授权；"
echo ">>> 用户完成后运行: lark-cli auth login --device-code <DEVICE_CODE>"
