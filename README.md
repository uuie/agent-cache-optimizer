<p align="center">
  <a href="https://www.npmjs.com/package/agent-cache-optimizer"><img src="https://img.shields.io/npm/v/agent-cache-optimizer" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-OpenCode-blue" alt="OpenCode">
  <img src="https://img.shields.io/badge/CLI-Claude%20Code%20%7C%20Codex%20%7C%20Gemini-orange" alt="Multi-CLI">
  <img src="https://img.shields.io/badge/providers-DeepSeek%20%7C%20Anthropic%20%7C%20OpenAI-purple" alt="DeepSeek Anthropic OpenAI">
  <img src="https://img.shields.io/badge/cache%20gain-40–88%25-brightgreen" alt="Cache gain 40-88%">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/deps-zero-blue" alt="Zero dependencies">
</p>

<h1 align="center">🧠 agent-cache-optimizer</h1>
<p align="center"><strong>OpenCode plugin for LLM prompt caching, token savings, and KV cache reuse</strong></p>
<p align="center">Stops prompt-cache busting when agent sessions change across agents, providers, models, projects, and workspaces.</p>
<p align="center">Stable system blocks go first. Volatile handoff, memory, date, and workspace state go later.</p>
<p align="center">Boost prompt cache hit rates by <strong>40–88%</strong>.<br>Zero config for OpenCode. Zero content knowledge. CLI-agnostic core.</p>
<p align="center"><strong>English</strong> | <a href="README.zh-CN.md">中文</a></p>

---

## 🎯 What problem does it solve?

LLM providers such as DeepSeek, Anthropic, OpenAI, and Google use
**prefix-match KV caching**: the beginning of the prompt must match a previous
request before the provider can reuse cached key-value states.

Agent prompts usually have the opposite shape. Dynamic state is injected first,
while stable but expensive blocks come later:

```
┌─────────────────────────────────────────────────┐
│ ⚡ HANDOFF block (changes every session)         │  ← Cache BUSTED
│ ⚡ REMEMBER / MEMORY (changes throughout day)    │  ← Cache BUSTED
├─────────────────────────────────────────────────┤
│ ✅ CLAUDE.md (changes weekly)                    │  ← Never reached
│ ✅ Agent definitions (static)                    │  ← Never reached
│ ✅ MCP / Skills / Tools (static)                 │  ← Never reached
│ ⚡ currentDate (changes daily)                   │
│ ⚡ Memory injection (changes per query)          │
└─────────────────────────────────────────────────┘
```

**Result: 0% cache reuse across sessions.** Every session recomputes the
entire system prompt from scratch, even though 70-90% of it hasn't changed.

This gets worse in real agent workflows:

| Scenario                             | What breaks the prefix cache                                       | What this project does                                                 |
| ------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Multi-agent runs                     | Planner/fixer/explorer handoffs change before shared rules         | Tracks stability per `provider__model__agent` scope                    |
| Multi-provider/model routing         | DeepSeek, Anthropic, OpenAI, and model variants warm differently   | Keeps scoped cache metrics and warm hashes instead of one global guess |
| Project/workspace/worktree switching | Repo paths, memories, dates, and workspace context move around     | Moves stable repo/tool/agent blocks before volatile workspace state    |
| Large MCP/tool/skill prompts         | Huge static tool schemas are recomputed when dynamic text is first | Splits large blocks and pins stable hashes near the front              |
| Handoff and memory-heavy sessions    | Conversation state changes every task                              | Keeps handoff/memory useful but moves it after cacheable blocks        |

It does **not** compress prompts, summarize instructions, or read prompt
content. It only hashes system blocks, learns which blocks are stable, and
reorders them so provider prefix caching can work.

## 💡 The Fix

**agent-cache-optimizer** reorders the system prompt at runtime:

```
┌─────────────────────────────────────────────────┐
│ ✅ CLAUDE.md (stable)          ← Cached         │
│ ✅ Agent definitions (stable)  ← Cached         │
│ ✅ MCP / Skills / Tools        ← Cached         │
│ ✅ Tool definitions            ← Cached         │
├─────────────────────────────────────────────────┤
│ ⚡ currentDate                                   │
│ ⚡ HANDOFF / REMEMBER / MEMORY                   │
│ ⚡ Memory injection                              │
└─────────────────────────────────────────────────┘
```

**Stable blocks first → prefix survives session changes → 40-88% cache reuse.**

## 🚀 Install

### OpenCode

```json
{
  "plugin": ["agent-cache-optimizer"]
}
```

Add to `~/.config/opencode/opencode.json`. OpenCode auto-installs from npm on next startup.

```bash
# Or via CLI
opencode plugin agent-cache-optimizer --global
```

**Restart OpenCode — done.** Zero config. Works immediately for DeepSeek, Anthropic, OpenAI, and any provider with prefix-match KV caching.

### Claude Code

Claude Code does not expose a runtime prompt-transform hook, so this package
loads as a Claude Code companion plugin for status and cache-friendly prompt
guidance rather than automatic system block reordering.

From this checkout:

```bash
PLUGIN_DIR="$(pwd)"

# Validate plugin metadata without starting a model session
claude plugin validate "$PLUGIN_DIR"

# Confirm Claude Code can see the session-only plugin
claude --plugin-dir "$PLUGIN_DIR" plugin list
claude --plugin-dir "$PLUGIN_DIR" plugin details agent-cache-optimizer

# Start Claude Code with the plugin loaded for this session
claude --plugin-dir "$PLUGIN_DIR"
```

Inside Claude Code, use `/agent-cache-status` to inspect local optimizer status.
For cache-friendly Claude sessions, structure stable `CLAUDE.md` content first
and use Claude Code's `--exclude-dynamic-system-prompt-sections` option when you
are using the default system prompt.

### Codex CLI

Codex CLI loads reusable workflows as skills or plugins. This package ships a
Codex plugin manifest and the `agent-cache-status` skill, so it can be exposed
through a local Codex plugin marketplace during development.

From this checkout:

```bash
PLUGIN_DIR="$(pwd)"
MARKETPLACE_ROOT="${HOME}/.local/share/agent-cache-optimizer-codex"

# Copy this plugin into a local Codex marketplace layout.
mkdir -p "$MARKETPLACE_ROOT/plugins/agent-cache-optimizer"
mkdir -p "$MARKETPLACE_ROOT/.agents/plugins"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  "$PLUGIN_DIR"/ "$MARKETPLACE_ROOT/plugins/agent-cache-optimizer"/

cat > "$MARKETPLACE_ROOT/.agents/plugins/marketplace.json" <<'JSON'
{
  "name": "agent-cache-optimizer-local",
  "interface": {
    "displayName": "Agent Cache Optimizer Local"
  },
  "plugins": [
    {
      "name": "agent-cache-optimizer",
      "source": {
        "source": "local",
        "path": "./plugins/agent-cache-optimizer"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
JSON

# Register the marketplace and install the plugin.
codex plugin marketplace add "$MARKETPLACE_ROOT"
codex plugin add agent-cache-optimizer@agent-cache-optimizer-local

# Confirm Codex installed and enabled it.
codex plugin list --json
```

Inside Codex, invoke `$agent-cache-optimizer:agent-cache-status` or use
`/skills` to select the skill. Start a new Codex thread after installing or
updating the plugin so the skill list is refreshed.

### Verify

```bash
# OpenCode: check plugin is loaded
opencode debug config | grep agent-cache-optimizer

# OpenCode: watch reorder activity in real time
tail -f ~/.cache/opencode/agent-cache-optimizer/diag.log

# Claude Code: inspect the session-only plugin
claude --plugin-dir "$(pwd)" plugin details agent-cache-optimizer

# Codex CLI: confirm the skill is visible in the prompt input
codex debug prompt-input "Use agent-cache-optimizer status" \
  | grep 'agent-cache-optimizer:agent-cache-status'
```

### Status dashboard

```bash
agent-cache-optimizer status           # text dashboard
agent-cache-optimizer status --json    # JSON for scripts
```

The dashboard reports active scopes, stable hashes, real provider cache hit
rate, and estimated savings.

## 🏗 How It Works

### 1. Observe (content-addressed, position-independent)

The plugin **never reads the content** of your prompts. It only hashes
each system block and tracks which hashes stay the same vs change across calls.

```
Session 1:  [H1, CLAUDE-A, AGENT-X, TOOLS-V1, DATE-1, MEM-1]
Session 2:  [H2, CLAUDE-A, AGENT-X, TOOLS-V1, DATE-2, MEM-2]
Session 3:  [H3, CLAUDE-A, AGENT-X, TOOLS-V1, DATE-2, MEM-3]

After 3 observations:
  H1/H2/H3 at position 0 change every time → score 0.0 (dynamic)
  CLAUDE-A at position 1 never changes     → score 1.0 (stable)
  AGENT-X at position 2 never changes      → score 1.0 (stable)
  ...
```

### 2. Split & Classify

Large blocks (>4KB) are split at structural boundaries — JSON arrays,
Markdown headings, XML elements, and long lists — using a robust
brace-depth parser that handles arbitrary nesting and fenced code blocks.

Cold-start heuristics detect volatile metadata patterns (`currentDate`,
`session ID`, `timestamp`) and cap their scores to prevent structural
boosts from misclassifying them as stable.

```
                                                                  ┌──────────┐
  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐     │ STABLE   │
  │ HANDOFF  │   │ CLAUDE   │   │ TOOLS    │   │ MEMORY   │ ──▶ │ CLAUDE   │
  │ (dynamic)│   │ (stable) │   │ (stable) │   │ (dynamic)│     │ TOOLS    │
  └──────────┘   └──────────┘   └──────────┘   └──────────┘     │──────────│
       ⚡             ✅              ✅              ⚡           │ DYNAMIC  │
                                                                 │ HANDOFF  │
                                                                 │ MEMORY   │
                                                                 └──────────┘
```

### 3. Two-phase decision

| Phase          | Trigger                 | Method                                       |
| -------------- | ----------------------- | -------------------------------------------- |
| **Cold start** | First 2 calls per scope | Universal position/size/structure heuristics |
| **Warm**       | 3+ calls                | Hash-based stability scores                  |

The cold-start heuristics use **only** structural signals (position, size,
delimiters, line density) — no keyword matching, no config awareness.
This means the plugin works immediately with **any** agent setup.

### 4. Provider Cache Metrics

Real cache hit rates are tracked from OpenCode provider events — no
estimation needed. `cache-metrics.json` records per-scope and
total `cacheReadTokens`, `cacheWriteTokens`, and `cacheHitRate`.
All session and message IDs are content-hashed for privacy.

## 📊 Benchmarks

Tested on a realistic OpenCode orchestrator prompt (~25KB system prompt):

| Scenario                     | Cacheable prefix   | Improvement |
| ---------------------------- | ------------------ | ----------- |
| Original (no reorder)        | 0 KB (0%)          | —           |
| Cold start (heuristics)      | 21.8 KB (88%)      | +88%        |
| **Content-addressed (v0.5)** | **52.9 KB (100%)** | **+100%**   |

**Production results** (155 observations, deepseek-v4-pro):

| Phase                        | S      | U     | D     | Stable KB   |
| ---------------------------- | ------ | ----- | ----- | ----------- |
| Pre-v0.5 (position-based)    | 1      | 0     | 24    | ~2 KB       |
| **v0.5 (content-addressed)** | **25** | **0** | **0** | **52.9 KB** |

### v0.6.1 real-world DeepSeek run (2026-06-26)

The `v0.6.1` tag documents provider-reported cache metrics from a local
OpenCode run, filtered with the same command used during testing:

```bash
cat ~/.cache/opencode/agent-cache-optimizer/diag.log \
  | grep hit \
  | grep 2026-06-26 \
  | grep deepseek__deepseek
```

The filtered run contained **309 cache-hit metric samples**:

| Scope                              | Samples | Hit rate observed | Latest metric                                             |
| ---------------------------------- | ------- | ----------------- | --------------------------------------------------------- |
| `deepseek-v4-pro` / `orchestrator` | 86      | 98.0-98.3%        | 98.1% hit rate, 39,084,800 cache-read tokens              |
| `deepseek-v4-flash` / `fixer`      | 196     | 86.1-99.2%        | 99.0% hit rate, 21,218,432 cache-read tokens              |
| `deepseek-v4-flash` / `explorer`   | 27      | 0.0-90.3%         | 90.3% hit rate after warm-up, 1,229,696 cache-read tokens |

The `explorer` scope shows cold-start behavior: the first sample was 0.0%
before the provider cache warmed, and later samples reached 90%+ hit rate.

## 🔌 Supported Platforms

| Platform        | Status                           | Adapter                                            |
| --------------- | -------------------------------- | -------------------------------------------------- |
| **OpenCode**    | ✅ Plugin                        | `src/index.ts` (native)                            |
| **Claude Code** | ✅ Companion plugin + guidelines | [adapters/claude-code.md](adapters/claude-code.md) |
| **Codex**       | ✅ Companion plugin + skill      | `.codex-plugin/plugin.json` + `skills/`            |
| **Gemini CLI**  | 🔜 Planned                       | Google context caching                             |

## 🛠 Cache-Friendliness Audit

Check any config file for patterns that bust the KV cache:

```bash
bash scripts/check-cache-friendly.sh CLAUDE.md
bash scripts/check-cache-friendly.sh --opencode
bash scripts/check-cache-friendly.sh --all
```

## 🙋 FAQ

**Q: Does this change my prompts?**
A: Only the ORDER of system blocks. Content is never modified.

**Q: Will it break my agent?**
A: No. The LLM sees the same blocks, just in a different order. System prompts
are position-independent by design.

**Q: Does it work with non-OpenCode agents?**
A: The core engine is CLI-agnostic. Adapters exist for OpenCode (plugin) and
Claude Code (companion plugin + guidelines). Codex ships a companion plugin and
status skill. Gemini CLI guidance is planned.

**Q: What if my prompts change?**
A: The hash-based tracking adapts automatically. If a previously-stable block
starts changing, its score drops and it moves to dynamic. If a new stable
block is added, it converges to stable after a few observations.

**Q: Does this work with Anthropic's prompt caching?**
A: Yes — the `chat.headers` hook adds the `prompt-caching-2024-07-31` beta
header automatically for Anthropic providers.

## ⭐ Star History

<a href="https://www.star-history.com/#uuie/agent-cache-optimizer&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=uuie/agent-cache-optimizer&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=uuie/agent-cache-optimizer&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=uuie/agent-cache-optimizer&type=Date" />
  </picture>
</a>

## 📄 License

MIT — use it, fork it, ship it, star it ⭐

---

<p align="center">
  <sub>Built with ❤️ for the LLM CLI ecosystem.  If this saved you tokens,</sub><br>
  <sub>drop a ⭐ on GitHub — it helps more people find it.</sub>
</p>
