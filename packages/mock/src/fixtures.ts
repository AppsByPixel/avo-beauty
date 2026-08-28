/**
 * Fixtures for the mock API.
 *
 * Values are lifted from the design files so a screen built against the mock
 * looks like the reference: Amara, member 8842, 24.500 KD, Silver.
 * design/AVO Wallet Home.dc.html and design/AVO States.dc.html.
 */

import type {
  Artist,
  Campaign,
  LegalDocumentSet,
  Member,
  Product,
  PromotionSet,
  Salon,
  StaffUser,
  SupportConfig,
  Transaction,
} from '@avo/types';

export const SALON_ID = 'SAL-AMARA';
export const BRANCH_SALMIYA = 'BR-SAL';
export const BRANCH_KUWAIT_CITY = 'BR-KWC';

export const salon: Salon = {
  id: SALON_ID,
  name: 'Amara',
  nameAr: 'أمارا',
  // Kuwait City, matching BRANCH_KUWAIT_CITY. A string rather than null on
  // purpose: null is the honest value for a salon predating migration 0037, and
  // this fixture is what the mock-backed suites read — a mock that serves the
  // emptier answer teaches every client the field is usually absent.
  city: 'Kuwait City',
  plan: 'growth',
  brandColor: '#6E7F6C',
  // Both default OFF — AVO-Beauty-Product-Description-v2.md §2.3. The pilot runs
  // without them; flip these to exercise the module-on states.
  modules: { booking: false, shop: false },
  loyaltyMode: 'tiers',
  tiers: [
    { name: 'bronze', minVisits: 0, bonusPercent: 0 },
    { name: 'silver', minVisits: 4, bonusPercent: 10 },
    { name: 'gold', minVisits: 10, bonusPercent: 20 },
    { name: 'black', minVisits: 20, bonusPercent: 30 },
  ],
  stampTarget: 8,
  stampReward: 'Free blow-dry',
  stampRewardAr: 'تصفيف شعر مجاني',
  depositFils: 5000,
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  branches: [
    { id: BRANCH_SALMIYA, salonId: SALON_ID, name: 'Salmiya', nameAr: 'السالمية' },
    { id: BRANCH_KUWAIT_CITY, salonId: SALON_ID, name: 'Kuwait City', nameAr: 'مدينة الكويت' },
  ],
  social: [
    { id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: true },
    { id: 'tiktok', label: 'TikTok', handle: '@amara.kw', on: true },
    { id: 'snapchat', label: 'Snapchat', handle: '', on: false },
    { id: 'whatsapp', label: 'WhatsApp', handle: '+96522334455', on: true },
  ],
  whatsappEnabled: true,
};

export const member: Member = {
  id: '8842',
  salonId: SALON_ID,
  name: 'Dana Al-Sabah',
  phone: '+96599124408',
  email: 'dana@example.com',
  emailVerified: true,
  balanceFils: 24500,
  visits: 5,
  tier: 'silver',
  stamps: null, // salon runs tiers
  policyVersion: 3,
  joinedAt: '2026-02-11T18:20:00+03:00',
};

/** The same member as the salon would look in stamps mode. Toggle with ?loyalty=stamps. */
export const memberStamps: Member = {
  ...member,
  tier: null,
  stamps: 4,
};

export const transactions: Transaction[] = [
  {
    id: 'TX-9021',
    memberId: member.id,
    branchId: BRANCH_SALMIYA,
    kind: 'charge',
    amountFils: -8000,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-9021',
    createdAt: '2026-08-14T19:05:00+03:00',
    voidedAt: null,
    reversedByTransactionId: null,
  },
  {
    id: 'TX-8977',
    memberId: member.id,
    branchId: BRANCH_SALMIYA,
    kind: 'topup',
    amountFils: 10000,
    bonusFils: 1000,
    method: 'knet',
    status: 'settled',
    reference: 'KNET-77120043',
    createdAt: '2026-08-14T11:42:00+03:00',
    voidedAt: null,
    reversedByTransactionId: null,
  },
  {
    id: 'TX-8810',
    memberId: member.id,
    branchId: BRANCH_KUWAIT_CITY,
    kind: 'charge',
    amountFils: -12500,
    bonusFils: 0,
    method: 'wallet',
    status: 'settled',
    reference: 'AVO-CHG-8810',
    createdAt: '2026-08-02T17:30:00+03:00',
    voidedAt: null,
    reversedByTransactionId: null,
  },
  {
    id: 'TX-8642',
    memberId: member.id,
    branchId: BRANCH_SALMIYA,
    kind: 'deposit_return',
    amountFils: 5000,
    bonusFils: 0,
    method: null,
    status: 'settled',
    reference: 'AVO-DEP-8642',
    createdAt: '2026-07-28T15:00:00+03:00',
    voidedAt: null,
    reversedByTransactionId: null,
  },
  {
    id: 'TX-8511',
    memberId: member.id,
    branchId: BRANCH_SALMIYA,
    kind: 'topup',
    amountFils: 25000,
    bonusFils: 2500,
    method: 'knet',
    status: 'settled',
    reference: 'KNET-76988201',
    createdAt: '2026-07-19T13:10:00+03:00',
    voidedAt: null,
    reversedByTransactionId: null,
  },
];

export const staff: StaffUser[] = [
  {
    id: 'ST-001',
    salonId: SALON_ID,
    name: 'Noura',
    handle: 'noura',
    role: 'manager',
    branchAccess: 'all',
    pinSet: true,
    passwordSet: true,
    active: true,
    deactivatedAt: null,
    perms: {
      dashboard: true,
      appointments: true,
      shop: true,
      loyalty: true,
      team: true,
      scanner: true,
      charges: true,
      void: true,
      marketing: true,
    },
  },
  {
    id: 'ST-002',
    salonId: SALON_ID,
    name: 'Hessa',
    handle: 'hessa',
    role: 'frontdesk',
    branchAccess: [BRANCH_SALMIYA],
    pinSet: true,
    passwordSet: true,
    active: true,
    deactivatedAt: null,
    // Deliberately restricted — this is the account lane B and D use to prove
    // the locked screen and the 403. Non-negotiable #7.
    perms: {
      dashboard: false,
      appointments: true,
      shop: false,
      loyalty: false,
      team: false,
      scanner: true,
      charges: false,
      void: false,
      marketing: false,
    },
  },
];

/**
 * IDS MATCH `api/src/db/seed.ts`, AND THAT IS THE POINT — not a coincidence.
 *
 * `artistId` ROUND-TRIPS: the wallet reads an artist here and sends the same id
 * back to `GET /artists/{id}/availability` (state/useBooking.ts) and in the
 * `POST /bookings` body (routes/bookings.ts:96). An id this file invents is an
 * id the real API refuses, and the booking flow would work perfectly against the
 * mock and fail against the server on every attempt.
 *
 * That is exactly what the support topics did for the whole build. These were
 * `AR-01`/`AR-02` against the seed's `AR-001`-`AR-004` until 2026-08-25 —
 * the same defect, in the flow that takes a deposit. The NAMES may differ from
 * the seed's (this file follows the design bundle for display, the header says
 * so); the IDS may not. `fixtures.test.ts` asserts it.
 */
export const artists: Artist[] = [
  {
    id: 'AR-001',
    salonId: SALON_ID,
    name: 'Maryam',
    nameAr: 'مريم',
    hasOwnLogin: true,
    active: true,
    availabilitySource: 'google',
    googleConnected: true,
    slotMinutes: 45,
    windows: {
      '0': { open: true, from: '10:00', to: '21:00' },
      '1': { open: true, from: '10:00', to: '21:00' },
      '2': { open: true, from: '16:00', to: '21:00' },
      '3': { open: true, from: '10:00', to: '21:00' },
      '4': { open: true, from: '10:00', to: '21:00' },
      '5': { open: false, from: '10:00', to: '21:00' },
      '6': { open: true, from: '10:00', to: '21:00' },
    },
  },
  {
    id: 'AR-002',
    salonId: SALON_ID,
    name: 'Fatima',
    nameAr: 'فاطمة',
    hasOwnLogin: false,
    active: true,
    availabilitySource: 'manual',
    googleConnected: false,
    slotMinutes: 30,
    windows: {
      '0': { open: true, from: '16:00', to: '21:00' },
      '1': { open: true, from: '16:00', to: '21:00' },
      '2': { open: true, from: '16:00', to: '21:00' },
      '3': { open: false, from: '10:00', to: '21:00' },
      '4': { open: true, from: '10:00', to: '13:00' },
      '5': { open: false, from: '10:00', to: '21:00' },
      '6': { open: true, from: '16:00', to: '21:00' },
    },
  },
];

/*
 * `image: null` ON EVERY ROW, DELIBERATELY, AND NOT BECAUSE IT IS EASIER.
 *
 * The API reports this field as an explicit `null` rather than omitting it, so a
 * client never has to tell "no image" from "field not sent". A fixture that left
 * it out would be the one place in the system where that distinction blurs — and
 * the mock exists precisely so the wallet and dashboard can build against
 * something shaped like the real thing.
 *
 * When an image fixture is wanted here, it needs a `url` that actually resolves
 * under the mock, not a plausible-looking string: the read is authenticated
 * against the real API, and a fixture URL that 404s would teach a lane's empty
 * state to look like a broken one.
 */
export const products: Product[] = [
  { id: 'PR-01', salonId: SALON_ID, name: 'Argan hair oil 100ml', priceFils: 8500, image: null },
  { id: 'PR-02', salonId: SALON_ID, name: 'Repair mask', priceFils: 12000, image: null },
  { id: 'PR-03', salonId: SALON_ID, name: 'Heat protect spray', priceFils: 6750, image: null },
];

export const services = [
  { id: 'SV-01', name: 'Blow-dry', priceFils: 8000 },
  { id: 'SV-02', name: 'Cut & style', priceFils: 15000 },
  { id: 'SV-03', name: 'Colour — roots', priceFils: 25000 },
  { id: 'SV-04', name: 'Manicure', priceFils: 6000 },
  { id: 'SV-05', name: 'Treatment', priceFils: 12500 },
];

export const promotions: PromotionSet = {
  boosts: {
    [BRANCH_SALMIYA]: { visit: 1, topup: 0, stamp: 1 },
    [BRANCH_KUWAIT_CITY]: { visit: 2, topup: 10, stamp: 1 },
  },
  boostsPublishedAt: '2026-08-10T09:00:00+03:00',
  boostsPublishedBy: 'Noura',
  happy: [
    {
      id: 'HH-01',
      branchId: 'all',
      days: [0, 1, 2], // Sun, Mon, Tue
      from: '16:00',
      to: '18:00',
      reward: 'x2visit',
      on: true,
      notify: true,
    },
    {
      id: 'HH-02',
      branchId: BRANCH_SALMIYA,
      days: [4],
      from: '10:00',
      to: '13:00',
      reward: 'topup10',
      on: false,
      notify: false,
    },
  ],
};

export const campaigns: Campaign[] = [
  {
    id: 'CMP-101',
    salonId: SALON_ID,
    salon: 'Amara',
    title: 'We miss you',
    body: 'It has been a while — 3.000 KD credit on your next visit at Amara.',
    channel: 'both',
    audience: 'lapsed',
    branchId: 'all',
    reward: 'credit3',
    reach: 612,
    when: 'now',
    scheduledAt: '',
    status: 'pending',
    submittedBy: 'Noura',
    submittedAt: '2026-08-16T10:12:00+03:00',
    decidedBy: null,
    decidedAt: null,
    note: null,
    heldReason: null,
    heldAt: null,
    result: null,
  },
];

/**
 * Legal set. The wallet holds NO copy of its own (non-negotiable #10) — it
 * renders exactly this. Abridged here; the full drafted text is in
 * design/avo-promotions.js and lands in the database at seed time.
 */
export const policies: LegalDocumentSet = {
  published: {
    version: 3,
    effectiveFrom: '2026-07-01',
    publishedAt: '2026-06-01T12:00:00+03:00',
    publishedBy: 'Fahad',
    docs: [
      {
        id: 'terms',
        scope: 'platform',
        consent: true,
        title: { en: 'Terms & conditions', ar: 'الشروط والأحكام' },
        body: {
          en: [
            '1. Contracting parties. This agreement is between you and the salon whose app you are using.',
            '5. Wallet credit. Credit in your wallet is prepaid credit for one salon. It is not a bank deposit, is not covered by deposit insurance, earns no interest, and cannot be withdrawn as cash. Payments are processed by a CBK-licensed payment service provider.',
          ],
          ar: [
            '١. أطراف التعاقد. هذه الاتفاقية بينكِ وبين الصالون الذي تستخدمين تطبيقه.',
            '٥. رصيد المحفظة. الرصيد في محفظتكِ هو رصيد مدفوع مسبقاً لصالون واحد. وهو ليس وديعة بنكية، وغير مشمول بضمان الودائع، ولا يحقق فوائد، ولا يمكن سحبه نقداً.',
          ],
        },
      },
      {
        id: 'privacy',
        scope: 'platform',
        consent: true,
        title: { en: 'Privacy policy', ar: 'سياسة الخصوصية' },
        body: {
          en: ['1. Controller. The salon is the controller of your customer data; AVO processes it on their behalf.'],
          ar: ['١. المتحكم بالبيانات. الصالون هو المتحكم ببيانات عملائه، وAVO تعالجها نيابةً عنه.'],
        },
      },
      {
        id: 'refunds',
        scope: 'wallet',
        consent: true,
        title: { en: 'Refunds & cancellation', ar: 'الاسترجاع والإلغاء' },
        body: {
          en: ['Refunds are always returned as wallet credit. There is no cash refund and no card reversal.'],
          ar: ['يتم الاسترجاع دائماً كرصيد في المحفظة. لا يوجد استرجاع نقدي ولا عكس للعملية على البطاقة.'],
        },
      },
    ],
  },
  draft: { docs: [] },
};

export const support: SupportConfig = {
  channels: {
    whatsapp: '+96550001234',
    email: 'help@avo.beauty',
    hoursEn: 'Sunday to Thursday, 9am – 6pm',
    hoursAr: 'الأحد إلى الخميس، ٩ صباحاً – ٦ مساءً',
    replyEn: 'We usually reply within one working day.',
    replyAr: 'نرد عادةً خلال يوم عمل واحد.',
  },
  /**
   * THE IDS AND WORDING THE REAL API SEEDS, verbatim from
   * `design/avo-promotions.js` — which `api/src/db/seed.ts` also seeds, verified
   * against a live `support_topic` table rather than read across.
   *
   * These were `tp-appt` / `tp-visit` / `tp-wallet` / `tp-charge` / `tp-account`
   * until 2026-08-25: five invented ids, none of which exist in the real
   * database, with different wording and no `other`. The consequence was not
   * cosmetic — `support_ticket.topic_id` references `support_topic` under
   * `ON DELETE RESTRICT`, so **the wallet's Contact-us form worked against this
   * mock and would have been refused by the real API on every topic**. A mock
   * that teaches a client ids the server has never heard of is worse than no
   * mock, because the failure surfaces only after the client is finished.
   *
   * Nothing caught it: `e2e` drives the real seed and the design file, which
   * agree with each other, so the drift was invisible to the one suite that
   * spans both. Lane B found it by going to the design file to check whether a
   * comment it was writing was TRUE rather than plausible.
   *
   * Keep this list byte-identical to the design's. It is the contract's
   * vocabulary, not a fixture's taste.
   */
  topics: [
    { id: 'wallet', route: 'avo', en: 'Wallet, top-ups or refunds', ar: 'المحفظة أو الشحن أو الاسترجاع' },
    { id: 'charge', route: 'avo', en: 'A charge I do not recognise', ar: 'خصم لا أعرفه' },
    { id: 'booking', route: 'salon', en: 'An appointment', ar: 'موعد' },
    { id: 'visit', route: 'salon', en: 'My visit or the service', ar: 'زيارتي أو الخدمة' },
    { id: 'account', route: 'avo', en: 'My account or my data', ar: 'حسابي أو بياناتي' },
    { id: 'other', route: 'avo', en: 'Something else', ar: 'شيء آخر' },
  ],
};
