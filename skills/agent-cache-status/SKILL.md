---
name: agent-cache-status
description: Show agent-cache-optimizer status — stability DBs, reordering stats, diagnostics. Trigger: /agent-cache-status
---

# Agent Cache Optimizer Status

Show the current state of the agent-cache-optimizer plugin.

## Data Locations

- Stability DBs: `~/.cache/opencode/agent-cache-optimizer/stability-*.json`
- Diagnostic log: `~/.cache/opencode/agent-cache-optimizer/diag.log`

## Display Format

Read all `stability-*.json` files and `diag.log`, then present:

```
╔══════════════════════════════════════════════════════════════╗
║              KV Cache Optimizer Status                       ║
╠══════════════════════════════════════════════════════════════╣
║ Status:  ACTIVE / NO DATA / ERROR                            ║
║ Mode:    COLD START (heuristics) / WARM (hash-based)         ║
║ Uptime:  first_seen → last_seen                             ║
╠══════════════════════════════════════════════════════════════╣
║ Per-Agent Breakdown:                                         ║
║   orchestrator:  12 obs, 88% cacheable                       ║
║   oracle:         5 obs, 75% cacheable                       ║
║   fixer:          3 obs, 90% cacheable                       ║
║   ...                                                        ║
╠══════════════════════════════════════════════════════════════╣
║ Last 5 reorders (from diag.log):                             ║
║   [time] [agent] S:X U:Y D:Z T:N obs:M                       ║
║   ...                                                        ║
╠══════════════════════════════════════════════════════════════╣
║ Estimated savings: XX KB / session                           ║
╚══════════════════════════════════════════════════════════════╝
```

## Key Metrics

From each `stability-{agent}.json`:
- `observations`: number of calls tracked
- `positions`: number of distinct block positions
- Average `scores` per block → classification quality
- Ratio of stable vs dynamic blocks

From `diag.log`:
- Last N reorder operations
- Confirm plugin is being invoked

## Interpretation

- **NO DATA**: Plugin hasn't been invoked yet. Restart OpenCode after adding the plugin to `opencode.json`.
- **COLD START**: First 2 sessions per agent — using position/size heuristics.
- **WARM**: 3+ sessions — using hash-based stability tracking. More accurate.
- **High stable %**: Good cache reuse across sessions.
- **High unknown %**: Heuristics can't classify some blocks → will improve with more observations.

## If Plugin Not Working

1. Check `opencode.json` has `"file:///home/chris/.config/opencode/plugins/agent-cache-optimizer.ts"` in `plugin` array
2. Check `diag.log` exists and has entries
3. If no diag.log: the `experimental.chat.system.transform` hook may not be firing → fall back to `chat.params` diagnostic
4. Run `opencode debug agent orchestrator` to verify plugin config

## Quick Health Check

```bash
# Check if plugin is loaded
ls ~/.cache/opencode/agent-cache-optimizer/

# View last reorder
tail -5 ~/.cache/opencode/agent-cache-optimizer/diag.log

# Count observations per agent
for f in ~/.cache/opencode/agent-cache-optimizer/stability-*.json; do
  echo "$(basename $f .json): $(python3 -c "import json; d=json.load(open('$f')); print(d['observations'])") obs"
done
```
