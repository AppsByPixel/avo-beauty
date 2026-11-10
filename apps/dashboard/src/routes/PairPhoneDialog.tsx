import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { create as createQr } from 'qrcode';
import {
  STAFF_PAIRING_TTL_MINUTES,
  STAFF_PAIRING_URL,
  type StaffUser,
} from '@avo/types';
import { Button, Select, Skeleton } from '@avo/ui';
import { ApiError } from '../api/client.js';
import {
  PERMISSIONS,
  formatStaffPhone,
  issuePairingCode,
  staffKeys,
  type StaffPairingCode,
} from '../api/staff.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { WriteError } from './sectionState.js';

/**
 * Merchant → Accounts → a staff card → "Pair a phone".
 *
 * NEW PRODUCT, NOT A DESIGN BUILT. Aftab approved staff phone pairing on
 * 2026-11-10 (DECISIONS.md § Staff phone pairing, phone sign-in, and a truthful
 * receipt line); there is no design file for this dialog, so every sentence in it
 * is INVENTED and kept plain, and it is assembled from the components and tokens
 * the rest of the dashboard already uses. The dashboard is English-only.
 *
 * WHAT IT DOES. It asks the server for one single-use pairing code for one staff
 * member and shows it three ways: a QR the AVO Staff app scans
 * (`${STAFF_PAIRING_URL}?t=${token}`), the six digits she can type with her
 * mobile number when the camera will not cooperate, and how long both have left.
 * The staff member chooses her own PIN ON THE PHONE — non-negotiable #6: a PIN is
 * never typed here, never in the QR.
 *
 * THE TOKEN LIVES IN THIS COMPONENT'S STATE AND NOWHERE ELSE. Not a query cache
 * (`issuePairingCode` is deliberately not a `useMutation` — `api/staff.ts` says
 * why), not storage, not the URL, not a log line. Closing the dialog unmounts it
 * and the state goes with it; reaching the expiry drops it from state too, since a
 * dead token has no reason to stay in memory.
 *
 * THE BRANCH. A code that names a branch also enrols the paired phone as a till
 * there — what `POST /salons/{id}/devices` does — so it needs `perms.dashboard` as
 * well as `perms.team`, and the server checks both. Here:
 *
 *   no perms.dashboard          send none: the phone is paired, not enrolled
 *   perms.dashboard, 1 branch   send it, without asking
 *   perms.dashboard, 2+         ask first, then request
 *
 * The hiding is a courtesy (#7). A refusal that arrives anyway renders the
 * server's own sentence through `WriteError`.
 */

/** The QR payload, exactly as the contract writes it. */
export function pairingPayload(token: string): string {
  return `${STAFF_PAIRING_URL}?t=${token}`;
}

/**
 * The QR as one SVG path in module units. Drawn from `qrcode`'s matrix rather
 * than its `toString` renderer so nothing reaches the DOM as an HTML string —
 * the path is data, React writes it as an attribute.
 *
 * Horizontal runs merge into one rectangle each, which keeps a version-5 code to
 * a few hundred segments instead of a thousand one-module squares.
 */
export function qrPath(text: string): { size: number; d: string } {
  const { modules } = createQr(text, { errorCorrectionLevel: 'M' });
  const size = modules.size;
  let d = '';
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!modules.get(row, col)) {
        col++;
        continue;
      }
      let run = 1;
      while (col + run < size && modules.get(row, col + run)) run++;
      d += `M${col} ${row}h${run}v1h-${run}z`;
      col += run;
    }
  }
  return { size, d };
}

/**
 * When the code stops working, on THIS machine's clock.
 *
 * The server's `expiresAt` is the authority, but it is read against a laptop
 * clock that may be minutes slow — and a slow clock would count down a code the
 * server has already expired, which is the one direction that costs something:
 * a staff member typing digits that cannot work. So the countdown ends at
 * whichever comes first, the server's instant or `STAFF_PAIRING_TTL_MINUTES`
 * after the response arrived. A fast clock only ever makes it end early.
 */
export function pairingDeadline(expiresAt: string, receivedAt: number): number {
  const ceiling = receivedAt + STAFF_PAIRING_TTL_MINUTES * 60_000;
  const server = Date.parse(expiresAt);
  return Number.isNaN(server) ? ceiling : Math.min(server, ceiling);
}

/** 599_400 ms → "10:00"; never negative. Whole seconds round UP, so 0:00 means gone. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "123456" → "123 456". */
export function groupDigits(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/**
 * The card's own name for `perms.scanner` — the chip's label in
 * `api/staff.ts § PERMISSIONS` — so this notice and the chip it sends a manager
 * to can never call it two different things.
 */
const SCAN_AND_CHARGE = PERMISSIONS.find((p) => p.key === 'scanner')?.label ?? 'Scan & charge';

/**
 * INVENTED — Aftab's ruling, in chat, 2026-11-10: "yes add the scan and charge
 * warning too". Pairing an account whose Scan & charge is off succeeds and the
 * phone signs in, and then it cannot take a charge — and nothing here said so.
 *
 * A WARNING, NOT A BLOCK: a paired phone is also how a staff member reads My
 * bookings and My schedule, which need no Scan & charge, so the code is still
 * issued and shown. The account is named twice rather than given a pronoun,
 * because nobody's pronouns are recorded.
 */
function scanChargeWarning(name: string): string {
  return `${name} can sign in on this phone but can't take payments yet: ${SCAN_AND_CHARGE} is off for this account. Turn it on from the card to let ${name} charge.`;
}

type Phase =
  | { kind: 'choose' }
  | { kind: 'requesting' }
  | { kind: 'shown'; code: StaffPairingCode; deadline: number }
  | { kind: 'expired' }
  | { kind: 'failed'; error: unknown };

interface BranchLite {
  id: string;
  name: string;
}

export interface PairPhoneDialogProps {
  account: StaffUser;
  branches: ReadonlyArray<BranchLite>;
  /** `session.perms.dashboard`. A branch enrols a till, and that needs it. */
  canEnrolTill: boolean;
  /** Must be stable (`useCallback`): the key listener re-binds on it. */
  onClose: () => void;
}

/**
 * The branch the select starts on: hers, when she works at exactly one of them.
 * Otherwise nothing — at a two-branch salon the till's branch decides which
 * boost a customer is paid at that counter (`Tills.tsx`), so a guessed default
 * is a mis-enrolment one click away.
 */
function startingBranch(account: StaffUser, branches: ReadonlyArray<BranchLite>): string {
  if (account.branchAccess === 'all' || account.branchAccess.length !== 1) return '';
  const only = account.branchAccess[0];
  return branches.some((b) => b.id === only) ? (only ?? '') : '';
}

function tabbableIn(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]',
    ),
  ].filter((el) => el.tabIndex >= 0);
}

export function PairPhoneDialog({ account, branches, canEnrolTill, onClose }: PairPhoneDialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const salonId = useSalonId();

  const choosing = canEnrolTill && branches.length > 1;
  const automaticBranch = canEnrolTill && branches.length === 1 ? (branches[0]?.id ?? null) : null;

  const [phase, setPhase] = useState<Phase>(choosing ? { kind: 'choose' } : { kind: 'requesting' });
  const [branchId, setBranchId] = useState(() => startingBranch(account, branches));
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef<AbortController | null>(null);
  /** The branch the current code was asked for, so "New code" asks for the same one. */
  const askedFor = useRef<string | null>(null);

  const request = useCallback(
    (forBranch: string | null) => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      askedFor.current = forBranch;
      // The old code leaves the screen at the click, not when the new one lands:
      // the server voids it the moment it issues the next, so nobody should be
      // copying digits that are about to stop working.
      setPhase({ kind: 'requesting' });
      issuePairingCode(account.id, forBranch, controller.signal).then(
        (code) => {
          if (controller.signal.aborted) return;
          const received = Date.now();
          setNow(received);
          setPhase({ kind: 'shown', code, deadline: pairingDeadline(code.expiresAt, received) });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          // She was removed in another tab. The card behind this dialog still says
          // she is on the team; let the roster catch up with the refusal.
          if (error instanceof ApiError && error.code === 'staff_deactivated') {
            void queryClient.invalidateQueries({ queryKey: staffKeys.list(salonId) });
          }
          setPhase({ kind: 'failed', error });
        },
      );
    },
    [account.id, queryClient, salonId],
  );

  /*
   * THE FIRST CODE, ONCE — deferred a tick so React's StrictMode double-mount in
   * development cancels the first scheduling instead of issuing two codes (each
   * of which writes an audit row). The cleanup also aborts anything in flight, so
   * a dialog closed mid-request never lands a token into a component that is gone.
   */
  useEffect(() => {
    const first = choosing ? null : window.setTimeout(() => request(automaticBranch), 0);
    return () => {
      if (first !== null) window.clearTimeout(first);
      inflight.current?.abort();
    };
    // Open-time decision; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * THE COUNTDOWN. One tick a second while a code is showing. Reaching the
   * deadline replaces the code with the expired notice — and drops the token from
   * state on the way, because an expired token is only something to leak.
   */
  const deadline = phase.kind === 'shown' ? phase.deadline : null;
  useEffect(() => {
    if (deadline === null) return;
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= deadline) setPhase({ kind: 'expired' });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);

  /*
   * interaction-spec.md §2: "Sheets and modals: focus moves to the sheet on open,
   * is trapped while open, and returns to the trigger on close. `Esc` closes."
   * Returning to the trigger is the card's half (`Accounts.tsx`); this is the
   * other three.
   *
   * MOVING IN runs on every phase change, but only when focus has fallen OUT of
   * the panel — which is what happens when the button just pressed ("Show code",
   * "New code") is replaced by the next phase. It lands on the first control that
   * is not a way out, else on the panel itself, so the first thing a keyboard user
   * is offered is never "close".
   */
  useEffect(() => {
    const el = panel.current;
    if (el === null || el.contains(document.activeElement)) return;
    const body = el.querySelector<HTMLElement>('.pair__body');
    const first = body ? tabbableIn(body).find((c) => !c.hasAttribute('data-pair-close')) : undefined;
    (first ?? el).focus();
  }, [phase.kind]);

  useEffect(() => {
    const mounted = panel.current;
    if (mounted === null) return;
    const el: HTMLDivElement = mounted;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = tabbableIn(el);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        el.focus();
        return;
      }
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !el.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !el.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = phase.kind === 'shown' ? phase : null;
  const shownToken = shown === null ? null : shown.code.token;
  const qr = useMemo(() => (shownToken === null ? null : qrPath(pairingPayload(shownToken))), [shownToken]);

  const remaining = shown === null ? 0 : shown.deadline - now;
  /** Showing a code that still works. `shown` past its deadline is expired for up to a tick. */
  const live = shown !== null && remaining > 0 ? shown : null;

  /*
   * THE SCAN & CHARGE WARNING — `scanChargeWarning` above. `account` is the
   * card's own row from the roster query, so there is no request of its own: a
   * grant that reaches the roster (the chip's mutation patches the row; a refetch
   * replaces it) re-renders this dialog without it. `!== true` is the chip's own
   * test for "on", so the two cannot disagree. Not over a refusal: "can sign in on
   * this phone" beside "Nothing was paired." would contradict it.
   */
  const warnId = `${titleId}-scan`;
  const cannotCharge = account.perms.scanner !== true && phase.kind !== 'failed';

  return (
    <div className="pair" role="presentation">
      <div
        className="pair__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(cannotCharge ? { 'aria-describedby': warnId } : {})}
        ref={panel}
        tabIndex={-1}
      >
        <div className="pair__head">
          <div>
            <h2 className="pair__title avo-display" id={titleId}>
              Pair a phone
            </h2>
            <p className="pair__who">
              For <b>{account.name}</b> · @{account.handle}
            </p>
          </div>
          <Button
            variant="quiet"
            className="pair__close"
            onClick={onClose}
            aria-label="Close"
            data-pair-close=""
          >
            <span aria-hidden="true">✕</span>
          </Button>
        </div>

        <div className="pair__body">
          {cannotCharge ? (
            <p className="pair__warn" id={warnId}>
              {scanChargeWarning(account.name)}
            </p>
          ) : null}

          {phase.kind === 'choose' ? (
            <div className="pair__choose">
              <Select
                label="Till branch"
                value={branchId}
                options={[
                  { value: '', label: 'Choose a branch', disabled: true },
                  ...branches.map((b) => ({ value: b.id, label: b.name })),
                ]}
                onChange={(event) => setBranchId(event.target.value)}
              />
              <p className="pair__note">
                Her phone is also set up as a till at this branch, so the charges she takes on it
                count there.
              </p>
              <div className="pair__actions">
                <Button disabled={branchId === ''} onClick={() => request(branchId)}>
                  Show code
                </Button>
                <Button variant="quiet" onClick={onClose} data-pair-close="">
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}

          {phase.kind === 'requesting' ? (
            <div className="pair__code" aria-busy="true">
              <Skeleton width={196} height={196} radius={14} />
              <Skeleton width={150} height={34} />
              <Skeleton width={110} height={14} />
              <span className="avo-sr-only" role="status">
                Getting a code…
              </span>
            </div>
          ) : null}

          {live !== null && qr !== null ? (
            <div className="pair__code">
              <svg
                className="pair__qr"
                role="img"
                aria-label={`Pairing QR code for ${account.name}`}
                viewBox={`-4 -4 ${qr.size + 8} ${qr.size + 8}`}
                shapeRendering="crispEdges"
              >
                <rect x={-4} y={-4} width={qr.size + 8} height={qr.size + 8} className="pair__qr-bg" />
                <path d={qr.d} className="pair__qr-ink" />
              </svg>
              <p className="pair__digits avo-display">
                <span aria-hidden="true">{groupDigits(live.code.code)}</span>
                <span className="avo-sr-only">{live.code.code.split('').join(' ')}</span>
              </p>
              <p className="pair__expiry">
                <span aria-hidden="true">Expires in {formatCountdown(remaining)}</span>
                {/*
                  §2 for a countdown: a polite live region, announced every 15
                  seconds rather than every tick.
                */}
                <span className="avo-sr-only" aria-live="polite">
                  Expires in {formatCountdown(Math.ceil(remaining / 15_000) * 15_000)}
                </span>
              </p>
            </div>
          ) : null}

          {phase.kind === 'expired' || (shown !== null && live === null) ? (
            <div className="pair__expired" role="status">
              <p className="pair__expired-title">This code has expired.</p>
              <p className="pair__note">Get a new code to pair her phone.</p>
            </div>
          ) : null}

          {phase.kind === 'failed' ? (
            <WriteError
              error={phase.error}
              reassurance="Nothing was paired."
              notFound={{
                unknown_staff: 'That account is no longer on your team list.',
                unknown_branch: 'That branch is no longer open.',
              }}
            />
          ) : null}

          {live !== null ? (
            <p className="pair__note">
              Open the AVO Staff app on her phone and scan this code. She then chooses her own PIN on
              the phone — you never see it.{' '}
              {account.phone
                ? `No camera? She can enter her mobile number, ${formatStaffPhone(account.phone)}, and the six digits instead.`
                : 'To pair without the camera, add her mobile number to her account first.'}
            </p>
          ) : null}

          {phase.kind === 'choose' ? null : (
            <div className="pair__actions">
              {phase.kind === 'requesting' ? null : (
                <Button
                  variant="secondary"
                  onClick={() => request(askedFor.current)}
                  {...(live !== null ? { 'aria-describedby': `${titleId}-new` } : {})}
                >
                  {phase.kind === 'failed' ? 'Try again' : 'New code'}
                </Button>
              )}
              <Button variant="quiet" onClick={onClose} data-pair-close="">
                Done
              </Button>
            </div>
          )}
          {live !== null ? (
            <p className="pair__note" id={`${titleId}-new`}>
              A new code replaces this one — this one stops working.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
