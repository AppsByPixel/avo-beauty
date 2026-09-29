/**
 * Wallet · Book. design/AVO Wallet Home.dc.html § BOOK (:521-618).
 *
 * Branch → service → artist → day and time → review → confirmed, with the
 * deposit held by the server at the moment of confirmation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BRANCH STEP MOST SALONS NEVER SEE -- AND WHY IT IS FIRST
 * ═══════════════════════════════════════════════════════════════════════════
 * The design draws three numbered steps and no branch step, and the product
 * spec (AVO-Beauty-Product-Description-v2.md:41) reads "service → artist →
 * day → time slot → confirm". Aftab added a branch step after testing the app,
 * and then fixed its place himself (W1: "In book, it should be branch
 * selection then service, then staff"). Branch first is therefore the
 * authorised order, not drift from the spec.
 *
 * It is CONDITIONAL, and the condition is the whole feature: a salon with one
 * open branch is never asked, opens on the service exactly as before, and its
 * counter reads "Step 1 of 4". That is why the header below reads
 * `flow.totalSteps` and not `TOTAL_STEPS` — the constant is the ceiling, the
 * controller has the answer.
 *
 * AT A MULTI-BRANCH SALON THE FIRST SCREEN WAITS FOR THE ROSTER. Whether step
 * 1 is the branch or the service depends on a read that has not landed when
 * Book opens, so the flow opens on `'entry'` — header, empty track, no
 * counter, a skeleton — and then on the right step, once. Never the service
 * first and then the branch. `state/useBooking.ts § the entry gate` argues it,
 * including its failure state, which is the ordinary failure screen with a
 * retry because it is now the first thing she sees.
 *
 * THE STEP DOES NOT ASSERT A BRANCH. It filters the roster; the booking's
 * branch is still derived server-side from the artist. There is no `branchId`
 * in the body of `POST /bookings` and this change did not add one — which is
 * also why the review step does not list a branch row.
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
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native';
import { formatMoney, type Fils, type Member, type Salon } from '@avo/types';
import { MIN_TAP_TARGET, WHITE, color, onBrandFill, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { focusable } from '../theme/focus';
import { FailureScreen } from '../components/FailureScreen';
import { PrimaryButton, SecondaryButton } from '../components/Buttons';
import { PolicyBlock } from '../components/booking/PolicyBlock';
import type { BookingView } from '../api/booking';
import { TopUpSheet } from '../components/TopUpSheet';
import { useTopUp } from '../state/useTopUp';
import { useNewBalanceAfterTopUp } from '../state/useNewBalanceAfterTopUp';
import { DEFAULT_TOP_UP_AMOUNT } from '../domain/topup';
import { fils } from '@avo/types';
import {
  BranchRow,
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
// `TOTAL_STEPS` is deliberately NOT imported: it is the flow's ceiling, and the
// number this screen prints is `flow.totalSteps`, which is 4 at a salon with one
// open branch. Importing the constant here is how the counter would go back to
// promising a step she cannot reach.
import { useBooking, type LoadState, type RescheduleTarget } from '../state/useBooking';
import {
  branchChoiceLabel,
  sameChoice,
  type BranchChoice,
} from '../domain/branchPicker';
import {
  artistName,
  formatWhen,
  hasGrid,
  holdsDeposit,
  isFullyTaken,
  serviceName,
  splitRuns,
} from '../domain/booking';
import { brandedStyles } from '../theme/live';

interface Props {
  salon: Salon;
  member: Member;
  /**
   * WHEN the read `member` came out of landed — `useWalletHome`'s `fetchedAt`,
   * passed down from the shell that owns the read.
   *
   * For one row: the top-up success screen's "New balance". `member.balanceFils`
   * alone cannot tell "the server has answered since she paid" from "this is the
   * figure from before the payment", and only the first may carry that label
   * (#2). See `state/useNewBalanceAfterTopUp.ts`.
   */
  memberFetchedAt: number | null;
  /** Leave the flow — the bottom nav's Home, or the confirmed screen's button. */
  onHome: () => void;
  /** Re-read the wallet after a deposit moves. Never a locally computed balance. */
  onBooked: () => void;
  /** Set when the flow was entered from the Upcoming card's Reschedule button. */
  reschedule?: RescheduleTarget | undefined;
  /** Fired with the toast to show once the flow leaves. */
  onToast: (message: string) => void;
}

export function BookScreen({
  salon,
  member,
  memberFetchedAt,
  onHome,
  onBooked,
  reschedule,
  onToast,
}: Props) {
  const { lang, copy } = useLanguage();
  const flow = useBooking({ salon, reschedule, onBooked });
  const [topUpAmount] = useState<Fils>(DEFAULT_TOP_UP_AMOUNT);

  /**
   * "New balance" for the top-up sheet below. The stamp half is here because
   * only this screen knows when ITS top-up settled; the comparison is in the
   * hook because Home and Shop ask the identical question.
   */
  const balance = useNewBalanceAfterTopUp(member.balanceFils, memberFetchedAt);
  const markSucceeded = balance.markSucceeded;

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
      // The stamp is what lets the success screen tell that re-read from the
      // `member` already in props, which is the figure from BEFORE she paid.
      markSucceeded();
      onBooked();
      flow.clearShortfall();
    }, [markSucceeded, onBooked, flow]),
  });

  const salonModuleOff = !salon.modules.booking;

  // ------------------------------------------------------------- the shell --

  /**
   * Back LEAVES from the first step, whichever that is: `branch` at a salon
   * with a branch step, `service` at one without, `day` on a reschedule — and
   * from `'entry'`, where she has not reached a step at all. `firstStep` is
   * the machine's answer, so this cannot disagree with `flow.back()` about
   * where the flow starts.
   */
  const onBack = useCallback(() => {
    if (flow.step === 'entry' || flow.step === flow.firstStep) {
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
          policy={flow.result.booking.policy}
          serviceName={flow.selectedService ? serviceName(flow.selectedService, lang) : '—'}
          artistLabel={flow.selectedArtist ? artistName(flow.selectedArtist, lang) : '—'}
          rescheduled={flow.rescheduling}
          onDone={() => {
            /*
              A RESCHEDULE NOW REACHES THIS SCREEN FOR A BOOKING THAT HOLDS
              NOTHING. `rescheduleToast` says "your deposit carries over", which
              on a merchant-created appointment describes a transfer that did not
              happen. `bookedToast` needs no variant: it fires only on a booking
              this app created, which always holds the salon's deposit.
            */
            onToast(
              flow.rescheduling
                ? holdsDeposit(flow.result!.booking)
                  ? copy.rescheduleToast
                  : copy.rescheduleToastNoDeposit
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
          /*
            THIS WAS A HARD-CODED `null` under a comment saying the row belonged
            to the sheet's own success screen because that screen re-read the
            member itself. It does not — `TopUpSheet` renders what it is handed,
            and `null` renders a skeleton bar, so the row sat grey forever on the
            one screen where she tops up precisely to make a deposit clear.

            It is the shell's member read now, admitted only once that read
            landed AFTER the payment settled. Still never `member.balanceFils`
            plus `creditFils`: #2 makes the number the server's, and the hook is
            where that is decided.
          */
          newBalanceFils={balance.newBalanceFils}
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
          <Text style={[text('bodyL', lang, '600'), styles.backText]}>{copy.back}</Text>
        </Pressable>
        <Text style={[text('displayM', lang), styles.title]}>{copy.bookTitle}</Text>
        <Text style={[text('body', lang, '600'), styles.stepCount]} testID="book-step-count">
          {/*
            `flow.totalSteps`, NOT `TOTAL_STEPS`. Four at a single-branch salon,
            five where the branch step is real. Printing the constant here is
            the exact defect this slice was told to avoid.

            NOTHING on `'entry'`, where both are null: the count is decided
            before it is first shown, so there is no number yet that is true.
            The Text stays mounted so the header keeps its shape.
          */}
          {flow.stepIndex !== null && flow.totalSteps !== null
            ? copy.bookStep(flow.stepIndex, flow.totalSteps)
            : ''}
        </Text>
      </View>
      <ProgressBar step={flow.stepIndex} total={flow.totalSteps} />

      {flow.step === 'entry' && <Entry flow={flow} />}

      {flow.step === 'branch' && <BranchStep flow={flow} salon={salon} />}

      {flow.step === 'service' && (
        <Step
          state={flow.services}
          onRetry={flow.retryLoad}
          skeleton={<RowSkeleton />}
          label={copy.chooseService}
        >
          {(services) =>
            /*
              NOTHING TO BOOK — every service is unassigned, or nobody on this
              roster performs any (`domain/serviceAssignment.ts`). Before 0061
              every service was bookable, so this step never needed an empty
              state; it does now, and a label over nothing reads as a failed
              load.
            */
            services.length === 0 ? (
              <EmptyPanel
                title={copy.servicesEmptyTitle}
                body={copy.servicesEmptyBody}
                testID="book-services-empty"
              />
            ) : (
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
            )
          }
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
              {/*
                `409 artist_not_assigned` sent her back here: the artist she
                chose no longer does this service. Said from the CODE, above the
                refreshed list, with her service still chosen.
              */}
              {flow.artistUnassigned ? (
                <View
                  style={styles.confirmFailure}
                  accessibilityRole="alert"
                  accessibilityLiveRegion="polite"
                  testID="book-artist-unassigned"
                >
                  <Text style={[text('bodyL', lang, '600'), styles.confirmFailureTitle]}>
                    {copy.artistNotAssignedTitle}
                  </Text>
                  <Text style={[text('body', lang), styles.confirmFailureBody]}>
                    {copy.artistNotAssignedBody}
                  </Text>
                </View>
              ) : null}
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

          {/*
            THE SALON'S BOOKING POLICY, before she confirms (migration 0066).
            Directly above the button that agrees to it. Nothing at all when
            the salon has none, or on a reschedule — see `useBooking § policy`.
          */}
          <PolicySection flow={flow} />

          {flow.confirmFailure ? (
            <ConfirmFailure
              failure={flow.confirmFailure}
              rescheduling={flow.rescheduling}
              policyBooking={reschedule?.booking.policy != null}
            />
          ) : null}
        </>
      )}

      {/* No CTA on `'entry'`: there is nothing to continue from yet. */}
      {flow.step !== 'confirmed' && flow.step !== 'entry' ? (
        <Cta flow={flow} salon={salon} topUp={topUp} amount={topUpAmount} />
      ) : null}

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
 * THE ENTRY GATE -- before step 1 is known. `useBooking § the entry gate`.
 *
 * LOADING is a row skeleton with NO step label: the label would be "Choose a
 * branch" or "Choose a service", and which one is the thing being waited on.
 * Rows because both candidates' own loading states are rows (`BranchStep`'s
 * skeleton below, and the service step's), so whichever arrives replaces a
 * shape it already has. interaction-spec.md §4: a skeleton matching the real
 * layout, never a centred spinner. No new copy — the skeleton's spoken label
 * is `loadingAria`, like every other skeleton in this flow.
 *
 * FAILURE is the ordinary failure screen with a retry. Offline gets the
 * offline copy and a 5xx gets ours (`domain/loadFailure.ts`), and the retry
 * re-reads the split and puts her back on this skeleton. It has to be
 * recoverable in place: this is the first thing she sees, so a dead end here
 * would be a Book tab that does not work.
 */
function Entry({ flow }: { flow: ReturnType<typeof useBooking> }) {
  if (flow.entryFailure) {
    return (
      <FailureScreen
        kind={flow.entryFailure.kind}
        message={flow.entryFailure.message}
        reference={flow.entryFailure.reference}
        onRetry={flow.retryLoad}
        retrying={false}
      />
    );
  }
  return (
    <View testID="book-entry-loading">
      <RowSkeleton count={3} />
    </View>
  );
}

/**
 * STEP 1 -- THE BRANCH. (migration 0044; promoted from a filter strip to a step
 * by Aftab after testing the app, and moved first by W1.)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MOST SALONS NEVER REACH THIS COMPONENT, AND THAT IS STILL THE FEATURE
 * ═══════════════════════════════════════════════════════════════════════════
 * `flow.hasBranchStep` is false for a single-branch salon, for a salon whose
 * artists are all unassigned (the common case today -- migration 0044
 * deliberately did not guess), and for a reschedule. Those flows never route
 * here at all and their counter says four. `domain/branchPicker.ts` owns that
 * rule and argues each suppression; `useBooking` owns the counter that has to
 * agree with it.
 *
 * A SINGLE-BRANCH SALON IS NEVER ASKED: one option is not a choice, and
 * `resolveBranch` already treats a lone open branch as ESTABLISHED, so those
 * bookings are correctly attributed with nothing on screen.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT IS THE SERVICE LIST'S ROWS, AND THERE IS NO "ALL BRANCHES"
 * ═══════════════════════════════════════════════════════════════════════════
 * The bundle draws no branch step, so anything here is borrowed. It borrowed
 * the day strip's chips first (a horizontal `ScrollView` of `BranchChip`s,
 * design:568-572), from when the branch was a filter inside the artist step.
 * Aftab, 2026-09-29: "Book branch list should be same design wise as services
 * list". So it is now `BranchRow` -- the service row's own shell
 * (`OptionRow`), in the service list's own `styles.rows` container, under the
 * same micro label -- and a selected branch looks exactly like a selected
 * service.
 *
 * And, the same day: "Remove all branches option in the select branch while
 * booking". The rows are every open branch, then "Other artists" when some
 * artist has no branch -- the only way to reach her, so it stays, last, with
 * its note. Nothing is selected when the step paints; Continue waits for a
 * tap, as it does on the service step. `domain/branchPicker.ts` records why
 * removing "all" leaves no bookable artist unreachable.
 *
 * AN EMPTY `branchOptions` HERE IS A LOAD, NOT AN ABSENCE. The step's existence
 * is decided once, at entry, so a `retryLoad` that re-reads the roster split
 * leaves her standing on this step with no chips for an instant. That is the
 * step's loading state and it renders as one; a FAILED re-read renders the
 * failure screen with a retry rather than that skeleton for ever.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AN EMPTY BRANCH IS SAID HERE, NOT TWO STEPS LATER
 * ═══════════════════════════════════════════════════════════════════════════
 * Tapping a row re-reads the roster for it. If it comes back empty, the panel
 * appears under the rows and Continue stays disabled — `useBooking § the
 * empty branch`. The panel shows its TITLE ONLY now: its body, "Try another
 * branch, or choose All branches to see everyone", points at a row that no
 * longer exists, and copy is not this lane's to rewrite. See `ArtistsEmpty`.
 */
function BranchStep({
  flow,
  salon,
}: {
  flow: ReturnType<typeof useBooking>;
  salon: Salon;
}) {
  const { lang, copy } = useLanguage();

  if (flow.splitFailure) {
    return (
      <FailureScreen
        kind={flow.splitFailure.kind}
        message={flow.splitFailure.message}
        reference={flow.splitFailure.reference}
        onRetry={flow.retryLoad}
        retrying={false}
      />
    );
  }

  if (flow.branchOptions.length === 0) {
    return (
      <>
        <StepLabel>{copy.chooseBranch}</StepLabel>
        <RowSkeleton count={2} />
      </>
    );
  }

  const rowKey = (choice: BranchChoice) =>
    choice.kind === 'branch' ? choice.branchId : choice.kind;

  return (
    <View style={styles.branchBlock}>
      <StepLabel>{copy.chooseBranch}</StepLabel>
      {/* The service list's own container and gap -- see the header. */}
      <View style={styles.rows}>
        {flow.branchOptions.map((choice) => {
          const label = branchChoiceLabel(choice, salon.branches, lang, copy);
          // Unreachable from `branchChoices`, which builds rows from the same
          // `salon.branches`; a row with no name is not drawn rather than
          // drawn blank.
          if (label === null) return null;
          return (
            <BranchRow
              key={rowKey(choice)}
              label={label}
              selected={sameChoice(flow.branchChoice, choice)}
              onPick={() => flow.pickBranch(choice)}
              testID={`book-branch-${rowKey(choice)}`}
            />
          );
        })}
      </View>

      {/*
        THE NOTE IS WHAT STOPS THE THIRD GROUP BEING A HALF-TRUTH.
        "Other artists" says these are not at any of the branches beside it; the
        note says why, in a customer's words, without using the API's
        "unassigned". Shown only while that group is selected -- on a branch chip
        it would be a caveat about a location she did not choose.

        IT MATTERS MORE AS A STEP THAN IT DID AS A FILTER. A strip that narrowed
        a list she could already see claimed little; a numbered step reads as a
        decision. This sentence is what keeps "Other artists" from being read as
        "a branch called Other".
      */}
      {flow.branchChoice?.kind === 'unassigned' ? (
        <View style={styles.branchNote}>
          <Note tone="wash">{copy.branchFilterOtherNote}</Note>
        </View>
      ) : null}

      {/*
        The chosen chip's roster. A failed read is a failure with a retry; an
        empty one is the panel, and `useBooking` refuses Continue on it too.
        A read still in flight shows nothing here and a disabled Continue for
        one round trip -- the chip itself has already answered the tap.
      */}
      {flow.artists.status === 'failed' ? (
        <FailureScreen
          kind={flow.artists.failure.kind}
          message={flow.artists.failure.message}
          reference={flow.artists.failure.reference}
          onRetry={flow.retryLoad}
          retrying={false}
        />
      ) : flow.branchHasArtists === false ? (
        <View style={styles.branchNote}>
          <ArtistsEmpty flow={flow} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The roster's EMPTY state -- on the branch step (an empty branch) and on the
 * artist step (an empty salon).
 *
 * Two different emptinesses, and telling them apart is the whole value:
 *
 *   A BRANCH WITH NO ARTISTS. She chose a location and it has nobody bookable.
 *   This is reachable by design rather than by accident: `branchChoices` keeps
 *   a row for every open branch even when its roster is empty, on the grounds
 *   that a MISSING row reads as a branch that does not exist while an empty one
 *   reads as a branch with nobody in today. Only one of those is true.
 *
 *   SINCE W1 IT IS SHOWN ON THE BRANCH STEP, under the rows, and Continue is
 *   refused on it -- so she meets it before choosing a service rather than
 *   after. On the artist step it survives only as a backstop for a roster that
 *   changed between the two reads.
 *
 *   TITLE ONLY SINCE 2026-09-29. Its body, `branchEmptyBody`, told her to
 *   "choose All branches", a row the step no longer has, and trunk ruled the
 *   key deleted in both languages rather than rewritten. The way out is still
 *   on screen without it: the other branch rows are directly above the panel.
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
  const filtered = flow.branchChoice !== null;
  return filtered ? (
    <EmptyPanel title={copy.branchEmptyTitle} testID="book-branch-empty" />
  ) : (
    <EmptyPanel
      title={copy.artistsEmptyTitle}
      body={copy.artistsEmptyBody}
      testID="book-artists-empty"
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
function ConfirmFailure({
  failure,
  rescheduling,
  policyBooking = false,
}: {
  failure: { code: string | null; message: string };
  rescheduling: boolean;
  /** Moving a booking made under the salon's policy: the legacy clause is false. */
  policyBooking?: boolean;
}) {
  const { lang, copy } = useLanguage();
  const taken = failure.code === 'slot_taken' || failure.code === 'slot_past';
  const off = failure.code === 'booking_not_enabled';
  const windowClosed = failure.code === 'change_window_closed';
  /*
    `409 artist_not_assigned` reaches THIS panel only on a reschedule — a new
    booking is sent back to the staff step instead (`useBooking.confirm`). The
    server's `message` is English and would be English inside a mirrored
    layout, so the words come from the code.
  */
  const unassigned = failure.code === 'artist_not_assigned';

  const title = taken
    ? copy.slotTakenTitle
    : off
      ? copy.bookingOffTitle
      : windowClosed
        ? copy.changeClosedTitle
        : unassigned
          ? copy.artistNotAssignedTitle
          : // Not `errorTitle` — that is the cold-load screen's words and offers a
            // retry. This is a refusal, and the server wrote a sentence for it.
            copy.blockedTitle;

  const body = taken
    ? copy.slotTakenBody
    : off
      ? copy.bookingOffBody
      : windowClosed
        ? policyBooking
          ? copy.changeClosedBodyNoDeposit
          : copy.changeClosedBody
        : unassigned
          ? rescheduling
            ? copy.artistNotAssignedRescheduleBody
            : copy.artistNotAssignedBody
          : failure.message;

  return (
    <View style={styles.confirmFailure} accessibilityRole="alert" testID="book-confirm-failure">
      <Text style={[text('bodyL', lang, '600'), styles.confirmFailureTitle]}>{title}</Text>
      <Text style={[text('body', lang), styles.confirmFailureBody]}>{body}</Text>
    </View>
  );
}

// ------------------------------------------------------ the booking policy --

/**
 * The review step's policy, in its four states. `flow.policy` is null where no
 * policy is shown (a reschedule, or a salon with no deposit), and a ready
 * `null` is a salon that has never published one: both draw nothing, and the
 * screen is exactly what it was.
 */
function PolicySection({ flow }: { flow: ReturnType<typeof useBooking> }) {
  const { lang, copy } = useLanguage();
  const state = flow.policy;
  if (state === null) return null;
  if (state.status === 'loading') {
    return (
      <View style={styles.policySkeleton} accessibilityLabel={copy.loadingAria} testID="book-policy-loading">
        <View style={[styles.policyBar, { width: '44%' }]} />
        <View style={[styles.policyBar, { width: '86%', marginTop: 10 }]} />
      </View>
    );
  }
  if (state.status === 'failed') {
    return (
      <View style={styles.confirmFailure} accessibilityRole="alert" testID="book-policy-failed">
        <Text style={[text('body', lang), styles.confirmFailureBody]}>{copy.policyLoadFailed}</Text>
        <SecondaryButton label={copy.tryAgain} onPress={flow.retryPolicy} testID="book-policy-retry" />
      </View>
    );
  }
  if (state.data === null) return null;
  return (
    <>
      {flow.policyChanged ? (
        <View accessibilityRole="alert" testID="book-policy-changed">
          <Note>{copy.policyChanged}</Note>
        </View>
      ) : null}
      <PolicyBlock terms={state.data} testID="book-review-policy" />
    </>
  );
}

// ----------------------------------------------------------------- the CTA --

/**
 * design:1549-1558 — one button, four labels.
 *
 *   branch/service/artist   Continue, enabled once something is chosen
 *   day                     Review booking, enabled once a slot is chosen
 *   review                  Confirm · hold <deposit>  — or, when the server has
 *                           said she is short, "Top up to book", which opens the
 *                           sheet instead.
 *
 * THE BRANCH STEP GATES ON A TAP AND ON THE ROSTER. Like the other three
 * there is no default -- since the "All branches" row went (2026-09-29) nothing
 * is chosen until she chooses a branch, and `flow.branchHasArtists` is null
 * until she does. What is also demanded, since W1 moved the branch first, is
 * that the chosen row's roster has landed with somebody in it: otherwise
 * Continue would lead through the service step to an empty staff step.
 * `useBooking § the empty branch`.
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
        // Off until the policy is on screen: she cannot agree to what she has
        // not been shown. `flow.policy` is null where none applies.
        disabled={
          flow.submitting ||
          !flow.selectedSlot ||
          (flow.policy !== null && flow.policy.status !== 'ready')
        }
        testID="book-confirm"
        style={styles.cta}
      />
    );
  }

  const enabled =
    flow.step === 'service'
      ? flow.selectedService !== null
      : flow.step === 'branch'
        ? flow.branchHasArtists === true
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
  policy,
  serviceName,
  artistLabel,
  rescheduled,
  onDone,
}: {
  salon: Salon;
  startsAt: string;
  depositFils: number;
  /** The policy STAMPED on the booking the server returned; null when legacy. */
  policy: BookingView['policy'];
  serviceName: string;
  artistLabel: string;
  rescheduled: boolean;
  onDone: () => void;
}) {
  const { lang, copy } = useLanguage();
  /* One derivation for the row and both policy lines. See domain/booking.ts. */
  const held = holdsDeposit({ depositFils });
  return (
    <View style={styles.confirmed} testID="book-confirmed">
      <View style={styles.tickBadge}>
        <Text style={[text('bodyS', lang, '700'), styles.tickBadgeMark]}>✓</Text>
      </View>
      <Text style={[text('displayM', lang), styles.confirmedTitle]}>{copy.booked}</Text>
      <Text style={[text('body', lang), styles.confirmedSub]}>
        {serviceName} · {artistLabel}
      </Text>

      <View style={styles.confirmedCard}>
        <ReviewRow
          label={copy.whenRow}
          value={formatWhen(startsAt, salon.timezone, lang)}
          last={rescheduled && !held}
        />
        {/*
          THE DEPOSIT ROW IS DROPPED ENTIRELY WHEN THERE IS NO DEPOSIT, rather
          than rendered as "Deposit held · 0.000 KD".

          This screen is reached on a RESCHEDULE as well as on a new booking, and
          a merchant-created appointment can be rescheduled from the Upcoming
          card like any other. A row labelled "Deposit held" against a zero is
          the same false statement as the pill on that card, with more authority:
          it sits inside the confirmation, next to the time, formatted as money.

          A row is the right thing to drop where the pill was not. The pill is
          the ONLY state this card carries and its slot would read as a failure;
          this is one row among several, and "Deposit held" is not a question a
          customer is left asking when the appointment never had one.
        */}
        {held ? (
          <ReviewRow
            label={copy.depositHeld}
            value={formatMoney(depositFils as Fils, lang)}
            last={rescheduled}
          />
        ) : null}
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

      {/*
        Both policy lines name the deposit, and both are cut at that clause when
        there is none. See copy/en.ts § cancelPolicyNoDeposit — the 24h/1h
        contradiction the block above records is inherited by the variants
        unchanged, deliberately, rather than quietly resolved by this lane.
      */}
      {/*
        A BOOKING MADE UNDER THE SALON'S POLICY is shown that policy, as
        stamped, in place of the design's two legacy lines — "Free to cancel up
        to 24h before" and "After that the deposit stays with the salon" are
        both false under a policy that sets its own cut-offs.
      */}
      {held && policy ? (
        <>
          <PolicyBlock terms={policy} testID="book-stamped-policy" />
          <Text style={[text('bodyS', lang), styles.policy]} testID="book-resched-note">
            {copy.reschedNotePolicy}
          </Text>
        </>
      ) : (
        <>
          <Text style={[text('bodyS', lang), styles.policy]} testID="book-policy">
            {held ? copy.cancelPolicy : copy.cancelPolicyNoDeposit}
          </Text>
          <Text style={[text('bodyS', lang), styles.policy]} testID="book-resched-note">
            {held ? copy.reschedNote : copy.reschedNoteNoDeposit}
          </Text>
        </>
      )}

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

const styles = brandedStyles(() => ({
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
  backText: { color: color.brandDeep },
  title: { color: color.ink },
  stepCount: { color: color.textMuted },

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
  confirmFailureTitle: { color: color.dangerText },
  confirmFailureBody: { color: color.dangerText, marginTop: 4, lineHeight: 19 },
  policySkeleton: {
    marginTop: 14,
    padding: 16,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  policyBar: { height: 12, borderRadius: 6, backgroundColor: color.surfaceAlt2 },

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
  tickBadgeMark: { color: WHITE, fontSize: 34, lineHeight: 40 },
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
}));
