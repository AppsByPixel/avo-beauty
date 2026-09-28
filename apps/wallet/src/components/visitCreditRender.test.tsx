// @vitest-environment jsdom

/**
 * "+1 VISIT" ON HER ACTIVITY — what a charge earned, from `Transaction.loyalty`.
 *
 * Migration 0065 (lane A, edcb0f0) records on every charge row the increment the
 * charge actually applied, and the serialiser sends it as `loyalty`
 * (`TransactionLoyaltySchema.nullable()`). The wallet shows it in two places,
 * both from `domain/activity.ts § earnedLabel`:
 *
 *   · the activity row's sub-line   "Yesterday · 4:30 pm · Kuwait City · +1 visit"
 *   · the receipt's design row      design:1568 `['Visit credit', '+1 visit']`,
 *                                   design:1582 `['احتساب الزيارة', '+زيارة واحدة']`
 *
 * And nothing when `loyalty` is null — a non-charge, or a charge from before
 * 0065, which did earn a visit that nobody recorded. The client never guesses
 * "+1" for it (non-negotiable #2). Nor on a voided charge, whose count the void
 * took back.
 *
 * Every case is rendered — the feed and the sheet, the components HomeScreen
 * mounts — in both loyalty modes and both languages.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language, Transaction, TransactionLoyalty } from '@avo/types';

vi.mock('react-native-svg', async () => {
  const React = await import('react');
  const Svg = ({ children }: { children?: React.ReactNode }) =>
    React.createElement('span', { 'data-svg': '' }, children);
  const nothing = () => null;
  return { default: Svg, Svg, Path: nothing, Circle: nothing, Rect: nothing, G: nothing };
});

/* eslint-disable import/first */
import { ActivityFeed } from './ActivityFeed';
import { TransactionSheet } from './TransactionSheet';
import { LanguageProvider } from '../i18n/language';
import { earnedLabel, toActivityRow } from '../domain/activity';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

afterEach(cleanup);

const BRANCHES = [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' }];
const TZ = 'Asia/Kuwait';

/** A charge as `serialiseTransactionForCustomer` sends it, `loyalty` last. */
function charge(loyalty: TransactionLoyalty | null, over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'TX-9802919',
    memberId: '8842',
    branchId: 'BR-KWC',
    kind: 'charge',
    amountFils: -3000,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-9802919',
    createdAt: '2026-08-18T10:20:31.000Z',
    customAmount: false,
    voidedAt: null,
    reversedByTransactionId: null,
    loyalty,
    ...over,
  } as Transaction;
}

const tiers = (visitsEarned: number): TransactionLoyalty => ({
  mode: 'tiers',
  visitsEarned,
  tierAfter: 'silver',
  climbed: false,
  rewardReady: false,
});

const stamps = (stampsEarned: number): TransactionLoyalty => ({
  mode: 'stamps',
  stampsEarned,
  tierAfter: null,
  climbed: false,
  rewardReady: false,
});

/** Render the feed and the sheet for one transaction; return what each draws. */
function draw(tx: Transaction, lang: Language) {
  const copy = lang === 'ar' ? ar : en;
  const row = toActivityRow(tx, BRANCHES, lang, copy, TZ);
  render(
    <LanguageProvider initial={lang}>
      <ActivityFeed rows={[row]} onTopUp={vi.fn()} onOpen={vi.fn()} />
      <TransactionSheet
        transaction={tx}
        branches={BRANCHES}
        timeZone={TZ}
        onClose={vi.fn()}
        onReport={vi.fn()}
      />
    </LanguageProvider>,
  );
  const feedRow = screen.getByTestId(`activity-row-${tx.id}`);
  const receipt = screen.getByTestId('tx-rows');
  return { copy, row, feedText: feedRow.textContent ?? '', receipt };
}

/** The value beside a receipt label, or null when the sheet has no such row. */
function receiptValue(receipt: HTMLElement, label: string): string | null {
  const labelEl = within(receipt).queryByText(label);
  if (!labelEl) return null;
  return labelEl.parentElement?.lastElementChild?.textContent ?? null;
}

const CASES: {
  name: string;
  loyalty: TransactionLoyalty;
  en: string;
  ar: string;
}[] = [
  { name: 'tiers, one visit', loyalty: tiers(1), en: '+1 visit', ar: '+زيارة واحدة' },
  { name: 'tiers, a doubled visit', loyalty: tiers(2), en: '+2 visits', ar: '+زيارتان' },
  { name: 'tiers, three', loyalty: tiers(3), en: '+3 visits', ar: '+٣ زيارات' },
  { name: 'stamps, one stamp', loyalty: stamps(1), en: '+1 stamp', ar: '+ختم واحد' },
  { name: 'stamps, double stamps', loyalty: stamps(2), en: '+2 stamps', ar: '+ختمان' },
  { name: 'stamps, triple stamps', loyalty: stamps(3), en: '+3 stamps', ar: '+٣ أختام' },
];

describe('a charge that recorded what it earned', () => {
  for (const c of CASES) {
    for (const lang of ['en', 'ar'] as const) {
      it(`${c.name} — ${lang}: the row ends with it, and the receipt has the Visit credit row`, () => {
        const { copy, row, feedText, receipt } = draw(charge(c.loyalty), lang);
        const expected = c[lang];

        expect(row.when.endsWith(` · ${expected}`)).toBe(true);
        expect(feedText).toContain(expected);
        // The design's own label, in the design's own position: after Branch.
        expect(receiptValue(receipt, copy.txVisitCredit)).toBe(expected);
        expect(copy.txVisitCredit).toBe(lang === 'ar' ? 'احتساب الزيارة' : 'Visit credit');
      });
    }
  }

  it('the count is the one the server recorded — a boosted +2 is never "+1"', () => {
    expect(earnedLabel(charge(tiers(2)), en)).toBe('+2 visits');
    expect(earnedLabel(charge(stamps(2)), ar)).toBe('+ختمان');
  });

  it('Arabic counts are Eastern — a count is not money — and money stays Western', () => {
    const { feedText } = draw(charge(tiers(12)), 'ar');
    expect(feedText).toContain('+١٢ زيارة');
    expect(feedText).not.toMatch(/\+12/);
    expect(feedText).toContain('3.000'); // the amount, Western (#12)
  });
});

describe('nothing is said when nothing was recorded', () => {
  for (const lang of ['en', 'ar'] as const) {
    const words = lang === 'ar' ? /زيار|ختم|أختام/ : /visit|stamp/i;

    it(`${lang}: a charge from before 0065 (loyalty: null) draws no clause and no row`, () => {
      const { copy, row, feedText, receipt } = draw(charge(null), lang);
      expect(row.when).not.toMatch(words);
      expect(feedText).not.toMatch(words);
      expect(receiptValue(receipt, copy.txVisitCredit)).toBeNull();
      expect(earnedLabel(charge(null), copy)).toBeNull();
    });

    it(`${lang}: a top-up (loyalty: null) draws none either`, () => {
      const topup = charge(null, { kind: 'topup', amountFils: 11000, bonusFils: 1000, method: 'knet' });
      const { copy, feedText, receipt } = draw(topup, lang);
      expect(feedText).not.toMatch(words);
      expect(receiptValue(receipt, copy.txVisitCredit)).toBeNull();
    });

    it(`${lang}: a voided charge no longer claims the visit the void took back`, () => {
      const voided = charge(tiers(1), {
        voidedAt: '2026-08-18T10:31:00.000Z',
        reversedByTransactionId: 'TX-9802920',
      });
      const { copy, feedText, receipt } = draw(voided, lang);
      expect(feedText).not.toMatch(words);
      expect(receiptValue(receipt, copy.txVisitCredit)).toBeNull();
    });
  }
});
