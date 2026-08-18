/**
 * The signed-in flow: which screen is showing, and the one place a scanned code
 * turns into a charge.
 *
 * A hand-rolled switch rather than a navigation library. The flow is a short
 * linear path with one modal, every transition is named in the design's own
 * `screen` state (:788-791), and a stack navigator would add a dependency and a
 * back-gesture model this surface does not want — a half-completed charge must
 * not be reachable by swiping backwards.
 *
 * THE SCAN → CHARGE PATH, IN ONE PLACE
 * ------------------------------------
 * `handleCode` is the only entry into a member card, and both sources reach it:
 * the camera, and a deep link carrying the same `avo://pay` URI. `POST /scans`
 * resolves the token to a member — the member charged is the one the SERVER
 * returns, never the `m` parameter in the code.
 */

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError } from '../api/client';
import { fetchSalonLoyalty, type SalonLoyalty } from '../api/salon';
import { resolveScan, type ScanResult } from '../api/scans';
import type { LookupMember } from '../api/members';
import { copy } from '../copy/en';
import { useSession } from '../state/session';
import { color } from '../theme';
import { CodeRefusedState } from '../components/States';
import { VoidSheet } from '../components/VoidSheet';
import { ChargesScreen } from './ChargesScreen';
import { HomeScreen, type HomeDestination } from './HomeScreen';
import { LookupScreen } from './LookupScreen';
import { MemberScreen, type ChargeAttempt } from './MemberScreen';
import { BookingsScreen } from './BookingsScreen';
import { ScheduleScreen } from './ScheduleScreen';
import { ResultScreen } from './ResultScreen';
import { ScanScreen } from './ScanScreen';

type Screen =
  | { name: 'home' }
  | { name: 'scan' }
  | { name: 'resolving' }
  | { name: 'codeRefused'; title: string; body: string }
  | { name: 'member'; scan: ScanResult; token: string | undefined }
  | { name: 'result'; attempt: ChargeAttempt }
  | { name: 'lookup' }
  | { name: 'charges'; voidTarget?: string }
  | { name: 'bookings' }
  | { name: 'schedule' };

export function ScannerFlow() {
  const { session, staff, signOut, reportFailure } = useSession();
  const [screen, setScreen] = useState<Screen>({ name: 'home' });
  const [salon, setSalon] = useState<SalonLoyalty | null>(null);
  const [voidFromResult, setVoidFromResult] = useState<string | null>(null);

  const accessToken = session?.accessToken ?? '';
  const salonId = staff?.salonId;

  // The loyalty configuration, once. A failure is not fatal: the member card
  // falls back to the tier pill, which is what a tiers salon shows anyway.
  useEffect(() => {
    if (!salonId || !accessToken) return;
    let alive = true;
    fetchSalonLoyalty(salonId, accessToken)
      .then((s) => {
        if (alive) setSalon(s);
      })
      .catch(() => {
        /* reported through the member card's fallback, not a blocking error */
      });
    return () => {
      alive = false;
    };
  }, [salonId, accessToken]);

  const handleCode = useCallback(
    async (code: { memberId: string; token: string }) => {
      setScreen({ name: 'resolving' });
      try {
        const scan = await resolveScan(code.token, accessToken);
        setScreen({ name: 'member', scan, token: code.token });
      } catch (err) {
        if (reportFailure(err)) return;
        if (err instanceof ApiError && err.status === 410) {
          // The two 410s are different sentences at the counter.
          setScreen(
            err.code === 'token_expired'
              ? { name: 'codeRefused', title: copy.codeExpiredTitle, body: copy.codeExpiredBody }
              : { name: 'codeRefused', title: copy.codeUsedTitle, body: copy.codeUsedBody },
          );
          return;
        }
        setScreen({
          name: 'codeRefused',
          title: copy.errorTitle,
          body: err instanceof ApiError ? err.message : copy.errorBody,
        });
      }
    },
    [accessToken, reportFailure],
  );

  /**
   * A member reached by manual lookup instead of a scan.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS USED TO ASSEMBLE A MEMBER CARD, AND EVERY PART IT ASSEMBLED WAS MADE UP.
   *
   * `GET /members?q=` is live now, so the lookup itself works — but it answers
   * with a directory row: id, salonId, name, phoneLast4, tier. No balance, no
   * stamps, by design. The card this used to open renders `member.balanceFils`
   * and `member.stamps` on the screen where money moves.
   *
   * It also passed `heldDepositFils: 0` and `services: []` as literals. The
   * zero was the worse of the two: `POST /scans` reads the REAL held deposit
   * through the same `findApplicableHold` the charge uses, precisely so what the
   * artist is shown and what the charge applies cannot disagree. A customer with
   * 5.000 held would have seen no deposit credit line while the charge quietly
   * applied one — non-negotiable #2 in the direction that embarrasses the salon
   * at the counter.
   *
   * There is no way to do this correctly yet. Nothing on the API resolves ONE
   * member for a staff caller: `POST /scans` requires a QR token, which is
   * exactly what a manual lookup does not have, and there is no
   * `GET /members/{id}`. So the honest outcome is to say so rather than open a
   * card full of invented money. ESCALATED to trunk — see copy.
   *
   * What is owed, and it is one endpoint: a scanner-scoped, salon-scoped read of
   * one member returning the SAME envelope `POST /scans` returns —
   * `{ member, heldDepositFils, heldDepositBooking, services }` — so this path
   * and the scan path show identical numbers because they came from one place.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  const handlePick = useCallback((_member: LookupMember) => {
    setScreen({
      name: 'codeRefused',
      title: copy.lookupPickBlockedTitle,
      body: copy.lookupPickBlockedBody,
    });
  }, []);

  const goHome = useCallback(() => setScreen({ name: 'home' }), []);

  const navigate = useCallback((to: HomeDestination) => {
    switch (to) {
      case 'scan':
        setScreen({ name: 'scan' });
        return;
      case 'charges':
        setScreen({ name: 'charges' });
        return;
      case 'bookings':
        setScreen({ name: 'bookings' });
        return;
      case 'schedule':
        setScreen({ name: 'schedule' });
        return;
    }
  }, []);

  const firstName = staff?.name.split(' ')[0] ?? 'there';
  // design:135, :402 — "Hessa · hessa" in both screens' headers.
  const staffHandle = staff?.handle ?? '—';

  return (
    <View style={styles.root}>
      {screen.name === 'home' && <HomeScreen onNavigate={navigate} onSignOut={signOut} />}

      {(screen.name === 'scan' || screen.name === 'resolving') && (
        <ScanScreen
          onCode={(code) => void handleCode(code)}
          onHome={goHome}
          onSignOut={signOut}
          onManualLookup={() => setScreen({ name: 'lookup' })}
          staffFirstName={firstName}
        />
      )}

      {screen.name === 'codeRefused' && (
        <View style={styles.padded}>
          <CodeRefusedState
            title={screen.title}
            body={screen.body}
            onScanAgain={() => setScreen({ name: 'scan' })}
            onManualLookup={() => setScreen({ name: 'lookup' })}
          />
        </View>
      )}

      {screen.name === 'member' && (
        <MemberScreen
          /*
            A FRESH INSTANCE PER MEMBER, DELIBERATELY.

            MemberScreen holds the selected services in component state. Two
            consecutive members rendered by the same element type would reuse
            that instance and carry the selection across — customer B charged
            for customer A's services. Today every path between two member
            cards passes through 'resolving' (which unmounts this), so the bug
            is not reachable; the key makes it unreachable by construction
            instead of by the current shape of the navigation.
          */
          key={`${screen.scan.member.id}:${screen.token ?? 'manual'}`}
          scan={screen.scan}
          token={screen.token}
          accessToken={accessToken}
          stampTarget={salon?.stampTarget ?? null}
          onRescan={() => setScreen({ name: 'scan' })}
          onCharged={(attempt) => setScreen({ name: 'result', attempt })}
        />
      )}

      {screen.name === 'result' && (
        <ResultScreen
          attempt={screen.attempt}
          onVoid={() => setVoidFromResult(screen.attempt.result.transaction.id)}
          onNext={() => setScreen({ name: 'scan' })}
        />
      )}

      {screen.name === 'lookup' && (
        <LookupScreen
          accessToken={accessToken}
          onBack={() => setScreen({ name: 'scan' })}
          onPick={handlePick}
        />
      )}

      {screen.name === 'charges' && (
        <ChargesScreen
          accessToken={accessToken}
          onHome={goHome}
          voidTargetOnOpen={screen.voidTarget}
        />
      )}

      {screen.name === 'bookings' && (
        <BookingsScreen
          accessToken={accessToken}
          onHome={goHome}
          staffFirstName={firstName}
          staffHandle={staffHandle}
        />
      )}

      {screen.name === 'schedule' && (
        <ScheduleScreen
          accessToken={accessToken}
          onHome={goHome}
          staffFirstName={firstName}
          staffHandle={staffHandle}
        />
      )}

      {/*
        Voiding straight off the result screen — design:390. It opens the same
        sheet the charge list uses, so there is one void implementation and one
        idempotency discipline.
      */}
      {voidFromResult && (
        <VoidSheet
          transactionId={voidFromResult}
          accessToken={accessToken}
          onClose={() => setVoidFromResult(null)}
          onVoided={() => {
            setVoidFromResult(null);
            setScreen({ name: 'scan' });
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.surface },
  padded: { flex: 1, justifyContent: 'center', paddingHorizontal: 22 },
});
