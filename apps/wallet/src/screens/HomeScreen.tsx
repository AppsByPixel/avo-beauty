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
import { fils, type Fils } from '@avo/types';
import { color, CONTROL_BORDER, MIN_TAP_TARGET, radius, text } from '../theme';
import { useLanguage } from '../i18n/language';
import { LanguageToggle } from '../components/LanguageToggle';
import { useWalletHome } from '../state/useWalletHome';
import { useWalletToken } from '../state/useWalletToken';
import { useTopUp } from '../state/useTopUp';
import { loyaltyPill, loyaltyProgress } from '../domain/loyalty';
import { relativeTime, toActivityRow } from '../domain/activity';
import { DEFAULT_TOP_UP_AMOUNT } from '../domain/topup';
import { WalletCard } from '../components/WalletCard';
import { PaymentCode } from '../components/PaymentCode';
import { ActivityFeed } from '../components/ActivityFeed';
import { BranchEarning } from '../components/BranchEarning';
import { HomeSkeleton } from '../components/HomeSkeleton';
import { FailureScreen } from '../components/FailureScreen';
import { OfflineBanner, StaleBanner } from '../components/Banners';
import { TopUpCard } from '../components/TopUpCard';
import { TopUpSheet } from '../components/TopUpSheet';
import { TransactionSheet } from '../components/TransactionSheet';
import { AccountButton } from '../components/AccountButton';

export function HomeScreen({ onOpenAccount }: { onOpenAccount: () => void }) {
  const { lang, copy } = useLanguage();
  const home = useWalletHome();
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
            CONTRACT GAP (reported, not filled): `Salon.name` is one string. The
            design's own reference set carries `nameAr: 'أمارا'`
            (design/avo-promotions.js:33) and renders it in AR, but
            api-contract.md's Salon has no Arabic field — so an Arabic wallet
            shows the Latin salon name. Shared-package change, belongs on trunk.
          */}
          <Text style={[text('displayM', lang), styles.salon]}>{salon.name}</Text>
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
