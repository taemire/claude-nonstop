/**
 * Account scoring and selection.
 *
 * Hybrid picker: absolute-remaining gap dominates when accounts differ by
 * more than ABSOLUTE_GAP_THRESHOLD_PP percentage points; within that band,
 * fall back to bottleneck headroom rate (drain-before-reset).
 *
 * Why hybrid: pure headroom-rate selection produced counterintuitive picks
 * when one account was nearly idle and another was 70%+ used — the heavily-
 * used account would still win because its imminent weekly reset gave it a
 * higher %/h rate. Users observing `73% <-- best` over a `0%` account read
 * that as broken. The hybrid keeps the drain-before-reset logic for
 * comparable accounts but defers to raw remaining capacity when the gap is
 * meaningful (>20pp by default).
 *
 * When usePriority is true, accounts with lower priority numbers are preferred
 * over accounts with higher headroom. Accounts whose effective utilization is
 * at or above PRIORITY_THRESHOLD (98%) are considered "near-exhausted" and
 * skipped in favor of the next priority. Within the same priority bucket the
 * hybrid comparator is the tiebreaker.
 */

const PRIORITY_THRESHOLD = 98;
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;       // 5h
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;   // 7d
// Floor for time-to-reset to keep the rate stable as a window approaches t→0.
// Without this, dividing by tiny remaining values would explode the score and
// the picker would oscillate on accounts seconds away from reset.
const MIN_REMAINING_MS = 5 * 60 * 1000;             // 5 min
// Hybrid gate: if two accounts differ by more than this many percentage points
// of absolute remaining capacity, the higher-remaining account wins outright.
// Below this gap, accounts are considered comparable and the rate-based
// tiebreaker decides. Override via env CLAUDE_NONSTOP_HEADROOM_GAP_PP.
const ABSOLUTE_GAP_THRESHOLD_PP = (() => {
  const raw = process.env.CLAUDE_NONSTOP_HEADROOM_GAP_PP;
  if (raw == null || raw === '') return 20;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 20;
})();

/**
 * Pick the best account from a list of accounts with usage data.
 *
 * @param {Array<{name: string, configDir: string, token: string, usage: object, priority?: number}>} accounts
 * @param {string} [excludeName] - Account name to exclude (e.g., the one that just hit a limit)
 * @param {object} [options]
 * @param {boolean} [options.usePriority=false] - When true, prefer accounts by priority number
 * @param {Set<string>|Iterable<string>} [options.excludeNames] - Additional names to skip (e.g. admin-disabled blocklist)
 * @param {Date} [options.now] - Override current time (for testing)
 * @returns {{ account: object, reason: string } | null}
 */
export function pickBestAccount(accounts, excludeName, options = {}) {
  const extraExcluded = options.excludeNames instanceof Set
    ? options.excludeNames
    : new Set(options.excludeNames || []);
  const now = options.now instanceof Date ? options.now : new Date();

  const candidates = accounts.filter(a => {
    if (a.name === excludeName) return false;
    if (extraExcluded.has(a.name)) return false;
    if (!a.token) return false;
    if (a.usage?.error) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  if (options.usePriority) {
    // Priority-aware sorting:
    // 1. Non-exhausted (< 98% util) before exhausted (>= 98% util)
    // 2. Within each group: lower priority number first (nulls last)
    // 3. Tiebreaker: higher availability (headroom rate) first
    candidates.sort((a, b) => {
      const aUtil = effectiveUtilization(a.usage);
      const bUtil = effectiveUtilization(b.usage);
      const aExhausted = aUtil >= PRIORITY_THRESHOLD;
      const bExhausted = bUtil >= PRIORITY_THRESHOLD;

      if (aExhausted !== bExhausted) return aExhausted ? 1 : -1;

      const aPri = a.priority ?? Infinity;
      const bPri = b.priority ?? Infinity;
      if (aPri !== bPri) return aPri - bPri;

      return compareHybrid(a.usage, b.usage, now);
    });

    const best = candidates[0];
    const pri = best.priority != null ? `, priority: ${best.priority}` : '';
    // Find the runner-up that shares best's priority + exhaustion bucket — that's
    // the one the hybrid tiebreaker actually compared against. Anything outside
    // the bucket was sorted by priority/exhaustion before the tiebreaker ran.
    const bestPri = best.priority ?? Infinity;
    const bestExhausted = effectiveUtilization(best.usage) >= PRIORITY_THRESHOLD;
    const tieBucketRunnerUp = candidates.find((c, i) => {
      if (i === 0) return false;
      if ((c.priority ?? Infinity) !== bestPri) return false;
      const cExhausted = effectiveUtilization(c.usage) >= PRIORITY_THRESHOLD;
      return cExhausted === bestExhausted;
    });
    const detail = pickPathDetail(best.usage, tieBucketRunnerUp?.usage, now);

    return {
      account: best,
      reason: `priority selection (${detail}, session: ${best.usage.sessionPercent}%, weekly: ${best.usage.weeklyPercent}%${pri})`,
    };
  }

  // Default: hybrid sort — absolute remaining gap first, headroom rate within band
  candidates.sort((a, b) => compareHybrid(a.usage, b.usage, now));

  const best = candidates[0];
  const detail = pickPathDetail(best.usage, candidates[1]?.usage, now);

  return {
    account: best,
    reason: `${detail} (session: ${best.usage.sessionPercent}%, weekly: ${best.usage.weeklyPercent}%)`,
  };
}

/**
 * Hybrid comparator: returns negative if `a` should come before `b`.
 *
 * Step 1 — absolute-remaining gap: if accounts differ by more than the
 * configured threshold (default 20pp), the higher-remaining one wins outright.
 * Step 2 — bottleneck headroom rate: within the comparable band, prefer the
 * account that should be drained first to avoid losing credits at reset.
 */
function compareHybrid(usageA, usageB, now) {
  const aRem = absoluteRemaining(usageA);
  const bRem = absoluteRemaining(usageB);
  const remGap = aRem - bRem;
  if (Math.abs(remGap) > ABSOLUTE_GAP_THRESHOLD_PP) {
    // Higher absolute remaining wins → return negative when a has more.
    return -remGap;
  }
  return effectiveAvailability(usageB, now) - effectiveAvailability(usageA, now);
}

/**
 * Build a short label that explains which decision path picked this account.
 * If the runner-up is more than the threshold below in raw remaining, the
 * raw-remaining path won. Otherwise the rate-based tiebreaker won.
 */
function pickPathDetail(bestUsage, runnerUpUsage, now) {
  const bestRem = absoluteRemaining(bestUsage);
  if (runnerUpUsage) {
    const runnerRem = absoluteRemaining(runnerUpUsage);
    if (bestRem - runnerRem > ABSOLUTE_GAP_THRESHOLD_PP) {
      return `highest absolute remaining ${bestRem}%`;
    }
  }
  const rate = effectiveAvailability(bestUsage, now);
  return `highest availability ${rate.toFixed(2)}%/h within ${ABSOLUTE_GAP_THRESHOLD_PP}pp band`;
}

/**
 * Pick the best account using priority hierarchy.
 * Convenience wrapper for `use --priority`.
 *
 * @param {Array} accounts - Accounts with usage data
 * @param {object} [options]
 * @param {Set<string>|Iterable<string>} [options.excludeNames] - Names to skip (e.g. admin-disabled blocklist)
 * @param {Date} [options.now] - Override current time (for testing)
 * @returns {{ account: object, reason: string } | null}
 */
export function pickByPriority(accounts, options = {}) {
  return pickBestAccount(accounts, undefined, { ...options, usePriority: true });
}

/**
 * Per-axis headroom rate in %/h.
 *
 * - Hard ceiling: percent >= 100 → 0 (account currently blocked on this axis).
 * - Missing resetsAt: assume a full window remaining (legacy / API miss).
 * - remainingMs floored at MIN_REMAINING_MS to prevent divide-by-near-zero.
 */
export function axisHeadroomRate(percent, resetsAt, windowMs, now) {
  const p = Math.max(0, percent || 0);
  if (p >= 100) return 0;
  let remainingMs;
  if (resetsAt) {
    const reset = new Date(resetsAt).getTime();
    if (Number.isNaN(reset)) {
      remainingMs = windowMs;
    } else {
      remainingMs = Math.max(MIN_REMAINING_MS, reset - now.getTime());
    }
  } else {
    remainingMs = windowMs;
  }
  const remainingHours = remainingMs / 3_600_000;
  return (100 - p) / remainingHours;
}

/**
 * Effective availability — bottleneck headroom rate across session + weekly.
 * Higher is better; pick the account with the most headroom on its tightest axis.
 *
 * @param {object} usage
 * @param {Date} [now]
 * @returns {number} %/h on the bottleneck axis (0 if blocked on either axis)
 */
export function effectiveAvailability(usage, now = new Date()) {
  if (!usage) return 0;
  const s = axisHeadroomRate(usage.sessionPercent, usage.sessionResetsAt, SESSION_WINDOW_MS, now);
  const w = axisHeadroomRate(usage.weeklyPercent, usage.weeklyResetsAt, WEEKLY_WINDOW_MS, now);
  return Math.min(s, w);
}

/**
 * Calculate effective utilization — the higher of session or weekly.
 *
 * Retained for the priority-mode exhaustion threshold check (PRIORITY_THRESHOLD).
 * No longer drives default selection; see `effectiveAvailability` instead.
 */
export function effectiveUtilization(usage) {
  if (!usage) return 100;
  return Math.max(usage.sessionPercent || 0, usage.weeklyPercent || 0);
}

/**
 * Absolute remaining capacity in percentage points on the bottleneck axis.
 * 100 minus the higher of session/weekly utilization, clamped to [0, 100].
 * Used by the hybrid comparator to gate raw-remaining vs rate-based logic.
 */
export function absoluteRemaining(usage) {
  if (!usage) return 0;
  const top = Math.max(usage.sessionPercent || 0, usage.weeklyPercent || 0);
  return Math.max(0, Math.min(100, 100 - top));
}

export { PRIORITY_THRESHOLD, SESSION_WINDOW_MS, WEEKLY_WINDOW_MS, MIN_REMAINING_MS, ABSOLUTE_GAP_THRESHOLD_PP };
