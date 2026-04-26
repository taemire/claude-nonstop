/**
 * Account scoring and selection.
 *
 * Picks the best account by **headroom rate** — % of usage budget remaining
 * per hour, on the bottleneck axis (session vs weekly). Higher rate wins.
 *
 * Why rate, not raw utilization: an account at 99% with 1h to weekly reset
 * has more usable bandwidth (1 %/h) than a fresh account at 0% with 168h
 * (~0.6 %/h). The near-reset account should be drained before its credits
 * vanish at reset, so prefer it. Raw `max(session, weekly)` couldn't model
 * this and tied accounts that were actually quite different in pressure.
 *
 * When usePriority is true, accounts with lower priority numbers are preferred
 * over accounts with higher headroom. Accounts whose effective utilization is
 * at or above PRIORITY_THRESHOLD (98%) are considered "near-exhausted" and
 * skipped in favor of the next priority.
 */

const PRIORITY_THRESHOLD = 98;
const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;       // 5h
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;   // 7d
// Floor for time-to-reset to keep the rate stable as a window approaches t→0.
// Without this, dividing by tiny remaining values would explode the score and
// the picker would oscillate on accounts seconds away from reset.
const MIN_REMAINING_MS = 5 * 60 * 1000;             // 5 min

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

      return effectiveAvailability(b.usage, now) - effectiveAvailability(a.usage, now);
    });

    const best = candidates[0];
    const pri = best.priority != null ? `, priority: ${best.priority}` : '';

    return {
      account: best,
      reason: `priority selection (session: ${best.usage.sessionPercent}%, weekly: ${best.usage.weeklyPercent}%${pri})`,
    };
  }

  // Default: sort by headroom rate (descending — highest availability first)
  candidates.sort((a, b) => {
    return effectiveAvailability(b.usage, now) - effectiveAvailability(a.usage, now);
  });

  const best = candidates[0];
  const rate = effectiveAvailability(best.usage, now);

  return {
    account: best,
    reason: `highest availability ${rate.toFixed(2)}%/h (session: ${best.usage.sessionPercent}%, weekly: ${best.usage.weeklyPercent}%)`,
  };
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

export { PRIORITY_THRESHOLD, SESSION_WINDOW_MS, WEEKLY_WINDOW_MS, MIN_REMAINING_MS };
