/**
 * The redeem refusals, pinned against what the server actually answers.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY `ApiError` BELOW IS A TRANSCRIPT, NOT AN INVENTION.
 * ═════════════════════════════════════════════════════════════════════════════
 * Driven against the real API on avo_lane_b, port 4710, with four vouchers
 * issued through `POST /v1/vouchers` as the platform admin and put into their
 * three dead states (one force-expired in SQL, one voided through
 * `DELETE /v1/vouchers/:id`, one redeemed and then redeemed again):
 *
 *   expired           HTTP 409 {"error":"voucher_not_redeemable","message":"That code
 *                              cannot be redeemed. Check it and try again, or contact support."}
 *   voided            HTTP 409  — byte-identical body
 *   already redeemed  HTTP 409  — byte-identical body
 *   never existed     HTTP 409  — byte-identical body
 *   live              HTTP 200 {"creditedFils":5000,"balanceAfterFils":29500,…}
 *
 * THE BRIEF FOR THIS SLICE ASKED FOR "the three the server distinguishes". It
 * distinguishes none of them, on purpose, and `routes/vouchers.ts` argues the
 * decision at length. That is the single most important fact about this screen
 * and it is why there is one refusal string here and not three.
 *
 * `api/shop.test.ts`'s standing lesson — "four contract drifts in this project
 * were a schema narrower than the wire" — is why these are transcripts.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import {
  CODE_MAX_LENGTH,
  NOT_REDEEMABLE,
  canRetryRedeem,
  canSubmitCode,
  classifyRedeemFailure,
  redeemFailureMessage,
} from './voucher';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

/** The 409 the route answers for all five dead states. Verbatim. */
function refusal(): ApiError {
  return new ApiError(
    // `classify(409)` is 'server' — NOT a typo, and the trap this module exists
    // for. See below.
    'server',
    'That code cannot be redeemed. Check it and try again, or contact support.',
    'WLT-1234-5678',
    409,
    NOT_REDEEMABLE,
  );
}

describe('the five dead states are one refusal', () => {
  /**
   * All five are the SAME `ApiError`, so this is really a statement about the
   * server: there is nothing in the response to branch on. It is written as five
   * cases anyway, because the brief asked for three of them by name and the
   * answer is that they are not separable.
   */
  it.each([
    ['expired', refusal()],
    ['voided', refusal()],
    ['already redeemed', refusal()],
    ['never existed', refusal()],
    ["issued to somebody else", refusal()],
  ])('%s classifies as refused', (_name, err) => {
    expect(classifyRedeemFailure(err)).toBe('refused');
    expect(redeemFailureMessage('refused', en)).toBe(en.vchRefused);
  });

  /**
   * THE CLIENT'S ENGLISH IS THE SERVER'S ENGLISH, CHARACTER FOR CHARACTER.
   *
   * We render our own string rather than `err.message` because the API emits
   * English only and #12 makes this app bilingual. That freedom is also how the
   * two sentences drift apart, so the transcript above is compared to the copy
   * key directly: if either side is reworded, this fails.
   */
  it("says exactly what the server says, in English", () => {
    expect(en.vchRefused).toBe(refusal().message);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * A REFUSAL NEVER OFFERS TRY AGAIN, AND THIS IS THE SHARP EDGE.
   * ═══════════════════════════════════════════════════════════════════════════
   * `client.ts § classify` sends 401/403 to 'forbidden', 503/504 to 'offline'
   * and EVERYTHING ELSE to 'server' — the kind whose whole meaning is "our
   * fault, so the screen offers Try again". A 409 is everything else. A sheet
   * that keyed off `err.kind` would therefore put a retry button under a dead
   * code and leave it there forever, which is precisely the "you can't" case
   * interaction-spec.md §4 says must explain instead.
   */
  it('a refusal is a "you cannot", not a "we failed" — despite arriving as kind=server', () => {
    const err = refusal();
    expect(err.kind).toBe('server');
    expect(canRetryRedeem(classifyRedeemFailure(err))).toBe(false);
  });
});

describe('the failures that are not about the code', () => {
  it('a transport failure is offline, keeps its key, and offers a retry', () => {
    // What `sendOnce` synthesises when fetch rejects: kind 'offline', status null.
    const err = new ApiError('offline', 'No connection.', 'WLT-1111-2222', null);
    expect(classifyRedeemFailure(err)).toBe('offline');
    expect(canRetryRedeem('offline')).toBe(true);
  });

  it('a 503 is offline too — the server answered, about itself', () => {
    const err = new ApiError('offline', 'Unavailable.', 'WLT-1111-2223', 503);
    expect(classifyRedeemFailure(err)).toBe('offline');
  });

  it('a 500 is a failure we own, and it retries', () => {
    const err = new ApiError('server', 'Something went wrong.', 'WLT-3333-4444', 500);
    expect(classifyRedeemFailure(err)).toBe('failed');
    expect(canRetryRedeem('failed')).toBe(true);
  });

  /**
   * `code_only` and `invalid_code` are the route's own 400s. Unreachable from
   * this sheet — it sends one field and caps the length — so they are a defect
   * in US, and they do not retry: the body will not change between attempts.
   */
  it('a 400 blames us, not her code, and does not retry', () => {
    const err = new ApiError('server', 'Send only the code.', 'WLT-5555-6666', 400, 'code_only');
    expect(classifyRedeemFailure(err)).toBe('rejected');
    expect(canRetryRedeem('rejected')).toBe(false);
    expect(redeemFailureMessage('rejected', en)).toBe(en.vchRejected);
  });

  /**
   * A 401 that outlived `client.ts`'s refresh-and-retry-once. Not 'refused' —
   * her code may be perfectly good — so it lands in the generic bucket and
   * retries, which is what the sign-in gate above will resolve.
   */
  it('a surviving 401 is a generic failure, not a dead code', () => {
    const err = new ApiError('forbidden', 'Unauthorized.', 'WLT-7777-8888', 401);
    expect(classifyRedeemFailure(err)).toBe('failed');
  });

  it('anything that is not an ApiError is a generic failure', () => {
    expect(classifyRedeemFailure(new Error('boom'))).toBe('failed');
    expect(classifyRedeemFailure(null)).toBe('failed');
  });
});

describe('every failure has a sentence, in both languages', () => {
  /**
   * The Arabic is the ENGLISH here and that is correct, not a bug: all four are
   * AR GAPS and `copy/ar.ts` says so by name. What this asserts is that no
   * failure falls through to `undefined` — a missing branch would render an
   * empty `InlineError`, which looks like a working screen that refused her
   * silently.
   */
  it.each(['refused', 'rejected', 'offline', 'failed'] as const)('%s', (failure) => {
    for (const copy of [en, ar]) {
      const message = redeemFailureMessage(failure, copy);
      expect(typeof message).toBe('string');
      expect(message.trim()).not.toBe('');
    }
  });

  /**
   * THE OFFLINE SENTENCE CARRIES ONE LOAD-BEARING CLAUSE. She is holding a code
   * she may believe she has just spent, and the one thing she needs is that
   * nothing has been used. Pinned by its substance, not by its wording.
   */
  it('the offline message says nothing has been used', () => {
    expect(en.vchOffline.toLowerCase()).toContain('nothing has been used');
  });

  /**
   * NON-NEGOTIABLE #5, AS A COPY TEST. "No cash, no card reversal, on any
   * surface, ever." The confirmation is the one place in this flow where a
   * customer is being compensated and is most likely to ask, so it must not be
   * readable as offering either.
   */
  it('the confirmation offers no cash and no card reversal', () => {
    const body = en.vchDoneBody.toLowerCase();
    expect(body).toContain('wallet credit');
    expect(body).toContain('not paid out as cash');
    expect(body).toContain('back to a card');
    // And no string in the voucher block invites the opposite reading.
    for (const s of [en.vchSub, en.vchDoneTitle, en.vchDoneBody, en.vchRefused]) {
      expect(s.toLowerCase()).not.toMatch(/\brefund(ed|s)?\b/);
    }
  });
});

describe('what the field lets her send', () => {
  it('an empty or whitespace-only field cannot be submitted', () => {
    expect(canSubmitCode('')).toBe(false);
    expect(canSubmitCode('   ')).toBe(false);
    expect(canSubmitCode('\t\n')).toBe(false);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NOTHING ELSE IS VALIDATED, AND THAT IS DRIVEN RATHER THAN ASSUMED.
   * ═══════════════════════════════════════════════════════════════════════════
   * `normaliseCode` upper-cases and strips spaces and dashes server-side. A
   * client that rejected a lowercase or dashed code would refuse input the
   * server accepts: `"vmq5-cxmc-ggk3"` redeemed `VMQ5CXMCGGK3` for 1.500 KD on
   * avo_lane_b, HTTP 200.
   */
  it('accepts what the server normalises — lowercase, dashes, spaces', () => {
    expect(canSubmitCode('vmq5-cxmc-ggk3')).toBe(true);
    expect(canSubmitCode('26LJ N8HA GKMD')).toBe(true);
    expect(canSubmitCode('26ljn8hagkmd')).toBe(true);
  });

  /** `requireString(body.code, 'code', 64)` — past this only a 400 is possible. */
  it('caps at the length the server caps at', () => {
    expect(CODE_MAX_LENGTH).toBe(64);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THAT THE SECTION IS UNCONDITIONAL — asserted structurally, the way
 * `payTabWiring.test.ts` and `theme/brandBootOrder.test.ts` defend properties a
 * unit test cannot see.
 * ═══════════════════════════════════════════════════════════════════════════
 * The Help block above it renders only when `GET /v1/platform/support` returned
 * a config — `{support ? … : null}`. A voucher she has been given must be
 * spendable whether or not that read succeeded, so the section must sit OUTSIDE
 * that ternary, and it must not acquire one of its own.
 *
 * This is the property with no other guard. `AccountScreen` needs four hooks and
 * a provider tree to render, there is no screen-level render spec in this app,
 * and the regression is one character long: wrapping the block in `{support && …}`
 * would hide the only way to redeem a voucher behind an unrelated endpoint, and
 * every test in this file would still pass.
 *
 * WHAT THIS DOES NOT BUY, stated for the same reason that file states it: it
 * asserts the source SAYS the right thing, not that React renders it. A
 * screen-level render spec would subsume it and belongs with a budget for
 * mocking `useAccount`, `useNotificationPreferences` and `useDeletionState`.
 */
describe('where the section sits on the Account screen', () => {
  const SCREEN = readFileSync(
    join(resolve(__dirname, '..'), 'screens', 'AccountScreen.tsx'),
    'utf8',
  );

  it('renders the voucher card, and the row that opens the sheet', () => {
    expect(SCREEN).toContain('testID="voucher-rows"');
    expect(SCREEN).toContain('testID="row-voucher"');
    expect(SCREEN).toContain('copy.acctVouchers');
    expect(SCREEN).toContain('copy.vchRow');
  });

  /**
   * The Help block is `{support ? ( … ) : null}` and the voucher block follows
   * its closing `) : null}`. So the section's own markup must contain no
   * `support` reference at all — which is the cheapest true statement of
   * "outside the conditional" that source text can make.
   */
  it('does not depend on the support config', () => {
    const start = SCREEN.indexOf('<SectionLabel>{copy.acctVouchers}</SectionLabel>');
    const end = SCREEN.indexOf('</SettingsCard>', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = SCREEN.slice(start, end);
    expect(block).not.toContain('support');
    expect(block).not.toContain('?');
  });

  /** Non-negotiable #2: the screen re-reads the member, it is not handed a balance. */
  it('re-reads the member after a redemption rather than applying a local number', () => {
    expect(SCREEN).toContain('onRedeemed={account.retry}');
    expect(SCREEN).not.toContain('onRedeemed={account.applyMember}');
  });
});
