/**
 * The activity feed and its empty state.
 *
 * The empty state is a section-level state, not a screen-level one: a brand-new
 * member's wallet card, tier and payment code are all real and should render.
 * Only the list is empty, and interaction-spec.md §4 asks that an empty state
 * name the thing and offer the one action that fills it. Here that action is a
 * top-up, which is exactly what turns an empty feed into a non-empty one.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, MICRO_LABEL_COLOR, MIN_TAP_TARGET, onBrandFill, radius, text } from '../theme';
import { en } from '../copy/en';
import { SignedAmount } from './Money';
import type { ActivityRow } from '../domain/activity';

interface Props {
  rows: ActivityRow[];
  onTopUp: () => void;
  /** Every row opens the detail sheet — design/AVO Wallet Home.dc.html. */
  onOpen: (id: string) => void;
}

export function ActivityFeed({ rows, onTopUp, onOpen }: Props) {
  return (
    <View style={styles.section}>
      <Text style={[text('label'), styles.sectionLabel]}>{en.activityLabel}</Text>
      {rows.length === 0 ? (
        <EmptyActivity onTopUp={onTopUp} />
      ) : (
        <Rows rows={rows} onOpen={onOpen} />
      )}
    </View>
  );
}

function Rows({ rows, onOpen }: { rows: ActivityRow[]; onOpen: (id: string) => void }) {
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
            <Text style={[text('bodyL'), styles.rowTitle]}>{row.title}</Text>
            <Text style={[text('bodyS'), styles.rowWhen]}>
              {row.when}
              {row.pending ? ' · Pending' : ''}
              {row.failed ? ' · Failed' : ''}
            </Text>
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
  return (
    <View style={[styles.card, styles.empty]}>
      <View style={styles.emptyIcon}>
        <View style={styles.emptyBar} />
        <View style={styles.emptyBar} />
        <View style={[styles.emptyBar, styles.emptyBarShort]} />
      </View>
      <Text style={[text('displayS'), styles.emptyTitle]}>{en.emptyActivityTitle}</Text>
      <Text style={[text('body'), styles.emptyBody]}>{en.emptyActivityBody}</Text>
      <Pressable
        onPress={onTopUp}
        accessibilityRole="button"
        style={styles.emptyAction}
        accessibilityLabel={en.emptyActivityAction}
      >
        <Text style={[text('body'), styles.emptyActionText]}>{en.emptyActivityAction}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
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
  rowTitle: { color: color.ink, fontWeight: '500' },
  rowWhen: { color: color.textMuted, marginTop: 1 },

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
  emptyActionText: { color: onBrandFill.color, fontWeight: '600' },
});
