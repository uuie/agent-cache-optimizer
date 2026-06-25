# Changelog

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
