import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_DISABLE_PATTERN } from '../../../lib/runner.js';

describe('ADMIN_DISABLE_PATTERN', () => {
  it('matches the genuine two-line CLI banner', () => {
    const banner = [
      'Your usage allocation has been disabled by your admin',
      '/extra-usage to request more usage from your admin.',
    ].join('\n');
    assert.match(banner, ADMIN_DISABLE_PATTERN);
  });

  it('matches the banner inside a larger output buffer', () => {
    const output = [
      '❯ 진행',
      'Your usage allocation has been disabled by your admin',
      '/extra-usage to request more usage from your admin.',
      '',
    ].join('\n');
    assert.match(output, ADMIN_DISABLE_PATTERN);
  });

  it('tolerates CRLF line endings', () => {
    const banner =
      'Your usage allocation has been disabled by your admin\r\n' +
      '/extra-usage to request more usage from your admin';
    assert.match(banner, ADMIN_DISABLE_PATTERN);
  });

  it('does NOT match the disabled-state sentence alone', () => {
    const text = 'Your usage allocation has been disabled by your admin yesterday.';
    assert.doesNotMatch(text, ADMIN_DISABLE_PATTERN);
  });

  it('does NOT match the /extra-usage CTA alone', () => {
    const text = 'Run /extra-usage to request more usage from your admin if you need it.';
    assert.doesNotMatch(text, ADMIN_DISABLE_PATTERN);
  });

  it('does NOT match when the two sentences are separated by prose', () => {
    const text = [
      'Your usage allocation has been disabled by your admin.',
      'After waiting, you can typically run',
      '/extra-usage to request more usage from your admin.',
    ].join('\n');
    assert.doesNotMatch(text, ADMIN_DISABLE_PATTERN);
  });

  it('does NOT match the regex literal being quoted in markdown', () => {
    const text =
      'The detector uses `Your usage allocation has been disabled by your admin` ' +
      'and falls back to `/extra-usage to request more usage from your admin`.';
    assert.doesNotMatch(text, ADMIN_DISABLE_PATTERN);
  });
});
