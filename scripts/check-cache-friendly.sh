#!/usr/bin/env bash
# check-cache-friendly.sh — scan any CLI agent's config for KV-cache-busting patterns
# Usage: ./check-cache-friendly.sh [file]        (default: CLAUDE.md)
#        ./check-cache-friendly.sh --opencode     (scan opencode config)
#        ./check-cache-friendly.sh --all          (scan all known configs)
set -euo pipefail

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

warn()  { echo -e "${YELLOW}⚠️  $1${NC}"; }
good()  { echo -e "${GREEN}✅ $1${NC}"; }
bad()   { echo -e "${RED}❌ $1${NC}"; }

check_file() {
  local file="$1"
  local label="${2:-$file}"
  if [[ ! -f "$file" ]]; then
    echo "   (file not found: $file)"
    return
  fi

  echo ""
  echo "─── $label ───"
  local issues=0

  # 1. Date stamps in first 10 lines
  if head -10 "$file" | grep -qP '\d{4}-\d{2}-\d{2}'; then
    warn "Date stamp in first 10 lines → move to file end for cache stability"
    ((issues++))
  fi

  # 2. Session IDs
  if grep -qP 'ses_[a-z0-9]{8,}' "$file" 2>/dev/null; then
    warn "Session ID patterns found → these change every session"
    ((issues++))
  fi

  # 3. Dynamic file references (but NOT npm package names)
  if grep -qP '@remember\b|\.remember/|memory-dream(?!@)' "$file" 2>/dev/null; then
    warn "Dynamic file/memory references → content changes between sessions"
    ((issues++))
  fi

  # 4. Very short first line (often a date or status) — text files only
  #    Skip JSON/YAML config files and markdown section headers (## / #)
  local first_line
  first_line=$(head -1 "$file")
  if [[ ! "$file" =~ \.(json|yaml|yml|toml|lock)$ ]]; then
    if [[ ${#first_line} -lt 30 && ! "$first_line" =~ ^#+\  ]]; then
      warn "Very short first line (${#first_line} chars): '$first_line'"
      ((issues++))
    fi
  fi

  # 5. File volatility check
  local size lines mtime
  size=$(wc -c < "$file" | tr -d ' ')
  lines=$(wc -l < "$file" | tr -d ' ')
  mtime=$(stat -c %Y "$file" 2>/dev/null || echo 0)
  local now
  now=$(date +%s)
  local age_hrs=$(( (now - mtime) / 3600 ))

  echo "   Size: ${size}B, Lines: ${lines}, Age: ${age_hrs}h"

  if [[ $issues -eq 0 ]]; then
    good "No cache-busting patterns detected"
  fi
}

check_opencode() {
  local config_dir="${HOME}/.config/opencode"
  echo ""
  echo "══════════ OpenCode Config ══════════"

  # Main config
  check_file "$config_dir/opencode.json" "opencode.json"

  # Append files
  for f in "$config_dir"/oh-my-opencode-slim/*_append.md; do
    [[ -f "$f" ]] || continue
    check_file "$f" "$(basename "$f")"
  done

  # .remember files
  for f in "$config_dir"/.remember/*.md; do
    [[ -f "$f" ]] || continue
    local name; name=$(basename "$f")
    local lines; lines=$(wc -l < "$f" | tr -d ' ')
    local size; size=$(wc -c < "$f" | tr -d ' ')
    echo "   .remember/$name: ${lines} lines, ${size}B"
  done
}

check_claude() {
  echo "══════════ Claude Code Config ══════════"
  check_file "${HOME}/.claude/CLAUDE.md" "CLAUDE.md (global)"
  for f in "${HOME}"/.claude/rules/*.md; do
    [[ -f "$f" ]] || continue
    check_file "$f" "rules/$(basename "$f")"
  done
  check_file "$(pwd)/CLAUDE.md" "CLAUDE.md (project)" 2>/dev/null || true
  check_file "$(pwd)/AGENTS.md" "AGENTS.md (project)" 2>/dev/null || true
}

# ── Main ───────────────────────────────────────────────────────────

case "${1:-}" in
  --opencode) check_opencode ;;
  --claude)   check_claude ;;
  --all)
    check_opencode
    echo ""
    check_claude
    ;;
  *)
    check_file "${1:-CLAUDE.md}" "${1:-CLAUDE.md}"
    ;;
esac

echo ""
echo "Done."
