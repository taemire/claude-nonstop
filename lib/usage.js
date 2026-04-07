/**
 * Query the Anthropic OAuth usage API.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 * Returns five_hour and seven_day utilization percentages (0-100).
 */

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Normalize a utilization value to a 0-100 percentage.
 * The API returns percentage scale (0-100). The previous fraction-detection
 * branch (value <= 1.0) misread integer values like 1.0 as 100% instead of 1%.
 * Fix: treat all values as percentage directly.
 */
export function normalizePercent(value) {
  if (typeof value !== 'number' || isNaN(value)) return 0;
  return Math.min(100, Math.round(value));
}

/**
 * Check usage for a single account token.
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{sessionPercent: number, weeklyPercent: number, sessionResetsAt: string|null, weeklyResetsAt: string|null, error: string|null}>}
 */
export async function checkUsage(token) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      return {
        sessionPercent: 0,
        weeklyPercent: 0,
        sessionResetsAt: null,
        weeklyResetsAt: null,
        error: `HTTP ${res.status}`,
      };
    }

    const data = await res.json();

    // New nested format: { five_hour: { utilization: N, resets_at: "..." }, seven_day: { ... } }
    if (data.five_hour !== undefined || data.seven_day !== undefined) {
      return {
        sessionPercent: normalizePercent(data.five_hour?.utilization ?? 0),
        weeklyPercent: normalizePercent(data.seven_day?.utilization ?? 0),
        sessionResetsAt: data.five_hour?.resets_at ?? null,
        weeklyResetsAt: data.seven_day?.resets_at ?? null,
        error: null,
      };
    }

    // Legacy flat format: { five_hour_utilization: 0.72, ... }
    return {
      sessionPercent: normalizePercent(data.five_hour_utilization ?? 0),
      weeklyPercent: normalizePercent(data.seven_day_utilization ?? 0),
      sessionResetsAt: data.five_hour_reset_at ?? null,
      weeklyResetsAt: data.seven_day_reset_at ?? null,
      error: null,
    };
  } catch (error) {
    return {
      sessionPercent: 0,
      weeklyPercent: 0,
      sessionResetsAt: null,
      weeklyResetsAt: null,
      error: error.name === 'AbortError' ? 'timeout' : error.message,
    };
  }
}

/**
 * Fetch the account profile (name, email) from the OAuth profile API.
 *
 * @param {string} token - OAuth access token
 * @returns {Promise<{name: string|null, email: string|null}>}
 */
export async function fetchProfile(token) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) return { name: null, email: null };

    const data = await res.json();
    return {
      name: data.account?.full_name || data.account?.display_name || null,
      email: data.account?.email || null,
    };
  } catch {
    return { name: null, email: null };
  }
}

/**
 * Check usage for all accounts in parallel.
 *
 * @param {Array<{name: string, configDir: string, token: string}>} accounts
 * @returns {Promise<Array<{name: string, configDir: string, token: string, usage: object}>>}
 */
export async function checkAllUsage(accounts) {
  const results = await Promise.all(
    accounts.map(async (account) => {
      const usage = await checkUsage(account.token);
      return { ...account, usage };
    })
  );
  return results;
}
