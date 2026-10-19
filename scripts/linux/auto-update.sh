#!/usr/bin/env bash
# ClassPilot 服务器自动更新与守护（systemd 定时器每 3 分钟以 root 运行一次）：
#   1. 守护：配置到位但服务没在跑 → 拉起。app 目录有 disabled.flag 时不拉起。
#   2. 更新：GitHub main 有新提交、且 CI 已通过时：构建（含全部测试）→ 换上新版 → 重启 → 健康检查，失败回滚。
#      正在上课（有 3 小时内开始、还没下课的课）时不重启，等下课再更新。构建失败继续跑旧版，同一提交不再重试。
# 从不改动：config/、data/、logs/。
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"

exec 9>/run/classpilot-update.lock
flock -n 9 || exit 0

git_src() { sudo -u "$RUN_USER" -H git -C "$SRC_DIR" "$@"; }
service_ready() { [ -f "$CONFIG" ] && [ ! -f "$APP_DIR/disabled.flag" ]; }

# GitHub Actions 结果：success / failure / pending / unknown
ci_state() {
    local json
    json=$(curl -fsS -m 20 -H 'Accept: application/vnd.github+json' -H 'User-Agent: ClassPilot-AutoUpdate' "$REPO_API/commits/$1/check-runs" 2>/dev/null) || { echo unknown; return; }
    echo "$json" | jq -r '.check_runs |
        if length == 0 then "unknown"
        elif any(.status != "completed") then "pending"
        elif any(.conclusion != "success") then "failure"
        else "success" end' 2>/dev/null || echo unknown
}

watchdog() {
    service_ready || return 0
    if ! systemctl is-active --quiet classpilot.service; then
        log "服务没在运行，拉起"
        start_and_wait && log "已拉起" || log "拉起失败，见 logs/console.log"
    fi
}

update() {
    git_src fetch --quiet origin "$BRANCH" 2>>"$LOG_FILE" || { log "git fetch 失败"; return; }
    local latest current short subject
    latest=$(git_src rev-parse "origin/$BRANCH")
    current=$(read_text "$VERSION_FILE")
    [ "$latest" = "$current" ] && return
    [ "$latest" = "$(read_text "$FAILED_FILE")" ] && return
    short=${latest:0:7}
    case "$(ci_state "$latest")" in
        success) ;;
        failure) log "$short 的 CI 没通过，不安装"; echo "$latest" > "$FAILED_FILE"; return ;;
        *) return ;;
    esac
    if service_ready && class_in_progress; then return; fi
    subject=$(git_src log -1 --format=%s "$latest")
    log "发现新提交 ${short}：$subject"
    git_src checkout --quiet --force "$latest"
    if ! build_src > "$APP_DIR/logs/build.log" 2>&1; then
        log "$short 构建失败，继续运行旧版本"
        echo "$latest" > "$FAILED_FILE"
        return
    fi
    local scripts_changed=0
    diff -rq "$SRC_DIR/scripts/linux" "$APP_DIR/scripts/linux" >/dev/null 2>&1 || scripts_changed=1
    deploy_build
    echo "$latest" > "$VERSION_FILE"
    bash "$APP_DIR/scripts/linux/install.sh" --units   # 版本号写在单元里，每次更新都重写
    [ "$scripts_changed" -eq 1 ] && bash "$APP_DIR/scripts/linux/install.sh" --site >/dev/null 2>&1
    if ! service_ready; then
        log "已更新到 $short（配置未到位，服务未启动）"
        return
    fi
    if start_and_wait; then
        log "已更新到 $short"
    else
        log "$short 启动后健康检查没通过，回滚"
        rm -rf "$CUR" && mv "$PREV" "$CUR"
        echo "$latest" > "$FAILED_FILE"
        echo "$current" > "$VERSION_FILE"
        start_and_wait || log "回滚后也没能启动，见 logs/console.log"
    fi
}

watchdog
update
