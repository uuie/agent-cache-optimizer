# Changelog

## 0.4.0 — 2026-06-25

### Added
- **Cache warming**: persist known-stable hashes to `warm-cache.json`; new sessions skip cold start
- **Savings tracking**: cumulative estimated $ savings in `savings.json`, displayed in `aco status`
- **Enhanced diag.log**: per-call stableKB + estimated $ saved + cumulative total
- **Conversation log adapter**: append-only guidelines for maximizing cache across turns

### Changed
- `classify()` now accepts `warmHashes` for instant warm-state classification
- `aco status --json` includes savings + warm cache data
- `aco status` dashboard shows est. savings and warm cache count

## 0.2.1 — 2026-06-24

### Fixed
- Binary renamed from `aco` to `agent-cache-optimizer` (aco was taken on npm)

## 0.2.0 — 2026-06-24

### Added
- `agent-cache-optimizer` CLI binary (replaces skill-based slash command)
- `aco status` / `aco status --json` commands

## 0.1.0 — 2026-06-24

### Added

- **Core engine**: content-agnostic hash-based stability tracking (`core.ts`)
- **Cold-start heuristics**: universal position/size/structure signals (`heuristics.ts`)
- **Block splitting**: automatic splitting of >4KB blocks at JSON/Markdown/XML boundaries (`splitting.ts`)
- **OpenCode plugin**: `experimental.chat.system.transform` hook for runtime prompt reordering
- **Per-agent tracking**: isolated stability databases for orchestrator/oracle/fixer/etc.
- **Diagnostics**: `chat.params` fallback logging, `diag.log` audit trail
- **Provider headers**: automatic Anthropic `prompt-caching-2024-07-31` header via `chat.headers`
- **Status dashboard**: `/cache-status` slash command + `cache-status.sh` CLI script
- **Cache audit tool**: `check-cache-friendly.sh` for scanning config files
- **Claude Code adapter**: optimization guidelines document
- **Documentation**: bilingual README (EN + zh-CN), cross-CLI architecture docs
