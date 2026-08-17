/**
 * The Book flow's pieces. Layout, spacing and colour from
 * design/AVO Wallet Home.dc.html § BOOK (:521-618); the states from
 * design/AVO States.dc.html.
 *
 * Everything here is presentational. Nothing decides whether a slot is
 * bookable, what a deposit is, or whether a balance covers it — those live in
 * state/useBooking.ts and, ultimately, on the server.
 *
 * TWO RULES ARE STRUCTURAL RATHER THAN REMEMBERED:
 *
 *   · every colour comes off `theme`, which is `@avo/tokens`. There is not a
 *     hex in this file.
 *   · every filled control is `onBrandFill` — `brandDeep`, never `brand`
 *     (non-negotiable #9). The selected day chip and the selected slot are the
 *     two places the design fills something with the brand, and both are
 *     white-on-`brandDeep`.
 */

import { StyleSheet, Text, View } from 'react-native';
import { formatMoney, type Fils, type Language } from '@avo/types';
import {
  MICRO_LABEL_COLOR,
  MIN_TAP_TARGET,
  WHITE,
  color,
  onBrandFill,
  radius,
  text,
} from '../../theme';
import { useLanguage } from '../../i18n/language';
import { alignEnd } from '../../i18n/rtl';
import { TappableRow } from '../Buttons';
import { AVAIL_SALON_BG, AVAIL_SALON_DOT, AVAIL_SALON_TEXT, BRAND_BORDER, micro } from './tokens';
import type { AvailabilitySlotWire, BookableService } from '../../api/booking';
import type { Artist } from '@avo/types';
import {
  artistHoursPromise,
  artistInitial,
  artistName,
  dayNumberLabel,
  slotLabel,
  weekdayLabel,
  type StripDay,
} from '../../domain/booking';

// ------------------------------------------------------------------- shell --

/** design:536 — the uppercase micro-label above each step's content. */
export function StepLabel({ children }: { children: string }) {
  const { lang } = useLanguage();
  return <Text style={[text('label', lang), styles.stepLabel]}>{children}</Text>;
}

/** design:531 — the four-step progress bar. `brand` as a surface, which is its job. */
export function ProgressBar({ step, total }: { step: number; total: number }) {
  const fraction = Math.min(step, total) / total;
  return (
    <View style={styles.track} accessibilityRole="progressbar">
      {/*
        `alignSelf: flex-start` unconditionally. On the cross axis of a column
        container that is already the INLINE start, which under RTL is the
        right — so the bar grows from the reading edge in both languages. See
        i18n/rtl.ts, which records the measurement: flipping this to flex-end
        for Arabic double-flips it.
      */}
      <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
    </View>
  );
}

// ---------------------------------------------------------------- step one --

/**
 * design:538-543.
 *
 * NO DURATION ON THE ROW, and that is a design/contract disagreement rather
 * than an omission. The design shows "45 min" per service; the API has no
 * per-service duration because a booking's length is the ARTIST's
 * `slotMinutes`, chosen at step 3. Showing an invented minute count here would
 * be a number in front of a customer that no server will honour. The real
 * duration appears on the review, where it comes off the slot. Reported.
 */
export function ServiceRow({
  service,
  selected,
  onPick,
}: {
  service: BookableService;
  selected: boolean;
  onPick: () => void;
}) {
  const { lang } = useLanguage();
  return (
    <TappableRow
      onPress={onPick}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${service.name} · ${formatMoney(service.priceFils as Fils, lang)}`}
      testID={`book-service-${service.id}`}
      style={[styles.optionRow, selected && styles.optionRowOn]}
    >
      <View style={styles.optionBody}>
        {/*
          CONTRACT GAP (reported): `Service` has no `nameAr`, so an Arabic
          wallet shows the Latin service name. `Salon`, `Branch` and `Artist`
          all carry one. Not invented here — a transliteration written by this
          lane is a copy defect wearing the right script.
        */}
        <Text style={[text('bodyL', lang), styles.optionName]}>{service.name}</Text>
      </View>
      <Money amount={service.priceFils} />
    </TappableRow>
  );
}

/** The price, split so the figure keeps the display face in both languages. */
function Money({ amount }: { amount: number }) {
  const { lang } = useLanguage();
  return (
    <Text style={[text('money', lang), styles.price]} accessibilityElementsHidden>
      {formatMoney(amount as Fils, lang)}
    </Text>
  );
}

// ---------------------------------------------------------------- step two --

/**
 * design:551-561 — the avatar, the name, the role, and the availability badge.
 *
 * THE BADGE IS THE ARTIST'S SETTING, NOT A MEASUREMENT. "Live availability"
 * means her hours are synced from a connected Google Calendar; "Availability by
 * salon hours" means they are not. Whether that sync actually worked TODAY is a
 * different question, answered by the grid — see the fallback note on step 3.
 */
export function ArtistRow({
  artist,
  selected,
  onPick,
}: {
  artist: Artist;
  selected: boolean;
  onPick: () => void;
}) {
  const { lang, copy } = useLanguage();
  const live = artistHoursPromise(artist) === 'live';
  const name = artistName(artist, lang);
  const badge = live ? copy.availLive : copy.availSalon;

  return (
    <TappableRow
      onPress={onPick}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${name} · ${badge}`}
      testID={`book-artist-${artist.id}`}
      style={[styles.optionRow, selected && styles.optionRowOn]}
    >
      <View style={styles.avatar}>
        <Text style={[text('displayS', 'en'), styles.avatarInitial]}>
          {artistInitial(artist.name)}
        </Text>
      </View>
      <View style={styles.optionBody}>
        <Text style={[text('bodyL', lang), styles.optionName]}>{name}</Text>
        <View style={[styles.badge, live ? styles.badgeLive : styles.badgeSalon]}>
          <View style={[styles.badgeDot, live ? styles.badgeDotLive : styles.badgeDotSalon]} />
          <Text style={[micro(lang), live ? styles.badgeTextLive : styles.badgeTextSalon]}>
            {badge}
          </Text>
        </View>
      </View>
      <View style={[styles.tick, selected && styles.tickOn]}>
        {selected ? <Text style={styles.tickMark}>✓</Text> : null}
      </View>
    </TappableRow>
  );
}

// -------------------------------------------------------------- step three --

/** design:568-572 — the horizontal day strip. The first chip reads "Today". */
export function DayChip({
  day,
  selected,
  onPick,
}: {
  day: StripDay;
  selected: boolean;
  onPick: () => void;
}) {
  const { lang, copy } = useLanguage();
  const dow = day.isToday ? copy.today : weekdayLabel(day, lang);
  const number = dayNumberLabel(day, lang);
  return (
    <TappableRow
      onPress={onPick}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${dow} ${number}`}
      testID={`book-day-${day.date}`}
      style={[styles.dayChip, selected && styles.dayChipOn]}
    >
      <Text style={[micro(lang), selected ? styles.dayDowOn : styles.dayDow]}>{dow}</Text>
      <Text style={[text('displayS', lang), selected ? styles.dayNumOn : styles.dayNum]}>
        {number}
      </Text>
    </TappableRow>
  );
}

/**
 * design:1517-1524 — one slot.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AN UNAVAILABLE SLOT IS STRUCK THROUGH, NEVER HIDDEN
 * ═══════════════════════════════════════════════════════════════════════════
 * api-contract.md says so and api/src/services/availability.ts opens with the
 * reasoning: a 16:45 that is simply missing reads as a salon that does not work
 * at 16:45, and a 16:45 with a line through it reads as a slot somebody else
 * took. Only one of those is true, and the difference is a customer picking
 * 17:15 rather than closing the app.
 *
 * The endpoint returns every slot on the grid with `available` and a `reason`
 * precisely so this component can draw it. It is also why the reason is on the
 * accessibility label: a struck-through chip is a visual convention, and a
 * screen reader that only heard "16:45" would hear a slot that is free.
 */
export function SlotChip({
  slot,
  selected,
  onPick,
  reasonLabel,
}: {
  slot: AvailabilitySlotWire;
  selected: boolean;
  onPick: () => void;
  reasonLabel: string | null;
}) {
  const { lang } = useLanguage();
  const label = slotLabel(slot.local, lang);
  const disabled = !slot.available;
  return (
    <TappableRow
      onPress={onPick}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={reasonLabel ? `${label} — ${reasonLabel}` : label}
      testID={`book-slot-${slot.local}`}
      style={[styles.slot, disabled && styles.slotOff, selected && styles.slotOn]}
    >
      <Text
        style={[
          text('bodyL', lang),
          styles.slotText,
          selected && styles.slotTextOn,
          disabled && styles.slotTextOff,
        ]}
      >
        {label}
      </Text>
    </TappableRow>
  );
}

// --------------------------------------------------------------- step four --

/** design:586-590 — the three review rows. */
export function ReviewRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const { lang } = useLanguage();
  return (
    <View style={[styles.reviewRow, last && styles.reviewRowLast]}>
      <Text style={[text('body', lang), styles.reviewLabel]}>{label}</Text>
      <Text style={[text('bodyL', lang), styles.reviewValue, { textAlign: alignEnd(lang) }]}>
        {value}
      </Text>
    </View>
  );
}

/**
 * design:591-594 — the deposit card.
 *
 * The amount is `salon.depositFils` rendered through `formatMoney`, which is
 * the only place a currency unit exists in this app. A `kd: 'KD'` constant here
 * is what makes an Arabic build read "5.000 KD" — correct-looking in English
 * testing and wrong in Arabic, and invisible until someone switches language.
 */
export function DepositCard({
  depositFils,
  remainderFils,
}: {
  depositFils: number;
  remainderFils: number | null;
}) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.depositCard}>
      <View style={styles.depositTop}>
        <Text style={[text('bodyL', lang), styles.depositLabel]}>{copy.depositHeld}</Text>
        <Text style={[text('money', lang), styles.depositAmount]}>
          {formatMoney(depositFils as Fils, lang)}
        </Text>
      </View>
      {remainderFils !== null ? (
        <Text style={[text('body', lang), styles.depositNote]}>
          {copy.depositNote(formatMoney(remainderFils as Fils, lang))}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * design:595 — the shortfall banner.
 *
 * The number is the SERVER's `shortfallFils` from the 402, never
 * `deposit − balance` computed here. Non-negotiable #2 owns the balance, and
 * that includes owning the difference: a client that subtracts two numbers is a
 * client with a second opinion about money, and it is wrong exactly when a
 * charge landed between the read and the tap.
 */
export function ShortfallBanner({ shortfallFils }: { shortfallFils: number }) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.shortBanner} accessibilityRole="alert">
      <View style={styles.shortDot} />
      <Text style={[text('body', lang), styles.shortText]}>
        {copy.bookShortBy(formatMoney(shortfallFils as Fils, lang))}
      </Text>
    </View>
  );
}

/** A brand-tinted note. Used for the calendar fallback and the WhatsApp line. */
export function Note({
  children,
  tone = 'brand',
}: {
  children: string;
  tone?: 'brand' | 'wash';
}) {
  const { lang } = useLanguage();
  return (
    <View style={[styles.note, tone === 'wash' && styles.noteWash]}>
      <View style={styles.noteDot} />
      <Text style={[text('body', lang), styles.noteText]}>{children}</Text>
    </View>
  );
}

// -------------------------------------------------------------- the states --

/**
 * The loading state: skeletons shaped like the rows they replace.
 *
 * interaction-spec.md §4 — "skeletons shaped like the real layout, never a
 * centred spinner on a full page", and no money figure is ever drawn as 0.000
 * before the data arrives, which is why the price column is a bar.
 */
export function RowSkeleton({ count = 5 }: { count?: number }) {
  const { copy } = useLanguage();
  return (
    <View
      style={styles.skeletonGroup}
      accessibilityLabel={copy.loadingAria}
      accessibilityRole="progressbar"
    >
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.skeletonRow}>
          <View style={[styles.skeletonBar, { width: '52%' }]} />
          <View style={[styles.skeletonBar, styles.skeletonBarShort]} />
        </View>
      ))}
    </View>
  );
}

/** The slot grid's loading state: the same three-up grid, as bars. */
export function GridSkeleton({ count = 6 }: { count?: number }) {
  const { copy } = useLanguage();
  return (
    <View style={styles.grid} accessibilityLabel={copy.loadingAria} accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.slot, styles.slotSkeleton]} />
      ))}
    </View>
  );
}

/**
 * The empty state — States:112-119. Names the thing and offers the one action
 * that fills it, with no illustration.
 *
 * A DAY WITH NO SLOTS IS THIS, NOT A BLANK GRID. `open: false` means the artist
 * does not work then, and the honest answer is a sentence saying so rather than
 * an area of nothing that reads as a screen that failed to load.
 */
export function EmptyPanel({
  title,
  body,
  testID,
}: {
  title: string;
  body: string;
  testID?: string;
}) {
  const { lang } = useLanguage();
  return (
    <View style={styles.emptyPanel} testID={testID}>
      <Text style={[text('displayS', lang), styles.emptyTitle]}>{title}</Text>
      <Text style={[text('body', lang), styles.emptyBody]}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  stepLabel: { color: MICRO_LABEL_COLOR, marginHorizontal: 2, marginBottom: 12 },

  track: {
    height: 5,
    borderRadius: 999,
    backgroundColor: color.hairline,
    overflow: 'hidden',
    marginBottom: 20,
  },
  // `brand` as a surface fill — exactly what non-negotiable #9 reserves it for.
  fill: { height: '100%', borderRadius: 999, backgroundColor: color.brand, alignSelf: 'flex-start' },

  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 14,
    paddingHorizontal: 15,
    borderRadius: radius.card,
    backgroundColor: color.white,
    borderWidth: 1.5,
    borderColor: color.borderControl,
  },
  optionRowOn: { borderColor: color.brand },
  optionBody: { flex: 1, minWidth: 0 },
  optionName: { color: color.ink, fontWeight: '600' },
  price: { color: color.ink, fontSize: 15 },

  avatar: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: color.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: { color: color.brandDeep, fontSize: 17 },

  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 999,
    marginTop: 4,
  },
  badgeLive: { backgroundColor: color.brandTint },
  badgeSalon: { backgroundColor: AVAIL_SALON_BG },
  badgeDot: { width: 5, height: 5, borderRadius: 3 },
  badgeDotLive: { backgroundColor: color.brand },
  badgeDotSalon: { backgroundColor: AVAIL_SALON_DOT },
  badgeTextLive: { color: color.brandDeep, fontWeight: '600' },
  badgeTextSalon: { color: AVAIL_SALON_TEXT, fontWeight: '600' },

  tick: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: color.borderControl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickOn: { backgroundColor: color.brand, borderColor: color.brand },
  tickMark: { color: WHITE, fontSize: 12, fontWeight: '700', lineHeight: 14 },

  dayChip: {
    minWidth: 58,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingVertical: 11,
    paddingHorizontal: 8,
    borderRadius: 14,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.borderControl,
  },
  dayChipOn: { backgroundColor: onBrandFill.backgroundColor, borderColor: color.brandDeep },
  dayDow: { color: color.textMuted },
  dayDowOn: { color: WHITE, opacity: 0.75 },
  dayNum: { color: color.ink, fontSize: 18 },
  dayNumOn: { color: WHITE, fontSize: 18 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  slot: {
    // Three across with two 9pt gaps. `flexBasis` rather than a computed width
    // so the row still divides correctly at any frame width.
    flexBasis: '31%',
    flexGrow: 1,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.borderControl,
  },
  slotOn: { backgroundColor: onBrandFill.backgroundColor, borderColor: color.brandDeep },
  slotOff: { backgroundColor: color.disabledBg, borderColor: 'transparent' },
  slotSkeleton: { backgroundColor: color.surfaceAlt2, borderColor: 'transparent' },
  slotText: { color: color.ink, fontWeight: '600' },
  slotTextOn: { color: WHITE },
  // design:1518 — `text-decoration: line-through` on the disabled slot. The
  // strike IS the message; without it a greyed chip reads as "not offered".
  slotTextOff: { color: color.textMutedSoft, textDecorationLine: 'line-through' },

  reviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: color.hairline,
  },
  reviewRowLast: { borderBottomWidth: 0 },
  reviewLabel: { color: color.textMuted },
  reviewValue: { color: color.ink, fontWeight: '600', flexShrink: 1 },

  depositCard: {
    marginTop: 14,
    padding: 16,
    borderRadius: radius.card,
    backgroundColor: color.brandTint2,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
  },
  depositTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  depositLabel: { color: color.brandDeeper, fontWeight: '600' },
  depositAmount: { color: color.positive, fontSize: 20 },
  depositNote: { color: color.textMuted, marginTop: 6 },

  shortBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 12,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: color.dangerBg,
  },
  shortDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.dangerDot },
  shortText: { color: color.dangerText, flex: 1 },

  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: color.brandTint,
  },
  noteWash: { backgroundColor: color.brandTint2 },
  noteDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.brand },
  noteText: { color: color.brandDeeper, flex: 1, lineHeight: 18 },

  skeletonGroup: { gap: 9 },
  skeletonRow: {
    minHeight: 62,
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 15,
    borderRadius: radius.card,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  skeletonBar: { height: 12, borderRadius: 6, backgroundColor: color.surfaceAlt2 },
  skeletonBarShort: { width: '28%', height: 10 },

  emptyPanel: {
    alignItems: 'center',
    paddingVertical: 34,
    paddingHorizontal: 18,
    borderRadius: radius.cardLg,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  emptyTitle: { color: color.ink, textAlign: 'center' },
  emptyBody: { color: color.textMuted, marginTop: 7, textAlign: 'center', lineHeight: 20 },
});

