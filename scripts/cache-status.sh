#!/usr/bin/env bash
# cache-status.sh — display KV Cache Optimizer status
# Usage: cache-status.sh [--json]
set -euo pipefail

CACHE_DIR="${HOME}/.cache/opencode/agent-cache-optimizer"
BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

# ── Check if plugin has run ────────────────────────────────────────

if [[ ! -d "$CACHE_DIR" ]]; then
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║              KV Cache Optimizer Status                       ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║ Status:  NO DATA                                             ║"
  echo "║                                                               ║"
  echo "║ Plugin has not been invoked yet.                              ║"
  echo "║                                                               ║"
  echo "║ 1. Verify agent-cache-optimizer.ts is in opencode.json plugins      ║"
  echo "║ 2. Restart OpenCode                                           ║"
  echo "║ 3. Make at least one request to trigger the hook              ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  exit 0
fi

# ── Parse stability DBs ────────────────────────────────────────────

declare -A agent_obs agent_positions agent_stable_pct agent_mode

for db in "$CACHE_DIR"/stability-*.json; do
  [[ -f "$db" ]] || continue
  agent=$(basename "$db" .json | sed 's/^stability-//')

  obs=$(python3 -c "
import json
d=json.load(open('$db'))
print(d.get('observations', 0))
" 2>/dev/null || echo 0)

  pos_count=$(python3 -c "
import json
d=json.load(open('$db'))
print(len(d.get('positions', {})))
" 2>/dev/null || echo 0)

  # Average score across all known hashes
  avg_score=$(python3 -c "
import json
d=json.load(open('$db'))
scores = list(d.get('scores', {}).values())
if scores:
    stable = sum(1 for s in scores if s >= 0.7)
    dynamic = sum(1 for s in scores if s <= 0.3)
    print(f'{stable}/{len(scores)}')
else:
    print('0/0')
" 2>/dev/null || echo "0/0")

  agent_obs[$agent]=$obs
  agent_positions[$agent]=$pos_count
  agent_stable_pct[$agent]=$avg_score

  if [[ $obs -ge 3 ]]; then
    agent_mode[$agent]="WARM"
  else
    agent_mode[$agent]="COLD"
  fi
done

# ── Parse diag log ─────────────────────────────────────────────────

diag_entries=0
last_entry=""
if [[ -f "$CACHE_DIR/diag.log" ]]; then
  diag_entries=$(wc -l < "$CACHE_DIR/diag.log" | tr -d ' ')
  last_entry=$(tail -1 "$CACHE_DIR/diag.log" 2>/dev/null || echo "(empty)")
fi

# ── Display ────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║              KV Cache Optimizer Status                       ║${NC}"
echo -e "${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"

# Status line
if [[ $diag_entries -gt 0 ]]; then
  echo -e "║ ${GREEN}Status:  ACTIVE${NC}                                               ║"
else
  echo -e "║ ${RED}Status:  NO ACTIVITY (check plugin loading)${NC}                    ║"
fi

# Mode: cold/warm per agent
modes=""
for agent in "${!agent_obs[@]}"; do
  modes+="$agent=${agent_mode[$agent]} "
done
printf "║ Mode:    %-52s ║\n" "$modes"

# Uptime from diag.log first/last
if [[ $diag_entries -gt 0 ]]; then
  first_ts=$(head -1 "$CACHE_DIR/diag.log" | grep -oP '^\[[^\]]+\]' | tr -d '[]' || echo "?")
  last_ts=$(tail -1 "$CACHE_DIR/diag.log" | grep -oP '^\[[^\]]+\]' | tr -d '[]' || echo "?")
  printf "║ Uptime:  %-52s ║\n" "$first_ts → $last_ts"
fi

echo -e "${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"

# Per-agent breakdown
if [[ ${#agent_obs[@]} -eq 0 ]]; then
  echo -e "║ ${YELLOW}No per-agent data yet — make requests with different agents${NC}     ║"
else
  printf "║ ${CYAN}%-20s %6s %8s %10s${NC}  ║\n" "Agent" "Obs" "Positions" "Stable"
  for agent in $(printf '%s\n' "${!agent_obs[@]}" | sort); do
    printf "║ %-20s %6s %8s %10s  ║\n" \
      "$agent" "${agent_obs[$agent]}" "${agent_positions[$agent]}" "${agent_stable_pct[$agent]}"
  done
fi

echo -e "${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"

# Last reorder entries
if [[ $diag_entries -gt 0 ]]; then
  echo -e "║ ${CYAN}Last reorders (diag.log):${NC}                                    ║"
  tail -5 "$CACHE_DIR/diag.log" 2>/dev/null | while IFS= read -r line; do
    # Truncate to fit in box
    printf "║   %-56s ║\n" "${line:0:56}"
  done
else
  echo -e "║ ${YELLOW}No reorder events logged yet${NC}                                  ║"
fi

echo -e "${BOLD}╠══════════════════════════════════════════════════════════════╣${NC}"

# Estimated savings
total_obs=0
for o in "${agent_obs[@]}"; do total_obs=$((total_obs + o)); done
if [[ $total_obs -gt 0 ]]; then
  total_stable=0
  total_blocks=0
  for agent in "${!agent_stable_pct[@]}"; do
    s=$(echo "${agent_stable_pct[$agent]}" | cut -d/ -f1)
    t=$(echo "${agent_stable_pct[$agent]}" | cut -d/ -f2)
    total_stable=$((total_stable + s))
    total_blocks=$((total_blocks + t))
  done
  if [[ $total_blocks -gt 0 ]]; then
    pct=$((total_stable * 100 / total_blocks))
    printf "║ Estimated cache reuse: %-36s ║\n" "~${pct}% of system prompt"
  fi
fi

echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Quick stats ────────────────────────────────────────────────────

echo "Files:"
echo "  $(ls "$CACHE_DIR"/stability-*.json 2>/dev/null | wc -l) stability DBs"
echo "  ${diag_entries} diagnostic log entries"
echo ""

if [[ $diag_entries -eq 0 && ${#agent_obs[@]} -eq 0 ]]; then
  echo "⚠️  Plugin hasn't fired yet. Troubleshooting:"
  echo "  1. grep 'agent-cache-optimizer' ~/.config/opencode/opencode.json"
  echo "  2. Restart OpenCode"
  echo "  3. Check: the experimental.chat.system.transform hook"
  echo "     may not be available in your OpenCode version."
  echo "     Fallback: chat.params hook writes to diag.log on first call."
fi
