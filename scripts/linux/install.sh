#!/usr/bin/env bash
# ClassPilot 服务器一次性安装（Ubuntu 22.04 / 24.04，root 运行，可重复运行）。
# 这台服务器是几个项目共用的：不改动 TrendPilot / StockPilot 的目录、用户、端口和 systemd 单元。
#   1. 网络检查：OpenRouter、OpenAI、GitHub、Node 软件源。
#   2. Node.js 22（系统里已有 22 以上就不动）；Caddy（反向代理 + 免费 HTTPS，几个项目共用，只加自己的站点文件）。
#   3. 普通用户 classpilot；源码 /opt/classpilot-src，运行目录 /opt/classpilot。
#   4. 构建（含类型检查和全部测试），注册 systemd：
#        classpilot.service        服务本身，只监听 127.0.0.1，内存上限 400M。配置文件到位前不启动。
#        classpilot-update.timer   每 3 分钟 auto-update.sh：自动更新 + 守护。
#   5. Caddy 站点：https://<域名> → 127.0.0.1:<端口>；防火墙只放行 80/443（SSH 不动）。
# 用法：bash install.sh            完整安装
#       bash install.sh --check    只做网络检查
#       bash install.sh --units    只重新写 systemd 单元
#       bash install.sh --site     只重新写 Caddy 站点
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行"; exit 1; }

check_network() {
    local fail=0 code
    for item in \
        "OpenRouter|https://openrouter.ai/api/v1/models" \
        "OpenAI|https://api.openai.com/v1/models" \
        "GitHub|$REPO_API" \
        "Node 软件源|https://deb.nodesource.com/"; do
        local name=${item%%|*} url=${item#*|}
        code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$url" || echo 000)
        if [ "$code" = 000 ]; then echo "FAIL $name 连不上"; fail=1; else echo "OK   $name（HTTP $code）"; fi
    done
    return $fail
}

pick_port() {
    if [ -f "$PORT_FILE" ]; then return; fi
    local p
    for p in 8095 8096 8097 8098 8099; do
        if ! ss -ltn "( sport = :$p )" | grep -q ":$p"; then
            echo "$p" > "$PORT_FILE"
            PORT=$p
            BASE="http://127.0.0.1:$PORT"
            echo "使用端口 $p（只监听 127.0.0.1）"
            return
        fi
    done
    echo "8095-8099 都被占用了，停止安装"; exit 4
}

write_units() {
    local ver
    ver=$(cut -c1-7 "$VERSION_FILE" 2>/dev/null || echo dev)
    cat > /etc/systemd/system/classpilot.service <<EOF
[Unit]
Description=ClassPilot English class assistant
After=network-online.target
Wants=network-online.target
ConditionPathExists=$CONFIG
ConditionPathExists=!$APP_DIR/disabled.flag

[Service]
User=$RUN_USER
WorkingDirectory=$APP_DIR
Environment=CLASSPILOT_CONFIG=$CONFIG
Environment=CLASSPILOT_DATA=$APP_DIR/data
Environment=CLASSPILOT_STATIC=$CUR/dist
Environment=CLASSPILOT_PORT=$PORT
Environment=CLASSPILOT_VERSION=$ver
Environment=NODE_NO_WARNINGS=1
ExecStart=/usr/bin/node --max-old-space-size=256 $CUR/dist-server/server.mjs
Restart=always
RestartSec=10
MemoryMax=400M
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
StandardOutput=append:$APP_DIR/logs/console.log
StandardError=append:$APP_DIR/logs/console.log

[Install]
WantedBy=multi-user.target
EOF
    cat > /etc/systemd/system/classpilot-update.service <<EOF
[Unit]
Description=ClassPilot auto update and watchdog

[Service]
Type=oneshot
ExecStart=/bin/bash $APP_DIR/scripts/linux/auto-update.sh
TimeoutStartSec=1800
EOF
    cat > /etc/systemd/system/classpilot-update.timer <<EOF
[Unit]
Description=Run ClassPilot auto update every 3 minutes

[Timer]
OnBootSec=2min
OnUnitInactiveSec=3min

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable classpilot.service classpilot-update.timer >/dev/null 2>&1
    systemctl start classpilot-update.timer
}

install_node() {
    local major=0
    command -v node >/dev/null && major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "$major" -ge "$NODE_MIN_MAJOR" ]; then
        echo "已有 Node.js $(node -v)，不改动"
        return
    fi
    if [ "$major" -gt 0 ]; then
        echo "系统里已有 Node.js $(node -v)，版本太低。检查是否有其他服务在用："
        if systemctl list-units --type=service --state=running --no-legend | grep -v classpilot | awk '{print $1}' | xargs -r systemctl show -p ExecStart --value 2>/dev/null | grep -q node; then
            echo "有其他服务在用 Node.js，为避免影响它们，停止安装。请人工确认后再升级。"; exit 5
        fi
    fi
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
    echo "已安装 Node.js $(node -v)"
}

install_caddy() {
    if command -v caddy >/dev/null; then
        echo "已有 Caddy $(caddy version | cut -d' ' -f1)，只添加 ClassPilot 自己的站点文件"
        return
    fi
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
    echo "已安装 Caddy"
}

write_site() {
    mkdir -p /etc/caddy/sites
    cat > /etc/caddy/sites/classpilot.caddy <<EOF
# ClassPilot（由 /opt/classpilot/scripts/linux/install.sh 生成；其他项目请写自己的文件）
$DOMAIN {
    encode gzip
    request_body {
        max_size 50MB
    }
    reverse_proxy 127.0.0.1:$PORT
}
EOF
    local cf=/etc/caddy/Caddyfile
    if [ ! -f "$cf" ] || grep -q '/usr/share/caddy' "$cf"; then
        # 安装包自带的示例 Caddyfile：换成只引用各项目站点文件
        [ -f "$cf" ] && cp "$cf" "$cf.bak-$(date +%Y%m%d%H%M%S)"
        printf '# 每个项目在 /etc/caddy/sites/ 下写自己的站点文件\nimport sites/*.caddy\n' > "$cf"
    elif ! grep -q 'import sites/\*\.caddy' "$cf"; then
        printf '\nimport sites/*.caddy\n' >> "$cf"
    fi
    caddy validate --config "$cf" --adapter caddyfile >/dev/null 2>&1 || { echo "Caddy 配置校验失败，没有重载"; caddy validate --config "$cf" --adapter caddyfile 2>&1 | tail -5; exit 6; }
    systemctl enable caddy >/dev/null 2>&1
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    echo "Caddy 站点：https://$DOMAIN"
}

open_firewall() {
    if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
        ufw status | grep -qE '^(22|OpenSSH)' || ufw allow OpenSSH >/dev/null
        ufw allow 80/tcp >/dev/null
        ufw allow 443/tcp >/dev/null
        echo "系统防火墙已放行 80/443"
    else
        echo "系统防火墙（ufw）未启用，不改动"
    fi
    echo "注意：如果 Vultr 控制台开了云防火墙，也要放行 80 和 443"
}

case "${1:-}" in
    --check) check_network; exit $? ;;
    --units) write_units; exit 0 ;;
    --site) write_site; exit 0 ;;
esac

echo "== 内存（安装前）"; free -m | awk 'NR==2{print "已用 "$3"M / "$2"M"}'

echo "== 1/6 网络检查"
check_network || { echo "网络不通，停止安装"; exit 2; }

echo "== 2/6 安装 Node.js、Caddy 等"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git jq sqlite3 curl ca-certificates >/dev/null
install_node
install_caddy

echo "== 3/6 用户和目录"
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$RUN_USER"
mkdir -p "$APP_DIR/config" "$APP_DIR/data" "$APP_DIR/logs" "$APP_DIR/scripts"
pick_port
mkdir -p "$SRC_DIR" && chown "$RUN_USER:$RUN_USER" "$SRC_DIR"
if [ ! -d "$SRC_DIR/.git" ]; then
    sudo -u "$RUN_USER" -H git clone --quiet --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
else
    sudo -u "$RUN_USER" -H git -C "$SRC_DIR" fetch --quiet origin "$BRANCH"
    sudo -u "$RUN_USER" -H git -C "$SRC_DIR" checkout --quiet --force "origin/$BRANCH"
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
chmod 700 "$APP_DIR/config"

echo "== 4/6 构建（含全部测试）"
build_src > "$APP_DIR/logs/build.log" 2>&1 || { echo "构建失败，见 $APP_DIR/logs/build.log"; tail -20 "$APP_DIR/logs/build.log"; exit 3; }
deploy_build
sudo -u "$RUN_USER" -H git -C "$SRC_DIR" rev-parse HEAD > "$VERSION_FILE"

echo "== 5/6 注册 systemd"
write_units

echo "== 6/6 HTTPS 和防火墙"
write_site
open_firewall

log "安装完成：$(cut -c1-7 "$VERSION_FILE")"
if [ -f "$CONFIG" ]; then
    if start_and_wait; then echo "安装完成，服务已启动：https://$DOMAIN"; else echo "服务没有正常启动，见 $APP_DIR/logs/console.log"; tail -20 "$APP_DIR/logs/console.log"; fi
else
    echo "安装完成。上传配置文件（口令和 API Key）到 $CONFIG 后服务会启动。"
fi
echo "== 内存（安装后）"; free -m | awk 'NR==2{print "已用 "$3"M / "$2"M"}'
