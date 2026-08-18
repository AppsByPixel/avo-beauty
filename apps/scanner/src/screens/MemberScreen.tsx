/**
 * Member card, service chips, totals, charge — design:325-374.
 *
 * The screen where the money actually moves, so the rules are worth restating
 * at the top of it:
 *
 *   #2 The server owns the balance. The card shows what the scan returned; the
 *      totals footer adds up prices the server sent; nothing here decides
 *      whether the wallet can afford it. The 402 does, and it carries the exact
 *      shortfall (:364 "Balance too low by <b>{{ shortStr }} KD</b>").
 *   #3 One transaction. If the charge fails, nothing happened — including the
 *      QR token, which the API deliberately does NOT consume on a 402, so the
 *      customer tops up at the counter and the SAME code is rescanned.
 *   #4 One idempotency key per attempt, minted once and reused across retries
 *      of that attempt. `attemptKey` below.
 *
 * THE DOUBLE-SUBMIT CASE, WHICH IS THE ONE THAT COSTS MONEY
 * ---------------------------------------------------------
 * An artist tapping Charge twice on a slow connection must not debit twice.
 * Two guards, and both are needed:
 *   - `busy` disables the button, which handles the fast double-tap;
 *   - the idempotency key is stable for the attempt, so if the first request
 *     did reach the server and the second is a retry of it, the server replays
 *     the stored result instead of charging again. That is the guard that
 *     survives a dropped response, which `busy` cannot.
 *
 * THE DOUBLE-CHARGE PATH IDEMPOTENCY CANNOT SEE
 * ---------------------------------------------
 * Those two guards protect the attempt. They do not protect the RECOVERY, and the
 * recovery crosses the attempt boundary. Traced end to end on this screen:
 *
 *   1. `POST /charges` succeeds server-side — wallet debited, visit counted,
 *      receipt queued.
 *   2. The response cannot be read. (It has happened for real: the API omitted two
 *      fields `TransactionSchema` requires, so a landed charge parsed as a
 *      failure. Fixed in the API, but a dropped connection does the same thing and
 *      cannot be fixed.)
 *   3. Staff reach for Rescan. That unmounts this component.
 *   4. Remounting re-runs `useRef(newIdempotencyKey())` below — a NEW key.
 *   5. Her app mints a fresh token; the spent one is gone.
 *   6. Fresh key, fresh body, fresh token: the server takes a SECOND real charge,
 *      correctly, because nothing about it is a duplicate.
 *
 * Every step is the system working as designed, which is why no idempotency test
 * finds it — the server behaved properly both times. The consequence for this
 * screen is a rule about what the error state may offer: NOT a retry. A client
 * that could not read the response does not know whether the money moved, so the
 * only honest instruction is to check her balance, which is what it now says.
 *
 * Re-tapping Charge, by contrast, is safe and stays enabled: the key has not
 * changed and neither has the basket, so the server replays its stored answer
 * rather than charging again. The dangerous affordance is the one that unmounts
 * this screen, not the one that repeats the request.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { fils, formatMoney, type Fils } from '@avo/types';
import { ApiError, newIdempotencyKey } from '../api/client';
import { charge, type ChargeResult } from '../api/charges';
import type { ScanResult } from '../api/scans';
import { copy } from '../copy/en';
import { chargeTotals } from '../domain/charge';
import { loyaltyPill, memberSubtitle } from '../domain/loyalty';
import { useSession } from '../state/session';
import { card, color, display, MIN_TAP_TARGET, radius, ui } from '../theme';
import { LinkButton, PrimaryButton } from '../components/Buttons';
import { figureOf, Money } from '../components/Money';
import { OfflineBanner } from '../components/States';

export interface ChargeAttempt {
  result: ChargeResult;
  memberName: string;
  loyaltyPillText: string;
}

export function MemberScreen({
  scan,
  token,
  accessToken,
  stampTarget,
  onRescan,
  onCharged,
}: {
  scan: ScanResult;
  /** Absent when the member was found by manual lookup rather than scanned. */
  token: string | undefined;
  accessToken: string;
  /** From the salon, for the stamps pill. Null at a tiers salon. */
  stampTarget: number | null;
  onRescan: () => void;
  onCharged: (attempt: ChargeAttempt) => void;
}) {
  const { reportFailure } = useSession();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [shortfall, setShortfall] = useState<Fils | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);

  /**
   * One key per ATTEMPT. It is regenerated when the basket changes, because the
   * API treats the same key with a different body as a conflict rather than a
   * replay (api/src/services/idempotency.ts) — reusing it would turn a
   * corrected basket into a 409 instead of a charge.
   */
  const attemptKey = useRef(newIdempotencyKey());

  const heldDeposit = fils(scan.heldDepositFils);
  const totals = useMemo(
    () => chargeTotals(scan.services, selected, heldDeposit),
    [scan.services, selected, heldDeposit],
  );

  const toggle = useCallback((id: string) => {
    setShortfall(null);
    setFailure(null);
    attemptKey.current = newIdempotencyKey();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    if (busy || !totals.hasSelection) return;
    setBusy(true);
    setFailure(null);
    setShortfall(null);
    try {
      const result = await charge(
        {
          memberId: scan.member.id,
          serviceIds: scan.services.filter((s) => selected.has(s.id)).map((s) => s.id),
          token,
        },
        attemptKey.current,
        accessToken,
      );
      onCharged({
        result,
        memberName: scan.member.name,
        loyaltyPillText: loyaltyPill(scan.member, stampTarget),
      });
    } catch (err) {
      // A dead session replaces this screen with the PIN pad; there is nothing
      // useful to render here in that case.
      if (reportFailure(err)) return;
      if (err instanceof ApiError) {
        const short = err.shortfallFils;
        if (err.code === 'insufficient_balance' && short !== null) {
          // The server's number, rendered. Not a subtraction done here.
          setShortfall(fils(short));
        } else {
          setFailure(err);
        }
      }
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    totals.hasSelection,
    scan,
    selected,
    token,
    accessToken,
    stampTarget,
    onCharged,
    reportFailure,
  ]);

  const firstName = scan.member.name.split(' ')[0] ?? scan.member.name;
  const shortCopy = copy.shortfall(firstName);

  const label = !totals.hasSelection
    ? copy.chargeSelectFirst
    : busy
      ? copy.chargeWorking
      : shortfall !== null
        ? copy.chargeTooLow
        : copy.chargeAction(formatMoney(totals.chargedFils));

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <LinkButton label={copy.rescan} onPress={onRescan} testID="member-rescan" />
          <Text style={[ui(12), styles.eyebrow]}>{copy.charging}</Text>
        </View>

        {/* The member card — design:333-350. */}
        <LinearGradient
          colors={[card.from, card.to]}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={styles.memberCard}
        >
          <View style={styles.memberRow}>
            <View style={styles.avatar}>
              <Text style={[display(20, '600'), styles.onBrand]}>
                {scan.member.name.charAt(0).toUpperCase()}
              </Text>
            </View>
            <View style={styles.memberNames}>
              <Text style={[ui(16, '600'), styles.onBrand]} testID="member-name">
                {scan.member.name}
              </Text>
              <Text style={[ui(12), styles.onBrandMuted]}>{memberSubtitle(scan.member)}</Text>
            </View>
            <View style={styles.pill}>
              <Text style={[ui(12, '600'), styles.onBrand]} testID="member-loyalty">
                {loyaltyPill(scan.member, stampTarget)}
              </Text>
            </View>
          </View>

          {/* Stamp dots — design:339-345. Only at a stamps salon. */}
          {scan.member.stamps !== null && stampTarget !== null && (
            <View style={styles.stamps}>
              {Array.from({ length: stampTarget }, (_, i) => (
                <View
                  key={i}
                  style={[
                    styles.stampDot,
                    i < (scan.member.stamps ?? 0) ? styles.stampOn : styles.stampOff,
                  ]}
                />
              ))}
            </View>
          )}

          <View style={styles.balanceRow}>
            <Text style={[ui(12, '600'), styles.balanceLabel]}>{copy.walletBalance}</Text>
            <Money
              amount={fils(scan.member.balanceFils)}
              figureStyle={[display(26), styles.onBrand]}
              unitStyle={[ui(13), styles.onBrandMuted]}
            />
          </View>
        </LinearGradient>

        {/*
          The held deposit — design:352-355. Driven entirely by the server's
          `heldDepositFils`, so it appears only when there genuinely is one.

          NO LONGER UNREACHABLE. This carried a note saying the API returned 0
          unconditionally because bookings were not built; bookings are built, and
          `counterEnvelope` now reads the real hold through the same
          `findApplicableHold` the charge uses. Driven against a real server on
          both paths — scanned and manually looked up — with a booking inside the
          no-show grace window.

          The window is the part worth knowing: a hold only applies while the
          booking is within `noShowReturnMinutes` of now, so a fixture booked far
          in the future correctly shows 0 here and looks identical to a bug. It has
          been read as one twice.
        */}
        {heldDeposit > 0 && (
          <View style={styles.depositBanner} testID="deposit-banner">
            <View style={styles.depositDot} />
            <Text style={[ui(12.5), styles.depositText]}>
              {copy.depositAppliesLead}{' '}
              <Text style={ui(12.5, '700')}>{figureOf(heldDeposit)}</Text> {copy.depositApplies}
            </Text>
          </View>
        )}

        <Text style={[ui(12, '600'), styles.sectionLabel]}>{copy.selectServices}</Text>
        <View style={styles.chips}>
          {scan.services.map((s) => {
            const on = selected.has(s.id);
            return (
              <Pressable
                key={s.id}
                onPress={() => toggle(s.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${s.name}, ${formatMoney(fils(s.priceFils))}`}
                testID={`service-${s.id}`}
                style={[styles.chip, on ? styles.chipOn : styles.chipOff]}
              >
                <Text style={[ui(13.5, '500'), on ? styles.onBrand : styles.chipText]}>
                  {s.name}
                </Text>
                <Text
                  style={[
                    display(13.5, '600'),
                    on ? styles.chipPriceOn : styles.chipPriceOff,
                  ]}
                >
                  {figureOf(fils(s.priceFils))}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* design:364 — the shortfall, verbatim, with the SERVER's number. */}
        {shortfall !== null && (
          <View
            style={styles.shortfall}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            testID="shortfall"
          >
            <View style={styles.shortfallDot} />
            <Text style={[ui(12.5), styles.shortfallText]}>
              {shortCopy.lead}{' '}
              <Text style={ui(12.5, '700')}>{formatMoney(shortfall)}</Text> {shortCopy.tail}
            </Text>
          </View>
        )}

        {/*
          A FAILED CHARGE, AND DELIBERATELY NO "TRY AGAIN" BUTTON.

          See § THE DOUBLE-CHARGE PATH at the top of this file. The short version:
          this branch also covers the case where the debit SUCCEEDED and only the
          reply was unreadable, so the one thing the screen must not do is make a
          second charge one confident tap away. The design's retry affordance
          (States:103,137) is right for a failed load and wrong for a failed
          charge, because a client that could not read the response does not know
          whether the money moved.

          What it says instead is the check the client can no longer make: look at
          her balance. An offline failure is the exception — nothing left the
          device, so the outcome is not in doubt and the banner alone is honest.
        */}
        {failure && (
          <View style={styles.failure} accessibilityRole="alert" testID="charge-failure">
            {failure.kind === 'offline' ? (
              <OfflineBanner label={copy.offlineBody} />
            ) : (
              <>
                <Text style={[ui(12.5), styles.shortfallText]}>{failure.message}</Text>
                <Text
                  style={[ui(12.5, '600'), styles.shortfallText, styles.unknownOutcome]}
                  testID="charge-unknown-outcome"
                >
                  {copy.chargeUnknownOutcome}
                </Text>
                <Text style={[ui(11.5), styles.failureRef]}>{copy.reference(failure.reference)}</Text>
              </>
            )}
          </View>
        )}
      </ScrollView>

      {/* The totals footer — design:367-372. Pinned, outside the scroll. */}
      <View style={styles.footer}>
        <Row label={copy.totalServices} amount={totals.totalFils} />
        <Row label={copy.totalDeposit} amount={totals.creditFils} negative />
        <View style={styles.grandRow}>
          <Text style={ui(14, '600')}>{copy.totalToCharge}</Text>
          <Money
            amount={totals.chargedFils}
            figureStyle={display(22, '600')}
            unitStyle={[ui(13), styles.mutedUnit]}
          />
        </View>
        <PrimaryButton
          label={label}
          onPress={() => void submit()}
          disabled={!totals.hasSelection || busy || shortfall !== null}
          testID="charge-button"
        />
      </View>
    </View>
  );
}

function Row({ label, amount, negative }: { label: string; amount: Fils; negative?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[ui(13), styles.rowLabel]}>{label}</Text>
      <View style={styles.rowValue}>
        {negative && <Text style={[display(13, '600'), styles.credit]}>− </Text>}
        <Text style={[display(13, '600'), negative ? styles.credit : styles.rowAmount]}>
          {figureOf(amount)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { paddingTop: 66, paddingHorizontal: 22, paddingBottom: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  eyebrow: { color: color.textMutedSoft },
  memberCard: { borderRadius: radius.walletCard, padding: 18 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberNames: { flex: 1 },
  onBrand: { color: color.white },
  onBrandMuted: { color: 'rgba(255,255,255,0.85)', marginTop: 1 },
  pill: {
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  stamps: { flexDirection: 'row', gap: 6, marginTop: 15, flexWrap: 'wrap' },
  stampDot: { width: 18, height: 18, borderRadius: 9 },
  stampOn: { backgroundColor: color.white },
  stampOff: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.45)' },
  balanceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.2)',
  },
  balanceLabel: {
    color: 'rgba(255,255,255,0.85)',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  depositBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.brandTint,
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  depositDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.brand },
  depositText: { color: color.brandDeeper, flex: 1, lineHeight: 18 },
  sectionLabel: {
    color: color.textMutedLabel,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: 22,
    marginBottom: 12,
    marginHorizontal: 2,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    flexBasis: '47.5%',
    flexGrow: 1,
    minHeight: MIN_TAP_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radius.chip,
    borderWidth: 1,
  },
  chipOn: { backgroundColor: color.brandDeep, borderColor: color.brandDeep },
  chipOff: { backgroundColor: color.white, borderColor: 'rgba(28,27,25,0.12)' },
  chipText: { color: color.ink },
  chipPriceOn: { color: 'rgba(255,255,255,0.9)' },
  chipPriceOff: { color: color.textMuted },
  shortfall: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 18,
  },
  shortfallDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.dangerDot },
  shortfallText: { color: color.dangerText, flex: 1, lineHeight: 18 },
  failure: {
    marginTop: 18,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  /** The instruction, weighted above the server's message — it is the action. */
  unknownOutcome: { marginTop: 8 },
  failureRef: { color: color.textMutedSoft, marginTop: 6 },
  footer: {
    backgroundColor: color.white,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
    paddingTop: 16,
    paddingHorizontal: 22,
    paddingBottom: 30,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  rowLabel: { color: color.textMutedLabel },
  rowValue: { flexDirection: 'row' },
  rowAmount: { color: color.ink },
  credit: { color: color.positive },
  grandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingTop: 9,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
    marginBottom: 14,
  },
  mutedUnit: { color: color.textMuted },
});
