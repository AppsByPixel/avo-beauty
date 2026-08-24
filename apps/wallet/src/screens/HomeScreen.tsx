/**
 * Wallet · Home.
 *
 * The four required states are not appended to this screen — they are the only
 * ways it renders. `useWalletHome` returns one of six statuses and each branch
 * below is one of them; there is no path that renders a balance the server has
 * not confirmed, and no path that renders 0.000 while waiting.
 *
 * Layout, spacing and copy from design/AVO Wallet Home.dc.html; the state
 * treatments from design/AVO States.dc.html.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native';
import { fils, formatMoney, type Fils } from '@avo/types';
import { color, CONTROL_BORDER, MIN_TAP_TARGET, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { LanguageToggle } from '../components/LanguageToggle';
import type { HomeState } from '../state/useWalletHome';
import { useUpcoming } from '../state/useBooking';
import { useBookingLabels } from '../state/useBookingLabels';
import { nextAppointment } from '../domain/booking';
import type { BookingView } from '../api/booking';
import { useWalletToken } from '../state/useWalletToken';
import { useTopUp } from '../state/useTopUp';
import { loyaltyPill, loyaltyProgress } from '../domain/loyalty';
import { relativeTime, toActivityRow } from '../domain/activity';
import { salonName } from '../domain/names';
import { DEFAULT_TOP_UP_AMOUNT } from '../domain/topup';
import { WalletCard } from '../components/WalletCard';
import { PaymentCode } from '../components/PaymentCode';
import { ActivityFeed } from '../components/ActivityFeed';
import { BranchEarning } from '../components/BranchEarning';
import { HomeSkeleton } from '../components/HomeSkeleton';
import { FailureScreen } from '../components/FailureScreen';
import { OfflineBanner, StaleBanner } from '../components/Banners';
import { TopUpCard } from '../components/TopUpCard';
import {
  NoUpcomingCard,
  UpcomingCard,
  UpcomingFailedCard,
  UpcomingSkeleton,
} from '../components/UpcomingCard';
import { TopUpSheet } from '../components/TopUpSheet';
import { TransactionSheet } from '../components/TransactionSheet';
import { AccountButton } from '../components/AccountButton';

interface HomeProps {
  /**
   * Lifted to App.tsx so that Home and Book read ONE wallet snapshot.
   *
   * Two `useWalletHome()` instances would be two `GET /members/me` calls and,
   * worse, two balances: the Book flow could hold a deposit and Home would keep
   * rendering the figure it read before the tap, until something happened to
   * remount it. One state, one balance, re-read after every money move.
   */
  home: HomeState & { retry: () => void };
  onOpenAccount: () => void;
  /** Open the Book flow — the empty card's action and the Upcoming card's. */
  onBook: () => void;
  /** Move an existing appointment. The deposit carries; no money moves. */
  onReschedule: (booking: BookingView) => void;
  /** Fired with the cancellation toast, so it survives this screen re-rendering. */
  onToast: (message: string) => void;
}

export function HomeScreen({ home, onOpenAccount, onBook, onReschedule, onToast }: HomeProps) {
  const { lang, copy } = useLanguage();
  const { status, snapshot, fetchedAt, failure } = home;

  const [amount, setAmount] = useState<Fils>(DEFAULT_TOP_UP_AMOUNT);
  const [openTxId, setOpenTxId] = useState<string | null>(null);

  /**
   * When a top-up succeeded, so the success screen can tell a balance that has
   * been re-read since from one that has not. Non-negotiable #2: the new balance
   * is the server's answer to GET /members/me, never the old balance plus
   * `creditFils`. Until that read lands the row shows a bar, not a number.
   */
  const succeededAt = useRef<number | null>(null);
  const retry = home.retry;
  const onSucceeded = useCallback(() => {
    succeededAt.current = Date.now();
    retry();
  }, [retry]);

  const topUp = useTopUp({ onSucceeded });

  // Offline hides the payment code entirely — interaction-spec.md §4. A stale
  // token fails at the counter and that failure looks like the salon's fault.
  const codeEnabled = status === 'ready' || status === 'stale';
  const walletToken = useWalletToken(codeEnabled && snapshot !== null);

  const rows = useMemo(
    () =>
      snapshot
        ? snapshot.transactions.map((tx) => toActivityRow(tx, snapshot.salon.branches, lang, copy))
        : [],
    [snapshot, lang, copy],
  );

  /**
   * The upcoming appointment.
   *
   * Only read when the salon actually takes bookings — `modules.booking`
   * defaults OFF (AVO-Beauty-Product-Description-v2.md § Settings) and a card
   * for a feature the salon does not have is worse than no card. The server
   * enforces the module too, so this is the courtesy half of non-negotiable #7.
   */
  const bookingOn = snapshot?.salon.modules.booking === true;
  const upcoming = useUpcoming({
    enabled: bookingOn,
    onChanged: home.retry,
  });
  const labels = useBookingLabels(snapshot?.salon.id ?? null, bookingOn);
  const nextBooking = useMemo(
    () => nextAppointment(upcoming.bookings, new Date()),
    [upcoming.bookings],
  );

  const onCancel = useCallback(
    async (booking: BookingView) => {
      const refunded = await upcoming.cancel(booking.id);
      // Only on success. A refused cancel renders its refusal on the card —
      // a toast saying "deposit returned" for a 409 would be a lie the customer
      // acts on.
      if (refunded !== null) {
        onToast(copy.cancelledToast(formatMoney(fils(refunded), lang)));
      }
    },
    [upcoming, onToast, copy, lang],
  );

  if (status === 'loading' || (!snapshot && home.refreshing)) {
    return (
      <Shell>
        <HomeSkeleton />
      </Shell>
    );
  }

  if (!snapshot) {
    return (
      <Shell centered>
        <FailureScreen
          kind={failure?.kind ?? 'server'}
          message={failure?.message ?? copy.errorBody}
          reference={failure?.reference ?? '—'}
          onRetry={home.retry}
          retrying={home.refreshing}
        />
      </Shell>
    );
  }

  const { member, salon, promotions } = snapshot;
  const progress = loyaltyProgress(member, salon);
  const firstName = member.name.split(' ')[0] ?? member.name;
  const offline = status === 'offline';

  const openTx = snapshot.transactions.find((tx) => tx.id === openTxId) ?? null;

  // Only a balance read AFTER the top-up settled may be labelled "New balance".
  const newBalanceFils =
    succeededAt.current !== null && fetchedAt !== null && fetchedAt >= succeededAt.current
      ? fils(member.balanceFils)
      : null;

  return (
    <Shell
      overlay={
        <>
          <TopUpSheet
            stage={topUp.stage}
            controller={topUp}
            newBalanceFils={newBalanceFils}
            tier={member.tier}
          />
          <TransactionSheet
            transaction={openTx}
            branches={salon.branches}
            onClose={() => setOpenTxId(null)}
            // "Report a problem with this payment" → Account → Contact us, with
            // the receipt reference already handed over. src/support/contact.ts.
            onReport={onOpenAccount}
          />
        </>
      }
    >
      {offline ? <OfflineBanner /> : null}
      {status === 'stale' && fetchedAt ? (
        <StaleBanner at={fetchedAt} onRetry={home.retry} />
      ) : null}

      {/*
        `flexDirection: 'row'` is already a LOGICAL direction on both targets —
        CSS lays a row along the inline axis and Yoga reverses it under
        `I18nManager.isRTL` — so the greeting sits at the reading edge and the
        language toggle at the far edge in both languages, with no conditional.
        Writing 'row-reverse' for Arabic here would double-flip it.
      */}
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={[text('body', lang), styles.greeting]}>{copy.greeting(firstName)}</Text>
          {/*
            THE GAP THIS NOTE USED TO REPORT IS CLOSED, and the note outlived it.
            It read: "CONTRACT GAP (reported, not filled): `Salon.name` is one
            string … api-contract.md's Salon has no Arabic field — so an Arabic
            wallet shows the Latin salon name. Shared-package change, belongs on
            trunk." The trunk change landed: `SalonSchema.nameAr` is in
            `packages/types`, `GET /salons/SAL-AMARA` answers `nameAr: "أمارا"`,
            and the design has written it since design:1275 (`salon: 'أمارا'`).
            Only this line had not been updated, so the Arabic home screen
            greeted her in Arabic and then named her salon in Latin.

            The choice is `salonName()` rather than the ternary that first fixed
            it, because a ternary HERE is a branch no test can reach — this
            workspace has no renderer, and an untested render site is exactly how
            this shipped. domain/names.ts carries the rule and the spec.
          */}
          <Text style={[text('displayM', lang), styles.salon]}>{salonName(salon, lang)}</Text>
        </View>
        {/* design:195-198 — the switch and the avatar, in that order. */}
        <View style={styles.headerControls}>
          <LanguageToggle />
          <AccountButton onPress={onOpenAccount} />
        </View>
      </View>

      <WalletCard
        balanceFils={member.balanceFils}
        pill={loyaltyPill(progress, copy)}
        progress={progress}
        lastUpdated={offline && fetchedAt ? copy.lastUpdated(relativeTime(fetchedAt, copy)) : null}
      >
        <PaymentCode
          memberId={member.id}
          token={walletToken.token}
          secondsRemaining={walletToken.secondsRemaining}
          unavailable={offline ? 'offline' : walletToken.failed ? 'failed' : null}
          onPress={walletToken.refresh}
        />
      </WalletCard>

      <BranchEarning salon={salon} promotions={promotions} />

      {/*
        design:312-322 — the Upcoming card, between the branch note and the
        top-up card. Four renderings, and the empty one is a card rather than
        nothing: a section that vanishes reads as a screen that half-loaded.
      */}
      {bookingOn ? (
        upcoming.status === 'loading' ? (
          <UpcomingSkeleton />
        ) : upcoming.status === 'failed' ? (
          // NOT the empty card. See UpcomingFailedCard — a failed read here once
          // told a customer she had no appointment moments after her deposit
          // left her balance.
          //
          // The FAILURE, not just the fact of one: without it the card said
          // "This is on our side" to a customer whose phone had no signal.
          <UpcomingFailedCard failure={upcoming.failure} onRetry={upcoming.reload} />
        ) : nextBooking ? (
          <UpcomingCard
            booking={nextBooking}
            salon={salon}
            artistLabel={labels.artistLabel(nextBooking.artistId, lang)}
            serviceLabel={labels.serviceLabel(nextBooking.serviceId, lang)}
            onReschedule={() => onReschedule(nextBooking)}
            onCancel={() => void onCancel(nextBooking)}
            busy={upcoming.busy}
            failure={upcoming.actionFailure}
          />
        ) : (
          <NoUpcomingCard onBook={onBook} />
        )
      ) : null}

      <TopUpCard
        member={member}
        salon={salon}
        selected={amount}
        onSelect={setAmount}
        onContinue={() => topUp.open(amount)}
      />

      <ActivityFeed
        rows={rows}
        onTopUp={() => topUp.open(amount)}
        onOpen={setOpenTxId}
      />

      {offline ? (
        <Pressable onPress={home.retry} accessibilityRole="button" style={styles.offlineRetry}>
          <Text style={[text('bodyL', lang), styles.offlineRetryText]}>{copy.tryAgain}</Text>
        </Pressable>
      ) : null}

      <View style={styles.footerSpace} />
    </Shell>
  );
}

/**
 * `overlay` is a sibling of the ScrollView, not a child of it. A sheet rendered
 * inside the scroll content would scroll away with the page and be clipped by
 * the content container — it has to sit on the frame.
 */
function Shell({
  children,
  centered,
  overlay,
}: {
  children: React.ReactNode;
  centered?: boolean;
  overlay?: React.ReactNode;
}) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.frame}>
        <ScrollView
          contentContainerStyle={[styles.scroll, centered && styles.scrollCentered]}
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
        {overlay}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  // interaction-spec.md §1: mobile surfaces are fixed-width app screens; the
  // reference is 402pt. On a desktop browser the wallet is centred at that
  // width rather than stretched — it is a phone screen, not a responsive page.
  frame: {
    flex: 1,
    width: '100%',
    maxWidth: 402,
    alignSelf: 'center',
    backgroundColor: color.surface,
  },
  scroll: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 40 },
  scrollCentered: { flexGrow: 1, justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 20,
  },
  headerText: { flexShrink: 1, minWidth: 0 },
  // `row` is already a logical direction on both targets, so the pair mirrors in
  // Arabic without a conditional. See i18n/rtl.ts.
  headerControls: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  greeting: { color: color.textMuted },
  salon: { color: color.ink, marginTop: 2 },
  offlineRetry: {
    marginTop: 20,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 15,
    borderRadius: radius.button,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: CONTROL_BORDER,
  },
  // Brand text on a light surface: brandDeep, never brand.
  offlineRetryText: { color: color.brandDeep, fontWeight: '600' },
  footerSpace: { height: 24 },
});
