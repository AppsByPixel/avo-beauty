// @vitest-environment jsdom

/**
 * "CONTACT US" READS AS A CONTROL — item 5 of the 2026-09-28 punch list.
 *
 * Aftab: "contact us button — make it clearer that it's clickable." The row had
 * lost both of the design's cues (design:445-452): the brand-tinted icon tile
 * and the chevron. It rendered two lines of text beside a WhatsApp row that is
 * also plain text and is not a control. `ContactRow` restores the design's own
 * drawing; this file pins what a customer — sighted or on VoiceOver — gets.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE "CONTACT US" IS REACHED FROM, MEASURED RATHER THAN ASSUMED.
 *
 * The brief named three screens. `contactCta` is rendered in exactly ONE place,
 * Account's Help card. Home and Shop reach the same Contact sheet through a
 * different, design-drawn control: the receipt's "Report a problem with this
 * payment" (design:934, a bordered button), rendered by the ONE
 * `TransactionSheet` both screens mount, which records the reference and routes
 * to Account where the sheet opens pre-filled. So there are two controls, not
 * three, and both are pinned here as actionable:
 *
 *   · Account   → `ContactRow`: role, name, hint, chevron, and the mirror.
 *   · Home/Shop → `TransactionSheet`'s `tx-report`: role and name, in both
 *                 languages, and that pressing it hands off to Contact us.
 *
 * The receipt button is NOT given a chevron. It is a bordered button in the
 * design, already unambiguous, and not what the client named; restyling it
 * would be a change nobody asked for.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `react-native-svg` IS STUBBED — it cannot load here (see vitest.config.ts) —
 * but NOT to nothing, as other render suites do: the stub renders the `Svg`
 * root as a span carrying its testID and its flattened `transform`, because
 * the chevron's mirror is a claim this file makes and a stub that drew nothing
 * could not be wrong about it. Everything else about the glyph (its path, its
 * opacity) is the component's, unstubbed in the real build.
 */

import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language, Transaction } from '@avo/types';

vi.mock('react-native-svg', async () => {
  const React = await import('react');
  const { StyleSheet } = await import('react-native');
  const Svg = ({
    testID,
    style,
    children,
  }: {
    testID?: string;
    style?: unknown;
    children?: React.ReactNode;
  }) => {
    const flat = (StyleSheet.flatten(style as never) ?? {}) as { transform?: unknown };
    return React.createElement(
      'span',
      { 'data-testid': testID, 'data-svg': '', 'data-transform': JSON.stringify(flat.transform ?? null) },
      children,
    );
  };
  const nothing = () => null;
  return { default: Svg, Svg, Path: nothing, Circle: nothing, Rect: nothing, G: nothing };
});

/* eslint-disable import/first */
import { ContactRow } from './Rows';
import { TransactionSheet } from '../TransactionSheet';
import { LanguageProvider } from '../../i18n/language';
import { takeContactPrefill } from '../../support/contact';
import { en } from '../../copy/en';
import { ar } from '../../copy/ar';

afterEach(cleanup);

const LANGS: Array<[Language, typeof en]> = [
  ['en', en],
  ['ar', ar],
];

const drawRow = (lang: Language, onPress = vi.fn()) => {
  render(
    <LanguageProvider initial={lang}>
      <ContactRow onPress={onPress} testID="contact-open" />
    </LanguageProvider>,
  );
  return onPress;
};

describe('Account → Contact us is announced as a control', () => {
  it.each(LANGS)('%s: role button, named by its title, with the sub-line as its hint', (lang, copy) => {
    drawRow(lang);
    const row = screen.getByTestId('contact-open');
    expect(row.getAttribute('role')).toBe('button');
    expect(row.getAttribute('aria-label')).toBe(copy.contactCta);
    expect(row.textContent).toContain(copy.contactCta);
    expect(row.textContent).toContain(copy.contactCtaSub);
  });

  it('pressing it opens Contact us', () => {
    const onPress = drawRow('en');
    fireEvent.click(screen.getByTestId('contact-open'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('Account → Contact us carries the tap cue the rest of the screen uses', () => {
  it.each(LANGS)('%s: ends with the chevron, inside the control', (lang) => {
    drawRow(lang);
    const row = screen.getByTestId('contact-open');
    const chevron = screen.getByTestId('contact-open-chevron');
    expect(row.contains(chevron)).toBe(true);
    // The last thing in the row, i.e. at its reading end — the chevron points
    // at where she is going, not at the icon.
    const svgs = row.querySelectorAll('[data-svg]');
    expect(svgs[svgs.length - 1]).toBe(chevron);
  });

  it('draws the design icon tile first, and the chevron is a different glyph from it', () => {
    drawRow('en');
    const svgs = screen.getByTestId('contact-open').querySelectorAll('[data-svg]');
    expect(svgs).toHaveLength(2); // icon tile glyph, then chevron
    expect(svgs[0]!.getAttribute('data-testid')).toBeNull();
  });
});

describe('the chevron mirrors in the Arabic layout — non-negotiable #12', () => {
  it('points at the reading edge in English: no transform', () => {
    drawRow('en');
    expect(screen.getByTestId('contact-open-chevron').getAttribute('data-transform')).toBe('null');
  });

  it('is flipped in Arabic, where the reading edge is the left', () => {
    drawRow('ar');
    expect(JSON.parse(screen.getByTestId('contact-open-chevron').getAttribute('data-transform')!)).toEqual([
      { scaleX: -1 },
    ]);
  });

  it('the Arabic document is laid out right-to-left, so the row itself mirrors too', () => {
    drawRow('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });
});

// ─────────────────────────────── Home and Shop: the receipt's way to Contact us

const TOPUP = {
  id: 'TX-2665307',
  memberId: '8842',
  branchId: 'BR-KWC',
  kind: 'topup',
  amountFils: 11000,
  bonusFils: 1000,
  method: 'knet',
  status: 'settled',
  reference: 'AVO-TOP-FAR19T',
  createdAt: '2026-08-25T21:38:22.862Z',
  voidedAt: null,
  reversedByTransactionId: null,
} as Transaction;

describe('Home and Shop → the receipt hands off to Contact us through a real button', () => {
  it.each(LANGS)('%s: "Report a problem with this payment" is role button and named', (lang, copy) => {
    render(
      <LanguageProvider initial={lang}>
        <TransactionSheet
          transaction={TOPUP}
          branches={[{ id: 'BR-KWC', name: 'Kuwait City' }]}
          onClose={vi.fn()}
          onReport={vi.fn()}
        />
      </LanguageProvider>,
    );
    const report = screen.getByTestId('tx-report');
    expect(report.getAttribute('role')).toBe('button');
    expect(report.getAttribute('aria-label')).toBe(copy.txReport);
  });

  it('pressing it records the reference for Contact us and navigates', () => {
    const onReport = vi.fn();
    render(
      <LanguageProvider initial="en">
        <TransactionSheet
          transaction={TOPUP}
          branches={[{ id: 'BR-KWC', name: 'Kuwait City' }]}
          onClose={vi.fn()}
          onReport={onReport}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByTestId('tx-report'));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(takeContactPrefill()).toEqual({ reference: 'AVO-TOP-FAR19T' });
  });
});

/**
 * SOURCE ASSERTIONS, LABELLED AS SUCH. `AccountScreen`, `HomeScreen` and
 * `ShopScreen` are not mounted here — each pulls a data hook per section — so
 * what is left to check is that the screens are joined to the controls proved
 * above, and that the old text-only row cannot come back beside the new one.
 */
describe('the screens use these controls', () => {
  const WALLET = path.resolve(__dirname, '..', '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(WALLET, rel), 'utf8');

  it('Account renders ContactRow for Contact us, and nothing else names contactCta', () => {
    const src = read('src/screens/AccountScreen.tsx');
    expect(src).toMatch(/<ContactRow onPress=\{openContact\}/);
    expect(src).not.toContain('copy.contactCta');
  });

  it('Home and Shop both hand the receipt a route to Account', () => {
    expect(read('src/screens/HomeScreen.tsx')).toMatch(/<TransactionSheet[\s\S]*?onReport=\{onOpenAccount\}/);
    expect(read('src/screens/ShopScreen.tsx')).toMatch(/<TransactionSheet[\s\S]*?onReport=\{onReport\}/);
  });
});
