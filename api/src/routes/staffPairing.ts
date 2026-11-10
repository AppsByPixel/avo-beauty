/**
 * PAIRING A PHONE TO ONE STAFF MEMBER — the missing door to the scanner.
 *
 *   POST /staff/{staffId}/pairing-code   perms.team (+ perms.dashboard with a branch)
 *   POST /staff/pair                     unauthenticated, rationed, single-use
 *
 * Aftab, 2026-11-10 (DECISIONS.md § Staff phone pairing, phone sign-in, and a
 * truthful receipt line). The contract is `packages/types` § staff pairing; the
 * schema is migration 0073.
 *
 * =========================================================================
 * WHY IT WAS NEEDED
 * =========================================================================
 * Nothing in the product set a staff PIN or bound one to a phone. Only
 * `db/seed.ts` wrote `pin_hash`, so every staff account created in the dashboard
 * — and every owner of an onboarded salon — could never sign into the scanner.
 * The scanner's "Set up this device" form asked for a salon id, a handle and a
 * device id typed by hand, and then for a PIN nobody had ever set.
 *
 * =========================================================================
 * THE SHAPE, AND NON-NEGOTIABLE #6
 * =========================================================================
 * A manager issues a code from Accounts. The phone redeems it ONCE — by scanning
 * the QR (the token) or by typing the staff member's mobile number and six
 * digits — and in the same request the staff member chooses her own PIN ON THE
 * PHONE. The server issues the device id. So the PIN is never typed into the
 * dashboard, never sits in a QR, and is stored only as a hash bound to a device
 * the server named: "Staff PINs are hashed, rate limited, device-scoped, locked
 * after N failures" holds, and device-scoped now means something, because the
 * device id is no longer a string the client chose.
 *
 * A mobile number alone is never enough. It is not a secret.
 *
 * =========================================================================
 * ENUMERATION
 * =========================================================================
 * `POST /staff/pair` is unauthenticated and answers ONE refusal for every cause
 * — unknown, used, expired or voided token; wrong digits; unknown phone;
 * deactivated staff — `400 pairing_refused` with one sentence. And the miss paths
 * cost the same: the chosen PIN is hashed on EVERY request before anything is
 * looked up, and the phone path verifies against a FIXED number of code hashes
 * (real ones for the live codes found, `burnVerifyTime` for the rest), so the
 * wall time does not say whether the number belongs to anybody. Same property
 * `routes/auth.ts`'s header states for the sign-ins, kept here.
 *
 * THE RESIDUAL CHANNEL, stated rather than denied, as the member reset request
 * states its own: a wrong guess at a number that HAS a live code also runs an
 * UPDATE that changes a row (the strike count), where a miss runs the same
 * UPDATE and changes none; and the fifth strike writes one audit row. Both are a
 * database round trip against four argon2 verifies, behind a budget of ten
 * attempts per number per quarter-hour (services/pairLimit.ts) — not a
 * measurement platform.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { STAFF_PAIRING_TTL_MINUTES } from '@avo/types';
import { db } from '../db/client';
import { deviceEnrolment } from '../db/schema/deviceEnrolment';
import { branch } from '../db/schema/salon';
import { staffPairingCode, staffUser } from '../db/schema/staff';
import { burnVerifyTime, hashSecret, isFourDigitPin, verifySecret } from '../auth/password';
import { requireDashboardPerm, requirePerm } from '../auth/principal';
import { issueSession, revokeSessionsOfScope } from '../auth/sessions';
import {
  hashPairingToken,
  isServerIssuedDeviceId,
  mintPairedDeviceId,
  mintPairingDigits,
  mintPairingToken,
} from '../auth/tokens';
import { badRequest, conflict, notFound } from '../http/errors';
import { normaliseStaffPhone } from '../http/fields';
import { requireString } from '../money/validate';
import { writeAudit } from '../services/audit';
import { chargePairBudget } from '../services/pairLimit';
import { serialiseStaff } from './staff';

/**
 * THE one refusal for every way a redeem can fail. The `error` string is the
 * contract the scanner switches on; the sentence is the one it shows.
 */
export const PAIRING_REFUSED_CODE = 'pairing_refused';
export const PAIRING_REFUSED_MESSAGE = 'That code did not work. Ask a manager for a new one.';
const PAIRING_REFUSED = () => badRequest(PAIRING_REFUSED_CODE, PAIRING_REFUSED_MESSAGE);

/**
 * Five wrong sets of digits against one code VOID it. With a million codes and a
 * ten-minute life that is a one-in-200,000 chance per issued code, before the
 * per-phone and per-address budgets bound how many codes a caller can reach.
 * Counted under a row lock (see the redeem), so a burst cannot overshoot.
 */
export const PAIRING_MAX_WRONG_DIGITS = 5;

/**
 * THE BOUND on live codes considered for one mobile number, and the number of
 * argon2 verifies EVERY phone-path request pays, whatever it finds.
 *
 * `staff_user_salon_active_phone_uq` is per salon, so one person can be active
 * staff at more than one salon and hold a live code at each; the redeem carries
 * no salon to choose by. Each staff row holds at most one live code
 * (`staff_pairing_code_live_uq`), so this is "salons at once", and three is
 * ample. The constant-cost loop is `MAX_WALLETS_PER_PHONE`'s argument in
 * routes/auth.ts, for the same reason: verifying once per code FOUND would make
 * a number with codes measurably slower than a number without.
 */
export const PAIRING_MAX_CODES_PER_PHONE = 3;

/** A live code joined to the staff member it pairs. */
interface PairingCandidate {
  code: typeof staffPairingCode.$inferSelect;
  staff: typeof staffUser.$inferSelect;
}

function clientMeta(req: FastifyRequest): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: req.ip ?? null,
    userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
  };
}

/**
 * The live-code predicate, in one place: unspent, unexpired, for an ACTIVE staff
 * member, and — if the code enrols a till — at a branch that is still open. A
 * branch closed since the code was issued makes the code dead rather than
 * pairing the phone somewhere that refuses every charge (`devices.ts` § enrol
 * refuses closed branches for the same reason).
 *
 * `now()` is the transaction's clock, which is the clock the claim's own guard
 * reads; the two cannot disagree about whether a code expired mid-request.
 */
const liveCode = () =>
  and(
    isNull(staffPairingCode.usedAt),
    isNull(staffPairingCode.voidedAt),
    gt(staffPairingCode.expiresAt, sql`now()`),
    isNull(staffUser.deactivatedAt),
    or(
      isNull(staffPairingCode.branchId),
      sql`EXISTS (SELECT 1 FROM branch b
                   WHERE b.id = ${staffPairingCode.branchId}
                     AND b.salon_id = ${staffPairingCode.salonId}
                     AND b.closed_at IS NULL)`,
    ),
  );

export async function registerStaffPairingRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------ issue a code --
  /**
   * perms.team — the authority that manages who works here, which is the
   * authority `PATCH /staff/{id}` checks: the target must be in the caller's
   * salon (404 otherwise, the same for "not here" and "not yours"), and nothing
   * narrower. Self is allowed, and is the primary case: an owner pairing her own
   * phone is the door that onboarded owners never had.
   *
   * WITH `branchId`, ALSO perms.dashboard. The code then enrols the paired phone
   * as a till at that branch, which is what `POST /salons/{id}/devices` does and
   * that endpoint's gate (routes/devices.ts § THE GATE argues why it is
   * `dashboard`). A manager who could not enrol a till directly must not be able
   * to do it by pairing one. Both permissions are checked before any row is read.
   *
   * REFUSED FOR A DEACTIVATED TARGET with `409 staff_deactivated`. A leaver holds
   * no credential (`staff_user_deactivated_holds_no_credential`), and re-hire is
   * the reset-link path, which re-activates her in the same UPDATE that sets a
   * credential; pairing would be a second, unaudited way back in.
   *
   * ISSUING VOIDS THE EARLIER UNUSED CODES for that staff member, inside a
   * transaction that locks her row first, so two managers pressing "Pair a phone"
   * at once produce one live code, not two (`staff_pairing_code_live_uq` is the
   * backstop). The older code — the one already on somebody's screen — is the one
   * nobody knows is still valid; the password reset spends its predecessor for
   * the same reason.
   *
   * THE RESPONSE CARRIES THE SECRETS, ONCE. Unlike the reset link, which must
   * never come back through the manager's browser, a pairing code's whole purpose
   * is to be shown on the manager's screen to the phone in front of it — a QR
   * across a counter. It lives ten minutes, works once, and binds nothing until
   * the staff member chooses her PIN on the phone. The server keeps only hashes.
   */
  app.post<{ Params: { id: string } }>('/staff/:id/pairing-code', async (req, reply) => {
    // FIRST STATEMENT. Before the target is read, before the body is parsed.
    const p = requireDashboardPerm(req, 'team');

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Non-negotiable #6: the PIN is chosen on the phone, never typed here.
    for (const banned of ['pin', 'pinHash', 'password', 'passwordHash']) {
      if (banned in body) {
        throw badRequest(
          'not_settable_here',
          'Credentials are not set through this endpoint. The staff member chooses her PIN on the phone.',
        );
      }
    }
    const rejected = Object.keys(body).filter((k) => k !== 'branchId');
    if (rejected.length > 0) {
      throw badRequest('not_settable_here', `These fields cannot be sent here: ${rejected.join(', ')}.`);
    }

    const wantsBranch = body.branchId !== undefined && body.branchId !== null;
    // The second permission, still before any lookup.
    if (wantsBranch) requirePerm(req, 'dashboard', 'dashboard');
    const branchId = wantsBranch ? requireString(body.branchId, 'branchId', 100).trim() : null;

    const [target] = await db
      .select()
      .from(staffUser)
      .where(and(eq(staffUser.id, req.params.id), eq(staffUser.salonId, p.salonId)))
      .limit(1);
    if (!target) throw notFound('unknown_staff', 'No such staff member.');

    const DEACTIVATED = () =>
      conflict(
        'staff_deactivated',
        'This account has been deactivated. Re-activate it with a reset link before pairing a phone.',
      );
    if (target.deactivatedAt) throw DEACTIVATED();

    /**
     * OPEN BRANCHES OF THIS SALON ONLY, answered `404 unknown_branch` and not a
     * 403 — `devices.ts` § enrol's wording and its reason: a 403 would confirm the
     * id names a real branch somewhere else. The composite FK is the control; this
     * is the sentence.
     */
    let branchName: string | null = null;
    if (branchId) {
      const [b] = await db
        .select({ id: branch.id, name: branch.name })
        .from(branch)
        .where(and(eq(branch.id, branchId), eq(branch.salonId, p.salonId), isNull(branch.closedAt)))
        .limit(1);
      if (!b) throw notFound('unknown_branch', 'No such open branch.');
      branchName = b.name;
    }

    const token = mintPairingToken();
    const code = mintPairingDigits();
    // argon2id, outside the transaction so no row lock is held across the hash.
    const codeHash = await hashSecret(code);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + STAFF_PAIRING_TTL_MINUTES * 60_000);

    await db.transaction(async (tx) => {
      // Serialise issuers on the staff row, and re-read the deactivation under
      // the lock: a leaver deactivated between the read above and here must not
      // be handed a live code.
      const [locked] = await tx
        .select({ id: staffUser.id, deactivatedAt: staffUser.deactivatedAt })
        .from(staffUser)
        .where(eq(staffUser.id, target.id))
        .for('update');
      if (!locked || locked.deactivatedAt) throw DEACTIVATED();

      const voided = await tx
        .update(staffPairingCode)
        .set({ voidedAt: createdAt })
        .where(
          and(
            eq(staffPairingCode.staffId, target.id),
            isNull(staffPairingCode.usedAt),
            isNull(staffPairingCode.voidedAt),
          ),
        )
        .returning({ id: staffPairingCode.id });

      const [row] = await tx
        .insert(staffPairingCode)
        .values({
          salonId: p.salonId,
          staffId: target.id,
          tokenHash: hashPairingToken(token),
          codeHash,
          branchId,
          expiresAt,
          createdBy: p.id,
          createdAt,
        })
        .returning({ id: staffPairingCode.id });

      await writeAudit(tx, p, {
        salonId: p.salonId,
        kind: 'access',
        action: 'Pairing code issued',
        // Who, for whom, how long, and where. NEVER the token or the digits —
        // an audit row is read by more people than this response is.
        detail:
          `${target.name} (@${target.handle}) — single-use, valid for ${STAFF_PAIRING_TTL_MINUTES} minutes` +
          (branchName ? ` · enrols the phone at ${branchName}` : '') +
          (voided.length > 0 ? ` · ${voided.length} earlier code(s) voided` : ''),
        source: 'merchant',
        subjectType: 'staff_user',
        subjectId: target.id,
        metadata: {
          pairingCodeId: row?.id ?? null,
          expiresAt: expiresAt.toISOString(),
          ttlMinutes: STAFF_PAIRING_TTL_MINUTES,
          branchId,
          voidedEarlier: voided.length,
        },
        ...clientMeta(req),
      });
    });

    // `StaffPairingCodeSchema`, exactly.
    return reply.code(201).send({
      staffId: target.id,
      token,
      code,
      expiresAt: expiresAt.toISOString(),
      branchId,
    });
  });

  // ------------------------------------------------------------------ redeem --
  /**
   * Unauthenticated. `{ token, pin }` or `{ phone, code, pin }`.
   *
   * ORDER, each step for a reason:
   *
   *   1. SHAPE — exactly one of token / phone, and a four-digit PIN
   *      (`400 invalid_pin_format`, the PIN sign-in's own refusal). Reads no
   *      table, so it discloses nothing.
   *   2. BUDGET — per address and per phone, before any table holding staff or
   *      codes is read and before any hash (services/pairLimit.ts).
   *   3. HASH THE CHOSEN PIN — on every request, hit or miss, so the token path's
   *      miss and hit cost the same argon2 and the hash is not computed under a
   *      row lock.
   *   4. ONE TRANSACTION: find the live code(s) FOR UPDATE; on the phone path
   *      verify the digits against a fixed number of hashes; on a miss record the
   *      strike and commit; on a hit CLAIM the code with the `used_at IS NULL AND
   *      voided_at IS NULL AND expires_at > now()` guard (two racing redeems
   *      cannot both win), issue the device id, set `pin_hash` + `pin_device_id`
   *      and clear the failure count and lock, revoke her live SCANNER sessions,
   *      enrol the till if the code named a branch, write the audit rows, and
   *      mint the scanner session — all or nothing. A session minted outside the
   *      transaction could outlive a rolled-back claim.
   */
  app.post('/staff/pair', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // ------------------------------------------------------------- 1. shape --
    const viaToken = body.token !== undefined && body.token !== null;
    const viaPhone = body.phone !== undefined && body.phone !== null;
    if (viaToken === viaPhone) {
      throw badRequest('invalid_request', 'Send the token from the QR, or the mobile number and code.');
    }
    if (!isFourDigitPin(body.pin)) {
      throw badRequest('invalid_pin_format', 'A PIN is four digits.');
    }
    const pin = body.pin;

    /**
     * Normalised but NOT refused here: a malformed token, number or code is a
     * wrong one, and answers the uniform refusal at the end of the uniform path —
     * a distinguishable 400 for "that is not a phone number" would be harmless,
     * but one refusal is simpler to keep honest than an argument about which
     * refusals are harmless.
     */
    const phone = viaPhone ? normaliseStaffPhone(body.phone) : null;
    const digits = typeof body.code === 'string' && /^\d{6}$/.test(body.code) ? body.code : null;
    const token =
      typeof body.token === 'string' && body.token.length >= 32 && body.token.length <= 200
        ? body.token
        : null;

    // ------------------------------------------------------------ 2. budget --
    await chargePairBudget(db, { ip: req.ip ?? null, phone });

    // -------------------------------------------------------- 3. the PIN hash --
    const pinHash = await hashSecret(pin);

    // ----------------------------------------------------- 4. the transaction --
    const outcome = await db.transaction(async (tx) => {
      const select = () =>
        tx
          .select({ code: staffPairingCode, staff: staffUser })
          .from(staffPairingCode)
          .innerJoin(
            staffUser,
            and(eq(staffUser.id, staffPairingCode.staffId), eq(staffUser.salonId, staffPairingCode.salonId)),
          );

      let matched: PairingCandidate | null = null;

      if (viaToken) {
        const rows = token
          ? await select()
              .where(and(eq(staffPairingCode.tokenHash, hashPairingToken(token)), liveCode()))
              .limit(1)
              .for('update', { of: staffPairingCode })
          : [];
        matched = rows[0] ?? null;
      } else {
        const candidates =
          phone && digits
            ? await select()
                .where(and(eq(staffUser.phone, phone), liveCode()))
                .orderBy(desc(staffPairingCode.createdAt))
                .limit(PAIRING_MAX_CODES_PER_PHONE)
                .for('update', { of: staffPairingCode })
            : [];

        // A FIXED number of verifies, whatever was found. See the constant.
        for (let i = 0; i < PAIRING_MAX_CODES_PER_PHONE; i++) {
          const c = candidates[i];
          if (c && digits) {
            if ((await verifySecret(c.code.codeHash, digits)) && !matched) matched = c;
          } else {
            await burnVerifyTime(digits ?? '000000');
          }
        }

        if (!matched) {
          /**
           * A STRIKE ON EVERY CODE THE GUESS WAS TRIED AGAINST, and the fifth voids
           * it — in one statement, under the FOR UPDATE above, so concurrent wrong
           * guesses queue on the row and each sees the last one's count. SET reads
           * the OLD `failed_attempts` on both sides, which is what makes the CASE
           * fire on exactly the fifth.
           *
           * Run even when nothing was found, against no row, so a miss and a strike
           * cost the same round trip.
           */
          const ids = candidates.map((c) => c.code.id);
          const struck = await tx
            .update(staffPairingCode)
            .set({
              failedAttempts: sql`${staffPairingCode.failedAttempts} + 1`,
              voidedAt: sql`CASE WHEN ${staffPairingCode.failedAttempts} + 1 >= ${PAIRING_MAX_WRONG_DIGITS}
                                 THEN now() ELSE NULL END`,
            })
            .where(ids.length > 0 ? inArray(staffPairingCode.id, ids) : sql`false`)
            .returning({
              id: staffPairingCode.id,
              salonId: staffPairingCode.salonId,
              staffId: staffPairingCode.staffId,
              voidedAt: staffPairingCode.voidedAt,
              failedAttempts: staffPairingCode.failedAttempts,
            });

          for (const s of struck) {
            if (!s.voidedAt) continue;
            const who = candidates.find((c) => c.code.id === s.id)?.staff;
            /**
             * `null` ACTOR, on purpose — the PIN lockout's reasoning in
             * routes/auth.ts: five wrong codes establish that somebody tried, not
             * who. She is the SUBJECT; the system voided the code.
             */
            await writeAudit(tx, null, {
              salonId: s.salonId,
              kind: 'risk',
              action: 'Pairing code voided',
              detail: `A pairing code for ${who?.name ?? s.staffId} was voided after ${s.failedAttempts} wrong attempts`,
              source: 'scanner',
              subjectType: 'staff_user',
              subjectId: s.staffId,
              metadata: { pairingCodeId: s.id, attempts: s.failedAttempts },
              ...clientMeta(req),
            });
          }
          return null;
        }
      }

      if (!matched) return null;
      const code = matched.code;

      // ------------------------------------------------------------- claim --
      const claimed = await tx
        .update(staffPairingCode)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(staffPairingCode.id, code.id),
            isNull(staffPairingCode.usedAt),
            isNull(staffPairingCode.voidedAt),
            gt(staffPairingCode.expiresAt, sql`now()`),
          ),
        )
        .returning({ id: staffPairingCode.id });
      if (claimed.length === 0) return null;

      // ------------------------------------------------- bind the PIN -------
      /**
       * THE PHONE SHE IS LEAVING, read under her row lock. The UPDATE below
       * returns only the new values, and a plain read here could see a binding a
       * concurrent redeem is about to replace — then the wrong phone would be
       * unenrolled and the one actually replaced left live. The lock is the one
       * the UPDATE takes next anyway, in the same order (code row, then staff
       * row), so it adds no new way to deadlock.
       */
      const [prior] = await tx
        .select({ pinDeviceId: staffUser.pinDeviceId })
        .from(staffUser)
        .where(and(eq(staffUser.id, code.staffId), eq(staffUser.salonId, code.salonId)))
        .for('update');

      const deviceId = mintPairedDeviceId();
      const now = new Date();
      const [staff] = await tx
        .update(staffUser)
        .set({
          pinHash,
          pinDeviceId: deviceId,
          // A fresh PIN on a fresh device starts with a clean record. A lock
          // left from the old phone would refuse the PIN she just chose.
          pinFailedAttempts: 0,
          pinLockedUntil: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(staffUser.id, code.staffId),
            eq(staffUser.salonId, code.salonId),
            // Deactivated since the SELECT: refuse, and the throw rolls the
            // claim back with everything else.
            isNull(staffUser.deactivatedAt),
          ),
        )
        .returning();
      if (!staff) throw PAIRING_REFUSED();

      /**
       * HER SCANNER SESSIONS GO WITH THE OLD BINDING. The PIN now works only from
       * the new device; a phone still signed in on the old one would be a scanner
       * session that no longer corresponds to any PIN she holds. Her web session
       * stays — which phone holds her PIN says nothing about the laptop.
       */
      const revokedScannerSessions = await revokeSessionsOfScope(
        tx,
        { kind: 'staff', id: staff.id },
        'scanner',
        'phone_paired',
      );

      // ---------------------------------------- unenrol the phone she left --
      /**
       * Trunk's ruling, 2026-11-10 (phase 2): A RE-PAIR UNENROLS HER PREVIOUS
       * PHONE — BUT ONLY A PHONE THIS SERVER ISSUED.
       *
       * Her old PIN binding is gone (above), so a till enrolled under her old
       * `PH-` id is a till nobody can sign into any more: one person per phone,
       * and that person has moved. Left live it sits in Tills as "<her>'s phone"
       * at a branch, looking like hardware the salon still runs.
       *
       * A TYPED OR SEEDED ID IS NEVER TOUCHED (`DEV-SCANNER-01`, anything a
       * manager entered in "Set up manually" or in Tills). Those may be the
       * counter's shared tablet, which other staff still sign into with their
       * own PINs; her re-pairing says nothing about it. `isServerIssuedDeviceId`
       * says why the prefix is a fact on this column and not a guess.
       *
       * REVOKED EXACTLY AS `DELETE /salons/:id/devices/:deviceId` REVOKES:
       * `revoked_at` + `revoked_by_staff_id` on the live row (an UPDATE — the
       * superseded row stays as history), `revoked_at IS NULL` in the WHERE so
       * the row count decides, and the same `rules` / `device_revoked` audit row,
       * so the audit filters treat it like a revoke from Tills.
       *
       * AS HER, the "Phone paired" row's reasoning below — and the only actor the
       * row can carry: `device_enrolment_revocation_is_whole` requires
       * `revoked_by_staff_id` whenever `revoked_at` is set, so "the system" is not
       * representable without a migration, and this slice adds none. She is the
       * one who moved the PIN; the issuer is in the metadata.
       *
       * Whether or not the NEW code names a branch: the old till is dead either way.
       */
      const priorDeviceId = prior?.pinDeviceId ?? null;
      if (isServerIssuedDeviceId(priorDeviceId)) {
        const unenrolled = await tx
          .update(deviceEnrolment)
          .set({ revokedAt: now, revokedByStaffId: staff.id, updatedAt: now })
          .where(
            and(
              eq(deviceEnrolment.salonId, staff.salonId),
              eq(deviceEnrolment.deviceId, priorDeviceId),
              isNull(deviceEnrolment.revokedAt),
            ),
          )
          .returning({ id: deviceEnrolment.id, label: deviceEnrolment.label });

        for (const row of unenrolled) {
          await writeAudit(tx, { kind: 'staff', id: staff.id, name: staff.name, role: staff.role }, {
            salonId: staff.salonId,
            kind: 'rules',
            action: 'device_revoked',
            detail: `${row.label} (${priorDeviceId})`,
            source: 'scanner',
            subjectType: 'device',
            subjectId: priorDeviceId,
            metadata: {
              via: 'pairing',
              reason: 'staff_repaired',
              pairingCodeId: code.id,
              pairedStaffId: staff.id,
              issuedBy: code.createdBy,
              replacedByDeviceId: deviceId,
            },
            ...clientMeta(req),
          });
        }
      }

      // -------------------------------------------------- enrol the till --
      let enrolledAt: { branchId: string; branchName: string } | null = null;
      if (code.branchId) {
        const [b] = await tx
          .select({ id: branch.id, name: branch.name })
          .from(branch)
          .where(and(eq(branch.id, code.branchId), eq(branch.salonId, code.salonId), isNull(branch.closedAt)))
          .limit(1);
        // `liveCode()` already refused a closed branch; this is the same rule
        // read again under the transaction, not a second policy.
        if (!b) throw PAIRING_REFUSED();

        const [issuer] = await tx
          .select({ id: staffUser.id, name: staffUser.name, role: staffUser.role })
          .from(staffUser)
          .where(eq(staffUser.id, code.createdBy))
          .limit(1);

        const label = `${staff.name}'s phone`;
        await tx.insert(deviceEnrolment).values({
          id: `ENR-${randomUUID()}`,
          salonId: code.salonId,
          deviceId,
          branchId: b.id,
          label,
          // The authority is the issuer's `perms.dashboard`, checked when she
          // issued the code — so the row names her, as a direct enrolment would.
          enrolledByStaffId: code.createdBy,
          createdAt: now,
          updatedAt: now,
        });

        await writeAudit(
          tx,
          issuer ? { kind: 'staff', id: issuer.id, name: issuer.name, role: issuer.role } : null,
          {
            salonId: code.salonId,
            // `devices.ts`'s kind and action, so the audit filters treat a till
            // enrolled by pairing exactly like one enrolled directly.
            kind: 'rules',
            action: 'device_enrolled',
            detail: `${label} (${deviceId}) → ${b.name}`,
            source: 'scanner',
            subjectType: 'device',
            subjectId: deviceId,
            metadata: { via: 'pairing', pairingCodeId: code.id, pairedStaffId: staff.id },
          },
        );
        enrolledAt = { branchId: b.id, branchName: b.name };
      }

      // ------------------------------------------------- the session -------
      // `scanner` scope, minted exactly as `staffPinSession` mints one.
      const issued = await issueSession(tx, {
        principalKind: 'staff',
        staffId: staff.id,
        salonId: staff.salonId,
        scope: 'scanner',
        deviceId,
        ...clientMeta(req),
      });

      /**
       * AS HER, the actor-snapshot case `routes/auth.ts` § web sign-in argues: no
       * session-backed principal exists yet, and her identity is established by a
       * single-use code a manager issued for her. `System` would claim AVO paired
       * the phone. The issuer is named in the metadata and on the issue row.
       */
      await writeAudit(tx, { kind: 'staff', id: staff.id, name: staff.name, role: staff.role }, {
        salonId: staff.salonId,
        kind: 'access',
        action: 'Phone paired',
        detail:
          `${staff.name} (@${staff.handle}) paired a phone and chose a PIN` +
          (enrolledAt ? ` · enrolled as a till at ${enrolledAt.branchName}` : '') +
          (revokedScannerSessions > 0
            ? ` · ${revokedScannerSessions} earlier scanner session(s) signed out`
            : ''),
        source: 'scanner',
        subjectType: 'staff_user',
        subjectId: staff.id,
        metadata: {
          via: viaToken ? 'qr' : 'phone',
          deviceId,
          pairingCodeId: code.id,
          issuedBy: code.createdBy,
          branchId: enrolledAt?.branchId ?? null,
          revokedScannerSessions,
        },
        ...clientMeta(req),
      });

      return { staff, deviceId, issued };
    });

    if (!outcome) throw PAIRING_REFUSED();

    // `StaffPairResponseSchema`, exactly.
    return reply.send({
      salonId: outcome.staff.salonId,
      deviceId: outcome.deviceId,
      accessToken: outcome.issued.accessToken,
      refreshToken: outcome.issued.refreshToken,
      expiresAt: outcome.issued.expiresAt.toISOString(),
      staff: serialiseStaff(outcome.staff),
    });
  });
}
