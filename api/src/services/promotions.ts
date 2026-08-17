/**
 * The promotion set, and the server side of the rule that makes it safe.
 *
 * api-contract.md § Promotion set:
 *
 *   "There is no `live` flag. A window is live if and only if
 *    days.includes(now.getDay()) && from <= now < to in salon-local time.
 *    Both clients resolve it every second and render a real countdown; the
 *    banner disappears on its own at `to` with no push, no poll and no server
 *    tick. Server-side, the same predicate gates the earning multiplier at
 *    charge time — a client that shows a stale banner cannot cause a wrong
 *    charge."
 *
 * THE PREDICATE IS IMPORTED, NOT REIMPLEMENTED
 * --------------------------------------------
 * `isHappyHourLive`, `minutesRemaining` and `rewardEffect` come from
 * packages/types/src/rules.ts. Not one line of them is restated below. They are
 * shared precisely so a client and this server cannot disagree, and a second
 * implementation here — however carefully copied — would be a second thing to
 * keep in step, which is the same failure as a stored `live` column with a cron
 * job behind it. If the rule is wrong it must be wrong everywhere at once.
 *
 * `activeHappyHour` is the fourth of that family and is deliberately NOT used
 * here. It answers "which countdown does the customer see", by picking the live
 * window closest to ending — the right question for a banner, and the wrong one
 * for an earning rate, which is the BEST live offer rather than the most urgent
 * one. It belongs to the clients. See `decideEarning`.
 *
 * WHAT THIS MODULE ADDS: THE ZONE
 * -------------------------------
 * `rules.ts` takes `offsetMinutes`, because it was written before
 * `salon.timezone` existed. `offsetFor(salon, now)` supplies the zone's offset
 * AT THAT INSTANT, which is exactly the value the shared function needs:
 *
 *     salonClock(now, offset) = the UTC fields of (now + offset)
 *
 * and (now + the zone's offset at now) is that zone's wall clock at now, DST
 * included. So the shared predicate becomes zone-correct with no change to it.
 *
 * REPORTED, NOT PATCHED AROUND — `minutesUntilNext` in rules.ts searches up to
 * seven days ahead using ONE offset throughout, so in a DST zone a next-window
 * countdown spanning a transition is an hour out. Fixing it means changing the
 * signature to take a zone id instead of an offset, which is a packages/types
 * change and therefore trunk's, not lane A's. It is not used on the money path.
 *
 * HOW A CHARGE'S MULTIPLIER IS DECIDED
 * ------------------------------------
 * ONE evaluation instant, taken inside the money transaction, applied once.
 * Never a client claim: `POST /charges` reads no promotion field from its body,
 * so a patched scanner announcing a boost that is not live earns the ordinary
 * rate. Non-negotiable #2.
 *
 * WHEN TWO OFFERS OVERLAP, THE BEST ONE APPLIES — THEY DO NOT COMPOUND
 * -------------------------------------------------------------------
 * Unspecified in the contract, decided here, and decided conservatively. A
 * branch permanently boosted to 2x visits that also runs an `x2visit` happy hour
 * would compound to 4x, and neither the dashboard's stepper nor the wallet's
 * chip says anything that would lead a merchant to expect it: she set "2x" twice
 * and would be funding "4x". `max`, not product.
 *
 * The one place things DO add is the top-up percentage against the TIER bonus,
 * and only because rules.ts says so in as many words: `topupBonusPercent` is
 * "Extra top-up bonus percentage points ON TOP OF the tier bonus". Tier and
 * promotion are different budget lines — which is also why they are different
 * columns. Promotion sources still take the max among themselves first.
 */

import { and, eq } from 'drizzle-orm';
import { isHappyHourLive, minutesRemaining, rewardEffect, type HappyHour } from '@avo/types';
/**
 * A TYPE-ONLY import of the client, deliberately.
 *
 * `db/client.ts` parses the environment at module load, so importing the value
 * would make this module — whose core is a pure function of some rows and an
 * instant — refuse to load without a DATABASE_URL. The predicate is the thing
 * most worth testing and it must be testable with no database, no docker and no
 * env file, exactly as services/loyalty.ts is. Callers pass their own executor.
 */
import type { Db } from '../db/client';
import { boost, happyHour } from '../db/schema/promotion';
import { salon } from '../db/schema/salon';
import { transaction } from '../db/schema/transaction';
import { offsetFor } from '../time/zone';
import type { Executor } from './audit';

/** The wire shape of one window — exactly `HappyHourSchema`, no `live` flag. */
export type HappyHourWire = HappyHour;

export interface PromotionSetWire {
  boosts: Record<string, { visit: number; topup: number; stamp: number }>;
  boostsPublishedAt: string | null;
  boostsPublishedBy: string | null;
  happy: HappyHourWire[];
}

/** NULL branch means every branch; the wire spells that `"all"`. */
export function serialiseHappyHour(row: typeof happyHour.$inferSelect): HappyHourWire {
  return {
    id: row.id,
    branchId: row.branchId ?? 'all',
    days: [...row.days].sort((a, b) => a - b),
    from: row.from,
    to: row.to,
    reward: row.reward as HappyHour['reward'],
    on: row.on,
    notify: row.notify,
  };
}

/**
 * Read the whole set for a salon.
 *
 * ONE object, because the contract says so: "The customer wallet and the
 * merchant dashboard read the same object. Never duplicate boost or happy-hour
 * values in a client."
 */
export async function readPromotionSet(exec: Db, salonId: string): Promise<PromotionSetWire> {
  const [boostRows, happyRows] = await Promise.all([
    exec.select().from(boost).where(eq(boost.salonId, salonId)),
    exec.select().from(happyHour).where(eq(happyHour.salonId, salonId)),
  ]);

  const boosts: PromotionSetWire['boosts'] = {};
  let publishedAt: Date | null = null;
  let publishedBy: string | null = null;
  for (const b of boostRows) {
    boosts[b.branchId] = { visit: b.visit, topup: b.topup, stamp: b.stamp };
    // Every row of a set is stamped identically by `PUT .../boosts`, so the max
    // is the set's publish time. Taking the max rather than "the first row"
    // means a hand-edited database still reports the most recent truth.
    if (publishedAt === null || b.publishedAt > publishedAt) {
      publishedAt = b.publishedAt;
      publishedBy = b.publishedBy;
    }
  }

  return {
    boosts,
    boostsPublishedAt: publishedAt ? publishedAt.toISOString() : null,
    boostsPublishedBy: publishedBy,
    happy: happyRows
      .map(serialiseHappyHour)
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

// ------------------------------------------------------------ the effect --

export interface EarningDecision {
  /** 1, 2 or 3. What one appointment is worth in visits. */
  visitMultiplier: number;
  /** 1, 2 or 3. What one appointment is worth in stamps. */
  stampMultiplier: number;
  /** Percentage POINTS added to the tier bonus on a top-up. */
  topupBonusPercent: number;
  /** Flat wallet credit in fils — `credit3`. Paid as its own adjustment row. */
  creditFils: number;
  /**
   * The window that produced the winning effect, or null when the effect came
   * from a branch boost or from nothing at all. This is what lands in
   * `transaction.promotion_id`.
   */
  happyHourId: string | null;
  /** Minutes left in that window at the evaluation instant. Receipt copy. */
  minutesRemaining: number;
  /** The instant the decision was made. ONE per charge, recorded, never re-read. */
  decidedAt: Date;
}

export const NO_PROMOTION: Omit<EarningDecision, 'decidedAt'> = {
  visitMultiplier: 1,
  stampMultiplier: 1,
  topupBonusPercent: 0,
  creditFils: 0,
  happyHourId: null,
  minutesRemaining: 0,
};

export interface PromotionInputs {
  salon: { id: string; timezone: string };
  /**
   * The branch this money moved at, or NULL when nobody actually established
   * one.
   *
   * NULL IS NOT "no branch", IT IS "NOT KNOWN", AND THE DIFFERENCE IS MONEY.
   * `transaction.branch_id` is NOT NULL, so both charge and top-up fall back to
   * `defaultBranchId()` — `SELECT id FROM branch WHERE salon_id = … ORDER BY id
   * LIMIT 1`. That is a defensible way to ATTRIBUTE a row for reporting and an
   * indefensible way to decide what a customer EARNS: a salon whose branches are
   * BR-KWC and BR-SAL would pay every unattributed customer Kuwait City's boost
   * because 'BR-KWC' sorts first. Nobody chose that, and it would be invisible.
   *
   * So a branch boost applies only when the branch is genuinely known — a
   * scanner that sent one. A `branchId: "all"` happy hour has no ambiguity to
   * resolve and applies either way.
   *
   * FLAGGED: the scanner does not send its branch today, and `StaffPrincipal`
   * carries branch ACCESS (`branchAccessAll` / `branchAccessIds`), not a current
   * location, so the server cannot infer one. Until a charge carries the branch
   * it happened at, branch boosts are configurable and inert — loudly, here,
   * rather than quietly wrong.
   */
  branchId: string | null;
  boosts: Array<{ branchId: string; visit: number; topup: number; stamp: number }>;
  windows: HappyHourWire[];
}

/**
 * THE DECISION. Pure — it takes the rows and an instant and returns what this
 * charge or top-up earns, so it is testable without a database and cannot
 * accidentally read a clock of its own.
 *
 * `now` is passed in rather than taken here for the reason the replay case
 * demands: a charge is evaluated ONCE, at one instant, inside the money
 * transaction. An idempotent replay returns the stored answer; it does not
 * re-run this against the replay clock, which is the boundary bug that pays
 * twice.
 */
export function decideEarning(input: PromotionInputs, now: Date): EarningDecision {
  const offset = offsetFor(input.salon, now);

  const decision: EarningDecision = { ...NO_PROMOTION, decidedAt: now };

  // ---- branch boosts. Always on, no window, scoped to the branch charged at --
  // Skipped entirely when the branch is not known — see `PromotionInputs.branchId`.
  const b = input.branchId
    ? input.boosts.find((x) => x.branchId === input.branchId)
    : undefined;
  if (b) {
    decision.visitMultiplier = Math.max(decision.visitMultiplier, b.visit);
    decision.stampMultiplier = Math.max(decision.stampMultiplier, b.stamp);
    decision.topupBonusPercent = Math.max(decision.topupBonusPercent, b.topup);
  }

  // ---- happy hours. THE SHARED PREDICATE, resolved against the salon's zone --
  //
  // Every window is tested, not just the one `activeHappyHour` would show as a
  // banner: that function answers "which countdown does the customer see" by
  // picking the window closest to ending, which is the right question for a
  // banner and the wrong one for an earning rate. The rate is the best offer
  // that is actually live.
  const live = input.windows.filter(
    (w) =>
      // `all` needs no branch to be known. A branch-scoped window does, and an
      // unknown branch is not a match — same reasoning as the boost above.
      (w.branchId === 'all' || (input.branchId !== null && w.branchId === input.branchId)) &&
      isHappyHourLive(w, now, offset),
  );

  for (const w of live) {
    const effect = rewardEffect(w.reward);
    const before = { ...decision };

    decision.visitMultiplier = Math.max(decision.visitMultiplier, effect.visitMultiplier);
    decision.stampMultiplier = Math.max(decision.stampMultiplier, effect.stampMultiplier);
    decision.topupBonusPercent = Math.max(decision.topupBonusPercent, effect.topupBonusPercent);
    // Flat credit is granted ONCE however many windows offer it — `max`, not a
    // sum. Two overlapping `credit3` windows are one 3.000 KD credit.
    decision.creditFils = Math.max(decision.creditFils, effect.creditFils);

    // Attribute to the window that actually moved something. A live window whose
    // reward was already beaten by a boost has not earned the customer anything
    // and must not be recorded as the reason.
    const moved =
      decision.visitMultiplier !== before.visitMultiplier ||
      decision.stampMultiplier !== before.stampMultiplier ||
      decision.topupBonusPercent !== before.topupBonusPercent ||
      decision.creditFils !== before.creditFils;

    if (moved) {
      decision.happyHourId = w.id;
      decision.minutesRemaining = minutesRemaining(w, now, offset);
    }
  }

  return decision;
}

/**
 * Load everything `decideEarning` needs, inside the caller's transaction.
 *
 * Read INSIDE the money transaction, never before it: a promotion switched off
 * between a pre-read and the commit would otherwise still be paid out, and the
 * merchant would be funding a window she had already closed.
 */
export async function loadPromotionInputs(
  exec: Executor,
  salonId: string,
  branchId: string | null,
): Promise<PromotionInputs | null> {
  const salonRows = await exec
    .select({ id: salon.id, timezone: salon.timezone })
    .from(salon)
    .where(eq(salon.id, salonId))
    .limit(1);
  const s = salonRows[0];
  if (!s) return null;

  const [boostRows, happyRows] = await Promise.all([
    branchId === null
      ? Promise.resolve([])
      : exec
          .select()
          .from(boost)
          .where(and(eq(boost.salonId, salonId), eq(boost.branchId, branchId))),
    // `on: false` rows are loaded and handed to the predicate rather than
    // filtered out here. `isHappyHourLive` refuses them on its first line, and
    // letting the shared function be the only thing that decides is the point.
    exec.select().from(happyHour).where(eq(happyHour.salonId, salonId)),
  ]);

  return {
    salon: s,
    branchId,
    boosts: boostRows.map((b) => ({
      branchId: b.branchId,
      visit: b.visit,
      topup: b.topup,
      stamp: b.stamp,
    })),
    windows: happyRows.map(serialiseHappyHour),
  };
}

/**
 * Has this window ever paid out?
 *
 * `DELETE .../happy-hours/{hid}` removes the row, and `transaction.promotion_id`
 * is `ON DELETE restrict`, so a window that has been applied cannot be deleted —
 * the database would refuse with a foreign key error, which reaches a merchant
 * as a 500. Asked here instead so she gets a sentence: switch it off, the record
 * of what it paid stays.
 */
export async function hasBeenApplied(exec: Db, happyHourId: string): Promise<boolean> {
  const rows = await exec
    .select({ id: transaction.id })
    .from(transaction)
    .where(eq(transaction.promotionId, happyHourId))
    .limit(1);
  return rows.length > 0;
}
