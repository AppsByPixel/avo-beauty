/**
 * Two rules that live on the charge screens and had no guard but a comment.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SOURCE SCANS, NOT RENDERS, and the reason is the same one
 * `apps/wallet/src/api/account.test.ts` gives for scanning rather than rendering
 * non-negotiable #10: there is no renderer in this workspace — no jsdom, no
 * testing-library, and `react-test-renderer` is gone in React 19 — and adding one
 * would rewrite the trunk-owned `pnpm-lock.yaml`, which is not a lane B call.
 *
 * More to the point, a render test would be aimed at the wrong risk. Neither rule
 * below is about a component drawing a value wrongly. One is about a row STOPPING
 * being drawn, and the other is about a button being ADDED. A scan over the shipped
 * source catches both at the moment somebody writes them, which is the only moment
 * either is cheap to undo.
 *
 * WHY THESE TWO AND NOT EVERY SCREEN RULE. Both are guarantees whose entire
 * enforcement was, until now, a paragraph of prose:
 *
 *   the no-retry rule    MemberScreen's header traces a real double-charge path
 *                        end to end and concludes the error state must not offer a
 *                        retry. DECISIONS.md § "Idempotency protects the attempt,
 *                        not the recovery" carries the same trace. Nothing
 *                        anywhere asserted it — the e2e money suite covers the
 *                        SERVER's idempotency, which is the half that already
 *                        worked. This is the class of gap DECISIONS.md § "Defence
 *                        in depth hides the absence of its own layers" names: a
 *                        layer nothing can reach is a layer nobody will notice
 *                        disappearing.
 *
 *   the returned deposit ResultScreen's only explanation for a balance that rose
 *                        during a charge. The field it reads was silently stripped
 *                        by the schema once already.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from '../copy/en';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');
const memberScreen = read('MemberScreen.tsx');
const resultScreen = read('ResultScreen.tsx');

// ------------------------------------------------------- the no-retry rule ----

describe('a failed charge offers no retry affordance', () => {
  /**
   * The path, from MemberScreen's own header: the charge SUCCEEDS server-side, the
   * response cannot be read, staff reach for a retry, that unmounts the screen,
   * the remount mints a NEW idempotency key and her app mints a fresh token — so
   * the second request is not a duplicate by any measure the server has, and it
   * takes a second real debit. Every step is the system working as designed, which
   * is exactly why no idempotency test finds it.
   */
  it('tells staff to check her balance instead of offering a button', () => {
    expect(memberScreen).toContain('copy.chargeUnknownOutcome');
    expect(copy.chargeUnknownOutcome).toBeTruthy();
  });

  /**
   * THE ASSERTION THAT WOULD ACTUALLY CATCH THE REGRESSION.
   *
   * `FailureState` is the shared "we failed, try again" component
   * (components/States.tsx), correct for a failed LOAD and wrong for a failed
   * charge. The charge screen must not reach for it, and must not grow an
   * `onRetry` of its own.
   *
   * Scoped to the charge screen rather than the app: BookingsScreen legitimately
   * retries, because re-reading a schedule moves no money.
   */
  it('does not render a retry control on the charge failure path', () => {
    expect(memberScreen).not.toContain('FailureState');
    expect(memberScreen).not.toMatch(/onRetry/);
    expect(memberScreen).not.toMatch(/copy\.tryAgain/);
  });

  /**
   * The other half, and it is not the same claim. Re-tapping Charge IS safe and
   * stays enabled — the key has not changed and neither has the basket, so the
   * server replays its stored answer. A "fix" that disabled Charge after a failure
   * would remove the one recovery that cannot double-debit, so the key must stay
   * per-attempt in a ref rather than being reminted on every render.
   */
  it('keeps the idempotency key stable across the attempt', () => {
    /*
      MATCHED WITH THE DECLARATION, NOT ON THE BARE CALL, and that is a fix rather
      than fussiness. `useRef(newIdempotencyKey())` also appears in this screen's
      HEADER COMMENT, at step 4 of the double-charge trace — so an assertion on the
      substring alone stayed green when the real `useRef` was swapped for a
      `useState`, satisfied entirely by the prose describing the bug. Found by
      mutating the source and checking each assertion went red; that one did not.
      A test a comment can satisfy is the same defect as a green typecheck bought
      with a cast.
    */
    expect(memberScreen).toContain('const attemptKey = useRef(newIdempotencyKey());');
  });

  /**
   * An offline failure is the deliberate exception: nothing left the device, so the
   * outcome is not in doubt and the banner alone is honest. Pinned so the branch is
   * not "simplified" into one message that tells her to check a balance that cannot
   * have moved.
   */
  it('treats an offline failure as a known outcome, not an unknown one', () => {
    expect(memberScreen).toContain("failure.kind === 'offline'");
  });
});

// ---------------------------------------------------- the returned deposit ----

/**
 * DECISIONS.md § "Five calls made without asking", call 4.
 *
 * A 10.000 hold against a 6.000 basket, driven on avo_lane_b: applied 6000,
 * returned 4000, wallet debit 0, balance 8500 -> 12500. So the screen says
 * "Charged" while the only figure on it goes UP, and this row is the only thing on
 * any staff surface that reconciles the two.
 */
describe('the charge result panel explains a balance that went up', () => {
  it('renders depositReturnedFils on the result screen', () => {
    expect(resultScreen).toContain('depositReturnedFils');
    expect(resultScreen).toContain('copy.depositReturned');
  });

  it('takes the figure from the server rather than computing a difference', () => {
    /*
      Non-negotiable #2 owns the difference as well as the balance. A screen doing
      `heldDeposit - basket` would be a second opinion about money, and it would be
      WRONG in the case that matters: the API caps `depositAppliedFils` at the
      basket, so the remainder is not a subtraction this screen has the inputs for.
    */
    expect(resultScreen).toContain('amount={fils(result.depositReturnedFils)}');
    expect(resultScreen).not.toMatch(/depositAppliedFils\s*[-−]/);
  });

  it('hides the row rather than printing a 0.000 return on an ordinary charge', () => {
    // 0-not-absent is how the API says "no remainder" (see api/charges.test.ts), so
    // the screen must treat 0 as nothing to explain and not as a figure to show.
    expect(resultScreen).toContain('result.depositReturnedFils > 0');
  });

  it('uses the bundle’s own wording, which the customer also reads', () => {
    // `Deposit returned` is design/AVO Wallet Home.dc.html:1569 and the wallet's
    // `txKind.deposit_return`. One fact, one phrase, on both surfaces.
    expect(copy.depositReturned).toBe('Deposit returned');
  });
});
