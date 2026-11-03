#!/bin/bash
# Admin tool, no sudo, systemd, global Docker prune, or changes to other stacks.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
action=${1:-check}
config=${2:-images.conf}
[[ "$config" =~ ^[A-Za-z0-9_-]+\.conf$ ]] || { echo 'Use a reviewed local images*.conf filename' >&2; exit 1; }
compose=(docker compose --env-file "$config" -f compose.json)
verify() {
 local context
 "${compose[@]}" config --quiet
 context=$("${compose[@]}" config --format json | python3 -c 'import json,sys;print(json.load(sys.stdin)["services"]["backend"]["build"]["context"])')
 (cd -- "$(dirname -- "$context")" && sha256sum --check --status source.sha256)
 sha256sum --check --status catalogues.sha256 deployment.sha256
}
reserve() {
 local disk mem
 disk=$(df -B1 --output=avail . | tail -n1)
 mem=$(awk '/^MemAvailable:/ {print $2*1024}' /proc/meminfo)
 awk -v d="$disk" -v m="$mem" -v extra="${1:-0}" 'BEGIN {exit !(d >= (20.25+extra)*1073741824 && m >= 2.25*1073741824)}' || { echo 'Stopped: disk/RAM safety reserve' >&2; return 1; }
}
case "$action" in
 check)
  reserve
  verify
  docker network inspect net --format '{{.Name}}'
  ;;
 build)
  reserve 4
  verify
  # Separate invocations prevent simultaneous frontend/backend builds.
  for service in backend frontend; do
   "${compose[@]}" build "$service" & job=$!
   while kill -0 "$job" 2>/dev/null; do
    if ! reserve; then kill -INT "$job" 2>/dev/null || true; wait "$job" || true; exit 1; fi
    sleep 3
   done
   wait "$job"
  done
  ;;
 initialize)
  reserve
  verify
  "${compose[@]}" run --rm --no-deps initialize
  ;;
 start)
  reserve
  verify
  "${compose[@]}" up -d --no-build backend frontend
  ;;
 stop) "${compose[@]}" stop frontend backend ;;
 status) "${compose[@]}" ps ;;
 logs) "${compose[@]}" logs --tail=100 backend frontend ;;
 backup)
  reserve
  umask 077
  mkdir -p backups
  file=$(mktemp "backups/data-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.partial")
  running=$("${compose[@]}" ps --status running -q backend)
  resume(){ if [[ -n "$running" ]]; then "${compose[@]}" start backend >&2; fi; }
  trap resume EXIT
  "${compose[@]}" stop backend
  estimate=$("${compose[@]}" run --rm --no-deps -T backup --estimate)
  [[ "$estimate" =~ ^[0-9]+$ ]] || { echo 'Invalid backup size estimate' >&2; exit 1; }
  reserve "$(awk -v b="$estimate" 'BEGIN {print b/1073741824}')"
  "${compose[@]}" run --rm --no-deps -T backup > "$file" & job=$!
  while kill -0 "$job" 2>/dev/null; do
   if ! reserve; then kill -TERM "$job" 2>/dev/null || true; wait "$job" || true; exit 1; fi
   sleep 3
  done
  wait "$job"
  gzip -t "$file"
  final=${file%.partial}.tar.gz
  mv -- "$file" "$final"
  sha256sum "$final" > "$final.sha256"
  echo "Verified private backup: $final"
  ;;
 *) echo 'Usage: ./manage.sh check|build|initialize|start|stop|status|logs|backup [images.conf]' >&2; exit 1 ;;
esac
