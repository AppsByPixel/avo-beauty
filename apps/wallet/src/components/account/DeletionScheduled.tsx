/**
 * The persistent "your account is scheduled for deletion" state, and the door out.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE GRACE WINDOW IS ONLY REAL IF SHE CAN FIND IT.
 *
 * Before this, the ONLY route to the cancel door was the few seconds between
 * requesting deletion and closing the sheet. Reopen the app and Account looked
 * ordinary: clock running, nothing on screen saying so, no way back. This card
 * is what a customer mid-window actually sees, so its job is to state two things
 * without ambiguity — WHEN, and that nothing has happened yet.
 *
 * IT MUST NOT IMPLY THE ERASURE IS UNDER WAY. `erasureScheduled` comes back
 * `false` and will stay false until the retention job exists, because which
 * columns are nulled at the due date is the client's decision (CLAUDE.md
 * § Escalate). "We have your request and the clock is running" and "your data
 * has been removed" are different sentences and only the first is true, so the
 * copy opens with "Nothing has been deleted yet."
 *
 * NO DESIGN SOURCE. The design's delete sheet calls no server (design:902-903),
 * so it has no notion of a request that outlives the sheet. Built from the parts
 * the Account screen already uses — `SettingsCard`, the danger tint the sheet's
 * balance card uses — rather than inventing a new visual language, and the two
 * new strings are in AR_GAPS.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { StyleSheet, Text, View } from 'react-native';
import { color, radius, text } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { TappableRow } from '../Buttons';
import { erasureDueOn } from '../../domain/deletion';

export function DeletionScheduled({
  erasureDueAt,
  onOpenCancel,
}: {
  /**
   * The server's `erasureDueAt`. Nullable because the schema allows it — a
   * `pending` status with no date would be a contract violation, but the client
   * renders around it rather than crashing on the screen whose whole purpose is
   * to be reachable.
   */
  erasureDueAt: string | null;
  onOpenCancel: () => void;
}) {
  const { lang, copy } = useLanguage();
  const dueOn = erasureDueAt ? erasureDueOn(erasureDueAt) : null;

  return (
    <View style={styles.card} testID="deletion-scheduled">
      <Text style={[text('bodyL', lang), styles.title]}>{copy.deleteScheduledTitle}</Text>
      {/*
        Only when the date is known. The alternative — a sentence with a gap in
        it, or a guessed requestedAt + graceDays — is worse than a shorter card
        on the screen that tells her how long she has.
      */}
      {dueOn ? (
        <Text style={[text('bodyS', lang), styles.body]} testID="deletion-scheduled-date">
          {copy.deleteScheduledBody(dueOn)}
        </Text>
      ) : null}
      <TappableRow
        onPress={onOpenCancel}
        accessibilityRole="button"
        accessibilityLabel={copy.deleteCancel}
        testID="deletion-scheduled-cancel"
        style={styles.action}
      >
        <Text style={[text('bodyS', lang), styles.actionText]}>{copy.deleteCancel}</Text>
      </TappableRow>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.dangerBg,
    borderRadius: radius.card,
    paddingVertical: 16,
    paddingHorizontal: 18,
    marginTop: 18,
  },
  title: { color: color.dangerText, fontWeight: '600' },
  body: { color: color.dangerText, marginTop: 6, lineHeight: 19 },
  action: {
    marginTop: 14,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.button,
    backgroundColor: color.surface,
  },
  actionText: { color: color.dangerText, fontWeight: '600' },
});
