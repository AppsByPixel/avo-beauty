/**
 * Platform admin — the owner console's principal, and the thing whose absence
 * blocked all of phase 7.
 *
 * WHAT WAS ALREADY HERE, AND WHAT WAS NOT
 * --------------------------------------
 * `audit_log.actor_kind` has included `platform_admin` since migration 0001 and
 * the seed writes rows with it, but `services/audit.ts::actorOf()` could not
 * produce that value from any principal that existed — the schema anticipated
 * the console and the write path did not. `PrincipalKind` was
 * `'member' | 'staff'` and `SessionScope` was `'wallet' | 'scanner' |
 * 'dashboard'`, so `POST /auth/web/session` could only ever mint a salon-scoped
 * merchant session, and every `/v1/platform/*` route either took no principal at
 * all or took a merchant one.
 *
 * Lane C recorded the consequence in `apps/dashboard/src/auth/scopes.ts` and
 * refused to build against it, which was right: `LANES.md` § "Order of work"
 * records that running a client ahead of the API is what produced "the throwaway
 * sign-in stand-in that had to be rewritten".
 *
 * THIS PRINCIPAL HAS NO SALON, AND THAT IS THE WHOLE POINT
 * -------------------------------------------------------
 * Every other principal in this system is salon-scoped, and `requireSameSalon`
 * is the tenancy boundary. A platform admin is the one credential that reads
 * ACROSS salons by design — the console's Analytics is "across all salons" — so
 * `session.salon_id` is nullable from migration 0028 and a platform session must
 * carry NULL there. A platform admin with a salon id would be a merchant with
 * extra authority, which is exactly the confusion the console must not be.
 *
 * The inverse needs a test and lane D has it written down as owed: "the owner
 * console scope reads across salons by design; when it lands, every one of its
 * endpoints needs the inverse test — a merchant credential must not reach an
 * owner route" (`e2e/tenancy.test.ts`).
 *
 * =========================================================================
 * SECTION PERMISSIONS — SIX ARE DRAWN, NINE ARE HERE, AND THE GAP IS REPORTED
 * =========================================================================
 * `design/AVO Owner Console.dc.html` draws TEN sidebar sections — Analytics,
 * Activity, Reports, Salons, Accounts, Admins, Approvals, Policies, Audit log,
 * Controls — and its Admins editor offers SIX chips:
 *
 *     analytics · activity · salons · accounts · admins · controls
 *
 * So four sections have no declared gate. Three of them have endpoints in this
 * slice, and non-negotiable #7 does not permit an endpoint with no server-side
 * gate — "the UI hiding a button is a courtesy, not a control". Hence
 * `perm_approvals`, `perm_policies` and `perm_audit`, added because the
 * endpoints exist and NOT because a better authority model was wanted:
 *
 *   approvals   the campaign queue, the release/reject decision, and the
 *               platform throttle — which the design draws INSIDE the Approvals
 *               screen rather than under Controls, so it is gated with the
 *               screen it appears on.
 *   policies    the legal draft/publish/discard set. Publishing changes the text
 *               every customer in the product is held to.
 *   audit       the platform-wide audit read. The record of authority, across
 *               every salon.
 *
 * `reports` is the fourth ungated section and gets no column here, because
 * nothing in this slice serves it. When CSV export lands it needs a chip too,
 * and adding one then is a smaller decision than guessing at it now.
 *
 * REPORTED TO TRUNK: the design's chip list and its own sidebar disagree by
 * four. That is a design gap rather than a build decision, and the three columns
 * above are the minimum that lets the endpoints exist without an ungated door.
 *
 * THE OWNER HOLDS EVERYTHING, AS A CHECK
 * --------------------------------------
 * The design renders the owner's row as "Owner · full access" with
 * non-toggleable chips and no remove button. That is a rule, so it is a
 * constraint rather than a convention a handler keeps — the same treatment
 * `staff_user`'s "void implies charges" gets, and for the same reason: a row
 * written before the rule existed must not be able to express the forbidden
 * combination either.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { timestamptz } from './_shared';

/**
 * The four roles in the design's Admins editor, plus the owner it renders apart.
 *
 * `owner`, NOT `founder`, AND THE CONTRACT SAYS FOUNDER — a three-way disagreement
 * worth settling in writing, because Lane C hit it at its own boundary parse and had
 * written `founder` first.
 *
 *   api-contract.md:564 § PlatformAdmin   role: "founder" | "admin" | "analyst"
 *   AVO Owner Console.dc.html             role: 'owner', and a select offering
 *                                         admin / analyst / support
 *   here                                  owner | admin | analyst | support
 *
 * THE DESIGN WINS, on both counts, and CLAUDE.md is the reason rather than a
 * preference: "The designs in `design/` are **final**. Build them faithfully; do not
 * redesign them." `api-contract.md` is a derived specification, and it is stale here
 * in two independent ways — the word (`founder` where the drawn fixture says
 * `owner`) and the count (it omits `support`, which the Admins editor's own
 * `<option value="support">Support — accounts & salons</option>` offers and whose
 * preset the design spells out).
 *
 * `owner` is also the word that makes `platform_admin_owner_flag_matches_role`
 * readable: `owner = (role = 'owner')` is one fact stated once, where
 * `owner = (role = 'founder')` would be a flag and a role that have to be remembered
 * as a pair.
 *
 * REPORTED: `api-contract.md` § PlatformAdmin needs both corrections. `design/` is
 * outside this lane's column, so the fix is trunk's; this comment is here so the
 * next reader does not "correct" the enum back toward the stale document. Two lanes
 * independently reached `owner` from the design, which is the evidence.
 */
export const PLATFORM_ROLES = ['owner', 'admin', 'analyst', 'support'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * The nine sections. Six drawn as chips, three added because their endpoints
 * exist — see the header.
 */
export const PLATFORM_SECTIONS = [
  'analytics',
  'activity',
  'salons',
  'accounts',
  'admins',
  'controls',
  'approvals',
  'policies',
  'audit',
] as const;
export type PlatformSection = (typeof PLATFORM_SECTIONS)[number];

/**
 * The design's role presets, exactly — `adminPresets` in
 * `AVO Owner Console.dc.html`, extended over the three added sections.
 *
 * `analyst` and `support` get FALSE on all three additions, and that is the
 * conservative reading rather than a guess: the design gives an analyst
 * "read-only metrics" and support "accounts & salons", and neither description
 * includes releasing a message to every customer of a salon, republishing the
 * terms, or reading the platform's authority log.
 */
export const PLATFORM_ROLE_PRESETS: Record<PlatformRole, Record<PlatformSection, boolean>> = {
  owner: {
    analytics: true, activity: true, salons: true, accounts: true, admins: true,
    controls: true, approvals: true, policies: true, audit: true,
  },
  admin: {
    analytics: true, activity: true, salons: true, accounts: true, admins: true,
    controls: true, approvals: true, policies: true, audit: true,
  },
  analyst: {
    analytics: true, activity: true, salons: false, accounts: false, admins: false,
    controls: false, approvals: false, policies: false, audit: false,
  },
  support: {
    analytics: false, activity: true, salons: true, accounts: true, admins: false,
    controls: false, approvals: false, policies: false, audit: false,
  },
};

export const platformAdmin = pgTable(
  'platform_admin',
  {
    /** 'PA-YOUSEF'. Not a uuid: it appears in audit rows a human reads. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /**
     * The sign-in handle, lowercase, WITHOUT the '@' the console renders.
     *
     * GLOBALLY UNIQUE, unlike `staff_user.handle` which is unique per salon
     * because "noura" is not a unique person inside AVO. There is exactly one
     * platform, so there is exactly one "yousef" — which is also why platform
     * sign-in needs no workspace field and merchant sign-in does (DECISIONS.md
     * queue item 7).
     */
    handle: text('handle').notNull(),
    /**
     * Nullable, like `staff_user.password_hash`. An invited admin exists before
     * she has set a password — the design's Admins row offers "Reset password"
     * and shows "Link sent" — and non-negotiable #6 says the console only ever
     * sends a reset link. A NULL hash is "invited, not yet signed in", and
     * `POST /auth/platform/session` refuses it without saying which half failed.
     */
    passwordHash: text('password_hash'),
    role: text('role').$type<PlatformRole>().notNull(),
    /**
     * The one row the console renders as "You · Owner · full access", with no
     * remove button and no toggleable chips. A boolean rather than
     * `role = 'owner'` alone, because the CHECK below needs to say "this row
     * holds everything" and reading a role string to decide authority is the
     * mistake `permsOf` exists to avoid.
     */
    owner: boolean('owner').notNull().default(false),

    permAnalytics: boolean('perm_analytics').notNull().default(false),
    permActivity: boolean('perm_activity').notNull().default(false),
    permSalons: boolean('perm_salons').notNull().default(false),
    permAccounts: boolean('perm_accounts').notNull().default(false),
    permAdmins: boolean('perm_admins').notNull().default(false),
    permControls: boolean('perm_controls').notNull().default(false),
    /** The three additions. See the header. */
    permApprovals: boolean('perm_approvals').notNull().default(false),
    permPolicies: boolean('perm_policies').notNull().default(false),
    permAudit: boolean('perm_audit').notNull().default(false),

    /**
     * Deactivated rather than deleted, for the reason `audit_log`'s actor columns
     * are a snapshot: seven years outlives staff turnover, and a removed admin's
     * decisions must still read "Yousef · Owner". The design's ✕ removes the row
     * from the list; this is what that means underneath.
     */
    active: boolean('active').notNull().default(true),

    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('platform_admin_handle_uq').on(t.handle),
    check(
      'platform_admin_role_is_known',
      sql`${t.role} IN ('owner', 'admin', 'analyst', 'support')`,
    ),
    check('platform_admin_handle_is_lower', sql`${t.handle} = lower(${t.handle})`),
    check('platform_admin_handle_has_no_at', sql`${t.handle} NOT LIKE '@%'`),
    /**
     * "Owner · full access", as a constraint. A row flagged `owner` cannot have a
     * section switched off, so the console's non-toggleable chips are backed by
     * something rather than merely drawn that way.
     */
    check(
      'platform_admin_owner_holds_everything',
      sql`NOT ${t.owner} OR (${t.permAnalytics} AND ${t.permActivity} AND ${t.permSalons}
           AND ${t.permAccounts} AND ${t.permAdmins} AND ${t.permControls}
           AND ${t.permApprovals} AND ${t.permPolicies} AND ${t.permAudit})`,
    ),
    /** The owner role and the owner flag are one fact, not two. */
    check(
      'platform_admin_owner_flag_matches_role',
      sql`${t.owner} = (${t.role} = 'owner')`,
    ),
  ],
);
