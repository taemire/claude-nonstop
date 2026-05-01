import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickBestAccount,
  pickByPriority,
  PRIORITY_THRESHOLD,
  effectiveAvailability,
  axisHeadroomRate,
  absoluteRemaining,
  SESSION_WINDOW_MS,
  WEEKLY_WINDOW_MS,
  ABSOLUTE_GAP_THRESHOLD_PP,
} from '../../../lib/scorer.js';

const makeAccount = (name, sessionPercent, weeklyPercent, opts = {}) => ({
  name,
  configDir: `/tmp/profiles/${name}`,
  token: 'token' in opts ? opts.token : 'sk-ant-oat01-valid',
  priority: opts.priority ?? undefined,
  usage: opts.error
    ? { error: opts.error }
    : {
      sessionPercent,
      weeklyPercent,
      sessionResetsAt: opts.sessionResetsAt ?? null,
      weeklyResetsAt: opts.weeklyResetsAt ?? null,
    },
});

// Helper: ISO timestamp `hours` from `now`
const inHours = (hours, now = new Date()) =>
  new Date(now.getTime() + hours * 3_600_000).toISOString();

describe('pickBestAccount', () => {

  it('picks the account with the lowest utilization', () => {
    const accounts = [
      makeAccount('high', 80, 50),
      makeAccount('low', 10, 20),
      makeAccount('mid', 40, 30),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'low');
  });

  it('uses the higher of session or weekly percent', () => {
    const accounts = [
      makeAccount('a', 10, 90),  // effective: 90
      makeAccount('b', 50, 20),  // effective: 50
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'b');
  });

  it('excludes the named account', () => {
    const accounts = [
      makeAccount('best', 0, 0),
      makeAccount('other', 50, 50),
    ];
    const result = pickBestAccount(accounts, 'best');
    assert.equal(result.account.name, 'other');
  });

  it('filters out accounts with no token', () => {
    const accounts = [
      makeAccount('no-token', 0, 0, { token: null }),
      makeAccount('has-token', 50, 50),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'has-token');
  });

  it('filters out accounts with usage errors', () => {
    const accounts = [
      makeAccount('error', 0, 0, { error: 'HTTP 401' }),
      makeAccount('ok', 60, 60),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'ok');
  });

  it('returns null when no candidates remain', () => {
    const accounts = [
      makeAccount('only', 0, 0, { token: null }),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result, null);
  });

  it('returns null for empty array', () => {
    const result = pickBestAccount([]);
    assert.equal(result, null);
  });

  it('returns null when all are excluded or invalid', () => {
    const accounts = [
      makeAccount('excluded', 0, 0),
      makeAccount('error', 0, 0, { error: 'timeout' }),
    ];
    const result = pickBestAccount(accounts, 'excluded');
    assert.equal(result, null);
  });

  it('handles tied utilization deterministically (first in input order wins)', () => {
    const accounts = [
      makeAccount('a', 50, 50),
      makeAccount('b', 50, 50),
    ];
    const result = pickBestAccount(accounts);
    assert.ok(result !== null);
    // Sort is stable in Node 18+; first candidate in input order wins ties
    assert.equal(result.account.name, 'a');
    // Verify it's consistent
    const result2 = pickBestAccount(accounts);
    assert.equal(result2.account.name, 'a');
  });

  it('includes reason string with percentages', () => {
    const accounts = [makeAccount('test', 25, 30)];
    const result = pickBestAccount(accounts);
    assert.ok(result.reason.includes('25%'));
    assert.ok(result.reason.includes('30%'));
  });

  it('handles accounts with null usage as 100% utilization', () => {
    const accounts = [
      { name: 'null-usage', configDir: '/tmp/null', token: 'sk-ant-oat01-x', usage: null },
      makeAccount('ok', 50, 50),
    ];
    // null usage -> effectiveUtilization returns 100, so 'ok' wins
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'ok');
  });

  it('handles zero utilization', () => {
    const accounts = [makeAccount('zero', 0, 0)];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'zero');
  });

  it('handles 100% utilization', () => {
    const accounts = [makeAccount('full', 100, 100)];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'full');
  });

  it('filters multiple invalid accounts correctly', () => {
    const accounts = [
      makeAccount('err1', 0, 0, { error: 'HTTP 500' }),
      makeAccount('err2', 0, 0, { error: 'timeout' }),
      makeAccount('no-tok', 0, 0, { token: null }),
      makeAccount('valid', 30, 40),
    ];
    const result = pickBestAccount(accounts);
    assert.equal(result.account.name, 'valid');
  });

  // Without usePriority, priority is ignored
  it('ignores priority when usePriority is false (default)', () => {
    const accounts = [
      makeAccount('pri1', 80, 80, { priority: 1 }),  // effective: 80
      makeAccount('pri2', 10, 10, { priority: 2 }),   // effective: 10
    ];
    const result = pickBestAccount(accounts);
    // Default: lowest utilization wins, regardless of priority
    assert.equal(result.account.name, 'pri2');
  });
});

describe('pickBestAccount with usePriority', () => {
  it('picks highest priority account even with higher utilization', () => {
    const accounts = [
      makeAccount('main', 60, 60, { priority: 1 }),     // effective: 60
      makeAccount('backup', 10, 10, { priority: 2 }),    // effective: 10
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'main');
  });

  it('skips exhausted priority 1 and falls back to priority 2', () => {
    const accounts = [
      makeAccount('main', PRIORITY_THRESHOLD, PRIORITY_THRESHOLD, { priority: 1 }),
      makeAccount('backup', 10, 10, { priority: 2 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'backup');
  });

  it('skips account at 100% and uses next priority', () => {
    const accounts = [
      makeAccount('main', 100, 100, { priority: 1 }),
      makeAccount('backup', 50, 50, { priority: 2 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'backup');
  });

  it('accounts without priority are treated as lowest priority', () => {
    const accounts = [
      makeAccount('no-pri', 10, 10),                     // no priority = Infinity
      makeAccount('has-pri', 50, 50, { priority: 1 }),   // priority 1
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'has-pri');
  });

  it('same priority falls back to lower utilization', () => {
    const accounts = [
      makeAccount('a', 80, 80, { priority: 1 }),
      makeAccount('b', 20, 20, { priority: 1 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'b');
  });

  it('all exhausted — picks by priority then utilization', () => {
    const accounts = [
      makeAccount('a', 99, 99, { priority: 2 }),
      makeAccount('b', 98, 100, { priority: 1 }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    // Both exhausted (>= 98%), priority 1 wins
    assert.equal(result.account.name, 'b');
  });

  it('excludeName still works with priority', () => {
    const accounts = [
      makeAccount('main', 10, 10, { priority: 1 }),
      makeAccount('backup', 50, 50, { priority: 2 }),
    ];
    const result = pickBestAccount(accounts, 'main', { usePriority: true });
    assert.equal(result.account.name, 'backup');
  });

  it('includes priority in reason string', () => {
    const accounts = [makeAccount('test', 25, 30, { priority: 1 })];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.ok(result.reason.includes('priority'));
    assert.ok(result.reason.includes('1'));
  });

  it('cascades through multiple priority levels', () => {
    const accounts = [
      makeAccount('main', 99, 99, { priority: 1 }),       // exhausted
      makeAccount('backup1', 99, 99, { priority: 2 }),     // exhausted
      makeAccount('backup2', 50, 50, { priority: 3 }),     // available
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true });
    assert.equal(result.account.name, 'backup2');
  });
});

describe('pickByPriority', () => {
  it('is a convenience wrapper that uses priority', () => {
    const accounts = [
      makeAccount('main', 60, 60, { priority: 1 }),
      makeAccount('backup', 10, 10, { priority: 2 }),
    ];
    const result = pickByPriority(accounts);
    assert.equal(result.account.name, 'main');
  });

  it('returns null for empty array', () => {
    const result = pickByPriority([]);
    assert.equal(result, null);
  });
});

describe('PRIORITY_THRESHOLD', () => {
  it('is 98', () => {
    assert.equal(PRIORITY_THRESHOLD, 98);
  });
});

describe('effectiveAvailability (time-weighted)', () => {
  it('returns 0 for null usage', () => {
    assert.equal(effectiveAvailability(null), 0);
  });

  it('returns 0 when session is 100% (hard ceiling)', () => {
    const usage = { sessionPercent: 100, weeklyPercent: 10, sessionResetsAt: null, weeklyResetsAt: null };
    assert.equal(effectiveAvailability(usage), 0);
  });

  it('returns 0 when weekly is 100% (hard ceiling)', () => {
    const usage = { sessionPercent: 10, weeklyPercent: 100, sessionResetsAt: null, weeklyResetsAt: null };
    assert.equal(effectiveAvailability(usage), 0);
  });

  it('falls back to full-window assumption when resetsAt is missing', () => {
    // session 50/5h = 10%/h, weekly 90/168h ≈ 0.536%/h → bottleneck = weekly
    const usage = { sessionPercent: 50, weeklyPercent: 10 };
    const got = effectiveAvailability(usage);
    const expected = (100 - 10) / (WEEKLY_WINDOW_MS / 3_600_000);
    assert.ok(Math.abs(got - expected) < 1e-6, `got ${got}, expected ${expected}`);
  });

  it('uses bottleneck axis (min of session and weekly rate)', () => {
    const now = new Date('2026-04-26T00:00:00Z');
    const usage = {
      sessionPercent: 0,                          // session very fresh
      sessionResetsAt: inHours(5, now),           // full 5h ahead
      weeklyPercent: 99,                          // weekly nearly full
      weeklyResetsAt: inHours(50, now),           // 50h until reset → weekly is bottleneck
    };
    const sRate = (100 - 0) / 5;                  // 20 %/h
    const wRate = (100 - 99) / 50;                // 0.02 %/h
    assert.equal(effectiveAvailability(usage, now), Math.min(sRate, wRate));
  });
});

describe('axisHeadroomRate', () => {
  it('clamps remaining to MIN_REMAINING_MS to avoid divide-by-zero blow-up', () => {
    const now = new Date('2026-04-26T00:00:00Z');
    // 1 second remaining — would normally produce a huge rate; floor caps it
    const oneSecondAhead = new Date(now.getTime() + 1000).toISOString();
    const rate = axisHeadroomRate(50, oneSecondAhead, WEEKLY_WINDOW_MS, now);
    // With 5min floor: (100-50) / (5/60) = 600 %/h max
    assert.ok(rate <= 600 + 1e-6, `rate=${rate} should be capped near 600`);
    assert.ok(rate >= 599, `rate=${rate} should be near 600 (floor activated)`);
  });

  it('returns 0 for percent >= 100', () => {
    const now = new Date();
    assert.equal(axisHeadroomRate(100, inHours(1, now), WEEKLY_WINDOW_MS, now), 0);
    assert.equal(axisHeadroomRate(150, inHours(1, now), WEEKLY_WINDOW_MS, now), 0);
  });

  it('handles invalid resetsAt gracefully (falls back to full window)', () => {
    const now = new Date();
    const rate = axisHeadroomRate(50, 'not-a-date', WEEKLY_WINDOW_MS, now);
    const expected = 50 / (WEEKLY_WINDOW_MS / 3_600_000);
    assert.ok(Math.abs(rate - expected) < 1e-6);
  });
});

describe('pickBestAccount with time-weighted scoring', () => {
  it('prefers near-reset account over fresh account when raw remaining is comparable (within hybrid band)', () => {
    // Drain-before-reset still applies, but only inside the absolute-remaining band.
    // Both accounts at 50% utilization (same absRem 50) → gap 0 → rate decides.
    // near-reset's weekly resets in 1h vs long-runway's 100h → near-reset has the
    // higher headroom rate and wins the tiebreaker.
    const now = new Date('2026-04-26T00:00:00Z');
    const accounts = [
      makeAccount('long-runway', 0, 50, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(100, now),
      }),
      makeAccount('near-reset', 0, 50, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(1, now),
      }),
    ];
    const result = pickBestAccount(accounts, undefined, { now });
    assert.equal(result.account.name, 'near-reset');
  });

  it('still excludes accounts blocked at 100% on either axis', () => {
    const now = new Date('2026-04-26T00:00:00Z');
    const accounts = [
      makeAccount('blocked-session', 100, 10, {
        sessionResetsAt: inHours(2, now),
        weeklyResetsAt: inHours(100, now),
      }),
      makeAccount('available', 50, 50, {
        sessionResetsAt: inHours(2, now),
        weeklyResetsAt: inHours(100, now),
      }),
    ];
    const result = pickBestAccount(accounts, undefined, { now });
    assert.equal(result.account.name, 'available');
  });

  it('reproduces the 4-account case from the design doc', () => {
    // Snapshot from real claude-nonstop status output (2026-04-26).
    // Expected ranking under rate-based bottleneck: default > second > fourth > third.
    const now = new Date('2026-04-26T03:00:00Z');
    const accounts = [
      makeAccount('default', 38, 15, {
        sessionResetsAt: inHours(2.37, now),
        weeklyResetsAt: inHours(132, now),
      }),
      makeAccount('second', 16, 39, {
        sessionResetsAt: inHours(2.37, now),
        weeklyResetsAt: inHours(98, now),
      }),
      makeAccount('third', 100, 44, {
        sessionResetsAt: inHours(2.87, now),
        weeklyResetsAt: inHours(1.03, now),
      }),
      makeAccount('fourth', 0, 38, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(111, now),
      }),
    ];
    const result = pickBestAccount(accounts, undefined, { now });
    assert.equal(result.account.name, 'default');
  });

  it('reason string reports the headroom rate in %/h', () => {
    const now = new Date('2026-04-26T00:00:00Z');
    const accounts = [
      makeAccount('a', 25, 30, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(168, now),
      }),
    ];
    const result = pickBestAccount(accounts, undefined, { now });
    assert.ok(result.reason.includes('%/h'), `reason should mention %/h: ${result.reason}`);
  });

  it('accepts options.now for deterministic test injection', () => {
    // Both accounts at absRem 50 (same bottleneck remaining) → falls to rate-based tiebreaker.
    // imminent's near-reset weekly window has the higher %/h, so it wins.
    const t1 = new Date('2026-04-26T00:00:00Z');
    const t2 = new Date('2026-04-26T03:30:00Z');  // 3.5h later — imminent closer to weekly reset
    const accounts = [
      makeAccount('long-runway', 0, 50, {
        sessionResetsAt: inHours(5, t1),
        weeklyResetsAt: inHours(100, t1),
      }),
      makeAccount('imminent', 0, 50, {
        sessionResetsAt: inHours(5, t1),
        weeklyResetsAt: inHours(4, t1),  // resets in 4h relative to t1, in 0.5h relative to t2
      }),
    ];
    assert.equal(pickBestAccount(accounts, undefined, { now: t1 }).account.name, 'imminent');
    assert.equal(pickBestAccount(accounts, undefined, { now: t2 }).account.name, 'imminent');
  });
});

describe('pickBestAccount hybrid (raw remaining vs rate)', () => {
  it('prefers raw remaining when absolute gap exceeds threshold', () => {
    // Real-world case that motivated the hybrid (2026-05-01 user report):
    // a "fresh" backup account at session 0% / weekly 9% should win over an
    // active account at session 73% / weekly 62%, even though the active one
    // has a higher %/h drain rate due to imminent weekly reset.
    const now = new Date('2026-05-01T00:00:00Z');
    const accounts = [
      makeAccount('busy', 73, 62, {
        sessionResetsAt: inHours(3.15, now),
        weeklyResetsAt: inHours(42.32, now),
        priority: 1,
      }),
      makeAccount('idle', 0, 9, {
        sessionResetsAt: null,                // session window fresh
        weeklyResetsAt: inHours(139.32, now),
        priority: 1,
      }),
    ];
    const result = pickBestAccount(accounts, undefined, { now, usePriority: true });
    assert.equal(result.account.name, 'idle');
    assert.ok(result.reason.includes('absolute remaining'),
      `reason should reflect raw-remaining path: ${result.reason}`);
  });

  it('falls back to rate-based tiebreaker within the hybrid band', () => {
    // absRem 60 vs 50 → gap 10pp ≤ 20pp → rate decides.
    const now = new Date('2026-05-01T00:00:00Z');
    const accounts = [
      makeAccount('a', 40, 40, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(168, now),    // long runway → low rate
      }),
      makeAccount('b', 50, 50, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(10, now),     // imminent reset → high rate
      }),
    ];
    // a: bottleneck min(60/5, 60/168) = 0.357 %/h
    // b: bottleneck min(50/5, 50/10) = 5.0 %/h
    // Within band, b wins by rate even though a has slightly more raw remaining.
    const result = pickBestAccount(accounts, undefined, { now });
    assert.equal(result.account.name, 'b');
    assert.ok(result.reason.includes('%/h'),
      `reason should reflect rate path: ${result.reason}`);
  });

  it('treats gap exactly at threshold as within-band (strict >)', () => {
    // absRem 80 vs 60 → gap = 20pp = threshold (not >) → rate decides.
    const now = new Date('2026-05-01T00:00:00Z');
    const accounts = [
      makeAccount('rawer', 20, 20, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(168, now),
      }),
      makeAccount('rater', 40, 40, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(2, now),      // very near reset → high rate
      }),
    ];
    // rawer: min(80/5, 80/168) = 0.476
    // rater: min(60/5, 60/2) = 12.0
    const result = pickBestAccount(accounts, undefined, { now });
    assert.equal(result.account.name, 'rater');
  });

  it('priority-mode tiebreaker also uses hybrid', () => {
    // Two priority-1 accounts: raw-remaining gap dominates.
    const now = new Date('2026-05-01T00:00:00Z');
    const accounts = [
      makeAccount('busy-pri1', 73, 62, {
        sessionResetsAt: inHours(3, now),
        weeklyResetsAt: inHours(42, now),
        priority: 1,
      }),
      makeAccount('idle-pri1', 0, 9, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(139, now),
        priority: 1,
      }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true, now });
    assert.equal(result.account.name, 'idle-pri1');
  });

  it('priority hierarchy still beats raw remaining (lower priority number wins)', () => {
    // Hybrid only kicks in within the same priority bucket.
    const now = new Date('2026-05-01T00:00:00Z');
    const accounts = [
      makeAccount('pri1-busy', 70, 60, {
        sessionResetsAt: inHours(3, now),
        weeklyResetsAt: inHours(42, now),
        priority: 1,
      }),
      makeAccount('pri2-idle', 0, 5, {
        sessionResetsAt: inHours(5, now),
        weeklyResetsAt: inHours(168, now),
        priority: 2,
      }),
    ];
    const result = pickBestAccount(accounts, undefined, { usePriority: true, now });
    assert.equal(result.account.name, 'pri1-busy');
  });
});

describe('absoluteRemaining', () => {
  it('returns 0 for null usage', () => {
    assert.equal(absoluteRemaining(null), 0);
  });

  it('returns 100 minus the higher of session/weekly', () => {
    assert.equal(absoluteRemaining({ sessionPercent: 30, weeklyPercent: 60 }), 40);
    assert.equal(absoluteRemaining({ sessionPercent: 70, weeklyPercent: 20 }), 30);
  });

  it('clamps at 0 when utilization exceeds 100', () => {
    assert.equal(absoluteRemaining({ sessionPercent: 110, weeklyPercent: 50 }), 0);
  });

  it('clamps at 100 when missing fields', () => {
    assert.equal(absoluteRemaining({}), 100);
  });
});

describe('ABSOLUTE_GAP_THRESHOLD_PP', () => {
  it('defaults to 20 percentage points', () => {
    // The constant is loaded once at module import; test verifies the default
    // applies when no env override was set when this test process started.
    if (process.env.CLAUDE_NONSTOP_HEADROOM_GAP_PP == null
        || process.env.CLAUDE_NONSTOP_HEADROOM_GAP_PP === '') {
      assert.equal(ABSOLUTE_GAP_THRESHOLD_PP, 20);
    } else {
      // Honor whatever the env asked for, but at least sanity-check it's a number.
      assert.ok(Number.isFinite(ABSOLUTE_GAP_THRESHOLD_PP));
    }
  });
});
