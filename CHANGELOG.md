# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Manual swap signal — `SIGUSR1` now triggers an immediate swap to the next best account without invoking the admin-disabled blocklist or the sleep-until-reset branch. Use `kill -USR1 <claude-nonstop-pid>` (or `pkill -USR1 -f claude-nonstop`) when an upstream CLI banner-format change causes automatic detection to miss a stuck session.
- `normalizeBannerBuffer()` helper — strips ANSI sequences, removes Unicode box-drawing/block-element glyphs (U+2500–U+259F), and collapses whitespace runs into a single space. Used by admin-disable detection so the genuine box-drawn banner reassembles into a contiguous string before regex matching.

### Changed

- Output buffer enlarged from 4 KB → 8 KB (`OUTPUT_BUFFER_MAX`) and trim retention from 2 KB → 4 KB (`OUTPUT_BUFFER_TRIM`). 50% retention guarantees the genuine admin-disable banner cannot be split across a trim boundary even under bursty PTY output that briefly fills the buffer.

### Fixed

- Admin-disable detection no longer requires both banner sentences on adjacent lines (regression from 3ae6cd5) nor the tightened single-sentence form (b1f3b85). Both tightenings missed the genuine Claude Code banner because the disabled-state sentence is wrapped across PTY lines bounded by `│` glyphs (e.g. `│ Your usage allocation has been disabled by  │\n│ your admin       │`), so the literal phrase was never contiguous in the buffer. The detector now applies `normalizeBannerBuffer()` (strip ANSI + box-drawing + collapse whitespace) before testing the simplified single-sentence pattern. Trade-off: model output or pasted logs containing the exact phrase will also trigger a swap; bypass via `CLAUDE_NONSTOP_DISABLE_ADMIN_DETECT=1`.

## [0.2.0] - 2025-06-15

### Added

- Multi-account switching with automatic rate limit detection
- Slack remote access with per-session channels
- Account management commands (`add`, `remove`, `list`, `status`, `reauth`)
- Claude Code hook integration (`SessionStart`, `Stop`)
- Socket Mode webhook for Slack message relay
- Session migration between accounts (`.jsonl` + `tool-results/`)
- Usage API integration with best-account scoring
- tmux session management for remote access
- Interactive `setup` command for Slack configuration
- Hook installation and status commands

### Security

- Account name validation — alphanumeric, hyphens, underscores only; path traversal blocked (prevents malicious names like `../etc`)
- Command injection prevention — all subprocess calls use `execFile` with array arguments, never shell string interpolation
- Tmux message length truncation — 4096 char limit prevents terminal flooding from Slack relay
- User data isolation — all runtime data stored in `~/.claude-nonstop/`, not in the project directory
- Atomic writes for `channel-map.json` — write-to-temp + rename prevents corruption from concurrent access
- Stale channel-map entry pruning — inactive entries auto-removed after 7 days to limit data accumulation

## [0.1.0] - 2025-05-01

### Added

- Initial implementation
- Basic account switching
- Slack integration prototype
