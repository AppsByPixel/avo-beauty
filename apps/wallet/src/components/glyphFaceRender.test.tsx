// @vitest-environment jsdom

/**
 * THE WIRING HALF OF THE FACELESS-TEXT RULE, FOR THE SYMBOL GLYPHS.
 *
 * `theme/typeFidelity.test.ts` § "every Text that draws copy resolves a face"
 * reads the source and is the exhaustive check. What it cannot say is whether
 * the face it sees composed actually ARRIVES — `text('bodyS', lang)` reads
 * correctly with a `lang` that is always undefined, and `styles.resultGlyph`
 * layered over it could grow a `fontFamily` nobody noticed and win.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THESE NODES USED TO DO, MEASURED RATHER THAN ASSUMED.
 *
 * All four glyphs were on a BARE `styles.X` with no family: the selected-slot
 * tick, the booking-confirmed badge tick, and the top-up result mark in all four
 * of its arms. They were allow-listed, and the reason given was that U+25F7 and
 * U+2715 are in none of the faces this app loads — true — so pinning a face
 * would "force a substitution". That premise was wrong, and the way it was shown
 * wrong is the reason this file exists.
 *
 * Driven in Chrome against the real ttfs, one span per family at 34px/700, the
 * family emitted bare the way react-native-web emits it, against a control
 * family declared nowhere:
 *
 *              U+2713 ✓   U+25F7 ◷   U+2715 ✕   U+26A0 ⚠
 *   Inter          30.00      20.48      25.92      34.87
 *   Plex Arabic    31.02      20.48      25.92      34.00
 *   no such face   25.67      20.48      25.92      34.00
 *
 * The fallback runs PER CHARACTER, so a named face that lacks the codepoint
 * never enters the cascade for that character and costs exactly nothing —
 * U+25F7 and U+2715 measure identically under all three, to the hundredth of a
 * pixel. U+26A0 shows the same signature in Arabic only. And U+2713 differs
 * under all three: the unpinned ticks were not drawing Inter's tick, they were
 * drawing a narrower system one, which is the defect this file now pins shut.
 *
 * `document.fonts.check` DOES NOT GUARD THIS. It returned true for all four
 * codepoints against a family that was never declared at all.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PAY→GET ARROW IS HERE TOO, AND IT IS THE ODD ONE. Every other node in
 * this file asserts Inter in English and Plex Arabic in Arabic; that one asserts
 * Inter in BOTH, because a language-following face would hand the Arabic build a
 * mark 14% narrower (Inter 1954/2048 em, Plex 820/1000) on a node that sets the
 * gap between the Pay and Get columns — and the design's own arrow is one
 * artwork mirrored by a width-preserving `scaleX(-1)`. `TopUpCard.tsx`
 * § THE ARROW IS A GLYPH is the argument; the identical expectation in both
 * languages is how it is held.
 *
 * WHY THE BOOK-CONFIRMED TICK IS NOT HERE. `ConfirmedStage` is internal to
 * `BookScreen`, which loads a salon, a service list, an artist list and an
 * availability window before it can reach the confirmation. `ArtistRow` is the
 * same tick under the same fix in a component that renders on its props, so the
 * wiring claim is made once here and the confirmed badge is named by the source
 * rule instead — typeFidelity.test.ts § "the pinned glyph sites are named".
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fils,
  type BookableArtist,
  type Member,
  type PromotionSet,
  type Salon,
  type TopUpIntentPublic,
} from '@avo/types';

import { ArtistRow } from './booking/BookingParts';
import { TopUpCard } from './TopUpCard';
import { TopUpSheet } from './TopUpSheet';
import { LanguageProvider } from '../i18n/language';
import type { TopUpController, TopUpStage } from '../state/useTopUp';

afterEach(cleanup);

const ARTIST: BookableArtist = {
  id: 'art_1',
  salonId: 'sal_1',
  name: 'Dana',
  nameAr: 'دانة',
  availabilityLive: true,
};

const INTENT: TopUpIntentPublic = {
  id: 'tup_1',
  memberId: 'mem_1',
  amountFils: fils(10000),
  bonusFils: fils(500),
  creditFils: fils(10500),
  method: 'knet',
  status: 'succeeded',
  failureReason: null,
  redirectUrl: 'https://pay.example.com/tup_1',
  reference: 'AVO-1234',
};

/** Nothing below taps anything; the controller is here to satisfy the prop. */
const CONTROLLER: TopUpController = {
  stage: { name: 'closed' },
  open: () => {},
  chooseMethod: () => {},
  retryQuote: () => {},
  pay: () => {},
  retryOpen: () => {},
  tryAgain: () => {},
  close: () => {},
};

/**
 * The computed family of the leaf element whose whole text is `ch`.
 *
 * A leaf, deliberately: react-native-web nests a `<div>` around the text node,
 * and the ancestor's `textContent` matches too. The family is read off the one
 * that actually carries the character.
 */
function faceOfGlyph(container: HTMLElement, ch: string): string {
  const leaves = Array.from(container.querySelectorAll('*')).filter(
    (n) => n.textContent === ch && n.children.length === 0,
  );
  expect(leaves.length, `expected exactly one leaf drawing ${ch}`).toBe(1);
  return getComputedStyle(leaves[0] as HTMLElement).fontFamily.replace(/"/g, '');
}

function renderTick(lang: 'en' | 'ar') {
  cleanup();
  const { container } = render(
    <LanguageProvider initial={lang}>
      <ArtistRow artist={ARTIST} selected onPick={() => {}} />
    </LanguageProvider>,
  );
  return faceOfGlyph(container, '✓');
}

function renderTopUp(lang: 'en' | 'ar', stage: TopUpStage, ch: string) {
  cleanup();
  const { container } = render(
    <LanguageProvider initial={lang}>
      <TopUpSheet stage={stage} controller={CONTROLLER} newBalanceFils={fils(24500)} tier={null} />
    </LanguageProvider>,
  );
  return faceOfGlyph(container, ch);
}

const SUCCESS: TopUpStage = { name: 'result', intent: INTENT, outcome: 'success' };
const PENDING: TopUpStage = { name: 'result', intent: INTENT, outcome: 'pending' };
const DECLINED: TopUpStage = { name: 'result', intent: INTENT, outcome: 'declined' };
const OFFLINE: TopUpStage = {
  name: 'quoteFailed',
  amountFils: fils(10000),
  method: 'knet',
  failure: { kind: 'offline', message: 'no network', reference: 'AVO-9' },
};
const QUOTE_FAILED: TopUpStage = {
  name: 'quoteFailed',
  amountFils: fils(10000),
  method: 'knet',
  failure: { kind: 'server', message: 'boom', reference: 'AVO-9' },
};
const GATEWAY_FAILED: TopUpStage = {
  name: 'gatewayFailed',
  intent: INTENT,
  failure: { reason: 'blocked', detail: 'popup blocked' },
};

/** Every glyph arm of `resultGlyph`, keyed by the stage that draws it. */
const RESULT_ARMS: [string, TopUpStage, string][] = [
  ['success ✓', SUCCESS, '✓'],
  ['pending ◷', PENDING, '◷'],
  ['declined ✕', DECLINED, '✕'],
  ['quote offline ⚠', OFFLINE, '⚠'],
  ['quote failed ✕', QUOTE_FAILED, '✕'],
  ['gateway failed ✕', GATEWAY_FAILED, '✕'],
];

/**
 * THE PAY→GET ARROW, which is the one node here whose two languages are
 * expected to agree. Everything above asserts Inter in English and Plex Arabic
 * in Arabic; this asserts Inter in BOTH, and that difference is the decision
 * rather than an oversight — `TopUpCard.tsx` § "THE ARROW IS A GLYPH" carries
 * the reasoning and the widths. No fake timers: the card's 30s interval only
 * re-resolves happy hours, `ARROW_PROMOTIONS` carries none, and `cleanup()`
 * unmounts before it could fire.
 */
const ARROW_MEMBER = { tier: 'silver' } as Member;

const ARROW_SALON = {
  loyaltyMode: 'tiers',
  timezone: 'Asia/Kuwait',
  tiers: [
    { name: 'bronze', bonusPercent: 0 },
    { name: 'silver', bonusPercent: 10 },
  ],
} as Salon;

const ARROW_PROMOTIONS: PromotionSet = {
  boosts: {},
  boostsPublishedAt: '2026-08-10T06:00:00.000Z',
  boostsPublishedBy: 'Noura',
  happy: [],
};

function renderArrow(lang: 'en' | 'ar') {
  cleanup();
  const { container } = render(
    <LanguageProvider initial={lang}>
      <TopUpCard
        member={ARROW_MEMBER}
        salon={ARROW_SALON}
        promotions={ARROW_PROMOTIONS}
        selected={fils(10000)}
        onSelect={() => {}}
        onContinue={() => {}}
      />
    </LanguageProvider>,
  );
  return faceOfGlyph(container, lang === 'ar' ? '←' : '→');
}

describe('the symbol glyphs resolve one of the app\'s own faces', () => {
  it('the selected-slot tick is Inter in English and Plex Arabic in Arabic', () => {
    // 700, because the style declared `fontWeight: '700'` with no family to
    // apply it to. The weight was always inert here; pinning moved it onto the
    // base call, so it now selects a real Bold face rather than being ignored.
    expect(renderTick('en')).toBe('Inter_700Bold');
    expect(renderTick('ar')).toBe('IBMPlexSansArabic_700Bold');
  });

  it.each(RESULT_ARMS)('the top-up result mark, %s, is Inter in English', (_name, stage, ch) => {
    // `resultGlyph` declares no weight, so it takes bodyS's own 400 rather than
    // whatever the platform would have picked.
    expect(renderTopUp('en', stage, ch)).toBe('Inter_400Regular');
  });

  it.each(RESULT_ARMS)('the top-up result mark, %s, is Plex Arabic in Arabic', (_name, stage, ch) => {
    expect(renderTopUp('ar', stage, ch)).toBe('IBMPlexSansArabic_400Regular');
  });

  /**
   * THE ARROW IS THE ONE THAT MUST **NOT** FOLLOW THE LANGUAGE, and asserting
   * the same value twice is the only way to say so in a way that goes red. A
   * later reader "correcting" this style to `text('bodyS', lang)` — which is
   * right at every other Text in that file — fails the Arabic half here.
   */
  it('the pay→get arrow is Inter in English AND in Arabic, deliberately', () => {
    expect(renderArrow('en')).toBe('Inter_400Regular');
    expect(renderArrow('ar')).toBe('Inter_400Regular');
  });

  /**
   * THE ONE THAT FAILS ON THE SHAPE THAT ACTUALLY SHIPPED. Every assertion
   * above would still pass if the family were merely the WRONG app face. This
   * one goes red on the regression that matters: a family absent altogether,
   * which react-native-web leaves on its `font: '14px System'` base style and
   * the OS then resolves.
   */
  it('emits a family at all — the defect was its absence, not its value', () => {
    const faces = [renderTick('en'), renderTick('ar'), renderArrow('en'), renderArrow('ar')];
    for (const lang of ['en', 'ar'] as const) {
      for (const [, stage, ch] of RESULT_ARMS) faces.push(renderTopUp(lang, stage, ch));
    }
    for (const face of faces) {
      expect(face).not.toBe('');
      expect(face).not.toMatch(/system|-apple-|Segoe|Roboto|Helvetica|Arial|sans-serif/i);
      expect(face).toMatch(/^(Inter|IBMPlexSansArabic|Fraunces)_\d{3}/);
    }
  });
});
