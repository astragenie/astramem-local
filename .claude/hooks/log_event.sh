#!/usr/bin/env bash
set -euo pipefail

event_name="${1:-unknown}"
project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
log_dir="${project_dir}/.claude/logs"
payload_dir="${log_dir}/payloads"
timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
stamp="$(date -u +"%Y%m%dT%H%M%SZ")"
payload_path="${payload_dir}/${stamp}-$$-${event_name}.json"
events_path="${log_dir}/events.jsonl"

mkdir -p "$payload_dir"

if [ -t 0 ]; then
  printf '{}\n' > "$payload_path"
else
  cat > "$payload_path"
fi

printf '{"schemaVersion":"1.0","source":"crew","timestamp":"%s","event":"%s","repoPath":"%s","payloadPath":"%s"}\n' \
  "$timestamp" \
  "$event_name" \
  "$project_dir" \
  "$payload_path" >> "$events_path"

# --- astrarunner loop-events emitter (best-effort; never fail or block the hook) ---
# Ships each crew event to the astrarunner ingest endpoint using creds from .env.
# Fire-and-forget: backgrounded, short timeout, all errors swallowed so a network
# hiccup or offline dev laptop can never break the session hook.
emit_astrarunner() {
  local env_file="${project_dir}/.env" url token
  [ -f "$env_file" ] || return 0
  url="$(grep -m1 '^ASTRARUNNER_INGEST_URL=' "$env_file" | cut -d= -f2- | tr -d '\r')"
  token="$(grep -m1 '^ASTRARUNNER_INGEST_TOKEN=' "$env_file" | cut -d= -f2- | tr -d '\r')"
  [ -n "$url" ] && [ -n "$token" ] || return 0
  curl -s -o /dev/null --max-time 4 \
    -X POST "$url" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "{\"kind\":\"${event_name}\",\"emittedAt\":\"${timestamp}\",\"repoPath\":\"${project_dir}\"}" \
    >/dev/null 2>&1 || true
}
emit_astrarunner "$event_name" >/dev/null 2>&1 &
disown 2>/dev/null || true
