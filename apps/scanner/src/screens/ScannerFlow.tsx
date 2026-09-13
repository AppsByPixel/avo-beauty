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
 * the camera, and a deep link carrying the same `avostaff://pay` URI. `POST /scans`
 * resolves the token to a member — the member charged is the one the SERVER
 * returns, never the `m` parameter in the code.
 */

import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError } from '../api/client';
import { fetchSalonLoyalty, type SalonLoyalty } from '../api/salon';
import { adoptSalonName } from '../config/brand';
import { resolveScan, type ScanResult } from '../api/scans';
import { fetchMember, type LookupMember } from '../api/members';
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
  /**
   * `from` because resolving looks different depending on which door she came
   * through. A scan resolves behind the camera screen, which is what the artist is
   * already looking at. A manual open must NOT flash the camera — it stays on the
   * lookup list she just tapped, so the row she picked is still on screen while
   * the server answers.
   */
  | { name: 'resolving'; from: 'scan' | 'lookup' }
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
        if (!alive) return;
        setSalon(s);
        /*
          The name is read at render time (config/brand.ts), so a rename in the
          dashboard reaches Home's heading now rather than at the next launch. The
          COLOUR cannot follow it: the stylesheets copied their colours when their
          modules were evaluated. See src/theme/sealed.ts.
        */
        adoptSalonName(s.name);
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
      setScreen({ name: 'resolving', from: 'scan' });
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
   * A member reached by manual lookup instead of a scan — THE LAST STEP, and it
   * used to be a dead end.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * WHAT THIS REPLACES, AND WHY THE REPLACEMENT IS ONE LINE OF FETCH
   *
   * Before `GET /members/{id}` existed this had two possible shapes, and both
   * were wrong. Assembling a card from the directory row meant passing
   * `heldDepositFils: 0` and `services: []` as literals — a customer with 5.000
   * held would see no deposit credit line while the charge quietly applied one,
   * non-negotiable #2 in the direction that embarrasses the salon at the counter.
   * Refusing to open the card at all was honest but left the fallback failing in
   * exactly the situation it exists for: her phone is flat and she is at the till.
   *
   * The endpoint lands and both problems dissolve, because it returns the SAME
   * envelope `POST /scans` returns from the SAME server-side builder
   * (api/src/services/counter.ts). So there is nothing to assemble here. The
   * manual path is not a second member card — it is `handleCode`'s card reached
   * through a different door, and the only difference that survives is the one
   * that matters:
   *
   *   NO TOKEN. `token: undefined` below, and it is deliberate. A wallet token is
   *   what normally proves the customer was present to authorise the debit; a
   *   dead phone cannot mint one, and `POST /charges` declares the field optional
   *   for precisely this case (api/src/routes/charges.ts:118). What replaces the
   *   proof is the audit trail: the server writes an append-only row naming this
   *   staff member for the search, another for the open, and another for the
   *   charge. That is why the screen tells the artist her lookups are logged —
   *   the log is the control that stands in for the token.
   *
   * `resolving` first, so the member card never renders against a stale envelope
   * — and it also unmounts MemberScreen, which is what stops a previous
   * customer's service selection from surviving into this one.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  const handlePick = useCallback(
    async (member: LookupMember) => {
      setScreen({ name: 'resolving', from: 'lookup' });
      try {
        // The id from the row, but every FIGURE on the card comes from this
        // response. The row carried no balance and no services on purpose.
        const envelope = await fetchMember(member.id, accessToken);
        setScreen({ name: 'member', scan: envelope, token: undefined });
      } catch (err) {
        if (reportFailure(err)) return;
        setScreen({
          name: 'codeRefused',
          title: copy.lookupOpenFailedTitle,
          body: err instanceof ApiError ? err.message : copy.errorBody,
        });
      }
    },
    [accessToken, reportFailure],
  );

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

      {(screen.name === 'scan' ||
        (screen.name === 'resolving' && screen.from === 'scan')) && (
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

      {(screen.name === 'lookup' ||
        (screen.name === 'resolving' && screen.from === 'lookup')) && (
        <LookupScreen
          accessToken={accessToken}
          onBack={() => setScreen({ name: 'scan' })}
          onPick={(member) => void handlePick(member)}
          /*
            Opening is a second request, and while it is in flight the list must
            not accept another tap: two members opened from one list is two
            envelopes racing for one member card, and the loser could be the one
            that renders. The screen shows its existing skeleton, the same one the
            search uses, rather than a new spinner nobody designed.
          */
          opening={screen.name === 'resolving'}
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
