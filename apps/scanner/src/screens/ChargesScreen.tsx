/**
 * Today's charges, and the void — design:242-273, and the locked variant at
 * :276-302.
 *
 * THIS SCREEN IS WHERE NON-NEGOTIABLE #7 IS PROVED
 * ================================================
 * "Permissions are enforced server-side. The UI hiding a button is a courtesy,
 * not a control."
 *
 * So this screen does NOT branch on `perms.charges` before deciding whether to
 * call the API. It always calls `GET /charges?date=today`, and it renders the
 * locked screen when the SERVER answers 403. The padlock on the home tile is
 * drawn from the client's copy of `perms` because a tile has to draw something;
 * what is actually enforced is the response.
 *
 * The practical difference: a client whose cached `perms` say `charges: true`
 * when the server has revoked it still gets the locked screen, because the
 * locked screen is driven by the refusal rather than by the belief.
 *
 * CONTRACT GAP — REPORTED, RENDERED HONESTLY
 * ==========================================
 * The design's row is "Noura S. / Blow-dry / 2:10 PM · by Rana". `GET /charges`
 * returns bare `Transaction` rows — no member name, no service names, no staff
 * name (api/src/routes/charges.ts:156-168). Those three fields have nowhere to
 * come from, so the row shows what exists (reference, time, amount) and leaves
 * the rest out. Filling them with a lookup per row would be N+1 requests
 * against an endpoint that does not exist either; inventing them is worse.
 *
 * THE VOID STATE IS NOW THE SERVER'S, WHICH IT WAS NOT
 * ====================================================
 * A void is a compensating `adjustment` row, never an edit of the charge, so
 * "is this charge voided" is a fact about a DIFFERENT row. The API has always
 * answered it — a self-join on `reverses_transaction_id` filling `voidedAt` and
 * `reversedByTransactionId` — and `TransactionSchema` was stripping both.
 *
 * With the evidence deleted, this screen could only remember the voids it had
 * performed itself, in a `voided` map that lives as long as the component. A
 * reload, a second device, or a colleague's void all produced the same wrong
 * screen: a refunded charge rendered identically to a live one, with "Void this
 * charge" underneath it. Tapping that is a 409 in front of a customer.
 *
 * So `voidedAt` decides, and the local map only supplies the reason text for a
 * void taken in this session — the list does not carry a reason, and this
 * screen does not invent one.
 */

import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { fils } from '@avo/types';
import { ApiError } from '../api/client';
import { fetchTodaysCharges, type ChargeRow } from '../api/charges';
import { fetchRoster } from '../api/staff';
import { copy } from '../copy/en';
import { useSession } from '../state/session';
import { color, display, radius, ui } from '../theme';
import { DangerButton, LinkButton, PrimaryButton } from '../components/Buttons';
import { Money } from '../components/Money';
import {
  EmptyState,
  ErrorState,
  OfflineBanner,
  Refusal,
  SkeletonRows,
} from '../components/States';
import { VoidSheet } from '../components/VoidSheet';

const VOID_WINDOW_MS = 15 * 60_000;

type Load =
  | { state: 'loading' }
  | { state: 'ready'; rows: ChargeRow[] }
  | { state: 'forbidden'; message: string }
  | { state: 'offline' }
  | { state: 'error'; message: string; reference: string };

export function ChargesScreen({
  accessToken,
  onHome,
  /** Opened straight onto a void from the result screen — design:787. */
  voidTargetOnOpen,
}: {
  accessToken: string;
  onHome: () => void;
  voidTargetOnOpen?: string | undefined;
}) {
  const { staff, can, refreshPerms, reportFailure } = useSession();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [voidTarget, setVoidTarget] = useState<string | null>(voidTargetOnOpen ?? null);
  const [voided, setVoided] = useState<Record<string, string>>({});
  const [authorised, setAuthorised] = useState<{ name: string; role: string }[]>([]);
  const [asked, setAsked] = useState(false);

  const reload = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const rows = await fetchTodaysCharges(accessToken);
      setLoad({ state: 'ready', rows });
    } catch (err) {
      if (reportFailure(err)) return;
      if (err instanceof ApiError) {
        if (err.status === 403) {
          setLoad({ state: 'forbidden', message: err.message });
          // The server disagreed with our cached authority. Re-read it so the
          // home tile stops promising something the server refuses.
          void refreshPerms();
          return;
        }
        if (err.kind === 'offline') {
          setLoad({ state: 'offline' });
          return;
        }
        setLoad({ state: 'error', message: err.message, reference: err.reference });
        return;
      }
      setLoad({ state: 'error', message: copy.errorBody, reference: '—' });
    }
  }, [accessToken, refreshPerms, reportFailure]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The locked screen names who can grant the permission (design:290). See
  // api/staff.ts § fetchRoster for why this can itself be refused — when it is,
  // the section simply does not render.
  useEffect(() => {
    if (load.state !== 'forbidden') return;
    let alive = true;
    fetchRoster(accessToken)
      .then((all) => {
        if (!alive) return;
        setAuthorised(
          all
            .filter((s) => s.perms.charges)
            .map((s) => ({ name: s.name, role: copy.roles[s.role] ?? s.role })),
        );
      })
      .catch(() => {
        /* Reported in the module doc. The screen stands without the names. */
      });
    return () => {
      alive = false;
    };
  }, [load.state, accessToken]);

  // ------------------------------------------------------------- refusal --

  if (load.state === 'forbidden') {
    const first = staff?.name.split(' ')[0] ?? 'This';
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <LinkButton label={copy.home} onPress={onHome} testID="charges-home" />
        <Refusal title={copy.lockedTitle} body={copy.lockedBody(first)}>
          {authorised.length > 0 && (
            <View style={styles.whoCard}>
              <Text style={[ui(11, '600'), styles.whoTitle]}>
                {copy.lockedWhoTitle.toUpperCase()}
              </Text>
              <View style={styles.whoList}>
                {authorised.map((a) => (
                  <View key={a.name} style={styles.whoRow}>
                    <View style={styles.whoAvatar}>
                      <Text style={[ui(12, '600'), styles.whoInitial]}>{a.name.charAt(0)}</Text>
                    </View>
                    <Text style={[ui(13.5), styles.whoName]}>{a.name}</Text>
                    <Text style={[ui(11.5, '600'), styles.whoRole]}>{a.role}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
          <PrimaryButton
            label={
              asked
                ? copy.askManagerSent(authorised[0]?.name.split(' ')[0] ?? 'your manager')
                : copy.askManager
            }
            onPress={() => setAsked(true)}
            disabled={asked}
            style={styles.askAction}
            testID="charges-ask"
          />
        </Refusal>
      </ScrollView>
    );
  }

  // --------------------------------------------------------------- states --

  const canVoid = can('void');

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <LinkButton label={copy.home} onPress={onHome} testID="charges-home" />
        <Text style={[ui(12), styles.eyebrow]}>{todayName()}</Text>
      </View>

      <Text style={display(24)}>{copy.chargesTitle}</Text>

      {load.state === 'ready' && (
        <Text style={[ui(12.5), styles.sub]}>
          {copy.chargesSummary(load.rows.length, load.rows.filter(isVoidable).length)}.{' '}
          {canVoid ? copy.voidRuleCan : copy.voidRuleCannot}
        </Text>
      )}

      {load.state === 'loading' && (
        <View style={styles.list}>
          <SkeletonRows count={4} />
        </View>
      )}

      {load.state === 'offline' && (
        <View style={styles.list}>
          {/*
            `offlineTitle`, not the default `offlineBanner`. This is a COLD load —
            the whole list failed — so "No connection · showing your last update"
            promises a last update that is not on screen and never was. Same lie
            DECISIONS.md § "The offline cold-load sentence" names, in a screen that
            otherwise had this state right from the start. No new string needed.
          */}
          <OfflineBanner label={copy.offlineTitle} />
          <View style={styles.retry}>
            <PrimaryButton label={copy.tryAgain} onPress={() => void reload()} />
          </View>
        </View>
      )}

      {load.state === 'error' && (
        <ErrorState
          reference={load.reference}
          body={load.message}
          onRetry={() => void reload()}
        />
      )}

      {load.state === 'ready' && load.rows.length === 0 && (
        <View style={styles.list}>
          <EmptyState title={copy.chargesEmptyTitle} body={copy.chargesEmptyBody} />
        </View>
      )}

      {load.state === 'ready' && load.rows.length > 0 && (
        <View style={styles.list}>
          {load.rows.map((row) => {
            // The reason we sent, if the void happened in THIS session. The
            // server is the authority on whether the charge is voided at all —
            // `voidedAt` covers the reload, the second device, and the
            // colleague who voided it a minute ago. The local reason only ever
            // makes the sentence more specific, never makes it true.
            const reason = voided[row.id];
            const voidedAt = row.voidedAt;
            const isVoided = voidedAt !== null || reason !== undefined;
            return (
              <View key={row.id} style={styles.card} testID={`charge-${row.id}`}>
                <View style={styles.cardTop}>
                  <View style={styles.cardText}>
                    {/*
                      The design's customer name and service list have no source
                      on this endpoint — see the note at the top of this file.
                      The reference is what identifies the charge to staff.
                    */}
                    <Text style={ui(14.5, '600')}>{row.reference}</Text>
                    <Text style={[ui(11.5), styles.cardMeta]}>{timeOf(row.createdAt)}</Text>
                  </View>
                  <Money
                    amount={fils(Math.abs(row.amountFils))}
                    figureStyle={[display(16, '600'), isVoided ? styles.struck : null]}
                    hideUnit
                  />
                </View>

                {isVoided ? (
                  <View style={styles.voidedNote}>
                    <View style={styles.voidedDot} />
                    <Text style={[ui(12), styles.voidedText]}>
                      {reason
                        ? copy.voidedNote(reason)
                        : voidedAt
                          ? copy.voidedAtNote(timeOf(voidedAt))
                          : null}
                    </Text>
                  </View>
                ) : (
                  canVoid &&
                  isVoidable(row) && (
                    <DangerButton
                      label={copy.voidThis}
                      onPress={() => setVoidTarget(row.id)}
                      style={styles.voidAction}
                      testID={`void-${row.id}`}
                    />
                  )
                )}
              </View>
            );
          })}
        </View>
      )}

      {voidTarget && (
        <VoidSheet
          transactionId={voidTarget}
          accessToken={accessToken}
          onClose={() => setVoidTarget(null)}
          onVoided={(_refunded, reason) => {
            setVoided((prev) => ({ ...prev, [voidTarget]: reason }));
            setVoidTarget(null);
            // The balance and the ledger changed server-side; re-read rather
            // than patching a local copy of money.
            void reload();
          }}
        />
      )}
    </ScrollView>
  );
}

/**
 * Voidable means inside the 15-minute window AND not already voided.
 *
 * The second half is new, and it is the half that was a defect. `voidedAt` was
 * being stripped by the contract, so this function could only ask about the
 * clock; a charge voided ten minutes ago came back from the server looking
 * exactly like a live one and the screen offered "Void this charge" on it. The
 * staff member tapped it in front of the customer and got an error for doing
 * what the screen invited. Local `voided` state hid it within a session and did
 * nothing across a reload, a second device, or a void taken by a colleague.
 */
function isVoidable(row: ChargeRow): boolean {
  if (row.voidedAt !== null) return false;
  return Date.now() - new Date(row.createdAt).getTime() < VOID_WINDOW_MS;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
}

/** design:247 shows the weekday. */
function todayName(): string {
  return new Date().toLocaleDateString('en-GB', { weekday: 'long' });
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: { paddingTop: 66, paddingHorizontal: 22, paddingBottom: 26, flexGrow: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  eyebrow: { color: color.textMutedSoft },
  sub: { color: color.textMuted, marginTop: 5, lineHeight: 19 },
  list: { marginTop: 16, gap: 10 },
  retry: { marginTop: 16 },
  card: {
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    padding: 15,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  cardText: { flex: 1 },
  cardMeta: { color: color.textMutedSoft, marginTop: 4 },
  struck: { color: color.textMutedSoft, textDecorationLine: 'line-through' },
  voidAction: { marginTop: 13 },
  voidedNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.dangerBg,
    borderRadius: 11,
    paddingVertical: 10,
    paddingHorizontal: 13,
    marginTop: 13,
  },
  voidedDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.dangerDot },
  voidedText: { color: color.dangerText, flex: 1 },
  whoCard: {
    alignSelf: 'stretch',
    marginTop: 26,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    padding: 16,
  },
  whoTitle: { color: color.textMutedSoft, letterSpacing: 0.9 },
  whoList: { gap: 9, marginTop: 11 },
  whoRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  whoAvatar: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: color.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  whoInitial: { color: color.brandDeep },
  whoName: { flex: 1 },
  whoRole: { color: color.textMutedSoft },
  askAction: { alignSelf: 'stretch', marginTop: 18 },
});
