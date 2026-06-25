# Changelog

## 0.6.0 — 2026-06-25

### Added

- **Model-scoped tracking**: databases and warm caches are now keyed by `provider__model__agent` instead of just agent name, enabling correct per-provider/model stability tracking across multi-model setups
- **Block splitting v2**: robust brace-depth JSON parser handles arbitrary nesting, escaped strings, consecutive objects (not just arrays), and XML sibling elements. Markdown section splitting respects fenced code blocks. Long top-level lists (3+ items) are split into individual items.
- **Volatile metadata detection**: cold-start heuristics now detect and cap blocks containing dynamic meta-info patterns (`currentDate`, `session ID`, `timestamp`, `last updated`, `ISO timestamp`) even when structural heuristics would otherwise boost them to stable
- **Provider cache metrics**: real cache hit rate tracking from OpenCode provider events (`cacheReadTokens`, `cacheWriteTokens`, `cacheHitRate`) stored in `cache-metrics.json` with per-scope and total aggregation
- **Structured event logging**: all significant events written to `events.jsonl` with content-hashed IDs for privacy-preserving observability
- **Enhanced CLI**: `agent-cache-optimizer status` now displays cache hit rate, structured event counts, and properly handles scoped warm cache format

### Changed

- **Two-tier classification**: simplified from 3 tiers (stable/unknown/dynamic) to 2 tiers (stable/dynamic) with 0.5 threshold, effectively eliminating the "unknown" bucket
- **Warm cache v2**: upgraded format with `global` + per-scope hash sets; hashes stable across multiple scopes are promoted to global for cross-scope cache warming
- **Warm cache durability**: hashes persist across sessions unless absent from ALL scopes (not just removed on first scope change)
- **Content-addressable snapshot keys**: session and item IDs in cache metrics are content-hashed to avoid leaking sensitive identifiers
- Cold-start classification now routes 0.5-score blocks to stable instead of unknown

### Fixed

- Cumulative savings no longer double-counted (was multiplying by observation count twice)
- Metrics deduplication: zero-delta provider events are skipped after the first recording

## 0.5.4 — 2026-06-25

### Added

- **Disk space management**: diag.log rotates at 50KB/1000 lines
- **Stale hash pruning**: auto-removes hashes unseen for 7 days with count≤2
- **VERSION const**: version logged in plugin startup message

### Fixed

- Migration detects missing `contentObservations` and resets cleanly

## 0.5.3 — 2026-06-25

### Changed

- `VERSION` constant replaces hardcoded version strings
- Migration logic simplified: full reset when `contentObservations` missing

## 0.5.2 — 2026-06-25

### Fixed

- `contentObservations` field properly tracked (was missing after migration)

## 0.5.1 — 2026-06-25

### Fixed

- Auto-migrate pre-0.5 DBs on load (rebuild contentIndex from positions)
- `contentObservations` separate from `observations` for accurate content scoring

## 0.5.0 — 2026-06-25

### Added

- **Content-addressed block matching** (Irminsul-lite): track blocks by hash regardless of position
- `contentIndex` + `contentScores` in StabilityDB for position-independent tracking
- `updateContentDB()` for per-call content fingerprinting
- `lookupContentScore()` for position-independent score queries
- Classification priority: warm cache → content score → position score → cold start

### Changed

- Stable block identification improved from ~1/25 to 25/25 in production

## 0.4.0 — 2026-06-25

### Added

- **Cache warming**: persist known-stable hashes to `warm-cache.json`
- **Savings tracking**: cumulative estimated $ savings in `savings.json`
- **Enhanced diag.log**: per-call stableKB + estimated $ saved + cumulative total
- **Conversation log adapter**: append-only cache optimization guidelines

## 0.2.1 — 2026-06-24

### Fixed

- Binary renamed from `aco` to `agent-cache-optimizer` (`aco` was taken on npm)

## 0.2.0 — 2026-06-24

### Added

- `agent-cache-optimizer` CLI (replaces skill-based slash command)
- `agent-cache-optimizer status` and `--json` commands

## 0.1.0 — 2026-06-24

### Added

- Core engine: content-agnostic hash-based stability tracking
- Cold-start heuristics: universal position/size/structure signals
- Block splitting for >4KB blocks at JSON/Markdown/XML boundaries
- OpenCode plugin: `experimental.chat.system.transform` hook
- Per-agent tracking, diagnostics, Anthropic prompt-caching header
- Bilingual README (EN + zh-CN)
