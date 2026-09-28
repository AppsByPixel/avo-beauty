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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
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
import { useTopUp } from '../state/useTopUp';
import { useNewBalanceAfterTopUp } from '../state/useNewBalanceAfterTopUp';
import { loyaltyPill, loyaltyProgress } from '../domain/loyalty';
import { collapseScrollTarget, relativeTime, toActivityRow } from '../domain/activity';
import { salonName } from '../domain/names';
import { DEFAULT_TOP_UP_AMOUNT } from '../domain/topup';
import { WalletCard } from '../components/WalletCard';
import { PaymentCode } from '../components/PaymentCode';
import type { PaymentCodeView } from '../domain/paymentCode';
import { ActivityFeed } from '../components/ActivityFeed';
import { BranchEarning } from '../components/BranchEarning';
import { HappyHourBanner } from '../components/HappyHourBanner';
import { HomeSkeleton } from '../components/HomeSkeleton';
import { FailureScreen } from '../components/FailureScreen';
import { OfflineBanner, StaleBanner } from '../components/Banners';
import { MembershipSection } from '../components/MembershipSection';
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
import { BellButton } from '../components/BellButton';
import { BellSheet } from '../components/BellSheet';
import { useBell } from '../state/useBell';
import { useOrders } from '../state/useOrders';

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
  /**
   * THE PAYMENT CODE IS DECIDED IN THE SHELL NOW, NOT HERE, and the reason is
   * design:627 — the Pay tab.
   *
   * The design binds that tab to `openQr` (design:1905), the SAME handler as the
   * wallet card's panel (design:254), and it does not change screen: the enlarged
   * code opens over Shop and Book too. So the token, the `PaymentCodeView` and
   * the overlay all had to move up to `App.tsx`, which is the only place that
   * outlives a tab switch.
   *
   * That move is also what makes the §4 suppression hold for the tab. There is
   * ONE `paymentCodeView` for the whole app; this panel and the Pay tab read it,
   * and `domain/payTab.ts` asserts the tab can never enlarge what this rule has
   * hidden. Two computations would have been two opinions about when a QR may be
   * on a screen, and the one that mattered would be whichever ran offline.
   */
  codeView: PaymentCodeView;
  /** The countdown to the SERVER's expiry. Cosmetic; see useWalletToken. */
  codeSecondsRemaining: number;
  /** Reached only from the `ready` panel — App decides, per domain/payTab.ts. */
  onEnlargeCode: () => void;
  /** Reached only from the `failed` panel, whose copy asks for it. */
  onRetryCode: () => void;
  /**
   * Pull-to-refresh. App's `useWalletRefresh().requestRefresh`, the same
   * throttled re-read the payment code's close and the foreground run, so a pull
   * cannot become a fourth path with its own opinion. True when a read started.
   */
  onPullToRefresh: () => boolean;
  /** `useWalletRefresh().generation` — re-reads the Upcoming card with the wallet. */
  refreshGeneration: number;
}

export function HomeScreen({
  home,
  onOpenAccount,
  onBook,
  onReschedule,
  onToast,
  codeView,
  codeSecondsRemaining,
  onEnlargeCode,
  onRetryCode,
  onPullToRefresh,
  refreshGeneration,
}: HomeProps) {
  const { lang, copy } = useLanguage();
  const { status, snapshot, fetchedAt, failure } = home;

  const [amount, setAmount] = useState<Fils>(DEFAULT_TOP_UP_AMOUNT);
  const [openTxId, setOpenTxId] = useState<string | null>(null);

  /**
   * FOLDING THE ACTIVITY FEED MUST NOT STRAND HER. "Show less" sits at the
   * bottom of an expanded feed; folding shortens the page under her finger, so
   * Home brings the section's top back into view when — and only when — it has
   * scrolled above the viewport. The rule is `collapseScrollTarget`; this is the
   * scroll view it acts on. Refs, not state: the offset changes every frame and
   * nothing renders from it.
   */
  const scrollRef = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollY.current = e.nativeEvent.contentOffset.y;
  }, []);
  const onFeedCollapse = useCallback((section: View | null) => {
    const scroll = scrollRef.current;
    const content = scroll ? innerContent(scroll) : null;
    if (!section || !scroll || !content) return;
    // Where she was when she pressed — read NOW, before the fold re-lays the
    // page out and the scroll view clamps to its shorter end.
    const from = scrollY.current;
    // Against the scroll CONTENT, so the answer is a content offset that the
    // fold cannot move (everything above the section is unchanged by it).
    section.measureLayout(
      content,
      (_x, sectionTop) => {
        const y = collapseScrollTarget(from, sectionTop);
        if (y !== null) scroll.scrollTo({ y, animated: true });
      },
      () => {
        // Unmeasurable (unmounted mid-fold): staying put is the safe answer.
      },
    );
  }, []);

  /**
   * "New balance" on the top-up success screen. Non-negotiable #2: it is the
   * server's answer to GET /members/me read AFTER the payment settled, never the
   * old balance plus `creditFils`, and until such a read lands the row is a bar.
   *
   * The comparison used to be written out here and hard-coded to `null` on the
   * other two screens that open this sheet. It is one hook now —
   * `state/useNewBalanceAfterTopUp.ts` argues why. Called before the early
   * returns below, so the balance is read off the snapshot defensively.
   */
  const balance = useNewBalanceAfterTopUp(snapshot?.member.balanceFils ?? null, fetchedAt);
  const retry = home.retry;
  const markSucceeded = balance.markSucceeded;
  const onSucceeded = useCallback(() => {
    markSucceeded();
    retry();
  }, [markSucceeded, retry]);

  const topUp = useTopUp({ onSucceeded });

  /*
    THE BELL (W4). Read once the wallet is on screen, and again whenever Home
    re-reads the wallet — a top-up or a charge that moved her balance also
    queued a receipt, so the badge follows `fetchedAt`. See `BellButton` for why
    it lives in this header and nowhere else.
  */
  const bell = useBell({ enabled: snapshot !== null, refreshKey: fetchedAt });

  /*
    PULL-TO-REFRESH. The spinner is up only for a read the PULL started: tying
    it to `home.refreshing` alone would drop the platform spinner over the top of
    the page for every top-up re-read and banner Try again too. A throttled pull
    starts nothing, so `pulled` never rises and the control lets go at once.
  */
  const [pulled, setPulled] = useState(false);
  const onPull = useCallback(() => {
    if (onPullToRefresh()) setPulled(true);
  }, [onPullToRefresh]);
  useEffect(() => {
    if (!home.refreshing) setPulled(false);
  }, [home.refreshing]);
  /*
    W7 — HER ORDERS, FOR THE BELL'S PICKUP ROWS. The bell's shop item carries
    no branch (`domain/bell.ts` § limit 3), so where she collects is joined in
    from `GET /members/me/orders`. Gated on the panel being open — the same
    gate the Shop screen puts on the same read — so Home does not pay for it on
    every visit. Until it lands, or if it fails, a pickup row says "Pickup" and
    names nothing; the bell's own four states are unaffected.
  */
  const bellOrders = useOrders(bell.open);

  const rows = useMemo(
    () =>
      snapshot
        ? snapshot.transactions.map((tx) =>
            toActivityRow(tx, snapshot.salon.branches, lang, copy, snapshot.salon.timezone),
          )
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
    refreshKey: refreshGeneration,
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
        /*
          =====================================================================
          AND A SUCCESSFUL CANCEL THAT RETURNED NOTHING IS THE OTHER HALF OF
          THAT LIE, WHICH THIS LINE WAS TELLING
          =====================================================================
          A front desk can now create an appointment on an existing member's
          account, and `BookingSchema` § source makes it always zero-deposit.
          Cancelling one answered `refundedFils: 0` and this toast rendered
          "Appointment cancelled · 0.000 KD deposit returned" — a receipt, in
          her own language, for money that never left her wallet.

          THE TEST IS `refunded`, NOT `booking.depositFils`, and that is the one
          place in this slice where the server's number beats the booking's.
          Both are 0 on a merchant booking, so they agree today; they are not the
          same question. `depositFils` is what the appointment was WORTH, and
          `refundedFils` is what the cancellation actually MOVED — and it is the
          second one this sentence is a receipt for. Non-negotiable #2: the
          server decides what came back, and the toast reports it rather than
          predicting it from a field beside it.
        */
        onToast(
          refunded > 0
            ? copy.cancelledToast(formatMoney(fils(refunded), lang))
            : copy.cancelledToastNoDeposit,
        );
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
  const progress = loyaltyProgress(member, salon, lang);
  const firstName = member.name.split(' ')[0] ?? member.name;
  const offline = status === 'offline';

  const openTx = snapshot.transactions.find((tx) => tx.id === openTxId) ?? null;

  return (
    <Shell
      scrollRef={scrollRef}
      onScroll={onScroll}
      refreshing={pulled && home.refreshing}
      onRefresh={onPull}
      overlay={
        <>
          <TopUpSheet
            stage={topUp.stage}
            controller={topUp}
            // Only a balance read AFTER the top-up settled may be labelled
            // "New balance" — #2, enforced in the hook, not here.
            newBalanceFils={balance.newBalanceFils}
            tier={member.tier}
          />
          <TransactionSheet
            transaction={openTx}
            branches={salon.branches}
            timeZone={salon.timezone}
            onClose={() => setOpenTxId(null)}
            // "Report a problem with this payment" → Account → Contact us, with
            // the receipt reference already handed over. src/support/contact.ts.
            onReport={onOpenAccount}
          />
          <BellSheet
            bell={bell}
            salon={salonName(salon, lang)}
            timeZone={salon.timezone}
            transactions={snapshot.transactions}
            {...(bellOrders.orders ? { orders: bellOrders.orders } : {})}
            onOpenSettings={() => {
              // The EXISTING switches — Account → Notifications. Not rebuilt.
              bell.close();
              onOpenAccount();
            }}
          />
          {/*
            design:641-643 USED TO BE RENDERED HERE and is now a sibling of the
            whole shell, in `App.tsx`. design:627's Pay tab opens the same
            overlay from Shop and Book, and an overlay owned by Home could not be
            opened from a screen Home is not on. Nothing about WHEN it may open
            changed: `codeView` is still the gate, it is just computed one level
            up and handed to both. See `domain/payTab.ts`.
          */}
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
            it, because the rule wants to live somewhere a test can reach
            directly. This note used to justify that by saying the workspace has
            no renderer — it has one now (see happyHourBannerRender.test.tsx),
            so that clause was retired rather than left to be believed. The
            conclusion stands on its own: domain/names.ts carries the rule and
            the spec, and a pure function is the better home for it either way.
          */}
          <Text style={[text('displayM', lang), styles.salon]}>{salonName(salon, lang)}</Text>
        </View>
        {/* design:195-198 — the switch and the avatar, in that order. */}
        <View style={styles.headerControls}>
          <LanguageToggle />
          {/* W4 — not in the design. Between the switch and the avatar; see BellButton. */}
          <BellButton unreadCount={bell.unreadCount} onPress={bell.openPanel} />
          <AccountButton onPress={onOpenAccount} />
        </View>
      </View>

      {/*
        design:201-231 — the happy-hour banners sit between the header and the
        wallet card, live or next, and nothing at all when the salon has neither.
        The component owns its own one-second tick so the countdown does not
        re-render this whole screen; see its header.
      */}
      <HappyHourBanner promotions={promotions} salon={salon} />

      <WalletCard
        balanceFils={member.balanceFils}
        pill={loyaltyPill(progress, copy)}
        progress={progress}
        lastUpdated={offline && fetchedAt ? copy.lastUpdated(relativeTime(fetchedAt, copy)) : null}
      >
        <PaymentCode
          memberId={member.id}
          view={codeView}
          secondsRemaining={codeSecondsRemaining}
          // Two handlers where there was one `onPress` bound to `refresh`. The
          // tap on a LIVE code enlarges, which is what its hint has always
          // claimed; refresh is reachable only from the failed panel, whose copy
          // asks for it. See PaymentCode's header.
          onEnlarge={onEnlargeCode}
          onRetry={onRetryCode}
        />
      </WalletCard>

      <BranchEarning salon={salon} promotions={promotions} />

      {/*
        design:283-310 — top up, directly under the branch note and ABOVE
        Upcoming. This order is the design's, and it was inverted here until
        2026-09-09; the note that used to sit on the Upcoming block asserted the
        opposite while citing the very lines that disprove it.

        Both cards carry the design's own `margin-top:22px` (design:284 and
        design:313), so the order is the only thing the swap changes — the gap
        is 22 either way. The `margin-top:15px` in this section belongs to the
        you-pay/you-get panel at design:300, which IS now rendered — inside
        TopUpCard, from `domain/topupPreview.ts`. This note used to say we
        deliberately did not render it and that TopUpCard's header was that
        decision; both halves are now out of date and the header there carries
        the reversal.

        `promotions` is passed because the preview's figures include a live
        top-up window, and because a NULL set means the figures are withheld
        rather than guessed — see topupPreview.ts § bonusPercents.
      */}
      <TopUpCard
        member={member}
        salon={salon}
        promotions={promotions}
        selected={amount}
        onSelect={setAmount}
        onContinue={() => topUp.open(amount)}
      />

      {/*
        design:312-322 — the Upcoming card, between the TOP-UP card above and
        Activity below. Four renderings, and the empty one is a card rather than
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

      <ActivityFeed
        rows={rows}
        onTopUp={() => topUp.open(amount)}
        onOpen={setOpenTxId}
        onCollapse={onFeedCollapse}
      />

      {/*
        design:343-384 — Membership, the last section on Home. The tier ladder
        or the stamp card, on `Salon.loyaltyMode`, and nothing at all for a salon
        that has configured neither. Its row count is the salon's own; see
        domain/membership.ts for why that is not a detail.
      */}
      <MembershipSection member={member} salon={salon} />

      {offline ? (
        <Pressable onPress={home.retry} accessibilityRole="button" style={styles.offlineRetry}>
          <Text style={[text('bodyL', lang, '600'), styles.offlineRetryText]}>{copy.tryAgain}</Text>
        </Pressable>
      ) : null}

      <View style={styles.footerSpace} />
    </Shell>
  );
}

/**
 * The scroll view's content container, as something `measureLayout` accepts.
 *
 * `getInnerViewRef`, NOT `getInnerViewNode`. Under the new architecture (this
 * app is RN 0.86) `measureLayout` refuses a numeric node handle — it logs "must
 * be called with a ref to a native component" and never calls back — and a
 * handle is exactly what `getInnerViewNode` returns. `getInnerViewRef` returns
 * the host instance on native and the DOM node on react-native-web; both
 * implement it (ScrollView.js:870 in react-native, and the web ScrollView).
 *
 * THE ONE CAST, AND WHY IT IS NOT A GREEN BOUGHT WITH ONE: `ScrollView.d.ts`
 * lags its own source and declares only `getInnerViewNode` (d.ts:891), while
 * `ScrollView.js:142` types `getInnerViewRef` on the imperative methods. The
 * cast adds the method the runtime has; it asserts nothing about its result
 * beyond what `measureLayout` takes, and a missing method returns null here,
 * which Home treats as "stay put".
 */
function innerContent(scroll: ScrollView): Parameters<View['measureLayout']>[0] | null {
  const withRef = scroll as unknown as { getInnerViewRef?: () => unknown };
  const inner = withRef.getInnerViewRef?.() ?? null;
  return (inner as Parameters<View['measureLayout']>[0] | null) ?? null;
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
  scrollRef,
  onScroll,
  refreshing,
  onRefresh,
}: {
  children: React.ReactNode;
  centered?: boolean;
  overlay?: React.ReactNode;
  /** Home's loaded state only — the skeleton and failure shells have no feed. */
  scrollRef?: React.RefObject<ScrollView | null>;
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  /**
   * Pull-to-refresh, loaded state only: the skeleton has nothing to refresh and
   * the failure screen has its own Try again. NATIVE only. It is a touch idiom
   * with no desktop equivalent, and react-native-web implements it by wrapping
   * the scroll view in a second View carrying the scroll view's own style,
   * which would re-lay out the web wallet's fixed column for no gesture.
   */
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const refreshControl =
    onRefresh && Platform.OS !== 'web' ? (
      <RefreshControl refreshing={refreshing ?? false} onRefresh={onRefresh} />
    ) : undefined;
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.frame}>
        <ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          // Only the offset at the moment of a fold is read, so a coarse
          // throttle is plenty and costs the JS thread nothing worth measuring.
          scrollEventThrottle={64}
          contentContainerStyle={[styles.scroll, centered && styles.scrollCentered]}
          showsVerticalScrollIndicator={false}
          refreshControl={refreshControl}
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
  offlineRetryText: { color: color.brandDeep },
  footerSpace: { height: 24 },
});
