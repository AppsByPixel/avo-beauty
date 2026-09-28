/**
 * When she can collect — W8. Two lines under a pickup branch, wherever one is
 * named: the picker's rows, the single-branch tile, her order and the invoice
 * (the bell draws the same sentences as plain lines, `domain/bell.ts`).
 *
 *   "Collect during working hours, 10 am – 1 pm and 4 pm – 9 pm"
 *   "Closed now — collect tomorrow from 10 am"          ← only while shut
 *
 * DISPLAY ONLY. Nothing here blocks Pay or changes what is sent — the server
 * does not refuse a pickup out of hours. See `domain/pickupHours.ts`, which also
 * carries the two rules this depends on: "open now" in the SALON's zone, and a
 * zero-length span is not a window.
 *
 * `timezone: null` is "the zone is not known" — a card-paid order snapshot
 * stored before migration 0063 carries no zone — and draws the hours without a
 * closed-now line, rather than deciding one on the device's clock.
 *
 * THE CLOCK TICKS, SLOWLY. A cart left open across 21:00 should not go on
 * saying nothing; thirty seconds is plenty for a sentence about hours, and far
 * below the happy-hour banner's once a second.
 *
 * THE HOOK IS SEPARATE FROM THE VIEW because a radio row carries its own
 * `accessibilityLabel`, which replaces what its children would have said. A row
 * that drew the hours but announced only the branch name would tell a
 * screen-reader user less than a sighted one, so those rows read the same lines
 * from `usePickupHours` into their label.
 *
 * NOT IN THE DESIGN BUNDLE. The muted body line is the delivery snapshot's own
 * (`OrdersSheet` `body`); the closed-now line is the warn text the status pill
 * already uses — a notice, not a refusal, so never the danger chip.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLanguage } from '../i18n/language';
import { pickupHoursLines, type BusinessHours, type PickupHoursLines } from '../domain/pickupHours';
import { color, text } from '../theme';

const TICK_MS = 30_000;

/** The two sentences for these hours, re-read every thirty seconds. */
export function usePickupHours(
  hours: BusinessHours | null,
  timezone: string | null,
): PickupHoursLines | null {
  const { copy } = useLanguage();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return hours === null ? null : pickupHoursLines(hours, timezone, now, copy);
}

/** The lines as a screen reader hears them, for a row that owns its label. */
export function spokenPickupHours(lines: PickupHoursLines | null): string {
  if (lines === null) return '';
  return lines.closedNow === null ? ` · ${lines.hours}` : ` · ${lines.hours} · ${lines.closedNow}`;
}

/** The view. `lines` null draws nothing. */
export function PickupHoursLinesView({
  lines,
  testID,
}: {
  lines: PickupHoursLines | null;
  testID: string;
}) {
  const { lang } = useLanguage();
  if (lines === null) return null;
  return (
    <View style={styles.block} testID={testID}>
      <Text style={[text('bodyS', lang), styles.hours]} testID={`${testID}-hours`}>
        {lines.hours}
      </Text>
      {lines.closedNow === null ? null : (
        <Text style={[text('bodyS', lang, '600'), styles.closed]} testID={`${testID}-closed`}>
          {lines.closedNow}
        </Text>
      )}
    </View>
  );
}

/** Hook and view together, for a surface that does not own an a11y label. */
export function PickupHoursNote({
  hours,
  timezone,
  testID,
}: {
  hours: BusinessHours;
  timezone: string | null;
  testID: string;
}) {
  const lines = usePickupHours(hours, timezone);
  return <PickupHoursLinesView lines={lines} testID={testID} />;
}

const styles = StyleSheet.create({
  block: { marginTop: 2 },
  hours: { color: color.textMuted },
  closed: { color: color.warnText, marginTop: 2 },
});
