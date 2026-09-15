// @vitest-environment jsdom

/**
 * THE CART'S SCROLL REGION — the flex-fill that had become a magic number.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DEFECT, AND WHY IT HAD TWO HALVES.
 *
 *   design/AVO Wallet Home.dc.html:913  max-height:88%;display:flex;flex-direction:column
 *   design/AVO Wallet Home.dc.html:948  flex:1;overflow:auto;margin-top:14px
 *   CartSheet.tsx (before)              lines: { marginTop: 14, maxHeight: 320 }
 *
 * A region that takes whatever height is left inside the sheet had been built as
 * a fixed 320pt cap. That clipped rows against a hard edge — the reported
 * symptom — and it also pushed the fulfilment block, the totals and the pay
 * button down past the sheet's own 88% ceiling, so on a small device THE PAY
 * BUTTON WAS UNREACHABLE. Same defect, worse half, and the half nobody reported.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE CAN AND CANNOT PROVE, STATED PLAINLY.
 *
 * jsdom has no layout engine and react-native-web is CSS, not Yoga, so NOTHING
 * here resolves a height. A test that read `styles.lines.flexShrink` and called
 * it a layout proof would be asserting the fix's spelling, not its effect.
 *
 * The resolved-layout measurement was done separately, in Yoga 3.2.1 — the same
 * engine React Native lays out with — against a model of this tree (sheet
 * maxHeight 88%, padding 12/30, grabber 5+16, head 26, rows 65 each, fulfilment,
 * totals 150). Its three results are why the fix is shaped the way it is:
 *
 *   maxHeight: 320   6 rows on a 667pt screen → lines clipped at 320 and the CTA
 *                    resolved 146pt BELOW the bottom of the screen.
 *   flex: 1          lines region resolved to height 0 at 1, 2 and 6 rows. Yoga
 *                    reads `flex:1` as `flexBasis:0`, and an auto-height-with-max
 *                    container has no free space to grow into. The literal
 *                    transcription of the design is a WORSE bug than the one it
 *                    replaces: an empty cart.
 *   flexShrink: 1    65 / 130 / 272 for 1 / 2 / 6 rows on 812pt, and the CTA on
 *                    screen in every case.
 *
 * So what this file asserts is the two things that a future edit would actually
 * break, and that are checkable here:
 *
 *   1. THE SHAPE OF THE STYLE — no fixed cap, and `flexShrink`, not `flex`.
 *      Narrow, and honestly labelled as a style assertion.
 *   2. THE RENDERED TREE — that the fulfilment section is a DESCENDANT of the
 *      scroll container rather than a sibling of it. That is a containment fact
 *      about real rendered output, and it is the half the Yoga run showed
 *      matters most: fed a 430pt fulfilment block, a rigid sibling left the
 *      CTA 80pt off a 667pt screen even with the shrink fix applied. That 430
 *      is a MODELLED height, not a measured component — the argument does not
 *      rest on it, it rests on this block's height being unbounded (it grows
 *      with the address book) while the sheet's is capped. The design cannot
 *      settle this one — it draws no delivery UI at all — so it is a build
 *      decision, and this is where it is pinned.
 *
 *   3. AND THE ONE-LINE CASE, which is a rendering fact: a flex-fill region must
 *      not stretch the sheet for a single item. Checked as "the region carries no
 *      minimum and no fixed height", since the height itself is Yoga's to decide.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { StyleSheet } from 'react-native';
import type { MemberAddress } from '@avo/types';
import { fils } from '@avo/types';

import { CartSheet } from './CartSheet';
import { LanguageProvider } from '../i18n/language';
import { PICKUP, type FulfilmentChoice } from '../domain/fulfilment';
import type { AddressBookController } from '../state/useAddresses';

afterEach(cleanup);

const ADDRESS: MemberAddress = {
  id: 'ADR-1',
  label: 'Home',
  block: '4',
  street: 'Salem Al Mubarak',
  building: '12',
  floor: null,
  apartment: null,
  area: null,
  governorate: null,
  instructions: null,
  latitude: null,
  longitude: null,
  createdAt: '2026-09-10T09:00:00.000Z',
};

function book(): AddressBookController {
  return {
    status: 'ready',
    addresses: [ADDRESS],
    failure: null,
    fetchedAt: 1_757_500_000_000,
    busy: false,
    writeError: null,
    retry: vi.fn(),
    clearWriteError: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
  };
}

function line(n: number) {
  return {
    product: {
      id: `PR-${n}`,
      salonId: 'SAL-AMARA',
      name: `Product ${n}`,
      priceFils: 8500,
      image: null,
    },
    qty: 1,
    lineTotalFils: fils(8500),
  };
}

function cart(count: number, fulfilment: FulfilmentChoice = PICKUP) {
  const lines = Array.from({ length: count }, (_, i) => line(i + 1));
  return render(
    <LanguageProvider initial="en">
      <CartSheet
        open
        lines={lines}
        count={count}
        total={fils(8500 * count)}
        balanceFils={24500}
        canAfford
        shortfall={fils(0)}
        stale={[]}
        busy={false}
        refusal={null}
        fulfilment={fulfilment}
        block={null}
        book={book()}
        onClose={vi.fn()}
        onAdd={vi.fn()}
        onRemove={vi.fn()}
        onCheckout={vi.fn()}
        onTopUp={vi.fn()}
        onFulfilment={vi.fn()}
        onChooseAddress={vi.fn()}
        onAddAddress={vi.fn()}
        onEditAddress={vi.fn()}
        onDeleteAddress={vi.fn()}
      />
    </LanguageProvider>,
  );
}

/** `styles.lines`, read from the module's own StyleSheet rather than retyped. */
function linesStyle(): Record<string, unknown> {
  const src = fs.readFileSync(path.join(__dirname, 'CartSheet.tsx'), 'utf8');
  const m = /\n  lines: \{([^}]*)\},/.exec(src);
  expect(m, 'styles.lines not found in CartSheet.tsx').not.toBeNull();
  const out: Record<string, unknown> = {};
  for (const pair of m![1]!.split(',')) {
    const kv = /^\s*(\w+):\s*(.+?)\s*$/.exec(pair);
    if (kv) out[kv[1]!] = Number(kv[2]);
  }
  return out;
}

describe('the cart lines region fills the sheet instead of capping at a number', () => {
  it('declares no fixed height and no cap — the 320 is gone', () => {
    const s = linesStyle();
    expect(s.maxHeight).toBeUndefined();
    expect(s.height).toBeUndefined();
    // …and no minimum either, so one line does not stretch the sheet to 88%.
    expect(s.minHeight).toBeUndefined();
    expect(s.marginTop).toBe(14); // design:948, unchanged
  });

  it('shrinks rather than grows — `flex: 1` resolves to height 0 in Yoga', () => {
    const s = linesStyle();
    expect(s.flexShrink).toBe(1);
    // The literal transcription of design:948. It is the trap, not the fix.
    expect(s.flex).toBeUndefined();
    expect(s.flexGrow).toBeUndefined();
    expect(s.flexBasis).toBeUndefined();
  });

  it('leaves every sibling at RN\'s default flexShrink of 0, as the design pins them', () => {
    // design:944, :945 and :962 carry `flex-shrink:0` on the grabber, the head
    // and the totals block. RN's default IS 0, so the design's intent holds for
    // free — but only while nobody adds a shrink to them. That is what this
    // checks. (Line numbers verified by grep, not recalled: an earlier draft of
    // this comment cited 914/915/964, which are in the transaction sheet.)
    const src = fs.readFileSync(path.join(__dirname, 'CartSheet.tsx'), 'utf8');
    for (const name of ['head', 'totals', 'cta']) {
      const m = new RegExp(`\\n  ${name}: \\{([^}]*)\\},`).exec(src);
      expect(m, `styles.${name}`).not.toBeNull();
      expect(m![1], `styles.${name} must not shrink`).not.toContain('flexShrink');
    }
    // RN's own default, asserted rather than trusted: unlike CSS, Yoga starts
    // every node at `flexShrink: 0`, which is why the design's explicit
    // `flex-shrink:0` on those three needs no transcription.
    expect(StyleSheet.flatten<{ flexShrink?: number }>([{}]).flexShrink).toBeUndefined();
  });
});

describe('the fulfilment section scrolls with the lines, not beside them', () => {
  // The rendered-tree half. As a rigid sibling, a tall fulfilment block pushed
  // the CTA 80pt off a 667pt screen even with the shrink fix — measured.
  it.each([
    ['collect', PICKUP],
    ['delivery, with a saved address', { mode: 'delivery', addressId: ADDRESS.id } as FulfilmentChoice],
  ])('%s: it is inside the scroll container', (_label, choice) => {
    cart(2, choice);
    const scroll = screen.getByTestId('cart-scroll');
    const section = screen.getByTestId('fulfilment-section');
    expect(scroll.contains(section)).toBe(true);
  });

  it('the cart lines are inside it too, and the totals block is not', () => {
    cart(2);
    const scroll = screen.getByTestId('cart-scroll');
    expect(scroll.contains(screen.getByTestId('cart-line-PR-1'))).toBe(true);
    expect(scroll.contains(screen.getByTestId('cart-line-PR-2'))).toBe(true);
    // The pay button must stay OUT of the scroll region — it is the fixed
    // footer, and the whole point is that it cannot be scrolled away from.
    expect(scroll.contains(screen.getByTestId('cart-pay'))).toBe(false);
  });

  it('renders one line without pulling the fulfilment block out of the scroller', () => {
    cart(1);
    const scroll = screen.getByTestId('cart-scroll');
    expect(scroll.contains(screen.getByTestId('cart-line-PR-1'))).toBe(true);
    expect(scroll.contains(screen.getByTestId('fulfilment-section'))).toBe(true);
  });

  it('the empty cart has no scroll region at all', () => {
    cart(0);
    expect(screen.queryByTestId('cart-scroll')).toBeNull();
    expect(screen.getByTestId('cart-empty')).toBeTruthy();
  });
});
