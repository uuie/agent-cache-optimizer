<p align="center">
  <a href="https://www.npmjs.com/package/agent-cache-optimizer"><img src="https://img.shields.io/npm/v/agent-cache-optimizer" alt="npm version"></a>
  <img src="https://img.shields.io/badge/platform-OpenCode-blue" alt="OpenCode">
  <img src="https://img.shields.io/badge/cache%20gain-40–88%25-brightgreen" alt="Cache gain 40-88%">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT">
  <img src="https://img.shields.io/badge/deps-zero-blue" alt="Zero dependencies">
</p>

<h1 align="center">🧠 agent-cache-optimizer</h1>
<p align="center"><strong>Content-agnostic KV cache optimizer for LLM CLI agents</strong></p>
<p align="center">Boost prompt cache hit rates by <strong>40–88%</strong>.<br>Zero config. Zero content knowledge. Works with <em>any</em> agent framework.</p>

---

## 🎯 The Problem

LLM providers (DeepSeek, Anthropic, OpenAI, Google) use **prefix-match KV caching**:
if your prompt starts with the same bytes as a previous request, the computed
key-value states are reused — cache hits cost near-zero tokens.

**But every CLI agent puts dynamic content at the FRONT of the system prompt:**

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

### Verify

```bash
# Check plugin is loaded
opencode debug config | grep agent-cache-optimizer

# Watch reorder activity in real time
tail -f ~/.cache/opencode/agent-cache-optimizer/diag.log
```

### Status dashboard

Inside OpenCode:

```
/cache-status
```

Or terminal:

```bash
bash scripts/cache-status.sh
```

### Output

```
╔══════════════════════════════════════════════════════════════╗
║              KV Cache Optimizer Status                       ║
╠══════════════════════════════════════════════════════════════╣
║ Status:  ACTIVE                                              ║
║ Mode:    orchestrator=WARM oracle=COLD                        ║
║ Uptime:  2026-06-24T15:30 → 2026-06-24T16:45                ║
╠══════════════════════════════════════════════════════════════╣
║ Agent              Obs  Positions     Stable                 ║
║ orchestrator        12         11      8/11                  ║
║ oracle               3          5      3/5                   ║
╠══════════════════════════════════════════════════════════════╣
║ Estimated cache reuse: ~73% of system prompt                 ║
╚══════════════════════════════════════════════════════════════╝
```

## 🏗 How It Works

### 1. Observe (content-agnostic)

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

### 2. Classify & Reorder

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
| **Cold start** | First 2 calls per agent | Universal position/size/structure heuristics |
| **Warm**       | 3+ calls                | Hash-based stability scores                  |

The cold-start heuristics use **only** structural signals (position, size,
delimiters, line density) — no keyword matching, no config awareness.
This means the plugin works immediately with **any** agent setup.

## 📊 Benchmarks

Tested on a realistic OpenCode orchestrator prompt (~25KB system prompt):

| Scenario                       | Cacheable prefix | Improvement |
| ------------------------------ | ---------------- | ----------- |
| Original (no reorder)          | 0 KB (0%)        | —           |
| Cold start (heuristics)        | 21.8 KB (88%)    | +88%        |
| Warm (hash-based, 3+ sessions) | 21.8 KB (88%)    | +88%        |

**Per-agent results** (3 different agent configurations):

| Agent        | Blocks | Stable | Dynamic | Cacheable |
| ------------ | ------ | ------ | ------- | --------- |
| orchestrator | 11     | 8      | 3       | 88%       |
| oracle       | 6      | 3      | 3       | 88%       |
| fixer        | 6      | 3      | 3       | 90%       |

## 🔌 Supported Platforms

| Platform        | Status        | Adapter                                            |
| --------------- | ------------- | -------------------------------------------------- |
| **OpenCode**    | ✅ Plugin     | `src/index.ts` (native)                            |
| **Claude Code** | 📖 Guidelines | [adapters/claude-code.md](adapters/claude-code.md) |
| **Codex**       | 🔜 Planned    | Adapt OpenCode plugin                              |
| **Gemini CLI**  | 🔜 Planned    | Google context caching                             |

## 🧩 API (standalone usage)

The core engine is CLI-agnostic. Use it in any project:

```typescript
import { emptyDB, updateDB, classify } from "agent-cache-optimizer"

// Track stability
let db = emptyDB()
const blocks = ["HANDOFF...", "CLAUDE.md...", "AGENT...", "MEMORY..."]

// Classify and reorder
const classified = classify(blocks, db)
const optimized = [...classified.stable, ...classified.unknown, ...classified.dynamic]

// Update for next call
db = updateDB(db, optimized)
```

## 📁 Project Structure

```
agent-cache-optimizer/
├── src/
│   ├── index.ts          # OpenCode plugin entry point
│   ├── core.ts           # Hash-tracking engine (CLI-agnostic)
│   ├── heuristics.ts     # Cold-start position/size classifiers
│   ├── splitting.ts      # Large block splitter (>4KB)
│   └── types.ts          # TypeScript types
├── adapters/
│   └── claude-code.md    # Claude Code optimization guide
├── scripts/
│   ├── cache-status.sh   # Status dashboard
│   └── check-cache-friendly.sh  # Config audit tool
├── skills/
│   └── cache-status/     # /cache-status slash command
├── docs/
│   ├── cross-cli.md      # Cross-CLI architecture
│   └── upstream.md       # Upstream fix recommendations
├── README.md
├── README.zh-CN.md       # 中文文档
├── LICENSE               # MIT
└── CHANGELOG.md
```

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
Claude Code (guidelines). Codex and Gemini CLI adapters are planned.

**Q: What if my prompts change?**
A: The hash-based tracking adapts automatically. If a previously-stable block
starts changing, its score drops and it moves to dynamic. If a new stable
block is added, it converges to stable after a few observations.

**Q: Does this work with Anthropic's prompt caching?**
A: Yes — the `chat.headers` hook adds the `prompt-caching-2024-07-31` beta
header automatically for Anthropic providers.

## 📄 License

MIT — use it, fork it, ship it, star it ⭐

---

<p align="center">
  <sub>Built with ❤️ for the LLM CLI ecosystem.  If this saved you tokens,</sub><br>
  <sub>drop a ⭐ on GitHub — it helps more people find it.</sub>
</p>
