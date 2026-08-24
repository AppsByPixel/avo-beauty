/**
 * `GET /v1/platform/accounts` — the console's Accounts list.
 *
 * ================= THE WIDEST READ IN THE PRODUCT =================
 *
 * Say it plainly, because every other read in this API is the opposite. `member`
 * and `staff_user` are reached through `requireSameSalon` everywhere else, and
 * `services/memberSearch.ts` spends a page arguing that a staff-facing search box
 * "is a customer-list export unless you stop it" — salon scoping, a minimum query
 * length, two rate-limit tiers and an audit row per lookup. This endpoint has NO
 * salon predicate at all. It crosses every tenant by design, which is what the
 * design's own Accounts section is: "all users, filter, wallet adjust, stamps,
 * password-reset links".
 *
 * So the whole safety argument is the gate, and it is `requirePlatform(req,
 * 'accounts')` — which refuses on the CREDENTIAL KIND before it refuses on
 * authority. A merchant token, a scanner PIN and a member token all fail
 * `requirePlatformScope` with "This endpoint is the AVO owner console, not the salon
 * dashboard", because a merchant reaching this turns one salon's front desk into a
 * platform-wide staff and customer directory. That is the inverse of the leak
 * `memberSearch.ts` was built to prevent, and it is the one failure of this file
 * that would not look like a bug from the console.
 *
 * ================= NON-NEGOTIABLE #6 =================
 *
 * "Passwords are never stored in plaintext, never returned by an endpoint, never
 * shown in a UI." The design draws that sentence on this very screen. What is
 * served is `passwordSet: boolean` and there is deliberately no `SELECT` of
 * `password_hash`, `pin_hash` or any reset token anywhere below — the comparison
 * happens in the DATABASE and only the boolean crosses the boundary, so the hash
 * never enters this process. `routes/staff.ts` and `routes/platformAdmins.ts`
 * compute the same field, and both do it in TypeScript from a selected column;
 * this one does not read the column at all.
 *
 * And the naive version of that boolean is a LIE for a customer, which driving it
 * is what showed: `member.password_hash` is `NOT NULL`, so erasure cannot clear it
 * and overwrites it with a sentinel instead. `IS NOT NULL` therefore returned
 * `passwordSet: true` beside `status: 'erased'`. The sentinel is now exported from
 * `services/erasure.ts` and compared against — one definition, because two
 * spellings of "erased password" is how the one nobody reads drifts.
 *
 * NO CUSTOMER PHONE OR EMAIL, and that is a departure from the design worth
 * reporting rather than quietly making. `design/AVO Owner Console.dc.html` renders a
 * handle on every row — `@latifa.a` for a customer — and no such column exists on
 * `member`; its login identity is the PHONE. Deriving a handle would be inventing
 * data, and serving the phone would put every customer's number in the product's
 * widest list, which is a much larger disclosure than the screen needs to do its
 * job: the design's table draws Name, Salon and Role, and the actions are keyed on
 * the id. So `handle` is the staff member's real one and `null` for a customer. If
 * the console needs to tell two customers named Dana apart, that belongs on a
 * per-account read, not on a list that returns every tenant at once.
 *
 * ================= WHY IT DID NOT EXIST =================
 *
 * The section had its verbs and no way to find an account. `POST
 * /members/{id}/adjustments` (routes/adjustments.ts) and `POST
 * /accounts/{id}/reset-link` (routes/accountResets.ts) are both `requirePlatform(req,
 * 'accounts')` and both take an id the console had no endpoint to obtain: `GET
 * /members` is a scanner-scoped search behind `perms.scanner`, and `GET /staff` is
 * `requireDashboardPerm(req, 'team')` on the merchant's own salon. Both refuse a
 * platform admin. That is the same shape `routes/platformConsole.ts` records for the
 * Salons section — a guard pointing at a screen with no remedy in it.
 *
 * A CONTRACT ADDITION, reported: api-contract.md § Operations names the two writes
 * and not this read, exactly as it named neither `POST /v1/platform/salons` nor the
 * four admin routes.
 *
 * `kind` ON THE WIRE IS THE FIELD `POST /accounts/{id}/reset-link` REQUIRES in its
 * body, and that is not a coincidence — that route refuses to infer it: "Ids are
 * opaque by contract, so nothing guarantees the two id spaces stay disjoint… The
 * console's list knows the role of every row it renders; making it say so costs one
 * field and removes a class of wrong-account resets." This is the list that knows.
 *
 * CONSOLE ADMINS ARE NOT HERE. They are the Admins section and
 * `GET /v1/platform/admins` serves them, gated `admins` — a different chip, because
 * seeing who can sign in to AVO itself is not the same authority as seeing a salon's
 * customers. The design agrees: its three role labels are Customer, Staff and Salon
 * owner.
 */

import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { salon } from '../db/schema/salon';
import { staffUser } from '../db/schema/staff';
import { requirePlatform } from '../auth/principal';
import { ERASED_PASSWORD_SENTINEL } from '../services/erasure';
import { badRequest } from '../http/errors';
import {
  afterCursor,
  cursorInstant,
  mergePage,
  parseCursor,
  type Keyed,
} from '../services/streamCursor';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/**
 * Two tables, so two ranks. `services/streamCursor.ts` owns the mechanics; what is
 * this endpoint's own is the order — customers first inside one instant, because
 * `member` and `staff_user` rows created by the onboarding wizard share a
 * `created_at` and the pair has to page deterministically.
 */
const STREAM_RANK = { customer: 0, staff: 1 } as const;
const ACCOUNT_RANKS = Object.values(STREAM_RANK);

/**
 * The design's four filter chips: "All accounts", Customers, Staff, Salon owners.
 *
 * `owner` is a `staff_user` whose `role` is `owner` — `db/schema/staff.ts`'s
 * `staffRole` enum — not a third table. `POST /accounts/{id}/reset-link` already
 * reasons this way: "A salon owner is a staff_user, so the design's third role is
 * `kind: 'staff'`."
 */
const ROLE_FILTERS = ['all', 'customer', 'staff', 'owner'] as const;
type RoleFilter = (typeof ROLE_FILTERS)[number];

/**
 * WHAT AN ACCOUNT IS, AS ONE STATE RATHER THAN THREE NULLABLE TIMESTAMPS.
 *
 * The two tables spell "not usable any more" differently and both are already
 * pinned by CHECK constraints: a member is `deletion_requested` then `erased`
 * (`member_erased_requires_request`), and a staff member is `deactivated` with both
 * credentials nulled (`staff_user_deactivated_has_no_credentials`). A console
 * rendering three timestamp fields would have to re-derive the precedence, and the
 * precedence is the thing that matters — an erased member is a tombstone and
 * `POST /accounts/{id}/reset-link` refuses her 409, while a member inside the
 * deletion window issues normally because "the window exists so she can come back".
 * One field, resolved here, so the console's disabled states cannot disagree with
 * what the write door will do.
 */
type AccountStatus = 'active' | 'deletion_requested' | 'erased' | 'deactivated';

interface AccountRow {
  id: string;
  /** `'customer' | 'staff'` — the field `POST /accounts/{id}/reset-link` requires. */
  kind: 'customer' | 'staff';
  name: string;
  /** The staff member's real login handle. `null` for a customer — see the header. */
  handle: string | null;
  /** `'customer'`, or one of `staffRole`: owner / manager / frontdesk / artist / scanner. */
  role: string;
  salonId: string;
  /** The salon pill the design draws on every row. */
  salon: string;
  /** NON-NEGOTIABLE #6. A boolean, computed in SQL, never the hash. */
  passwordSet: boolean;
  status: AccountStatus;
  createdAt: string;
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw badRequest('invalid_limit', `limit must be a whole number between 1 and ${MAX_LIMIT}.`);
  }
  return n;
}

function parseRole(value: unknown): RoleFilter {
  if (value === undefined || value === '') return 'all';
  const raw = String(value).trim();
  if (raw === '') return 'all';
  if (!(ROLE_FILTERS as readonly string[]).includes(raw)) {
    throw badRequest('invalid_role', `role must be one of ${ROLE_FILTERS.join(', ')}.`);
  }
  return raw as RoleFilter;
}

/**
 * The search box: "Search accounts — name, salon…".
 *
 * `%` and `_` ESCAPED, the same as `auditSearchPredicate`, so somebody typing a
 * literal underscore searches for that character rather than for any character.
 *
 * NO MINIMUM LENGTH, unlike `services/memberSearch.ts`, and the difference is not
 * an oversight. That box needs one because a two-character floor is what stops a
 * SALON'S STAFF walking the customer name space from a tablet; a console admin
 * holding `accounts` is entitled to the unfiltered list and gets it by sending no
 * query at all, so a floor here would restrict nothing and only break "search for
 * everyone called A". The control on this endpoint is the section gate, not the
 * query.
 *
 * NOT `role`, though the design's mock filters on it. Its rows carry the LABEL
 * ("Customer", "Salon owner") and this endpoint carries the enum value, so matching
 * a typed word against `role` would find "owner" and never "Salon owner" — a search
 * that works for one of the four chips and silently not the others. `?role=` is the
 * field for that question and it is exact.
 */
function like(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get<{
    Querystring: { role?: string; q?: string; salon?: string; limit?: string; cursor?: string };
  }>('/v1/platform/accounts', async (req, reply) => {
    /**
     * THE ONLY THING STANDING BETWEEN A CREDENTIAL AND EVERY ACCOUNT AVO HOLDS.
     * `requirePlatform` checks the kind first and the section second — see the
     * header, and `auth/principal.ts` § `requirePlatformScope` for the copy.
     */
    requirePlatform(req, 'accounts');

    const limit = parseLimit(req.query.limit);
    const role = parseRole(req.query.role);
    const q = (req.query.q ?? '').trim();
    const cursor = parseCursor(req.query.cursor, ACCOUNT_RANKS);
    const take = limit + 1;

    /**
     * `?salon=` NARROWS and widens nothing — `GET /v1/platform/audit`'s reasoning,
     * refusal by name included: "no accounts" and "you typed the wrong id" look
     * identical otherwise and only one of them is worth acting on.
     */
    const salonFilter = (req.query.salon ?? '').trim();
    if (salonFilter !== '') {
      const [known] = await db
        .select({ id: salon.id })
        .from(salon)
        .where(eq(salon.id, salonFilter))
        .limit(1);
      if (!known) throw badRequest('unknown_salon', 'No such salon.');
    }

    /**
     * ONE QUERY PER TABLE, each joined to `salon` for the pill and for the name the
     * search matches on. A join rather than a second lookup keyed on the ids that
     * came back, because the salon name is part of the FILTER — resolving it
     * afterwards would mean filtering in memory over a page that was selected
     * without the predicate, which is a page missing rows.
     *
     * `LEFT JOIN`, though both foreign keys are `NOT NULL` with `onDelete: 'restrict'`
     * so a row without a salon cannot exist: an inner join would silently DROP such a
     * row if one ever did, and a directory that quietly omits accounts is worse than
     * one that shows a blank pill.
     */
    const wantCustomers = role === 'all' || role === 'customer';
    const wantStaff = role === 'all' || role === 'staff' || role === 'owner';

    const customerRows = wantCustomers
      ? await db
          .select({
            id: member.id,
            name: member.name,
            salonId: member.salonId,
            salonName: salon.name,
            /**
             * #6: computed in SQL, so the hash is never selected and never reaches
             * this process — the comparison happens in the database and only the
             * boolean crosses the boundary.
             *
             * `IS NOT NULL` ALONE IS A LIE HERE, and driving it is what showed that.
             * `member.password_hash` is `NOT NULL`, so an erased member cannot have
             * it cleared — `services/erasure.ts` overwrites it with
             * `ERASED_PASSWORD_SENTINEL`, a value `argon2.verify` refuses because it
             * is not a PHC string. So the naive check returned `passwordSet: true`
             * beside `status: 'erased'`, which is a contradiction on the one screen
             * whose banner is #6's own sentence. The sentinel is imported rather
             * than repeated: two spellings of "erased password" is how the one
             * nobody reads drifts.
             *
             * For every live member this is `true`, and that is a fact the console
             * can rely on: there is no "invite pending" state for a customer the way
             * there is for staff.
             */
            passwordSet: sql<boolean>`${member.passwordHash} IS NOT NULL
              AND ${member.passwordHash} <> ${ERASED_PASSWORD_SENTINEL}`,
            erasedAt: member.erasedAt,
            deletionRequestedAt: member.deletionRequestedAt,
            createdAt: member.createdAt,
            cursorAt: cursorInstant(member.createdAt),
          })
          .from(member)
          .leftJoin(salon, eq(salon.id, member.salonId))
          .where(
            and(
              salonFilter === '' ? undefined : eq(member.salonId, salonFilter),
              q === ''
                ? undefined
                : or(ilike(member.name, like(q)), ilike(salon.name, like(q))),
              afterCursor(cursor, STREAM_RANK.customer, member.createdAt, member.id),
            ),
          )
          .orderBy(desc(member.createdAt), asc(member.id))
          .limit(take)
      : [];

    const staffRows = wantStaff
      ? await db
          .select({
            id: staffUser.id,
            name: staffUser.name,
            handle: staffUser.handle,
            role: staffUser.role,
            salonId: staffUser.salonId,
            salonName: salon.name,
            /**
             * #6, and here the boolean carries real information: `password_hash` is
             * NULLABLE on staff, so `false` is either an invite nobody has redeemed
             * (`routes/staff.ts`: "the dashboard can show the new row as invite
             * pending") or a leaver, whose credentials are both nulled by
             * `staff_user_deactivated_has_no_credentials`. `pin_hash` is not served
             * at all — a scanner PIN's existence is the scanner's business.
             */
            passwordSet: sql<boolean>`${staffUser.passwordHash} IS NOT NULL`,
            deactivatedAt: staffUser.deactivatedAt,
            createdAt: staffUser.createdAt,
            cursorAt: cursorInstant(staffUser.createdAt),
          })
          .from(staffUser)
          .leftJoin(salon, eq(salon.id, staffUser.salonId))
          .where(
            and(
              /**
               * The `owner` chip is a `role` predicate on the SAME table, not a
               * third stream — see `ROLE_FILTERS`. `staff` means every staff row
               * INCLUDING owners, because the design's chip above it is "Staff" and
               * a list that hid the owner from it would be a list of everyone except
               * the one person a console admin is most likely looking for.
               */
              role === 'owner' ? eq(staffUser.role, 'owner') : undefined,
              salonFilter === '' ? undefined : eq(staffUser.salonId, salonFilter),
              q === ''
                ? undefined
                : or(
                    ilike(staffUser.name, like(q)),
                    ilike(staffUser.handle, like(q)),
                    ilike(salon.name, like(q)),
                  ),
              afterCursor(cursor, STREAM_RANK.staff, staffUser.createdAt, staffUser.id),
            ),
          )
          .orderBy(desc(staffUser.createdAt), asc(staffUser.id))
          .limit(take)
      : [];

    const keyed: Keyed<AccountRow>[] = [
      ...customerRows.map<Keyed<AccountRow>>((m) => ({
        rank: STREAM_RANK.customer,
        at: m.cursorAt,
        id: m.id,
        item: {
          id: m.id,
          kind: 'customer',
          name: m.name,
          /** No such column. See the header — not invented, not the phone. */
          handle: null,
          role: 'customer',
          salonId: m.salonId,
          salon: m.salonName ?? '',
          passwordSet: m.passwordSet,
          /**
           * Erased BEFORE deletion-requested, because `member_erased_requires_request`
           * makes both true on a tombstone and only the first is the useful answer:
           * the reset door refuses an erased member 409 and issues normally inside
           * the window.
           */
          status: m.erasedAt !== null
            ? 'erased'
            : m.deletionRequestedAt !== null
              ? 'deletion_requested'
              : 'active',
          createdAt: m.createdAt.toISOString(),
        },
      })),
      ...staffRows.map<Keyed<AccountRow>>((s) => ({
        rank: STREAM_RANK.staff,
        at: s.cursorAt,
        id: s.id,
        item: {
          id: s.id,
          kind: 'staff',
          name: s.name,
          handle: s.handle,
          role: s.role,
          salonId: s.salonId,
          salon: s.salonName ?? '',
          passwordSet: s.passwordSet,
          /**
           * A DEACTIVATED STAFF MEMBER IS STILL LISTED, deliberately. The reset door
           * calls sending her a link "the re-hire path" and issues one, so hiding her
           * would hide the row whose action is the reason the row is interesting.
           */
          status: s.deactivatedAt !== null ? 'deactivated' : 'active',
          createdAt: s.createdAt.toISOString(),
        },
      })),
    ];

    /**
     * `total` IS NOT SERVED, unlike `GET /v1/platform/audit`. Counting it means two
     * more `count(*)` scans over `member` and `staff_user` with the same predicate on
     * every page, and — the part that matters — the sum of two counts is not the
     * count of the merged list under any filter that could ever make the two streams
     * overlap. The audit read totals one table. Reported rather than approximated:
     * an almost-right number on a screen is worse than no number.
     */
    return reply.send(mergePage(keyed, limit));
  });
}
