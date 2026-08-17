/**
 * Four values the Book flow needs that `@avo/tokens` does not name.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THESE ARE REPORTED, NOT INVENTED
 * ═══════════════════════════════════════════════════════════════════════════
 * The skill file is explicit: "If a value in the design genuinely has no token,
 * **report it** — do not invent one." Three tokens (`textMutedLabel`,
 * `borderControl`, `white`) were added to trunk exactly this way after a lane
 * found values the design used repeatedly with nothing to name them, and the
 * scanner does the same thing in components/States.tsx for its offline dot.
 *
 * So each one below is held here, with the design line it came from and the
 * reason it is not one of the existing tokens, until trunk names it. Holding
 * them in ONE module rather than scattering them through the stylesheet is what
 * makes the report a list rather than an archaeology exercise.
 */

import type { TextStyle } from 'react-native';
import type { Language } from '@avo/types';
import { ARABIC_FAMILY, text } from '../../theme';

/**
 * The amber "Availability by salon hours" badge — design:1498-1499.
 *
 *   background  #F4EFE2
 *   text        #8A7A55
 *   dot         #B6A26A
 *
 * NOT `warnBg` / `warnText`. Those are #F3E9CF and #8a6d3b, which are the GOLD
 * TIER pill (design:690, `Gold: ['#8a6d3b', '#F3E9CF']`) — a different thing
 * that happens to be a similar hue. Substituting them would tint an
 * availability badge with a loyalty colour, and the two would then drift
 * together the first time either is adjusted.
 */
export const AVAIL_SALON_BG = '#F4EFE2';
export const AVAIL_SALON_TEXT = '#8A7A55';
export const AVAIL_SALON_DOT = '#B6A26A';

/**
 * The 1px edge on the brand-washed deposit card — `rgba(110,127,108,0.22)`,
 * design:591. It is `brand` at 22% and the design uses it on every
 * brand-washed panel in the bundle; `hairline` is ink at 8% and reads grey
 * against the wash rather than green.
 *
 * apps/scanner/src/components/States.tsx carries the same literal with the same
 * citation, which is the second call site and the argument for tokenising it.
 */
export const BRAND_BORDER = 'rgba(110,127,108,0.22)';

/**
 * The 10.5px/600 micro-label — the availability badge and the day chip's
 * weekday line (design:1497, :570).
 *
 * The type scale stops at `label` (11px, uppercase, +0.88 tracking) and `bodyS`
 * (12.5px). Neither fits: `label`'s uppercase transform is wrong for
 * "Live availability", which the design writes in sentence case, and `bodyS` is
 * two points too large for a chip that has to sit under a name inside a 42pt
 * row.
 *
 * Composed from `bodyS` rather than typed from nothing, so the FAMILY still
 * comes off the token and Arabic still resolves to IBM Plex Sans Arabic — the
 * one property that must not be hand-written, because a Latin face on an Arabic
 * string renders as tofu or as a silent system substitution.
 */
export function micro(lang: Language): TextStyle {
  return { ...text('bodyS', lang), fontSize: 10.5, fontWeight: '600' };
}

/** Re-exported so a reader can see the Arabic family is the token's, not a literal. */
export { ARABIC_FAMILY };
