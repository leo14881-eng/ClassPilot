#!/usr/bin/env bash
# ClassPilot 服务器（Ubuntu）共用设置和函数，被 install.sh / auto-update.sh / status.sh 引用。
# 从不输出 config/config.json 的内容（里面有口令和 API Key）。

APP_DIR=/opt/classpilot
SRC_DIR=/opt/classpilot-src
REPO_URL=https://github.com/leo14881-eng/ClassPilot.git
REPO_API=https://api.github.com/repos/leo14881-eng/ClassPilot
BRANCH=main
RUN_USER=classpilot
PORT_FILE="$APP_DIR/config/port"
PORT=$(cat "$PORT_FILE" 2>/dev/null || echo 8095)
BASE="http://127.0.0.1:$PORT"
DOMAIN_FILE="$APP_DIR/config/domain"
DOMAIN=$(cat "$DOMAIN_FILE" 2>/dev/null || echo 202-182-114-123.sslip.io)
CUR="$APP_DIR/app"
PREV="$APP_DIR/app.prev"
VERSION_FILE="$APP_DIR/version.txt"
FAILED_FILE="$APP_DIR/failed-commit.txt"
CONFIG="$APP_DIR/config/config.json"
DB="$APP_DIR/data/classpilot.db"
LOG_FILE="$APP_DIR/logs/auto-update.log"
NODE_MIN_MAJOR=22

log() {
    mkdir -p "$(dirname "$LOG_FILE")"
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

read_text() {
    [ -f "$1" ] && tr -d '\r\n ' < "$1" || true
}

healthy() {
    curl -fsS -m 10 -o /dev/null "$BASE/api/health" 2>/dev/null
}

# 有课正在进行（没下课，且最近 15 分钟还有声音或字幕进来）时不重启服务，避免打断上课。
# 忘了点"下课"的课不会一直挡住更新。
class_in_progress() {
    [ -f "$DB" ] || return 1
    local since n
    since=$(( ($(date +%s) - 15 * 60) * 1000 ))
    n=$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM sessions WHERE status = 'live' AND COALESCE(json_extract(json, '$.lastActivityAt'), started_at) > $since;" 2>/dev/null || echo 0)
    [ "${n:-0}" -gt 0 ]
}

# 构建：安装依赖、类型检查、全部测试、打包。限制内存，避免影响同机其他服务。
build_src() {
    sudo -u "$RUN_USER" -H bash -c "cd '$SRC_DIR' && export NODE_OPTIONS=--max-old-space-size=512 && npm install --no-audit --no-fund --loglevel=error && npm run check"
}

# 把构建结果换上去（保留上一版，用于回滚）
deploy_build() {
    rm -rf "$PREV"
    [ -d "$CUR" ] && mv "$CUR" "$PREV"
    mkdir -p "$CUR"
    cp -r "$SRC_DIR/dist" "$SRC_DIR/dist-server" "$CUR/"
    cp -r "$SRC_DIR/scripts/." "$APP_DIR/scripts/"
    chown -R "$RUN_USER:$RUN_USER" "$CUR" "$APP_DIR/scripts"
}

start_and_wait() {
    systemctl restart classpilot.service
    for _ in $(seq 1 20); do
        sleep 2
        healthy && return 0
    done
    return 1
}
