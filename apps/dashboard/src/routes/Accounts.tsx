import { useState } from 'react';
import type { StaffUser } from '@avo/types';
import { Button, Card, Chip, EmptyState, Pill, Segmented, Select, Skeleton, TextField } from '@avo/ui';
import {
  PERMISSIONS,
  ROLE_LABEL,
  applyPermissionRules,
  changedPerms,
  roleOptionsFor,
  useCreateStaff,
  useDeactivateStaff,
  useSendPasswordReset,
  useStaff,
  useUpdateStaff,
  type BranchAccess,
  type PermissionName,
  type StaffPerms,
} from '../api/staff.js';
import { useSalon } from '../api/salon.js';
import { useSession } from '../auth/AuthProvider.js';
import { Customers } from './Customers.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * Merchant → Accounts → Team. `perms.team` on every route it touches.
 *
 * NO COURTESY PERMISSION GATE, DELIBERATELY — and "every route" above is the
 * reason. `GET /staff` and all four writes are `requireDashboardPerm(req, 'team')`,
 * so the refusal arrives on the read and nobody reaches a control she cannot use.
 * Ledger in sectionState.tsx.
 *
 * WHAT THESE CONTROLS ACTUALLY DO. Each one writes to the shared staff record,
 * and the staff scanner reads the same record — so switching "Scan & charge" off
 * here changes what that phone can open, and the API revokes her live scanner
 * sessions on the way out. Every grant and every revoke writes an audit row
 * naming who changed what, from what, to what; they show up under Access in the
 * audit log, which is the next section, and that is where these writes were
 * verified rather than assumed.
 *
 * THE COMMENT THAT USED TO BE HERE WAS WRONG, AND IT COST A SLICE.
 *
 * It listed `POST /staff`, `DELETE /staff/{id}`, the password reset and
 * role/branchAccess on `PATCH /staff/{id}` as having no endpoint, and concluded
 * that role and branch had to render as facts rather than controls. All four
 * exist now (api/src/routes/staff.ts:349, :593, :440, :701) and this file went on
 * asserting otherwise — long enough that the assertion was read as the record of
 * what the API lacks and used to plan work. A stale "not built" comment in a
 * consumer is worse than no comment: it is load-bearing and nobody re-checks it.
 * So the rule this file now follows, written down where the next person will hit
 * it: STATE WHAT THIS SCREEN DOES, AND LET api/src/routes BE THE RECORD OF WHAT
 * THE API HAS.
 *
 * ONE DEPARTURE FROM THE DESIGN, ON PURPOSE. The design's new-account form has a
 * "Temporary password" field. It is not built and must not be — non-negotiable #6
 * and `refuseCredentialFields` on the endpoint both refuse it. Access is
 * established with a reset link. See `useCreateStaff` for the full reasoning.
 */

type Tab = 'team' | 'customers';

export function Accounts() {
  const session = useSession('merchant');
  const staff = useStaff();
  const salon = useSalon();
  const updateStaff = useUpdateStaff();
  const createStaff = useCreateStaff();
  const deactivate = useDeactivateStaff();
  const sendReset = useSendPasswordReset();
  const [tab, setTab] = useState<Tab>('team');
  const [adding, setAdding] = useState(false);
  /** staffId → the reset the server accepted, so the card can say when it expires. */
  const [resetSent, setResetSent] = useState<Record<string, string>>({});

  if (staff.isError) {
    return (
      <SectionError
        error={staff.error}
        forbiddenTitle="You don't have access to accounts"
        failedTitle="Couldn't load the team accounts"
        onRetry={() => void staff.refetch()}
        retrying={staff.isFetching}
      />
    );
  }

  const items = staff.data?.items;
  const branches = salon.data?.branches ?? [];
  const branchNames = new Map(branches.map((b) => [b.id, b.name]));

  /*
   * The last holder of `perms.team` cannot be removed and cannot have `team`
   * revoked — the server refuses both, because that is the permission that
   * grants permissions and losing the last one locks the salon out of this
   * screen. Counted here so the card can SAY so on the disabled control instead
   * of letting the merchant discover it as a 409.
   */
  const teamAdmins = (items ?? []).filter((a) => a.active && a.perms.team === true);
  const soleTeamAdminId = teamAdmins.length === 1 ? teamAdmins[0]?.id : undefined;

  return (
    <>
      <div className="accounts__head">
        <Segmented
          label="Accounts"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'team', label: 'Team' },
            { value: 'customers', label: 'Customers' },
          ]}
        />
        <span className="accounts__hint">
          {/*
            THE CUSTOMERS HINT IS THE DESIGN'S SENTENCE WITH TWO CLAUSES REMOVED,
            NOT A PARAPHRASE OF IT. The design writes "Open a customer to see their
            profile, activity and purchases — or gift and reimburse them." Purchases
            is a `shop`/`appointments` join this card cannot make, and gift and
            reimburse are money-moving writes not in this release — see
            `Customers.tsx § THREE PANELS`. `console/Accounts.tsx` hit the identical
            shape on its own banner and settled the rule: keep the true clauses WORD
            FOR WORD and drop the unbuilt ones rather than blurring the whole
            sentence into something vaguer. A header promising what the screen below
            does not do is a false claim whoever wrote it.
          */}
          {tab === 'team'
            ? 'Create sign-ins for your staff and control what each can do.'
            : 'Open a customer to see their profile and activity.'}
        </span>
      </div>

      {tab === 'customers' ? (
        /*
         * THE CUSTOMER BOOK, WHICH OWNS ITS OWN FOUR STATES — it reads three
         * routes of its own (`/customers`, `/customers/{id}`, `.../activity`) and
         * `Customers.tsx` explains why a shared PERMISSION is not a shared
         * FAILURE. Nothing is handed down from here.
         *
         * THE `staff.isError` EARLY RETURN ABOVE STILL FIRES FIRST, AND ON THIS
         * TAB THAT IS CORRECT RATHER THAN A LEAK OF ONE SECTION INTO ANOTHER:
         * `GET /staff` and all three customer routes are `perms.team`, so a
         * session refused the team list is a session refused the book, and the
         * refusal she reads is the server's own sentence either way. What it does
         * mean is that the book's 403 is reachable SECOND rather than never —
         * `perms` is a snapshot from sign-in and `team` can be revoked while this
         * tab is open.
         */
        <Customers />
      ) : staff.isPending ? (
        <div className="accounts__list">
          {[0, 1, 2].map((n) => (
            <Card key={n} className="account">
              <div className="account__head">
                <Skeleton width={42} height={42} radius={13} />
                <div className="account__ident">
                  <Skeleton width="40%" height={15} />
                  <Skeleton width="26%" height={12} />
                </div>
              </div>
              <Skeleton width="100%" height={34} />
            </Card>
          ))}
        </div>
      ) : (
        <>
          <div className="accounts__count-row">
            <span className="accounts__count">
              {items?.length ?? 0} team account{(items?.length ?? 0) === 1 ? '' : 's'} · toggle
              exactly what each person is allowed to do.
            </span>
            {adding ? null : (
              <Button onClick={() => setAdding(true)}>+ Add teammate</Button>
            )}
          </div>

          {adding ? (
            <NewAccountForm
              branches={branches}
              busy={createStaff.isPending}
              error={createStaff.isError ? createStaff.error : null}
              onCancel={() => {
                createStaff.reset();
                setAdding(false);
              }}
              onCreate={(input) => {
                createStaff.mutate(input, { onSuccess: () => setAdding(false) });
              }}
            />
          ) : null}

          {!items || items.length === 0 ? (
            <EmptyState
              title="No team accounts"
              body="Add a teammate to create their sign-in, then set exactly what they are allowed to do. They receive a link to set their own password — you never type one for them."
            />
          ) : (
            <div className="accounts__list">
              {items.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  branchNames={branchNames}
                  branches={branches}
                  isSoleTeamAdmin={account.id === soleTeamAdminId}
                  isSelf={account.id === session.staffId}
                  resetExpiresAt={resetSent[account.id]}
                  busy={
                    (updateStaff.isPending && updateStaff.variables?.staffId === account.id) ||
                    (deactivate.isPending && deactivate.variables?.staffId === account.id)
                  }
                  resetting={sendReset.isPending && sendReset.variables?.staffId === account.id}
                  onToggle={(key, next) => {
                    const before = account.perms;
                    const after = applyPermissionRules(before, key, next);
                    const diff = changedPerms(before, after);
                    if (Object.keys(diff).length === 0) return;
                    updateStaff.mutate({ staffId: account.id, patch: { perms: diff } });
                  }}
                  onRole={(role) => updateStaff.mutate({ staffId: account.id, patch: { role } })}
                  onBranchAccess={(branchAccess) =>
                    updateStaff.mutate({ staffId: account.id, patch: { branchAccess } })
                  }
                  onReset={() => {
                    sendReset.mutate(
                      { staffId: account.id },
                      {
                        onSuccess: (accepted) =>
                          setResetSent((current) => ({
                            ...current,
                            [account.id]: accepted.expiresAt,
                          })),
                      },
                    );
                  }}
                  onRemove={() => deactivate.mutate({ staffId: account.id })}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/*
        One error surface for the three row-level writes. Each carries its own
        reassurance because the wrong one is worse than none: a merchant who has
        just clicked "Remove" needs to know the account is still there, and one
        who toggled a chip needs to know the authority did not move.
      */}
      {updateStaff.isError ? (
        <WriteError error={updateStaff.error} reassurance="That account is unchanged." />
      ) : null}
      {deactivate.isError ? (
        <WriteError
          error={deactivate.error}
          reassurance="Nobody was removed — that account still has its sign-in."
        />
      ) : null}
      {sendReset.isError ? (
        <WriteError
          error={sendReset.error}
          reassurance="No link was sent. Any link already issued is still valid."
        />
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- one account */

interface BranchLite {
  id: string;
  name: string;
}

interface AccountCardProps {
  account: StaffUser;
  branchNames: Map<string, string>;
  branches: ReadonlyArray<BranchLite>;
  /** The only remaining holder of `perms.team`. The server refuses to strip her. */
  isSoleTeamAdmin: boolean;
  /** The signed-in user's own row. `DELETE /staff/{id}` refuses it, 409. */
  isSelf: boolean;
  /** ISO instant from the 202, when a link has been issued this session. */
  resetExpiresAt: string | undefined;
  busy: boolean;
  resetting: boolean;
  onToggle: (key: PermissionName, next: boolean) => void;
  onRole: (role: string) => void;
  onBranchAccess: (access: BranchAccess) => void;
  onReset: () => void;
  onRemove: () => void;
}

function AccountCard({
  account,
  branchNames,
  branches,
  isSoleTeamAdmin,
  isSelf,
  resetExpiresAt,
  busy,
  resetting,
  onToggle,
  onRole,
  onBranchAccess,
  onReset,
  onRemove,
}: AccountCardProps) {
  const perms = account.perms;
  /*
   * Two confirmations, both for actions whose consequence lands on somebody
   * else's phone before the merchant sees any feedback. Held in the card rather
   * than a modal: interaction-spec.md §2 wants focus trapped in a modal, and
   * an inline confirm on the row that caused it needs no trap and loses no
   * context.
   */
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmScannerOff, setConfirmScannerOff] = useState(false);

  const branchValue = account.branchAccess === 'all' ? 'all' : (account.branchAccess[0] ?? '');
  const branchLabel =
    account.branchAccess === 'all'
      ? 'All branches'
      : account.branchAccess.map((id) => branchNames.get(id) ?? id).join(', ') || 'No branch';

  const leaver = !account.active;

  return (
    <Card className="account" data-inactive={leaver || undefined}>
      <div className="account__head">
        <span className="account__avatar" aria-hidden="true">
          {account.name.slice(0, 1)}
        </span>
        <div className="account__ident">
          <div className="account__name">{account.name}</div>
          <div className="account__handle">@{account.handle}</div>
        </div>

        {leaver ? (
          /*
           * A leaver holds no credential and no authority worth editing, so the
           * controls collapse to the one action that applies: a link that invites
           * her back onto the SAME row, which is what keeps two years of charges
           * attributed to one identity.
           */
          <Pill tone="quiet">Left the team</Pill>
        ) : (
          <>
            <Select
              label={`Role — ${account.name}`}
              labelHidden
              size="sm"
              value={account.role}
              disabled={busy}
              options={roleOptionsFor(account.role)}
              onChange={(event) => {
                if (event.target.value !== account.role) onRole(event.target.value);
              }}
            />
            <Select
              label={`Branch access — ${account.name}`}
              labelHidden
              size="sm"
              value={branchValue}
              disabled={busy}
              options={[
                { value: 'all', label: 'All branches' },
                ...branches.map((b) => ({ value: b.id, label: b.name })),
              ]}
              onChange={(event) => {
                const next: BranchAccess =
                  event.target.value === 'all' ? 'all' : [event.target.value];
                onBranchAccess(next);
              }}
            />
          </>
        )}

        {/*
          `pinSet` and `passwordSet` are the ONLY things a client ever learns
          about a credential — never the PIN, never a hash, never a length
          (non-negotiable #6). Both are shown because they answer different
          questions: no PIN means she cannot charge on the scanner, and no
          password means she has never signed in to the dashboard — which for a
          new account is "invite pending", not a fault.
        */}
        {leaver ? null : (
          <Pill tone={account.pinSet ? 'brand' : 'quiet'}>
            {account.pinSet ? 'PIN set' : 'No PIN'}
          </Pill>
        )}
        {account.passwordSet || leaver ? null : <Pill tone="quiet">Invite pending</Pill>}

        {resetExpiresAt ? (
          /*
           * "Sent", not "delivered". The endpoint answers 202 — accepted for
           * delivery, with no sender wired yet — so the card reports what is
           * true: a link exists and it stops working at a stated time. Never the
           * link, never a password.
           */
          <span className="account__sent">
            <span className="account__sent-dot" aria-hidden="true" />
            Link sent · expires {formatExpiry(resetExpiresAt)}
          </span>
        ) : (
          <Button
            variant="secondary"
            className="account__reset"
            disabled={resetting}
            onClick={onReset}
          >
            {resetting ? 'Sending…' : leaver ? 'Invite back' : 'Reset password'}
          </Button>
        )}

        {leaver ? null : (
          /*
           * Two refusals the server WILL make, pre-empted with the server's own
           * reason rather than discovered as a 409 after the confirmation.
           *
           *   `cannot_deactivate_self`      staff.ts:608 — "You cannot remove
           *                                 your own account."
           *   last holder of `perms.team`   refuseLastTeamAdminRemoval
           *
           * Both are `requireDashboardPerm(req, 'team')` routes and both refuse
           * with or without this check, so this is the courtesy. It is here
           * because a control that can only fail is the same defect Settings had,
           * just one button wide: a manager clicks ✕ on her own row, reads a
           * confirmation about deleting her PIN and signing her out, presses
           * "Remove from team", and only then learns it was never possible.
           */
          <button
            type="button"
            className="account__remove"
            aria-label={`Remove ${account.name}`}
            title={
              isSelf
                ? 'You cannot remove your own account. Ask another manager to do it.'
                : isSoleTeamAdmin
                  ? 'The last person who can manage the team cannot be removed'
                  : `Remove ${account.name}`
            }
            disabled={busy || isSoleTeamAdmin || isSelf}
            onClick={() => setConfirmRemove(true)}
          >
            <span aria-hidden="true">✕</span>
          </button>
        )}
      </div>

      {confirmRemove ? (
        /*
         * SAYS WHAT REMOVAL ACTUALLY IS. The endpoint deactivates: the row stays
         * so old charges keep her name, and what leaves is both credentials and
         * every live session, immediately. A merchant told "delete" would expect
         * the history to go with it, and a merchant told nothing would not know
         * the phone in the salon logs out mid-shift.
         */
        <div className="account__confirm" role="group" aria-label={`Remove ${account.name}?`}>
          <p className="account__confirm-text">
            Remove <b>{account.name}</b>? Her password and scanner PIN are deleted and she is
            signed out of the dashboard and the scanner straight away. Her name stays on past
            charges, and you can invite her back to the same account later.
          </p>
          <div className="account__confirm-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setConfirmRemove(false);
                onRemove();
              }}
            >
              {busy ? 'Removing…' : 'Remove from team'}
            </Button>
            <Button variant="quiet" onClick={() => setConfirmRemove(false)}>
              Keep access
            </Button>
          </div>
        </div>
      ) : null}

      <div className="account__perms">
        <div className="avo-label">Access &amp; authority</div>
        <div className="account__chips">
          {PERMISSIONS.map(({ key, label, note }) => {
            const on = perms[key] === true;
            /*
             * The one refusal the server will make that the merchant cannot
             * guess: the last holder of `team` cannot give it up, because it is
             * the permission that grants permissions. Disabled with the reason on
             * it rather than clickable into a 409.
             */
            const lastTeamAdmin = key === 'team' && on && isSoleTeamAdmin;
            /*
             * WHAT THE GRANT ACTUALLY REACHES, where the label understates it.
             * One permission has a `note` today and it is `shop`, because the
             * fulfilment board put a customer's home address behind a chip that
             * says "Shop" — `api/staff.ts § PERMISSIONS` has the argument and the
             * escalation.
             *
             * The refusal wins the `title` where both apply: a disabled chip's
             * reason is about the click that just failed, which is more urgent
             * than the scope of a grant that is not happening. They cannot
             * collide today — `team` has no note and `shop` cannot be a last
             * team admin — and the ordering is written down so that stays true
             * rather than accidental.
             */
            const title = lastTeamAdmin
              ? 'Someone must be able to manage the team. Grant it to another account first.'
              : note;
            return (
              <Chip
                key={key}
                on={on}
                dot
                label={label}
                disabled={busy || leaver || lastTeamAdmin}
                /*
                 * The note joins the ACCESSIBLE name too. A `title` is a hover
                 * affordance and a mouse is not how everyone reads this card —
                 * interaction-spec.md §2 is emphatic that meaning must not live
                 * in a hover. Without this the scope of the grant is sighted-
                 * mouse-only, which for a privacy consequence is the wrong half
                 * of the audience.
                 */
                aria-label={`${label} — ${account.name}${note ? `. ${note}` : ''}`}
                {...(title ? { title } : {})}
                onClick={() => {
                  // Revoking `scanner` kills a live session on a phone in the
                  // salon. Say it before, not after.
                  if (key === 'scanner' && on) {
                    setConfirmScannerOff(true);
                    return;
                  }
                  onToggle(key, !on);
                }}
              />
            );
          })}
        </div>

        {confirmScannerOff ? (
          <div
            className="account__confirm"
            role="group"
            aria-label={`Turn off Scan & charge for ${account.name}?`}
          >
            <p className="account__confirm-text">
              Turning off <b>Scan &amp; charge</b> signs <b>{account.name}</b> out of the scanner
              immediately — if she is holding the salon phone mid-appointment, it returns to the PIN
              screen. Void a charge goes with it.
            </p>
            <div className="account__confirm-actions">
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setConfirmScannerOff(false);
                  onToggle('scanner', false);
                }}
              >
                Turn off and sign her out
              </Button>
              <Button variant="quiet" onClick={() => setConfirmScannerOff(false)}>
                Leave it on
              </Button>
            </div>
          </div>
        ) : null}

        {/*
          Said once, near the two chips it governs, rather than discovered when
          the server silently takes `void` away with `charges`.
        */}
        <p className="account__rule">
          Void a charge requires See today&rsquo;s charges — granting one grants both, and
          removing charges removes void.
          {leaver ? null : <> Branch access: {branchLabel}.</>}
        </p>
      </div>
    </Card>
  );
}

/**
 * The expiry of a reset link, in the salon's reading rather than an ISO string.
 * Time only when it is today — a 60-minute TTL never crosses a day in practice,
 * and "expires 19:42" is what somebody walking to a desk needs.
 */
function formatExpiry(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'soon';
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/* ------------------------------------------------------------- new account */

interface NewAccountFormProps {
  branches: ReadonlyArray<BranchLite>;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onCreate: (input: {
    name: string;
    handle: string;
    role: string;
    branchAccess: BranchAccess;
    perms: Partial<StaffPerms>;
  }) => void;
}

/**
 * The design's "New team account" form, MINUS the temporary-password field.
 *
 * Four inputs, not five. The design's fifth is "Temporary password · At least 6
 * characters", with the note "the teammate signs in with this username &
 * password, then sets their own on first login". Non-negotiable #6 forbids it in
 * three separate clauses and `POST /staff` 400s on the field, so it is absent and
 * the note is replaced by what actually happens: the account is created with no
 * credential, and a reset link is what lets her in.
 *
 * A NEW ACCOUNT REACHES NOTHING UNTIL SOMEBODY SAYS SO. `perms` is sent empty and
 * `branchAccess` defaults to "no branch" on the server. The permission chips on
 * the card are the second, deliberate step — an onboarding form that silently
 * granted nine permissions would make the chips decorative.
 */
function NewAccountForm({ branches, busy, error, onCancel, onCreate }: NewAccountFormProps) {
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [role, setRole] = useState<string>('frontdesk');
  const [branchAccess, setBranchAccess] = useState<string>('all');
  const [localError, setLocalError] = useState<string | null>(null);

  /*
   * The same handle rule the server applies, applied before the request rather
   * than instead of it: lower-cased, `@` stripped, and the character class from
   * `POST /staff`. A merchant who types "Fatima R." into the username field gets
   * a sentence about spaces here instead of a 400 round-trip.
   */
  const cleanHandle = handle.trim().toLowerCase().replace(/^@/, '');
  const handleValid = /^[a-z0-9._-]+$/.test(cleanHandle);

  function submit() {
    if (name.trim() === '') {
      setLocalError('Give the account a name — it is what appears on the audit log.');
      return;
    }
    if (cleanHandle === '') {
      setLocalError('Pick a username. She signs in with it.');
      return;
    }
    if (!handleValid) {
      setLocalError('A username is letters, numbers, dots, dashes and underscores — no spaces.');
      return;
    }
    setLocalError(null);
    onCreate({
      name: name.trim(),
      handle: cleanHandle,
      role,
      branchAccess: branchAccess === 'all' ? 'all' : [branchAccess],
      perms: {},
    });
  }

  return (
    <Card className="new-account">
      <h3 className="new-account__title avo-display">New team account</h3>

      <div className="new-account__grid">
        <TextField
          label="Full name"
          placeholder="Fatima R."
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
        <Select
          label="Role"
          value={role}
          disabled={busy}
          options={[
            { value: 'manager', label: 'Manager — full access' },
            { value: 'frontdesk', label: 'Front desk — bookings & charge' },
            { value: 'artist', label: 'Stylist — schedule & charge' },
            { value: 'scanner', label: 'Scanner only — charge' },
          ]}
          onChange={(event) => setRole(event.target.value)}
        />
        <Select
          label="Branch access"
          value={branchAccess}
          disabled={busy}
          options={[
            { value: 'all', label: 'All branches' },
            ...branches.map((b) => ({ value: b.id, label: b.name })),
          ]}
          onChange={(event) => setBranchAccess(event.target.value)}
        />
        <TextField
          label="Username"
          placeholder="fatima.r"
          value={handle}
          disabled={busy}
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => setHandle(event.target.value)}
        />
      </div>

      {localError ? (
        <div className="new-account__error">{localError}</div>
      ) : error ? (
        <WriteError error={error} reassurance="No account was created." />
      ) : null}

      <div className="new-account__actions">
        <Button disabled={busy} onClick={submit}>
          {busy ? 'Creating…' : 'Create account'}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {/*
        Replaces the design's "signs in with this username & password" note,
        which describes a flow non-negotiable #6 does not allow.
      */}
      <p className="new-account__note">
        The account is created with no password. Send a reset link from her card and she sets her
        own — you never see or type it. Her scanner PIN and her permissions are separate, and she
        can reach nothing until you grant them.
      </p>
    </Card>
  );
}
