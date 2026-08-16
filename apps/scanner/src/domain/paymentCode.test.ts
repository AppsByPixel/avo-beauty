/**
 * The parser is the scanner's front door: every string a camera reads at a
 * salon counter arrives here first. These pin the refusals, not just the happy
 * path — a code that is almost right is the dangerous one.
 */

import { describe, expect, it } from 'vitest';
import { walletTokenUri } from '@avo/types';
import { parsePaymentCode } from './paymentCode';

describe('parsePaymentCode', () => {
  it('round-trips what the wallet mints', () => {
    // The one that matters: this is the exact function apps/wallet renders into
    // its QR, so if these two ever drift the pilot stops working.
    const uri = walletTokenUri('8842', 'wt_abc123');
    expect(parsePaymentCode(uri)).toEqual({ memberId: '8842', token: 'wt_abc123' });
  });

  it('reads a plain code', () => {
    expect(parsePaymentCode('avo://pay?m=8842&t=tok')).toEqual({
      memberId: '8842',
      token: 'tok',
    });
  });

  it('decodes percent-escapes', () => {
    const uri = walletTokenUri('member/8842', 'a+b=c&d');
    expect(parsePaymentCode(uri)).toEqual({ memberId: 'member/8842', token: 'a+b=c&d' });
  });

  it('tolerates surrounding whitespace from the decoder', () => {
    expect(parsePaymentCode('  avo://pay?m=1&t=2  ')).toEqual({ memberId: '1', token: '2' });
  });

  it('ignores parameter order and extra parameters', () => {
    expect(parsePaymentCode('avo://pay?t=tok&v=2&m=8842')).toEqual({
      memberId: '8842',
      token: 'tok',
    });
  });

  // ------------------------------------------------------------- refusals --

  it.each([
    ['a URL that is not ours', 'https://example.com/?m=1&t=2'],
    ['our scheme, wrong path', 'avo://topup?m=1&t=2'],
    ['no query at all', 'avo://pay'],
    ['a missing token', 'avo://pay?m=8842'],
    ['a missing member', 'avo://pay?t=tok'],
    ['an empty token', 'avo://pay?m=8842&t='],
    ['an empty member', 'avo://pay?m=&t=tok'],
    ['a bare number, like a loyalty card', '8842'],
    ['empty input', ''],
    ['a malformed percent-escape', 'avo://pay?m=8842&t=%E0%A4%A'],
  ])('refuses %s', (_label, input) => {
    expect(parsePaymentCode(input)).toBeNull();
  });
});
