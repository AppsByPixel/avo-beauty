/**
 * What mirroring does NOT do for you.
 *
 * Most of the layout flips for free and it is worth knowing why, so that nobody
 * "fixes" it by adding conditionals that then double-flip:
 *
 *   flexDirection: 'row'   flips on BOTH targets. On web, CSS flexbox lays a row
 *                          out along the inline axis, so `dir="rtl"` reverses it.
 *                          On native, Yoga reverses it when `I18nManager.isRTL`.
 *                          A `row` is therefore already a logical direction and
 *                          must never be written as `row-reverse` for Arabic.
 *   marginStart/End        logical on both. `marginLeft` is not — it is a
 *   paddingStart/End       physical edge and stays put when the layout turns
 *                          around. Prefer the logical form.
 *   justifyContent         follows the flipped main axis, so `space-between`
 *                          keeps a label at the reading edge in both languages.
 *
 * What does not flip, and is what this module is for:
 *
 *   textAlign: 'left'/'right'   physical. `'start'`/`'end'` are not in React
 *                               Native's TextStyle, so the value is resolved
 *                               from the language here instead.
 *   directional glyphs          → ← ‹ › ✓ arrows in copy. An arrow that keeps
 *                               pointing right in an Arabic sentence points
 *                               backwards. The design agrees and mirrors its own
 *                               ladder arrow — AVO Wallet Home.dc.html:1716 uses
 *                               `10 → 10` and :1722 uses `10 ← 10`.
 *   progress fills              a bar that grows from the physical left grows
 *                               *backwards* in Arabic. It has to grow from the
 *                               reading edge.
 *
 * The progress case is the one worth being careful about, because it looks fine
 * in a screenshot and is wrong: a Kuwaiti reader reads the bar from the right,
 * so a fill anchored left reads as "you have almost none left" when it means the
 * opposite.
 */

import type { TextStyle } from 'react-native';
import type { Language } from '@avo/types';

/**
 * `textAlign` for text that should sit at the far edge — a row's value column.
 *
 * The only helper here, because it is the only thing in the built screens that
 * React Native gives no logical form for. Text that should sit at the READING
 * edge needs nothing: `textAlign` defaults to `auto`, which follows the
 * paragraph direction on both targets. Adding an `alignStart(lang)` to say so
 * explicitly would just be a way to get it wrong later.
 */
export function alignEnd(lang: Language): TextStyle['textAlign'] {
  return lang === 'ar' ? 'left' : 'right';
}

/*
 * THERE IS NO `fillAnchor(lang)` HELPER, AND THERE WAS ONE UNTIL IT WAS MEASURED.
 *
 * The progress fill on the wallet card has to grow from the reading edge — a bar
 * anchored to the physical left in an Arabic layout reads as "almost none" when
 * it means "almost there". The obvious implementation is to flip `alignSelf` to
 * `flex-end` in Arabic. That is wrong, and the browser says so:
 *
 *   dir=rtl, alignSelf: flex-end  → fill at x=42..90   (LEFT of the track)
 *   dir=rtl, alignSelf: flex-start → fill at the right edge
 *
 * `flex-start` on the CROSS axis of a column container is already the inline
 * start, which under RTL is the right. Flipping it manually double-flips it. So
 * the fill is `alignSelf: 'flex-start'` unconditionally, in WalletCard's
 * stylesheet, and this note is here because "it flips for free" is the sort of
 * claim that gets quietly reversed by the next person who eyeballs it.
 */

/*
 * There is deliberately no general "mirror the arrows in this string" helper.
 * Bidi already reorders a mixed string correctly; the only characters that need
 * a decision are the ones whose *meaning* is directional, and there is exactly
 * one of those in the built screens — the tier ladder. It is handled where it
 * belongs, in the copy: `en.tierLadder` uses → and `ar.tierLadder` uses ←,
 * matching design/AVO Wallet Home.dc.html:1716 and :1722.
 */

