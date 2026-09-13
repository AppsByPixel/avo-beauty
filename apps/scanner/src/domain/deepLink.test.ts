/**
 * A URL is not a scan.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BUG: THE SCANNER ACCUSED THE CUSTOMER BEFORE THE CAMERA WAS EVEN ON.
 *
 * `ScanScreen`'s deep-link effect did this:
 *
 *     void Linking.getInitialURL().then((url) => { if (url) accept(url); });
 *
 * `getInitialURL()` is the URL that LAUNCHED THE APP, not a scanned code. It is
 * handed straight to `accept`, which parses it, fails, and sets `unreadable` —
 * so the screen rendered "That isn't an AVO wallet code." with the camera off
 * and nothing ever scanned. Driven on a simulator: the message sat under the
 * "Allow camera access" button on a freshly opened scanner.
 *
 * Under Expo Go it is unconditional, because the launch URL is always `exp://…`.
 * In a standalone build launched from the home screen `getInitialURL()` is null
 * and nothing shows — but any launch through a link that is not a payment code
 * (a universal link, a notification tap, an `avo://` route added later) puts a
 * false accusation in front of a staff member holding a customer's phone.
 *
 * THE DISTINCTION THIS MODULE DRAWS. A scan that did not parse deserves the
 * message: someone pointed the camera at something and it was not a wallet code.
 * A URL that was never a scan deserves silence. Both still reach the SAME
 * `accept` in the screen — this filters, it does not fork.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from 'vitest';
import { deepLinkAction } from './deepLink';

describe('a URL that is not a payment code', () => {
  it('is ignored, not reported as an unreadable scan', () => {
    // THE ONE THAT SHIPPED. Expo Go's launch URL, every single time.
    expect(deepLinkAction('exp://127.0.0.1:8199')).toEqual({ kind: 'ignore' });
  });

  it('is ignored for every launch shape that is not a payment code', () => {
    const notCodes = [
      'exp+avo-scanner://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8199',
      'https://avorewards.com/staff',
      'avo://home',
      'avostaff://pay', // our scheme, our path, but no credential
      'avostaff://pay?m=8842', // half a credential
      'avostaff://pay?t=wt_9f2c41', // the other half
      '',
      '   ',
    ];
    for (const url of notCodes) {
      expect(deepLinkAction(url), url).toEqual({ kind: 'ignore' });
    }
  });

  it('is ignored when there is no launch URL at all', () => {
    // A standalone build opened from the home screen.
    expect(deepLinkAction(null)).toEqual({ kind: 'ignore' });
  });
});

describe('a URL that IS a payment code', () => {
  /**
   * The path must keep working. It is the only way to exercise a charge on
   * hardware with no camera, and it is a real delivery route in production.
   */
  it('still charges', () => {
    expect(deepLinkAction('avostaff://pay?m=8842&t=wt_9f2c41')).toEqual({
      kind: 'charge',
      code: { memberId: '8842', token: 'wt_9f2c41' },
    });
  });

  it('accepts the same forms the parser accepts, including trimming and case', () => {
    expect(deepLinkAction('  avostaff://pay?m=8842&t=wt_1  ')).toEqual({
      kind: 'charge',
      code: { memberId: '8842', token: 'wt_1' },
    });
    expect(deepLinkAction('AVOSTAFF://PAY?m=8842&t=wt_1').kind).toBe('charge');
  });

  /**
   * The member id in the URI is NOT the thing charged — the token is the
   * credential and the server resolves it. This module must not start deciding
   * otherwise; it hands over exactly what the parser returned.
   */
  it('hands over the parser’s result unchanged', () => {
    const action = deepLinkAction('avostaff://pay?m=forged&t=wt_real');
    expect(action).toEqual({ kind: 'charge', code: { memberId: 'forged', token: 'wt_real' } });
  });
});

describe('the invariant', () => {
  it('never asks for a charge without a code, and never a code without a charge', () => {
    const urls = [
      null,
      '',
      'exp://127.0.0.1:8199',
      'avostaff://pay',
      'avostaff://pay?m=8842&t=wt_1',
      'https://example.com',
    ];
    for (const url of urls) {
      const action = deepLinkAction(url);
      if (action.kind === 'charge') {
        expect(action.code.memberId).toBeTruthy();
        expect(action.code.token).toBeTruthy();
      } else {
        expect(action).toEqual({ kind: 'ignore' });
      }
    }
  });
});
