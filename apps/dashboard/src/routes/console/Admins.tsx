import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  InfoBanner,
  Pill,
  Select,
  Skeleton,
  TextField,
} from '@avo/ui';
import { useSession } from '../../auth/AuthProvider.js';
import type { PlatformAdmin, PlatformSection } from '../../auth/platformAdmin.js';
import {
  ASSIGNABLE_ROLES,
  ROLE_LABEL_LONG,
  ROLE_LABEL_SHORT,
  SECTION_LABEL,
  SECTION_ORDER,
  useDeactivateAdmin,
  useInviteAdmin,
  usePlatformAdmins,
  useSendAdminReset,
  useUpdateAdmin,
  type AssignableRole,
} from '../../api/platformAdmins.js';
import { SectionError, WriteError } from '../sectionState.js';

/**
 * Admins — who can open the owner console, and which of its nine sections.
 *
 * This screen is where non-negotiable #7 is either real or decorative: "the UI
 * hiding a button is a courtesy, not a control". Every chip here posts a PATCH and
 * the server re-reads `platform_admin` on every subsequent request, so revoking
 * `approvals` from someone mid-session takes effect on her next call rather than
 * at her next sign-in. Nothing on this screen enforces anything; it edits the rows
 * the enforcement reads.
 *
 * =========================================================================
 * THE DESIGN'S "TEMPORARY PASSWORD" FIELD IS NOT DRAWN
 * =========================================================================
 * `AVO Owner Console.dc.html` § ADMINS draws four inputs on the invite form —
 * Full name, Role, Username, and "Temporary password" with the placeholder "At
 * least 6 characters". The fourth is absent here, and this is the one place in
 * this build where a design element is deliberately not implemented.
 *
 * Non-negotiable #6: "Passwords are never stored in plaintext, never returned by
 * an endpoint, never shown in a UI. Owner console only sends a reset link." A
 * field that accepts a password the inviter then has to read out is all three
 * failures at once. `POST /v1/platform/admins` refuses `password` and
 * `temporaryPassword` by name with `password_not_accepted` rather than ignoring
 * them, so drawing the field would produce a form that cannot submit — but the
 * reason it is not drawn is #6, not the 400.
 *
 * =========================================================================
 * THE RESET LINK EXISTS NOW, AND THIS COMMENT USED TO SAY IT DID NOT
 * =========================================================================
 * It read: "The design pairs the password field with a 'Reset password' button and
 * a 'Link sent' confirmation. THERE IS NO ENDPOINT BEHIND EITHER … Drawing 'Reset
 * password' would be a button that does nothing."
 *
 * That was true when it was written and is false now. Lane A landed both halves —
 * `POST /v1/platform/admins/{id}/password-reset` issues
 * (`api/src/routes/platformAdmins.ts:461`) and `POST /auth/platform/password-reset`
 * redeems (`api/src/routes/auth.ts:831`) — so the button is built. The claim is
 * corrected in place rather than deleted, because a stale "not built" note is the
 * repeat failure in this repo: nine of them had outlived their endpoints, and this
 * one was rebased in still asserting a gap that had closed.
 *
 * "Link sent" IS the design's word and is used, with the same care `Accounts.tsx`
 * takes over the identical 202: the endpoint reports ACCEPTED, not delivered, and
 * answers `delivered: false` because no sender is wired. So the row says a link
 * exists and when it stops working, and never that it arrived.
 *
 * `passwordSet` still drives "Invited · cannot sign in yet" — issuing a link does
 * NOT set a password, so the pill is still true after the button is pressed, and
 * the two are showing different facts rather than contradicting each other.
 *
 * THE OWNER GETS THE BUTTON, unlike the ✕ and the chips. The endpoint allows it
 * deliberately and says why: she is the escape hatch that cannot be removed, so an
 * owner locked out with no way to request a link is "the one lockout with nothing
 * behind it". Resetting a credential is not editing authority. A REMOVED admin does
 * NOT get it — the endpoint refuses her with 404, because a link would be a way
 * back into the console for somebody deliberately taken out of it.
 *
 * =========================================================================
 * NINE CHIPS, NOT THE DESIGN'S SIX
 * =========================================================================
 * See `SECTION_LABEL` in api/platformAdmins.ts. The three the design does not
 * draw — approvals, policies, audit — gate endpoints that exist and sections this
 * lane has already built, so omitting them would leave no way to grant Approvals
 * short of an UPDATE by hand.
 */
export function Admins() {
  const admins = usePlatformAdmins();
  const invite = useInviteAdmin();
  const update = useUpdateAdmin();
  const deactivate = useDeactivateAdmin();
  const sendReset = useSendAdminReset();
  /* `adminId`, not `id` — see auth/session.ts § OwnerSession. */
  const me = useSession('owner');

  const [adding, setAdding] = useState(false);
  /*
   * WHICH ROW HAS A LIVE LINK, keyed by admin id rather than read off the mutation.
   * `useMutation` holds one `data`/`variables` pair, so a second reset would move
   * the "Link sent" line from the first row to the second and quietly imply the
   * first link had stopped existing. Both are live — the endpoint spends a previous
   * link only for the SAME admin — so the screen has to remember per row.
   *
   * Local state and not the query cache, because the server sends none of this back
   * on the admin row: `password_hash` is untouched until she redeems the link, so
   * there is nothing in `GET /v1/platform/admins` to hold it. It is therefore
   * session-scoped by nature and lost on reload, which is honest — the console
   * cannot know from the API whether a link is still outstanding.
   */
  const [linkSentAt, setLinkSentAt] = useState<Record<string, string>>({});

  if (admins.isError) {
    return (
      <SectionError
        error={admins.error}
        forbiddenTitle="You don't have access to admins"
        failedTitle="Couldn't load the console users"
        onRetry={() => void admins.refetch()}
        retrying={admins.isFetching}
      />
    );
  }

  /*
   * DEACTIVATED ADMINS ARE NOT FILTERED OUT HERE, because the API does send them:
   * `DELETE` flips `active` to false and `GET`'s query is unfiltered, so a row
   * with `active: false` is a row the server chose to show.
   *
   * THIS COMMENT USED TO SAY "nothing in the seed or the handlers produces one
   * today, so there is no state to draw for — named, not built." THAT WAS WRONG,
   * and the screen's own ✕ is what falsified it: the DELETE this file calls is
   * precisely what produces the row, one refetch later. Driven against
   * `avo_lane_c`, GET then returned four items with `PA-FATIMAS · active=False`
   * and the card rendered her identically to an active admin — live role select,
   * nine live chips, and a live ✕ that now answers 404 `unknown_admin`, which
   * `WriteError` would report as a failure over a removal that had already
   * committed. The count read "4 console users" when three could open the console.
   *
   * The treatment the old comment already proposed is the right one and is now
   * built, mirroring `Accounts.tsx`'s leaver row — the merchant Team screen had
   * solved this exact shape (`data-inactive`, controls collapsed to one pill, no
   * ✕) and this sibling had not copied it.
   */
  const items = admins.data ?? [];
  /* Who can actually open the console. A removed admin cannot, so she is not one. */
  const activeCount = items.filter((a) => a.active).length;

  return (
    <div className="admins">
      <InfoBanner icon={<PersonCheckGlyph />}>
        Invite people to the owner console with their own sign-in. Pick a role, then fine-tune
        exactly which sections they can open.
      </InfoBanner>

      <div className="admins__head">
        <span className="admins__count">
          {admins.isPending ? '' : `${activeCount} console users`}
        </span>
        {!adding && !admins.isPending ? (
          <Button variant="quiet" onClick={() => setAdding(true)}>
            + Add admin
          </Button>
        ) : null}
      </div>

      {adding ? (
        <InviteForm
          busy={invite.isPending}
          error={invite.isError ? invite.error : null}
          onCancel={() => {
            invite.reset();
            setAdding(false);
          }}
          onSubmit={(input) => {
            invite.mutate(input, { onSuccess: () => setAdding(false) });
          }}
        />
      ) : null}

      {admins.isPending ? (
        <>
          <Card className="admins__card">
            <Skeleton width="34%" height={17} />
            <Skeleton width="60%" height={13} />
          </Card>
          <Card className="admins__card">
            <Skeleton width="30%" height={17} />
            <Skeleton width="55%" height={13} />
          </Card>
        </>
      ) : items.length === 0 ? (
        /*
         * Unreachable in practice — the platform owner is seeded and cannot be
         * removed, so the list has at least one row. Built anyway because a screen
         * without its empty state is not done, and because "unreachable" is a claim
         * about today's seed rather than about the endpoint.
         */
        <EmptyState
          title="No console users"
          body="Nobody can open the owner console. Add an admin to give someone access."
        />
      ) : (
        <ul className="admins__list">
          {items.map((admin) => (
            <AdminCard
              key={admin.id}
              admin={admin}
              isMe={admin.id === me.adminId}
              busy={update.isPending || deactivate.isPending}
              onRole={(role) => update.mutate({ id: admin.id, role })}
              onToggle={(section, on) =>
                update.mutate({ id: admin.id, sections: { [section]: on } })
              }
              onRemove={() => deactivate.mutate({ id: admin.id })}
              /* Per row, so a second reset does not move the first row's line. */
              resetting={sendReset.isPending && sendReset.variables?.id === admin.id}
              linkExpiresAt={linkSentAt[admin.id] ?? null}
              onReset={() =>
                sendReset.mutate(
                  { id: admin.id },
                  {
                    onSuccess: (accepted) =>
                      setLinkSentAt((prev) => ({ ...prev, [accepted.adminId]: accepted.expiresAt })),
                  },
                )
              }
            />
          ))}
        </ul>
      )}

      {update.isError ? (
        <WriteError error={update.error} reassurance="Nobody's access changed." />
      ) : null}
      {deactivate.isError ? (
        <WriteError error={deactivate.error} reassurance="That admin still has access." />
      ) : null}
      {sendReset.isError ? (
        /*
         * "No link was sent" is the whole reassurance and it is accurate: the issue
         * is one transaction that spends the previous link and inserts the new one
         * together, so a failure leaves any earlier link exactly as it was.
         */
        <WriteError error={sendReset.error} reassurance="No link was sent." />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- invite -- */

function InviteForm({
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (input: { name: string; username: string; role: AssignableRole }) => void;
}) {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<AssignableRole>('admin');

  /*
   * The API's own rule, restated so the field can refuse before the round trip
   * rather than after: "2–100 characters of letters, digits, dot, dash or
   * underscore". A leading '@' is stripped server-side, so it is accepted here and
   * not required.
   */
  const handle = username.trim().replace(/^@/, '').toLowerCase();
  const handleValid = /^[a-z0-9._-]{2,100}$/.test(handle);
  const ready = name.trim() !== '' && handleValid;

  return (
    <Card className="admins__invite">
      <h2 className="admins__h2 avo-display">New console admin</h2>

      <div className="admins__invitegrid">
        <TextField
          label="Full name"
          placeholder="Salem A."
          value={name}
          autoComplete="off"
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <Select
          label="Role"
          value={role}
          options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL_LONG[r] }))}
          onChange={(e) => setRole(e.currentTarget.value as AssignableRole)}
        />
        <TextField
          label="Username"
          placeholder="salem.a"
          value={username}
          autoComplete="off"
          onChange={(e) => setUsername(e.currentTarget.value)}
        />
      </div>

      {/*
        THE FOURTH FIELD IS MISSING ON PURPOSE — #6. The design draws "Temporary
        password / At least 6 characters" here. See this file's header: an invite
        creates an admin with no password, and she sets her own through a reset
        link. This sentence is on the screen rather than only in a comment, because
        the person it matters to is the inviter, who would otherwise expect the new
        admin to be able to sign in.
      */}
      <p className="admins__note">
        AVO never sets a password. {name.trim() === '' ? 'The new admin' : name.trim()} will get a
        reset link and choose her own — send it with Reset password on her row once she&rsquo;s
        created.
      </p>

      {error ? <WriteError error={error} reassurance="No admin was created." /> : null}

      <div className="admins__inviteactions">
        <Button
          disabled={busy || !ready}
          onClick={() => onSubmit({ name: name.trim(), username: handle, role })}
        >
          Create admin
        </Button>
        <Button variant="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------------- card -- */

function AdminCard({
  admin,
  isMe,
  busy,
  onRole,
  onToggle,
  onRemove,
  onReset,
  resetting,
  linkExpiresAt,
}: {
  admin: PlatformAdmin;
  isMe: boolean;
  busy: boolean;
  onRole: (role: AssignableRole) => void;
  onToggle: (section: PlatformSection, on: boolean) => void;
  onRemove: () => void;
  onReset: () => void;
  resetting: boolean;
  /** ISO expiry of a link issued in THIS session, or null. */
  linkExpiresAt: string | null;
}) {
  /*
   * THE OWNER IS NOT EDITABLE, which the design draws (no select, no ✕, a static
   * "Owner · full access") and `platform_admin_owner_holds_everything` enforces in
   * the database. The API refuses an edit or a removal by name, so this is the
   * courtesy layer over a real control rather than the control itself.
   *
   * `isMe` is the second immovable case and it is NOT the same one: you may edit
   * your own role and chips — the server allows it, and an admin narrowing her own
   * access is a legitimate thing to do — but you may not remove yourself, because
   * the `admins` section is the only route back in. So the ✕ is withheld and the
   * select is not.
   */
  /*
   * THE THIRD IMMOVABLE CASE, and the one this card was missing: a REMOVED admin.
   * `DELETE` deactivates and `GET` still lists her, so she arrives here with
   * `active: false` — holding no console access, no session (they are revoked at
   * removal) and nothing worth editing. Her controls collapse to one pill, exactly
   * as `Accounts.tsx` does for a leaver: a role select and nine chips over a row
   * the enforcement already refuses would be edits with no subject, and the ✕
   * answers 404 `unknown_admin`.
   */
  const removed = !admin.active;
  const editable = !admin.owner && !removed;
  const removable = editable && !isMe;

  return (
    <li>
      <Card className="admins__card" data-inactive={removed || undefined}>
        <div className="admins__cardtop">
          <span className="admins__avatar" aria-hidden="true">
            {admin.name.slice(0, 1)}
          </span>

          <span className="admins__who">
            <span className="admins__name">
              {admin.name}
              {isMe ? <span className="admins__you">You</span> : null}
            </span>
            <span className="admins__handle">{admin.handle}</span>
          </span>

          {/*
            THREE BRANCHES, NOT TWO. `editable` now excludes the removed row as
            well as the owner, so an `editable ? Select : Owner-pill` would have
            labelled a deactivated analyst "Owner · full access" — the defect the
            two-branch version would have introduced the moment `removed` joined
            the condition. The removed case is tested first because it is the one
            that overrides both.
          */}
          {removed ? (
            <Pill tone="quiet">Removed &middot; no console access</Pill>
          ) : editable ? (
            <Select
              label={`Role for ${admin.name}`}
              labelHidden
              size="sm"
              value={admin.role}
              disabled={busy}
              options={ASSIGNABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABEL_SHORT[r] }))}
              onChange={(e) => onRole(e.currentTarget.value as AssignableRole)}
            />
          ) : (
            /* The design's static label for the owner row, verbatim. */
            <Pill tone="warn">Owner &middot; full access</Pill>
          )}

          {/*
            `|| removed` for the same reason `Accounts.tsx` writes
            `account.passwordSet || leaver ? null : …` — a removed admin also has
            `passwordSet: false` (she never set one), so without this she would
            carry BOTH pills and read as an invitation still waiting on somebody.
            "Removed" is the fact that matters; the pending invite is moot.
          */}
          {admin.passwordSet || removed ? null : (
            <Pill tone="neutral">Invited &middot; cannot sign in yet</Pill>
          )}

          {/*
            "Reset password" / "Link sent" — the design's two words, now that lane A
            has put an endpoint behind them. On EVERY row including the owner's,
            which the design draws and the endpoint deliberately permits: she is the
            escape hatch that cannot be removed, so refusing her a link would be the
            one lockout with no way out. Resetting a credential is not editing
            authority, which is why this sits outside `editable`.

            NOT on a removed row — the endpoint answers 404 there on purpose, since a
            link would be a way back in for somebody deliberately taken out.

            "Link sent · expires HH:MM" reports what the 202 actually promises. The
            response carries `delivered: false` and no token, and neither the link nor
            anything derived from it is rendered — non-negotiable #6 on this side of
            the wire too.
          */}
          {removed ? null : linkExpiresAt ? (
            <span className="admins__sent">
              <span className="admins__sent-dot" aria-hidden="true" />
              Link sent &middot; expires {formatExpiry(linkExpiresAt)}
            </span>
          ) : (
            <Button
              variant="secondary"
              className="admins__reset"
              disabled={busy || resetting}
              onClick={onReset}
            >
              {resetting ? 'Sending…' : 'Reset password'}
            </Button>
          )}

          {removable ? (
            <button
              type="button"
              className="admins__remove"
              disabled={busy}
              title={`Remove ${admin.name}`}
              aria-label={`Remove ${admin.name}`}
              onClick={onRemove}
            >
              ✕
            </button>
          ) : null}
        </div>

        {/*
          THE CHIP ROW IS ABSENT ON A REMOVED ROW, not merely disabled — the same
          call `Accounts.tsx` makes with `{leaver ? null : …}` around its authority
          area. Nine greyed chips describe access she does not have: her sections
          are whatever they were when the ✕ landed, and `loadPlatformPrincipal`
          refuses the row on every request regardless of what they say. Showing
          them would be showing a permission set that no longer decides anything.
        */}
        {removed ? null : (
        <div className="admins__access">
          <div className="admins__accesshead">Console access</div>
          <div className="admins__chips">
            {SECTION_ORDER.map((section) => (
              <Chip
                key={section}
                on={admin.sections[section]}
                label={SECTION_LABEL[section]}
                dot
                /*
                 * The owner's chips are all on and cannot be turned off. Disabled
                 * rather than absent: the design shows the owner holding every
                 * section, and hiding the row would make "full access" a claim with
                 * nothing behind it.
                 */
                disabled={!editable || busy}
                onClick={() => onToggle(section, !admin.sections[section])}
              />
            ))}
          </div>
          {editable ? (
            <p className="admins__rolenote">
              Changing the role resets these to that role&rsquo;s defaults.
            </p>
          ) : null}
        </div>
        )}
      </Card>
    </li>
  );
}

/*
 * The same four lines as `Accounts.tsx`'s `formatExpiry`, which is module-private
 * there. Duplicated rather than extracted on purpose: sharing it means editing a
 * file already on `dev` to move a wall-clock formatter, which buys nothing and adds
 * merge surface to two lanes' worth of console work. If a third caller appears it
 * belongs in `packages/ui` and that is a trunk conversation.
 *
 * 'en-GB' and a 24-hour clock, matching the merchant screen. Not money, so the
 * three-decimal rule does not apply; `formatMoney` is untouched by this screen
 * because nothing on it is money.
 */
function formatExpiry(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'soon';
  return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function PersonCheckGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M2.5 16.5c0-2.6 2-4.2 4.5-4.2s4.5 1.6 4.5 4.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M14 5.5l1.4 1.4L18 4.3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
