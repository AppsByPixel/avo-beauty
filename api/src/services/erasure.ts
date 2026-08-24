/**
 * Account erasure — the executor behind the privacy policy's § 5.
 *
 * THE PROMISE, VERBATIM (legalSeed.ts, the published text the wallet renders
 * under non-negotiable #10): "Transaction records are kept for 7 years, as
 * financial rules require. The rest of your account data is deleted within 30
 * days of a deletion request." `POST /members/me/deletion` set the clock and
 * served `erasureDueAt` to the customer as a fact — and nothing executed it. A
 * member past her due date stayed undeleted for ever. This is the no-show shape
 * exactly (a state machine with an unreachable terminal state and no runner),
 * except the terminal state here is a legal commitment rather than a deposit
 * return.
 *
 * SCRUB, NOT ROW-DELETE. `transaction` and `ledger_entry` rows are a salon's
 * books — a deleted member's charges still happened and commission was still
 * owed on them (non-negotiables #1/#3) — and they reference her with restrict,
 * as does `booking`. So the member ROW survives as a tombstone the books can
 * keep resolving, and what gets deleted is HER: every column and every sibling
 * row that identifies a person. § 2 of the same policy is the checklist of what
 * was collected: "your name, phone number, appointment history, transaction and
 * reward history, and basic device data".
 *
 * WHAT THE SCRUB DOES, table by table — and the reasoning survives here because
 * the census and the leak sweeps will look for it:
 *
 *   member                  scrubbed IN PLACE. name → 'Deleted account';
 *                           phone → a synthetic '+990…' value (the column is
 *                           NOT NULL, CHECKed E.164, and unique per salon, so
 *                           the tombstone needs a well-formed impossible number
 *                           — +990 is an unassigned country code); email → NULL;
 *                           password_hash → '!erased' (not parseable as argon2,
 *                           so verifySecret returns false for every input and
 *                           sign-in refuses without a special case). visits /
 *                           tier / stamps stay: they are aggregates on a row
 *                           that now names nobody — "reward history"
 *                           de-identified rather than destroyed, which is the
 *                           7-year books argument one step removed.
 *   session                 DELETED — ip, user agent, device id: the policy's
 *                           "basic device data". Deleting the rows also kills
 *                           any surviving token mid-flight: `sessionIsLive`
 *                           finds no row, so a stale access token dies at its
 *                           next request without a revocation pass.
 *   wallet_token            DELETED. QR tokens are hers.
 *   member_password_reset   DELETED — carries `requested_ip`. The FK cascade
 *                           that would clear these on a hard DELETE is inert
 *                           under a scrub (the member row survives), so the job
 *                           deletes them explicitly.
 *   phone_change_challenge  DELETED — old AND new phone numbers in clear.
 *   merchant_notification   rows whose SUBJECT is her: DELETED. The salon's
 *                           bell feed has no member FK, but a row pointing at a
 *                           member is a row about her account. Rows about her
 *                           BOOKINGS may still embed her name in free text —
 *                           that residue joins the audit_log flag below, same
 *                           class (names inside operational strings).
 *   receipt_job             DELETED — a delivery queue, not the money record,
 *                           and `payload` is the receipt RENDERED AT CHARGE
 *                           TIME, name and all; `last_error` can echo a
 *                           provider's view of the destination. The money each
 *                           was about is the transaction row, which stays.
 *   support_ticket          DELETED — `message` is her own correspondence, the
 *                           clearest possible "rest of your account data".
 *                           FLAGGED to trunk rather than silently decided: a
 *                           salon-routed ticket has operational value to the
 *                           salon, and if trunk rules the other way the delete
 *                           narrows to platform-routed rows.
 *   booking                 KEPT, deliberately. § 2 lists "appointment history"
 *                           apart from "transaction and reward history", so a
 *                           strict reading calls it "the rest" — but booking
 *                           rows hold deposit money's paper trail
 *                           (hold/settled transaction FKs, restrict both ways)
 *                           and per-branch revenue reads them. The defensible
 *                           reading implemented here: a booking pointing at a
 *                           tombstone identifies nobody, so the HISTORY is
 *                           de-identified rather than destroyed. The wording
 *                           ambiguity is FLAGGED to trunk, not resolved.
 *   loyalty_event           KEPT — same argument, "reward history" on a
 *                           tombstone.
 *   campaign_send           CANNOT be touched: 0028 revoked UPDATE/DELETE from
 *                           avo_app. Rows are (campaign, member, channel,
 *                           sent_at) — de-identified by the tombstone.
 *   member_consent_event    CANNOT be touched: 0020's REVOKE. Rows carry
 *                           `ip_address`. FLAGGED: scrubbing them needs either
 *                           an owner-role job or a narrow column grant, both
 *                           schema/trunk decisions — and consent records are
 *                           also the platform's legal defence that consent
 *                           existed, a retention question that is CLIENT-OWNED
 *                           (CLAUDE.md escalations).
 *   audit_log               CANNOT be touched: 0023's REVOKE plus triggers that
 *                           refuse UPDATE and DELETE outright. Her existing
 *                           rows carry `actor_name`, `ip_address`,
 *                           `user_agent` and names inside `detail` strings, and
 *                           they will outlive the erasure. FLAGGED — the same
 *                           policy's § 7 PROMISES an audit log ("every staff
 *                           action on your record is written to an audit log"),
 *                           so the two sections are in real tension and the
 *                           resolution is not this job's to pick.
 *
 * WHAT THE JOB REFUSES TO DECIDE: money. Three states make erasure unsafe, all
 * reachable because `POST /members/me/deletion` checks only `balance_fils` at
 * request time:
 *
 *   - a NON-ZERO BALANCE at due date (the top-up path cancels the deletion on
 *     settle, so this should be unreachable — but "should be" is not a
 *     precondition, and an adjustment or refund credit during the window is not
 *     a top-up);
 *   - a booking still in `deposit_held`: her money, in escrow, with a
 *     deposit-return path that would credit a tombstone;
 *   - a top-up intent still live ('created'/'redirected'/'pending'): money in
 *     flight at the gateway, whose settle handler cancels deletions and must
 *     not lose that race to an erasure.
 *
 * Each is COUNTED and DEFERRED, never resolved: erasing is the one
 * irreversible act in this codebase, deferring costs a day. The counts land in
 * the run report and the job's audit row so a member stuck deferred is visible,
 * not lost.
 *
 * THE RACE WITH THE TOP-UP SETTLE (services/topup.ts § "A TOP-UP CANCELS A
 * PENDING DELETION") is settled by lock order, not luck: both paths take the
 * member row FOR UPDATE first, and this job re-checks `deletion_due_at` and
 * `erased_at` INSIDE the lock. Settle first → the deletion is cancelled and the
 * re-check sees NULL and skips. Job first → the member is erased, and the
 * settle's own intent lock finds an intent whose member is a tombstone — which
 * cannot happen for a LIVE intent, because a live intent is precisely what this
 * job defers on.
 *
 * PER-MEMBER TRANSACTIONS, not one batch: a crash mid-batch leaves every member
 * either fully scrubbed or untouched, and running the job twice erases nobody
 * twice — the re-check inside the lock is the same conditional-spend discipline
 * as the reset flows.
 *
 * THE JOB'S OWN AUDIT ROW NAMES NOBODY. An append-only row naming her would
 * outlive the erasure and defeat it. It carries the member ID — opaque, and the
 * ledger references it for seven years regardless — plus per-table counts.
 * `null` actor: the system erased her, on the policy's authority, not on any
 * session's.
 */

import { and, eq, inArray, isNull, isNotNull, lte, asc, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import type { Db } from '../db/client';
import { member, memberPasswordReset } from '../db/schema/member';
import { booking } from '../db/schema/booking';
import { merchantNotification } from '../db/schema/notification';
import { phoneChangeChallenge } from '../db/schema/phoneChange';
import { receiptJob } from '../db/schema/receipt';
import { session } from '../db/schema/session';
import { supportTicket } from '../db/schema/legal';
import { topUpIntent } from '../db/schema/topup';
import { walletToken } from '../db/schema/walletToken';
import { writeAudit } from './audit';

export interface ErasureRunResult {
  candidates: number;
  erased: number;
  /** Deferred: money states the job refuses to decide. Visible, not lost. */
  deferredBalance: number;
  deferredEscrow: number;
  deferredPendingTopup: number;
  /** The re-check inside the lock found the state changed under us. */
  skipped: number;
  failed: number;
}

/**
 * A well-formed impossible phone. +990 is an unassigned country code, the rest
 * is random, and the result satisfies both `member_phone_is_e164` and the
 * per-salon uniqueness (collision odds 10^-12 per pair; the unique index would
 * refuse the write and the member retries next run rather than corrupting
 * anything).
 */
function tombstonePhone(): string {
  const digits = Array.from(randomBytes(12), (b) => String(b % 10)).join('');
  return `+990${digits}`;
}

/**
 * Not a hash in any scheme argon2 recognises, so `verifySecret` throws inside
 * its try and answers false to every candidate password — sign-in refuses a
 * tombstone with no special case anywhere.
 */
/**
 * A NON-NULL VALUE THAT CANNOT VERIFY. `member.password_hash` is `NOT NULL`, so
 * erasure cannot clear it — it overwrites it with this, and `argon2.verify` refuses
 * anything that is not a PHC string, so a tombstone cannot sign in.
 *
 * EXPORTED, because a bare `password_hash IS NOT NULL` reads this as "she has a
 * password" and that is a lie a UI will render. `GET /v1/platform/accounts` computes
 * `passwordSet` and got it wrong until this was exported: an erased member came back
 * `passwordSet: true` beside `status: 'erased'`, which is the kind of contradiction
 * non-negotiable #6's screen is the worst place to put. One definition, imported.
 */
export const ERASED_PASSWORD_SENTINEL = '!erased';

export const TOMBSTONE_NAME = 'Deleted account';

/** Top-up intent states with money still in flight at the gateway. */
const LIVE_INTENT_STATUSES = ['created', 'redirected', 'pending'] as const;

export async function runErasureOnce(
  db: Db,
  limit = 100,
  nowOverride?: Date,
): Promise<ErasureRunResult> {
  const now = nowOverride ?? new Date();

  /**
   * Candidates, UNLOCKED — a hint, not a decision, exactly as the no-show
   * worker's header argues. Every row is re-checked under its own lock below.
   */
  const candidates = await db
    .select({ id: member.id })
    .from(member)
    .where(and(isNotNull(member.deletionDueAt), lte(member.deletionDueAt, now), isNull(member.erasedAt)))
    .orderBy(asc(member.deletionDueAt))
    .limit(limit);

  const result: ErasureRunResult = {
    candidates: candidates.length,
    erased: 0,
    deferredBalance: 0,
    deferredEscrow: 0,
    deferredPendingTopup: 0,
    skipped: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    try {
      const outcome = await db.transaction(async (tx) => {
        /**
         * The member row FIRST, FOR UPDATE — the same lock, in the same order,
         * as the top-up settle and the no-show return, which is what makes the
         * three paths serialise instead of deadlock.
         */
        const [m] = await tx
          .select()
          .from(member)
          .where(eq(member.id, candidate.id))
          .for('update')
          .limit(1);
        if (!m) return 'skipped' as const;

        /**
         * THE RE-CHECK, inside the lock. A top-up that settled between the scan
         * and this lock has cancelled the deletion (deletionDueAt now NULL); a
         * concurrent manual run has already erased. Either way: not ours.
         */
        if (m.erasedAt !== null) return 'skipped' as const;
        if (m.deletionDueAt === null || m.deletionDueAt.getTime() > now.getTime()) {
          return 'skipped' as const;
        }

        // ---- the money preconditions: counted and deferred, never decided ----
        if (m.balanceFils > 0) return 'deferred_balance' as const;

        const [held] = await tx
          .select({ id: booking.id })
          .from(booking)
          .where(and(eq(booking.memberId, m.id), eq(booking.status, 'deposit_held')))
          .limit(1);
        if (held) return 'deferred_escrow' as const;

        const [liveIntent] = await tx
          .select({ id: topUpIntent.id })
          .from(topUpIntent)
          .where(
            and(
              eq(topUpIntent.memberId, m.id),
              inArray(topUpIntent.status, [...LIVE_INTENT_STATUSES]),
            ),
          )
          .limit(1);
        if (liveIntent) return 'deferred_pending_topup' as const;

        // ------------------------------------------------------- the scrub ----
        const counts: Record<string, number> = {};
        const del = async (name: string, run: () => Promise<Array<{ id?: unknown }>>) => {
          counts[name] = (await run()).length;
        };

        await del('sessions', () =>
          tx.delete(session).where(eq(session.memberId, m.id)).returning({ id: session.id }),
        );
        await del('walletTokens', () =>
          tx.delete(walletToken).where(eq(walletToken.memberId, m.id)).returning({ id: walletToken.id }),
        );
        await del('passwordResets', () =>
          tx
            .delete(memberPasswordReset)
            .where(eq(memberPasswordReset.memberId, m.id))
            .returning({ id: memberPasswordReset.id }),
        );
        await del('phoneChanges', () =>
          tx
            .delete(phoneChangeChallenge)
            .where(eq(phoneChangeChallenge.memberId, m.id))
            .returning({ id: phoneChangeChallenge.id }),
        );
        await del('merchantNotificationsAboutHer', () =>
          tx
            .delete(merchantNotification)
            .where(
              and(
                eq(merchantNotification.subjectType, 'member'),
                eq(merchantNotification.subjectId, m.id),
              ),
            )
            .returning({ id: merchantNotification.id }),
        );
        await del('receiptJobs', () =>
          tx.delete(receiptJob).where(eq(receiptJob.memberId, m.id)).returning({ id: receiptJob.id }),
        );
        await del('supportTickets', () =>
          tx
            .delete(supportTicket)
            .where(eq(supportTicket.memberId, m.id))
            .returning({ id: supportTicket.id }),
        );

        await tx
          .update(member)
          .set({
            name: TOMBSTONE_NAME,
            phone: tombstonePhone(),
            email: null,
            emailVerified: false,
            passwordHash: ERASED_PASSWORD_SENTINEL,
            erasedAt: now,
            updatedAt: now,
          })
          .where(eq(member.id, m.id));

        /**
         * The audit row. NO NAME, NO PHONE, NOTHING THAT WAS JUST SCRUBBED — an
         * append-only row naming her would outlive the erasure and defeat it.
         * The member id is what the ledger keeps for seven years anyway, and
         * the counts are what an auditor of the PROMISE needs.
         */
        await writeAudit(tx, null, {
          salonId: m.salonId,
          kind: 'access',
          action: 'Account erased',
          detail:
            `Member ${m.id} erased on schedule — ` +
            Object.entries(counts)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', '),
          source: 'system',
          subjectType: 'member',
          subjectId: m.id,
          metadata: {
            requestedAt: m.deletionRequestedAt?.toISOString() ?? null,
            dueAt: m.deletionDueAt?.toISOString() ?? null,
            counts,
            /**
             * The two tables the scrub structurally cannot reach (append-only
             * for avo_app), recorded on every erasure so the gap is a visible
             * fact rather than an assumption: audit_log (names, ip, ua in her
             * historical rows) and member_consent_event (ip). Flagged to trunk;
             * resolution is a schema/retention decision, not this job's.
             */
            retainedBeyondErasure: ['audit_log', 'member_consent_event'],
          },
        });

        return 'erased' as const;
      });

      if (outcome === 'erased') result.erased += 1;
      else if (outcome === 'deferred_balance') result.deferredBalance += 1;
      else if (outcome === 'deferred_escrow') result.deferredEscrow += 1;
      else if (outcome === 'deferred_pending_topup') result.deferredPendingTopup += 1;
      else result.skipped += 1;
    } catch {
      // One member's failure is one member's failure. The next run retries her;
      // the rest of the batch proceeds.
      result.failed += 1;
    }
  }

  return result;
}
