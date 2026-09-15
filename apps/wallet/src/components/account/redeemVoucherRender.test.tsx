// @vitest-environment jsdom

/**
 * THE REDEEM SHEET, RENDERED — the half `domain/voucher.test.ts` cannot reach.
 *
 * The domain spec proves what each failure MEANS. It cannot prove the sheet asks
 * the right question, holds one idempotency key across a retry, shows the
 * server's balance rather than a sum, or labels its money for a screen reader.
 * That gap is the one DECISIONS #38 records in the Pay tab — the rule was tested
 * and the call to it was not — and `topUpCardRender.test.tsx` exists for the same
 * reason.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ARIA LABEL IS ASSERTED ALONGSIDE EVERY VISIBLE FIGURE, DELIBERATELY.
 * ═════════════════════════════════════════════════════════════════════════════
 * Lane C's sharpest mutation proof went red on ONLY the aria-label: the visible
 * string was right by accident. A hand-rolled `(fils/1000).toFixed(3)` produces
 * "5.000" and announces "five point zero zero zero"; `moneyAriaLabel` announces
 * Kuwaiti dinars, which interaction-spec.md §2 requires. A screenshot review
 * cannot see the difference, so the test has to.
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted`, the idiom `state/useShopCheckout.test.tsx` established here:
// `vi.mock` is hoisted above every `const`, so a plain top-level fn is not yet
// initialised when the factory runs.
const { redeemVoucher, newIdempotencyKey } = vi.hoisted(() => ({
  redeemVoucher: vi.fn(),
  newIdempotencyKey: vi.fn(),
}));

vi.mock('../../api/vouchers', () => ({ redeemVoucher, newIdempotencyKey }));

// eslint-disable-next-line import/first
import { ApiError } from '../../api/client';
// eslint-disable-next-line import/first
import { RedeemVoucherSheet } from './RedeemVoucherSheet';
// eslint-disable-next-line import/first
import { LanguageProvider } from '../../i18n/language';
// eslint-disable-next-line import/first
import { en } from '../../copy/en';
// eslint-disable-next-line import/first
import { NOT_REDEEMABLE } from '../../domain/voucher';

/**
 * The 200 the real API answered on avo_lane_b, port 4710, for code
 * `26LJN8HAGKMD` — a 5.000 KD voucher against a 24.500 KD balance. Transcribed,
 * not composed: `api/shop.test.ts`'s "a schema narrower than the wire" lesson.
 */
const REDEMPTION = {
  voucher: {
    id: 'VCH-441874b7-df6',
    code: '26LJN8HAGKMD',
    memberId: '8842',
    amountFils: 5000,
    reason: 'Late appointment on 3 Sep',
    expiresAt: null,
    createdAt: '2026-09-15T09:14:23.731Z',
    redeemedAt: '2026-09-15T09:14:41.100Z',
    redeemedTransactionId: 'TX-VCH-2c74284c-511',
    voidedAt: null,
    redeemable: false,
  },
  creditedFils: 5000,
  balanceAfterFils: 29500,
};

/** The 409 all five dead states answer with. */
const refusal = () =>
  new ApiError(
    'server',
    'That code cannot be redeemed. Check it and try again, or contact support.',
    'WLT-1234-5678',
    409,
    NOT_REDEEMABLE,
  );

function mount(opts: { lang?: 'en' | 'ar'; onRedeemed?: () => void; onClose?: () => void } = {}) {
  return render(
    <LanguageProvider initial={opts.lang ?? 'en'}>
      <RedeemVoucherSheet
        open
        onClose={opts.onClose ?? (() => {})}
        onRedeemed={opts.onRedeemed ?? (() => {})}
      />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  redeemVoucher.mockReset();
  newIdempotencyKey.mockReset();
  let n = 0;
  newIdempotencyKey.mockImplementation(() => `wlt-key-${++n}`);
});

afterEach(cleanup);

describe('the empty state — the sheet as it opens', () => {
  it('names what a voucher is, because the design drew no surface she could learn it from', () => {
    const { container } = mount();
    expect(container.textContent).toContain(en.vchSub);
    expect(container.textContent).toContain(en.vchTitle);
  });

  it('will not submit an empty field', () => {
    const { getByTestId } = mount();
    expect(getByTestId('voucher-submit').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(getByTestId('voucher-submit'));
    expect(redeemVoucher).not.toHaveBeenCalled();
  });

  it('will not submit whitespace either', () => {
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '   ' } });
    expect(getByTestId('voucher-submit').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('what the sheet sends', () => {
  /**
   * SENT AS SHE TYPED IT. `normaliseCode` upper-cases and strips spaces and
   * dashes server-side; normalising here as well would put the rule in two
   * places, and the second copy is the one that drifts. Driven:
   * `"vmq5-cxmc-ggk3"` redeemed `VMQ5CXMCGGK3`, HTTP 200.
   */
  it('sends the code unmodified, and only the code', async () => {
    redeemVoucher.mockResolvedValue(REDEMPTION);
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: 'vmq5-cxmc-ggk3' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(redeemVoucher).toHaveBeenCalled());
    expect(redeemVoucher.mock.calls[0]![0]).toBe('vmq5-cxmc-ggk3');
  });

  /** Non-negotiable #4. The server refuses the request without one. */
  it('sends an idempotency key', async () => {
    redeemVoucher.mockResolvedValue(REDEMPTION);
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(redeemVoucher).toHaveBeenCalled());
    expect(redeemVoucher.mock.calls[0]![1]).toBe('wlt-key-1');
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE KEY ACROSS A RETRY. THIS IS THE MONEY TEST IN THIS FILE.
   * ═══════════════════════════════════════════════════════════════════════════
   * A redeem that timed out may well have committed. A FRESH key on the retry
   * would present a code the server has already marked `redeemed_at`, the atomic
   * claim would refuse it, and she would be told a voucher that worked did not —
   * with the credit sitting unexplained in her balance. Holding the key sends the
   * retry into `awaitCommittedKey`, which replays the winner's response verbatim.
   *
   * Driven against avo_lane_b: the same key twice returned byte-identical 200s,
   * `balanceAfterFils: 29500` both times, and the balance moved once.
   */
  it('reuses one key when a transport failure is retried', async () => {
    redeemVoucher.mockRejectedValueOnce(
      new ApiError('offline', 'No connection.', 'WLT-1111-2222', null),
    );
    redeemVoucher.mockResolvedValueOnce(REDEMPTION);
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(getByTestId('voucher-error').textContent).toContain('connection'));

    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(redeemVoucher).toHaveBeenCalledTimes(2));
    expect(redeemVoucher.mock.calls[1]![1]).toBe(redeemVoucher.mock.calls[0]![1]);
  });

  /**
   * AND A NEW CODE IS A NEW ATTEMPT. The stored key hashes the body, so reusing
   * it with different text is a 422 rather than a replay — api-contract.md's
   * addendum. Editing the field must therefore burn the key.
   */
  it('mints a fresh key once she edits the code', async () => {
    redeemVoucher.mockRejectedValueOnce(
      new ApiError('offline', 'No connection.', 'WLT-1111-2222', null),
    );
    redeemVoucher.mockResolvedValueOnce(REDEMPTION);
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(redeemVoucher).toHaveBeenCalledTimes(1));

    fireEvent.change(getByTestId('voucher-code'), { target: { value: 'VMQ5CXMCGGK3' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(redeemVoucher).toHaveBeenCalledTimes(2));
    expect(redeemVoucher.mock.calls[1]![1]).not.toBe(redeemVoucher.mock.calls[0]![1]);
  });
});

describe('the confirmation', () => {
  /**
   * BOTH NUMBERS ARE THE SERVER'S. `creditedFils` and `balanceAfterFils` come
   * off the response, computed inside the same transaction as the credit and the
   * ledger pair. 24.500 + 5.000 = 29.500 happens to hold here — which is exactly
   * why the balance is asserted against the RESPONSE and the sheet is never
   * given the old balance to add to (#2).
   */
  it('shows the credit and the new balance, both formatted and both announced', async () => {
    redeemVoucher.mockResolvedValue(REDEMPTION);
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    fireEvent.click(getByTestId('voucher-submit'));

    const credited = await waitFor(() => getByTestId('voucher-credited'));
    expect(credited.textContent).toBe('5.000 KD');
    // THE HALF A SCREENSHOT MISSES.
    expect(credited.getAttribute('aria-label')).toBe('5.000 Kuwaiti dinars');

    const balance = getByTestId('voucher-balance');
    expect(balance.textContent).toBe('29.500 KD');
    expect(balance.getAttribute('aria-label')).toBe('29.500 Kuwaiti dinars');
  });

  /** #12: Western digits for money, Arabic unit, in an Arabic sheet. */
  it('keeps money Western in Arabic and announces it in Arabic', async () => {
    redeemVoucher.mockResolvedValue(REDEMPTION);
    const { getByTestId } = mount({ lang: 'ar' });
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    fireEvent.click(getByTestId('voucher-submit'));

    const credited = await waitFor(() => getByTestId('voucher-credited'));
    expect(credited.textContent).toContain('5.000');
    expect(credited.textContent).toContain('د.ك');
    expect(credited.textContent).not.toMatch(/[٠-٩]/);
    const label = credited.getAttribute('aria-label') ?? '';
    expect(label).toContain('5.000');
    expect(label).not.toBe(credited.textContent);
  });

  /** Non-negotiable #5, on the one screen where she is being compensated. */
  it('says it is wallet credit and offers neither cash nor a card reversal', async () => {
    redeemVoucher.mockResolvedValue(REDEMPTION);
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    fireEvent.click(getByTestId('voucher-submit'));
    const done = await waitFor(() => getByTestId('voucher-done'));
    expect(done.textContent).toContain(en.vchDoneBody);
  });

  /**
   * AFTER THE CREDIT, NEVER BEFORE. The screen behind re-reads `/members/me`
   * rather than being handed this sheet's number. Announcing it before the
   * transaction committed is a lie for however long the request takes — the rule
   * `ChangePasswordSheet` states for its security promise.
   */
  it('asks the screen behind to re-read the member, once', async () => {
    redeemVoucher.mockResolvedValue(REDEMPTION);
    const onRedeemed = vi.fn();
    const { getByTestId } = mount({ onRedeemed });
    expect(onRedeemed).not.toHaveBeenCalled();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(onRedeemed).toHaveBeenCalledTimes(1));
  });

  /** The code is not echoed back. She typed it; it is spent. */
  it('never reprints the spent code', async () => {
    redeemVoucher.mockResolvedValue(REDEMPTION);
    const { getByTestId, queryByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    fireEvent.click(getByTestId('voucher-submit'));
    const done = await waitFor(() => getByTestId('voucher-done'));
    expect(done.textContent).not.toContain('26LJN8HAGKMD');
    expect(queryByTestId('voucher-code')).toBeNull();
  });
});

describe('the error state', () => {
  /**
   * ONE MESSAGE FOR EXPIRED, VOIDED AND ALREADY-REDEEMED, because that is what
   * the server answers — see `domain/voucher.test.ts` for the five transcripts.
   * The sheet's job is not to guess which one it was.
   */
  it('renders the one refusal, and it is ours, not the server’s English by accident', async () => {
    redeemVoucher.mockRejectedValue(refusal());
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '5NWBVRNHLA8H' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() =>
      expect(getByTestId('voucher-error').textContent).toContain(en.vchRefused),
    );
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A REFUSAL DOES NOT LEAVE THE SHEET BUSY, AND IT DOES NOT REPLAY THE KEY.
   * ═══════════════════════════════════════════════════════════════════════════
   * The code is dead, so the attempt is over: the next tap is a different
   * question and must not replay a stored 409. `canRetryRedeem('refused')` is
   * false, so the key is burned.
   */
  it('burns the key after a refusal, so a second tap is a genuinely new request', async () => {
    redeemVoucher.mockRejectedValue(refusal());
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '5NWBVRNHLA8H' } });
    fireEvent.click(getByTestId('voucher-submit'));
    /*
      WAIT FOR THE REFUSAL TO RENDER, NOT FOR THE CALL TO HAPPEN. Written
      `waitFor(() => calledTimes(1))` this test went red, and the reason is worth
      keeping: that resolves the instant the mock is INVOKED, which is before the
      rejection has been caught and before `busy` has gone back to false. The
      second click then landed on a disabled button and nothing happened — a
      false red produced entirely by the test, on a sheet that was behaving
      correctly. It also proves the in-flight guard is real.
    */
    await waitFor(() => expect(getByTestId('voucher-error')).toBeTruthy());

    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(redeemVoucher).toHaveBeenCalledTimes(2));
    expect(redeemVoucher.mock.calls[1]![1]).not.toBe(redeemVoucher.mock.calls[0]![1]);
  });

  /**
   * THE OFFLINE SENTENCE. She is holding a code she may believe she has just
   * spent, so the load-bearing clause is that nothing has been used.
   */
  it('keeps the last word on offline: nothing has been used', async () => {
    redeemVoucher.mockRejectedValue(
      new ApiError('offline', 'No connection.', 'WLT-1111-2222', null),
    );
    const { getByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() =>
      expect(getByTestId('voucher-error').textContent).toContain(en.vchOffline),
    );
  });

  /** An error never leaves the confirmation on screen. */
  it('never shows a confirmation when the redeem failed', async () => {
    redeemVoucher.mockRejectedValue(refusal());
    const { getByTestId, queryByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: 'ZZZZZZZZZZZZ' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(getByTestId('voucher-error')).toBeTruthy());
    expect(queryByTestId('voucher-done')).toBeNull();
  });

  /** Editing the code clears the old refusal rather than leaving it under a new one. */
  it('clears the message when she edits the code', async () => {
    redeemVoucher.mockRejectedValue(refusal());
    const { getByTestId, queryByTestId } = mount();
    fireEvent.change(getByTestId('voucher-code'), { target: { value: 'ZZZZZZZZZZZZ' } });
    fireEvent.click(getByTestId('voucher-submit'));
    await waitFor(() => expect(getByTestId('voucher-error')).toBeTruthy());
    fireEvent.change(getByTestId('voucher-code'), { target: { value: '26LJN8HAGKMD' } });
    expect(queryByTestId('voucher-error')).toBeNull();
  });
});
