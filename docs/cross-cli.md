# KV Cache Optimization — Cross-CLI Architecture

## Core Principle (CLI-agnostic)

All LLM CLI agents assemble a system prompt from:
1. **Stable blocks**: CLAUDE.md / AGENTS.md / rules / tool definitions / agent configs
2. **Semi-dynamic blocks**: currentDate (changes daily)
3. **Dynamic blocks**: session handoff / memory injections / conversation history

Prefix-match KV caches (DeepSeek, Anthropic, Google, OpenAI) reuse computed
states when the prompt PREFIX is byte-identical to a cached request. Dynamic
content at the front busts everything.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                 agent-cache-optimizer-core                  │
│                                                       │
│  hash(track) → stability score → reorder             │
│  Fully content-agnostic, zero external deps           │
│  Input: string[] (system blocks)                      │
│  Output: string[] (reordered blocks)                  │
│  State: per-agent stability.json                      │
└──────────────────────────────────────────────────────┘
         │                │                │
    ┌────▼─────┐    ┌─────▼──────┐    ┌────▼──────┐
    │ OpenCode  │    │Claude Code │    │   Codex    │
    │  adapter  │    │  adapter   │    │  adapter   │
    │           │    │            │    │            │
    │ plugin.ts │    │ hook.js    │    │ plugin.py  │
    │ system    │    │ pre-launch │    │ (TBD)      │
    │ .transform│    │ validator  │    │            │
    └───────────┘    └────────────┘    └────────────┘
```

## Per-CLI Strategy

### OpenCode (✅ implemented)

- Hook: `experimental.chat.system.transform` — direct system prompt access
- Fallback: `chat.params` + `chat.headers` for diagnostics
- Adapter: `plugins/agent-cache-optimizer.ts`

### Claude Code (see [adapters/claude-code.md](../adapters/claude-code.md))

- No direct prompt-transform hook available
- Anthropic has native prompt caching (automatic prefix reuse)
- Strategy: **pre-session validator** + CLAUDE.md structure optimization
- Check: CLAUDE.md for date stamps, session IDs, dynamic includes
- Check: `.claude/settings.json` hooks for cache-busting patterns
- Wrap `claude` invocation to compare cache metrics before/after

### Codex (OpenAI)

- Plugin API likely similar to OpenCode (both from AI SDK ecosystem)
- Strategy: adapt OpenCode plugin once Codex plugin API is confirmed
- OpenAI prompt caching uses similar prefix-match mechanism

### Gemini CLI

- Uses `activate_skill` + GEMINI.md for project context
- Google context caching API has explicit cache tokens
- Strategy: inject cache_control markers at stable block boundaries

## Shared Core Module

`agent-cache-optimizer-core.ts`:

```typescript
// Pure functions, no CLI-specific dependencies
export function hashBlock(content: string): string
export function coldStartScore(block: string, index: number, total: number): number
export function classifyBlocks(blocks: string[], db: StabilityDB): Classified
export function updateStabilityDB(db: StabilityDB, blocks: string[]): StabilityDB
```

Each adapter imports these and adds CLI-specific glue:
1. Extract blocks from CLI's prompt representation
2. Call `classifyBlocks()`
3. Inject reordered blocks back into CLI's prompt

## Roadmap

1. [x] OpenCode plugin (V3: per-agent + block splitting + diagnostics)
2. [ ] Extract shared core to `agent-cache-optimizer-core.ts`
3. [ ] Claude Code pre-session validator
4. [ ] Codex adapter (once API confirmed)
5. [ ] Gemini CLI adapter (Google context caching)
