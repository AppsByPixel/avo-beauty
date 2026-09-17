// @vitest-environment jsdom

/**
 * THE WIRING HALF OF THE LANGUAGE-LESS-`text()` RULE.
 *
 * `theme/typeFidelity.test.ts` § "no site that draws copy pins the script at
 * authoring time" reads every `text()` call in the app and is the exhaustive
 * check — deliberately source-level, because React Native has no DOM to scan and
 * a per-screen render assertion would be one rule restated sixty times.
 *
 * What a source scan cannot say is whether the language it sees passed actually
 * ARRIVES. `text('bodyL', lang, '600')` reads correctly with a `lang` that is
 * always `undefined`; `useLanguage()` could be destructured wrongly, the
 * provider could hand back a default, a memo could freeze the first value. Those
 * are one bug each and they are all invisible to a scanner.
 *
 * So this is ONE test, not one per button: the shared control resolved through a
 * real provider in both languages. Every other button in the app is the same
 * component.
 *
 * THE DEFECT IT WOULD HAVE CAUGHT. `Buttons` took no `lang` and never read
 * `useLanguage()`, so both labels resolved `Inter_600SemiBold` in Arabic —
 * a face whose cmap contains exactly one codepoint in any Arabic range (U+FEFF).
 * The browser substituted the OS default Arabic face silently, which is why it
 * survived: it looked like type, just not the design's.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PrimaryButton, SecondaryButton } from './Buttons';
import { LanguageProvider } from '../i18n/language';

afterEach(cleanup);

/** The real Arabic label of the wallet's most-tapped button — copy/ar.ts. */
const AR_LABEL = 'العودة للرئيسية';
const EN_LABEL = 'View on home';

function fontOf(label: string, lang: 'en' | 'ar', Button: typeof PrimaryButton) {
  // Torn down between renders, because the interesting comparison below is the
  // SAME label under two providers and `getByText` would otherwise find both.
  cleanup();
  const { getByText } = render(
    <LanguageProvider initial={lang}>
      <Button label={label} onPress={() => {}} />
    </LanguageProvider>,
  );
  return getComputedStyle(getByText(label)).fontFamily.replace(/"/g, '');
}

describe('a button label is set in the reading language', () => {
  it.each([
    ['PrimaryButton', PrimaryButton],
    ['SecondaryButton', SecondaryButton],
  ] as const)('%s: Arabic asks for the Arabic SemiBold face, not Inter', (_name, Button) => {
    expect(fontOf(AR_LABEL, 'ar', Button)).toBe('IBMPlexSansArabic_600SemiBold');
    expect(fontOf(EN_LABEL, 'en', Button)).toBe('Inter_600SemiBold');
  });

  /**
   * AND THE PROVIDER IS THE SOURCE, not a default baked into the component. If
   * `useLanguage()` were dropped for a constant, the assertion above would still
   * pass in whichever language that constant named. Switching the provider and
   * requiring the face to move is what rules that out.
   */
  it('follows the provider rather than a value fixed in the component', () => {
    const inArabic = fontOf(EN_LABEL, 'ar', PrimaryButton);
    const inEnglish = fontOf(EN_LABEL, 'en', PrimaryButton);
    expect(inArabic).not.toBe(inEnglish);
  });
});
