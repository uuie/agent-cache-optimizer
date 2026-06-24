# Changelog

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
