# Cross-Agent Cache Hit Design

Date: 2026-06-25

## Goal

Improve DeepSeek prefix-cache hit rate when OpenCode switches between agents such
as `build`, `review`, and `plan`.

The plugin already moves stable system blocks before dynamic blocks. The missing
piece is that stable blocks are learned and ordered mostly inside
`provider__model__agent` scopes. After an agent switch, shared blocks can still
appear after an agent-specific prompt block, shortening the byte-identical prefix
that DeepSeek can reuse.

## Constraints

- Keep the plugin content-agnostic: use hashes and structural metadata only.
- Do not edit prompt text. Only reorder system blocks.
- Preserve per-agent observability and stability databases.
- Keep behavior safe for non-DeepSeek providers that also use prefix caching.
- Avoid configuration requirements for the default path.

## Design

Add a model-family learning layer alongside the existing per-agent scope.

Current scope:

```text
provider__model__agent
```

New family scope:

```text
provider__model
```

Each transform updates both databases. The agent scope keeps local behavior and
metrics. The family scope learns which block hashes are stable across multiple
agents using the same provider/model.

The reordered system prompt becomes:

```text
sharedStable -> scopedStable -> coldStable -> dynamic
```

`sharedStable` contains hashes that are stable in the family scope or promoted to
the global warm cache. These blocks form the cross-agent prefix and should appear
before agent-specific prompt blocks. `scopedStable` contains hashes stable only
for the current agent. `coldStable` contains blocks that cold-start heuristics
consider stable but the family learner has not confirmed yet.

## Data Flow

1. Resolve the current agent scope from OpenCode session events.
2. Resolve the family scope from provider and model only.
3. Split system blocks using the existing splitter.
4. Load both stability DBs and warm-cache data.
5. Classify each block using the existing classifier.
6. Rank stable blocks by shared status first, then scoped status, then current
   order as a deterministic fallback.
7. Persist both DBs after reorder.
8. Record diagnostics for shared-prefix size and hash counts.

## Components

- `familyScope(model)`: returns `provider__model`.
- `rankStableBlocks(...)`: partitions classified stable blocks into shared,
  scoped, and cold stable groups.
- Warm cache shape: keep existing v2 format but expose separate `global`,
  `family`, and `scope` membership to ranking code instead of only returning a
  merged set.
- Diagnostics: add `sharedStable`, `scopedStable`, `coldStable`, and
  `sharedPrefixBytes` to structured transform events.

## Error Handling

All new storage remains best-effort like the existing DBs. If the family DB or
warm cache cannot be read, the plugin falls back to the current per-agent
classification and reorder behavior. Failed family writes should log an error
event but must not block the chat request.

## Testing

Add focused Vitest coverage:

- Two agents with the same provider/model and shared tool blocks should place
  shared blocks before agent-specific stable blocks after family learning.
- Per-agent DB files should still be written.
- Metrics should still aggregate by `provider__model__agent`.
- Family DB read/write failures should not prevent transform output.
- Existing warm-cache promotion tests should continue to pass.

## Non-Goals

- No conversation-log rewrite.
- No prompt text mutation or marker insertion.
- No manual pinning UI in this change.
- No provider-specific DeepSeek branching.
