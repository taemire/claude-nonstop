import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildNotifyCommand, notifyDesktop, APP_LABEL } from '../../../lib/notify.js';

describe('buildNotifyCommand — macOS', () => {
  it('returns an osascript command on darwin', () => {
    const c = buildNotifyCommand('T', 'M', 'darwin');
    assert.equal(c.cmd, 'osascript');
    assert.ok(Array.isArray(c.args));
  });

  it('passes message and title as argv values (message then title)', () => {
    const c = buildNotifyCommand('My Title', 'My Message', 'darwin');
    assert.equal(c.args[c.args.length - 2], 'My Message');
    assert.equal(c.args[c.args.length - 1], 'My Title');
  });

  it('reads values from argv via "on run argv" (injection-safe AppleScript)', () => {
    const c = buildNotifyCommand('T', 'M', 'darwin');
    assert.ok(c.args.includes('on run argv'));
    assert.ok(c.args.some(a => a.includes('item 1 of argv') && a.includes('item 2 of argv')));
  });

  it('keeps shell/AppleScript metacharacters as a single literal argument', () => {
    const evil = '"; rm -rf / "$(whoami)" \\ end tell';
    const c = buildNotifyCommand('title', evil, 'darwin');
    // the dangerous string survives verbatim as ONE argv element — never split,
    // expanded, or interpolated into the AppleScript source.
    assert.ok(c.args.includes(evil));
  });
});

describe('buildNotifyCommand — Linux', () => {
  it('returns a notify-send command with [title, message]', () => {
    const c = buildNotifyCommand('T', 'M', 'linux');
    assert.deepEqual(c, { cmd: 'notify-send', args: ['T', 'M'] });
  });
});

describe('buildNotifyCommand — other / edge cases', () => {
  it('returns null on unsupported platforms', () => {
    assert.equal(buildNotifyCommand('T', 'M', 'win32'), null);
    assert.equal(buildNotifyCommand('T', 'M', 'aix'), null);
  });

  it('coerces null/undefined to safe strings', () => {
    const c = buildNotifyCommand(undefined, undefined, 'linux');
    assert.equal(c.args[0], APP_LABEL); // title falls back to APP_LABEL
    assert.equal(c.args[1], '');        // message falls back to empty string
  });
});

describe('notifyDesktop', () => {
  it('dispatches via injected execImpl on a supported platform', () => {
    const calls = [];
    const ok = notifyDesktop('T', 'M', {
      plat: 'linux',
      execImpl: (cmd, args) => { calls.push({ cmd, args }); return { unref() {} }; },
    });
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'notify-send');
    assert.deepEqual(calls[0].args, ['T', 'M']);
  });

  it('no-ops (no dispatch) on unsupported platforms', () => {
    let called = false;
    const ok = notifyDesktop('T', 'M', { plat: 'win32', execImpl: () => { called = true; } });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it('never throws even if execImpl throws', () => {
    const ok = notifyDesktop('T', 'M', {
      plat: 'darwin',
      execImpl: () => { throw new Error('spawn failed'); },
    });
    assert.equal(ok, false);
  });

  it('returns a boolean', () => {
    assert.equal(typeof notifyDesktop('T', 'M', { plat: 'win32', execImpl: () => {} }), 'boolean');
  });
});
