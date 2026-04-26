import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '../../helpers/temp-dir.js';
import {
  loadBlocklist,
  getAdminDisabledNames,
  markAdminDisabled,
  clearAdminDisabled,
  isAdminDisabled,
  getBlocklistFile,
  DEFAULT_TTL_HOURS,
} from '../../../lib/admin-disabled.js';

let tmp;
let blocklistPath;

beforeEach(() => {
  tmp = createTempDir('cn-admin-test-');
  blocklistPath = join(tmp, 'admin-disabled.json');
  process.env.CLAUDE_NONSTOP_BLOCKLIST_FILE = blocklistPath;
});

afterEach(() => {
  delete process.env.CLAUDE_NONSTOP_BLOCKLIST_FILE;
  removeTempDir(tmp);
});

const writeRaw = (obj) => writeFileSync(blocklistPath, JSON.stringify(obj));
const isoFromNow = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe('getBlocklistFile (env override)', () => {
  it('returns the env var when set', () => {
    assert.equal(getBlocklistFile(), blocklistPath);
  });

  it('falls back to CONFIG_DIR-based path when env var is unset', () => {
    delete process.env.CLAUDE_NONSTOP_BLOCKLIST_FILE;
    const path = getBlocklistFile();
    assert.ok(path.endsWith('/admin-disabled.json'), `unexpected fallback path: ${path}`);
    assert.ok(path.includes('.claude-nonstop'), `should be under .claude-nonstop: ${path}`);
  });
});

describe('loadBlocklist', () => {
  it('returns empty object when the file does not exist', () => {
    assert.deepEqual(loadBlocklist(), {});
  });

  it('returns empty object when the file contains invalid JSON', () => {
    writeFileSync(blocklistPath, '{ broken json');
    assert.deepEqual(loadBlocklist(), {});
  });

  it('returns empty object when JSON is not an object', () => {
    writeFileSync(blocklistPath, '"a string"');
    assert.deepEqual(loadBlocklist(), {});
  });

  it('returns valid entries with TTL hydration', () => {
    writeRaw({
      foo: { disabledAt: isoFromNow(-1), ttlHours: 24 },
    });
    const result = loadBlocklist();
    assert.ok('foo' in result);
    assert.equal(result.foo.ttlHours, 24);
  });

  it('hydrates default TTL when ttlHours is missing', () => {
    writeRaw({
      foo: { disabledAt: isoFromNow(-1) },
    });
    assert.equal(loadBlocklist().foo.ttlHours, DEFAULT_TTL_HOURS);
  });

  it('skips entries with missing or invalid disabledAt', () => {
    writeRaw({
      no_ts: { ttlHours: 24 },
      bad_ts: { disabledAt: 'not-a-date', ttlHours: 24 },
      ok: { disabledAt: isoFromNow(-1), ttlHours: 24 },
    });
    const result = loadBlocklist();
    assert.deepEqual(Object.keys(result), ['ok']);
  });

  it('filters out expired entries', () => {
    writeRaw({
      expired: { disabledAt: isoFromNow(-25), ttlHours: 24 },     // 25h ago, ttl 24h → expired
      alive: { disabledAt: isoFromNow(-1), ttlHours: 24 },        // 1h ago, ttl 24h → alive
      future: { disabledAt: isoFromNow(0.5), ttlHours: 24 },      // disabledAt in future → alive (still within window)
    });
    const result = loadBlocklist();
    assert.deepEqual(Object.keys(result).sort(), ['alive', 'future']);
  });

  it('skips non-object entries', () => {
    writeRaw({
      bad: 'string-entry',
      ok: { disabledAt: isoFromNow(-1), ttlHours: 24 },
    });
    assert.deepEqual(Object.keys(loadBlocklist()), ['ok']);
  });
});

describe('getAdminDisabledNames', () => {
  it('returns a Set', () => {
    assert.ok(getAdminDisabledNames() instanceof Set);
  });

  it('contains alive account names', () => {
    writeRaw({
      a: { disabledAt: isoFromNow(-1), ttlHours: 24 },
      b: { disabledAt: isoFromNow(-2), ttlHours: 24 },
    });
    const names = getAdminDisabledNames();
    assert.ok(names.has('a'));
    assert.ok(names.has('b'));
    assert.equal(names.size, 2);
  });

  it('does not include expired entries', () => {
    writeRaw({
      expired: { disabledAt: isoFromNow(-100), ttlHours: 24 },
      alive: { disabledAt: isoFromNow(-1), ttlHours: 24 },
    });
    assert.deepEqual([...getAdminDisabledNames()].sort(), ['alive']);
  });
});

describe('isAdminDisabled', () => {
  it('returns true for blocked accounts', () => {
    writeRaw({ x: { disabledAt: isoFromNow(-1), ttlHours: 24 } });
    assert.equal(isAdminDisabled('x'), true);
  });

  it('returns false for unknown accounts', () => {
    assert.equal(isAdminDisabled('nope'), false);
  });

  it('returns false for expired accounts', () => {
    writeRaw({ x: { disabledAt: isoFromNow(-100), ttlHours: 24 } });
    assert.equal(isAdminDisabled('x'), false);
  });
});

describe('markAdminDisabled', () => {
  it('writes a new entry with default TTL', () => {
    markAdminDisabled('foo');
    const result = loadBlocklist();
    assert.ok(result.foo);
    assert.equal(result.foo.ttlHours, DEFAULT_TTL_HOURS);
    assert.ok(typeof result.foo.disabledAt === 'string');
    assert.ok(!isNaN(Date.parse(result.foo.disabledAt)));
  });

  it('records the optional reason', () => {
    markAdminDisabled('foo', { reason: 'admin override during test' });
    assert.equal(loadBlocklist().foo.reason, 'admin override during test');
  });

  it('honors custom ttlHours', () => {
    markAdminDisabled('foo', { ttlHours: 1 });
    assert.equal(loadBlocklist().foo.ttlHours, 1);
  });

  it('preserves other entries when adding a new one', () => {
    markAdminDisabled('a');
    markAdminDisabled('b');
    const names = Object.keys(loadBlocklist()).sort();
    assert.deepEqual(names, ['a', 'b']);
  });

  it('overwrites existing entry with the latest disabledAt', async () => {
    markAdminDisabled('foo', { reason: 'first' });
    const first = loadBlocklist().foo.disabledAt;
    // Ensure the second timestamp is strictly later.
    await new Promise(r => setTimeout(r, 5));
    markAdminDisabled('foo', { reason: 'second' });
    const second = loadBlocklist().foo;
    assert.equal(second.reason, 'second');
    assert.ok(Date.parse(second.disabledAt) >= Date.parse(first));
  });

  it('ignores invalid name (non-string or empty)', () => {
    markAdminDisabled('');
    markAdminDisabled(null);
    markAdminDisabled(undefined);
    markAdminDisabled(123);
    assert.deepEqual(loadBlocklist(), {});
  });

  it('writes the file with mode 0o600', () => {
    markAdminDisabled('foo');
    const mode = statSync(blocklistPath).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  });

  it('creates the parent directory if missing', () => {
    rmSync(tmp, { recursive: true, force: true });
    // Use a deeper nested path under the freshly-removed tmp parent.
    const nested = join(tmp, 'nested', 'admin-disabled.json');
    process.env.CLAUDE_NONSTOP_BLOCKLIST_FILE = nested;
    markAdminDisabled('foo');
    assert.ok(existsSync(nested));
  });
});

describe('clearAdminDisabled', () => {
  it('removes a single entry by name', () => {
    markAdminDisabled('a');
    markAdminDisabled('b');
    const result = clearAdminDisabled('a');
    assert.deepEqual(result.cleared, ['a']);
    assert.deepEqual(Object.keys(loadBlocklist()), ['b']);
  });

  it('returns empty array when name is not on the blocklist', () => {
    markAdminDisabled('a');
    const result = clearAdminDisabled('nope');
    assert.deepEqual(result.cleared, []);
    assert.deepEqual(Object.keys(loadBlocklist()), ['a']);
  });

  it('clears all entries and removes the file when called without a name', () => {
    markAdminDisabled('a');
    markAdminDisabled('b');
    assert.ok(existsSync(blocklistPath));
    const result = clearAdminDisabled();
    assert.deepEqual(result.cleared.sort(), ['a', 'b']);
    assert.ok(!existsSync(blocklistPath));
    assert.deepEqual(loadBlocklist(), {});
  });

  it('returns empty cleared list when blocklist is already empty (no file)', () => {
    const result = clearAdminDisabled();
    assert.deepEqual(result.cleared, []);
  });

  it('ignores expired entries when clearing by name', () => {
    writeRaw({
      expired: { disabledAt: isoFromNow(-100), ttlHours: 24 },
    });
    const result = clearAdminDisabled('expired');
    assert.deepEqual(result.cleared, []);  // expired entries are filtered out before clearing
  });
});

describe('atomic write semantics', () => {
  it('does not leave a .tmp file behind on success', () => {
    markAdminDisabled('foo');
    const tmpFiles = readdirSync(tmp).filter(e => e.endsWith('.tmp'));
    assert.equal(tmpFiles.length, 0, `unexpected tmp leftovers: ${tmpFiles.join(', ')}`);
  });

  it('produces valid JSON that round-trips', () => {
    markAdminDisabled('alpha', { reason: 'r1', ttlHours: 12 });
    markAdminDisabled('beta', { reason: 'r2' });
    const onDisk = JSON.parse(readFileSync(blocklistPath, 'utf8'));
    assert.equal(onDisk.alpha.reason, 'r1');
    assert.equal(onDisk.alpha.ttlHours, 12);
    assert.equal(onDisk.beta.reason, 'r2');
    assert.equal(onDisk.beta.ttlHours, DEFAULT_TTL_HOURS);
  });
});
