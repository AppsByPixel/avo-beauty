// @vitest-environment jsdom

/**
 * THE BALANCE FIGURE'S LINE BOX, MEASURED AT THE NODE AND AGAINST THE REAL FONT.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT WAS WRONG
 * ─────────────────────────────────────────────────────────────────────────────
 * `WalletCard` drew the balance with `text('displayXL')` — `fontSize 52`,
 * `lineHeight 47`, a ratio of 0.900. Fraunces' natural line box is 1.233 em, so
 * 52pt needs 65px and was handed 47px: the box was 17px shorter than the face,
 * and React Native cut the top off the number. Measured on a device screenshot
 * at 3×, the topmost pixel row of the figure carried 105 white pixels — a long
 * flat run across several digits, where an intact apex starts with a handful of
 * pixels and grows.
 *
 * The token is NOT the defect and is not touched. In CSS a `line-height` below
 * the content height does not clip — the glyphs overflow the box — which is what
 * the designer saw in the browser mock, so 0.9 is a faithful reading of the
 * design and remains correct for the web surfaces reading the same token.
 * React Native clips instead. That is a platform difference, handled the way
 * CLAUDE.md § "Do not restyle" directs: follow the platform and note it.
 * `packages/tokens` is trunk-owned in any case.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SPEC READS THE TTF INSTEAD OF ASSERTING 1.233
 *
 * `fix(mobile): a spec that restates the token file cannot notice the token file
 * changing` (e348d47) removed two specs that had copied values out of the token
 * package and asserted them back; both went red for the wrong reason when the
 * ramp moved, and one had gone quietly false. The same trap is open here in a
 * nastier form: `theme/index.ts` carries Fraunces' vertical metrics as four
 * numbers, and a bump of `@expo-google-fonts/fraunces` could move the face and
 * leave those numbers behind with nothing complaining.
 *
 * So the metrics are re-read from the `.ttf` THE APP ACTUALLY REGISTERS, out of
 * its `head` and `hhea` tables, and compared. The constant cannot go stale
 * silently: if the shipped face changes, this goes red and names the number.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AND WHY IT READS COMPUTED STYLE RATHER THAN THE STYLESHEET
 *
 * In the shape of `happyHourBannerRender.test.tsx`. A spec asserting
 * `styles.balanceRow.marginTop === 3` would restate the source two lines away
 * and pass whether or not anything reaches the screen. Everything below renders
 * the card and reads `getComputedStyle` off the node that actually carries the
 * box.
 *
 * The general form of this rule — no text style may declare a box smaller than
 * its own font size — lives in `theme/typeFidelity.test.ts`, over every token in
 * both languages. This file is the face-aware half: the general rule's floor of
 * 1.0 em is what no face can survive, while 1.233 em is what THIS face needs,
 * and only the node that pins the face can be held to it.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { WalletCard } from './WalletCard';
import { LanguageProvider } from '../i18n/language';
import { FRAUNCES_LINE_EM, FRAUNCES_METRICS, frauncesLineHeight, text } from '../theme';

afterEach(cleanup);

// ------------------------------------------------------ the shipped face --

/**
 * The four Fraunces faces `App.tsx` registers. The figure draws in the 600 —
 * `Money` sets `fontFamily: moneyFigureFace()`, which defaults to SemiBold —
 * while the `displayXL` token names the 500, so BOTH have to be measured or the
 * spec would be checking a face the balance never uses.
 */
const REGISTERED_FACES = [
  '400Regular/Fraunces_400Regular',
  '400Regular_Italic/Fraunces_400Regular_Italic',
  '500Medium/Fraunces_500Medium',
  '600SemiBold/Fraunces_600SemiBold',
];

interface FaceMetrics {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
}

/**
 * `head.unitsPerEm` and the `hhea` vertical metrics, read straight out of the
 * font's table directory. No font library: the offsets are fixed by the
 * OpenType spec and a dependency here would be a second thing to keep true.
 */
function readFaceMetrics(spec: string): FaceMetrics {
  const require_ = createRequire(import.meta.url);
  const file = require_.resolve(`@expo-google-fonts/fraunces/${spec}.ttf`);
  const b = fs.readFileSync(file);

  const tables: Record<string, number> = {};
  const numTables = b.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables[b.toString('ascii', rec, rec + 4)] = b.readUInt32BE(rec + 8);
  }

  const head = tables['head'];
  const hhea = tables['hhea'];
  if (head === undefined || hhea === undefined) throw new Error(`${spec}: no head/hhea table`);

  return {
    unitsPerEm: b.readUInt16BE(head + 18),
    ascent: b.readInt16BE(hhea + 4),
    descent: b.readInt16BE(hhea + 6),
    lineGap: b.readInt16BE(hhea + 8),
  };
}

/** The natural line box, in ems, the way every renderer in this stack computes it. */
function naturalLineEm(m: FaceMetrics): number {
  return (m.ascent - m.descent + m.lineGap) / m.unitsPerEm;
}

describe('the Fraunces metric in theme/index.ts is the shipped font’s', () => {
  it.each(REGISTERED_FACES)('%s carries the metrics the theme records', (spec) => {
    expect(readFaceMetrics(spec)).toEqual(FRAUNCES_METRICS);
  });

  /**
   * The constant stands for the FAMILY, which is only legitimate because every
   * registered weight agrees. If a future package split them, one constant
   * could not be right for both the 500 the token names and the 600 the figure
   * draws in — so that assumption is checked rather than trusted.
   */
  it('is one metric for the whole family, not a per-weight accident', () => {
    const distinct = new Set(REGISTERED_FACES.map((s) => JSON.stringify(readFaceMetrics(s))));
    expect(distinct.size).toBe(1);
  });

  it('derives FRAUNCES_LINE_EM from those metrics rather than restating a ratio', () => {
    expect(FRAUNCES_LINE_EM).toBeCloseTo(naturalLineEm(readFaceMetrics('500Medium/Fraunces_500Medium')), 10);
  });

  /**
   * `ceil`, not `round`. At 52 the exact box is 64.116px; rounding gives 64,
   * which is still short and still clips, just by a tenth of a pixel.
   */
  it('rounds the fitted box UP, so the guarantee holds at every size', () => {
    for (const size of [12, 19, 22, 23, 30, 52]) {
      expect(frauncesLineHeight(size)).toBeGreaterThanOrEqual(size * FRAUNCES_LINE_EM);
    }
    expect(frauncesLineHeight(52)).toBe(Math.ceil(52 * FRAUNCES_LINE_EM));
  });
});

// ------------------------------------------------------------ the figure --

/**
 * The card's text leaves in DOM order: balance label, tier pill, figure, unit.
 * react-native-web mirrors RTL with `flexDirection`/`dir` and does not reorder
 * the DOM, so the indices hold in Arabic — asserted below rather than assumed.
 */
function leaves(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll('*')).filter(
    (n) => n.children.length === 0 && (n.textContent ?? '').trim() !== '',
  ) as HTMLElement[];
}

function card(lang: 'en' | 'ar') {
  cleanup();
  const { container } = render(
    <LanguageProvider initial={lang}>
      <WalletCard balanceFils={24500} pill="Gold" progress={null} lastUpdated={null} />
    </LanguageProvider>,
  );
  const all = leaves(container.firstElementChild as HTMLElement);
  const figure = all[2];
  const unit = all[3];
  if (!figure || !unit) throw new Error(`expected 4 text leaves, found ${all.length}`);
  // figure → the Money row → the balanceRow View that carries the margins.
  const row = figure.parentElement?.parentElement as HTMLElement;
  return { all, figure, unit, row };
}

const px = (v: string) => Number.parseFloat(v);

describe.each(['en', 'ar'] as const)('the balance figure is not clipped — %s', (lang) => {
  it('renders four text leaves in the same DOM order', () => {
    expect(card(lang).all).toHaveLength(4);
  });

  /**
   * THE GENERAL FLOOR. A line box below 1.0 em cuts into the glyphs of any real
   * text face, whatever the family — which is why this half of the rule needs no
   * knowledge of Fraunces and holds identically in Arabic. It is the assertion
   * that would have caught the original defect (47 < 52).
   */
  it('gives the figure a box at least as tall as its own font size', () => {
    const cs = getComputedStyle(card(lang).figure);
    expect(px(cs.lineHeight)).toBeGreaterThanOrEqual(px(cs.fontSize));
  });

  /**
   * THE FACE-AWARE FLOOR, which is the one the balance actually needed: 1.0 em
   * would still have left a 52px figure in a 52px box, 12px short of Fraunces.
   * The requirement is computed from the ttf, so it cannot drift from the font.
   */
  it('gives it a box the shipped Fraunces can actually draw in', () => {
    const cs = getComputedStyle(card(lang).figure);
    const needed = px(cs.fontSize) * naturalLineEm(readFaceMetrics('600SemiBold/Fraunces_600SemiBold'));
    expect(px(cs.lineHeight)).toBeGreaterThanOrEqual(needed);
  });

  /**
   * Non-negotiable #12: Western digits in the display face in BOTH languages.
   * The box was raised on the strength of Fraunces' metrics, so a change that
   * quietly moved the figure to another family would invalidate the floor above
   * while leaving it green.
   */
  it('still draws the figure in Fraunces, with Western digits', () => {
    const { figure } = card(lang);
    expect(getComputedStyle(figure).fontFamily.replace(/"/g, '')).toMatch(/^Fraunces_/);
    expect(figure.textContent).toBe('24.500');
  });

  /**
   * THE UNIT IS THE HALF THAT CHANGES SCRIPT, and it sits on the baseline beside
   * a figure whose box just grew by 18px. It keeps its own language's face and
   * its own size — the raise is scoped to the figure node and must not have
   * leaked across the row.
   */
  it('leaves the unit beside it on its own face and size', () => {
    const { unit } = card(lang);
    const cs = getComputedStyle(unit);
    expect(cs.fontFamily.replace(/"/g, '')).toBe(
      lang === 'ar' ? 'IBMPlexSansArabic_500Medium' : 'Inter_500Medium',
    );
    expect(px(cs.fontSize)).toBe(17);
    expect(unit.textContent).toBe(lang === 'ar' ? 'د.ك' : 'KD');
  });

  /**
   * AND THE NUMBER DID NOT MOVE.
   *
   * Growing the box would otherwise push the balance down the card and take
   * everything below it along. The row gives back the added leading as margin —
   * half at the top, half at the bottom, because that is how a line box
   * distributes leading — so the figure's baseline and the row's total height
   * are exactly what they were.
   *
   * Stated as the conservation it is: margins plus box equal the design's 12 and
   * 16 around the token's own 47. Neither side is pinned, so this survives a
   * token change and still says "nothing moved".
   */
  it('gives the added leading back as margin, so the row occupies what it did', () => {
    const { figure, row } = card(lang);
    const cs = getComputedStyle(row);
    const occupied = px(cs.marginTop) + px(getComputedStyle(figure).lineHeight) + px(cs.marginBottom);
    expect(occupied).toBe(12 + (text('displayXL').lineHeight ?? 0) + 16);
  });
});
