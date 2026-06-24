# KV Cache Optimization for DeepSeek — Upstream Changes Needed

## Problem

OpenCode's system prompt assembly places **dynamic blocks** (SessionStart HANDOFF,
.remember/ files, memory-dream injections, currentDate) at the **front** of the
system prompt array. This means the very first bytes of every session's system
prompt are different, which completely busts prefix-match KV caches (DeepSeek,
Anthropic prompt caching, Google context caching).

## Current prompt assembly order (observed)

```
[0] SessionStart HANDOFF + REMEMBER + MEMORY  ← ⚡ changes every session
[1] CLAUDE.md                                  ← ✅ stable
[2] Agent definitions                          ← ✅ stable
[3] MCP server instructions                    ← ✅ stable  
[4] Skills list                                ← ✅ stable
[5] currentDate                                ← ⚠️ changes daily
[6] Tool definitions                           ← ✅ stable
```

## Impact

- **Every new session: 100% cache miss** on system prompt
- **Every subagent call: fresh KV computation** for the full system prompt
- **Estimated waste**: 40-60% of system prompt tokens recomputed unnecessarily
- For DeepSeek where cache hit cost is near-zero, this is purely wasted compute

## Fix (in OpenCode core)

Move dynamic blocks to the **end** of the system prompt array:

```
[0] CLAUDE.md                                  ← ✅ stable
[1] Agent definitions                          ← ✅ stable
[2] MCP server instructions                    ← ✅ stable
[3] Skills list                                ← ✅ stable
[4] Tool definitions                           ← ✅ stable
[5] currentDate                                ← ⚠️ changes daily
[6] SessionStart HANDOFF + REMEMBER + MEMORY  ← ⚡ changes per session
```

This way, the KV cache prefix (blocks [0]-[4]) stays identical across sessions
and subagent calls, giving 70-80% cache reuse.

## Implementation in OpenCode

In the prompt assembly code (likely in the system prompt builder), change:

1. **Build stable prefix first**: all static configuration (CLAUDE.md, agent
   definitions, MCP/Skills/tools lists)
2. **Append semi-dynamic content**: currentDate
3. **Append fully-dynamic content last**: SessionStart hook output,
   .remember/ injection, memory-dream retrieval results

## Interim workaround

A plugin (`agent-cache-optimizer.ts`) uses `experimental.chat.system.transform` to
reorder blocks at runtime. This works but:
- Depends on an experimental hook
- Adds a small processing overhead
- Can't reorder content WITHIN blocks, only BETWEEN blocks

The proper fix is in the core prompt builder.
