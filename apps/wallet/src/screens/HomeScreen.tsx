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
import { en } from '../copy/en';
import { useWalletHome } from '../state/useWalletHome';
import { useWalletToken } from '../state/useWalletToken';
import { useTopUp } from '../state/useTopUp';
import { loyaltyPill, loyaltyProgress, tierLabel } from '../domain/loyalty';
import { clockTime, relativeTime, toActivityRow } from '../domain/activity';
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

export function HomeScreen() {
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
        ? snapshot.transactions.map((tx) => toActivityRow(tx, snapshot.salon.branches))
        : [],
    [snapshot],
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
          message={failure?.message ?? en.errorBody}
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
            tierName={member.tier ? tierLabel(member.tier) : null}
          />
          <TransactionSheet
            transaction={openTx}
            branches={salon.branches}
            onClose={() => setOpenTxId(null)}
          />
        </>
      }
    >
      {offline ? <OfflineBanner /> : null}
      {status === 'stale' && fetchedAt ? (
        <StaleBanner at={clockTime(fetchedAt)} onRetry={home.retry} />
      ) : null}

      <View style={styles.header}>
        <View>
          <Text style={[text('body'), styles.greeting]}>{en.greeting(firstName)}</Text>
          <Text style={[text('displayM'), styles.salon]}>{salon.name}</Text>
        </View>
      </View>

      <WalletCard
        balanceFils={member.balanceFils}
        pill={loyaltyPill(progress)}
        progress={progress}
        lastUpdated={offline && fetchedAt ? en.lastUpdated(relativeTime(fetchedAt)) : null}
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
          <Text style={[text('bodyL'), styles.offlineRetryText]}>{en.tryAgain}</Text>
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
    marginBottom: 20,
  },
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
