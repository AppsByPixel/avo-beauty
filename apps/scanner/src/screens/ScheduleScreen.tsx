/**
 * Scanner · My schedule. design/AVO Staff Scanner.dc.html:397-470.
 *
 * The artist sets her own week: where her hours come from, how long a booking
 * slot is, and a window per day, with a running open-days / hours / slots-per-
 * week summary in the footer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 1 · THE WEEK IS READ ON OPEN, AND FOR THREE MERGES IT WAS NOT
 * ═══════════════════════════════════════════════════════════════════════════
 * This section used to be titled "WHY THE WEEK IS NOT DRAWN UNTIL A SOURCE IS
 * CHOSEN" and it opened "Because nothing can read it… there is no
 * `GET /artists/me`". That route exists — `api/src/routes/artists.ts:658`,
 * scanner scope, no permission — and its own header credits this lane for asking
 * for it. The ask was granted, the comment was never updated, and the workaround
 * outlived the gap it was written for.
 *
 * WHAT THE WORKAROUND COST, which is why this is a defect and not tidying: the
 * screen opened on the source toggle and took her week from the PUT's response.
 * So a Google-synced artist could not LOOK at her own hours without tapping
 * "Set manually" — which switches her off her calendar. The one case the old
 * reasoning called harmless ("choosing Manual when she is already manual writes
 * nothing") was the only case it was harmless in.
 *
 * Now: `fetchMyArtist()` on mount, and the design's own layout — the week already
 * on screen when she arrives — is finally what renders. Which also means this
 * screen has a real LOADING state for the first time, and therefore a real
 * failure taxonomy on the read: `not_an_artist` explains, `offline` is her
 * connection, anything else is ours.
 *
 * Still true, and still checked: `GET /artists/me/availability` falls through to
 * the `:id` route and 404s, and `GET /salons/{id}/artists` needs `perms.team`
 * which the artist account deliberately lacks.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 2 · THE 409 IS SURFACED, NOT ONLY PREVENTED
 * ═══════════════════════════════════════════════════════════════════════════
 * A Google-sourced week is read-only, and the design says so with a Synced
 * pill and disabled rows. That is a UI convention, and non-negotiable #7's
 * whole point is that a convention is not a control — so the rows stay
 * tappable, the server refuses with `409 availability_is_synced`, and the
 * refusal names the fix in the API's own words. An artist who taps a day and
 * gets nothing learns that the app is broken; one who gets a sentence learns
 * what to do.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 3 · WHAT THIS SCREEN DOES NOT COMPUTE
 * ═══════════════════════════════════════════════════════════════════════════
 * The stepper refuses nothing. A window shorter than one slot, a close before
 * an open, a slot length that invalidates a day the client never sent — all
 * three are refused by the API with a sentence naming the day, and all three
 * are surfaced rather than pre-empted. The summary in the footer is arithmetic
 * on what is on screen, and it is labelled as such by being recomputed from the
 * server's row after every save.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ApiError } from '../api/client';
import {
  fetchMyArtist,
  putMyAvailability,
  SLOT_LENGTHS,
  type ArtistRow,
  type SlotLength,
  type Week,
} from '../api/artist';
import { copy } from '../copy/en';
import { color, display, MIN_TAP_TARGET, radius, ui } from '../theme';
import { LinkButton, PrimaryButton } from '../components/Buttons';
import { EmptyState, Refusal, SkeletonRows } from '../components/States';
import { useSession } from '../state/session';

/** design:645 — the stepper moves in half-hours. */
const STEP_MINUTES = 30;

/** design:654 — Sunday first, matching `Artist.windows`' own keys. */
const DAYS: Array<{ key: string; name: string; short: string }> = [
  { key: '0', name: 'Sunday', short: 'S' },
  { key: '1', name: 'Monday', short: 'M' },
  { key: '2', name: 'Tuesday', short: 'T' },
  { key: '3', name: 'Wednesday', short: 'W' },
  { key: '4', name: 'Thursday', short: 'T' },
  { key: '5', name: 'Friday', short: 'F' },
  { key: '6', name: 'Saturday', short: 'S' },
];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/** design:hhmm — minutes past midnight back to the contract's "HH:mm". */
function toHhmm(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 30, minutes));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

interface Props {
  accessToken: string;
  onHome: () => void;
  staffFirstName: string;
  staffHandle: string;
}

type Refusal409 = { title: string; body: string } | null;

export function ScheduleScreen({ accessToken, onHome, staffFirstName, staffHandle }: Props) {
  /**
   * `null` until a source has been chosen and the server has answered with the
   * row. There is no invented starting week — see the header.
   */
  const { reportFailure } = useSession();
  const [artist, setArtist] = useState<ArtistRow | null>(null);
  /** The edits not yet saved. Null means "nothing changed since the last read". */
  const [draftWeek, setDraftWeek] = useState<Week | null>(null);
  const [draftSlot, setDraftSlot] = useState<SlotLength | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal409>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /**
   * Her connection, told apart from our failure.
   *
   * It used to fall through to `failed`, and READ TRUTHFULLY BY ACCIDENT: a
   * transport failure carries `message: 'No connection.'` from `api/client.ts`,
   * so the body happened to say the right thing while the title above it said
   * "We couldn't load that". A 503 or 504 had no such luck — it classifies as
   * `offline` too but carries the SERVER's message, so the screen blamed us for
   * her signal with no reconnect guidance at all.
   *
   * "Nothing is lost" is literally true here: this is a SAVE path, and the draft
   * is only dropped in the success branch, so her unsaved week is still on
   * screen behind this alert.
   */
  const [offline, setOffline] = useState(false);
  /**
   * The initial read. True until `GET /artists/me` answers one way or another —
   * a state this screen could not have had while it opened on a toggle instead.
   */
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState(false);
  const [notArtist, setNotArtist] = useState(false);

  const manual = artist?.availabilitySource === 'manual';
  const week: Week | null = draftWeek ?? (artist?.windows as Week | undefined) ?? null;
  const slotMinutes: SlotLength = (draftSlot ??
    (artist?.slotMinutes as SlotLength | undefined) ??
    30) as SlotLength;

  /**
   * HER WEEK, READ ON OPEN — `GET /artists/me`.
   *
   * The read this screen went three merges without, while a comment above
   * asserted it did not exist. See section 1 of the header for what the
   * workaround cost a Google-synced artist.
   *
   * Failure taxonomy matches the write path exactly, and in the same order:
   * `reportFailure` first because a 401 is a dead session and not a screen
   * error; `not_an_artist` before the kind checks because it is a coded 404;
   * then `offline`; then ours. The pick-a-source state below stays as the
   * recovery for a failed read — choosing a source is a write that also returns
   * her row, so she is not stuck behind a read that will not complete.
   */
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    fetchMyArtist(accessToken, controller.signal)
      .then((row) => {
        if (!alive) return;
        setArtist(row);
      })
      .catch((err: unknown) => {
        if (!alive || controller.signal.aborted) return;
        if (reportFailure(err)) return;
        if (err instanceof ApiError) {
          if (err.code === 'not_an_artist') {
            setNotArtist(true);
            return;
          }
          if (err.kind === 'offline') {
            setOffline(true);
            return;
          }
          setFailed(err.message);
          return;
        }
        setFailed(copy.errorBody);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [accessToken, reportFailure]);

  const send = useCallback(
    async (patch: Parameters<typeof putMyAvailability>[0]) => {
      setBusy(true);
      setRefusal(null);
      setFailed(null);
      setOffline(false);
      setSaved(false);
      try {
        const row = await putMyAvailability(patch, accessToken);
        setArtist(row);
        // The server's row is the truth now, so the draft is dropped rather
        // than merged: a draft kept past a save is a second opinion about the
        // week, and it is the one that would win the next render.
        setDraftWeek(null);
        setDraftSlot(null);
        if (patch.windows || patch.slotMinutes) setSaved(true);
      } catch (err) {
        /*
          A DEAD SESSION IS NOT A SCREEN-LEVEL ERROR. `reportFailure` returns true
          when it ended the session, and the shell then swaps this screen for the
          PIN screen — the only remedy that helps. Without it a revoked PIN left an
          artist staring at an alert whose retry 401s for ever.
        */
        if (reportFailure(err)) return;
        if (!(err instanceof ApiError)) {
          setFailed(copy.errorBody);
          return;
        }
        if (err.code === 'not_an_artist') {
          setNotArtist(true);
          return;
        }
        /**
         * The two 409s, told apart, because the fix is different.
         *
         * `availability_is_synced` — her hours come from Google; switch to
         *    Manual first. The API's message says exactly that.
         * `google_not_connected` — she is trying to switch TO Google without a
         *    connected calendar, which reception has to set up in the dashboard.
         */
        if (err.code === 'availability_is_synced') {
          setRefusal({ title: copy.syncedRefusedTitle, body: err.message });
          return;
        }
        if (err.code === 'google_not_connected') {
          setRefusal({ title: copy.noCalendarTitle, body: err.message });
          return;
        }
        /*
          AFTER the code checks, and that order is the spec — `orderRefusal.ts`
          writes down why: the client maps 503 AND 504 to `offline`, so a coded
          refusal arriving on a 503 must not be read as a dead connection. Both
          409s above are code checks and therefore win.
        */
        if (err.kind === 'offline') {
          setOffline(true);
          return;
        }
        // Everything else keeps the server's sentence: `invalid_windows` names
        // the day and the reason ("Saturday closes at 10:00, at or before it
        // opens at 10:00"), which is more useful than anything written here.
        setFailed(err.message);
      } finally {
        setBusy(false);
      }
    },
    [accessToken, reportFailure],
  );

  // ------------------------------------------------------------ the editors --

  const patchDay = useCallback(
    (key: string, change: (day: Week[string]) => Week[string]) => {
      if (!week) return;
      const current = week[key];
      if (!current) return;
      setDraftWeek({ ...week, [key]: change(current) });
      setSaved(false);
    },
    [week],
  );

  const summary = useMemo(() => {
    if (!week) return { openDays: 0, hours: 0, slots: 0 };
    let openDays = 0;
    let minutes = 0;
    let slots = 0;
    for (const { key } of DAYS) {
      const day = week[key];
      if (!day?.open) continue;
      const span = toMinutes(day.to) - toMinutes(day.from);
      openDays += 1;
      minutes += span;
      slots += Math.floor(span / slotMinutes);
    }
    return { openDays, hours: minutes / 60, slots };
  }, [week, slotMinutes]);

  const dirty = draftWeek !== null || draftSlot !== null;

  if (notArtist) {
    return (
      <Shell onHome={onHome} staffFirstName={staffFirstName} staffHandle={staffHandle}>
        <Refusal title={copy.notArtistTitle} body={copy.notArtistBody} />
      </Shell>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <LinkButton label={copy.home} onPress={onHome} testID="schedule-home" />
        <Text style={[ui(12), styles.who]}>
          {staffFirstName} · {staffHandle}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Text style={display(24)}>{copy.schedule}</Text>
        <Text style={[ui(12.5), styles.sub]}>{copy.scheduleIntro}</Text>

        {/* design:407-410 — the source toggle. Also the screen's first read. */}
        <View style={styles.segment}>
          <SegmentButton
            label={copy.srcGoogle}
            active={artist !== null && !manual}
            disabled={busy}
            onPress={() => void send({ availabilitySource: 'google' })}
            testID="schedule-src-google"
          />
          <SegmentButton
            label={copy.srcManual}
            active={manual}
            disabled={busy}
            onPress={() => void send({ availabilitySource: 'manual' })}
            testID="schedule-src-manual"
          />
        </View>

        {/* design:412-415 — the banner under the toggle, verbatim either way. */}
        {artist !== null ? (
          <View style={[styles.banner, manual ? styles.bannerManual : styles.bannerGoogle]}>
            <View style={[styles.bannerDot, manual ? styles.dotManual : styles.dotGoogle]} />
            <Text style={[ui(12.5), styles.bannerText]}>
              {manual ? copy.srcManualNote : copy.srcGoogleNote}
            </Text>
          </View>
        ) : null}

        {refusal ? (
          <View style={styles.refusal} accessibilityRole="alert" testID="schedule-refusal">
            <Text style={[ui(14, '600'), styles.refusalTitle]}>{refusal.title}</Text>
            <Text style={[ui(12.5), styles.refusalBody]}>{refusal.body}</Text>
          </View>
        ) : null}

        {/*
          Her connection. `offlineColdBody` is INVENTED and authorised —
          DECISIONS.md § "The offline cold-load sentence" — and deliberately not
          `offlineBanner`, which promises a last update, nor `offlineBody`, which
          is charge-specific. The draft week is still on screen behind this.
        */}
        {offline ? (
          <View style={styles.refusal} accessibilityRole="alert" testID="schedule-offline">
            <Text style={[ui(14, '600'), styles.refusalTitle]}>{copy.offlineTitle}</Text>
            <Text style={[ui(12.5), styles.refusalBody]}>{copy.offlineColdBody}</Text>
          </View>
        ) : null}

        {failed ? (
          <View style={styles.refusal} accessibilityRole="alert" testID="schedule-failed">
            <Text style={[ui(14, '600'), styles.refusalTitle]}>{copy.errorTitle}</Text>
            <Text style={[ui(12.5), styles.refusalBody]}>{failed}</Text>
          </View>
        ) : null}

        {saved ? (
          <View style={styles.savedBanner} accessibilityRole="alert" testID="schedule-saved">
            <View style={[styles.bannerDot, styles.dotManual]} />
            <Text style={[ui(12.5), styles.bannerText]}>{copy.scheduleSaved}</Text>
          </View>
        ) : null}

        {/*
          The read, in flight. Layout-shaped rows rather than a spinner
          (interaction-spec §4) — and no figure anywhere, because the footer
          summary is derived from the week and a zero there would be a count
          she does not have yet.
        */}
        {loading ? (
          <View style={styles.body}>
            <SkeletonRows count={4} />
          </View>
        ) : null}

        {/*
          The RECOVERY state, no longer the first-open state. After a successful
          read `artist` is set and the week renders, so this shows only when the
          read failed — and choosing a source is a write that returns her row,
          which is why it is still worth offering rather than leaving her behind
          a read that will not complete.
        */}
        {!loading && artist === null ? (
          <View style={styles.body}>
            <EmptyState
              title={copy.pickSourceTitle}
              body={copy.pickSourceBody}
              testID="schedule-pick-source"
            />
          </View>
        ) : null}

        {/* design:417-425 — slot length, manual only. */}
        {artist !== null && manual ? (
          <View style={styles.slotBlock}>
            <Text style={[ui(11, '600'), styles.microLabel]}>{copy.slotLengthLabel}</Text>
            <View style={styles.slotChips}>
              {SLOT_LENGTHS.map((minutes) => (
                <Pressable
                  key={minutes}
                  onPress={() => {
                    setDraftSlot(minutes);
                    setSaved(false);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: minutes === slotMinutes }}
                  accessibilityLabel={copy.slotChip(minutes)}
                  testID={`schedule-slot-${minutes}`}
                  style={[styles.slotChip, minutes === slotMinutes && styles.slotChipOn]}
                >
                  <Text
                    style={[
                      ui(12.5, '600'),
                      minutes === slotMinutes ? styles.slotChipTextOn : styles.slotChipText,
                    ]}
                  >
                    {copy.slotChip(minutes)}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={[ui(11.5), styles.slotNote]}>{copy.slotNote(slotMinutes)}</Text>
          </View>
        ) : null}

        {/* design:427-460 — the seven day rows. */}
        {artist !== null && week ? (
          <View style={styles.days}>
            {DAYS.map(({ key, name, short }) => {
              const day = week[key];
              if (!day) return null;
              const span = toMinutes(day.to) - toMinutes(day.from);
              const slots = day.open ? Math.floor(span / slotMinutes) : 0;
              return (
                <View key={key} style={styles.dayCard} testID={`schedule-day-${key}`}>
                  <View style={styles.dayTop}>
                    <View style={styles.dayHead}>
                      <View style={[styles.dayBadge, day.open ? styles.dayBadgeOn : null]}>
                        <Text
                          style={[ui(12, '600'), day.open ? styles.dayBadgeTextOn : styles.dayBadgeText]}
                        >
                          {short}
                        </Text>
                      </View>
                      <View style={styles.dayNames}>
                        <Text style={ui(14, '600')}>{name}</Text>
                        <Text style={[ui(11.5), styles.dim]}>
                          {day.open
                            ? copy.daySummary(day.from, day.to, slots, slotMinutes)
                            : copy.dayOff}
                        </Text>
                      </View>
                    </View>

                    {manual ? (
                      /* design:435 — the toggle. `brand` as a track fill, which
                         is what a surface colour is for. */
                      <Pressable
                        onPress={() => patchDay(key, (d) => ({ ...d, open: !d.open }))}
                        accessibilityRole="switch"
                        accessibilityState={{ checked: day.open }}
                        accessibilityLabel={name}
                        testID={`schedule-toggle-${key}`}
                        style={styles.toggleHit}
                      >
                        <View style={[styles.track, day.open && styles.trackOn]}>
                          <View style={[styles.knob, day.open && styles.knobOn]} />
                        </View>
                      </Pressable>
                    ) : (
                      /*
                        design:436 — the Synced pill. STILL TAPPABLE, on purpose:
                        the tap sends the windows PUT the server refuses, and the
                        409 explains. See the header, §2.
                      */
                      <Pressable
                        onPress={() => void send({ windows: week })}
                        accessibilityRole="button"
                        accessibilityLabel={`${name} · ${day.open ? copy.synced : copy.off}`}
                        testID={`schedule-synced-${key}`}
                        style={[styles.pill, day.open ? styles.pillOn : styles.pillOff]}
                      >
                        <Text
                          style={[ui(11, '600'), day.open ? styles.pillTextOn : styles.pillTextOff]}
                        >
                          {day.open ? copy.synced : copy.off}
                        </Text>
                      </Pressable>
                    )}
                  </View>

                  {/* design:438-457 — the From/To steppers, open manual days only. */}
                  {manual && day.open ? (
                    <View style={styles.rangeRow}>
                      <Stepper
                        label={copy.windowFrom}
                        value={day.from}
                        onChange={(delta) =>
                          patchDay(key, (d) => ({ ...d, from: toHhmm(toMinutes(d.from) + delta) }))
                        }
                        testID={`schedule-from-${key}`}
                      />
                      <Stepper
                        label={copy.windowTo}
                        value={day.to}
                        onChange={(delta) =>
                          patchDay(key, (d) => ({ ...d, to: toHhmm(toMinutes(d.to) + delta) }))
                        }
                        testID={`schedule-to-${key}`}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}
      </ScrollView>

      {/* design:463-468 — the running summary and the save. */}
      {artist !== null && week ? (
        <View style={styles.footer}>
          <SummaryRow label={copy.openDays} value={copy.openDaysValue(summary.openDays, 7)} />
          <SummaryRow label={copy.hoursPerWeek} value={copy.hoursValue(summary.hours)} />
          <SummaryRow
            label={copy.bookingSlots}
            value={copy.slotsValue(summary.slots)}
            last
          />
          <PrimaryButton
            label={manual ? copy.saveSchedule : copy.backToHome}
            disabled={busy}
            onPress={() => {
              if (!manual) {
                onHome();
                return;
              }
              // Slot length and windows go in ONE request. The API is built for
              // it, and two requests can leave the slot changed and the week not.
              void send({
                ...(dirty ? { windows: week } : { windows: week }),
                slotMinutes,
              });
            }}
            testID="schedule-save"
            style={styles.save}
          />
        </View>
      ) : null}
    </View>
  );
}

// ------------------------------------------------------------------- parts --

function Shell({
  children,
  onHome,
  staffFirstName,
  staffHandle,
}: {
  children: React.ReactNode;
  onHome: () => void;
  staffFirstName: string;
  staffHandle: string;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <LinkButton label={copy.home} onPress={onHome} testID="schedule-home" />
        <Text style={[ui(12), styles.who]}>
          {staffFirstName} · {staffHandle}
        </Text>
      </View>
      <View style={styles.centre}>{children}</View>
    </View>
  );
}

/** design:685-687 — the segmented control's two halves. */
function SegmentButton({
  label,
  active,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="tab"
      accessibilityState={{ selected: active, disabled }}
      accessibilityLabel={label}
      testID={testID}
      style={[styles.segmentButton, active && styles.segmentButtonOn]}
    >
      <Text style={[ui(13, '600'), active ? styles.segmentTextOn : styles.segmentText]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** design:440-455 — a labelled −/value/+ control. */
function Stepper({
  label,
  value,
  onChange,
  testID,
}: {
  label: string;
  value: string;
  onChange: (deltaMinutes: number) => void;
  testID: string;
}) {
  return (
    <View style={styles.stepper}>
      <Text style={[ui(10.5, '600'), styles.stepperLabel]}>{label}</Text>
      <View style={styles.stepperBox}>
        <Pressable
          onPress={() => onChange(-STEP_MINUTES)}
          accessibilityRole="button"
          accessibilityLabel={`${label} earlier`}
          testID={`${testID}-minus`}
          style={styles.stepButton}
          hitSlop={8}
        >
          <Text style={[ui(18, '600'), styles.stepButtonText]}>−</Text>
        </Pressable>
        <Text style={display(15, '600')}>{value}</Text>
        <Pressable
          onPress={() => onChange(STEP_MINUTES)}
          accessibilityRole="button"
          accessibilityLabel={`${label} later`}
          testID={`${testID}-plus`}
          style={styles.stepButton}
          hitSlop={8}
        >
          <Text style={[ui(18, '600'), styles.stepButtonText]}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

function SummaryRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.summaryRow, last && styles.summaryRowLast]}>
      <Text style={[ui(13), styles.dim]}>{label}</Text>
      <Text style={display(13, '600')}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface, paddingTop: 66 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
    marginBottom: 14,
  },
  who: { color: color.textMutedSoft },
  centre: { flex: 1, justifyContent: 'center', paddingHorizontal: 22, paddingBottom: 60 },
  scroll: { paddingHorizontal: 22, paddingBottom: 24 },
  sub: { color: color.textMuted, marginTop: 5, lineHeight: 19 },
  dim: { color: color.textMuted },
  body: { marginTop: 18 },
  microLabel: { color: color.textMutedLabel, letterSpacing: 0.88, textTransform: 'uppercase' },

  segment: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 18,
    padding: 4,
    borderRadius: 12,
    backgroundColor: color.surfaceAlt2,
  },
  segmentButton: {
    flex: 1,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 9,
  },
  segmentButtonOn: { backgroundColor: color.white },
  segmentText: { color: color.textMuted },
  segmentTextOn: { color: color.ink },

  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 14,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  bannerManual: { backgroundColor: color.brandTint },
  bannerGoogle: { backgroundColor: color.brandTint2 },
  bannerDot: { width: 8, height: 8, borderRadius: 4 },
  dotManual: { backgroundColor: color.brand },
  /**
   * design:809 — `#C9A24B` on the Google banner. No token names it: the closest,
   * `warnText`, is the Gold tier pill and reads brown rather than amber at 8px.
   * Held with its citation and REPORTED, exactly as the scanner's offline dot was
   * before trunk named it.
   *
   * `warnText`'s hex is no longer quoted here. It said `#8a6d3b`, and
   * `deriveBrandSet`'s contrast audit has since moved it to `#7A6034` (4.01 →
   * 4.82), so a comment asserting what the token "is" had gone false inside a file
   * that reads the token correctly everywhere. The reasoning survives the change
   * untouched: both values are brown, and the distance from amber is the point
   * rather than the digits.
   *
   * Worth flagging for whoever tokenises this line: `#C9A24B` is also
   * `tier.gold.dot`, which the audit left unchanged deliberately because it is
   * decoration rather than text. That is a real candidate for the token this wants,
   * and it is a `packages/tokens` change rather than a scanner one.
   */
  dotGoogle: { backgroundColor: '#C9A24B' },
  bannerText: { color: color.brandDeeper, flex: 1, lineHeight: 18 },

  refusal: {
    marginTop: 14,
    padding: 14,
    borderRadius: 12,
    backgroundColor: color.dangerBg,
  },
  refusalTitle: { color: color.dangerText },
  refusalBody: { color: color.dangerText, marginTop: 4, lineHeight: 18 },
  savedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 14,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: color.brandTint,
  },

  slotBlock: { marginTop: 18 },
  slotChips: { flexDirection: 'row', gap: 8, marginTop: 9 },
  slotChip: {
    flex: 1,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.borderControl,
  },
  // White on brandDeep, never on brand.
  slotChipOn: { backgroundColor: color.brandDeep, borderColor: color.brandDeep },
  slotChipText: { color: color.textMuted },
  slotChipTextOn: { color: color.white },
  slotNote: { color: color.textMuted, marginTop: 8 },

  days: { gap: 10, marginTop: 16 },
  dayCard: {
    padding: 15,
    borderRadius: 14,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  dayTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  dayHead: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 },
  dayBadge: {
    width: 30,
    height: 30,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt2,
  },
  dayBadgeOn: { backgroundColor: color.brandTint },
  dayBadgeText: { color: color.textMutedSoft },
  dayBadgeTextOn: { color: color.brandDeep },
  dayNames: { flex: 1, minWidth: 0, gap: 1 },

  toggleHit: {
    minWidth: MIN_TAP_TARGET,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  track: { width: 44, height: 26, borderRadius: 999, backgroundColor: color.toggleOff },
  // `brand` as a track fill — a surface colour doing a surface's job.
  trackOn: { backgroundColor: color.brand },
  knob: {
    position: 'absolute',
    top: 3,
    left: 3,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: color.white,
  },
  knobOn: { left: 21 },

  pill: { paddingVertical: 5, paddingHorizontal: 11, borderRadius: radius.pill, minHeight: 30, justifyContent: 'center' },
  pillOn: { backgroundColor: color.brandTint },
  pillOff: { backgroundColor: color.surfaceAlt2 },
  pillTextOn: { color: color.brandDeep },
  pillTextOff: { color: color.textMutedSoft },

  rangeRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 13 },
  stepper: { flex: 1 },
  stepperLabel: {
    color: color.textMutedSoft,
    letterSpacing: 0.66,
    textTransform: 'uppercase',
    marginBottom: 5,
  },
  stepperBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: color.borderControl,
  },
  stepButton: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt2,
  },
  stepButtonText: { color: color.brandDeep, lineHeight: 20 },

  footer: {
    backgroundColor: color.white,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
    paddingHorizontal: 22,
    paddingTop: 16,
    paddingBottom: 30,
  },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  summaryRowLast: {
    paddingBottom: 12,
    marginBottom: 0,
    borderBottomWidth: 1,
    borderBottomColor: color.hairline,
  },
  save: { marginTop: 14 },
});
