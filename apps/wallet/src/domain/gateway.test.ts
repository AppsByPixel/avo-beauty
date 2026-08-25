/**
 * A failed open must come back as something, for every possible something.
 *
 * The behaviour under test is not the classification — it is that NOTHING gets
 * dropped. `platform/gateway.ts` used to end a failed open with
 * `.catch(() => undefined)`, and the specification that replaces it is: whatever
 * the platform throws, the caller gets a named failure it can put on a screen.
 *
 * So the first describe block is the important one. The reasons matter less; they
 * exist so a developer reading a console line knows which of four problems to go
 * and fix, and a reason that stops matching degrades to `error` rather than to
 * silence.
 */

import { describe, expect, it } from 'vitest';
import { classifyOpenFailure, gatewayOpenLog, unsupportedScheme } from './gateway';

describe('nothing thrown at it is ever swallowed', () => {
  const THROWN: unknown[] = [
    new Error('Another WebBrowser is already being presented.'),
    new Error(''),
    'a bare string',
    '',
    null,
    undefined,
    0,
    { code: 'ERR_WEB_BROWSER' },
    { toJSON: () => { throw new Error('unserialisable'); } },
    [],
  ];

  it('returns a failure with a reason and a detail for every input', () => {
    for (const thrown of THROWN) {
      const out = classifyOpenFailure(thrown);
      expect(out.opened).toBe(false);
      expect(out.reason).toBeTruthy();
      // A detail that is the empty string is the swallow wearing a different
      // hat: it prints as nothing and tells the next reader nothing.
      expect(out.detail.length).toBeGreaterThan(0);
    }
  });

  it('never returns opened: true from a failure', () => {
    for (const thrown of THROWN) {
      expect(classifyOpenFailure(thrown).opened).not.toBe(true);
    }
  });

  it('does not itself throw on anything', () => {
    for (const thrown of THROWN) {
      expect(() => classifyOpenFailure(thrown)).not.toThrow();
    }
  });
});

describe('the reasons a developer will read off the console', () => {
  it('names a second session as busy, not as a generic error', () => {
    // expo-web-browser's own wording when a session is already presented.
    expect(classifyOpenFailure(new Error('Another WebBrowser is already being presented.')).reason)
      .toBe('busy');
  });

  it('names a URL nothing can handle as unavailable', () => {
    expect(classifyOpenFailure(new Error('No handler for URL: knet://pay')).reason)
      .toBe('unavailable');
    expect(classifyOpenFailure(new Error('Unsupported URL')).reason).toBe('unavailable');
    expect(classifyOpenFailure(new Error('No Activity found to handle Intent')).reason)
      .toBe('unavailable');
  });

  it('names a refused window as blocked', () => {
    expect(classifyOpenFailure(new Error('Popup blocked by the browser')).reason).toBe('blocked');
  });

  it('falls back to error rather than to nothing when the text is unfamiliar', () => {
    const out = classifyOpenFailure(new Error('EXPO_SOMETHING_NOBODY_HAS_SEEN'));
    expect(out.reason).toBe('error');
    expect(out.detail).toBe('EXPO_SOMETHING_NOBODY_HAS_SEEN');
  });

  it('keeps the underlying message as the detail', () => {
    expect(classifyOpenFailure(new Error('boom')).detail).toBe('boom');
  });
});

describe('the console line', () => {
  const failure = { reason: 'unavailable' as const, detail: 'No handler for URL' };

  it('names the intent, because an orphan is what the failure leaves behind', () => {
    expect(gatewayOpenLog('TI-Y2EI29', failure)).toContain('TI-Y2EI29');
  });

  it('carries the reason and the detail', () => {
    const line = gatewayOpenLog('TI-Y2EI29', failure);
    expect(line).toContain('unavailable');
    expect(line).toContain('No handler for URL');
  });

  it('says the intent was not charged, so nobody reads it as a lost payment', () => {
    expect(gatewayOpenLog('TI-Y2EI29', failure)).toContain('NOT charged');
  });
});

/**
 * The guard that stands between a server-supplied URL and a crash.
 *
 * Driven, and this is not a hypothetical: `ASWebAuthenticationSession` raises an
 * Objective-C `NSInvalidArgumentException` — "Only HTTP and HTTPS URLs are
 * supported" — for anything else, and it kills the process rather than rejecting
 * the promise. The wallet terminated mid top-up with an intent open on the
 * server. No `try` around the call can catch it, so the check has to happen
 * first, and it has to be right.
 */
describe('a redirect URL an in-app browser session cannot be given', () => {
  it('lets the two schemes through that actually work', () => {
    expect(unsupportedScheme('http://localhost:4180/_gateway/SBX-1')).toBeNull();
    expect(unsupportedScheme('https://pay.knet.com.kw/checkout/abc')).toBeNull();
    // Case is not part of a scheme's identity.
    expect(unsupportedScheme('HTTPS://pay.knet.com.kw/x')).toBeNull();
    expect(unsupportedScheme('  https://pay.knet.com.kw/x  ')).toBeNull();
  });

  it('refuses the app-link schemes a regional processor may hand back', () => {
    for (const url of [
      'knet://pay/SBX-1',
      'knet-sandbox://pay/_gateway/SBX-1',
      'avo://topup/return',
      'itms-apps://apps.apple.com/app/id1',
    ]) {
      const out = unsupportedScheme(url);
      expect(out).not.toBeNull();
      expect(out?.opened).toBe(false);
      expect(out?.reason).toBe('unavailable');
    }
  });

  it('refuses a string that is not a URL at all rather than passing it on', () => {
    for (const url of ['', '   ', 'not a url', '/_gateway/SBX-1', '//pay.knet.com.kw/x']) {
      expect(unsupportedScheme(url)).not.toBeNull();
    }
  });

  it('names the offending scheme in the detail, so the log is actionable', () => {
    expect(unsupportedScheme('knet://pay')?.detail).toContain('"knet"');
    expect(unsupportedScheme('nonsense')?.detail).toContain('unparseable');
  });

  it('does not let a scheme sneak past by hiding inside the path', () => {
    // The crash is decided by the LEADING scheme, so that is what is read.
    expect(unsupportedScheme('knet://pay?next=https://ok.example')).not.toBeNull();
  });
});
