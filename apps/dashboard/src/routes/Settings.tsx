import { useEffect, useRef, useState } from 'react';
import { fils, formatFils, type Salon } from '@avo/types';
import { Button, Card, ErrorState, Pill, Skeleton, Stepper, TextField, Toggle } from '@avo/ui';
import { useSalonBookings } from '../api/bookings.js';
import { useSalon } from '../api/salon.js';
import {
  useAddBranch,
  useCloseBranch,
  useUpdateSalon,
  type BranchClosure,
} from '../api/settings.js';
import { useStaff } from '../api/staff.js';
import { useSession } from '../auth/AuthProvider.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * Merchant → Settings.
 *
 * Five panels, in the design's order: optional modules, booking deposit,
 * business hours, branches, and WhatsApp.
 *
 * NOT BUILT HERE, DELIBERATELY: the brand kit (logo upload, palette,
 * typography), social links, and Your plan & invoices. The first two are a
 * separate slice; the third has no endpoint of any kind — there is no invoice,
 * plan-price or payment-method shape in the API or in the contract, and the
 * design's figures ("45.000 KD a month plus 3%", "Next invoice 118.500 KD") are
 * prototype fixtures. Rendering them would put invented money on a merchant's
 * billing screen.
 *
 * COMMISSION IS NOT SHOWN HERE, AND IT USED TO BE — DECISION 84.
 *
 * A sixth panel, "AVO commission on top-ups", rendered the KNET and card rates on
 * this screen. It is gone. Aftab: "Hide commissions from the settings (Merchants
 * will not see anything related to commissions)." That REVERSES
 * api-contract.md's "merchant-visible, customer-never" — the contract makes the
 * merchant the one surface that MAY see a fee — so this is a capability being
 * WITHDRAWN by the client, not a defect being fixed, and that contract line is now
 * wrong rather than unimplemented. Trunk owns the contract; this column owns the
 * screen.
 *
 * DO NOT RE-ADD IT FROM THE DESIGN BUNDLE. `AVO Merchant Dashboard.dc.html` still
 * draws the panel, and CLAUDE.md says build the design faithfully — so the next
 * session to diff this screen against the artboard will find a card missing, be
 * right about the difference, and be wrong about the fix. The design predates the
 * instruction.
 *
 * REMOVING IT ALSO CLOSES A DEFECT, which is the useful half of the change. The
 * panel read the COMPILED LAUNCH DEFAULT out of @avo/types, while the rate a
 * top-up is actually priced at is a `platform_settings` row the owner console
 * edits under `controls`. This lane proved the divergence on a real payment: one
 * 20.000 KD card top-up recorded fee 550 at the compiled default and 650 after a
 * PATCH, with the compiled constant unchanged. So the panel showed a merchant a
 * figure that was correct until the owner first moved a stepper and stale
 * afterwards, and it could not do better from this column: the live row is
 * `GET /v1/platform/settings`, gated `controls`, a platform permission no merchant
 * holds. The api/ fix it asked for — serve a salon its own current rates — is no
 * longer owed to this screen, because this screen no longer asks.
 *
 * NOTHING ON THE SERVER NEEDED TO CHANGE. `feeFils` is already withheld from every
 * merchant-facing response and no report carries a fee column
 * (`api/src/routes/activity.ts`, `routes/members.ts` and `routes/topups.ts` each
 * say so in their own words), so this panel was the whole merchant-visible
 * surface. The rate leaving the SHIPPED JAVASCRIPT is a separate question from the
 * card leaving the screen — see the commit for the bundle check.
 */

const DEPOSIT_MIN = 1_000; // 1 KD, and the API's own floor
const DEPOSIT_MAX = 10_000; // 10 KD
const DEPOSIT_STEP = 1_000;

export function Settings() {
  const session = useSession('merchant');
  const salonQuery = useSalon();
  const update = useUpdateSalon();
  const salon = salonQuery.data;

  /*
   * THE COURTESY GATE MARKETING ALREADY HAD AND THIS SCREEN DID NOT.
   *
   * `GET /salons/{id}` is guarded by `requirePrincipal` and `requireSameSalon`
   * and NO permission — deliberately, because the customer wallet reads the same
   * object for `timezone`, `businessHours` and the loyalty shape. So the read
   * succeeds for any staff member in the salon, and this screen rendered a
   * complete, editable Settings editor to a front-desk account with
   * `perms.dashboard` and `perms.loyalty` both off. Every write from it then
   * refuses.
   *
   * That is the inverse of the failure `sectionState.tsx` guards against. Not a
   * 403 wearing a Retry button, but NO refusal at all until she has set a deposit,
   * toggled WhatsApp and pressed save — at which point the screen tells her the
   * change never happened. Verified with the seeded front-desk account: six
   * sections explained themselves, Settings handed her the editor.
   *
   * `perms.loyalty` and not `perms.dashboard`, because that is what the server
   * actually enforces: every salon write — `PATCH /salons/{id}` and all three
   * branch routes — is `requireDashboardPerm(req, 'loyalty')`. Gating the courtesy
   * on `dashboard` would hide the screen from somebody the API would let save,
   * which is a worse error than the one being fixed.
   *
   * Non-negotiable #7 is unchanged: the server refuses these writes whether or
   * not this check exists. This is the courtesy, not the control. The copy is the
   * API's own sentence for `loyalty`, so a merchant who reaches the refusal by
   * another route reads the same words.
   */
  if (!session.perms.loyalty) {
    return (
      <ErrorState
        title="You don't have access to settings"
        body="You don't have permission to change loyalty settings. A manager can grant it."
      />
    );
  }

  if (salonQuery.isError) {
    return (
      <SectionError
        error={salonQuery.error}
        forbiddenTitle="You don't have access to settings"
        failedTitle="Couldn't load settings"
        onRetry={() => void salonQuery.refetch()}
        retrying={salonQuery.isFetching}
      />
    );
  }

  return (
    <div className="settings">
      <ModulesPanel salon={salon} update={update} />
      <div className="settings__pair">
        <DepositPanel salon={salon} update={update} />
        <BusinessHoursPanel salon={salon} />
      </div>
      {/*
        * `settings__stack` IS GONE WITH THE SECOND CARD IT EXISTED TO SPACE. It
        * was a flex column with an 18px gap holding WhatsApp above Commission;
        * with one child it renders identically to the card sitting in the grid
        * cell directly, so keeping it would leave a wrapper whose only reason is
        * a sibling that no longer exists. Its rule is out of app.css too — this
        * was its only user.
        */}
      <div className="settings__pair">
        <BranchesPanel salon={salon} />
        <WhatsAppPanel salon={salon} update={update} />
      </div>

      {update.isError ? (
        <WriteError error={update.error} reassurance="That setting is unchanged." />
      ) : null}
    </div>
  );
}

type Updater = ReturnType<typeof useUpdateSalon>;

/* ------------------------------------------------------------------ modules */

/**
 * THESE TOGGLES WERE DISABLED BEHIND A NOTICE, AND THE REASON HAD EXPIRED.
 *
 * The notice read "Booking and Shop can't be switched on from here yet — the
 * workspace has no endpoint for it", above a comment claiming `PATCH
 * /salons/{id}` refuses "`modules`, `moduleBooking` and `moduleShop` alike".
 *
 * ONE THIRD OF THAT WAS RIGHT, AND IT IS WHY THE OTHER TWO THIRDS WERE BELIEVED.
 * The two COLUMN spellings are refused — deliberately and permanently, so that
 * one field does not have two doors — and a verification that reached for
 * `moduleBooking` would have got a real `not_editable` 400. But `modules`, the
 * WIRE shape this screen already READS off the salon, is in `MERCHANT_EDITABLE`
 * (api/src/routes/salons.ts:57) and has been since e883330. Driven against the
 * running API before this change, and asserted in SQL rather than in the reply —
 * the full transcript, including the 403 for a staff member without the
 * permission, is in `api/settings.ts § WHAT THIS ENDPOINT WILL NOT ACCEPT`.
 *
 * ONE SWITCH SENDS ONE KEY. `{ modules: { booking } }`, not the pair: the server
 * only touches a column whose key is present, precisely so that flipping Booking
 * from a render made before someone else changed Shop cannot silently take Shop
 * with it.
 *
 * THE GATE IS `perms.loyalty`, WHICH IS THE GATE THIS WHOLE SCREEN ALREADY HAS.
 * `PATCH /salons/{id}` is one route with one guard, so the courtesy check at the
 * top of `Settings` covers these writes exactly as it covers the deposit and the
 * WhatsApp switch — nothing extra to add here. Non-negotiable #7 unchanged: with
 * that check deleted the server still answers 403 and the columns still do not
 * move, which is the state the transcript above records.
 */
function ModulesPanel({ salon, update }: { salon: Salon | undefined; update: Updater }) {
  return (
    <Card className="settings__card settings__card--rows">
      <h2 className="settings__title avo-display">Optional modules</h2>

      <ModuleRow
        name="Booking"
        body="Service → artist → slot, with a wallet deposit. Default off."
        on={salon?.modules.booking}
        busy={update.isPending}
        onChange={(next) => update.mutate({ modules: { booking: next } })}
      />
      <ModuleRow
        name="Shop"
        body="Flat catalog, pay from wallet, pickup at salon. Default off."
        on={salon?.modules.shop}
        busy={update.isPending}
        onChange={(next) => update.mutate({ modules: { shop: next } })}
      />
    </Card>
  );
}

function ModuleRow({
  name,
  body,
  on,
  busy,
  onChange,
}: {
  name: string;
  body: string;
  on: boolean | undefined;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="settings__row">
      <div>
        <div className="settings__row-name">{name}</div>
        <div className="settings__row-body">{body}</div>
      </div>
      {on === undefined ? (
        <Skeleton width={40} height={24} radius={999} />
      ) : (
        <div className="settings__row-right">
          {/*
            The state as a word, not only as a switch position — and it follows
            the SERVER's value, never a local one. No optimistic flip: a module
            decides whether a whole surface exists in the customer's wallet, and
            a switch that reads On while the salon is still Off is the same class
            of lie as a stepper showing a deposit nobody accepted. The refusal
            path is `WriteError` at the foot of the screen; the switch simply
            never moved.
          */}
          <Pill tone={on ? 'brand' : 'quiet'}>{on ? 'On' : 'Off'}</Pill>
          <Toggle checked={on} disabled={busy} onChange={onChange} label={`${name} module`} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ deposit */

function DepositPanel({ salon, update }: { salon: Salon | undefined; update: Updater }) {
  const serverValue = salon?.depositFils ?? DEPOSIT_MIN;
  const [value, setValue] = useState<number>(serverValue);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /*
   * The server value wins whenever it changes underneath — including after a
   * failed PATCH, which is how the stepper snaps back to what is actually held
   * rather than sitting on a number nobody accepted.
   */
  useEffect(() => setValue(serverValue), [serverValue]);

  /*
   * Debounced, because the stepper is a control a merchant clicks four times to
   * get from 5 to 9 and each click would otherwise be a money write with its own
   * audit row. The last value wins; the request carries the settled figure.
   */
  function onChange(next: number) {
    setValue(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next !== serverValue) update.mutate({ depositFils: fils(next) });
    }, 550);
  }

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const returnMinutes = salon?.noShowReturnMinutes ?? 60;
  const returnLabel =
    returnMinutes % 60 === 0
      ? `${returnMinutes / 60} hour${returnMinutes === 60 ? '' : 's'}`
      : `${returnMinutes} minutes`;

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Booking deposit</h2>
      <p className="settings__sub">
        Held from the wallet at confirmation. Remainder paid at the salon.
      </p>

      {salon === undefined ? (
        <Skeleton width={220} height={38} />
      ) : (
        <div className="settings__deposit">
          <Stepper
            label="Booking deposit"
            value={value}
            min={DEPOSIT_MIN}
            max={DEPOSIT_MAX}
            step={DEPOSIT_STEP}
            onChange={onChange}
            // Integer fils in, formatted only here. Never a float.
            format={(v) => formatFils(fils(v))}
            valueText={`${formatFils(fils(value))} Kuwaiti dinars`}
            disabled={update.isPending}
          />
          <span className="settings__deposit-unit">KD</span>
          <span className="settings__deposit-range">1&ndash;10 KD</span>
        </div>
      )}

      <div className="settings__foot">
        No-show: deposit returns to the wallet <b>{returnLabel}</b> after a missed slot.
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------- business hours */

function BusinessHoursPanel({ salon }: { salon: Salon | undefined }) {
  const hours = salon?.businessHours;
  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Business hours</h2>
      {hours === undefined ? (
        <Skeleton width="70%" height={16} />
      ) : (
        <>
          <div className="settings__hours-row">
            <span className="settings__hours-label">Morning</span>
            <span className="settings__hours-value">
              {hours.morning[0]} &ndash; {hours.morning[1]}
            </span>
          </div>
          <div className="settings__hours-row settings__hours-row--divided">
            <span className="settings__hours-label">Evening</span>
            <span className="settings__hours-value">
              {hours.evening[0]} &ndash; {hours.evening[1]}
            </span>
          </div>
          <div className="settings__note">Afternoon closure — typical of Kuwait retail.</div>
          {/*
            The zone is not decoration. `businessHours` is naive wall clock; the
            same "10:00" resolves to a different instant per zone, and it is what
            artist windows and happy hours are measured against. Shown so a
            merchant can see which clock the salon runs on.
          */}
          {salon?.timezone ? (
            <div className="settings__note">All times in {salon.timezone}.</div>
          ) : null}
        </>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------- branches */

/**
 * Branches — the design's list, ✕ per row, and "+ Add branch".
 *
 * CLOSING IS NOT DELETING, AND THE SCREEN SAYS SO. `DELETE
 * /salons/{id}/branches/{bid}` sets `closedAt`; the row survives because
 * `booking.branch_id` and `transaction` reference it. The design's ✕ carries only
 * `title="Remove"`, which would be a lie about what the button does.
 *
 * THE CONSEQUENCES ARE SHOWN BEFORE THE CONFIRMATION, WHICH THE API CANNOT DO.
 * The DELETE answers with `staffRescoped`, `staffLeftWithNoBranch` and
 * `depositHeldBookings`, but computes them inside the transaction that performs
 * the close — there is no preview route. Those three facts are what a merchant
 * needs *before* she decides, so they are derived here from the roster and the
 * appointment list, and the server's own numbers are shown afterwards as
 * confirmation of what actually happened.
 *
 * AND THE WARNING IS PERMISSION-BOUND, WHICH IS WORTH SAYING OUT LOUD.
 * Closing a branch needs `perms.loyalty`. Knowing who it strands needs
 * `perms.team` (`GET /staff`), and knowing whose deposit is held needs
 * `perms.appointments` (`GET /salons/{id}/bookings`). A `loyalty`-only account can
 * therefore close a branch it cannot be warned about. Rather than fetch and 403,
 * the reads are `enabled` on the permission and the warning degrades to the
 * categories of consequence without counts — true either way, and never an
 * invented number. A closure-preview endpoint on `perms.loyalty` is the real fix;
 * reported to trunk.
 */
function BranchesPanel({ salon }: { salon: Salon | undefined }) {
  const session = useSession('merchant');
  const addBranch = useAddBranch();
  const closeBranch = useCloseBranch();
  const [newName, setNewName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [closed, setClosed] = useState<BranchClosure | null>(null);

  // Only fetched when the permission allows it — see the note above.
  const staff = useStaff(session.perms.team);
  const bookings = useSalonBookings('deposit_held', session.perms.appointments);

  const branches = salon?.branches ?? [];
  const onlyOpenBranch = branches.length <= 1;

  /**
   * What closing this branch would touch, derived the way the server derives it.
   *
   * `stranded` mirrors the API's `staffLeftWithNoBranch`: `array_remove` strips
   * the id, and a member is stranded when that leaves the list empty — so
   * exactly the branch-scoped staff whose only branch is this one.
   * `branchAccess === 'all'` staff are untouched by the server's UPDATE (the
   * `staff_user_branch_access_exclusive` CHECK keeps their id list empty), so
   * they are filtered out here too rather than counted and then explained away.
   */
  function impactOf(branchId: string) {
    const scoped = (staff.data?.items ?? []).filter(
      (s) => s.branchAccess !== 'all' && s.branchAccess.includes(branchId),
    );
    const held = (bookings.data?.items ?? []).filter((b) => b.branchId === branchId);
    return {
      rescoped: scoped.map((s) => s.name),
      stranded: scoped.filter((s) => s.branchAccess !== 'all' && s.branchAccess.length === 1),
      deposits: held.length,
      /*
       * `branchAssumed` is on `MerchantBooking` precisely so a per-branch count
       * that rests on a guess is distinguishable from one that does not. Ignoring
       * it here would turn an inferred branch into a stated fact in a warning
       * about money already taken from customers.
       */
      depositsAssumed: held.some((b) => b.branchAssumed),
    };
  }

  return (
    <Card className="settings__card">
      <h2 className="settings__title avo-display">Branches</h2>
      <p className="settings__sub">
        One wallet across all. Each branch gets an ID you can scope staff to.
      </p>

      {salon === undefined ? (
        <Skeleton width="80%" height={16} />
      ) : (
        <ul className="settings__branches">
          {branches.map((branch) => {
            const impact = impactOf(branch.id);
            return (
              <li key={branch.id} className="settings__branch">
                <span className="settings__branch-dot" aria-hidden="true" />
                <span className="settings__branch-name">{branch.name}</span>
                <span className="settings__branch-id">{branch.id}</span>
                {/*
                  The ✕ pattern from Accounts: a control that cannot succeed says
                  why BEFORE it is pressed. The server refuses the last open
                  branch with `last_open_branch` — a salon with none cannot take a
                  payment, a top-up or a booking.
                */}
                <button
                  type="button"
                  className="settings__branch-close"
                  aria-label={`Close ${branch.name}`}
                  title={
                    onlyOpenBranch
                      ? "This is the salon's only open branch. Open the new location first, then close this one."
                      : `Close ${branch.name}`
                  }
                  disabled={onlyOpenBranch || closeBranch.isPending}
                  onClick={() => {
                    setClosed(null);
                    setConfirming(branch.id);
                  }}
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {confirming !== null
        ? (() => {
            const branch = branches.find((b) => b.id === confirming);
            if (!branch) return null;
            const { rescoped, stranded, deposits, depositsAssumed } = impactOf(branch.id);
            const busy = closeBranch.isPending;
            return (
              <div
                className="settings__confirm"
                role="group"
                aria-label={`Close ${branch.name}?`}
              >
                <p className="settings__confirm-text">
                  Close <b>{branch.name}</b>? It stops taking payments, top-ups and bookings.
                  Past charges keep its name — it is closed, not deleted.
                </p>

                <ul className="settings__consequences">
                  {session.perms.team ? (
                    <>
                      <li>
                        {rescoped.length === 0
                          ? 'No staff are scoped to this branch.'
                          : rescoped.length === 1
                            ? `${rescoped[0]} loses it from her branch access.`
                            : `${rescoped.length} staff lose it from their branch access: ${rescoped.join(', ')}.`}
                      </li>
                      {stranded.length > 0 ? (
                        /*
                          `staffLeftWithNoBranch` is the one that needs her
                          attention — a staff member scoped to branches with none
                          left cannot work — so it gets its own line and the
                          warning tone rather than being folded into the count.
                        */
                        <li className="settings__consequence--warn">
                          <b>
                            {stranded.map((s) => s.name).join(', ')} would be left with no branch
                            at all
                          </b>{' '}
                          and cannot work until you give {stranded.length === 1 ? 'her' : 'them'}{' '}
                          another one in Accounts → Team.
                        </li>
                      ) : null}
                    </>
                  ) : (
                    // No `perms.team`, so no roster to count. Say what is unknown
                    // rather than implying nothing is affected.
                    <li>
                      Staff scoped to this branch will lose it from their branch access. You
                      don&rsquo;t have permission to see the team, so this can&rsquo;t be counted
                      here.
                    </li>
                  )}

                  {session.perms.appointments ? (
                    deposits > 0 ? (
                      <li className="settings__consequence--warn">
                        <b>
                          {deposits} appointment{deposits === 1 ? '' : 's'} here still hold
                          {deposits === 1 ? 's' : ''} a customer&rsquo;s deposit
                        </b>{' '}
                        — that money is already taken and stays held against the booking.
                        {depositsAssumed
                          ? ' At least one of those bookings has an assumed branch, so treat the count as approximate.'
                          : ''}
                      </li>
                    ) : (
                      <li>No appointment here is holding a deposit.</li>
                    )
                  ) : (
                    <li>
                      Appointments here may still hold a customer&rsquo;s deposit. You don&rsquo;t
                      have permission to see appointments, so this can&rsquo;t be counted here.
                    </li>
                  )}
                </ul>

                <div className="settings__confirm-actions">
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      closeBranch.mutate(
                        { branchId: branch.id },
                        {
                          onSuccess: (result) => {
                            setConfirming(null);
                            setClosed(result);
                          },
                        },
                      );
                    }}
                  >
                    {busy ? 'Closing…' : `Close ${branch.name}`}
                  </Button>
                  <Button variant="quiet" disabled={busy} onClick={() => setConfirming(null)}>
                    Keep it open
                  </Button>
                </div>
              </div>
            );
          })()
        : null}

      {/*
        The server's OWN numbers, after the fact. Not a duplicate of the warning:
        the warning is this client's estimate from two lists it may not be allowed
        to read, and this is what the close actually touched, straight from the
        UPDATE's RETURNING.
      */}
      {closed !== null ? (
        <div className="settings__closed" role="status">
          <b>{closed.name} is closed.</b>{' '}
          {closed.staffRescoped.length > 0
            ? `Re-scoped ${closed.staffRescoped.join(', ')}. `
            : 'No staff needed re-scoping. '}
          {closed.staffLeftWithNoBranch.length > 0
            ? `${closed.staffLeftWithNoBranch.join(', ')} now ${closed.staffLeftWithNoBranch.length === 1 ? 'has' : 'have'} no branch access — fix that in Accounts → Team. `
            : ''}
          {closed.depositHeldBookings > 0
            ? `${closed.depositHeldBookings} appointment${closed.depositHeldBookings === 1 ? '' : 's'} still hold a deposit here.`
            : ''}
        </div>
      ) : null}

      <div className="settings__addbranch">
        <TextField
          label="New branch name"
          labelHidden
          placeholder="New branch name"
          value={newName}
          disabled={addBranch.isPending}
          onChange={(event) => setNewName(event.target.value)}
        />
        <Button
          disabled={addBranch.isPending || newName.trim() === ''}
          onClick={() =>
            addBranch.mutate(
              { name: newName.trim() },
              { onSuccess: () => setNewName('') },
            )
          }
        >
          {addBranch.isPending ? 'Adding…' : '+ Add branch'}
        </Button>
      </div>

      {addBranch.isError ? (
        <WriteError error={addBranch.error} reassurance="No branch was added." />
      ) : null}
      {closeBranch.isError ? (
        <WriteError error={closeBranch.error} reassurance="That branch is still open." />
      ) : null}
    </Card>
  );
}

/* ----------------------------------------------------------------- whatsapp */

function WhatsAppPanel({ salon, update }: { salon: Salon | undefined; update: Updater }) {
  return (
    <Card className="settings__card settings__card--inline">
      <div>
        <div className="settings__row-name">WhatsApp notifications</div>
        <div className="settings__row-body">Confirmations · reminders · receipts</div>
      </div>
      {salon === undefined ? (
        <Skeleton width={40} height={24} radius={999} />
      ) : (
        <Toggle
          checked={salon.whatsappEnabled}
          disabled={update.isPending}
          onChange={(next) => update.mutate({ whatsappEnabled: next })}
          label="WhatsApp notifications"
        />
      )}
    </Card>
  );
}
