// @vitest-environment jsdom

/**
 * THE HAPPY-HOUR BANNER, RENDERED — the wiring half of a rule the domain tests
 * already prove.
 *
 * `domain/happyHour.test.ts` proves `happyBanner` thoroughly, and proves it as a
 * pure function of an instant. What no pure test can reach is whether the
 * COMPONENT asks it about the right instant, or whether someone one day replaces
 * the derivation with a stored `live` flag and every domain test stays green.
 *
 * That is not a hypothetical failure mode in this project — it is the one
 * CLAUDE.md names: "the happy-hour predicate, never a `live` flag". And it is
 * exactly the class of gap found in the wallet's Pay tab, where the rule was
 * tested and the call to it was not (DECISIONS.md #38).
 *
 * SO THE ASSERTION IS: SAME DATA, TWO CLOCKS, TWO BANNERS. Identical props, a
 * system clock moved from inside the window to outside it, and the rendered
 * output has to change. A `live` flag on the promotion could not pass this, and
 * neither could a component that read the clock once at module load.
 *
 * HH-01 runs Sun/Mon/Tue 16:00–18:00 in Asia/Kuwait. 2026-08-30 is a Sunday.
 * Times are written as Kuwait wall time with an explicit +03:00 so the test does
 * not depend on the machine's zone — the same care `happyHour.test.ts` takes.
 */

import { AA_NORMAL_TEXT, color, contrastRatio, hexToRgb } from '@avo/tokens';
import type { HappyHour, PromotionSet } from '@avo/types';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HappyHourBanner } from './HappyHourBanner';
import { LanguageProvider } from '../i18n/language';

const HH_01: HappyHour = {
  id: 'HH-01',
  branchId: 'all',
  days: [0, 1, 2],
  from: '16:00',
  to: '18:00',
  reward: 'x2visit',
  on: true,
  notify: true,
};

const PROMOTIONS: PromotionSet = {
  boosts: { 'BR-SAL': { visit: 1, topup: 0, stamp: 1 } },
  boostsPublishedAt: '2026-08-10T06:00:00.000Z',
  boostsPublishedBy: 'Noura',
  happy: [HH_01],
};

const SALON = {
  branches: [{ id: 'BR-SAL', name: 'Salmiya', nameAr: 'السالمية' }],
  timezone: 'Asia/Kuwait',
} as never;

/** A UTC instant written as the Kuwait wall time it denotes. */
const kuwait = (iso: string) => new Date(`${iso}+03:00`);

function renderAt(instant: Date, lang: 'en' | 'ar' = 'en') {
  vi.setSystemTime(instant);
  return render(
    <LanguageProvider initial={lang}>
      <HappyHourBanner promotions={PROMOTIONS} salon={SALON} />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  // `shouldAdvanceTime` keeps the component's own 1s interval from starving the
  // renderer while the clock is frozen.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('the banner is computed from the clock, not read off a flag', () => {
  it('renders the live banner inside the window', () => {
    const { container } = renderAt(kuwait('2026-08-30T17:00:00'));
    expect(container.textContent).toBeTruthy();
    expect(container.textContent).toContain('Happy hour');
  });

  it('renders something DIFFERENT outside the window, from identical props', () => {
    const inside = renderAt(kuwait('2026-08-30T17:00:00')).container.textContent;
    cleanup();
    const outside = renderAt(kuwait('2026-08-30T12:00:00')).container.textContent;

    // The precise copy is the domain layer's business. What this owns is that
    // the component's output is a FUNCTION OF THE CLOCK: one set of props,
    // two instants, two different renderings.
    expect(outside).not.toBe(inside);
  });

  it('looks AHEAD on a day the happy hour does not run', () => {
    // Thursday, 17:00 — the same wall-clock time that is live on a Sunday.
    // HH-01 runs Sun/Mon/Tue, so the hour matching proves nothing by itself;
    // only the day does. The component announces the next occurrence rather
    // than going blank, which is the `bannerNext` branch.
    //
    // I expected '' here and was wrong. Recorded rather than quietly amended,
    // because "renders nothing" was MY assumption about a component whose own
    // code plainly has two branches, and a test written to a guess about
    // behaviour is how a wrong expectation becomes a frozen requirement.
    const { container } = renderAt(kuwait('2026-09-03T17:00:00'));
    expect(container.textContent).toContain('Next happy hour');
    expect(container.textContent).not.toContain('Happy hour ·');
  });
});

// ------------------------------------------------ the live state is amber --

/**
 * THE AMBER, MEASURED AT THE NODE.
 *
 * The live banner used to be the brand ramp — `brandTint` ground, `brandDeeper`
 * title, `brandDeep` pill — on a screen where everything else is already the
 * brand ramp, so the one time-boxed state on it read as another card. It is the
 * amber group now, and this is what holds it there.
 *
 * WHY IT READS COMPUTED STYLE RATHER THAN THE STYLESHEET. A spec that asserted
 * `styles.bannerLive.backgroundColor === color.happyHourBg` would restate the
 * source file two lines away and pass whether or not the value reaches the
 * screen — the same emptiness as a spec that re-states the token file, which is
 * what this lane spent the morning removing. Everything below renders the
 * component and reads `getComputedStyle` off the element that actually carries
 * the colour, in the shape of `glyphFaceRender.test.tsx`.
 *
 * AND IT ASSERTS THE ABSENCE AS WELL AS THE PRESENCE. Naming the amber alone
 * would not go red if someone reintroduced a brand fill alongside it, so each
 * node is also asserted not to be the brand value it used to hold. Reverting the
 * ground to `brandTint`, the title to `brandDeeper` or the pill to `brandDeep`
 * fails here twice over.
 *
 * BOTH LANGUAGES. The component renders in Arabic too, and colour is not a
 * translation concern — which is exactly why it is worth pinning: an RTL branch
 * that forked the styles would be invisible to an English-only spec.
 *
 * The palette is read from `@avo/tokens` rather than from `../theme` on purpose.
 * The happy-hour group is not white-labelled, so the two agree today; reading
 * the package means this spec is about the token the design settled on, not
 * about whatever a tenant's hex left on the themed palette.
 */

/** `getComputedStyle` normalises to `rgb(r, g, b)`; tokens are hex. */
function rgbOf(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * The banner's four text leaves, in DOM order: title, sub, pill countdown,
 * clock. Order is the JSX's, not the visual one — react-native-web mirrors RTL
 * with `flexDirection`/`dir` and does not reorder the DOM, so the same indices
 * hold in Arabic. Asserted below rather than assumed.
 */
function textLeaves(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('*')).filter(
    (n) => n.children.length === 0 && (n.textContent ?? '').trim() !== '',
  ) as HTMLElement[];
}

/**
 * Throws rather than returning `undefined`, so a banner that stopped rendering
 * one of its four leaves fails HERE with the count in the message instead of
 * further down as a confusing colour mismatch against a missing node.
 */
function leafAt(root: HTMLElement, index: number, what: string): HTMLElement {
  const leaves = textLeaves(root);
  const el = leaves[index];
  if (!el) throw new Error(`no ${what} at leaf ${index}: found ${leaves.length} text leaves`);
  return el;
}

function liveBanner(lang: 'en' | 'ar') {
  cleanup();
  const { container } = renderAt(kuwait('2026-08-30T17:00:00'), lang);
  const root = container.firstElementChild as HTMLElement;
  // The dot is the only 8×8 box in the tree — `PulseDot size={8}`.
  const dot = root.querySelector('[style*="width: 8px"]') as HTMLElement;
  return {
    root,
    dot,
    title: leafAt(root, 0, 'title'),
    pillText: leafAt(root, 2, 'countdown pill text'),
    leafCount: textLeaves(root).length,
  };
}

describe.each(['en', 'ar'] as const)('the live banner is amber — %s', (lang) => {
  it('grounds on happyHourBg, never on the brand tint', () => {
    const { root } = liveBanner(lang);
    const bg = getComputedStyle(root).backgroundColor;
    expect(bg).toBe(rgbOf(color.happyHourBg));
    expect(bg).not.toBe(rgbOf(color.brandTint));
  });

  /**
   * The hairline is derived from `happyHourAccent` at the design's 28%, not the
   * hand-sampled `rgba(110,127,108,0.28)` it used to be — an alpha of a brand
   * value that no longer exists. Read here as the composited rgba the node
   * carries, so a re-typed literal of the old colour cannot pass.
   */
  it('draws its hairline from the amber at the design’s 28%', () => {
    const { root } = liveBanner(lang);
    const { r, g, b } = hexToRgb(color.happyHourAccent);
    expect(getComputedStyle(root).borderColor).toBe(`rgba(${r}, ${g}, ${b}, 0.28)`);
  });

  it('titles in happyHourText, never in brandDeeper', () => {
    const { title } = liveBanner(lang);
    const c = getComputedStyle(title).color;
    expect(c).toBe(rgbOf(color.happyHourText));
    expect(c).not.toBe(rgbOf(color.brandDeeper));
  });

  it('fills the countdown pill with happyHourAccent, never with brandDeep', () => {
    const { pillText } = liveBanner(lang);
    const pill = pillText.parentElement as HTMLElement;
    const bg = getComputedStyle(pill).backgroundColor;
    expect(bg).toBe(rgbOf(color.happyHourAccent));
    expect(bg).not.toBe(rgbOf(color.brandDeep));
  });

  /**
   * #9 is untouched by the move — after it the live banner does not use the
   * brand family at all — but white on a filled pill is still the pairing the
   * rule is about, so it is checked on the amber the same way.
   */
  it('puts white on that pill, and the pairing clears AA', () => {
    const { pillText } = liveBanner(lang);
    expect(getComputedStyle(pillText).color).toBe(rgbOf(color.white));
    expect(contrastRatio(color.white, color.happyHourAccent)).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });

  /**
   * The pulsing dot too. It is a non-text graphic, so the floor is WCAG 1.4.11's
   * 3:1 against the ground it sits on rather than 4.5:1. A brand-green dot in an
   * amber card was the one element that would still have argued happy hour is
   * just more house colour.
   */
  it('pulses in amber, not in brand green, and clears the 3:1 non-text floor', () => {
    const { dot } = liveBanner(lang);
    const bg = getComputedStyle(dot).backgroundColor;
    expect(bg).toBe(rgbOf(color.happyHourAccent));
    expect(bg).not.toBe(rgbOf(color.brand));
    expect(contrastRatio(color.happyHourAccent, color.happyHourBg)).toBeGreaterThanOrEqual(3);
  });

  /** The index assumption the helper rests on, stated rather than trusted. */
  it('renders its four text leaves in the same DOM order in both languages', () => {
    expect(liveBanner(lang).leafCount).toBe(4);
  });
});

/**
 * AND THE NEXT STATE IS DELIBERATELY UNCHANGED.
 *
 * It is the quiet "coming later" rendering — nothing is happening yet, so it has
 * nothing to announce and spending the amber on it would cost the live state its
 * contrast with the rest of the screen. It reads on `surface`, and this is what
 * says that was a decision rather than an omission: colouring it amber to match
 * fails here.
 */
describe.each(['en', 'ar'] as const)('the next-up banner stays quiet — %s', (lang) => {
  it('grounds on surface with an ink title, and takes no amber', () => {
    cleanup();
    // Thursday: HH-01 runs Sun/Mon/Tue, so this is the look-ahead branch.
    const { container } = renderAt(kuwait('2026-09-03T17:00:00'), lang);
    const root = container.firstElementChild as HTMLElement;
    const title = leafAt(root, 0, 'title');

    expect(getComputedStyle(root).backgroundColor).toBe(rgbOf(color.surface));
    expect(getComputedStyle(root).backgroundColor).not.toBe(rgbOf(color.happyHourBg));
    expect(getComputedStyle(title).color).toBe(rgbOf(color.ink));
  });
});
