// @vitest-environment jsdom

/**
 * NO STRING SAYS "AMARA" TO A CUSTOMER OF ANOTHER WORKSPACE.
 *
 * Trunk's demo, 2026-09-30: Maha, a SAL-FOREST member, signed in and landed in
 * Forest green — and her Account said "Your wallet holds prepaid credit for
 * Amara Salon only." Five keys in each copy file had the default salon's name
 * written in. They take the signed-in workspace's name now
 * (`state/workspaceName.ts`); this file draws the real screens and reads the
 * whole document, because a key-by-key copy test cannot see a literal that
 * some OTHER string on the screen still carries.
 *
 *   1. Forest, both languages: Account (its settings and fine print), the
 *      Contact sheet's confirmation, and Home each name Forest, and the word
 *      Amara — Latin or Arabic — is nowhere in the document.
 *   2. Amara, both languages: the design's own sentences, verbatim — the one
 *      exception is English `walletFine`, which drops the design's appended
 *      "Salon" (en.ts § walletFine) and is pinned in its new form.
 *   3. An empty `nameAr` falls back to the Latin name inside Arabic sentences.
 *   4. Before sign-in: the last workspace's name, then the default; sign-up
 *      always the default's, because that is where it registers her.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { brandPresets } from '@avo/tokens';
import {
  MemberSchema,
  SalonSchema,
  type Language,
  type Member,
  type Salon,
  type SupportConfig,
  type SupportTicket,
} from '@avo/types';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiRemove: async (ks: string[]) => void ks.forEach((k) => store.delete(k)),
  },
}));
vi.mock('react-native-svg', () => {
  const Nothing = () => null;
  return { default: Nothing, Svg: Nothing, Path: Nothing, Circle: Nothing, Rect: Nothing, G: Nothing };
});
vi.mock('react-native-qrcode-svg', () => ({ default: () => null }));
vi.mock('expo-linear-gradient', async () => {
  const { View } = await import('react-native');
  return {
    LinearGradient: ({ children, style }: { children?: ReactNode; style?: object }) => (
      <View style={style}>{children}</View>
    ),
  };
});

/* Account's reads, answered directly — the hooks are not what is under test. */
const h = vi.hoisted(() => ({
  account: null as unknown,
  submitTicket: null as unknown as (...a: unknown[]) => Promise<unknown>,
}));
vi.mock('../state/useAccount', () => ({
  useAccount: () => ({
    status: 'ready',
    data: h.account,
    fetchedAt: Date.now(),
    failure: null,
    refreshing: false,
    retry: () => undefined,
    applyMember: () => undefined,
  }),
}));
vi.mock('../state/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/notifications')>();
  return {
    ...actual,
    useNotificationPreferences: () => ({
      prefs: { push: true, wa: true, remind: true, receipt: false, offers: false },
      offersConsent: null,
      toggle: () => undefined,
      loaded: true,
      loadFailed: false,
      writeFailed: null,
      saving: [],
      reload: () => undefined,
    }),
  };
});
vi.mock('../state/useDeletionState', () => ({
  useDeletionState: () => ({ state: null, loaded: true, loadFailed: false, reload: () => undefined }),
}));
vi.mock('../api/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/account')>();
  return {
    ...actual,
    submitTicket: (...a: unknown[]) => h.submitTicket(...a),
    // Sign-up's terms stay loading: the form, and its sub-line, still render.
    getPolicies: () => new Promise(() => undefined),
  };
});

/* eslint-disable import/first */
import { AccountScreen } from './AccountScreen';
import { HomeScreen } from './HomeScreen';
import { SignInScreen } from './SignInScreen';
import { SignUpScreen } from './SignUpScreen';
import { LanguageProvider } from '../i18n/language';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import { DEFAULT_SALON_NAME } from '../config/salon';
import { __resetLastWorkspaceForTest, rememberWorkspace } from '../state/lastWorkspace';
import { workspaceName } from '../state/workspaceName';

// ------------------------------------------------------------------ fixtures --

/** Latin and Arabic, so a single regex catches either script's spelling. */
const AMARA_ANYWHERE = /amara|أمارا|أمارة/i;

const HOURS = { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] };
const salonFixture = (id: string, name: string, nameAr: string | null, brandColor: string): Salon =>
  SalonSchema.parse({
    id,
    name,
    nameAr,
    city: 'Kuwait City',
    plan: 'growth',
    brandColor,
    walletCard: 'brand',
    modules: { booking: false, shop: false },
    loyaltyMode: 'tiers',
    tiers: [
      { name: 'bronze', minVisits: 0, bonusPercent: 0 },
      { name: 'gold', minVisits: 4, bonusPercent: 10 },
    ],
    stampTarget: 8,
    stampReward: 'Free blow-dry',
    stampRewardAr: null,
    depositFils: 5000,
    noShowReturnMinutes: 60,
    timezone: 'Asia/Kuwait',
    businessHours: HOURS,
    branches: [
      { id: `BR-${id}`, salonId: id, name: 'Kuwait City', nameAr: 'مدينة الكويت', businessHours: HOURS, businessHoursSource: 'salon' },
    ],
    // One live handle, so "Follow <salon>" renders too.
    social: [{ id: 'instagram', label: 'Instagram', handle: '@salon.kw', on: true }],
    whatsappEnabled: true,
    emailEnabled: true,
  });

const FOREST = salonFixture('SAL-FOREST', 'Forest', null, brandPresets.forest.brand);
const FOREST_EMPTY_AR = salonFixture('SAL-FOREST', 'Forest', '', brandPresets.forest.brand);
const AMARA = salonFixture('SAL-AMARA', 'Amara', 'أمارا', brandPresets.amaraSage.brand);

const memberAt = (salonId: string): Member =>
  MemberSchema.parse({
    id: 'M-1',
    salonId,
    name: 'Maha Al-Rashid',
    phone: '+96599124408',
    email: 'maha@example.com',
    emailVerified: true,
    balanceFils: 41750,
    visits: 12,
    tier: 'gold',
    stamps: null,
    policyVersion: 3,
    joinedAt: '2026-02-11T18:20:00+03:00',
  });

const SUPPORT: SupportConfig = {
  channels: {
    whatsapp: '+96522000000',
    email: 'help@avo.example',
    hoursEn: 'Sun–Thu, 9–5',
    hoursAr: 'الأحد–الخميس',
    replyEn: 'Within a day',
    replyAr: 'خلال يوم',
  },
  topics: [{ id: 'T-BOOK', route: 'salon', en: 'A booking', ar: 'حجز' }],
};

const POLICIES = {
  version: 3,
  effectiveFrom: '2026-07-01',
  publishedAt: '2026-06-20T10:00:00Z',
  publishedBy: 'AVO',
  docs: [
    {
      id: 'DOC-WALLET',
      scope: 'wallet',
      consent: true,
      title: { en: 'Wallet terms', ar: 'شروط المحفظة' },
      body: { en: ['Clause.'], ar: ['بند.'] },
    },
  ],
};

function useSession(salon: Salon) {
  h.account = { member: memberAt(salon.id), salon, policies: POLICIES, support: SUPPORT };
  h.submitTicket = async () =>
    ({ id: 'SUP-48263', route: 'salon' }) as unknown as SupportTicket;
}

const wrap = (lang: Language, node: ReactNode) =>
  render(<LanguageProvider initial={lang}>{node}</LanguageProvider>);

function drawAccount(lang: Language) {
  wrap(lang, <AccountScreen onBack={vi.fn()} onLogOut={vi.fn()} onForgotPassword={vi.fn()} />);
}

/** Opens Contact us, sends a salon-routed message, and waits for the confirmation. */
async function sendSalonMessage() {
  fireEvent.click(screen.getByTestId('contact-open'));
  fireEvent.click(await screen.findByTestId('topic-T-BOOK'));
  fireEvent.change(screen.getByTestId('contact-message'), { target: { value: 'My booking time' } });
  fireEvent.click(screen.getByTestId('contact-send'));
  return screen.findByTestId('contact-sent');
}

function drawHome(lang: Language, salon: Salon) {
  wrap(
    lang,
    <HomeScreen
      home={{
        status: 'ready',
        snapshot: { member: memberAt(salon.id), salon, transactions: [], promotions: null },
        fetchedAt: Date.now(),
        failure: null,
        refreshing: false,
        retry: vi.fn(),
      }}
      onOpenAccount={vi.fn()}
      onBook={vi.fn()}
      onReschedule={vi.fn()}
      onToast={vi.fn()}
      codeView={{ kind: 'pending', canEnlarge: false }}
      codeSecondsRemaining={0}
      onEnlargeCode={vi.fn()}
      onRetryCode={vi.fn()}
      onPullToRefresh={() => false}
      refreshGeneration={0}
    />,
  );
}

const pageText = () => document.body.textContent ?? '';

beforeEach(() => {
  store.clear();
  __resetLastWorkspaceForTest();
  // Anything Home's own hooks reach for (the bell) finds no network, and says so.
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Network request failed')));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LANGS = [
  ['en', en],
  ['ar', ar],
] as const;

// ═══════════════════════════════════════════════════ 1 · a Forest session ══

describe('1. a Forest session names Forest, and never Amara', () => {
  it.each(LANGS)('%s: Account — the fine print, the offers switch and Follow', (lang, copy) => {
    useSession(FOREST);
    drawAccount(lang);
    // Forest has no nameAr, so Arabic reads the Latin name.
    expect(screen.getByText(copy.walletFine('Forest'))).toBeTruthy();
    expect(screen.getByText(copy.nOffersSub('Forest'))).toBeTruthy();
    expect(screen.getByText(copy.followTitle('Forest'))).toBeTruthy();
    expect(pageText()).not.toMatch(AMARA_ANYWHERE);
  });

  it.each(LANGS)('%s: Contact us — the salon-routed confirmation', async (lang, copy) => {
    useSession(FOREST);
    drawAccount(lang);
    const sent = await sendSalonMessage();
    expect(sent.textContent).toContain(copy.cSentSalon('Forest'));
    expect(pageText()).not.toMatch(AMARA_ANYWHERE);
  });

  it.each(LANGS)('%s: Home', async (lang) => {
    drawHome(lang, FOREST);
    expect(screen.getAllByText('Forest').length).toBeGreaterThan(0);
    // Let the bell's failed read settle, then read the whole page again.
    await waitFor(() => expect(pageText()).not.toMatch(AMARA_ANYWHERE));
  });

  it('the literal sentences, in full', () => {
    expect(en.walletFine('Forest')).toBe(
      'Your wallet holds prepaid credit for Forest only. Credit does not expire, cannot be transferred to another salon, and is not a bank deposit.',
    );
    expect(en.nOffersSub('Forest')).toBe('Occasional promotions from Forest. Off by default.');
    expect(en.cSentSalon('Forest')).toBe('Forest has your message and will reply on WhatsApp.');
    expect(en.signUpSub('Forest')).toBe('Your Forest wallet — valid at every Forest branch');
    expect(ar.walletFine('Forest')).toBe(
      'محفظتك تحتوي رصيداً مدفوعاً مسبقاً لصالون Forest فقط. الرصيد لا ينتهي، ولا يمكن تحويله لصالون آخر، وليس وديعة بنكية.',
    );
    expect(ar.nOffersSub('Forest')).toBe('عروض من Forest بين حين وآخر. مغلقة افتراضياً.');
    expect(ar.cSentSalon('Forest')).toBe('وصلت رسالتك إلى Forest وسيتم الرد على واتساب.');
    expect(ar.signUpSub('Forest')).toBe('محفظتك في Forest — صالحة في كل فروع Forest');
  });
});

// ═══════════════════════════════════════════════════ 2 · an Amara session ══

describe('2. an Amara session reads the design’s own words', () => {
  it('English: verbatim from design:1206 and :1227; walletFine without the appended "Salon"', async () => {
    useSession(AMARA);
    drawAccount('en');
    expect(screen.getByText('Occasional promotions from Amara. Off by default.')).toBeTruthy();
    // design:1214 reads "…for Amara Salon only." — see en.ts § walletFine.
    expect(
      screen.getByText(
        'Your wallet holds prepaid credit for Amara only. Credit does not expire, cannot be transferred to another salon, and is not a bank deposit.',
      ),
    ).toBeTruthy();
    const sent = await sendSalonMessage();
    expect(sent.textContent).toContain('Amara has your message and will reply on WhatsApp.');
  });

  it('Arabic: verbatim from design:1313, :1321 and :1334', async () => {
    useSession(AMARA);
    drawAccount('ar');
    expect(screen.getByText('عروض من أمارا بين حين وآخر. مغلقة افتراضياً.')).toBeTruthy();
    expect(
      screen.getByText(
        'محفظتك تحتوي رصيداً مدفوعاً مسبقاً لصالون أمارا فقط. الرصيد لا ينتهي، ولا يمكن تحويله لصالون آخر، وليس وديعة بنكية.',
      ),
    ).toBeTruthy();
    const sent = await sendSalonMessage();
    expect(sent.textContent).toContain('وصلت رسالتك إلى أمارا وسيتم الرد على واتساب.');
  });

  it.each([
    ['en', 'Your Amara wallet — valid at every Amara branch'], // design:1250
    ['ar', 'محفظتك في أمارا — صالحة في كل فروع أمارا'], // design:1357
  ] as const)('%s: sign-up, verbatim', (lang, sentence) => {
    wrap(lang, <SignUpScreen onSignedUp={vi.fn()} onLogIn={vi.fn()} />);
    expect(screen.getByText(sentence)).toBeTruthy();
  });
});

// ═══════════════════════════════════════ 3 · an empty Arabic name falls back ══

describe('3. Arabic falls back to the Latin name when nameAr is empty', () => {
  it('Account and Contact us read "Forest", never a hole in the sentence', async () => {
    useSession(FOREST_EMPTY_AR);
    drawAccount('ar');
    expect(screen.getByText(ar.walletFine('Forest'))).toBeTruthy();
    expect(screen.getByText(ar.nOffersSub('Forest'))).toBeTruthy();
    expect(screen.queryByText(ar.walletFine(''))).toBeNull();
    const sent = await sendSalonMessage();
    expect(sent.textContent).toContain(ar.cSentSalon('Forest'));
  });

  it('an Arabic name, when the salon has one, is the one Arabic reads', () => {
    useSession(salonFixture('SAL-FOREST', 'Forest', 'فورست', brandPresets.forest.brand));
    drawAccount('ar');
    expect(screen.getByText(ar.walletFine('فورست'))).toBeTruthy();
    expect(pageText()).not.toContain('Forest only');
  });
});

// ═══════════════════════════════════════════════ 4 · before there is a salon ══

describe('4. before sign-in: the last workspace, then the default', () => {
  const FOREST_ROW = {
    salonId: 'SAL-FOREST',
    name: 'Forest',
    nameAr: null,
    brandColor: brandPresets.forest.brand,
  };

  it('workspaceName: the salon on screen, then the last workspace, then the default', async () => {
    expect(workspaceName(null, 'en')).toBe(DEFAULT_SALON_NAME.name);
    expect(workspaceName(null, 'ar')).toBe(DEFAULT_SALON_NAME.nameAr);
    await rememberWorkspace(FOREST_ROW);
    expect(workspaceName(null, 'en')).toBe('Forest');
    expect(workspaceName(null, 'ar')).toBe('Forest');
    expect(workspaceName(AMARA, 'ar')).toBe('أمارا');
  });

  it.each(LANGS)('%s: a phone last signed in at Forest has a Forest sign-in screen', async (lang, copy) => {
    await rememberWorkspace(FOREST_ROW);
    wrap(lang, <SignInScreen onSignedIn={vi.fn()} onCreateAccount={vi.fn()} onForgotPassword={vi.fn()} />);
    expect(screen.getByTestId('signin-salon').textContent).toBe('Forest');
    expect(screen.getByText(copy.signInSub('Forest'))).toBeTruthy();
    expect(pageText()).not.toMatch(AMARA_ANYWHERE);
  });

  it('sign-up names the DEFAULT workspace even after a Forest sign-in — it registers there', async () => {
    await rememberWorkspace(FOREST_ROW);
    wrap('en', <SignUpScreen onSignedUp={vi.fn()} onLogIn={vi.fn()} />);
    expect(screen.getByTestId('signup-salon').textContent).toBe(DEFAULT_SALON_NAME.name);
    expect(screen.getByText(en.signUpSub(DEFAULT_SALON_NAME.name))).toBeTruthy();
  });
});
