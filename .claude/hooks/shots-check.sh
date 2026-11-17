#!/usr/bin/env bash
# Stop hook: when src/ or the shot fixtures changed, rebuild and name README screenshots whose terminal
# output changed (scripts/shots.mjs check). Fires once per session.
set -uo pipefail

payload="$(cat 2>/dev/null || true)"
session="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null || true)"

root="${CLAUDE_PROJECT_DIR:-}"
[ -n "$root" ] || root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$root" ] || exit 0
cd "$root" || exit 0
[ -f scripts/shots.mjs ] || exit 0

marker_dir="${TMPDIR:-/tmp}/cc-spend-shots"
marker="$marker_dir/${session:-nosession}"
mkdir -p "$marker_dir" 2>/dev/null || true
[ -e "$marker" ] && exit 0

base="$(git rev-parse --verify --quiet origin/main || git rev-parse --verify --quiet main || echo HEAD)"
changed="$({
  git diff --name-only "$base...HEAD"
  git diff --name-only HEAD
  git ls-files --others --exclude-standard
} 2>/dev/null)"
printf '%s\n' "$changed" | grep -qE '^(src/|scripts/shots)' || exit 0

node_modules/.bin/tsc -p tsconfig.build.json >/dev/null 2>&1 || exit 0
stale="$(node scripts/shots.mjs check 2>&1)" && exit 0

: > "$marker" 2>/dev/null || true
{
  echo "$stale"
  echo
  echo "The terminal output of a README screenshot changed. If the change is intended, re-take it (pnpm shots <name>) and look at the new image. This fires once per session."
} >&2
exit 2
