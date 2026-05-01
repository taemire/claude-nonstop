import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADMIN_DISABLE_PATTERN,
  ADMIN_DISABLE_KEYWORDS,
  detectAdminDisabled,
  normalizeBannerBuffer,
} from '../../../lib/runner.js';

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

  it('strips DEC private CSI (cursor hide/show) intermixed with sentence', () => {
    // `?25` includes `?` which the old [0-9;]* CSI matcher rejected, leaving
    // ESC bytes wedged between letters. The widened CSI grammar must absorb
    // private-mode parameter bytes (0x30–0x3F).
    const banner =
      '\x1b[?25l\x1b[1;1HYour usage allocation has been disabled by your admin\x1b[?25h';
    assert.match(normalizeBannerBuffer(banner), ADMIN_DISABLE_PATTERN);
  });

  it('strips OSC sequences terminated by ST (ESC \\)', () => {
    const banner =
      '\x1b]0;tab title\x1b\\Your usage allocation has been disabled by your admin';
    assert.match(normalizeBannerBuffer(banner), ADMIN_DISABLE_PATTERN);
  });

  it('removes Geometric Shapes glyphs (U+25A0–U+25FF) outside the old range', () => {
    // The old [─-▟] range covered U+2500–U+259F only; ◾ (U+25FE) survived
    // and broke whitespace collapse around it.
    const banner = '◾ Your usage allocation has been disabled by your admin ◾';
    assert.match(normalizeBannerBuffer(banner), ADMIN_DISABLE_PATTERN);
  });

  it('reassembles a list-item-corner banner shape (└ + tail line)', () => {
    // The 2026-05-01 occurrence in the wild used this list-style frame
    // instead of the four-corner ╭╰ box. Both must reduce to the same
    // contiguous sentence after normalization.
    const banner = [
      '└ Your usage allocation has been disabled by your admin',
      '  /extra-usage to request more usage from your admin.',
    ].join('\n');
    assert.match(normalizeBannerBuffer(banner), ADMIN_DISABLE_PATTERN);
  });
});

describe('detectAdminDisabled', () => {
  it('reports phrase match when the sentence is intact post-normalization', () => {
    const banner = [
      '╭─────────────────────────────────────────╮',
      '│ Your usage allocation has been disabled │',
      '│ by your admin                           │',
      '╰─────────────────────────────────────────╯',
    ].join('\n');
    const result = detectAdminDisabled(banner);
    assert.equal(result.matched, true);
    assert.equal(result.via, 'phrase');
  });

  it('falls back to keyword-AND when phrase is splintered beyond reassembly', () => {
    // Simulates a renderer that rewrites the same screen region piecewise so
    // the literal sentence is never contiguous in the buffer. All four
    // markers still appear within the 8 KB window.
    const splintered = [
      'banner top: usage allocation status',
      'middle line: this account has been disabled',
      'CTA: run /extra-usage for more',
      'footer: by your admin',
    ].join('\n');
    const result = detectAdminDisabled(splintered);
    assert.equal(result.matched, true);
    assert.equal(result.via, 'keyword-and');
  });

  it('does NOT match when only three of four keywords appear', () => {
    // Missing `/extra-usage` — paraphrase that mentions usage allocation,
    // disablement, and admin but not the literal slash command.
    const text =
      'Your usage allocation has been disabled briefly by your admin earlier today.';
    // Phrase regex would actually match this — verify the text we pick
    // tests keyword-AND independence by removing the literal phrase.
    const safer =
      'There was an issue with the usage allocation that has been disabled today by your admin. Please retry later.';
    // The above contains the phrase verbatim too. Build a cleanly negative
    // example by paraphrasing every marker except three.
    const negative = [
      'Your usage allocation tracker',
      'shows the policy has been disabled',
      'this morning by your admin team — please follow up.',
    ].join(' ');
    const result = detectAdminDisabled(negative);
    assert.equal(result.matched, false, 'must not match without /extra-usage');
    // Sanity: keep the unused fixtures referenced so future readers see the
    // intent if they tighten the assertion.
    assert.ok(text.length > 0 && safer.length > 0);
  });

  it('exposes ADMIN_DISABLE_KEYWORDS as a 4-element regex array', () => {
    assert.ok(Array.isArray(ADMIN_DISABLE_KEYWORDS));
    assert.equal(ADMIN_DISABLE_KEYWORDS.length, 4);
    for (const re of ADMIN_DISABLE_KEYWORDS) {
      assert.ok(re instanceof RegExp);
    }
  });

  it('returns the normalized buffer alongside the verdict for diagnostics', () => {
    const banner = '│ Your usage allocation has been disabled by your admin │';
    const result = detectAdminDisabled(banner);
    assert.equal(typeof result.normalized, 'string');
    assert.match(result.normalized, /usage allocation/);
    assert.doesNotMatch(result.normalized, /│/);
  });
});
