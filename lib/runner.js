/**
 * Process runner — spawns Claude Code, monitors output for rate limits,
 * and automatically switches accounts with session migration.
 *
 * Flow:
 * 1. Spawn `claude` with CLAUDE_CONFIG_DIR pointing to selected account
 * 2. Pipe stdout/stderr through to the user's terminal (real-time pass-through)
 * 3. Simultaneously scan output for rate limit patterns
 * 4. On rate limit detection:
 *    a. Kill the paused Claude process
 *    b. Find the active session file
 *    c. Migrate session to the next best account's config dir
 *    d. Resume with `claude --resume <sessionId>` using the new account
 */

import * as pty from 'node-pty';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { readCredentials } from './keychain.js';
import { checkAllUsage, checkUsage } from './usage.js';
import { pickBestAccount, effectiveUtilization } from './scorer.js';
import { findLatestSession, migrateSession } from './session.js';
import { reauthExpiredAccounts } from './reauth.js';
import { CONFIG_DIR } from './config.js';
import { getCurrentTmuxSession } from './tmux.js';
import { markAdminDisabled, getAdminDisabledNames } from './admin-disabled.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_NOTIFY_PATH = path.resolve(__dirname, '..', 'remote', 'hook-notify.cjs');

// ─── Diagnostic Logging ────────────────────────────────────────────────────
// Mirror console.error to a date-rotated log file. Required because the
// claude PTY repaints the screen on (re)launch and rate-limit-swap decisions
// printed to stderr scroll out of the user's terminal before they can be
// read. The log lets us see *why* a swap or exit happened post-mortem.
const RUNNER_LOG_PATH = path.join(
  CONFIG_DIR,
  `runner-${new Date().toISOString().slice(0, 10)}.log`,
);
const _origConsoleError = console.error.bind(console);
console.error = (...args) => {
  _origConsoleError(...args);
  try {
    const line = args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    fs.appendFileSync(RUNNER_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {}
};

/**
 * Rate limit detection pattern.
 * Claude Code outputs either:
 *   "Limit reached · resets Dec 17 at 6am (Europe/Oslo)"
 *   "You've hit your limit · resets 8am (America/Los_Angeles)"
 */
const RATE_LIMIT_PATTERN = /(?:Limit reached|You've hit your limit)\s*[·•]\s*resets\s+(.+?)(?:\s*$|\n)/im;

/**
 * Claude Code interactive input box marker.
 * The prompt line looks like `│ > …` once the UI is fully drawn (i.e. after
 * any session-resume replay finishes). Used as the primary gate for
 * rate-limit / admin-disabled detection so we don't match against replayed
 * conversation history that happens to contain a prior banner.
 */
const PROMPT_MARKER_PATTERN = /│\s*>/;

/**
 * Time after spawn before detection activates unconditionally (timeout
 * fallback for environments where the prompt marker never appears, e.g.,
 * the workspace-trust dialog blocks UI render). Tradeoff: a real
 * startup-time rate-limit hitting before the gate opens may be missed, but
 * that is far less harmful than false-positive thrashing across all
 * accounts triggered by replayed conversation content.
 */
const SPAWN_GRACE_MS = 4000;

/**
 * Admin-disabled allocation detection pattern.
 * Workspace admins on Teams/Enterprise plans can disable an account's
 * usage allocation; when they do, Claude Code surfaces this exact phrase
 * inside a box-drawn banner:
 *   "Your usage allocation has been disabled by your admin"
 *
 * Unlike rate-limits, this condition does NOT reset on a clock — only an
 * admin can re-enable the allocation. We treat it as a signal to swap
 * immediately and persist the account on a blocklist so subsequent
 * session starts avoid it for the TTL window.
 *
 * Why single-sentence detection: the genuine CLI banner is rendered with
 * box-drawing characters that wrap the sentence across PTY lines, e.g.
 * "│ Your usage allocation has been disabled by  │\n│ your admin       │".
 * Earlier "two-line adjacency" tightening (3ae6cd5) and "single sentence
 * with surrounding context" tightening (b1f3b85) both missed real banners
 * for this reason. The detector now strips ANSI + box-drawing glyphs and
 * collapses whitespace via normalizeBannerBuffer() before matching, so the
 * wrapped sentence reassembles into a contiguous string.
 *
 * Trade-off: the model echoing this exact phrase inside its own response
 * (or a user pasting it) will also trigger a swap. Use the escape hatch
 * CLAUDE_NONSTOP_DISABLE_ADMIN_DETECT=1 to bypass detection entirely.
 */
const ADMIN_DISABLE_PATTERN = /Your usage allocation has been disabled by your admin/i;

/**
 * Keyword set serving as a drift-tolerant fallback for admin-disable
 * detection. When ALL four markers appear in the normalized buffer the
 * banner is recognized even if upstream rendering breaks the literal
 * sentence into pieces our normalizer doesn't reassemble (e.g. cursor
 * positioning, alternate-screen redraws, glyphs outside U+2500–U+25FF).
 *
 * Why all-of: a model paraphrasing the disabled state may echo one or two
 * markers; emitting all four — including the literal `/extra-usage` slash
 * command — within an 8 KB window in normal prose is implausible.
 */
const ADMIN_DISABLE_KEYWORDS = [
  /usage allocation/i,
  /has been disabled/i,
  /\/extra-usage/i,
  /by your admin/i,
];

/** Maximum output buffer size before trimming (bytes). */
const OUTPUT_BUFFER_MAX = 8192;
/** Buffer trim target (bytes). 50% retention so the genuine two-line banner
 *  (≈150 bytes) cannot be split across a trim boundary even under bursty PTY
 *  output that briefly fills the buffer. */
const OUTPUT_BUFFER_TRIM = 4096;
/** Maximum number of account swaps before giving up. */
const MAX_SWAPS_DEFAULT = 5;
/** Message sent to auto-continue after rate-limit account switch. */
const RATE_LIMIT_CONTINUE_MSG = 'Continue.';
/** Time to wait before SIGKILL after SIGTERM (ms). */
const KILL_ESCALATION_DELAY = 3000;
/** Utilization threshold (%) at which all accounts are considered near-exhausted. */
const EXHAUSTION_THRESHOLD = 99;
/** Maximum sleep duration when waiting for a rate limit reset (6 hours). */
const MAX_SLEEP_MS = 6 * 60 * 60 * 1000;

/**
 * False-positive verification threshold for admin-disabled detection.
 * When the banner is detected, the OAuth usage API is queried for the
 * current account; if both 5h and 7d utilization are strictly below this
 * threshold, the detection is treated as a false positive (replay residue,
 * sub-agent output, or transient server flap) and the same account is
 * restarted instead of blocklisted. At-or-above the threshold the account
 * is genuinely capped and the blocklist + swap path proceeds.
 */
const ADMIN_DISABLE_VERIFY_THRESHOLD = 95;

/**
 * Cap on consecutive admin-disabled false-positive restarts on the same
 * account. After this many in a row, fall through to the normal
 * blocklist + swap path even if the API still says under-threshold —
 * avoids a tight restart loop if the trigger phrase keeps recurring.
 */
const MAX_CONSECUTIVE_ADMIN_FALSE_POSITIVES = 3;

// ─── ANSI Stripping ────────────────────────────────────────────────────────

/**
 * Strip ANSI escape sequences (colors, cursor moves, mode changes, OSC
 * window-title queries, single-character escape forms) from PTY output.
 *
 * The earlier `/\x1b\[[0-9;]*[a-zA-Z]/g` form missed common cases that
 * modern TUI renderers emit alongside banner text:
 *   - DEC private-mode CSI like `ESC [ ? 25 l` (cursor hide) — `?` and `2`
 *     fall outside `[0-9;]`, leaving `ESC [ ?` un-stripped and disrupting
 *     downstream substring matching.
 *   - CSI with intermediate bytes (`SP-/`, e.g. `ESC [ 1 SP q` for cursor
 *     style) — never matched at all.
 *   - OSC sequences terminated by ST (`ESC \`) rather than BEL — also
 *     never matched.
 *   - Single-character escapes (`ESC =`, `ESC >`, `ESC P`, `ESC \`).
 *
 * Without these, leftover ESC bytes wedge between letters and downstream
 * `normalizeBannerBuffer` whitespace collapse cannot rejoin them.
 */
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[\x30-\x3F]*[\x20-\x2F]*[\x40-\x7E]/g, '') // CSI: parameter + intermediate + final
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')         // OSC: BEL- or ST-terminated
    .replace(/\x1b[NOPVX_^=>]/g, '')                            // Two-byte escape forms
    .replace(/\x1b\\/g, '');                                    // Stray ST
}

/**
 * Normalize a PTY buffer for banner-pattern matching: strip ANSI sequences,
 * remove Unicode box-drawing/block-element/geometric-shape glyphs
 * (U+2500–U+25FF), drop residual control characters, and collapse all
 * whitespace runs (incl. CRLF + box padding) into a single space.
 *
 * The earlier `[─-▟]` (U+2500–U+259F) range covered Box Drawing + Block
 * Elements but missed Geometric Shapes (U+25A0–U+25FF) — banners that
 * use `■` `▶` or list-corner variants outside the old range survive
 * normalization with stray glyphs that break the literal sentence.
 *
 * Residual control-char stripping (`\x00-\x1F`, `\x7F`) catches lone ESC
 * bytes left over when a CSI sequence is malformed, plus BEL/CR
 * carryovers, so the cleaned buffer is plain printable text + spaces.
 */
function normalizeBannerBuffer(str) {
  return stripAnsi(str)
    .replace(/[─-◿]+/g, ' ')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Two-strategy admin-disable detection on the normalized buffer:
 *   1. Direct phrase match — `ADMIN_DISABLE_PATTERN` against normalized text.
 *   2. Keyword-AND fallback — all four `ADMIN_DISABLE_KEYWORDS` present.
 *
 * The fallback exists because banner format drift on the upstream CLI has
 * historically broken phrase matching (regressions 3ae6cd5, b1f3b85, and
 * the list-item-corner variant observed 2026-05-01). Requiring all four
 * markers keeps false-positive risk low while letting the detector
 * survive future renderer choices that splinter the literal sentence.
 *
 * @param {string} buffer - Raw PTY accumulator (will be normalized internally).
 * @returns {{ matched: boolean, via: 'phrase'|'keyword-and'|null, normalized: string }}
 */
function detectAdminDisabled(buffer) {
  const normalized = normalizeBannerBuffer(buffer);
  if (ADMIN_DISABLE_PATTERN.test(normalized)) {
    return { matched: true, via: 'phrase', normalized };
  }
  if (ADMIN_DISABLE_KEYWORDS.every((re) => re.test(normalized))) {
    return { matched: true, via: 'keyword-and', normalized };
  }
  return { matched: false, via: null, normalized };
}

/**
 * Spawn hook-notify.cjs fire-and-forget with data on stdin.
 */
function spawnHookNotify(type, data) {
  const child = execFile('node', [HOOK_NOTIFY_PATH, type], {
    timeout: 15_000,
    stdio: ['pipe', 'ignore', 'ignore'],
  }, () => {});
  child.stdin.write(JSON.stringify(data));
  child.stdin.end();
  child.unref();
}

/**
 * Find the earliest reset time across all non-excluded accounts.
 *
 * @param {Array<{name: string, usage: object}>} accounts
 * @param {string} [excludeName] - Account name to skip
 * @returns {number} Milliseconds until earliest reset (0 if no reset info available)
 */
function findEarliestReset(accounts, excludeName) {
  const now = Date.now();
  let earliest = Infinity;

  for (const a of accounts) {
    if (a.name === excludeName) continue;
    if (!a.usage) continue;

    for (const ts of [a.usage.sessionResetsAt, a.usage.weeklyResetsAt]) {
      if (!ts) continue;
      const resetMs = new Date(ts).getTime();
      if (isNaN(resetMs)) continue;
      if (resetMs > now && resetMs < earliest) {
        earliest = resetMs;
      }
    }
  }

  if (earliest === Infinity) return 0;
  return earliest - now;
}

/**
 * Format a duration in ms to a human-readable string like "2h 15m".
 */
function formatDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Sleep for the given number of milliseconds.
 * Interruptible: SIGINT or SIGTERM will resolve the sleep early.
 *
 * @param {number} ms
 * @returns {Promise<{ interrupted: boolean }>}
 */
function sleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ interrupted: false });
    }, ms);

    function onSignal() {
      cleanup();
      resolve({ interrupted: true });
    }

    function cleanup() {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

/**
 * Deactivate stale channel-map entries for a tmux session.
 * Called at startup so that reuseChannelForTmuxSession only matches
 * entries created during the current invocation (e.g., /clear or rate-limit restart),
 * not leftover entries from a previous run.
 *
 * @param {string} tmuxSessionName - The tmux session name to match
 * @param {string} [channelMapPath] - Path to channel-map.json (default: CONFIG_DIR/data/channel-map.json)
 */
function deactivateStaleChannels(tmuxSessionName, channelMapPath) {
  if (!channelMapPath) {
    channelMapPath = path.join(CONFIG_DIR, 'data', 'channel-map.json');
  }
  try {
    if (!fs.existsSync(channelMapPath)) return;
    const raw = fs.readFileSync(channelMapPath, 'utf8');
    if (!raw.trim()) return;
    const map = JSON.parse(raw);

    let changed = false;
    for (const entry of Object.values(map)) {
      if (entry.tmuxSession === tmuxSessionName && entry.active) {
        entry.active = false;
        changed = true;
      }
    }

    if (changed) {
      const dir = path.dirname(channelMapPath);
      const tmpFile = path.join(dir, `.channel-map.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tmpFile, JSON.stringify(map, null, 2), { mode: 0o600 });
      fs.renameSync(tmpFile, channelMapPath);
    }
  } catch {
    // Non-fatal — channel reuse is a convenience, not critical
  }
}

/**
 * Run Claude Code with automatic account switching.
 *
 * @param {string[]} claudeArgs - Arguments to pass to `claude`
 * @param {{ name: string, configDir: string }} selectedAccount - Account to use
 * @param {Array<{ name: string, configDir: string }>} allAccounts - All registered accounts
 * @param {{ maxSwaps?: number, remoteAccess?: boolean }} options - Runner options
 */
export async function run(claudeArgs, selectedAccount, allAccounts, options = {}) {
  // Scale swap budget with account count — with N accounts, you may need
  // N-1 swaps to try them all before exhaustion triggers the sleep mechanism.
  // The * 2 multiplier allows for accounts recovering mid-session (5-hour resets).
  const maxSwaps = options.maxSwaps ?? Math.max(MAX_SWAPS_DEFAULT, allAccounts.length * 2);
  const remoteAccess = options.remoteAccess ?? false;
  let currentAccount = selectedAccount;
  let swapCount = 0;
  let sessionId = extractResumeSessionId(claudeArgs);
  // Counter for back-to-back admin-disabled detections that the OAuth usage
  // API contradicted (utilization well below the verify threshold). Reset
  // when an admin-disabled is verified real, when a rate-limit/manual swap
  // fires, or when the cap is hit.
  let consecutiveAdminFalsePositives = 0;

  // Deactivate stale channel entries from previous invocations so that
  // reuseChannelForTmuxSession only matches entries from this run
  // (i.e., /clear or rate-limit restarts within the same tmux session).
  if (remoteAccess) {
    deactivateStaleChannels(getCurrentTmuxSession());
  }

  while (swapCount <= maxSwaps) {
    const result = await runOnce(claudeArgs, currentAccount, sessionId, { remoteAccess });

    // Determine swap reason. Rate-limit and admin-disable both demand a swap,
    // but admin-disable additionally persists the account on a blocklist
    // (no clock reset; only an admin can re-enable) and skips the
    // sleep-until-reset thrash-avoidance branch below. Manual swap (SIGUSR1)
    // behaves like admin-disable for routing purposes (skip sleep, no
    // blocklist) — it's an explicit user override.
    const swapReason = result.rateLimitDetected
      ? 'rate-limit'
      : (result.adminDisableDetected
        ? 'admin-disabled'
        : (result.manualSwapRequested ? 'manual' : null));

    if (!swapReason) {
      // Normal/signal exit — propagate the exit code
      process.exitCode = result.exitCode ?? 1;
      return;
    }

    // Admin-disabled false-positive guard.
    // The banner phrase can leak through sub-agent stdout (Codex / nested
    // tools), `claude --resume` replay residue, or transient server flaps
    // on accounts with plenty of headroom. Blocklisting on the first
    // sighting locks a healthy account out for 24h. Verify against the
    // OAuth usage API first; only blocklist + swap when verification
    // confirms the account is at-or-above the verify threshold (or the
    // API call itself fails / the false-positive cap is exhausted).
    if (swapReason === 'admin-disabled' &&
        consecutiveAdminFalsePositives < MAX_CONSECUTIVE_ADMIN_FALSE_POSITIVES) {
      const cred = readCredentials(currentAccount.configDir);
      if (cred.token) {
        const usage = await checkUsage(cred.token);
        const apiOk = !usage.error;
        const belowThreshold =
          usage.sessionPercent < ADMIN_DISABLE_VERIFY_THRESHOLD &&
          usage.weeklyPercent < ADMIN_DISABLE_VERIFY_THRESHOLD;

        if (apiOk && belowThreshold) {
          consecutiveAdminFalsePositives++;
          console.error(
            `\n[claude-nonstop] Admin-disabled message on "${currentAccount.name}" but usage API ` +
            `reports 5h=${usage.sessionPercent}% 7d=${usage.weeklyPercent}% ` +
            `(threshold ${ADMIN_DISABLE_VERIFY_THRESHOLD}%). Treating as false positive ` +
            `(${consecutiveAdminFalsePositives}/${MAX_CONSECUTIVE_ADMIN_FALSE_POSITIVES}); ` +
            `restarting on same account without swap.`
          );

          // Carry session forward on the same account so work resumes.
          const restartSession = result.sessionId
            ? { sessionId: result.sessionId }
            : findLatestSession(currentAccount.configDir, process.cwd());
          if (restartSession) {
            sessionId = restartSession.sessionId;
            claudeArgs = buildResumeArgs(claudeArgs, sessionId, RATE_LIMIT_CONTINUE_MSG);
          } else {
            sessionId = null;
          }
          continue;
        }
      }
    }

    // Past the verify gate — admin-disabled is real (or unverifiable, or
    // false-positive cap reached). Reset the counter and proceed with
    // the normal blocklist + swap path. Rate-limit / manual swap also
    // reset the counter since a real swap clears the streak.
    consecutiveAdminFalsePositives = 0;

    if (swapReason === 'admin-disabled') {
      markAdminDisabled(currentAccount.name, { reason: 'admin-disabled prompt detected during runOnce' });
    }

    // Trigger detected — attempt swap
    swapCount++;
    if (swapReason === 'admin-disabled') {
      console.error(`\n[claude-nonstop] Admin disabled allocation on "${currentAccount.name}" — added to blocklist (swap ${swapCount}/${maxSwaps})`);
    } else if (swapReason === 'manual') {
      console.error(`\n[claude-nonstop] Manual swap from "${currentAccount.name}" (swap ${swapCount}/${maxSwaps})`);
    } else {
      console.error(`\n[claude-nonstop] Rate limit detected on "${currentAccount.name}" (swap ${swapCount}/${maxSwaps})`);
    }

    if (swapCount > maxSwaps) {
      console.error('[claude-nonstop] Maximum swap attempts reached. All accounts may be rate-limited or admin-disabled.');
      process.exitCode = 1;
      return;
    }

    // Find the session to migrate
    const cwd = process.cwd();
    const session = result.sessionId
      ? { sessionId: result.sessionId }
      : findLatestSession(currentAccount.configDir, cwd);

    if (!session) {
      console.error('[claude-nonstop] Could not find session to migrate. Starting fresh on new account.');
    }

    // Pick the next best account, excluding admin-disabled blocklist entries
    const accountsWithTokens = allAccounts.map(a => ({
      ...a,
      token: readCredentials(a.configDir).token,
    })).filter(a => a.token);

    let accountsWithUsage = await checkAllUsage(accountsWithTokens);
    const hasPriorities = accountsWithUsage.some(a => a.priority != null);
    let blocklist = getAdminDisabledNames();
    let best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities, excludeNames: blocklist });

    // Skip the sleep-until-reset branch when the trigger was admin-disable —
    // there is no clock-based reset to wait for. Fall through to swap or exit.
    // If best candidate is near-exhausted, sleep until earliest reset instead of thrashing.
    // Include all accounts (even current) when finding reset times — after sleeping,
    // any account may have recovered, including the one that just hit the limit.
    //
    // TODO: For remote mode, consider an event-driven approach instead of blocking sleep:
    //   1. Notify Slack and save session state to disk
    //   2. Exit the runner cleanly
    //   3. Slack bot schedules a re-launch at the reset time (or user sends !resume)
    // This would free the tmux pane instead of holding it for hours.
    if (swapReason === 'rate-limit' && best && effectiveUtilization(best.account.usage) >= EXHAUSTION_THRESHOLD) {
      const sleepMs = findEarliestReset(accountsWithUsage);
      if (sleepMs > 0) {
        const clampedMs = Math.min(sleepMs, MAX_SLEEP_MS);
        const resetDate = new Date(Date.now() + clampedMs);
        console.error(`[claude-nonstop] All accounts near limit. Sleeping until ${resetDate.toLocaleTimeString()} (${formatDuration(clampedMs)})...`);

        if (remoteAccess) {
          spawnHookNotify('sleep-until-reset', {
            session_id: sessionId || null,
            cwd: process.cwd(),
            current_account: currentAccount.name,
            sleep_ms: clampedMs,
            reset_at: resetDate.toISOString(),
          });
        }

        const { interrupted } = await sleep(clampedMs);
        if (interrupted) {
          console.error('\n[claude-nonstop] Sleep interrupted by signal. Exiting.');
          process.exitCode = 130;
          return;
        }

        console.error('[claude-nonstop] Sleep complete. Re-checking account usage...');

        // Re-fetch usage after sleeping — any account may have recovered,
        // including the current one, so don't exclude it from the pick.
        const refreshedTokens = allAccounts.map(a => ({
          ...a,
          token: readCredentials(a.configDir).token,
        })).filter(a => a.token);
        accountsWithUsage = await checkAllUsage(refreshedTokens);
        blocklist = getAdminDisabledNames();
        best = pickBestAccount(accountsWithUsage, undefined, { usePriority: hasPriorities, excludeNames: blocklist });

        if (remoteAccess) {
          spawnHookNotify('sleep-wake', {
            session_id: sessionId || null,
            cwd: process.cwd(),
            current_account: currentAccount.name,
            best_account: best?.account?.name || null,
          });
        }

        // Sleep-then-swap doesn't count against the swap budget — the sleep
        // itself is the mechanism to avoid thrashing, so this is a "free" swap.
        swapCount--;
      }
    }

    // If no accounts available, check if auth errors are the cause and attempt re-auth
    if (!best && !remoteAccess) {
      const authErrors = accountsWithUsage.filter(a =>
        a.name !== currentAccount.name && a.usage?.error === 'HTTP 401'
      );
      if (authErrors.length > 0) {
        console.error('[claude-nonstop] Some accounts have expired tokens. Attempting re-auth...');
        const refreshed = await reauthExpiredAccounts(authErrors);
        if (refreshed.length > 0) {
          // Re-read credentials and re-check usage
          const updatedAccounts = allAccounts.map(a => ({
            ...a,
            token: readCredentials(a.configDir).token,
          })).filter(a => a.token);
          accountsWithUsage = await checkAllUsage(updatedAccounts);
          blocklist = getAdminDisabledNames();
          best = pickBestAccount(accountsWithUsage, currentAccount.name, { usePriority: hasPriorities, excludeNames: blocklist });
        }
      }
    }

    if (!best) {
      console.error('[claude-nonstop] No alternative accounts available.');
      if (blocklist && blocklist.size > 0) {
        console.error(`[claude-nonstop] Admin-disabled blocklist: ${[...blocklist].join(', ')}`);
        console.error('[claude-nonstop] Run "claude-nonstop admin-disabled --clear" to reset the blocklist.');
      }
      process.exitCode = 1;
      return;
    }

    const nextAccount = best.account;
    console.error(`[claude-nonstop] Switching to "${nextAccount.name}" (${best.reason})`);

    // Notify Slack about account switch (fire-and-forget)
    if (remoteAccess) {
      spawnHookNotify('account-switch', {
        session_id: sessionId || null,
        cwd: process.cwd(),
        from_account: currentAccount.name,
        to_account: nextAccount.name,
        reason: best.reason,
        swap_count: swapCount,
        max_swaps: maxSwaps,
      });
    }

    // Migrate session if we have one
    if (session) {
      const migration = migrateSession(
        currentAccount.configDir,
        nextAccount.configDir,
        cwd,
        session.sessionId
      );

      if (migration.success) {
        sessionId = session.sessionId;
        console.error(`[claude-nonstop] Session ${sessionId} migrated successfully`);
      } else {
        console.error(`[claude-nonstop] Session migration failed: ${migration.error}`);
        console.error('[claude-nonstop] Starting fresh session on new account');
        sessionId = null;
      }
    } else {
      sessionId = null;
    }

    // Update args for resume if we have a session — include continuation
    // message so Claude picks up immediately instead of waiting for input
    if (sessionId) {
      claudeArgs = buildResumeArgs(claudeArgs, sessionId, RATE_LIMIT_CONTINUE_MSG);
    }

    currentAccount = nextAccount;
  }
}

/**
 * Run Claude once, monitoring for rate limits and admin-disabled allocation.
 *
 * Also responds to SIGUSR1 as a manual swap signal: when the user observes a
 * stuck session that the wrapper's automatic detection failed to catch (e.g.,
 * a banner-format change on the upstream CLI), `kill -USR1 <claude-nonstop-pid>`
 * (or `pkill -USR1 -f claude-nonstop`) forces an immediate swap to the next
 * best account without invoking the admin-disabled blocklist or the
 * sleep-until-reset branch.
 *
 * @returns {Promise<{ exitCode: number|null, rateLimitDetected: boolean, adminDisableDetected: boolean, manualSwapRequested: boolean, resetTime: string|null, sessionId: string|null }>}
 */
function runOnce(claudeArgs, account, existingSessionId, options = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: account.configDir,
      FORCE_COLOR: '1',
    };

    // Strip CLAUDECODE so spawned claude works from inside a Claude Code session
    delete env.CLAUDECODE;

    if (options.remoteAccess) {
      env.CLAUDE_REMOTE_ACCESS = 'true';
    }

    const child = pty.spawn('claude', claudeArgs, {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env,
    });

    // Resize PTY when the real terminal resizes
    const onResize = () => {
      try { child.resize(process.stdout.columns, process.stdout.rows); } catch {}
    };
    process.stdout.on('resize', onResize);

    // Forward stdin to the PTY (resume in case it was paused by a previous runOnce)
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const onStdinData = (data) => child.write(data);
    process.stdin.on('data', onStdinData);
    process.stdin.on('error', () => {});

    let rateLimitDetected = false;
    let adminDisableDetected = false;
    let manualSwapRequested = false;
    let resetTime = null;
    let outputBuffer = '';

    // Detection gate — suppresses false positives caused by `claude --resume`
    // replaying past conversation history (which can contain prior banners).
    // The gate opens on whichever fires first:
    //   A) prompt marker (`│ >`) seen — UI fully drawn, replay complete
    //   B) SPAWN_GRACE_MS timeout — fallback for environments where the
    //      marker never appears (e.g., trust dialog blocks UI render)
    // When the gate opens, outputBuffer is cleared so any pre-gate residue
    // is forgotten. Both rate-limit and admin-disabled detection are gated.
    let markerSeen = false;
    let timeoutFired = false;
    const gateOpen = () => markerSeen || timeoutFired;
    const graceTimer = setTimeout(() => {
      if (timeoutFired) return;
      timeoutFired = true;
      outputBuffer = '';
    }, SPAWN_GRACE_MS);

    // Diagnostic mode: when CLAUDE_NONSTOP_DEBUG_DETECT=1, append a one-line
    // record to ~/.claude-nonstop/debug-detect.log on every PTY chunk so a
    // missed banner can be reconstructed post-hoc from raw + normalized tails.
    // Independent of the escape hatch — the hatch only suppresses the swap
    // action; visibility into what the buffer looked like is always preserved.
    const debugDetect = /^(1|true|yes|on)$/i.test(
      process.env.CLAUDE_NONSTOP_DEBUG_DETECT || ''
    );
    const debugFile = path.join(CONFIG_DIR, 'debug-detect.log');

    child.onData((data) => {
      process.stdout.write(data);

      outputBuffer += data;
      if (outputBuffer.length > OUTPUT_BUFFER_MAX) {
        outputBuffer = outputBuffer.slice(-OUTPUT_BUFFER_TRIM);
      }

      if (rateLimitDetected || adminDisableDetected || manualSwapRequested) return;

      let stripped = stripAnsi(outputBuffer);

      // Marker activation — once observed, replay is complete. Discard any
      // accumulated buffer so prior banner text in replayed history is not
      // matched against on the very next chunk.
      if (!markerSeen && PROMPT_MARKER_PATTERN.test(stripped)) {
        markerSeen = true;
        outputBuffer = '';
        stripped = '';
      }

      if (!gateOpen()) return;

      // Escape hatch: CLAUDE_NONSTOP_DISABLE_ADMIN_DETECT=1 disables
      // admin-disabled detection entirely. Useful when false positives are
      // suspected (e.g., the trigger string appears in model output,
      // documentation, or pasted logs rather than a real CLI banner).
      const adminDetectDisabled = /^(1|true|yes|on)$/i.test(
        process.env.CLAUDE_NONSTOP_DISABLE_ADMIN_DETECT || ''
      );

      const detection = detectAdminDisabled(outputBuffer);

      if (debugDetect) {
        try {
          fs.appendFileSync(
            debugFile,
            `[${new Date().toISOString()}] account=${account.name} ` +
              `chunk=${data.length} buf=${outputBuffer.length} ` +
              `match=${detection.matched}${detection.via ? '/' + detection.via : ''} ` +
              `escaped=${adminDetectDisabled} ` +
              `norm_tail=${JSON.stringify(detection.normalized.slice(-200))} ` +
              `raw_tail=${JSON.stringify(outputBuffer.slice(-200))}\n`,
            { mode: 0o600 }
          );
        } catch {
          // Diagnostic logging is best-effort; never fail the runner over it.
        }
      }

      if (!adminDetectDisabled && detection.matched) {
        adminDisableDetected = true;
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, KILL_ESCALATION_DELAY);
        return;
      }

      const match = RATE_LIMIT_PATTERN.exec(stripped);
      if (match) {
        rateLimitDetected = true;
        resetTime = match[1].trim();
        child.kill('SIGTERM');
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, KILL_ESCALATION_DELAY);
        return;
      }
    });

    // Forward signals to child
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const signalHandlers = {};
    let cleaned = false;

    // Manual-swap signal — escape hatch when automatic detection misses a
    // stuck session (e.g., upstream CLI banner format change). Not forwarded
    // to the child; instead we set the flag and terminate the child so the
    // outer swap loop picks the next best account.
    const onManualSwap = () => {
      if (rateLimitDetected || adminDisableDetected || manualSwapRequested) return;
      manualSwapRequested = true;
      console.error('\n[claude-nonstop] Manual swap requested via SIGUSR1');
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, KILL_ESCALATION_DELAY);
    };
    process.on('SIGUSR1', onManualSwap);

    function cleanup() {
      if (cleaned) return;
      cleaned = true;

      clearTimeout(graceTimer);

      for (const sig of signals) {
        process.removeListener(sig, signalHandlers[sig]);
      }
      process.removeListener('SIGUSR1', onManualSwap);

      process.stdin.removeListener('data', onStdinData);
      process.stdin.pause();
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      process.stdout.removeListener('resize', onResize);
    }

    for (const sig of signals) {
      const handler = () => {
        if (!rateLimitDetected && !adminDisableDetected && !manualSwapRequested) {
          try { child.kill(sig); } catch {}
        }
      };
      signalHandlers[sig] = handler;
      process.on(sig, handler);
    }

    // Single onExit handler: cleanup + resolve
    child.onExit(({ exitCode }) => {
      cleanup();

      resolve({
        exitCode: exitCode ?? null,
        rateLimitDetected,
        adminDisableDetected,
        manualSwapRequested,
        resetTime,
        sessionId: existingSessionId,
      });
    });
  });
}

/**
 * Extract --resume session ID from claude args if present.
 */
function extractResumeSessionId(args) {
  const idx = args.indexOf('--resume');
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  // Also check -r shorthand
  const idxR = args.indexOf('-r');
  if (idxR !== -1 && idxR + 1 < args.length) {
    return args[idxR + 1];
  }
  return null;
}

/** Known Claude CLI flags that take a value argument. */
const FLAGS_WITH_VALUES = new Set([
  '--append-system-prompt', '--model', '-m',
  '--allowedTools', '--disallowedTools',
]);

/**
 * Build new claude args with --resume flag.
 * Replaces existing --resume if present, otherwise prepends it.
 *
 * When continueMessage is provided (rate-limit swap), strips positional args
 * (the original user prompt and any previous continue message) so Claude
 * receives only the continuation prompt and picks up where it left off.
 */
function buildResumeArgs(originalArgs, sessionId, continueMessage) {
  const args = [...originalArgs];

  // Remove existing --resume or -r flags
  for (const flag of ['--resume', '-r']) {
    const idx = args.indexOf(flag);
    if (idx !== -1) {
      args.splice(idx, 2); // Remove flag and its value
    }
  }

  if (continueMessage) {
    // Strip positional args — keep only flags and their values
    const flagsOnly = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-')) {
        flagsOnly.push(args[i]);
        if (FLAGS_WITH_VALUES.has(args[i]) && i + 1 < args.length) {
          flagsOnly.push(args[++i]);
        }
      }
    }
    flagsOnly.unshift('--resume', sessionId);
    flagsOnly.push(continueMessage);
    return flagsOnly;
  }

  // Prepend --resume
  args.unshift('--resume', sessionId);
  return args;
}

export {
  stripAnsi, normalizeBannerBuffer, detectAdminDisabled,
  extractResumeSessionId, buildResumeArgs, RATE_LIMIT_PATTERN,
  ADMIN_DISABLE_PATTERN, ADMIN_DISABLE_KEYWORDS,
  RATE_LIMIT_CONTINUE_MSG, FLAGS_WITH_VALUES,
  findEarliestReset, formatDuration, sleep, deactivateStaleChannels,
  EXHAUSTION_THRESHOLD, MAX_SLEEP_MS,
  ADMIN_DISABLE_VERIFY_THRESHOLD, MAX_CONSECUTIVE_ADMIN_FALSE_POSITIVES,
};
