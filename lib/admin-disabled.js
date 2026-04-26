/**
 * Admin-disabled account blocklist.
 *
 * When Claude Code reports "Your usage allocation has been disabled by your
 * admin", the account is unusable until a human admin re-enables it. Unlike
 * rate-limits, there is no predictable reset time. This module persists a
 * blocklist so future session starts avoid the disabled account.
 *
 * Entries auto-expire after DEFAULT_TTL_HOURS (default: 24h) — the
 * expectation is that admin quota decisions are revisited at least daily.
 * Users can clear entries manually via the CLI.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';

const BLOCKLIST_FILE = join(CONFIG_DIR, 'admin-disabled.json');
const DEFAULT_TTL_HOURS = 24;

/**
 * Load the raw blocklist from disk, with expired entries filtered out.
 * Returns a plain object keyed by account name.
 *
 * @returns {Record<string, { disabledAt: string, ttlHours: number, reason?: string }>}
 */
export function loadBlocklist() {
  if (!existsSync(BLOCKLIST_FILE)) return {};

  let raw;
  try {
    raw = JSON.parse(readFileSync(BLOCKLIST_FILE, 'utf8'));
  } catch {
    return {};
  }

  if (!raw || typeof raw !== 'object') return {};

  const now = Date.now();
  const alive = {};
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== 'object' || !entry.disabledAt) continue;
    const disabledMs = Date.parse(entry.disabledAt);
    if (isNaN(disabledMs)) continue;
    const ttlHours = Number.isFinite(entry.ttlHours) ? entry.ttlHours : DEFAULT_TTL_HOURS;
    const expiresMs = disabledMs + ttlHours * 60 * 60 * 1000;
    if (expiresMs > now) {
      alive[name] = { ...entry, ttlHours };
    }
  }
  return alive;
}

/**
 * Returns the set of admin-disabled account names (expired entries omitted).
 *
 * @returns {Set<string>}
 */
export function getAdminDisabledNames() {
  return new Set(Object.keys(loadBlocklist()));
}

/**
 * Mark an account as admin-disabled. Atomic write.
 *
 * @param {string} name - Account name
 * @param {object} [options]
 * @param {number} [options.ttlHours=24]
 * @param {string} [options.reason]
 */
export function markAdminDisabled(name, options = {}) {
  if (!name || typeof name !== 'string') return;

  // Re-read to avoid clobbering concurrent writes.
  const current = loadBlocklist();
  current[name] = {
    disabledAt: new Date().toISOString(),
    ttlHours: options.ttlHours ?? DEFAULT_TTL_HOURS,
    ...(options.reason ? { reason: options.reason } : {}),
  };
  writeBlocklist(current);
}

/**
 * Remove one account (or all if name is omitted) from the blocklist.
 *
 * @param {string} [name]
 * @returns {{ cleared: string[] }}
 */
export function clearAdminDisabled(name) {
  const current = loadBlocklist();
  if (!name) {
    const cleared = Object.keys(current);
    if (existsSync(BLOCKLIST_FILE)) {
      try { unlinkSync(BLOCKLIST_FILE); } catch {}
    }
    return { cleared };
  }
  if (!(name in current)) return { cleared: [] };
  delete current[name];
  writeBlocklist(current);
  return { cleared: [name] };
}

/**
 * Is this account currently on the blocklist?
 */
export function isAdminDisabled(name) {
  return getAdminDisabledNames().has(name);
}

function writeBlocklist(data) {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const tmp = `${BLOCKLIST_FILE}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, BLOCKLIST_FILE);
}

export { BLOCKLIST_FILE, DEFAULT_TTL_HOURS };
