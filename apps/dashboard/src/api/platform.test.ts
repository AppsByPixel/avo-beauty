import { describe, expect, it } from 'vitest';
import { isCampaignHeld, parseDecisionResponse } from './platform.js';

/**
 * The owner console's decision path, against the responses the real endpoint
 * actually sent.
 *
 * BOTH FIXTURES WERE CAPTURED FROM A DRIVEN `POST /v1/platform/campaigns/{cid}/
 * decision`, not written from the schema — which is the only reason the bug they
 * pin down was found at all. The client read `CampaignSchema.parse(body)` where
 * the body is `{ campaign, delivery }`; both files, both sides, and the type
 * annotation agreed with each other and none of them agreed with the wire.
 *
 * Reproducing them needs three things the API imposes and a fixture cannot fake:
 * marketing consent derived from `member_consent_event` (Reem's grant had been
 * revoked, so a two-member salon has an audience of one), `weeklyCapPerCustomer`
 * at 2, and — for the hold — a quiet window covering the salon's clock at the
 * moment of the press.
 */

/**
 * A HOLD. `status: 'approved'`, `heldReason` set, nothing sent.
 *
 * Produced by setting the platform quiet window to 09:00–10:00 through the
 * console's own throttle panel and approving at 09:03 Kuwait. Note the window is
 * SAME-DAY (`from < to`) — `PATCH /v1/platform/messaging-policy` validates each
 * bound independently, so this is a policy the console can really set, and the
 * shared `isInQuietHours` handles it with `m >= from && m < to`.
 */
const HELD_ENVELOPE = {
  campaign: {
    id: 'CMP-2899',
    salonId: 'SAL-AMARA',
    salon: 'Amara',
    title: 'Gold tier spa preview',
    body: 'An early look at our new spa menu, for Gold and Platinum members.',
    channel: 'both',
    audience: 'gold',
    branchId: 'all',
    reward: 'none',
    reach: 0,
    when: 'now',
    scheduledAt: '',
    status: 'approved',
    heldReason: 'Quiet hours 09:00–10:00. Held until 10:00.',
    heldAt: '2026-08-19T06:03:49.197Z',
    submittedBy: 'Noura',
    submittedAt: '2026-08-19T06:03:29.502Z',
    decidedBy: 'Yousef',
    decidedAt: '2026-08-19T06:03:49.197Z',
    note: null,
    result: null,
  },
  delivery: {
    status: 'held',
    sent: 0,
    cappedOut: 0,
    heldReason: 'Quiet hours 09:00–10:00. Held until 10:00.',
    result: null,
  },
};

/**
 * A SEND WITH A RECIPIENT-LEVEL SKIP. `status: 'sent'`, `heldReason: null`,
 * `cappedOut: 1`.
 *
 * Produced by sending two `lowbal` campaigns to take Reem to the weekly cap of 2,
 * then one `all` campaign: Dana was under the cap and received it, Reem was over
 * it and was skipped. This is the case that must NOT read as held.
 */
const SENT_ENVELOPE = {
  campaign: {
    id: 'CMP-2773',
    salonId: 'SAL-AMARA',
    salon: 'Amara',
    title: 'August spa menu',
    body: 'Our new spa menu is live. Book any treatment this month and collect a double stamp.',
    channel: 'push',
    audience: 'all',
    branchId: 'all',
    reward: 'none',
    reach: 2,
    when: 'now',
    scheduledAt: '',
    status: 'sent',
    heldReason: null,
    heldAt: null,
    submittedBy: 'Noura',
    submittedAt: '2026-08-19T06:09:39.896Z',
    decidedBy: 'Yousef',
    decidedAt: '2026-08-19T06:09:40.009Z',
    note: null,
    result: '1 reached · 1 over the weekly cap',
  },
  delivery: {
    status: 'sent',
    sent: 1,
    cappedOut: 1,
    heldReason: null,
    result: '1 reached · 1 over the weekly cap',
  },
};

describe('parseDecisionResponse — the envelope, not the campaign', () => {
  /**
   * THE REGRESSION. `CampaignSchema.parse(envelope)` threw `id: Required |
   * salonId: Required | salon: Required | title: Required` on every decision, so
   * the mutation always settled in error and the screen rendered "Nothing was
   * released." over a decision that had committed, sent, and written its audit
   * row. A reviewer who believes that presses Approve again and gets a 409, which
   * reads as a second failure.
   *
   * Asserted on the ENVELOPE rather than on a hand-written campaign, because the
   * bug was the level being parsed. A test that fed a bare campaign would pass
   * against the broken code.
   */
  it('reads body.campaign, so a decision that committed is not reported as an error', () => {
    const held = parseDecisionResponse(HELD_ENVELOPE);
    expect(held.campaign.id).toBe('CMP-2899');
    expect(held.campaign.status).toBe('approved');

    const sent = parseDecisionResponse(SENT_ENVELOPE);
    expect(sent.campaign.id).toBe('CMP-2773');
    expect(sent.campaign.status).toBe('sent');
  });

  it('throws when body.campaign is absent — the decision is the one thing that must parse', () => {
    expect(() => parseDecisionResponse({ delivery: HELD_ENVELOPE.delivery })).toThrow();
    expect(() => parseDecisionResponse({})).toThrow();
  });

  /**
   * `heldReason` was withheld by the serialiser for a while and the console
   * refused to default it to null, because a held campaign rendering as sent is
   * exactly what #8 exists to prevent. The parse has to keep carrying it.
   */
  it('carries heldReason and heldAt through, rather than dropping them to null', () => {
    const { campaign } = parseDecisionResponse(HELD_ENVELOPE);
    expect(campaign.heldReason).toBe('Quiet hours 09:00–10:00. Held until 10:00.');
    expect(campaign.heldAt).toBe('2026-08-19T06:03:49.197Z');
  });
});

describe('parseDecisionResponse — delivery', () => {
  it('parses the hold outcome the console renders on the press', () => {
    const { delivery } = parseDecisionResponse(HELD_ENVELOPE);
    expect(delivery).not.toBeNull();
    expect(delivery?.status).toBe('held');
    expect(delivery?.sent).toBe(0);
    expect(delivery?.heldReason).toBe('Quiet hours 09:00–10:00. Held until 10:00.');
  });

  it('parses the send outcome, including the recipients the weekly cap skipped', () => {
    const { delivery } = parseDecisionResponse(SENT_ENVELOPE);
    expect(delivery?.status).toBe('sent');
    expect(delivery?.sent).toBe(1);
    expect(delivery?.cappedOut).toBe(1);
    expect(delivery?.result).toBe('1 reached · 1 over the weekly cap');
  });

  /**
   * `delivery: null` is what the API sends on a rejection and on approving a
   * `later`/`recurring` campaign — nothing was delivered in either case. It must
   * not throw: the decision itself succeeded.
   */
  it('accepts a null delivery without failing the decision', () => {
    const rejected = {
      campaign: {
        ...HELD_ENVELOPE.campaign,
        status: 'rejected',
        heldReason: null,
        heldAt: null,
        note: 'Audience is too broad for a Gold-only offer.',
      },
      delivery: null,
    };
    const parsed = parseDecisionResponse(rejected);
    expect(parsed.campaign.status).toBe('rejected');
    expect(parsed.delivery).toBeNull();
  });

  /**
   * A malformed `delivery` degrades to null rather than throwing — the opposite of
   * how `campaign` is treated, and deliberately. Losing a courtesy sentence must
   * not turn a committed decision back into the error state this file exists to
   * remove.
   */
  it('drops an unreadable delivery to null instead of failing the whole decision', () => {
    const parsed = parseDecisionResponse({
      campaign: SENT_ENVELOPE.campaign,
      delivery: { status: 'partially_sent' },
    });
    expect(parsed.campaign.status).toBe('sent');
    expect(parsed.delivery).toBeNull();
  });
});

describe('isCampaignHeld — a question about heldReason, never about status', () => {
  /**
   * The chip on the Decided row rendered `{c.status}` verbatim, so a held campaign
   * announced itself as "approved" — the one word that means the opposite of what
   * happened. A held campaign's status genuinely IS `approved`; that is why the
   * predicate cannot be a status comparison.
   */
  it('a held campaign reads as held even though its status is approved', () => {
    const { campaign } = parseDecisionResponse(HELD_ENVELOPE);
    expect(campaign.status).toBe('approved');
    expect(isCampaignHeld(campaign)).toBe(true);
  });

  /**
   * THE DISTINCTION THE SCREEN OWES A MERCHANT. The weekly per-customer cap skips
   * PEOPLE and the campaign still goes out; quiet hours and the monthly cap hold
   * the CAMPAIGN. A send with `cappedOut: 1` must not be counted or labelled as
   * held — "nothing went out" and "most of it did" are different next moves.
   */
  it('a send that skipped recipients over the weekly cap is NOT held', () => {
    const { campaign, delivery } = parseDecisionResponse(SENT_ENVELOPE);
    expect(delivery?.cappedOut).toBe(1);
    expect(isCampaignHeld(campaign)).toBe(false);
  });

  it('a campaign approved but not yet delivered is not held either', () => {
    const scheduled = {
      ...SENT_ENVELOPE.campaign,
      status: 'approved',
      when: 'later',
      scheduledAt: '2026-08-24T07:00:00.000Z',
      result: null,
      heldReason: null,
      heldAt: null,
    };
    const { campaign } = parseDecisionResponse({ campaign: scheduled, delivery: null });
    expect(isCampaignHeld(campaign)).toBe(false);
  });
});
