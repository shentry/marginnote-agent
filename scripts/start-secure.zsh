#!/bin/zsh

set -euo pipefail

task_script_dir=${0:A:h}
task_project_dir=${task_script_dir:h}
cd "$task_project_dir"

read -rs "MN_AGENT_API_KEY?模型 API Key: "
print

export MN_AGENT_API_KEY

task_host_pid=$(lsof -nP -iTCP:42117 -sTCP:LISTEN -t | head -n 1 || true)
if [[ -n "$task_host_pid" ]]; then
  task_host_cwd=$(lsof -a -p "$task_host_pid" -d cwd -Fn | sed -n 's/^n//p')
  task_host_command=$(ps -p "$task_host_pid" -o command= | sed 's/^ *//')
  if [[ "$task_host_cwd" != "$task_project_dir" || "$task_host_command" != "node host/src/main.mjs" ]]; then
    print -u2 "端口 42117 被其他进程占用，未停止该进程。"
    exit 1
  fi
  kill -TERM "$task_host_pid"
  for task_wait_index in {1..50}; do
    if ! kill -0 "$task_host_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
fi

exec npm start
