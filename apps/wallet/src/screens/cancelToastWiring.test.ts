/**
 * THE TOAST AFTER A CANCEL, AND THAT IT CANNOT NAME A REFUND THAT DID NOT HAPPEN.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS DEFENDS
 * ═════════════════════════════════════════════════════════════════════════════
 * `zeroDepositBookingRender.test.tsx` covers what the Upcoming card tells a
 * customer BEFORE she cancels. This covers the sentence she gets AFTER, which is
 * the one that reads as a receipt:
 *
 *     copy.cancelledToast(formatMoney(fils(refunded), lang))
 *     → "Appointment cancelled · 0.000 KD deposit returned"
 *
 * A front desk can now create an appointment on an existing member's account,
 * always zero-deposit (`BookingSchema § source`). Cancelling one answers
 * `refundedFils: 0`, and this line rendered that string in her own language at
 * the exact moment she would look for confirmation that money came back.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY SOURCE TEXT AND NOT A RENDER — MEASURED, NOT ASSUMED
 * ═════════════════════════════════════════════════════════════════════════════
 * There IS a renderer in this package now (`vitest.config.ts` § two
 * environments), so the reason `payTabWiring.test.ts` gives — "this workspace
 * has no renderer" — is stale and cannot be reused. The reason here is the
 * OTHER wall that same config documents, and it was re-measured for this file:
 * importing `./HomeScreen` under jsdom fails in vite's transform on
 * `react-native-qrcode-svg/src/index.js:45`, JSX inside a `.js`, reached through
 * `PaymentCode` → `QrOverlay`. The screen cannot be imported, let alone drawn.
 *
 * And the toast is not reachable even if it could be: it is built inside an
 * `onCancel` useCallback that is not exported, fired by a button several
 * contexts deep, and it needs a resolved session, a snapshot and a live
 * `DELETE /bookings/{id}` before it says anything.
 *
 * So this follows `payTabWiring.test.ts`, which defends an equally invisible
 * wiring property by reading the file. The mutation it exists to catch is one
 * word long — deleting the guard and going back to the unconditional call — and
 * it is the same edit somebody makes while tidying a ternary.
 *
 * WHAT IT DOES NOT BUY, stated rather than implied: it asserts the code SAYS the
 * right thing, not that React renders it. A render test would subsume it and
 * belongs to whoever gets `react-native-qrcode-svg` past vite. Reported.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname);
const HOME = readFileSync(join(SRC, 'HomeScreen.tsx'), 'utf8');

/**
 * Comments stripped before matching, so a paragraph QUOTING the wrong call
 * cannot satisfy a spec about the code — and this very file's subject is a
 * sentence that appears verbatim in a comment two lines above the code.
 */
const CODE = HOME.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the cancellation toast', () => {
  it('both variants are wired in — the money one and the silent one', () => {
    expect(CODE).toContain('copy.cancelledToast(');
    expect(CODE).toContain('copy.cancelledToastNoDeposit');
  });

  /**
   * THE LOAD-BEARING ONE. Every `cancelledToast(` call in the file must sit on
   * the true arm of a `refunded > 0` test — so the money sentence cannot be
   * reached when no money moved.
   */
  it('the money sentence is guarded by the amount the SERVER said it returned', () => {
    const calls = [...CODE.matchAll(/copy\.cancelledToast\(/g)];
    expect(calls, 'cancelledToast is not called at all — has it been renamed?').toHaveLength(1);

    const at = calls[0]!.index!;
    // The 200 characters before the call, which is where a guard would be.
    const before = CODE.slice(Math.max(0, at - 200), at);
    expect(before).toMatch(/refunded\s*>\s*0/);
    // And the guard is a conditional this call is an ARM of, not a statement
    // that merely happens to be nearby.
    expect(before).toContain('?');
  });

  /**
   * `refunded`, NOT `booking.depositFils`. Both are 0 on a merchant booking, so
   * they agree today and are not the same question: one is what the appointment
   * was worth, the other is what the cancellation actually moved. The toast is a
   * receipt for the second. Non-negotiable #2 — the server decides what came
   * back, and this reports it rather than predicting it.
   */
  it('reads the server’s refund and not the booking’s deposit', () => {
    const at = CODE.indexOf('copy.cancelledToast(');
    const before = CODE.slice(Math.max(0, at - 200), at);
    expect(before).not.toMatch(/depositFils/);
  });
});
