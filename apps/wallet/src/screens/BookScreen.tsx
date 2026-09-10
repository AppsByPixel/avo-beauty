/**
 * Wallet · Book. design/AVO Wallet Home.dc.html § BOOK (:521-618).
 *
 * Service → artist → day and time → review → confirmed, with the deposit held
 * by the server at the moment of confirmation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOUR STATES ARE NOT APPENDED TO THIS SCREEN
 * ═══════════════════════════════════════════════════════════════════════════
 * Each step renders from a `LoadState`, so loading is a skeleton shaped like
 * the rows it replaces, a failure is a failure screen with a retry, and an
 * empty day is a sentence rather than an area of nothing. The one that matters
 * most is the third:
 *
 *   open: false, no slots     → EMPTY. "This artist is not working then."
 *   slots, none available     → FULL. The grid is drawn, every chip struck
 *                               through, because the strike is the message.
 *   slots, some available     → the grid.
 *
 * A fully-booked day is NOT an empty state. Hiding it would tell a customer the
 * salon is shut when the truth is that somebody got there first.
 */

import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native';
import { formatMoney, type Fils, type Member, type Salon } from '@avo/types';
import { MIN_TAP_TARGET, WHITE, color, onBrandFill, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { focusable } from '../theme/focus';
import { FailureScreen } from '../components/FailureScreen';
import { PrimaryButton } from '../components/Buttons';
import { TopUpSheet } from '../components/TopUpSheet';
import { useTopUp } from '../state/useTopUp';
import { DEFAULT_TOP_UP_AMOUNT } from '../domain/topup';
import { fils } from '@avo/types';
import {
  BranchChip,
  DayChip,
  DepositCard,
  EmptyPanel,
  GridSkeleton,
  Note,
  ProgressBar,
  ReviewRow,
  RowSkeleton,
  ServiceRow,
  ShortfallBanner,
  SlotChip,
  StepLabel,
  ArtistRow,
} from '../components/booking/BookingParts';
import {
  TOTAL_STEPS,
  useBooking,
  type LoadState,
  type RescheduleTarget,
} from '../state/useBooking';
import {
  branchChoiceLabel,
  sameChoice,
  type BranchChoice,
} from '../domain/branchPicker';
import {
  artistName,
  formatWhen,
  hasGrid,
  isFullyTaken,
  serviceName,
  splitRuns,
} from '../domain/booking';

interface Props {
  salon: Salon;
  member: Member;
  /** Leave the flow — the bottom nav's Home, or the confirmed screen's button. */
  onHome: () => void;
  /** Re-read the wallet after a deposit moves. Never a locally computed balance. */
  onBooked: () => void;
  /** Set when the flow was entered from the Upcoming card's Reschedule button. */
  reschedule?: RescheduleTarget | undefined;
  /** Fired with the toast to show once the flow leaves. */
  onToast: (message: string) => void;
}

export function BookScreen({ salon, member, onHome, onBooked, reschedule, onToast }: Props) {
  const { lang, copy } = useLanguage();
  const flow = useBooking({ salon, reschedule, onBooked });
  const [topUpAmount] = useState<Fils>(DEFAULT_TOP_UP_AMOUNT);

  /**
   * The top-up the shortfall banner opens.
   *
   * It is a SECOND `useTopUp` instance, not Home's — the sheet has to be able
   * to open over the Book flow without navigating away, because navigating away
   * would lose the service, artist and slot she has already chosen and the
   * whole point of the one-tap top-up is that she comes back to the same
   * booking.
   */
  const topUp = useTopUp({
    onSucceeded: useCallback(() => {
      // The balance changed. Home re-reads it, and the stale 402 is cleared so
      // the next Confirm is a real attempt rather than a repeat of the refusal.
      onBooked();
      flow.clearShortfall();
    }, [onBooked, flow]),
  });

  const salonModuleOff = !salon.modules.booking;

  // ------------------------------------------------------------- the shell --

  const onBack = useCallback(() => {
    if (flow.step === 'service' || (flow.rescheduling && flow.step === 'day')) {
      onHome();
      return;
    }
    flow.back();
  }, [flow, onHome]);

  if (salonModuleOff) {
    /**
     * The module gate, drawn honestly.
     *
     * The server enforces it too — `POST /bookings` answers
     * `409 booking_not_enabled` regardless of what the client shows — and that
     * is the point of non-negotiable #7: this screen is the courtesy, the 409
     * is the control.
     */
    return (
      <Shell>
        <EmptyPanel
          title={copy.bookingOffTitle}
          body={copy.bookingOffBody}
          testID="book-module-off"
        />
        <PrimaryButton label={copy.viewHome} onPress={onHome} style={styles.cta} />
      </Shell>
    );
  }

  if (flow.step === 'confirmed' && flow.result) {
    return (
      <Shell>
        <Confirmed
          salon={salon}
          startsAt={flow.result.booking.startsAt}
          depositFils={flow.result.booking.depositFils}
          serviceName={flow.selectedService ? serviceName(flow.selectedService, lang) : '—'}
          artistLabel={flow.selectedArtist ? artistName(flow.selectedArtist, lang) : '—'}
          rescheduled={flow.rescheduling}
          onDone={() => {
            onToast(
              flow.rescheduling
                ? copy.rescheduleToast
                : copy.bookedToast(formatMoney(flow.result!.booking.depositFils as Fils, lang)),
            );
            onHome();
          }}
        />
      </Shell>
    );
  }

  return (
    <Shell
      overlay={
        <TopUpSheet
          stage={topUp.stage}
          controller={topUp}
          // The Book flow never labels a balance "new" — that row belongs to
          // the top-up's own success screen and it re-reads the member itself.
          newBalanceFils={null}
          tier={member.tier}
        />
      }
    >
      {/* design:526-531 — back, title, step counter, then the progress bar. */}
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          dataSet={focusable}
          hitSlop={12}
          testID="book-back"
          style={styles.backButton}
        >
          <Text style={[text('bodyL', lang), styles.backText]}>{copy.back}</Text>
        </Pressable>
        <Text style={[text('displayM', lang), styles.title]}>{copy.bookTitle}</Text>
        <Text style={[text('body', lang), styles.stepCount]}>
          {copy.bookStep(flow.stepIndex, TOTAL_STEPS)}
        </Text>
      </View>
      <ProgressBar step={flow.stepIndex} total={TOTAL_STEPS} />

      {flow.step === 'service' && (
        <Step
          state={flow.services}
          onRetry={flow.retryLoad}
          skeleton={<RowSkeleton />}
          label={copy.chooseService}
        >
          {(services) => (
            <View style={styles.rows}>
              {services.map((service) => (
                <ServiceRow
                  key={service.id}
                  service={service}
                  selected={flow.selectedService?.id === service.id}
                  onPick={() => flow.pickService(service)}
                />
              ))}
            </View>
          )}
        </Step>
      )}

      {flow.step === 'artist' && (
        <Step
          state={flow.artists}
          onRetry={flow.retryLoad}
          skeleton={<RowSkeleton count={4} />}
          label={copy.chooseArtist}
        >
          {(artists) => (
            <>
              <BranchStrip flow={flow} salon={salon} />
              {artists.length === 0 ? (
                <ArtistsEmpty flow={flow} />
              ) : (
                <View style={styles.rows}>
                  {artists.map((artist) => (
                    <ArtistRow
                      key={artist.id}
                      artist={artist}
                      selected={flow.selectedArtist?.id === artist.id}
                      onPick={() => flow.pickArtist(artist)}
                    />
                  ))}
                </View>
              )}
            </>
          )}
        </Step>
      )}

      {flow.step === 'day' && (
        <>
          <StepLabel>{copy.chooseDay}</StepLabel>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.strip}
          >
            {flow.strip.map((day) => (
              <DayChip
                key={day.date}
                day={day}
                selected={flow.selectedDate === day.date}
                onPick={() => flow.pickDay(day.date)}
              />
            ))}
          </ScrollView>

          <SlotSection flow={flow} />
        </>
      )}

      {flow.step === 'review' && flow.selectedSlot && (
        <>
          <StepLabel>{copy.review}</StepLabel>
          <View style={styles.reviewCard}>
            <ReviewRow
              label={copy.svcRow}
              value={flow.selectedService ? serviceName(flow.selectedService, lang) : '—'}
            />
            <ReviewRow
              label={copy.artistRow}
              value={flow.selectedArtist ? artistName(flow.selectedArtist, lang) : '—'}
            />
            <ReviewRow
              label={copy.whenRow}
              value={formatWhen(flow.selectedSlot.startsAt, salon.timezone, lang)}
              last
            />
          </View>

          {/*
            The remainder — the price of the service minus the deposit — is
            arithmetic on two amounts the SERVER sent, done in fils and clamped
            at zero. It is not a balance and it is not what will be charged: the
            actual charge happens at the counter through POST /charges, against
            the salon's own basket. design:1536 does the same subtraction.
          */}
          <DepositCard
            depositFils={salon.depositFils}
            remainderFils={
              flow.selectedService
                ? Math.max(0, flow.selectedService.priceFils - salon.depositFils)
                : null
            }
          />

          {flow.shortfallFils !== null ? (
            <>
              <ShortfallBanner shortfallFils={flow.shortfallFils} />
              <Text style={[text('body', lang), styles.shortHint]}>{copy.depShort}</Text>
            </>
          ) : null}

          {flow.confirmFailure ? <ConfirmFailure failure={flow.confirmFailure} /> : null}
        </>
      )}

      {flow.step !== 'confirmed' ? <Cta flow={flow} salon={salon} topUp={topUp} amount={topUpAmount} /> : null}

      <View style={styles.footerSpace} />
    </Shell>
  );
}

// -------------------------------------------------------------- the states --

/**
 * One step's four states, in one place, so no step can quietly ship with three
 * of them. interaction-spec.md §4.
 */
function Step<T>({
  state,
  onRetry,
  skeleton,
  label,
  children,
}: {
  state: LoadState<T>;
  onRetry: () => void;
  skeleton: React.ReactNode;
  label: string;
  children: (data: T) => React.ReactNode;
}) {
  if (state.status === 'loading') {
    return (
      <>
        <StepLabel>{label}</StepLabel>
        {skeleton}
      </>
    );
  }
  if (state.status === 'failed') {
    return (
      <FailureScreen
        kind={state.failure.kind}
        message={state.failure.message}
        reference={state.failure.reference}
        onRetry={onRetry}
        retrying={false}
      />
    );
  }
  return (
    <>
      <StepLabel>{label}</StepLabel>
      {children(state.data)}
    </>
  );
}

/**
 * STEP 2's BRANCH FILTER -- the branch switch Aftab asked for. (migration 0044)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT RENDERS NOTHING MOST OF THE TIME, AND THAT IS THE FEATURE
 * ═══════════════════════════════════════════════════════════════════════════
 * `flow.branchOptions` is empty for a single-branch salon, for a salon whose
 * artists are all unassigned (the common case today -- migration 0044
 * deliberately did not guess), and while the roster's split is still unknown.
 * `domain/branchPicker.ts` owns that rule and argues each of the three
 * suppressions. Here it is one early return, so there is no second place for
 * the rule to be half-applied.
 *
 * A SINGLE-BRANCH SALON SEES NO PICKER at all: one option is not a choice, and
 * `resolveBranch` already treats a lone open branch as ESTABLISHED, so those
 * bookings are correctly attributed with nothing on screen.
 *
 * The horizontal `ScrollView` and `styles.strip` are the day strip's own
 * (design:568-572), reused rather than restyled -- see `BranchChip`.
 */
function BranchStrip({
  flow,
  salon,
}: {
  flow: ReturnType<typeof useBooking>;
  salon: Salon;
}) {
  const { lang, copy } = useLanguage();
  if (flow.branchOptions.length === 0) return null;

  const label = (choice: BranchChoice) =>
    branchChoiceLabel(choice, salon.branches, lang, copy);

  return (
    <View style={styles.branchBlock}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.strip}
      >
        {flow.branchOptions.map((choice) => (
          <BranchChip
            key={choice.kind === 'branch' ? choice.branchId : choice.kind}
            label={label(choice)}
            selected={sameChoice(flow.branchChoice, choice)}
            onPick={() => flow.pickBranch(choice)}
            testID={`book-branch-${choice.kind === 'branch' ? choice.branchId : choice.kind}`}
          />
        ))}
      </ScrollView>

      {/*
        THE NOTE IS WHAT STOPS THE THIRD GROUP BEING A HALF-TRUTH.
        "Other artists" says these are not at any of the branches beside it; the
        note says why, in a customer's words, without using the API's
        "unassigned". Shown only while that group is selected -- on a branch chip
        it would be a caveat about rows she is not looking at.
      */}
      {flow.branchChoice.kind === 'unassigned' ? (
        <View style={styles.branchNote}>
          <Note tone="wash">{copy.branchFilterOtherNote}</Note>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Step 2's EMPTY state, which it did not have before this slice.
 *
 * Two different emptinesses, and telling them apart is the whole value:
 *
 *   A BRANCH WITH NO ARTISTS. She filtered, and that location has nobody
 *   bookable. The body points at the way out -- another branch, or All -- because
 *   an empty state that names nothing to do is a dead end. This is reachable by
 *   design rather than by accident: `branchChoices` keeps a chip for every open
 *   branch even when its roster is empty, on the grounds that a MISSING chip
 *   reads as a branch that does not exist while an empty one reads as a branch
 *   with nobody in today. Only one of those is true.
 *
 *   THE SALON HAS NOBODY AT ALL. Nothing to filter and nothing to suggest, so it
 *   says so plainly. Lumiere in the seed is exactly this -- two branches, zero
 *   artists -- and before this slice it rendered as an empty area with a
 *   Continue button that did nothing, which reads as a screen that failed to
 *   load.
 *
 * `EmptyPanel` is States:112-119's own shape: name the thing, offer the one
 * action, no illustration.
 */
function ArtistsEmpty({ flow }: { flow: ReturnType<typeof useBooking> }) {
  const { copy } = useLanguage();
  const filtered = flow.branchChoice.kind !== 'all';
  return (
    <EmptyPanel
      title={filtered ? copy.branchEmptyTitle : copy.artistsEmptyTitle}
      body={filtered ? copy.branchEmptyBody : copy.artistsEmptyBody}
      testID={filtered ? 'book-branch-empty' : 'book-artists-empty'}
    />
  );
}

/**
 * The grid, split at the afternoon closure.
 *
 * Two labelled groups, Morning and Evening, found from the data rather than
 * from a hard-coded 13:00 — see domain/booking.ts § splitRuns.
 */
function SlotSection({ flow }: { flow: ReturnType<typeof useBooking> }) {
  const { copy } = useLanguage();
  const { availability } = flow;

  const reasonLabel = useCallback(
    (reason: string | undefined): string | null => {
      // The reason is spoken, not drawn: a struck-through chip is a visual
      // convention, and a reader that only heard "16:45" would hear a free slot.
      if (!reason) return null;
      return reason === 'booked' || reason === 'busy' ? copy.slotTakenTitle : copy.bookEmptyDayTitle;
    },
    [copy],
  );

  const runs = useMemo(
    () => (availability.status === 'ready' ? splitRuns(availability.data.slots) : []),
    [availability],
  );

  if (availability.status === 'loading') {
    return (
      <>
        <StepLabel>{copy.morning}</StepLabel>
        <GridSkeleton count={4} />
      </>
    );
  }

  if (availability.status === 'failed') {
    return (
      <FailureScreen
        kind={availability.failure.kind}
        message={availability.failure.message}
        reference={availability.failure.reference}
        onRetry={flow.retryLoad}
        retrying={false}
      />
    );
  }

  const day = availability.data;

  if (!hasGrid(day)) {
    return (
      <View style={styles.gridSpace}>
        <EmptyPanel
          title={copy.bookEmptyDayTitle}
          body={copy.bookEmptyDayBody}
          testID="book-day-empty"
        />
      </View>
    );
  }

  return (
    <>
      {/*
        THE FALLBACK, SURFACED.

        `hoursSource: 'salon_hours'` means this artist is marked as syncing from
        Google and her calendar could not actually be read, so the times below
        are the SALON's rather than hers. The API over-offers deliberately — an
        over-offer is a booking the salon can move, an under-offer is revenue
        that silently never happened — and the whole defence of that choice is
        that it is never silent. This is where it stops being silent for the
        customer.
      */}
      {day.hoursSource === 'salon_hours' ? <Note tone="wash">{copy.availFallback}</Note> : null}

      {isFullyTaken(day) ? (
        <View style={styles.gridSpace}>
          <EmptyPanel
            title={copy.bookFullDayTitle}
            body={copy.bookFullDayBody}
            testID="book-day-full"
          />
        </View>
      ) : null}

      {runs.map((run, index) => (
        <View key={run.slots[0]?.startsAt ?? index}>
          <View style={styles.groupLabel}>
            <StepLabel>{index === 0 ? copy.morning : copy.evening}</StepLabel>
          </View>
          <View style={styles.grid}>
            {run.slots.map((slot) => (
              <SlotChip
                key={slot.startsAt}
                slot={slot}
                selected={flow.selectedSlot?.startsAt === slot.startsAt}
                onPick={() => flow.pickSlot(slot)}
                reasonLabel={reasonLabel(slot.reason)}
              />
            ))}
          </View>
        </View>
      ))}
    </>
  );
}

/**
 * A refusal on confirm. Explains; the CTA below is what retries.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `change_window_closed` IS HANDLED HERE, NOT ONLY ON THE UPCOMING CARD
 * ═══════════════════════════════════════════════════════════════════════════
 * It was not, and driving a real reschedule inside the hour is what showed it:
 * the server refused correctly, and this panel titled the refusal
 * "We couldn't load your wallet" — the COLD-LOAD failure title, which says
 * nothing about the deposit and invites a retry that cannot work.
 *
 * A reschedule is a change to an existing appointment, so every refusal the
 * Upcoming card can meet, this panel can meet too. Falling back to `errorTitle`
 * for an unrecognised code was the mistake: `errorTitle` means "we failed", and
 * a 409 means "you can't", which interaction-spec.md §4 is explicit are
 * different screens. The fallback is now the API's own sentence under a neutral
 * heading, and the codes that have written copy get it.
 */
function ConfirmFailure({ failure }: { failure: { code: string | null; message: string } }) {
  const { lang, copy } = useLanguage();
  const taken = failure.code === 'slot_taken' || failure.code === 'slot_past';
  const off = failure.code === 'booking_not_enabled';
  const windowClosed = failure.code === 'change_window_closed';

  const title = taken
    ? copy.slotTakenTitle
    : off
      ? copy.bookingOffTitle
      : windowClosed
        ? copy.changeClosedTitle
        : // Not `errorTitle` — that is the cold-load screen's words and offers a
          // retry. This is a refusal, and the server wrote a sentence for it.
          copy.blockedTitle;

  const body = taken
    ? copy.slotTakenBody
    : off
      ? copy.bookingOffBody
      : windowClosed
        ? copy.changeClosedBody
        : failure.message;

  return (
    <View style={styles.confirmFailure} accessibilityRole="alert" testID="book-confirm-failure">
      <Text style={[text('bodyL', lang), styles.confirmFailureTitle]}>{title}</Text>
      <Text style={[text('body', lang), styles.confirmFailureBody]}>{body}</Text>
    </View>
  );
}

// ----------------------------------------------------------------- the CTA --

/**
 * design:1549-1558 — one button, four labels.
 *
 *   step 1/2   Continue, enabled once something is chosen
 *   step 3     Review booking, enabled once a slot is chosen
 *   step 4     Confirm · hold <deposit>  — or, when the server has said she is
 *              short, "Top up to book", which opens the sheet instead.
 */
function Cta({
  flow,
  salon,
  topUp,
  amount,
}: {
  flow: ReturnType<typeof useBooking>;
  salon: Salon;
  topUp: ReturnType<typeof useTopUp>;
  amount: Fils;
}) {
  const { lang, copy } = useLanguage();

  if (flow.step === 'review') {
    if (flow.shortfallFils !== null) {
      /**
       * ONE TAP TO THE TOP-UP, AND THE AMOUNT IS THE DEFAULT RATHER THAN THE
       * SHORTFALL.
       *
       * The shortfall is what she is missing; the top-up amounts are the
       * salon's own tiles, and they carry the tier bonus. Pre-filling the exact
       * shortfall would offer her the one amount that earns nothing and leaves
       * her at zero, which is worse for her and for the salon. The banner above
       * names the shortfall so the choice is informed.
       */
      return (
        <PrimaryButton
          label={copy.bookTopUpCta}
          onPress={() => topUp.open(amount)}
          testID="book-topup"
          style={styles.cta}
        />
      );
    }
    return (
      <PrimaryButton
        label={
          flow.rescheduling
            ? copy.reschedule
            : copy.bookConfirmCta(formatMoney(fils(salon.depositFils), lang))
        }
        onPress={flow.confirm}
        disabled={flow.submitting || !flow.selectedSlot}
        testID="book-confirm"
        style={styles.cta}
      />
    );
  }

  const enabled =
    flow.step === 'service'
      ? flow.selectedService !== null
      : flow.step === 'artist'
        ? flow.selectedArtist !== null
        : flow.selectedSlot !== null;

  return (
    <PrimaryButton
      label={flow.step === 'day' ? copy.bookReviewCta : copy.bookContinue}
      onPress={flow.next}
      disabled={!enabled}
      testID="book-next"
      style={styles.cta}
    />
  );
}

// ----------------------------------------------------------- step five ------

/**
 * design:602-614 — the confirmed screen.
 *
 * THE ONE-HOUR RULE IS STATED HERE ALONGSIDE THE DESIGN'S OWN 24-HOUR LINE.
 *
 * `cancelPolicy` (design:1245 / :1352) says "Free to cancel up to 24h before".
 * `reschedNote` (design:1180 / :1287) says "Free until an hour before". They
 * contradict each other, they are both the designer's words, and the API
 * implements ONE HOUR — `env.bookingChangeWindowMinutes`, refused as
 * `409 change_window_closed`.
 *
 * Neither string is edited: a lane rewriting product copy to resolve a product
 * contradiction is how the contradiction stops being visible to the person who
 * has to resolve it. Both are shown, with the one the server actually enforces
 * second and last, so a customer reading this screen is not told only the
 * number that is wrong. Reported — it is a client decision which one is right.
 */
function Confirmed({
  salon,
  startsAt,
  depositFils,
  serviceName,
  artistLabel,
  rescheduled,
  onDone,
}: {
  salon: Salon;
  startsAt: string;
  depositFils: number;
  serviceName: string;
  artistLabel: string;
  rescheduled: boolean;
  onDone: () => void;
}) {
  const { lang, copy } = useLanguage();
  return (
    <View style={styles.confirmed} testID="book-confirmed">
      <View style={styles.tickBadge}>
        <Text style={styles.tickBadgeMark}>✓</Text>
      </View>
      <Text style={[text('displayM', lang), styles.confirmedTitle]}>{copy.booked}</Text>
      <Text style={[text('body', lang), styles.confirmedSub]}>
        {serviceName} · {artistLabel}
      </Text>

      <View style={styles.confirmedCard}>
        <ReviewRow label={copy.whenRow} value={formatWhen(startsAt, salon.timezone, lang)} />
        <ReviewRow
          label={copy.depositHeld}
          value={formatMoney(depositFils as Fils, lang)}
          last={rescheduled}
        />
        {/*
          design:610 — the WhatsApp confirmation line.

          Shown on a NEW booking only. A reschedule does not queue a fresh
          confirmation in the API today, and a line claiming a message that was
          never sent is worse than no line: she waits for it.
        */}
        {!rescheduled ? (
          <View style={styles.waRow}>
            <View style={styles.waDot} />
            <Text style={[text('body', lang), styles.waText]}>{copy.waConfirm}</Text>
          </View>
        ) : null}
      </View>

      <Text style={[text('bodyS', lang), styles.policy]}>{copy.cancelPolicy}</Text>
      <Text style={[text('bodyS', lang), styles.policy]}>{copy.reschedNote}</Text>

      <PrimaryButton label={copy.viewHome} onPress={onDone} style={styles.cta} testID="book-done" />
    </View>
  );
}

// --------------------------------------------------------------- the frame --

function Shell({ children, overlay }: { children: React.ReactNode; overlay?: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.frame}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
        {overlay}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  // interaction-spec.md §1 — the wallet is a fixed-width app screen, centred on
  // a desktop browser rather than stretched. Same frame as Home.
  frame: { flex: 1, width: '100%', maxWidth: 402, alignSelf: 'center', backgroundColor: color.surface },
  scroll: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 40 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 14,
  },
  backButton: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', marginVertical: -10 },
  backText: { color: color.brandDeep, fontWeight: '600' },
  title: { color: color.ink },
  stepCount: { color: color.textMuted, fontWeight: '600' },

  rows: { gap: 9 },
  strip: { gap: 9, paddingBottom: 4, paddingHorizontal: 1 },
  /**
   * The strip sits directly above the roster, which has no top margin of its
   * own -- step 3 gets away without this because `SlotSection`'s first group
   * label carries `marginTop: 18`. One block owns the gap so the note, which is
   * conditional, cannot double it.
   */
  branchBlock: { marginBottom: 12 },
  branchNote: { marginTop: 10 },
  groupLabel: { marginTop: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  gridSpace: { marginTop: 16 },

  reviewCard: {
    paddingHorizontal: 18,
    paddingVertical: 6,
    borderRadius: radius.cardLg,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  shortHint: { color: color.textMuted, marginTop: 8, marginHorizontal: 2 },

  confirmFailure: {
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: color.dangerBg,
  },
  confirmFailureTitle: { color: color.dangerText, fontWeight: '600' },
  confirmFailureBody: { color: color.dangerText, marginTop: 4, lineHeight: 19 },

  cta: { marginTop: 22 },

  confirmed: { alignItems: 'center', paddingTop: 30, paddingHorizontal: 6 },
  tickBadge: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: onBrandFill.backgroundColor,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickBadgeMark: { color: WHITE, fontSize: 34, fontWeight: '700', lineHeight: 40 },
  confirmedTitle: { color: color.ink, marginTop: 20, textAlign: 'center' },
  confirmedSub: { color: color.textMuted, marginTop: 6, textAlign: 'center' },
  confirmedCard: {
    alignSelf: 'stretch',
    marginTop: 24,
    paddingHorizontal: 18,
    paddingVertical: 6,
    borderRadius: radius.cardLg,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  waRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 13,
    borderTopWidth: 1,
    borderTopColor: color.hairlineInner,
  },
  waDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.success },
  waText: { color: color.textMuted, flex: 1 },
  policy: { color: color.textMutedSoft, marginTop: 12, textAlign: 'center', lineHeight: 19 },

  footerSpace: { height: 24 },
});
