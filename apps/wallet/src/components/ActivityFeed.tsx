/**
 * The activity feed, its disclosure and its empty state.
 *
 * The empty state is a section-level state, not a screen-level one: a brand-new
 * member's wallet card, tier and payment code are all real and should render.
 * Only the list is empty, and interaction-spec.md §4 asks that an empty state
 * name the thing and offer the one action that fills it. Here that action is a
 * top-up, which is exactly what turns an empty feed into a non-empty one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR ROWS, THEN A CONTROL — AND A THIRD SECTION-LEVEL STATE
 * ═══════════════════════════════════════════════════════════════════════════
 * This rendered every row until now, so an account with a year of history
 * pushed Membership and everything below it off the bottom of Home. Aftab asked
 * for four and a disclosure beneath.
 *
 * The rule is `domain/activity.ts § discloseActivity` and NOT an inline
 * `slice(0, 4)`, for the reason the near-empty case makes concrete: at exactly
 * four rows there is nothing under the fourth, so the control must not appear,
 * and `hidden > 0` is the single expression that decides it. A `slice` here and
 * a `length > 4` in the JSX would be two statements of one rule, and the
 * boundary is where they would disagree.
 *
 * EXPANDED IS VIEW STATE AND LIVES HERE. It is not a preference, it is not
 * persisted, and it does not belong on `useWalletHome`: the feed remounts on
 * every return to Home and opens collapsed again, which is the behaviour a
 * disclosure should have. Nothing about it reaches the server.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND IT FOLDS BACK — ONE CONTROL, TWO LABELS (2026-09-28)
 * ═══════════════════════════════════════════════════════════════════════════
 * Aftab: "activity now shows more but when I want to shorten the list again I
 * can't." The control used to withdraw once pressed. It now stays and reads
 * "Show less", and pressing it returns the list to four. The opens-collapsed
 * rule above is untouched — a way back does not make the open state sticky.
 *
 * THE SAME ELEMENT IN BOTH STATES, NOT TWO. One `Pressable` whose label and
 * state change, rather than a "more" button unmounting and a "less" button
 * mounting in its place: a screen reader's focus stays on the control she just
 * activated instead of falling back to the top of the document, and a keyboard
 * user can press it again without hunting for it.
 *
 * ITS STATE IS EXPOSED, NOT ONLY ITS LABEL. `accessibilityState.expanded` for
 * native and `aria-expanded` for the web build — both, for the reason `Toggle`
 * in account/Rows.tsx gives: react-native-web does not map the state object to
 * ARIA, measured there on `checked` and again here on `expanded`.
 *
 * FOLDING SCROLLS HER BACK TO THE LIST. See `domain/activity.ts §
 * collapseScrollTarget` for why and when; this component hands Home its own
 * view, and Home, which owns the scroll view, measures and decides.
 */

import { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { color, MICRO_LABEL_COLOR, MIN_TAP_TARGET, onBrandFill, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { focusable } from '../theme/focus';
import { SignedAmount } from './Money';
import { discloseActivity, type ActivityRow } from '../domain/activity';
import { brandedStyles } from '../theme/live';

interface Props {
  rows: ActivityRow[];
  onTopUp: () => void;
  /** Every row opens the detail sheet — design/AVO Wallet Home.dc.html. */
  onOpen: (id: string) => void;
  /**
   * Called as the list folds back to four, with the section's own view. Home
   * measures it against the scroll content it owns and brings it back into view
   * — see `domain/activity.ts § collapseScrollTarget`.
   *
   * THE VIEW, NOT A NUMBER. This first passed the section's `onLayout` y, and
   * driving the web build showed it landing 26pt off: react-native-web fires
   * `onLayout` from a ResizeObserver, so it reports a SIZE change and never a
   * pure MOVE — and the section moves without resizing whenever a card above it
   * settles (Upcoming's skeleton giving way to the real card). The number was
   * the section's first position, not its current one. Measuring at the press
   * is the only reading that cannot be stale.
   */
  onCollapse?: (section: View | null) => void;
}

export function ActivityFeed({ rows, onTopUp, onOpen, onCollapse }: Props) {
  const { lang, copy } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const { visible, control } = discloseActivity(rows, expanded);
  const sectionRef = useRef<View>(null);

  const toggle = () => {
    if (control === 'less') {
      setExpanded(false);
      onCollapse?.(sectionRef.current);
    } else {
      setExpanded(true);
    }
  };
  const label = control === 'less' ? copy.activityShowLess : copy.activityShowMore;
  const isExpanded = control === 'less';

  return (
    <View ref={sectionRef} style={styles.section}>
      <Text style={[text('label', lang), styles.sectionLabel]}>{copy.activityLabel}</Text>
      {rows.length === 0 ? (
        <EmptyActivity onTopUp={onTopUp} />
      ) : (
        <>
          <Rows rows={visible} onOpen={onOpen} />
          {/*
            BENEATH THE CARD, NOT INSIDE IT. The card's last row drops its
            bottom hairline (`rowLast`) so the list closes cleanly; a control
            inside would either reinstate that line or sit flush against it.
            Outside, it reads as an action on the card rather than an entry in
            it — which is what it is.

            It no longer withdraws once pressed. It used to, and this note said
            there was no "show less" because the bundle has no such string —
            true, and the right call until the client asked for one. See the
            header. `control` is null only when there is nothing to fold or
            reveal, i.e. four rows or fewer.
          */}
          {control ? (
            <Pressable
              onPress={toggle}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ expanded: isExpanded }}
              aria-expanded={isExpanded}
              dataSet={focusable}
              testID="activity-disclosure"
              style={styles.more}
            >
              <Text style={[text('body', lang, '600'), styles.moreText]}>{label}</Text>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  );
}

function Rows({ rows, onOpen }: { rows: ActivityRow[]; onOpen: (id: string) => void }) {
  const { lang } = useLanguage();
  return (
    <View style={styles.card}>
      {rows.map((row, index) => (
        <Pressable
          key={row.id}
          onPress={() => onOpen(row.id)}
          accessibilityRole="button"
          // One label for the whole row, so a reader announces a receipt rather
          // than four disconnected fragments.
          accessibilityLabel={`${row.title}, ${row.when}, ${row.amountLabel}`}
          testID={`activity-row-${row.id}`}
          style={[styles.row, index === rows.length - 1 && styles.rowLast]}
        >
          <View style={styles.icon}>
            <View style={[styles.iconDot, row.positive ? styles.iconDotIn : styles.iconDotOut]} />
          </View>
          <View style={styles.rowText}>
            <Text style={[text('bodyL', lang, '500'), styles.rowTitle]}>{row.title}</Text>
            {/*
              The status suffix is copy, not a literal — it was ' · Pending'
              inline, which is exactly the sort of string an Arabic build renders
              in English without anyone noticing. `toActivityRow` composes it now.
            */}
            <Text style={[text('bodyS', lang), styles.rowWhen]}>{row.when}</Text>
          </View>
          <SignedAmount
            display={row.amount}
            label={row.amountLabel}
            color={row.positive ? color.positive : color.ink}
          />
        </Pressable>
      ))}
    </View>
  );
}

function EmptyActivity({ onTopUp }: { onTopUp: () => void }) {
  const { lang, copy } = useLanguage();
  return (
    <View style={[styles.card, styles.empty]}>
      <View style={styles.emptyIcon}>
        <View style={styles.emptyBar} />
        <View style={styles.emptyBar} />
        <View style={[styles.emptyBar, styles.emptyBarShort]} />
      </View>
      <Text style={[text('displayS', lang), styles.emptyTitle]}>{copy.emptyActivityTitle}</Text>
      <Text style={[text('body', lang), styles.emptyBody]}>{copy.emptyActivityBody}</Text>
      <Pressable
        onPress={onTopUp}
        accessibilityRole="button"
        style={styles.emptyAction}
        accessibilityLabel={copy.emptyActivityAction}
      >
        <Text style={[text('body', lang, '600'), styles.emptyActionText]}>
          {copy.emptyActivityAction}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = brandedStyles(() => ({
  section: { marginTop: 24 },
  sectionLabel: { color: MICRO_LABEL_COLOR, marginHorizontal: 4, marginBottom: 10 },
  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
    minHeight: MIN_TAP_TARGET,
  },
  rowLast: { borderBottomWidth: 0 },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: color.surfaceAlt2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconDot: { width: 10, height: 10, borderRadius: radius.pill },
  iconDotIn: { backgroundColor: color.positive },
  iconDotOut: { backgroundColor: color.textMuted },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: color.ink },
  rowWhen: { color: color.textMuted, marginTop: 1 },

  /**
   * The disclosure. A text action, centred under the card, at the tap target
   * every other control on Home keeps.
   *
   * NOT A FILLED BUTTON. `emptyAction` above is filled because it is the one
   * thing to do on an empty screen; this sits under a card full of content and
   * a second brand-filled button on Home would compete with the wallet card's
   * own. `color.ink` rather than the brand for the same reason — and it keeps
   * non-negotiable #9 a non-question here, since no white text goes near a fill.
   */
  more: {
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 10,
  },
  moreText: { color: color.ink },

  empty: { paddingVertical: 44, paddingHorizontal: 24, alignItems: 'center' },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: color.surfaceAlt2,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  emptyBar: { width: 19, height: 1.7, borderRadius: 2, backgroundColor: 'rgba(28,27,25,0.32)' },
  emptyBarShort: { width: 11 },
  emptyTitle: { color: color.ink, marginTop: 16 },
  emptyBody: { color: color.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 20 },
  emptyAction: {
    marginTop: 20,
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    paddingVertical: 13,
    paddingHorizontal: 22,
    borderRadius: radius.input,
    // Non-negotiable #9: a white-text fill is brandDeep, never brand.
    backgroundColor: onBrandFill.backgroundColor,
  },
  emptyActionText: { color: onBrandFill.color },
}));
