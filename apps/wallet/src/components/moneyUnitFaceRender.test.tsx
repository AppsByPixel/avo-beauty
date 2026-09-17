// @vitest-environment jsdom

/**
 * THE WIRING HALF OF THE FACELESS-TEXT RULE, FOR THE ONE NODE IT WAS WRITTEN FOR.
 *
 * `theme/typeFidelity.test.ts` § "every Text that draws copy resolves a face"
 * reads the source and is the exhaustive check — it covers all 317 Text nodes in
 * the column, which no set of render assertions could. What it cannot say is
 * whether the face it sees composed actually ARRIVES: `text('bodyS', lang,
 * unitWeight)` reads correctly with a `lang` that is always undefined, and a
 * `unitStyle` layered over it could carry a `fontFamily` nobody noticed and win.
 *
 * So this is the rendered other half, and it is deliberately about the UNIT
 * rather than the figure. The figure was never in doubt — `Money` has always set
 * `fontFamily: moneyFigureFace()` on it — and it is asserted here anyway,
 * because the change that fixed the unit rewrote the node beside it.
 *
 * WHAT IT WOULD HAVE CAUGHT. `Money` rendered the unit as `[unitStyle, {
 * color }]`, so a caller passing a bare `{ fontSize: 11.5 }` produced a node
 * with NO `font-family` at all. react-native-web's Text base style is
 * `font: '14px System'`, which its compiler rewrites to
 * `-apple-system,BlinkMacSystemFont,…`, so "KD" and "د.ك" both drew in the OS
 * UI font. Three of the four call sites did exactly that. Measured at 11.5px,
 * "د.ك" is 14.24px wide in that stack against 17.78px in
 * IBMPlexSansArabic_500Medium — a different typeface, 20% narrower, on a line
 * box 3.5px shorter, in a row that aligns on the baseline.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fils } from '@avo/types';

import { Money } from './Money';
import { LanguageProvider } from '../i18n/language';

afterEach(cleanup);

/**
 * The unit as each real call site passes it. `WalletCard` sends a weight and the
 * other three do not, which is the whole spread of what `Money` is handed.
 */
const CALLERS = {
  'WalletCard#unit': { unitStyle: { fontSize: 17, opacity: 0.82 }, unitWeight: '500' as const },
  'TopUpCard#payUnit': { unitStyle: { fontSize: 11.5 } },
  'TopUpCard#getUnit': { unitStyle: { fontSize: 11.5 } },
  'DeleteAccountSheet#balanceUnit': { unitStyle: { fontSize: 12 }, unitWeight: '600' as const },
};

/** The two Text nodes `Money` draws, in document order: figure then unit. */
function facesOf(lang: 'en' | 'ar', props: { unitStyle: object; unitWeight?: '500' | '600' }) {
  cleanup();
  const { container } = render(
    <LanguageProvider initial={lang}>
      <Money amount={fils(24500)} color="#1C1B19" figureStyle={{ fontSize: 52 }} {...props} />
    </LanguageProvider>,
  );
  const nodes = Array.from(container.querySelectorAll('div > *'));
  return nodes.map((n) => getComputedStyle(n as HTMLElement).fontFamily.replace(/"/g, ''));
}

describe('the money unit is set in the reading language, at every call site', () => {
  it.each(Object.entries(CALLERS))(
    '%s: Arabic resolves an IBM Plex Sans Arabic face for the unit',
    (_site, props) => {
      const [, unit] = facesOf('ar', props);
      expect(unit).toMatch(/^IBMPlexSansArabic_\d{3}/);
    },
  );

  it.each(Object.entries(CALLERS))('%s: English resolves an Inter face for the unit', (_site, props) => {
    const [, unit] = facesOf('en', props);
    expect(unit).toMatch(/^Inter_\d{3}/);
  });

  it('carries the weight each caller asks for through to a real face', () => {
    expect(facesOf('en', CALLERS['WalletCard#unit'])[1]).toBe('Inter_500Medium');
    expect(facesOf('ar', CALLERS['WalletCard#unit'])[1]).toBe('IBMPlexSansArabic_500Medium');
    // `DeleteAccountSheet` used to carry `fontWeight: '600'` in the style object
    // with no family to apply it to. The weight was real — the OS stack is
    // multi-weight and honoured it — and the FACE was wrong. Both now land.
    expect(facesOf('en', CALLERS['DeleteAccountSheet#balanceUnit'])[1]).toBe('Inter_600SemiBold');
    expect(facesOf('ar', CALLERS['DeleteAccountSheet#balanceUnit'])[1]).toBe(
      'IBMPlexSansArabic_600SemiBold',
    );
    // And the three that pass no weight take the token's own 400 rather than
    // whatever the platform would have picked.
    expect(facesOf('en', CALLERS['TopUpCard#payUnit'])[1]).toBe('Inter_400Regular');
    expect(facesOf('ar', CALLERS['TopUpCard#payUnit'])[1]).toBe('IBMPlexSansArabic_400Regular');
  });

  it('leaves the figure in Fraunces in both languages — non-negotiable #12', () => {
    // The unit is the half that changes script. The figure does not, and the
    // node beside it was rewritten by the same change, so it is asserted here.
    for (const lang of ['en', 'ar'] as const) {
      expect(facesOf(lang, CALLERS['WalletCard#unit'])[0]).toBe('Fraunces_600SemiBold');
    }
  });

  it('emits a font-family at all — the defect was its absence, not its value', () => {
    // The assertions above would all pass if `fontFamily` were merely wrong.
    // This is the one that fails on the shape that actually shipped: a node
    // react-native-web renders with no family, left to the OS UI stack.
    for (const lang of ['en', 'ar'] as const) {
      for (const props of Object.values(CALLERS)) {
        for (const face of facesOf(lang, props)) {
          expect(face, `${lang} ${JSON.stringify(props)}`).not.toBe('');
          expect(face).not.toMatch(/system|-apple-|Segoe|Roboto|Helvetica|Arial|sans-serif/i);
        }
      }
    }
  });
});
