/**
 * The typed-price control's decisions, all of them outside a component.
 *
 * The scanner's vitest config is node-only on purpose ("Component and
 * end-to-end testing is lane D's column"), so every rule this feature has is in
 * `customAmount.ts` where a test can reach it — the same reason `deepLink.ts`
 * exists. A rule left inside a `useEffect` is a rule nothing here can prove.
 */

import { describe, expect, it } from 'vitest';
import { fils, formatMoney } from '@avo/types';
import { ApiError } from '../api/client';
import {
  CUSTOM_AMOUNT_MAX_FILS,
  REASON_MAX_CHARS,
  customAmountRefusal,
  parseTypedKd,
  typedChargeReady,
} from './customAmount';

// ───────────────────────────────────────────────────────── the field is KD ──

describe('parseTypedKd — the field is KD, the wire is fils', () => {
  /**
   * THE CASE THE BRIEF ASKS ABOUT, AND THE ONE `fils()`'s OWN ERROR NAMES:
   * "18.500 KD is fils(18500)".
   *
   * A staff member types what is on the price list, which is KD. `18.5` is
   * eighteen and a half dinars — 18500 fils — and NOT eighteen point five fils,
   * which is not a quantity of money that exists. The server's `parseAmountFils`
   * refuses a fraction precisely so that a client which never converted is told
   * rather than charged; this converts, so the server never sees one.
   */
  it('reads 18.5 as 18.500 KD — 18500 fils, not 18.5 of anything', () => {
    const parsed = parseTypedKd('18.5');
    expect(parsed).toEqual({ state: 'ok', amountFils: 18_500 });
    expect(formatMoney(fils(18_500))).toBe('18.500 KD');
  });

  it('treats a bare integer as whole dinars', () => {
    expect(parseTypedKd('18')).toEqual({ state: 'ok', amountFils: 18_000 });
    expect(parseTypedKd('1')).toEqual({ state: 'ok', amountFils: 1_000 });
  });

  it('pads a short fraction rather than reading it as fils', () => {
    expect(parseTypedKd('18.5')).toEqual({ state: 'ok', amountFils: 18_500 });
    expect(parseTypedKd('18.50')).toEqual({ state: 'ok', amountFils: 18_500 });
    expect(parseTypedKd('18.500')).toEqual({ state: 'ok', amountFils: 18_500 });
    expect(parseTypedKd('0.005')).toEqual({ state: 'ok', amountFils: 5 });
  });

  it('accepts a leading decimal point', () => {
    expect(parseTypedKd('.5')).toEqual({ state: 'ok', amountFils: 500 });
  });

  it('ignores surrounding whitespace', () => {
    expect(parseTypedKd('  18.5  ')).toEqual({ state: 'ok', amountFils: 18_500 });
  });

  /**
   * NO FLOAT TOUCHES THE CONVERSION (non-negotiable #1).
   *
   * `Number('1.005') * 1000` is 1004.9999999999999 and `Number('0.1') * 1000` is
   * 100.00000000000001 — both would reach `fils()` as non-integers and throw, and
   * a `Math.round` over the top would be a float deciding a price. The parse is
   * string-split then integer arithmetic, so these are exact.
   */
  it('converts the values a float multiply gets wrong', () => {
    expect(parseTypedKd('1.005')).toEqual({ state: 'ok', amountFils: 1_005 });
    expect(parseTypedKd('0.1')).toEqual({ state: 'ok', amountFils: 100 });
    expect(parseTypedKd('8.29')).toEqual({ state: 'ok', amountFils: 8_290 });
    expect(parseTypedKd('1.0000000001'.slice(0, 5))).toEqual({ state: 'ok', amountFils: 1_000 });
  });

  it('every accepted amount is a safe integer a branded Fils accepts', () => {
    for (const raw of ['18.5', '0.001', '200', '7', '99.999']) {
      const parsed = parseTypedKd(raw);
      expect(parsed.state).toBe('ok');
      if (parsed.state !== 'ok') continue;
      expect(Number.isSafeInteger(parsed.amountFils)).toBe(true);
      expect(() => fils(parsed.amountFils)).not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────── what it refuses ──

describe('parseTypedKd — what the keyboard will not send', () => {
  it('is empty, not invalid, before she has typed anything', () => {
    expect(parseTypedKd('')).toEqual({ state: 'empty' });
    expect(parseTypedKd('   ')).toEqual({ state: 'empty' });
    expect(parseTypedKd('.')).toEqual({ state: 'empty' });
  });

  /**
   * A FOURTH DECIMAL IS REFUSED, NOT ROUNDED. The dinar has three, so a fourth
   * digit means she is typing something other than what she thinks. Rounding it
   * silently would be a float's mistake made deliberately.
   */
  it('refuses a fourth decimal rather than rounding it away', () => {
    expect(parseTypedKd('18.5000')).toEqual({ state: 'invalid', why: 'too-precise' });
    expect(parseTypedKd('1.0005')).toEqual({ state: 'invalid', why: 'too-precise' });
  });

  it('refuses zero — there is nothing to charge', () => {
    expect(parseTypedKd('0')).toEqual({ state: 'invalid', why: 'zero' });
    expect(parseTypedKd('0.000')).toEqual({ state: 'invalid', why: 'zero' });
    expect(parseTypedKd('.0')).toEqual({ state: 'invalid', why: 'zero' });
  });

  it('refuses anything that is not a Western-digit decimal', () => {
    for (const raw of ['-5', '5-', 'abc', '1,5', '1.2.3', '١٨', '5 000', '1e3', '+5', '٥']) {
      expect(parseTypedKd(raw)).toEqual({ state: 'invalid', why: 'not-a-number' });
    }
  });

  it('refuses a figure too long to be a price rather than overflowing', () => {
    expect(parseTypedKd('9'.repeat(20))).toEqual({ state: 'invalid', why: 'not-a-number' });
  });
});

// ───────────────────────────────────────────────────────────── the ceiling ──

describe('parseTypedKd — the ceiling, mirrored not owned', () => {
  it('mirrors the server constant', () => {
    expect(CUSTOM_AMOUNT_MAX_FILS).toBe(200_000);
  });

  it('accepts the ceiling exactly', () => {
    expect(parseTypedKd('200')).toEqual({ state: 'ok', amountFils: 200_000 });
  });

  /**
   * Reported as its own state rather than folded into `invalid`, because it is
   * the one refusal where the artist's figure is a legible number she can be
   * shown back — "250.000 KD is over the 200.000 KD limit" — instead of being
   * told her typing is malformed.
   */
  it('reports a figure over the ceiling with the figure intact', () => {
    expect(parseTypedKd('200.001')).toEqual({ state: 'above-ceiling', amountFils: 200_001 });
    expect(parseTypedKd('250')).toEqual({ state: 'above-ceiling', amountFils: 250_000 });
  });
});

// ────────────────────────────────────────────────────── the reason beside it ──

describe('typedChargeReady — the server refuses without a reason, so the button waits for one', () => {
  it('is not ready on an amount alone', () => {
    expect(typedChargeReady(parseTypedKd('18.5'), '')).toBe(false);
    expect(typedChargeReady(parseTypedKd('18.5'), '   ')).toBe(false);
  });

  it('is not ready on a reason alone', () => {
    expect(typedChargeReady(parseTypedKd(''), 'Bridal trial')).toBe(false);
  });

  it('is ready with both', () => {
    expect(typedChargeReady(parseTypedKd('18.5'), 'Bridal trial')).toBe(true);
  });

  it('is not ready while the amount is refused', () => {
    expect(typedChargeReady(parseTypedKd('0'), 'Bridal trial')).toBe(false);
    expect(typedChargeReady(parseTypedKd('250'), 'Bridal trial')).toBe(false);
    expect(typedChargeReady(parseTypedKd('18.5000'), 'Bridal trial')).toBe(false);
  });

  it('refuses a reason longer than the server accepts', () => {
    expect(REASON_MAX_CHARS).toBe(300);
    expect(typedChargeReady(parseTypedKd('18.5'), 'x'.repeat(300))).toBe(true);
    expect(typedChargeReady(parseTypedKd('18.5'), 'x'.repeat(301))).toBe(false);
  });
});

// ────────────────────────────────────────────────────── the server's answers ──

const refusal = (status: number, code: string, message: string, details = {}) =>
  new ApiError({
    kind: status >= 500 ? 'server' : 'refused',
    message,
    code,
    status,
    reference: 'SCN-1000-2000',
    details,
  });

describe('customAmountRefusal — every refusal this endpoint can give is a sentence', () => {
  /**
   * THE PERMISSION-OFF CASE. The control is hidden from a staff member without
   * `perms.void`, and that hiding is a courtesy (non-negotiable #7). A cached
   * `perms.void: true` against a server that has revoked it puts a typed figure
   * on the wire and gets this back — so the sentence has to exist.
   *
   * The server's copy is rendered VERBATIM. It names `void`, not "custom
   * amount", because the gate really is `perms.void` — the API's own comment
   * says `perms.customAmount` would be the honest gate and is a four-way break a
   * lane may not make. Rewording it here would hide which permission was
   * actually refused; the scanner adds a line naming what she was doing instead.
   */
  it('renders the 403 verbatim and says what was refused', () => {
    const out = customAmountRefusal(
      refusal(403, 'forbidden', "You don't have permission to void a charge. A manager can grant it."),
    );
    expect(out.body).toBe("You don't have permission to void a charge. A manager can grant it.");
    expect(out.hint).toBe('Typing a price needs the same authority as voiding one.');
    expect(out.rereadPerms).toBe(true);
  });

  it('renders the ceiling refusal with the server figures, not a recomputed one', () => {
    const out = customAmountRefusal(
      refusal(
        400,
        'amount_above_ceiling',
        'A custom amount cannot exceed 200.000 KD. Check the figure — 250.000 KD looks like a typing mistake.',
        { maxFils: 200_000, amountFils: 250_000 },
      ),
    );
    expect(out.body).toContain('200.000 KD');
    expect(out.body).toContain('250.000 KD');
    expect(out.rereadPerms).toBe(false);
  });

  it('renders the fraction/zero refusal', () => {
    const out = customAmountRefusal(
      refusal(400, 'invalid_amount', 'amountFils must be a whole number of fils. 10.000 KD is 10000, not 10.5.'),
    );
    expect(out.body).toContain('whole number of fils');
  });

  /**
   * THE 422 ON A RE-TAP WITH A CHANGED FIGURE, AND THE HALF THAT IS EASY TO GET
   * BACKWARDS.
   *
   * The refused request did nothing. The EARLIER request under that same key —
   * the different body it is being compared against — may have charged. So the
   * reassuring reading of this refusal is the wrong one, and `outcomeUnknown`
   * makes the screen say the same thing it says when a response could not be
   * read: check her balance.
   */
  it('names the reused key and does not imply nothing happened', () => {
    const out = customAmountRefusal(
      refusal(422, 'idempotency_key_reused', 'That Idempotency-Key was already used for a different request. Use a new key.'),
    );
    expect(out.body).toBe(
      'That figure changed after the charge was sent. The earlier amount may already have gone through.',
    );
    expect(out.outcomeUnknown).toBe(true);
  });

  it('names the missing reason', () => {
    const out = customAmountRefusal(refusal(400, 'invalid_request', 'reason is required.'));
    expect(out.body).toBe('reason is required.');
  });

  it('falls back to the server message for a code it does not know', () => {
    const out = customAmountRefusal(refusal(409, 'something_new', 'A brand new refusal.'));
    expect(out.body).toBe('A brand new refusal.');
    expect(out.outcomeUnknown).toBe(false);
  });

  it('keeps the offline failure distinguishable — nothing left the device', () => {
    const out = customAmountRefusal(
      new ApiError({ kind: 'offline', message: 'No connection.', reference: 'SCN-1-2' }),
    );
    expect(out.offline).toBe(true);
  });
});
