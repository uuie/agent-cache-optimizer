# Contributing to agent-cache-optimizer

Thanks for your interest! This is a small, focused project — contributions
that improve cache hit rates, add CLI adapter support, or fix bugs are welcome.

## Setup

```bash
git clone https://github.com/uuie/agent-cache-optimizer.git
cd agent-cache-optimizer
npm install
```

## Project Structure

```
src/
├── index.ts          # OpenCode plugin entry (thin wrapper)
├── core.ts           # Hash-tracking engine (CLI-agnostic, zero deps)
├── heuristics.ts     # Cold-start classifiers (universal signals)
├── splitting.ts      # Large block splitter
└── types.ts          # Shared types
```

## Adding a New CLI Adapter

The core engine is CLI-agnostic. To add support for a new agent:

1. Create `adapters/<name>.ts` (or `.md` for guideline-based adapters)
2. Extract blocks from the CLI's system prompt
3. Call `classify()` from `heuristics.ts`
4. Inject reordered blocks back

Example for a hypothetical CLI with a pre-prompt hook:

```typescript
import { emptyDB, updateDB, classify } from "agent-cache-optimizer"

// In the CLI's pre-prompt hook:
const db = loadState()
const blocks = extractSystemBlocks()
const classified = classify(blocks, db)
const optimized = [...classified.stable, ...classified.unknown, ...classified.dynamic]
injectSystemBlocks(optimized)
saveState(updateDB(db, optimized))
```

## Testing

```bash
npm test
```

Tests focus on:
- Hash stability tracking correctness
- Cold-start heuristic accuracy
- Block splitting logic
- Classification boundary cases

## Code Style

- Pure functions where possible (no side effects in core/heuristics/splitting)
- No external dependencies for core modules
- TypeScript strict mode
- Comments in English

## PR Checklist

- [ ] Tests pass (`npm test`)
- [ ] TypeScript compiles (`npx tsc --noEmit`)
- [ ] No new dependencies in core modules
- [ ] CHANGELOG.md updated
- [ ] Works with both OpenCode and standalone usage

## License

By contributing, you agree that your contributions will be licensed under
the MIT License.
