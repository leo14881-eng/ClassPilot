#!/usr/bin/env bash
# Read-only disk report for the shared server (fixed maintenance action "disk-report"): who is filling the disk.
# Changes nothing. Safe to run when the disk is full (writes nothing to disk).
export LC_ALL=C
echo "### df"; df -h / ; df -i / | tail -1
echo; echo "### top writers over 20 s (bytes written, from /proc/<pid>/io)"
declare -A A
for d in /proc/[0-9]*; do p=${d#/proc/}; w=$(awk '/^write_bytes/{print $2}' $d/io 2>/dev/null); [ -n "$w" ] && A[$p]=$w; done
sleep 20
for p in "${!A[@]}"; do w=$(awk '/^write_bytes/{print $2}' /proc/$p/io 2>/dev/null); [ -n "$w" ] || continue; dlt=$((w - ${A[$p]})); [ $dlt -gt 1048576 ] && printf '%10d MB/20s pid %-7s %s | unit=%s\n' $((dlt/1048576)) $p "$(tr '\0' ' ' </proc/$p/cmdline | cut -c1-150)" "$(grep -o '[^/]*\.service' /proc/$p/cgroup 2>/dev/null | head -1)"; done | sort -rn | head -15
echo; echo "### directory growth over 30 s (KB)"
DIRS="/var/lib/stock-shadow /var/lib/private /opt/stock-shadow /opt/shadow-runner /tmp /var/log /opt/classpilot /opt/trendpilot /root /home /var/tmp"
du -xsk $DIRS 2>/dev/null > /dev/shm/du1 || du -xsk $DIRS 2>/dev/null
sleep 30
du -xsk $DIRS 2>/dev/null | while read s p; do o=$(awk -v p="$p" '$2==p{print $1}' /dev/shm/du1 2>/dev/null); printf '%10s KB  %+10d KB  %s\n' "$s" "$(( s - ${o:-$s} ))" "$p"; done
rm -f /dev/shm/du1
echo; echo "### files changed in the last 10 min, >20 MB"
find / -xdev -type f -mmin -10 -size +20M -printf '%s\t%TT\t%p\n' 2>/dev/null | sort -n | tail -20
echo; echo "### deleted files still held open (>10 MB)"
for f in /proc/[0-9]*/fd/*; do l=$(readlink "$f" 2>/dev/null) || continue; case "$l" in *'(deleted)') s=$(stat -Lc %s "$f" 2>/dev/null); [ "${s:-0}" -gt 10000000 ] && echo "$s pid ${f#/proc/} $l";; esac; done 2>/dev/null | sort -rn | head -15
echo; echo "### biggest dirs in /var/lib/private, /tmp, /var/lib/stock-shadow, /opt/stock-shadow, /opt/shadow-runner"
du -xh --max-depth=2 /var/lib/private /tmp /var/lib/stock-shadow /opt/stock-shadow /opt/shadow-runner 2>/dev/null | sort -h | tail -40
echo; echo "### journald"; journalctl --disk-usage 2>/dev/null; grep -E '^\s*SystemMaxUse' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/* 2>/dev/null
echo; echo "### services and timers"
systemctl list-units --type=service --state=running --no-pager --no-legend | grep -i -E "shadow|stock|trend|monitor|grid|btc|runner|classpilot"
systemctl list-timers --all --no-pager --no-legend | grep -i -E "shadow|stock|monitor|grid|btc|runner|preflight"
echo; echo "### cron"; crontab -l 2>/dev/null; ls -la /etc/cron.d 2>/dev/null
echo; echo "### done"
