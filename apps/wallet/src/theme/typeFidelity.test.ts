/**
 * TYPE FIDELITY — does the weight a style asks for reach a face that can draw it?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A WEIGHT CAN BE DECLARED AND STILL NOT HAPPEN
 * ─────────────────────────────────────────────────────────────────────────────
 * `text()` pins `fontFamily` to ONE single-weight face — `Inter_400Regular`,
 * `Inter_600SemiBold`, and so on — because React Native resolves a numeric
 * weight to a face only if that face is registered, and the Google Fonts
 * packages register one family name per weight. That is the right design and
 * `theme/index.ts` explains it at length.
 *
 * Its consequence is the thing this file exists for. A later object in the same
 * style array that raises `fontWeight` does not move the family, so the style
 * ends up asking for a weight the named face cannot supply:
 *
 *     StyleSheet.flatten([text('bodyS', 'en'), { fontWeight: '600' }])
 *       // { fontSize: 12.5, fontWeight: '600', fontFamily: 'Inter_400Regular' }
 *
 * Nothing fails. Nothing warns. `Inter_600SemiBold` is loaded in App.tsx and is
 * demonstrably reachable — `text('label')` selects it — and this style simply
 * never asks for it.
 *
 * IN ARABIC IT IS NON-NEGOTIABLE #12, NOT A COSMETIC MISS. The same composition
 * resolves to `IBMPlexSansArabic_400Regular` while `IBMPlexSansArabic_600SemiBold`
 * sits loaded and unused. An emphasis the design specifies disappears in the
 * language the build agreement calls "a first-class layout, not a translation
 * pass". The face is there; the code does not ask for it.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not claim these sites render at exactly
 * 400 on every platform — a browser will synthesise a faux bold, and the native
 * platforms differ. It claims the narrower and fully checkable thing: the real
 * SemiBold/Bold face this app loads is never selected at these sites, so what is
 * drawn is not the design's type either way.
 *
 * THE METHOD IS `contrast.test.ts`'s, AND FOR THE SAME REASON. React Native has
 * no DOM to scan, so the honest check is the source, read exhaustively, with the
 * resolution maths applied rather than eyeballed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE, MEASURED 2026-09-15 AGAINST THE DESIGN BUNDLE
 *
 * The design's weight vocabulary, counted across all six `design/*.dc.html`:
 * 556 × 600, 193 × 500, 11 × 700, 2 × 400 — and `design/tokens/avo-tokens.json`
 * carries no 700 in the type scale at all. All eleven 700s are badges, pills and
 * tags. So a build 700 is correct on a badge and wrong on a sentence.
 *
 * The count above is of EXPLICIT `font-weight:` declarations only. The bundle
 * also carries 34 `<b>` elements with no `b {}` rule anywhere, which compute to
 * 700 in a browser — measured, not assumed. Seventeen of those are the
 * developer-addressed banner at the top of each file and are not product copy;
 * of the rest, exactly two are product copy inside this lane's column
 * (AVO Staff Scanner.dc.html:354 and :364), and `apps/scanner` already draws
 * both at `ui(12.5, '700')` — `Inter_700Bold`, the right face, matching.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { StyleSheet } from 'react-native';
import { text } from './index';

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    return [p];
  });
}

/** `styleName -> { weight, namesAFace }` for every `StyleSheet` entry in a file. */
function weightStyles(src: string): Map<string, { weight: string; namesAFace: boolean }> {
  const out = new Map<string, { weight: string; namesAFace: boolean }>();
  for (const line of src.split('\n')) {
    const m = /(\w+): *\{([^}]*fontWeight: *'(\d+)'[^}]*)\}/.exec(line);
    if (m) out.set(m[1]!, { weight: m[3]!, namesAFace: m[2]!.includes('fontFamily') });
  }
  return out;
}

/**
 * Every `styles.X` composed after a `text()` / `display()` / `ui()` base, where
 * `X` raises `fontWeight` without naming a face. Keyed `path#styleName`, so a
 * style used from three call sites counts once — the defect is in the style.
 */
function inertOverrides(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    const styles = weightStyles(src);
    if (styles.size === 0) continue;
    const rel = path.relative(SRC, file);
    for (const line of src.split('\n')) {
      for (const comp of line.matchAll(/\[\s*(?:text|display|ui)\([^)]*\)\s*,([^\]]*)\]/g)) {
        for (const ref of comp[1]!.matchAll(/styles\.(\w+)/g)) {
          const s = styles.get(ref[1]!);
          if (s && !s.namesAFace) found.add(`${rel}#${ref[1]}`);
        }
      }
    }
  }
  return found;
}

/**
 * THE STANDING DEBT, FROZEN.
 *
 * Eighty-three styles raise a weight that never reaches a face. Every one of
 * them declares the weight the design declares — the SOURCE agrees with the
 * design bundle — so this is a rendering-layer defect, not a fidelity mismatch,
 * and its fix is one mechanical refactor: move the weight onto `text()`'s third
 * argument and drop `fontWeight` from the `StyleSheet` object. It cannot be
 * fixed by putting `fontFamily` in the style object instead, because the correct
 * face depends on `lang` and a `StyleSheet.create` object does not know the
 * language.
 *
 * Reported to trunk 2026-09-15 as its own slice. This list is the work order.
 *
 * The assertion is an equality, not a ceiling: adding one fails, and so does
 * fixing one without striking it off here. A ratchet that only counts up is a
 * ratchet nobody updates.
 */
const KNOWN_INERT = [
  'components/ActivityFeed.tsx#emptyActionText',
  'components/ActivityFeed.tsx#moreText',
  'components/ActivityFeed.tsx#rowTitle',
  'components/Banners.tsx#staleActionText',
  'components/BranchEarning.tsx#badgeText',
  'components/BranchEarning.tsx#chipName',
  'components/Buttons.tsx#primaryText',
  'components/Buttons.tsx#secondaryText',
  'components/CartSheet.tsx#lineName',
  'components/CartSheet.tsx#stepQty',
  'components/FailureScreen.tsx#buttonText',
  'components/FulfilmentSection.tsx#actionDanger',
  'components/FulfilmentSection.tsx#actionText',
  'components/FulfilmentSection.tsx#addText',
  'components/FulfilmentSection.tsx#emptyTitle',
  'components/FulfilmentSection.tsx#titleOff',
  'components/FulfilmentSection.tsx#titleOn',
  'components/HappyHourBanner.tsx#clock',
  'components/HappyHourBanner.tsx#pillLiveText',
  'components/HappyHourBanner.tsx#pillNextText',
  'components/HappyHourBanner.tsx#titleLive',
  'components/HappyHourBanner.tsx#titleNext',
  'components/LanguageToggle.tsx#label',
  'components/LanguageToggle.tsx#restart',
  'components/MembershipSection.tsx#currentPillText',
  'components/MembershipSection.tsx#stampCount',
  'components/OrdersSheet.tsx#snapshotName',
  'components/OrdersSheet.tsx#statusTextDone',
  'components/OrdersSheet.tsx#statusTextOpen',
  'components/PaymentCode.tsx#panelHint',
  'components/PaymentCode.tsx#unavailableTitle',
  'components/QrOverlay.tsx#doneText',
  'components/QrOverlay.tsx#logoInitial',
  'components/TopUpCard.tsx#badgeText',
  'components/TopUpCard.tsx#ctaText',
  'components/TopUpCard.tsx#getLabel',
  'components/TopUpSheet.tsx#methodName',
  'components/TopUpSheet.tsx#noteText',
  'components/UpcomingCard.tsx#actionDangerText',
  'components/UpcomingCard.tsx#actionText',
  'components/UpcomingCard.tsx#depositPillText',
  'components/UpcomingCard.tsx#refusalTitle',
  'components/WalletCard.tsx#pillText',
  'components/WalletCard.tsx#unit',
  'components/account/ChangePasswordSheet.tsx#forgotText',
  'components/account/ChangePasswordSheet.tsx#showText',
  'components/account/ContactSheet.tsx#routeChipText',
  'components/account/ContactSheet.tsx#segmentText',
  'components/account/ContactSheet.tsx#segmentTextOn',
  'components/account/DeleteAccountSheet.tsx#confirmText',
  'components/account/DeleteAccountSheet.tsx#keepText',
  'components/account/DeletionScheduled.tsx#actionText',
  'components/account/DeletionScheduled.tsx#title',
  'components/account/EditProfileSheet.tsx#linkMuted',
  'components/account/EditProfileSheet.tsx#linkText',
  'components/account/FollowSalon.tsx#label',
  'components/account/RedeemVoucherSheet.tsx#balanceValue',
  'components/booking/BookingParts.tsx#branchName',
  'components/booking/BookingParts.tsx#branchNameOn',
  'components/booking/BookingParts.tsx#depositLabel',
  'components/booking/BookingParts.tsx#optionName',
  'components/booking/BookingParts.tsx#reviewValue',
  'screens/AccountScreen.tsx#backText',
  'screens/AccountScreen.tsx#deleteText',
  'screens/AccountScreen.tsx#deleteUnknownRetryText',
  'screens/AccountScreen.tsx#editText',
  'screens/AccountScreen.tsx#helpTitle',
  'screens/AccountScreen.tsx#notifRetryText',
  'screens/BookScreen.tsx#backText',
  'screens/BookScreen.tsx#confirmFailureTitle',
  'screens/BookScreen.tsx#stepCount',
  'screens/ForgotPasswordScreen.tsx#footerLinkText',
  'screens/HomeScreen.tsx#offlineRetryText',
  'screens/ShopScreen.tsx#addText',
  'screens/ShopScreen.tsx#badgeText',
  'screens/ShopScreen.tsx#ordersText',
  'screens/ShopScreen.tsx#rowName',
  'screens/ShopScreen.tsx#rowPrice',
  'screens/ShopScreen.tsx#stepQty',
  'screens/SignInScreen.tsx#footerLinkText',
  'screens/SignInScreen.tsx#forgotText',
  'screens/SignUpScreen.tsx#footerLinkText',
  'screens/SignUpScreen.tsx#linkText',
];

/** The weight a face name encodes, e.g. `Inter_600SemiBold` -> `600`. */
function weightOfFace(family: string | undefined): string | undefined {
  return /_(\d{3})/.exec(family ?? '')?.[1];
}

describe("text()'s weight override resolves a real face", () => {
  it('selects the SemiBold face in both languages, not the Regular one', () => {
    expect(text('bodyS', 'en', '600').fontFamily).toBe('Inter_600SemiBold');
    // Non-negotiable #12. The face is loaded in App.tsx; before the override
    // existed, nothing in this app could ask for it outside the `label` token.
    expect(text('bodyS', 'ar', '600').fontFamily).toBe('IBMPlexSansArabic_600SemiBold');
  });

  it('leaves the token weight alone when no override is passed', () => {
    expect(text('bodyS', 'en').fontFamily).toBe('Inter_400Regular');
    expect(text('bodyS', 'en').fontWeight).toBe('400');
    expect(text('label', 'ar').fontFamily).toBe('IBMPlexSansArabic_600SemiBold');
  });

  it('keeps the Arabic rules it already had — no tracking, no uppercase', () => {
    const ar = text('label', 'ar', '700');
    expect(ar.fontFamily).toBe('IBMPlexSansArabic_700Bold');
    expect(ar.letterSpacing).toBeUndefined();
    expect(ar.textTransform).toBeUndefined();
  });

  it('never silently returns a face of a different weight than the one asked for', () => {
    // `face()` falls back to 400 when a family has no face at the requested
    // weight — Fraunces stops at 600 — so an override that cannot be honoured
    // would flatten silently. Every (token, weight) pair used below is checked
    // rather than trusted.
    for (const lang of ['en', 'ar'] as const) {
      for (const weight of ['400', '500', '600', '700'] as const) {
        const f = text('bodyS', lang, weight).fontFamily;
        expect(weightOfFace(f), `bodyS/${lang}/${weight} -> ${f}`).toBe(weight);
      }
    }
  });
});

describe('the retry chips draw the weight the design draws', () => {
  // design/AVO States.dc.html:103, :137 and :224 — every "Try again" and
  // "Retry" in the bundle is font-weight:600. There is no 700 on a text action
  // anywhere in the design. Both chips previously declared 700 AND resolved to
  // Inter_400Regular, so they disagreed with the design twice over.
  it.each(['en', 'ar'] as const)('%s: the retry label resolves to a 600 face', (lang) => {
    const flat = StyleSheet.flatten([
      text('bodyS', lang, '600'),
      { color: '#8f5a56', textDecorationLine: 'underline' as const },
    ]);
    expect(flat.fontWeight).toBe('600');
    expect(weightOfFace(flat.fontFamily)).toBe('600');
  });

  it.each([
    'components/OrdersSheet.tsx',
    'components/FulfilmentSection.tsx',
  ])('%s no longer declares 700 on chipRetryText', (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    expect(src).toMatch(/chipRetryText: \{[^}]*\}/);
    expect(weightStyles(src).has('chipRetryText')).toBe(false);
    expect(src).toContain("text('bodyS', lang, '600'), styles.chipRetryText");
  });
});

describe('the standing inert-override debt', () => {
  it('is exactly the recorded set — nothing added, nothing quietly fixed', () => {
    expect([...inertOverrides()].sort()).toEqual([...KNOWN_INERT].sort());
  });

  it('records the two this slice removed', () => {
    const found = inertOverrides();
    expect(found.has('components/OrdersSheet.tsx#chipRetryText')).toBe(false);
    expect(found.has('components/FulfilmentSection.tsx#chipRetryText')).toBe(false);
  });
});
