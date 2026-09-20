#!/bin/bash
# NovelForge macOS 构建验收辅助函数（由 .github/workflows/build-mac.yml source）
# 注意：本文件被 CI source 使用，不要 set -e，由调用方控制。

# 后端进程/端口约定
NF_BACKEND_PATTERN="NovelForgeBackend"

port_is_busy() { curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; }

wait_health() {
  local timeout="${1:-120}"
  local deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# 每个测试开始前必须确认端口空闲，否则无法区分是"新进程起来了"还是"旧进程还在响应"
assert_port_free() {
  if port_is_busy; then
    echo "::error::前置条件失败：54321 端口已有后端在运行，测试无法区分新旧进程"
    return 1
  fi
  echo "  前置条件 ok：54321 端口空闲"
  return 0
}

cleanup_novelforge() {
  pkill -f "$NF_BACKEND_PATTERN" >/dev/null 2>&1 || true
  pkill -f "NovelForge.app/Contents/MacOS/NovelForge" >/dev/null 2>&1 || true
  local i=0
  while [ "$i" -lt 20 ]; do
    port_is_busy || break
    sleep 1
    i=$((i + 1))
  done
  return 0
}

app_process_alive() {
  pgrep -f "$1/Contents/MacOS/NovelForge" >/dev/null 2>&1
}

# 启动 App：优先走 LaunchServices（与 Finder 双击同一条路）。
# 若 CI 环境没有可用 GUI 会话导致 open 拉不起来，则回退为直接执行主程序，
# 并打印警告——两条路都能验证"包本身能否运行"，区别只在是否经过系统启动服务。
# 用法：launch_app "<app 路径>" [等待主进程出现的秒数]
launch_app() {
  local app="$1" timeout="${2:-20}" i=0
  if open "$app" 2>"$RUNNER_TEMP/open-err.txt"; then
    while [ "$i" -lt "$timeout" ]; do
      if app_process_alive "$app"; then echo "  启动方式：LaunchServices (open)"; return 0; fi
      sleep 1; i=$((i + 1))
    done
  fi
  echo "::warning::open 未能在 ${timeout}s 内拉起主进程，回退为直接执行主程序（通常是 CI 无 GUI 会话所致）"
  cat "$RUNNER_TEMP/open-err.txt" 2>/dev/null || true
  "$app/Contents/MacOS/NovelForge" > "$RUNNER_TEMP/direct-launch.log" 2>&1 &
  i=0
  while [ "$i" -lt "$timeout" ]; do
    if app_process_alive "$app"; then echo "  启动方式：直接执行主程序（回退，未经过 LaunchServices）"; return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

tail_backend_log() {
  local log="$HOME/Library/Application Support/NovelForge/backend.log"
  if [ -f "$log" ]; then tail -n 150 "$log"; else echo "(没有 backend.log)"; fi
}
