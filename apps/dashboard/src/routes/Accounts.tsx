import { useState } from 'react';
import type { StaffUser } from '@avo/types';
import { Card, Chip, EmptyState, Pill, Segmented, Skeleton } from '@avo/ui';
import {
  PERMISSIONS,
  applyPermissionRules,
  changedPerms,
  useSetPermissions,
  useStaff,
  type PermissionName,
  type StaffPerms,
} from '../api/staff.js';
import { useSalon } from '../api/salon.js';
import { SectionError, WriteError } from './sectionState.js';

/**
 * Merchant → Accounts → Team. `GET /staff`, `PATCH /staff/{id}`, `perms.team`.
 *
 * WHAT THE CHIPS ACTUALLY DO. Each one writes to the shared staff record, and
 * the staff scanner reads the same record — so switching "Scan & charge" off
 * here changes what that phone can open, and the API revokes her live scanner
 * sessions on the way. Every grant and every revoke writes an audit row naming
 * who changed what, from what, to what; they show up under Access in the audit
 * log, which is the next section.
 *
 * WHAT IS NOT BUILT, AND WHY IT IS NOT FAKED
 * The design's account card also carries a role select, a branch-access select,
 * "Reset password", a remove button, and an "+ Add teammate" form. None of them
 * has an endpoint:
 *
 *   POST   /staff        does not exist   (create)
 *   DELETE /staff/{id}   does not exist   (remove)
 *   password reset       does not exist   (no route sends a link)
 *   PATCH  /staff/{id}   takes `perms` and nothing else — role and branchAccess
 *                        are not settable, and credentials are refused outright
 *
 * Role and branch therefore render as what they are — facts about the account —
 * rather than as selects that discard the choice. The rest is reported to Lane A
 * rather than drawn as buttons that do nothing. Phase 4's "configure a salon end
 * to end without an engineer" is not met for staff onboarding today.
 */

type Tab = 'team' | 'customers';

export function Accounts() {
  const staff = useStaff();
  const salon = useSalon();
  const setPermissions = useSetPermissions();
  const [tab, setTab] = useState<Tab>('team');

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
  const branchNames = new Map((salon.data?.branches ?? []).map((b) => [b.id, b.name]));

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
          {tab === 'team'
            ? 'Create sign-ins for your staff and control what each can do.'
            : 'Open a customer to see their profile, activity and purchases — or gift and reimburse them.'}
        </span>
      </div>

      {tab === 'customers' ? (
        <EmptyState
          title="Customer profiles aren't built yet"
          body="Gift, reimburse and the customer activity feed are a later phase. Staff access is on the Team tab."
        />
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
      ) : !items || items.length === 0 ? (
        <EmptyState
          title="No team accounts"
          body="Staff sign-ins are created by AVO during onboarding. Once they exist you can set exactly what each person is allowed to do."
        />
      ) : (
        <>
          <div className="accounts__count">
            {items.length} team account{items.length === 1 ? '' : 's'} · toggle exactly what each
            person is allowed to do.
          </div>

          <div className="accounts__list">
            {items.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                branchNames={branchNames}
                busy={setPermissions.isPending && setPermissions.variables?.staffId === account.id}
                onToggle={(key, next) => {
                  const before = account.perms as StaffPerms;
                  const after = applyPermissionRules(before, key, next);
                  const diff = changedPerms(before, after);
                  if (Object.keys(diff).length === 0) return;
                  setPermissions.mutate({ staffId: account.id, perms: diff });
                }}
              />
            ))}
          </div>
        </>
      )}

      {setPermissions.isError ? (
        <WriteError
          error={setPermissions.error}
          reassurance="That permission is unchanged."
        />
      ) : null}
    </>
  );
}

/* --------------------------------------------------------------- one account */

interface AccountCardProps {
  account: StaffUser;
  branchNames: Map<string, string>;
  busy: boolean;
  onToggle: (key: PermissionName, next: boolean) => void;
}

function AccountCard({ account, branchNames, busy, onToggle }: AccountCardProps) {
  const perms = account.perms as StaffPerms;

  const branchLabel =
    account.branchAccess === 'all'
      ? 'All branches'
      : account.branchAccess.map((id) => branchNames.get(id) ?? id).join(', ');

  return (
    <Card className="account">
      <div className="account__head">
        <span className="account__avatar" aria-hidden="true">
          {account.name.slice(0, 1)}
        </span>
        <div className="account__ident">
          <div className="account__name">{account.name}</div>
          <div className="account__handle">@{account.handle}</div>
        </div>
        {/* Facts, not controls — neither is settable through any endpoint. */}
        <Pill tone="quiet">{ROLE_LABEL[account.role] ?? account.role}</Pill>
        <Pill tone="quiet">{branchLabel}</Pill>
        {/*
          `pinSet` is the ONLY thing a client ever learns about a PIN — never the
          PIN, never its hash. Shown because "she has no scanner PIN yet" is the
          difference between an account that can charge and one that cannot.
        */}
        <Pill tone={account.pinSet ? 'brand' : 'quiet'}>
          {account.pinSet ? 'PIN set' : 'No PIN'}
        </Pill>
      </div>

      <div className="account__perms">
        <div className="avo-label">Access &amp; authority</div>
        <div className="account__chips">
          {PERMISSIONS.map(({ key, label }) => {
            const on = perms[key] === true;
            return (
              <Chip
                key={key}
                on={on}
                dot
                label={label}
                disabled={busy}
                aria-label={`${label} — ${account.name}`}
                onClick={() => onToggle(key, !on)}
              />
            );
          })}
        </div>
        {/*
          Said once, near the two chips it governs, rather than discovered when
          the server silently takes `void` away with `charges`.
        */}
        <p className="account__rule">
          Void a charge requires See today&rsquo;s charges — granting one grants both, and
          removing charges removes void.
        </p>
      </div>
    </Card>
  );
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  frontdesk: 'Front desk',
  artist: 'Stylist',
  scanner: 'Scanner only',
};
