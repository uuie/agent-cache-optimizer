# Conversation-Log Cache Optimization (v0.4)

## Principle: Append-Only Log

DeepSeek's prefix cache matches from the **start** of the prompt. After
reordering system blocks, the next frontier is the conversation log.

Every time a message is rewritten, reordered, or compressed mid-history,
the byte-level prefix changes → cache miss for everything after.

## Guidelines for Agent Developers

### DO: Append, Never Rewrite

```
✅ Turn 1: [system][user₁][assistant₁]
✅ Turn 2: [system][user₁][assistant₁][user₂][assistant₂]  ← Turn 1 prefix preserved
✅ Turn 3: [system][user₁][assistant₁][user₂][assistant₂][user₃][assistant₃]  ← Turn 2 prefix preserved
```

### DON'T: Inject, Reorder, or Compress

```
❌ Turn 2: [system][user₂][assistant₂]  ← history lost, but prefix is stable? NO
   (system prefix is stable, but conversation prefix changes because
    user₁/assistant₁ are missing)
❌ Turn 2: [system][updated timestamp][user₁][assistant₁][user₂]  ← timestamp busts
❌ Turn 2: [system][compressed: user₁+assistant₁][user₂]  ← compression changes bytes
```

## Implementation

### For OpenCode Agents

OpenCode's orchestrator manages conversation history. The plugin can't control
how messages are serialized, but agent developers can:

1. **Keep system prompts stable** (agent-cache-optimizer handles this)
2. **Avoid injecting timestamps in conversation** (use `currentDate` block at end)
3. **Prepend new user/assistant messages** at the end of the log — never insert mid-history
4. **Use consistent JSON key ordering** in tool calls

### For Custom Agent Loops (like Reasonix)

Implement a 3-region context:

```typescript
class CacheOptimizedContext {
  // Region 1: Immutable — computed once, never changes
  readonly immutablePrefix: string

  // Region 2: Append-only — grows monotonically, never rewritten  
  private log: string[] = []

  // Region 3: Volatile — reset each turn, never sent to LLM
  private scratch: string[] = []

  appendToLog(entry: string) {
    this.log.push(entry)
  }

  buildPrompt(): string {
    // Stable prefix first → cache hit
    return this.immutablePrefix + this.log.join("")
    // Note: scratch is NOT included
  }
}
```

## Cache Hit Rate Expectations

| Approach | System Prompt | Conversation | Combined |
|----------|--------------|--------------|----------|
| No optimization | 0% | 0% | 0% |
| System-only (our plugin) | 88% | 0% | ~30% |
| System + Append-Only | 88% | 70-90% | **80-95%** |
| Reasonix (3-region) | 99% | 95% | **94-99%** |

## Future: Automatic Log Optimization

In a future version, the plugin could:

1. Detect when conversation messages are being rewritten
2. Suggest append-only alternatives
3. Track conversation-level cache efficiency
4. Provide a `conversationCacheHitRate` metric

This requires deeper integration with the agent framework and is planned
for v1.0.
