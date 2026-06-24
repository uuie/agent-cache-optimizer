# KV Cache Optimizer — Claude Code Adapter

## Key Difference: Claude Code vs OpenCode

| | OpenCode | Claude Code |
|---|---|---|
| **API** | OpenAI-compatible (DeepSeek) | Anthropic native |
| **Prompt caching** | Server-side prefix match | Anthropic prompt caching (automatic) |
| **Hook system** | Plugin API (system.transform) | settings.json hooks (no prompt access) |
| **Optimization** | Runtime block reordering | Content authoring guidelines |

Claude Code has **no prompt-transform hook** — you can't reorder system blocks
at runtime. Optimization must happen at the **content level** (how you write
CLAUDE.md) and at the **invocation level** (how you structure sessions).

## Anthropic Prompt Caching (Native)

Anthropic's API caches prompts automatically. Key behaviors:
- Cache breakpoints are set at **message boundaries**
- The **system message** is cached as a unit
- If the system message changes by even 1 byte, the entire system cache is busted
- Cache read tokens cost 10% of base input tokens
- Cache TTL: ~5 minutes (varies with load)

## Optimization Strategies for Claude Code

### 1. CLAUDE.md Structure (highest impact)

```markdown
# BAD: dynamic content at the top
<!-- Last updated: 2026-06-24 -->          ← busts cache daily
Session: ses_abc123                          ← busts cache every session

## Project Rules
...

---
# GOOD: stable content first, dynamic at bottom

## Project Rules (stable)
...

## Code Style (stable)
...

<!-- Last updated: 2026-06-24 -->          ← dynamic at end
```

**Rule**: Put the most stable, longest-lived content FIRST in CLAUDE.md.
Dates, session references, and frequently-updated sections go LAST.

### 2. Session Continuity

Anthropic cache TTL is ~5 minutes. Sessions with gaps >5min lose cache.
- Use `--continue` / `--resume` to maintain cache within a work session
- Batch related questions together
- Avoid restarting Claude Code for each small question

### 3. Project File References

Claude Code supports `@filename` references. When CLAUDE.md references
external files with `@`, those files are loaded at invocation time.
- Stable referenced files → cache survives
- Frequently-changed referenced files → cache busts
- Prefer inline stable content over `@references` to dynamic files

### 4. Hook Discipline

Hooks configured in `.claude/settings.json` inject content via
`<system-reminder>` blocks. These appear in the system message.

- **SessionStart hooks**: output goes into system message → if content
  changes, entire system cache busts. Keep output minimal and stable.
- **UserPromptSubmit hooks**: can add context to user messages (less
  impact on cache since user message changes anyway)

### 5. Validation Script

Run this periodically to check CLAUDE.md for cache-busting patterns:

```bash
#!/bin/bash
# check-cache-friendly.sh — scan CLAUDE.md for cache-busting patterns

FILE="${1:-CLAUDE.md}"

echo "=== KV Cache Friendliness Check: $FILE ==="

# Check 1: date stamps in first 10 lines
if head -10 "$FILE" | grep -qP '\d{4}-\d{2}-\d{2}'; then
  echo "⚠️  Date stamp found in first 10 lines — consider moving to end of file"
fi

# Check 2: session IDs
if grep -qP 'ses_[a-z0-9]{10,}' "$FILE"; then
  echo "⚠️  Session ID found — these change every session"
fi

# Check 3: dynamic includes
if grep -qP '@remember|@memory|\.remember/' "$FILE"; then
  echo "⚠️  Dynamic file references found — content changes between sessions"
fi

# Check 4: file size volatility
echo "   File size: $(wc -c < "$FILE") bytes"
echo "   Last modified: $(stat -c %y "$FILE")"

echo "=== Done ==="
```

## Comparison: OpenCode Plugin vs Claude Code Approach

| Metric | OpenCode Plugin | Claude Code Guidelines |
|--------|----------------|----------------------|
| Runtime reordering | ✅ automatic | ❌ not possible |
| Content-level fix | N/A (handled by reorder) | ✅ manual guidelines |
| Cache hit improvement | 40-88% (measured) | 20-50% (estimated) |
| Setup effort | 0 (plugin auto-loads) | Manual CLAUDE.md review |
| Maintenance | 0 (hash-based, self-learning) | Periodic validation |
