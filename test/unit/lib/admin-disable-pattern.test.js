import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_DISABLE_PATTERN, normalizeBannerBuffer } from '../../../lib/runner.js';

describe('ADMIN_DISABLE_PATTERN', () => {
  it('matches the disabled-state sentence on its own', () => {
    const banner = 'Your usage allocation has been disabled by your admin';
    assert.match(banner, ADMIN_DISABLE_PATTERN);
  });

  it('matches the sentence inside a larger output buffer', () => {
    const output = [
      '❯ 진행',
      'Your usage allocation has been disabled by your admin',
      '/extra-usage to request more usage from your admin.',
      '',
    ].join('\n');
    assert.match(output, ADMIN_DISABLE_PATTERN);
  });

  it('does NOT match the /extra-usage CTA alone', () => {
    const text = 'Run /extra-usage to request more usage from your admin if you need it.';
    assert.doesNotMatch(text, ADMIN_DISABLE_PATTERN);
  });

  it('does NOT match a paraphrased mention', () => {
    const text = 'The admin disabled my usage allocation yesterday.';
    assert.doesNotMatch(text, ADMIN_DISABLE_PATTERN);
  });
});

describe('normalizeBannerBuffer', () => {
  it('reassembles the sentence inside a box-drawn frame', () => {
    const banner = [
      '╭───────────────────────────────────────────────────────────╮',
      '│ Your usage allocation has been disabled by your admin     │',
      '│                                                           │',
      '│ /extra-usage to request more usage from your admin        │',
      '╰───────────────────────────────────────────────────────────╯',
    ].join('\n');
    assert.match(normalizeBannerBuffer(banner), ADMIN_DISABLE_PATTERN);
  });

  it('reassembles a sentence wrapped across two box-drawn lines', () => {
    const banner = [
      '╭──────────────────────────────────────────────╮',
      '│ Your usage allocation has been disabled by   │',
      '│ your admin                                   │',
      '╰──────────────────────────────────────────────╯',
    ].join('\n');
    assert.match(normalizeBannerBuffer(banner), ADMIN_DISABLE_PATTERN);
  });

  it('strips ANSI color codes around the sentence', () => {
    const banner = '\x1b[31mYour usage allocation has been disabled by your admin\x1b[0m';
    assert.match(normalizeBannerBuffer(banner), ADMIN_DISABLE_PATTERN);
  });

  it('tolerates CRLF line endings', () => {
    const banner =
      '│ Your usage allocation has been disabled by\r\n' +
      '│ your admin\r\n' +
      '│ /extra-usage to request more usage from your admin\r\n';
    assert.match(normalizeBannerBuffer(banner), ADMIN_DISABLE_PATTERN);
  });

  it('does NOT spuriously join paraphrased fragments into the sentence', () => {
    const text = [
      'Your usage allocation got blocked,',
      'and the admin should re-enable it.',
    ].join('\n');
    assert.doesNotMatch(normalizeBannerBuffer(text), ADMIN_DISABLE_PATTERN);
  });
});
