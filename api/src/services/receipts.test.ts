/**
 * WHICH CHANNELS A PAYMENT QUEUES — the six-way matrix, with no database.
 *                                                    (DECISIONS.md #88)
 *
 * `salon.whatsapp_enabled` was stored, merchant-editable, served in the payload,
 * declared in `SalonSchema` — and consulted by NOTHING. `queueReceipts` built its
 * job list with `channel: 'whatsapp'` as an unconditional array literal, so
 * SAL-LUMIERE shipped the flag `false` and had a WhatsApp receipt queued for
 * every charge.
 *
 * WHY THIS IS A UNIT SPEC. The interesting thing here is not a row, it is the
 * COMBINATIONS: three merchant states times two customer capabilities is six
 * answers, and exactly one of them could ever produce silence. Six cases that
 * run in `pnpm check` are worth more than six that need a lane database — the
 * argument `money/ledger.ts` makes for its postings.
 *
 * THE STATE THAT IS ABSENT FROM THE MATRIX IS THE POINT: both channels off does
 * not appear, because `salon_receipt_channel_floor` makes it unstorable. So the
 * grid is 3 × 2, not 4 × 2.
 */

import { describe, expect, it } from 'vitest';
import { decideReceiptChannels } from './receipts';

const HAS_EMAIL = { email: 'her@example.com', emailVerified: true };
const NO_EMAIL = { email: null, emailVerified: false };
/** She typed one and nobody proved she controls it. */
const UNVERIFIED = { email: 'maybe-hers@example.com', emailVerified: false };

const BOTH = { whatsappEnabled: true, emailEnabled: true };
const WHATSAPP_ONLY = { whatsappEnabled: true, emailEnabled: false };
const EMAIL_ONLY = { whatsappEnabled: false, emailEnabled: true };

describe('the merchant chooses the channel, and cannot choose silence', () => {
  it('both on, verified address: both channels', () => {
    expect(decideReceiptChannels(BOTH, HAS_EMAIL)).toEqual({
      channels: ['whatsapp', 'email'],
      fallbackReason: null,
    });
  });

  it('both on, no address: WhatsApp only, and it is NOT a fallback', () => {
    // Her preference was honoured in full — there was simply nowhere to email.
    expect(decideReceiptChannels(BOTH, NO_EMAIL)).toEqual({
      channels: ['whatsapp'],
      fallbackReason: null,
    });
  });

  it('WhatsApp only: the email job is not queued even with a verified address', () => {
    expect(decideReceiptChannels(WHATSAPP_ONLY, HAS_EMAIL)).toEqual({
      channels: ['whatsapp'],
      fallbackReason: null,
    });
  });

  it('WhatsApp only, no address: still WhatsApp, still not a fallback', () => {
    expect(decideReceiptChannels(WHATSAPP_ONLY, NO_EMAIL)).toEqual({
      channels: ['whatsapp'],
      fallbackReason: null,
    });
  });

  it('email only, verified address: email alone — the flag finally does something', () => {
    /**
     * THE DEFECT, INVERTED INTO AN ASSERTION. Before this, `whatsapp` was in the
     * array literal unconditionally, so this case queued BOTH and the merchant's
     * choice did nothing.
     */
    expect(decideReceiptChannels(EMAIL_ONLY, HAS_EMAIL)).toEqual({
      channels: ['email'],
      fallbackReason: null,
    });
  });

  /**
   * THE ONE DANGEROUS COMBINATION, and the only one that could produce silence.
   * `design/README.md` § Known gaps 7 makes a receipt "a record-keeping
   * obligation, not marketing", so the floor fires and says why.
   */
  it('email only, NO verified address: falls back to WhatsApp and records the reason', () => {
    expect(decideReceiptChannels(EMAIL_ONLY, NO_EMAIL)).toEqual({
      channels: ['whatsapp'],
      fallbackReason: 'email_unavailable',
    });
  });

  it('an UNVERIFIED address is not an address — same fallback', () => {
    /**
     * The precondition is preserved exactly: "an unverified address is one the
     * customer typed, and it might be someone else's. A receipt names what she
     * bought, what it cost and what her wallet balance is now."
     *
     * A merchant chooses a PREFERENCE; she does not get to override a safety rule
     * about where a customer's balance may be sent. `emailEnabled` can only ever
     * REMOVE the email job, never add one to an unproven address.
     */
    expect(decideReceiptChannels(EMAIL_ONLY, UNVERIFIED)).toEqual({
      channels: ['whatsapp'],
      fallbackReason: 'email_unavailable',
    });
    expect(decideReceiptChannels(BOTH, UNVERIFIED).channels).toEqual(['whatsapp']);
  });

  /**
   * THE PROPERTY THAT MATTERS MOST, over every reachable combination at once: a
   * payment always queues at least one channel. Six cases enumerated rather than
   * argued, because "some combination somewhere sends nothing" is the failure
   * this whole slice exists to remove.
   */
  it('no reachable combination queues nothing', () => {
    for (const salon of [BOTH, WHATSAPP_ONLY, EMAIL_ONLY]) {
      for (const recipient of [HAS_EMAIL, NO_EMAIL, UNVERIFIED]) {
        const decision = decideReceiptChannels(salon, recipient);
        expect(decision.channels.length, JSON.stringify({ salon, recipient })).toBeGreaterThan(0);
      }
    }
  });

  it('a fallback is recorded only when the merchant’s preference was overridden', () => {
    for (const salon of [BOTH, WHATSAPP_ONLY, EMAIL_ONLY]) {
      for (const recipient of [HAS_EMAIL, NO_EMAIL, UNVERIFIED]) {
        const decision = decideReceiptChannels(salon, recipient);
        const overridden = !salon.whatsappEnabled && decision.channels.includes('whatsapp');
        expect(decision.fallbackReason === null, JSON.stringify({ salon, recipient })).toBe(
          !overridden,
        );
      }
    }
  });

  it('WhatsApp comes first when both are queued — one order, so the worker is predictable', () => {
    expect(decideReceiptChannels(BOTH, HAS_EMAIL).channels[0]).toBe('whatsapp');
  });
});
