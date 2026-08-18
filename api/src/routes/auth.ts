/**
 * Authentication. One signup, three sign-ins, one refresh, one password change.
 *
 *   POST /auth/member/signup    name + phone + password + accepted policy version
 *   POST /auth/member/session   phone + password   → wallet scope
 *   POST /staff/session         4-digit PIN        → scanner scope   (staff.ts calls in)
 *   POST /auth/web/session      username + password → dashboard scope
 *   POST /auth/refresh          rotate
 *   POST /auth/sign-out         revoke this device
 *   POST /members/me/password   change + revoke every OTHER session
 *
 * WHY THE PIN IS NOT JUST A SHORT PASSWORD
 * ----------------------------------------
 * api-contract.md § StaffUser: "Staff scanner authenticates by 4-digit PIN
 * scoped to a device+salon. PIN is not a password: rate-limit it, lock after N
 * failures, and never let it reach dashboard scopes."
 *
 * Four digits is 10,000 possibilities, which is nothing. What makes it safe is
 * the three controls around it, and all three are enforced in `staffPinSession`:
 * the PIN only works from the device it was bound to, attempts are rate-limited
 * per device (so an attacker cannot rotate targets to dodge the per-account
 * counter), and the account locks after N failures. The scope on the session is
 * the fourth: a PIN mints `scanner`, and `requireDashboardScope` refuses it.
 *
 * AND THE SAME WALL IN THE OTHER DIRECTION
 * ----------------------------------------
 * Those four controls only protect anything if the scanner is the ONLY way to
 * charge. A web session is everything a PIN session is not — long-lived,
 * browser-based, not bound to a device, refreshable for thirty days — so if it
 * could reach `POST /charges`, an attacker would simply use that door and the
 * PIN's controls would be decoration. `requireScannerPerm` is the other half of
 * the wall, and the product design says the same thing plainly: "Desktop
 * dashboard = full control; staff phone = PIN + scan only."
 *
 * ENUMERATION
 * -----------
 * Every failure path answers with the same body and burns the same argon2 time,
 * whether the account exists or not. "Wrong password" and "no such phone number"
 * being distinguishable turns a login form into a customer-list oracle.
 */

import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fils } from '@avo/types';
import { db } from '../db/client';
import { member } from '../db/schema/member';
import { platformAdmin } from '../db/schema/platformAdmin';
import { salon } from '../db/schema/salon';
import { pinAttempt, session } from '../db/schema/session';
import { staffPasswordReset, staffUser } from '../db/schema/staff';
import { env } from '../env';
import {
  burnVerifyTime,
  hashSecret,
  isAcceptablePassword,
  isFourDigitPin,
  verifySecret,
} from '../auth/password';
import { permsOf, requirePrincipal } from '../auth/principal';
import {
  issueSession,
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
  rotateSession,
} from '../auth/sessions';
import { hashPasswordResetToken } from '../auth/tokens';
import { badRequest, conflict, forbidden, tooManyRequests, unauthorized } from '../http/errors';
import { parseE164 } from '../http/fields';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { isUniqueViolation, violatedConstraint } from '../services/idempotency';
import { tierForVisits } from '../services/loyalty';
import { recordPolicyAcceptance, requireCurrentPolicyVersion } from '../services/policy';
import { enforceSignupLimits, recordSignupAttempt } from '../services/signupLimit';
import { serialiseStaff } from './staff';
import { serialisePlatformAdmin } from './platformAdmins';

/** One body for every credential failure. Never says which half was wrong. */
const BAD_CREDENTIALS = () => unauthorized('Those details do not match. Try again.', 'invalid_credentials');

/**
 * Signup met a phone that already holds a wallet at this salon.
 *
 * A DISTINCT CODE FROM `phone_in_use`, which `POST /members/me/phone-change`
 * answers, because the client's next move is different: there, she picks another
 * number; here, she already has an account and belongs on the Log in screen.
 * Same code for both would make the wallet guess which sentence to show.
 *
 * The polite pre-check and the unique-violation catch BOTH raise this one
 * refusal, so a double tap and a slow retype are indistinguishable to the client
 * — which is the point, since they are indistinguishable to the customer.
 */
const ALREADY_REGISTERED = () =>
  conflict(
    'already_registered',
    'There is already an account with that number. Log in instead, or contact support.',
  );

function clientMeta(req: FastifyRequest) {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ member signup --
  /**
   * SELF-SERVE REGISTRATION — and the moment non-negotiable #10 was missing.
   *
   * #10: "The customer app holds no legal copy. It renders the published policy
   * set from the API and stamps the version. Store the accepted version against
   * the member." Both halves of the data existed — `member.policy_version` since
   * migration 0000, `legal_document_set` since 0019 — and #10 was still unmet,
   * because there was no endpoint at which a customer accepted anything. Every
   * stamped version in the database had been written by a seed script.
   *
   * The design is `Your name`, `Phone`, `Password`, a REQUIRED terms checkbox and
   * a SEPARATE WhatsApp checkbox (design/README.md:113). DECISIONS.md § "Member
   * signup" and § "Wallet sign-in identity" settle the rest; the four decisions
   * that show up as code here are:
   *
   * 1. PHONE, NOT THE USERNAME THE DESIGN DRAWS. The design contradicts itself —
   *    it draws a Username field and also says, in both languages, "Your phone
   *    number is how you log in." Every other source agrees and there is no
   *    member username column anywhere.
   *
   * 2. THE CLIENT SENDS THE VERSION IT DISPLAYED. Stamping "whatever is current"
   *    would satisfy the letter of #10 and reproduce exactly what design/README.md
   *    gap 5 forbids. See services/policy.ts.
   *
   * 3. `wa` IS REQUIRED AND AN ABSENT VALUE IS A CLIENT BUG. `notify_wa` is
   *    `NOT NULL DEFAULT true` because service channels default on — but signup
   *    puts it on screen as a checkbox she can leave unticked, so an omitted
   *    field would let the column default record the OPPOSITE of her choice.
   *    An absence read as agreement is the same defect as a stale "not built"
   *    comment; it is refused rather than defaulted.
   *
   * 4. NO MARKETING CONSENT EVENT IS WRITTEN. NOT EVEN `granted: false`. The
   *    WhatsApp checkbox is `consentWa` — "Send me receipts and appointment
   *    confirmations on WhatsApp" — which is word-for-word `nWaSub`, the SERVICE
   *    channel. Marketing is `nOffersSub`, "Occasional promotions from Amara. Off
   *    by default.", and it has no signup entry point at all. Migration 0020 is
   *    explicit that `granted = false` is a WITHDRAWAL rather than the absence of
   *    a grant, so a false row here would put a withdrawal she never made into an
   *    append-only table. Silence is the correct record of never having been
   *    asked, and services/consent.ts already reads it that way.
   *
   * A NAME IS REQUIRED, which is the one place this extends a settled decision
   * rather than following it. The design marks the name `optional` — beside a
   * REQUIRED username. Removing the username (decision 1) leaves the name as the
   * only human label on the record, and it is what the counter envelope, the
   * receipt and the staff directory render. `PATCH /members/me` already refuses a
   * blank name via `requireString`, so accepting one here would create a row its
   * own edit endpoint could not round-trip.
   *
   * UNAUTHENTICATED, AND THEREFORE AN ENUMERATION ORACLE — stated rather than
   * buried, and STILL ESCALATED. The duplicate refusal below confirms that a
   * number is registered at this salon. Any signup form that hands back a session
   * confirms that, because it must refuse the second registration and cannot
   * pretend to have succeeded. Bounding it needs a verification step at signup
   * (the shape the phone-change challenge already uses) and that is a product
   * decision, not one to invent here.
   *
   * THE OTHER HALF OF THAT PARAGRAPH IS NOW FIXED, AND THEY WERE NOT THE SAME
   * QUESTION. It used to read "There is also NO RATE LIMIT on this route: argon2
   * is deliberately expensive, so an unauthenticated hashing endpoint is a cheap
   * denial of service. Both are escalated, not fixed quietly." Escalating them
   * together was the mistake: what a customer is asked to prove about her phone
   * number is a product decision, and an unbounded expensive endpoint is not one.
   * `services/signupLimit.ts` bounds the cost, in the shape of the directory-read
   * limiter — one query, two windows, ceiling first, counted before anything
   * expensive runs.
   *
   * AND THE LIMITER DOES NOT CLOSE THE ORACLE. Worth saying at the call site,
   * because it looks as though it should: at 20 attempts per five minutes a probe
   * still walks about 100 numbers an hour from one address, and the answer for
   * each is definitive. Nothing keyed on the caller bounds a distributed probe
   * either. What is bounded is the CPU.
   */
  app.post('/auth/member/signup', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    /**
     * FIRST, AND BEFORE THE BODY IS EVEN VALIDATED PAST THIS POINT.
     *
     * The order is the control. Every line below this one either reads the
     * database or hashes a password, and both are what a flood is trying to buy;
     * a refused caller pays for one indexed count and learns nothing about which
     * numbers are registered, because it never reaches the duplicate check.
     */
    const ipAddress = req.ip ?? null;
    await enforceSignupLimits(db, ipAddress);

    const salonId = requireString(body.salonId, 'salonId', 100);
    const name = requireString(body.name, 'name', 120);
    const phone = parseE164(body.phone);
    const password = body.password;

    if (!isAcceptablePassword(password)) {
      throw badRequest('password_too_short', 'Your new password needs at least 6 characters.');
    }

    /**
     * Decision 3, and it is a refusal rather than a default on purpose. `'wa' in
     * body` is not enough — `{ wa: null }` and `{ wa: 'false' }` would both slip
     * through a presence check and then be read as truthy or coerced.
     */
    if (typeof body.wa !== 'boolean') {
      throw badRequest(
        'wa_preference_required',
        'Send the WhatsApp preference as true or false. Leaving it out would turn it on.',
      );
    }
    const wa = body.wa;

    // Decision 2. Throws `policy_version_stale` (409) when a publish landed
    // between the screen rendering and this request — a renderable client state.
    const policySet = await requireCurrentPolicyVersion(db, body.policyVersion);

    /**
     * The salon decides the loyalty mode, so a new member's starting row differs:
     * a tiers salon puts her on the ladder's floor, a stamps salon on an empty
     * card. Getting this wrong is not cosmetic — `services/topup.ts` prices the
     * bonus from `member.tier`, and a null tier in a tiers salon silently pays 0.
     */
    const [s] = await db
      .select({ loyaltyMode: salon.loyaltyMode, tiers: salon.tiers })
      .from(salon)
      .where(eq(salon.id, salonId))
      .limit(1);
    if (!s) {
      // Not a 500 from the foreign key. A white-label build pointed at a salon
      // that does not exist is a deployment mistake with a readable cause.
      throw badRequest('unknown_salon', 'This app is not set up for a salon yet.');
    }

    /**
     * RECORDED BEFORE THE DUPLICATE CHECK, AND THAT MOVE IS THE FIX.
     *
     * It used to sit BELOW the check, with a comment explaining that "the row
     * marks an attempt that really is about to cost an argon2 hash — the thing
     * being rationed". That reasoning is sound about CPU and it made the
     * limiter's OTHER documented claim false, in the dangerous direction.
     *
     * `services/signupLimit.ts` said an attacker "still walks roughly 100 numbers
     * an hour per address". Lane D measured it: forty consecutive probes against
     * REGISTERED numbers from one address all answered `409 already_registered`
     * and left `signup_attempt` EMPTY — because every one of them was refused two
     * lines above the recorder. The enumeration oracle was not bounded at 100 an
     * hour. It was not bounded at all, and the docstring said otherwise.
     *
     * So the attempt is counted before the probe is answered. A refusal is an
     * attempt: it consumed the endpoint and it learned something.
     *
     * WHAT THIS COSTS, said out loud. One counter now bounds two different things,
     * so twenty probes from an address exhaust that address's signup budget for
     * five minutes — intended for an attacker, and a real cost on a shared address
     * such as a salon's wifi where staff help customers sign up. That is the
     * accepted tradeoff of an IP-keyed limiter and it is exactly why `TRUST_PROXY`
     * must name the real proxy: behind an untrusted one every caller already shares
     * a single bucket, which is strictly worse than this.
     *
     * The CPU claim is UNCHANGED. argon2 still runs only on the path past the
     * duplicate check, so a probe costs a count and a SELECT and no hash.
     *
     * Still outside the transaction below, because a row written inside it would be
     * rolled back by every FAILED signup — which is the traffic being bounded. And
     * still before the hash, so a burst cannot all pass the count and all pay for a
     * hash before any of them is visible to the next.
     *
     * WHAT IS STILL ESCALATED, AND THIS DOES NOT CLOSE IT: the oracle itself.
     * `already_registered` still confirms that a number holds a wallet here. It is
     * now RATIONED rather than free, which is what the docstring always claimed;
     * closing it needs a verification step at signup, which is migration 0026's
     * deliberate escalation and a product decision.
     */
    await recordSignupAttempt(db, { salonId, ipAddress });

    /**
     * The friendly half of the duplicate check. The database is still the
     * authority — see the catch below — because two taps race past any SELECT.
     */
    const existing = await db
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.salonId, salonId), eq(member.phone, phone)))
      .limit(1);
    if (existing[0]) throw ALREADY_REGISTERED();

    const passwordHash = await hashSecret(password);

    const tiersMode = s.loyaltyMode === 'tiers';

    try {
      const created = await db.transaction(async (tx) => {
        /**
         * ONE TRANSACTION FOR THE MEMBER AND HER ACCEPTANCE. A member created
         * without the evidence is #10 unmet again with a row to prove it, and an
         * acceptance for a member who does not exist is a dangling fact in an
         * append-only table. Neither is recoverable afterwards, so they commit
         * together or not at all.
         */
        const [m] = await tx
          .insert(member)
          .values({
            /**
             * The customer-facing member number, from the sequence migration 0025
             * adds. `Math.random()` over four digits — the way `SUP-` and `CMP-`
             * ids are minted — collides on a PRIMARY KEY within a few thousand
             * members, and the collision surfaces as a stranger's signup failing.
             *
             * A sequence is not rolled back by a failed transaction, so a refused
             * signup burns a number. That is the correct trade: gaps in a member
             * number are invisible, a duplicate is a 500.
             */
            id: sql`nextval('member_number_seq')::text`,
            salonId,
            name,
            phone,
            email: null,
            emailVerified: false,
            passwordHash,
            // Non-negotiable #2 and #1: the server owns the balance, in fils.
            balanceFils: fils(0),
            visits: 0,
            tier: tiersMode ? tierForVisits(s.tiers ?? [], 0) : null,
            stamps: tiersMode ? null : 0,
            // #10: the version SHE was shown, validated above.
            policyVersion: policySet.version,
            /**
             * EXPLICIT, and the reason this line exists at all. Omitting it lets
             * `NOT NULL DEFAULT true` record the opposite of an unticked box.
             */
            notifyWa: wa,
            /**
             * `push`, `remind` and `receipt` are NOT on the signup screen, so the
             * documented default applies to them and nothing here is inferred
             * from silence about a question she was asked. All three are on
             * Account → Notifications with a switch each.
             */
          })
          .returning();
        if (!m) throw new Error('signup insert returned no row');

        await recordPolicyAcceptance(tx, {
          memberId: m.id,
          salonId: m.salonId,
          policyVersion: policySet.version,
          source: 'signup',
          ...clientMeta(req),
        });

        await writeAudit(tx, null, {
          salonId: m.salonId,
          kind: 'access',
          action: 'Member signed up',
          detail: `${m.name} created a wallet · accepted policy v${policySet.version}`,
          source: 'wallet',
          subjectType: 'member',
          subjectId: m.id,
          /**
           * The actor is `null` — the System actor — because she had no principal
           * when this row was written. The subject columns carry who it is about,
           * which is the question asked of a signup.
           */
          metadata: { policyVersion: policySet.version, notifyWa: wa, loyaltyMode: s.loyaltyMode },
          ...clientMeta(req),
        });

        return m;
      });

      const issued = await issueSession(db, {
        principalKind: 'member',
        memberId: created.id,
        salonId: created.salonId,
        scope: 'wallet',
        deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
        ...clientMeta(req),
      });

      /**
       * 201, and `serialiseMember` — never the password, never the hash
       * (non-negotiable #6). The session is issued because the design goes
       * straight from Create account into the wallet.
       */
      return reply.code(201).send({
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresAt: issued.expiresAt.toISOString(),
        member: serialiseMember(created),
      });
    } catch (err) {
      /**
       * THE DOUBLE TAP. `member_salon_phone_uq` is the guard the SELECT above
       * cannot be: two requests both find nothing, both insert, and exactly one
       * commits. The loser gets the same refusal as the polite path, so a client
       * has one state to render either way.
       *
       * Named, not blanket. Every other unique violation is a bug and must keep
       * its 500 — treating all of them as "already registered" is the defect
       * `violatedConstraint` exists to prevent.
       */
      if (violatedConstraint(err) === 'member_salon_phone_uq') throw ALREADY_REGISTERED();
      if (isUniqueViolation(err)) req.log.error({ err }, 'unexpected unique violation on signup');
      throw err;
    }
  });

  // ------------------------------------------------------------ member sign-in --
  app.post('/auth/member/session', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    /**
     * The salon is part of the identity, not a convenience.
     *
     * `member_salon_phone_uq` is on (salon_id, phone), because api-contract.md
     * § Branch means one wallet per salon and the schema comment spells it out:
     * "the same person can hold a wallet at two salons". So a phone number does
     * NOT identify a member — looking one up by phone alone returns an arbitrary
     * row among the salons she belongs to, which is both a wrong-wallet bug and,
     * if the hashes differ, a way to authenticate against the wrong record.
     *
     * Each salon ships its own white-labelled wallet, so the client always knows
     * which salon it is.
     */
    const salonId = requireString(body.salonId, 'salonId', 100);
    const phone = requireString(body.phone, 'phone', 20);
    const password = typeof body.password === 'string' ? body.password : '';

    const rows = await db
      .select()
      .from(member)
      .where(and(eq(member.salonId, salonId), eq(member.phone, phone)))
      .limit(1);
    const m = rows[0];

    if (!m) {
      // Same cost as a real verify, so the timing does not reveal the miss.
      await burnVerifyTime(password);
      throw BAD_CREDENTIALS();
    }
    if (!(await verifySecret(m.passwordHash, password))) throw BAD_CREDENTIALS();

    const issued = await issueSession(db, {
      principalKind: 'member',
      memberId: m.id,
      salonId: m.salonId,
      scope: 'wallet',
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
      ...clientMeta(req),
    });

    return reply.send({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt.toISOString(),
      member: serialiseMember(m),
    });
  });

  // --------------------------------------------------------------- web sign-in --
  /**
   * Merchant dashboard. Username + password, and it mints `dashboard` scope —
   * the only way to reach a dashboard endpoint.
   */
  app.post('/auth/web/session', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    /**
     * Salon-scoped for the same reason as the member sign-in above:
     * `staff_user_salon_handle_uq` is on (salon_id, handle), so "noura" is not a
     * unique person. In deployment this comes from the per-salon subdomain the
     * dashboard is served on rather than from a field the user types.
     */
    const salonId = requireString(body.salonId, 'salonId', 100);
    const username = requireString(body.username, 'username', 100).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';

    const rows = await db
      .select()
      .from(staffUser)
      .where(and(eq(staffUser.salonId, salonId), eq(staffUser.handle, username)))
      .limit(1);
    const staff = rows[0];

    if (!staff || !staff.passwordHash) {
      await burnVerifyTime(password);
      throw BAD_CREDENTIALS();
    }
    if (!(await verifySecret(staff.passwordHash, password))) throw BAD_CREDENTIALS();

    const issued = await issueSession(db, {
      principalKind: 'staff',
      staffId: staff.id,
      salonId: staff.salonId,
      scope: 'dashboard',
      deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
      ...clientMeta(req),
    });

    /**
     * THE ACTOR IS HER, AND IT WAS `null`.
     *
     * `writeAudit(db, null, …)` resolves through `actorOf(null)` to
     * `System / Automatic`, so the audit log's Who column — and every actor
     * filter over it — could not answer "who signed in", on a row written one
     * statement after her password was verified. Her name survived only inside
     * the free-text `detail`, which is not filterable and not the column the
     * dashboard renders. Non-negotiable #7's trail was weaker than it looked.
     * Found by lane C, routed through trunk.
     *
     * There is no session-backed principal to pass here — the session was minted
     * three lines up and the request itself is anonymous — so this is the actor
     * SNAPSHOT case: identity established by a verified credential rather than by
     * a bearer token. See services/audit.ts § AuditActorSnapshot.
     */
    await writeAudit(db, { kind: 'staff', id: staff.id, name: staff.name, role: staff.role }, {
      salonId: staff.salonId,
      kind: 'access',
      action: 'Web sign-in',
      detail: `${staff.name} signed in to the dashboard`,
      source: 'merchant',
      subjectType: 'staff_user',
      subjectId: staff.id,
      ...clientMeta(req),
    });

    return reply.send({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt.toISOString(),
      staff: serialiseStaff(staff),
    });
  });

  // ------------------------------------------------------------------ refresh --
  // ------------------------------------------------------- platform sign-in --
  /**
   * `POST /auth/platform/session` — the owner console's front door, and the
   * endpoint whose absence blocked all of phase 7.
   *
   * NO WORKSPACE FIELD, unlike `POST /auth/web/session`. That one takes a
   * `salonId` because `staff_user_salon_handle_uq` is on `(salon_id, handle)`, so
   * "noura" is not a unique person — a visible departure from the drawn design and
   * DECISIONS.md queue item 7. There is exactly one platform, so
   * `platform_admin_handle_uq` is global and there is exactly one "yousef". The
   * console's sign-in screen therefore matches `AVO Login.dc.html` 5b as drawn.
   *
   * THE SESSION CARRIES NO SALON, and the database says so as an equivalence
   * (`session_salon_matches_principal`). This is the one credential that reads
   * across salons by design; one carrying a salon id would be a merchant with
   * extra authority.
   *
   * ENUMERATION, same as everywhere else in this file: every failure path answers
   * the same body and burns the same argon2 time, whether the handle exists or
   * not. The console's admin list is short and its members are named people, so a
   * distinguishable "no such user" is a list of AVO's staff.
   *
   * A DEACTIVATED ADMIN CANNOT SIGN IN, and it is checked with the same silence.
   * `loadPlatformPrincipal` also refuses her on every subsequent request, so
   * deactivating somebody who is already signed in takes effect on her next call
   * rather than at her next token refresh — the reason permissions are read per
   * request and not put in the token.
   */
  app.post('/auth/platform/session', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // `@yousef` and `yousef` are the same person. The column is lowercase without
    // the '@' by CHECK, so the boundary strips what the console renders.
    const handle = requireString(body.username, 'username', 100)
      .toLowerCase()
      .replace(/^@/, '');
    const password = typeof body.password === 'string' ? body.password : '';

    const rows = await db
      .select()
      .from(platformAdmin)
      .where(eq(platformAdmin.handle, handle))
      .limit(1);
    const admin = rows[0];

    if (!admin || !admin.passwordHash || !admin.active) {
      await burnVerifyTime(password);
      throw BAD_CREDENTIALS();
    }
    if (!(await verifySecret(admin.passwordHash, password))) throw BAD_CREDENTIALS();

    const issued = await issueSession(db, {
      principalKind: 'platform_admin',
      platformAdminId: admin.id,
      // NULL, and required to be. See the header.
      salonId: null,
      scope: 'platform',
      ...clientMeta(req),
    });

    /**
     * `salonId: null` on the audit row, which `audit_log` allows — its own header
     * calls a null salon "platform-wide". This is the first write path that
     * produces `actor_kind = 'platform_admin'`; the enum has carried the value
     * since migration 0001 and nothing could emit it.
     */
    await writeAudit(
      db,
      { kind: 'platform_admin', id: admin.id, name: admin.name, role: admin.role },
      {
        salonId: null,
        kind: 'access',
        action: 'Console sign-in',
        detail: `${admin.name} signed in to the owner console`,
        source: 'owner_console',
        subjectType: 'platform_admin',
        subjectId: admin.id,
        ...clientMeta(req),
      },
    );

    return reply.send({
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresAt: issued.expiresAt.toISOString(),
      admin: serialisePlatformAdmin(admin),
    });
  });

  app.post('/auth/refresh', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = requireString(body.refreshToken, 'refreshToken', 500);

    const rotated = await rotateSession(db, raw);
    // Null covers all of: unknown, already rotated, revoked, expired. A replayed
    // refresh token is indistinguishable from a stolen one, so it just fails.
    if (!rotated) throw unauthorized('That session has ended. Sign in again.', 'session_ended');

    return reply.send({
      accessToken: rotated.accessToken,
      refreshToken: rotated.refreshToken,
      expiresAt: rotated.expiresAt.toISOString(),
    });
  });

  // ----------------------------------------------------------------- sign-out --
  app.post('/auth/sign-out', async (req, reply) => {
    const p = requirePrincipal(req);
    await revokeSession(db, p.sessionId, 'sign_out');
    return reply.code(204).send();
  });

  // ------------------------------------------------- staff reset, redeemed --
  /**
   * The far end of the reset LINK — non-negotiable #6's other half.
   *
   * `POST /staff/{id}/password-reset` mints the token and answers 202 without
   * it; the staff member arrives here holding it. UNAUTHENTICATED by necessity:
   * the whole point is that she cannot sign in. The token is the credential,
   * which is why it is 32 bytes of CSPRNG, single-use, and dead in an hour.
   *
   * EVERY FAILURE IS THE SAME REFUSAL. Unknown, expired, already spent, or
   * belonging to an account that has since been deactivated all answer
   * `invalid_reset_token`. Distinguishing them would let someone with a stale
   * link learn whether an account still exists, and there is nothing the
   * legitimate holder can do differently in any of the four cases anyway —
   * she asks for another link.
   *
   * On success every session for that staff member is revoked. She is setting
   * this password because she lost the old one, and "lost" and "somebody else
   * has it" are the same event until proven otherwise.
   */
  app.post('/auth/staff/password-reset', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = requireString(body.token, 'token', 500);
    const password = body.password;

    if (!isAcceptablePassword(password)) {
      throw badRequest('password_too_short', 'Your new password needs at least 6 characters.');
    }

    const REFUSED = () =>
      badRequest(
        'invalid_reset_token',
        'That reset link has expired or has already been used. Ask a manager to send a new one.',
      );

    const rows = await db
      .select()
      .from(staffPasswordReset)
      .where(eq(staffPasswordReset.tokenHash, hashPasswordResetToken(token)))
      .limit(1);
    const reset = rows[0];
    if (!reset || reset.usedAt || reset.expiresAt.getTime() <= Date.now()) throw REFUSED();

    const staffRows = await db
      .select()
      .from(staffUser)
      .where(eq(staffUser.id, reset.staffId))
      .limit(1);
    const staff = staffRows[0];
    if (!staff) throw REFUSED();

    /**
     * A DEACTIVATED ACCOUNT IS RE-ACTIVATED HERE, not refused.
     *
     * `POST /staff/{id}/password-reset` issues a link against a leaver on
     * purpose — that is the re-hire path, and it is what keeps her history on
     * one identity instead of forking it across a second row. The link is only
     * an invitation until this point; accepting it is what makes her staff
     * again.
     *
     * It has to happen in the SAME UPDATE that sets the password, because
     * `staff_user_deactivated_holds_no_credential` refuses a row that is
     * deactivated and holds a credential. The constraint is not in the way here
     * — it is the reason the two facts cannot drift apart.
     *
     * Her permissions are whatever they were at departure; they are on the row,
     * and the roster shows them. Re-hiring somebody is not the moment to
     * silently reset her authority to nothing, and it is not the moment to
     * silently widen it either.
     */
    const reactivating = staff.deactivatedAt !== null;

    const passwordHash = await hashSecret(password);

    /**
     * The UPDATE carries the `used_at IS NULL` predicate rather than trusting
     * the SELECT above. Two redemptions of one link racing each other is the
     * double-tapped scanner in another costume, and the database resolves it:
     * exactly one of them updates a row, and the loser is refused.
     */
    const spent = await db
      .update(staffPasswordReset)
      .set({ usedAt: new Date() })
      .where(and(eq(staffPasswordReset.id, reset.id), isNull(staffPasswordReset.usedAt)))
      .returning({ id: staffPasswordReset.id });
    if (spent.length === 0) throw REFUSED();

    await db
      .update(staffUser)
      .set({
        passwordHash,
        // Both facts in one statement. See the note above.
        ...(reactivating ? { deactivatedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(staffUser.id, staff.id));

    // She lost the old password. Treat that as a compromise until told
    // otherwise — the same instinct as `revokeOtherSessions` on a change,
    // except there is no calling device here worth keeping.
    await revokeAllSessions(db, { kind: 'staff', id: staff.id }, 'password_reset');

    /**
     * Her too, and for the same reason. The caller holds a single-use reset token
     * bound to this account, which identifies her as surely as a password does —
     * it is what `revokeAllSessions` two lines up is acting on. `System` would
     * claim AVO changed her password.
     */
    await writeAudit(db, { kind: 'staff', id: staff.id, name: staff.name, role: staff.role }, {
      salonId: staff.salonId,
      kind: 'access',
      action: reactivating ? 'Account re-activated from reset link' : 'Password set from reset link',
      detail:
        `${staff.name} (@${staff.handle}) set a new password` +
        (reactivating ? ' and is active again' : ''),
      source: 'merchant',
      subjectType: 'staff_user',
      subjectId: staff.id,
      metadata: { requestedBy: reset.requestedBy, reactivated: reactivating },
      ...clientMeta(req),
    });

    // 204: no body, so no body to leak a credential in. She signs in normally.
    return reply.code(204).send();
  });

  // ---------------------------------------------------------- password change --
  /**
   * api-contract.md § Profile edit rule 4: requires `current`, minimum length 6,
   * rejects `next === current`, and "revokes every other session while keeping
   * the calling device signed in".
   */
  app.post('/members/me/password', async (req, reply) => {
    const p = requirePrincipal(req);
    if (p.kind !== 'member') throw forbidden('This endpoint is for customers.');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = typeof body.current === 'string' ? body.current : '';
    const next = body.next;

    if (!isAcceptablePassword(next)) {
      throw badRequest('password_too_short', 'Your new password needs at least 6 characters.');
    }
    if (next === current) {
      throw badRequest('password_unchanged', 'Your new password must be different.');
    }

    const rows = await db.select().from(member).where(eq(member.id, p.id)).limit(1);
    const m = rows[0];
    if (!m) throw unauthorized();

    // "Forgot my current password" is the reset-link flow, not a bypass of this.
    if (!(await verifySecret(m.passwordHash, current))) {
      throw unauthorized('That password does not match.', 'invalid_credentials');
    }

    const passwordHash = await hashSecret(next);
    await db
      .update(member)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(member.id, m.id));

    // The security half — every other device drops. The caller stays signed in,
    // which is why this is a per-row revoke and not a watermark on the account.
    const revoked = await revokeOtherSessions(
      db,
      { kind: 'member', id: m.id },
      p.sessionId,
      'password_change',
    );

    await writeAudit(db, p, {
      salonId: m.salonId,
      kind: 'access',
      action: 'Password changed',
      detail: `${revoked} other session(s) signed out`,
      source: 'wallet',
      subjectType: 'member',
      subjectId: m.id,
      metadata: { revokedSessions: revoked },
      ...clientMeta(req),
    });

    // Never returns a password field, and 204 means there is no body to leak one in.
    return reply.code(204).send();
  });
}

// ----------------------------------------------------------------- PIN session --

/**
 * The staff PIN sign-in. Exported because `POST /staff/session` lives in
 * staff.ts, but the credential logic belongs next to the other credentials.
 *
 * Order of checks is deliberate: device rate limit, then account lockout, then
 * the PIN itself. The cheap global checks come first so a flood cannot make the
 * expensive argon2 path the denial-of-service.
 */
export async function staffPinSession(req: FastifyRequest): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  staff: ReturnType<typeof serialiseStaff>;
}> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const salonId = requireString(body.salonId, 'salonId', 100);
  const deviceId = requireString(body.deviceId, 'deviceId', 200);
  const handle = requireString(body.handle, 'handle', 100).toLowerCase();
  const pin = body.pin;

  if (!isFourDigitPin(pin)) {
    throw badRequest('invalid_pin_format', 'A PIN is four digits.');
  }

  // ------------------------------------------------- 1. device rate limit --
  // Per device+salon, whoever is being targeted. Without this an attacker walks
  // the PIN space by rotating handles, and every individual account counter
  // stays comfortably below its lockout threshold.
  const windowStart = new Date(Date.now() - env.pinDeviceWindowMinutes * 60_000);
  const recent = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pinAttempt)
    .where(
      and(
        eq(pinAttempt.salonId, salonId),
        eq(pinAttempt.deviceId, deviceId),
        eq(pinAttempt.succeeded, false),
        gte(pinAttempt.createdAt, windowStart),
      ),
    );

  if ((recent[0]?.n ?? 0) >= env.pinDeviceAttemptsPerWindow) {
    throw tooManyRequests(
      'too_many_attempts',
      'Too many attempts from this device. Wait a few minutes and try again.',
    );
  }

  const rows = await db
    .select()
    .from(staffUser)
    .where(and(eq(staffUser.salonId, salonId), eq(staffUser.handle, handle)))
    .limit(1);
  const staff = rows[0];

  const recordAttempt = async (staffId: string | null, succeeded: boolean) => {
    await db.insert(pinAttempt).values({ salonId, deviceId, staffId, succeeded });
  };

  if (!staff) {
    await recordAttempt(null, false);
    await burnVerifyTime(String(pin));
    throw BAD_CREDENTIALS();
  }

  // --------------------------------------------------- 2. account lockout --
  if (staff.pinLockedUntil && staff.pinLockedUntil.getTime() > Date.now()) {
    await recordAttempt(staff.id, false);
    throw tooManyRequests(
      'pin_locked',
      'This PIN is locked. A manager can unlock it, or try again later.',
    );
  }

  // ------------------------------------------------- 3. device scoping ----
  // The PIN is bound to a device. api-contract.md calls it "scoped to a
  // device+salon", and the schema CHECK refuses a pin_hash without a device id.
  if (!staff.pinHash || !staff.pinDeviceId) {
    await recordAttempt(staff.id, false);
    await burnVerifyTime(String(pin));
    throw BAD_CREDENTIALS();
  }
  if (staff.pinDeviceId !== deviceId) {
    await recordAttempt(staff.id, false);
    await burnVerifyTime(String(pin));
    // Deliberately the same refusal — "right PIN, wrong device" would confirm
    // the PIN to someone holding a stolen tablet.
    throw BAD_CREDENTIALS();
  }

  // ----------------------------------------------------- 4. the PIN itself --
  if (!(await verifySecret(staff.pinHash, pin))) {
    const attempts = staff.pinFailedAttempts + 1;
    const locked = attempts >= env.pinMaxAttempts;

    await db
      .update(staffUser)
      .set({
        pinFailedAttempts: attempts,
        pinLockedUntil: locked ? new Date(Date.now() + env.pinLockoutMinutes * 60_000) : null,
        updatedAt: new Date(),
      })
      .where(eq(staffUser.id, staff.id));
    await recordAttempt(staff.id, false);

    if (locked) {
      /**
       * `null` HERE IS CORRECT AND IS NOT THE SAME DEFECT as the two above.
       *
       * Five failed PINs establish that somebody tried, not who. Attributing the
       * lockout to the account holder would put "Hessa M. locked her own PIN" in
       * a `risk` row whose likeliest reader is somebody asking whether it was her
       * at all. She is the SUBJECT — `subjectType: 'staff_user'` — and the system
       * is the actor. Left as it is, deliberately, and said so here because the
       * two fixes above make this line look like a third instance of the same
       * omission.
       */
      await writeAudit(db, null, {
        salonId,
        kind: 'risk',
        action: 'PIN locked',
        detail: `${staff.name}'s PIN locked after ${attempts} failed attempts`,
        source: 'scanner',
        subjectType: 'staff_user',
        subjectId: staff.id,
        metadata: { deviceId, attempts },
      });
      throw tooManyRequests(
        'pin_locked',
        'This PIN is locked. A manager can unlock it, or try again later.',
      );
    }
    throw BAD_CREDENTIALS();
  }

  // Success clears the counter.
  await db
    .update(staffUser)
    .set({ pinFailedAttempts: 0, pinLockedUntil: null, updatedAt: new Date() })
    .where(eq(staffUser.id, staff.id));
  await recordAttempt(staff.id, true);

  // `scanner` scope, never `dashboard`. This is the line that makes "never let
  // it reach dashboard scopes" a property of the credential.
  const issued = await issueSession(db, {
    principalKind: 'staff',
    staffId: staff.id,
    salonId: staff.salonId,
    scope: 'scanner',
    deviceId,
    ...clientMeta(req),
  });

  return {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    expiresAt: issued.expiresAt.toISOString(),
    staff: serialiseStaff(staff),
  };
}

// --------------------------------------------------------------- serialisers --

/**
 * The wire shape of a member. Explicitly typed rather than inferred, so that
 * `passwordHash` cannot reappear by accident: adding a column to the table would
 * silently widen an inferred return type, and this is the serialiser that stands
 * between the password column and the network (non-negotiable #6).
 */
export interface MemberView {
  id: string;
  salonId: string;
  name: string;
  phone: string;
  email: string | null;
  emailVerified: boolean;
  balanceFils: number;
  visits: number;
  tier: 'bronze' | 'silver' | 'gold' | 'black' | null;
  stamps: number | null;
  policyVersion: number;
  joinedAt: string;
}

export function serialiseMember(m: typeof member.$inferSelect): MemberView {
  return {
    id: m.id,
    salonId: m.salonId,
    name: m.name,
    phone: m.phone,
    email: m.email,
    emailVerified: m.emailVerified,
    balanceFils: m.balanceFils,
    visits: m.visits,
    tier: m.tier,
    stamps: m.stamps,
    policyVersion: m.policyVersion,
    joinedAt: m.joinedAt.toISOString(),
  };
}

export { permsOf, session };
