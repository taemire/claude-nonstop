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
import { join, dirname } from 'node:path';
import { CONFIG_DIR } from './config.js';

const DEFAULT_TTL_HOURS = 24;

/**
 * Resolve the blocklist file path on each call so tests can redirect it
 * via CLAUDE_NONSTOP_BLOCKLIST_FILE without restarting the process.
 * Without this hook, the constant captured at module load time would pin
 * the path to the real `~/.claude-nonstop/admin-disabled.json`.
 */
function getBlocklistFile() {
  return process.env.CLAUDE_NONSTOP_BLOCKLIST_FILE || join(CONFIG_DIR, 'admin-disabled.json');
}

/**
 * Load the raw blocklist from disk, with expired entries filtered out.
 * Returns a plain object keyed by account name.
 *
 * @returns {Record<string, { disabledAt: string, ttlHours: number, reason?: string }>}
 */
export function loadBlocklist() {
  const file = getBlocklistFile();
  if (!existsSync(file)) return {};

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
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
    const file = getBlocklistFile();
    if (existsSync(file)) {
      try { unlinkSync(file); } catch {}
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
  const file = getBlocklistFile();
  const parent = dirname(file);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

export { getBlocklistFile, DEFAULT_TTL_HOURS };
