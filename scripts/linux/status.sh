#!/usr/bin/env bash
# 服务器状态：服务、版本、健康、资源、最近日志（不输出配置内容）
# shellcheck source=common.sh
. "$(cd "$(dirname "$0")" && pwd)/common.sh"
echo "主机 $(hostname)  时间 $(date '+%F %T %Z')  $(uptime -p)"
echo "版本 $(cut -c1-7 "$VERSION_FILE" 2>/dev/null)  配置$([ -f "$CONFIG" ] && echo 已到位 || echo 未到位)  端口 $PORT  网址 https://$DOMAIN$([ -f "$APP_DIR/disabled.flag" ] && echo '  已停用')"
echo "服务 $(systemctl is-active classpilot.service)  自动更新 $(systemctl is-active classpilot-update.timer)  Caddy $(systemctl is-active caddy 2>/dev/null)"
echo "健康 $(curl -fsS -m 10 "$BASE/api/health" 2>/dev/null | head -c 300)"
echo "外网 HTTPS $(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/health" 2>/dev/null)"
free -m | awk 'NR==2{print "内存已用 "$3"M / "$2"M"}'
echo "ClassPilot 进程内存 $(systemctl show -p MemoryCurrent --value classpilot.service 2>/dev/null | awk '{ if ($1 ~ /^[0-9]+$/) printf "%dM", $1/1048576; else print $1 }')"
df -h / | awk 'NR==2{print "硬盘已用 "$3" / "$2}'
echo "录音占用 $(du -sh "$APP_DIR/data/audio" 2>/dev/null | cut -f1)"
if [ -f "$DB" ]; then
    echo "--- 最近的课"
    sqlite3 -readonly -separator ' | ' "$DB" "SELECT datetime(started_at/1000,'unixepoch','localtime'), json_extract(json,'$.school'), json_extract(json,'$.topic'), status, IFNULL(json_extract(json,'$.statusNote'),'') FROM sessions ORDER BY started_at DESC LIMIT 6;" 2>&1
    echo "复习词库 $(sqlite3 -readonly "$DB" "SELECT COUNT(*) || ' 条，已掌握 ' || IFNULL(SUM(mastered),0) FROM items;" 2>/dev/null)"
fi
echo "--- auto-update.log"
tail -n 8 "$LOG_FILE" 2>/dev/null
echo "--- console.log 最近错误"
grep -E 'error|Error|\[http\]|\[config\]' "$APP_DIR/logs/console.log" 2>/dev/null | tail -n 8 | cut -c1-220
