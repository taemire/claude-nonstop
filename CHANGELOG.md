# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`swap <target>` command** — ergonomic mid-session account swap precursor.
  A running Claude Code process loads OAuth credentials at startup and cannot
  swap them in-place; the proper procedure is exit → `use <target>` →
  `resume <id> --account=<target>`. `swap` does the validation up front
  (target exists, has token, quota previewed) and auto-detects the current
  session id for the cwd, then prints the exact `resume` 1-liner to paste
  after exit. Catches typos / missing creds BEFORE the user kills their
  active session.
  - `--session=<id>` to override session auto-detection
  - `--quiet` to print only the resume command (script-friendly, e.g. `swap fourth --quiet | pbcopy`)
- Manual swap signal — `SIGUSR1` now triggers an immediate swap to the next best account without invoking the admin-disabled blocklist or the sleep-until-reset branch. Use `kill -USR1 <claude-nonstop-pid>` (or `pkill -USR1 -f claude-nonstop`) when an upstream CLI banner-format change causes automatic detection to miss a stuck session.
- `normalizeBannerBuffer()` helper — strips ANSI sequences, removes Unicode box-drawing/block-element glyphs (U+2500–U+259F), and collapses whitespace runs into a single space. Used by admin-disable detection so the genuine box-drawn banner reassembles into a contiguous string before regex matching.
- `ADMIN_DISABLE_KEYWORDS` + `detectAdminDisabled()` — drift-tolerant keyword-AND fallback for admin-disable detection. When all four markers (`usage allocation`, `has been disabled`, `/extra-usage`, `by your admin`) appear in the normalized buffer, the swap fires even if the literal sentence was splintered by upstream renderer choices (cursor positioning, alternate-screen redraws, glyphs outside the box-drawing range). False-positive risk stays low: a model paraphrasing the disabled state may echo one or two markers, but emitting all four including the literal `/extra-usage` slash command within an 8 KB window is implausible.
- Diagnostic mode — `CLAUDE_NONSTOP_DEBUG_DETECT=1` appends a one-line record to `~/.claude-nonstop/debug-detect.log` on every PTY chunk, capturing the normalized + raw buffer tails plus match verdict. Independent of the escape hatch (`CLAUDE_NONSTOP_DISABLE_ADMIN_DETECT`) so missed banners can be reconstructed post-hoc even when the swap action itself is suppressed. Best-effort logging — runner never fails if the file is unwritable.

### Changed

- Output buffer enlarged from 4 KB → 8 KB (`OUTPUT_BUFFER_MAX`) and trim retention from 2 KB → 4 KB (`OUTPUT_BUFFER_TRIM`). 50% retention guarantees the genuine admin-disable banner cannot be split across a trim boundary even under bursty PTY output that briefly fills the buffer.
- `stripAnsi()` widened to cover DEC private CSI (`ESC [ ? 25 l` and friends), CSI with intermediate bytes, OSC sequences terminated by ST (`ESC \`) in addition to BEL, and single-character escape forms (`ESC =`, `ESC >`, `ESC P`, `ESC \`). The earlier `\x1b\[[0-9;]*[a-zA-Z]` form left ESC bytes wedged between letters when modern TUI renderers emitted these alongside banner text, breaking downstream substring matching.
- `normalizeBannerBuffer()` glyph range widened from U+2500–U+259F (Box Drawing + Block Elements) to U+2500–U+25FF (adds Geometric Shapes), and now also strips residual control characters (`\x00-\x1F\x7F`). Banners that use `■`/`▶`/list-corner variants outside the old range previously survived normalization with stray glyphs that broke whitespace collapse around them.

### Fixed

- Admin-disable detection no longer requires both banner sentences on adjacent lines (regression from 3ae6cd5) nor the tightened single-sentence form (b1f3b85). Both tightenings missed the genuine Claude Code banner because the disabled-state sentence is wrapped across PTY lines bounded by `│` glyphs (e.g. `│ Your usage allocation has been disabled by  │\n│ your admin       │`), so the literal phrase was never contiguous in the buffer. The detector now applies `normalizeBannerBuffer()` (strip ANSI + box-drawing + collapse whitespace) before testing the simplified single-sentence pattern. Trade-off: model output or pasted logs containing the exact phrase will also trigger a swap; bypass via `CLAUDE_NONSTOP_DISABLE_ADMIN_DETECT=1`.
- Admin-disable detection survives banner-format drift to the list-item-corner shape observed 2026-05-01 (`└ Your usage allocation has been disabled by your admin\n  /extra-usage to request more usage from your admin.`) and to renderer choices that splinter the literal sentence across non-contiguous buffer regions. The widened ANSI/glyph normalization plus keyword-AND fallback (`detectAdminDisabled()`) jointly close both regressions; 9 new tests in `test/unit/lib/admin-disable-pattern.test.js` lock the contract.

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
