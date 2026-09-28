/**
 * Every bell kind, in both languages — `domain/bell.ts`.
 *
 * The items are STRUCTURED (lane A: kind + integer fils + ISO instants + stored
 * names), so the sentences are this app's. What is pinned here:
 *
 *   · each of the six kinds renders in English AND in Arabic, from the copy
 *     module, with the exact words — so a kind whose Arabic is dropped (an
 *     English string standing in an Arabic row) goes red, not unnoticed;
 *   · money is `formatMoney`/`formatFils` output — Western digits in both;
 *   · a campaign's title and body are the merchant's words, VERBATIM, in both
 *     languages — not translated, not touched;
 *   · a voided charge is not drawn as a debit when Home's page says it was voided;
 *   · a card-paid order's two receipts fold into one row standing for both ids;
 *   · an unknown kind is a neutral row that opening the bell does not mark read.
 */

import { describe, expect, it } from 'vitest';
import { fils, formatMoney, type Language } from '@avo/types';
import type { BellItem } from '../api/bell';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import type { Copy } from '../copy/types';
import { bellRow, bellRows, campaignsHidden, dayLabel, idsToMark, timeLabel } from './bell';

const NOW = new Date('2026-09-28T12:00:00.000Z');
const AT = '2026-09-28T08:38:18.990Z';

const COPIES: Array<[Language, Copy]> = [
  ['en', en],
  ['ar', ar],
];

const ctx = (lang: Language, copy: Copy, transactions: { id: string; voidedAt: string | null }[] = []) => ({
  lang,
  copy,
  salon: lang === 'ar' ? 'أمارا' : 'Amara',
  timeZone: 'Asia/Kuwait',
  transactions,
  now: NOW,
});

const ARABIC = /[؀-ۿ]/;
const EASTERN = /[٠-٩]/;
const WESTERN = /[0-9]/;
/** A line with its formatted amount removed — see the Arabic-rows spec. */
const withoutMoney = (line: string) => line.replace(/[0-9.,]+\s*(د\.ك|KD)/g, '');

// ---- fixtures, to `serialiseReceiptItem`'s shape --------------------------

const TOPUP: BellItem = {
  id: 'TX-1',
  kind: 'topup',
  transactionId: 'TX-1',
  createdAt: AT,
  readAt: null,
  amountFils: 10000,
  bonusFils: 1000,
  creditFils: 11000,
  method: 'knet',
};

const CHARGE: BellItem = {
  id: 'TX-2',
  kind: 'charge',
  transactionId: 'TX-2',
  createdAt: AT,
  readAt: null,
  amountFils: 8000,
  services: ['Blow-dry', 'Cut'],
  customAmount: false,
};

const SHOP: BellItem = {
  id: 'TX-3',
  kind: 'shop',
  transactionId: 'TX-3',
  createdAt: '2026-09-27T10:00:00.000Z',
  readAt: null,
  amountFils: 20500,
  items: [
    { name: 'Repair mask', qty: 2 },
    { name: 'Argan hair oil 100ml', qty: 1 },
  ],
  fulfilment: 'delivery',
};

const STARTS = '2026-10-03T13:30:00.000Z';

const HOLD: BellItem = {
  id: 'TX-4',
  kind: 'deposit_hold',
  transactionId: 'TX-4',
  createdAt: AT,
  readAt: '2026-09-28T09:00:00.000Z',
  amountFils: 5000,
  bookingId: 'BK-1',
  serviceName: 'Blow-dry',
  artistName: 'Rana',
  startsAt: STARTS,
};

const RETURN_NO_SHOW: BellItem = {
  id: 'TX-5',
  kind: 'deposit_return',
  transactionId: 'TX-5',
  createdAt: AT,
  readAt: null,
  amountFils: 5000,
  bookingId: 'BK-1',
  reason: 'no_show',
  serviceName: 'Blow-dry',
  startsAt: STARTS,
};

const RETURN_CANCELLED: BellItem = { ...RETURN_NO_SHOW, id: 'TX-6', transactionId: 'TX-6', reason: 'cancelled' };

const CAMPAIGN: BellItem = {
  id: 'CMP-1',
  kind: 'campaign',
  campaignId: 'CMP-1',
  createdAt: AT,
  readAt: null,
  // The merchant wrote it in English. It stays English in an Arabic bell.
  title: 'Autumn glow — 20% off facials',
  body: 'This week only at Amara Salmiya. Book in the app.',
};

const money = (f: number, lang: Language) => formatMoney(fils(f), lang);

// ----------------------------------------------------------------- kinds --

describe('every kind renders in both languages, from the copy module', () => {
  it.each(COPIES)('%s: topup — the activity title, the bonus line, +credit', (lang, copy) => {
    const row = bellRow(TOPUP, ctx(lang, copy));
    expect(row.title).toBe(`${copy.txKind.topup} · ${copy.txMethod.knet}`);
    expect(row.lines).toEqual([copy.bellTopupBonus(money(1000, lang))]);
    expect(row.amount).toMatchObject({ display: '+11.000', tone: 'in' });
    expect(row.when).toBe(`${copy.today} · ${timeLabel(AT, lang, 'Asia/Kuwait')}`);
  });

  it.each(COPIES)('%s: charge — the services, −amount', (lang, copy) => {
    const row = bellRow(CHARGE, ctx(lang, copy));
    expect(row.title).toBe(copy.txKind.charge);
    expect(row.lines).toEqual([lang === 'ar' ? 'Blow-dry، Cut' : 'Blow-dry, Cut']);
    expect(row.amount).toMatchObject({ display: '−8.000', tone: 'out' });
  });

  it.each(COPIES)('%s: charge at a typed price says so rather than showing nothing', (lang, copy) => {
    const row = bellRow({ ...CHARGE, services: [], customAmount: true } as BellItem, ctx(lang, copy));
    expect(row.lines).toEqual([copy.bellChargeCustom]);
  });

  it.each(COPIES)('%s: shop — lines with counts, the fulfilment, −amount', (lang, copy) => {
    const row = bellRow(SHOP, ctx(lang, copy));
    expect(row.title).toBe(copy.txKind.shop);
    const sep = lang === 'ar' ? '، ' : ', ';
    expect(row.lines).toEqual([
      `${copy.bellShopLine('Repair mask', 2)}${sep}Argan hair oil 100ml · ${copy.bellDelivery}`,
    ]);
    expect(row.amount).toMatchObject({ display: '−20.500', tone: 'out' });
    expect(row.when).toBe(`${copy.yesterday} · ${timeLabel(SHOP.createdAt, lang, 'Asia/Kuwait')}`);
  });

  it.each(COPIES)('%s: deposit_hold — the template booking confirmation, −deposit', (lang, copy) => {
    const row = bellRow(HOLD, ctx(lang, copy));
    expect(row.title).toBe(copy.bellBookingTitle(lang === 'ar' ? 'أمارا' : 'Amara'));
    expect(row.lines).toEqual([
      copy.bellBookingWith('Blow-dry', 'Rana'),
      copy.bellBookingAt(dayLabel(STARTS, lang, 'Asia/Kuwait'), timeLabel(STARTS, lang, 'Asia/Kuwait')),
    ]);
    expect(row.amount).toMatchObject({ display: '−5.000' });
    expect(row.unread).toBe(false);
  });

  it('deposit_hold on a zero-deposit booking has no figure at all — not −0.000', () => {
    expect(bellRow({ ...HOLD, amountFils: 0 } as BellItem, ctx('en', en)).amount).toBeNull();
  });

  it.each(COPIES)('%s: deposit_return after a no-show — template § 4, +amount', (lang, copy) => {
    const row = bellRow(RETURN_NO_SHOW, ctx(lang, copy));
    expect(row.title).toBe(copy.bellNoShowTitle(lang === 'ar' ? 'أمارا' : 'Amara'));
    expect(row.lines).toEqual([copy.bellNoShowBody('Blow-dry', dayLabel(STARTS, lang, 'Asia/Kuwait'))]);
    expect(row.amount).toMatchObject({ display: '+5.000', tone: 'in' });
  });

  it.each(COPIES)('%s: deposit_return with no booking join falls back to the bare sentence', (lang, copy) => {
    const row = bellRow({ ...RETURN_NO_SHOW, serviceName: null, startsAt: null } as BellItem, ctx(lang, copy));
    expect(row.lines).toEqual([copy.bellNoShowBare]);
  });

  it.each(COPIES)('%s: deposit_return after she cancelled', (lang, copy) => {
    const row = bellRow(RETURN_CANCELLED, ctx(lang, copy));
    expect(row.title).toBe(copy.txKind.deposit_return);
    expect(row.lines).toEqual([`Blow-dry · ${dayLabel(STARTS, lang, 'Asia/Kuwait')}`, copy.bellCancelledReturn]);
  });

  it.each(COPIES)('%s: campaign — the merchant words VERBATIM, no figure', (lang, copy) => {
    const row = bellRow(CAMPAIGN, ctx(lang, copy));
    expect(row.title).toBe('Autumn glow — 20% off facials');
    expect(row.lines).toEqual(['This week only at Amara Salmiya. Book in the app.']);
    expect(row.verbatim).toBe(true);
    expect(row.amount).toBeNull();
  });
});

describe('the Arabic rows are Arabic — a dropped translation goes red here', () => {
  /*
    THE SALON NAME IS HELD LATIN IN BOTH LANGUAGES HERE, on purpose. With the
    Arabic name interpolated, an ENGLISH template ("Your booking at أمارا is
    confirmed.") carries Arabic letters and differs from the English row, so it
    would pass both checks below — measured, when `bellBookingTitle`'s Arabic was
    dropped. Same salon string, so only the template's own words can differ.
  */
  const same = (lang: Language, copy: Copy) => ({ ...ctx(lang, copy), salon: 'Amara' });
  const PAIR: BellItem[] = [
    { ...TOPUP, id: 'TX-P1', transactionId: 'TX-P1', amountFils: 8500, bonusFils: 850, creditFils: 9350 } as BellItem,
    { ...SHOP, id: 'TX-P2', transactionId: 'TX-P2', createdAt: AT, amountFils: 8500 } as BellItem,
  ];
  const cases: Array<[string, BellItem[]]> = [
    ...[TOPUP, CHARGE, SHOP, HOLD, RETURN_NO_SHOW, RETURN_CANCELLED].map(
      (k) => [`${k.kind}:${k.id}`, [k]] as [string, BellItem[]],
    ),
    ['card_order pair', PAIR],
  ];

  it.each(cases)('%s', (_name, items) => {
    const enRows = bellRows(items, same('en', en));
    const arRows = bellRows(items, same('ar', ar));
    expect(arRows).toHaveLength(enRows.length);
    arRows.forEach((arRow, r) => {
      const enRow = enRows[r]!;
      expect(withoutMoney(arRow.title)).toMatch(ARABIC);
      expect(arRow.title).not.toBe(enRow.title);
      // Every line the COPY composed is Arabic once its amount is removed; a
      // line that is only stored names (the service list) is not copy and is
      // exempt. See `withoutMoney` for why the amount must go first.
      for (const line of arRow.lines.filter((l) => !/^[A-Za-z ،,-]+$/.test(l))) {
        expect(withoutMoney(line)).toMatch(ARABIC);
      }
      expect(arRow.when).toMatch(ARABIC);
    });
  });

  /*
    THE LITERAL ARABIC, row by row. The letter checks above cannot be exact — an
    English template with an Arabic date or method inside it ("Paid by كي نت")
    still contains Arabic letters, and several keys survived dropping their
    Arabic until these literals were added. So each kind's whole Arabic row is
    pinned here as the text a Kuwaiti customer reads.
  */
  it('pins every kind’s Arabic row, word for word', () => {
    const arCtx = ctx('ar', ar);
    const PAIR: BellItem[] = [
      { ...TOPUP, id: 'TX-P1', transactionId: 'TX-P1', amountFils: 8500, bonusFils: 850, creditFils: 9350 } as BellItem,
      { ...SHOP, id: 'TX-P2', transactionId: 'TX-P2', createdAt: AT, amountFils: 8500,
        items: [{ name: 'Argan hair oil 100ml', qty: 1 }], fulfilment: 'pickup' } as BellItem,
    ];
    const text = (items: BellItem[], tx: { id: string; voidedAt: string | null }[] = []) =>
      bellRows(items, { ...arCtx, transactions: tx }).map((r) => [r.title, ...r.lines].join(' | '));

    expect(text([TOPUP])).toEqual(['شحن · كي نت | يشمل مكافأة 1.000 د.ك']);
    expect(text([CHARGE])).toEqual(['خدمة | Blow-dry، Cut']);
    expect(text([{ ...CHARGE, services: [], customAmount: true } as BellItem])).toEqual([
      'خدمة | مبلغ أُدخل في الصالون',
    ]);
    expect(text([CHARGE], [{ id: 'TX-2', voidedAt: AT }])).toEqual([
      'خدمة | Blow-dry، Cut | أُلغيت العملية ورجع المبلغ لمحفظتكِ',
    ]);
    expect(text([SHOP])).toEqual(['طلب من المتجر | Repair mask × ٢، Argan hair oil 100ml · توصيل']);
    expect(text(PAIR)).toEqual([
      'طلب من المتجر · كي نت | Argan hair oil 100ml · استلام من الصالون | دُفع عبر كي نت | أُضيفت مكافأة 0.850 د.ك إلى محفظتكِ',
    ]);
    expect(text([HOLD])).toEqual([
      `تم تأكيد حجزكِ في أمارا. | Blow-dry مع Rana | ${dayLabel(STARTS, 'ar', 'Asia/Kuwait')} الساعة ${timeLabel(STARTS, 'ar', 'Asia/Kuwait')}`,
    ]);
    expect(text([RETURN_NO_SHOW])).toEqual([
      `أمارا — رجع عربونكِ. | افتقدناكِ في موعد Blow-dry يوم ${dayLabel(STARTS, 'ar', 'Asia/Kuwait')}.`,
    ]);
    expect(text([{ ...RETURN_NO_SHOW, serviceName: null, startsAt: null } as BellItem])).toEqual([
      'أمارا — رجع عربونكِ. | رجع عربونكِ إلى محفظتكِ.',
    ]);
    expect(text([RETURN_CANCELLED])).toEqual([
      `استرجاع العربون | Blow-dry · ${dayLabel(STARTS, 'ar', 'Asia/Kuwait')} | ألغيتِ الحجز ورجع العربون لمحفظتكِ.`,
    ]);
    expect(
      text([{ id: 'LE-1', kind: 'unknown', serverKind: 'x', createdAt: AT, readAt: null } as BellItem]),
    ).toEqual(['إشعار جديد | حدّثي التطبيق لقراءة هذا الإشعار.']);
    // The day itself, as ICU renders it for the Kuwait calendar day.
    expect(dayLabel(STARTS, 'ar', 'Asia/Kuwait')).toBe('السبت، ٣ أكتوبر');
    expect(timeLabel(STARTS, 'ar', 'Asia/Kuwait')).toBe('٤:٣٠ م');
  });

  it('dates and counts are Eastern in Arabic; money is Western in both (#12)', () => {
    const hold = bellRow(HOLD, ctx('ar', ar));
    expect(hold.lines[1]).toMatch(EASTERN);
    expect(hold.lines[1]).not.toMatch(WESTERN);
    const shop = bellRow(SHOP, ctx('ar', ar));
    expect(shop.lines[0]).toContain('× ٢');
    const topup = bellRow(TOPUP, ctx('ar', ar));
    expect(topup.amount!.display).toBe('+11.000');
    expect(topup.lines[0]).toContain('1.000 د.ك');
    expect(topup.lines[0]).not.toMatch(EASTERN);
  });

  it('the campaign is NOT translated in the Arabic bell', () => {
    const arRow = bellRow(CAMPAIGN, ctx('ar', ar));
    expect(arRow.title).not.toMatch(ARABIC);
    expect(arRow.title).toBe((CAMPAIGN as { title: string }).title);
  });
});

// --------------------------------------------------------------- limits --

describe('a voided charge is not drawn as a successful debit (lane A limit 1)', () => {
  it.each(COPIES)('%s: voided on Home’s page → unsigned figure and the void line', (lang, copy) => {
    const row = bellRow(CHARGE, ctx(lang, copy, [{ id: 'TX-2', voidedAt: '2026-09-28T08:50:00.000Z' }]));
    expect(row.lines).toContain(copy.bellChargeVoided);
    expect(row.amount).toMatchObject({ display: '8.000', tone: 'neutral' });
  });

  it('NOT on the page → it cannot tell, and draws an ordinary charge (reported residue)', () => {
    const row = bellRow(CHARGE, ctx('en', en, [{ id: 'TX-OTHER', voidedAt: '2026-09-28T08:50:00.000Z' }]));
    expect(row.lines).not.toContain(en.bellChargeVoided);
    expect(row.amount!.display).toBe('−8.000');
  });
});

describe('a card-paid order’s two receipts are ONE row (lane A limit 2)', () => {
  // The captured pair: same millisecond, same amount.
  const PAIR_TOPUP: BellItem = { ...TOPUP, id: 'TX-10000000', transactionId: 'TX-10000000', amountFils: 8500, bonusFils: 850, creditFils: 9350 } as BellItem;
  const PAIR_SHOP: BellItem = {
    ...SHOP,
    id: 'TX-10000001',
    transactionId: 'TX-10000001',
    createdAt: AT,
    amountFils: 8500,
    items: [{ name: 'Argan hair oil 100ml', qty: 1 }],
    fulfilment: 'pickup',
  } as BellItem;

  it.each(COPIES)('%s: folded, both ids, unsigned, says how she paid and the bonus', (lang, copy) => {
    const rows = bellRows([PAIR_TOPUP, PAIR_SHOP], ctx(lang, copy));
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.kind).toBe('card_order');
    expect(row!.ids).toEqual(['TX-10000001', 'TX-10000000']);
    expect(row!.title).toBe(`${copy.txKind.shop} · ${copy.txMethod.knet}`);
    expect(row!.lines).toEqual([
      `Argan hair oil 100ml · ${copy.bellPickup}`,
      copy.bellCardOrder(copy.txMethod.knet),
      copy.bellCardOrderBonus(money(850, lang)),
    ]);
    expect(row!.amount).toMatchObject({ display: '8.500', tone: 'neutral' });
  });

  it('a wallet-paid order beside an unrelated top-up is NOT folded', () => {
    const rows = bellRows([TOPUP, { ...PAIR_SHOP, createdAt: '2026-09-28T08:40:00.000Z' } as BellItem], ctx('en', en));
    expect(rows.map((r) => r.kind)).toEqual(['topup', 'shop']);
  });

  it('opening the bell marks BOTH halves of the pair', () => {
    expect(idsToMark(bellRows([PAIR_TOPUP, PAIR_SHOP], ctx('en', en)))).toEqual([
      'TX-10000001',
      'TX-10000000',
    ]);
  });
});

describe('an unknown kind', () => {
  const UNKNOWN: BellItem = {
    id: 'LE-9',
    kind: 'unknown',
    serverKind: 'tier_climb',
    createdAt: AT,
    readAt: null,
  };

  it.each(COPIES)('%s: is a neutral row with the update sentence — never a throw', (lang, copy) => {
    const row = bellRow(UNKNOWN, ctx(lang, copy));
    expect(row.kind).toBe('unknown');
    expect(row.title).toBe(copy.bellUnknownTitle);
    expect(row.lines).toEqual([copy.bellUnknownBody]);
    expect(row.amount).toBeNull();
  });

  it('is drawn but NOT marked read on open — she was not shown its content', () => {
    const rows = bellRows([UNKNOWN, TOPUP], ctx('en', en));
    expect(rows).toHaveLength(2);
    expect(idsToMark(rows)).toEqual(['TX-1']);
  });
});

describe('idsToMark and the offers note', () => {
  it('sends only unread rows that were drawn', () => {
    expect(idsToMark(bellRows([TOPUP, HOLD, CAMPAIGN], ctx('en', en)))).toEqual(['TX-1', 'CMP-1']);
  });

  it('campaign missing from visibleKinds → the offers-off note is owed', () => {
    expect(campaignsHidden(['topup', 'charge', 'shop', 'deposit_hold', 'deposit_return'])).toBe(true);
    expect(campaignsHidden(['topup', 'campaign'])).toBe(false);
  });
});
