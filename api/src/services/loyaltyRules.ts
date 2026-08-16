/**
 * Validating a loyalty configuration before it is published.
 *
 * build-plan.md phase 4: "Tier rule edits validate thresholds and publish
 * atomically." This module is the first half. The second half — atomicity — is
 * not code at all, it is the shape of the data: `salon.tiers` is ONE jsonb
 * column, so a four-rung ladder is written by a single UPDATE and cannot land
 * half applied. See routes/loyalty.ts.
 *
 * WHY THE RULES ARE HERE AND NOT IN THE HANDLER
 * --------------------------------------------
 * There are two doors into `salon.tiers`: the publish endpoint, and the general
 * `PATCH /salons/{id}` that already listed `tiers` as editable. A validator
 * living in one handler is a validator the other route does not have, and the
 * unvalidated door is the one that matters — it is the one nobody is watching.
 * Both call `parseLoyaltyConfig`.
 *
 * WHY ALL FOUR TIERS, ALWAYS
 * --------------------------
 * `member.tier` is a `tier_name` enum column holding one of bronze / silver /
 * gold / black, and `services/topup.ts` prices a bonus by looking the member's
 * stored tier up in the published ladder:
 *
 *     s.tiers?.find((t) => t.name === m.tier)?.bonusPercent ?? 0
 *
 * Publish a ladder with `gold` removed and every Gold member's bonus silently
 * becomes 0 — not at her next visit, when the tier would be re-evaluated, but at
 * her next TOP-UP, which is sooner and is money. The `?? 0` is correct
 * defensive code and it is exactly what makes the failure quiet.
 *
 * So the ladder is all four rungs or it is refused. That is not a limitation
 * invented here: design/AVO Merchant Dashboard.dc.html § Loyalty renders exactly
 * four cards, Bronze locked and three editable, and the database enum has
 * exactly four values.
 */

import { fils, percentOf, type Fils } from '@avo/types';
import type { Tier } from '@avo/types';
import { badRequest } from '../http/errors';

/**
 * The ladder, bottom to top. Order is meaningful: index 0 is the floor everyone
 * starts on and each rung must sit strictly above the one below it.
 */
export const TIER_LADDER = ['bronze', 'silver', 'gold', 'black'] as const;

export type LadderTierName = (typeof TIER_LADDER)[number];

/** Display names, for copy that a merchant reads. Matches the design's cards. */
const TIER_LABEL: Record<LadderTierName, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  black: 'Black',
};

/**
 * The preview amount behind the design's "10 → 11 KD" line.
 *
 * 10.000 KD, as integer fils, because it is money and non-negotiable #1 admits
 * no exceptions for a number that is only ever displayed. The design computes
 * this in the browser with `10 + 10 * pct / 100`; computing it here as well —
 * and with `percentOf`, the same function `services/topup.ts` uses to price the
 * real bonus — is what makes the preview a promise rather than a coincidence.
 * A rounding rule that lives in two places has already disagreed.
 */
export const PREVIEW_TOPUP_FILS: Fils = fils(10_000);

export interface TierPreview {
  name: LadderTierName;
  minVisits: number;
  bonusPercent: number;
  /** Always 10000. Named rather than implied so a client cannot assume it. */
  topUpFils: number;
  /** What 10.000 KD actually credits at this tier. `topUpFils` + the bonus. */
  creditFils: number;
  /** The merchant-funded bonus on its own. */
  bonusFils: number;
}

export interface LoyaltyConfig {
  mode: 'tiers' | 'stamps';
  tiers: Tier[] | null;
  stampTarget: number | null;
  stampReward: string | null;
  stampRewardAr: string | null;
}

function requireInt(value: unknown, field: string, label: string): number {
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    /**
     * The dashboard's inputs are `inputMode="numeric"` text fields, so "12"
     * arrives as a string from an unmodified client. Accepted for whole numbers
     * only — "12.5" and "" are still refused below, because a fractional visit
     * threshold is not a formatting difference, it is a different rule.
     */
    return Number(value.trim());
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest('invalid_tier', `${label}: ${field} must be a whole number.`);
  }
  return value;
}

/**
 * Validate a whole tier ladder.
 *
 * Refusals carry the design's own copy where the design wrote it — "Must be more
 * visits than Silver" is the warning under the offending card in
 * AVO Merchant Dashboard.dc.html, and the dashboard renders the server's message
 * rather than re-deriving it, so the two cannot say different things about the
 * same ladder.
 */
export function parseTiers(value: unknown): Tier[] {
  if (!Array.isArray(value)) {
    throw badRequest('invalid_tiers', 'tiers must be an array of four rungs, Bronze first.');
  }
  if (value.length !== TIER_LADDER.length) {
    throw badRequest(
      'invalid_tiers',
      `A ladder has all four tiers — ${TIER_LADDER.map((t) => TIER_LABEL[t]).join(', ')}. Got ${value.length}.`,
    );
  }

  const out: Tier[] = [];
  for (let i = 0; i < TIER_LADDER.length; i += 1) {
    const expected = TIER_LADDER[i]!;
    const label = TIER_LABEL[expected];
    const row = value[i];

    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw badRequest('invalid_tier', `${label}: expected { name, minVisits, bonusPercent }.`);
    }
    const t = row as Record<string, unknown>;

    /**
     * Position decides identity, not the other way round. Accepting the four
     * rungs in any order and sorting them would let a ladder name Gold at index
     * 1, and every reader of the array — the dashboard's cards, this validator's
     * "above the tier below" check — assumes bottom-to-top.
     */
    if (t.name !== expected) {
      throw badRequest(
        'invalid_tier',
        `Tier ${i + 1} must be ${label}. The ladder is fixed: ${TIER_LADDER.join(' → ')}.`,
      );
    }

    const minVisits = requireInt(t.minVisits, 'minVisits', label);
    const bonusPercent = requireInt(t.bonusPercent, 'bonusPercent', label);

    if (minVisits < 0) {
      throw badRequest('invalid_tier', `${label}: visits cannot be negative.`);
    }
    if (bonusPercent < 0 || bonusPercent > 100) {
      throw badRequest('invalid_tier', `${label}: bonus must be between 0 and 100 percent.`);
    }

    if (i === 0) {
      /**
       * BRONZE IS LOCKED. The design draws it with no inputs and the caption
       * "No bonus · not editable", and both halves are load-bearing:
       *
       *   minVisits must be 0   — it is the tier a member is on before her first
       *                           visit. `tierForVisits` returns the highest rung
       *                           whose minVisits is met, so a Bronze floor above
       *                           0 leaves a brand-new member on NO tier, and
       *                           `member.tier` is nullable, so nothing complains.
       *
       *   bonusPercent must be 0 — "Bonus credit is funded by you, not AVO". A
       *                           Bronze bonus is a bonus paid to every customer
       *                           on every top-up forever, which is not a loyalty
       *                           ladder, it is a discount. If a salon wants one,
       *                           that is a product decision, not a form field.
       */
      if (minVisits !== 0) {
        throw badRequest(
          'bronze_is_locked',
          'Bronze is where everyone starts, so its threshold is 0 visits and cannot be changed.',
        );
      }
      if (bonusPercent !== 0) {
        throw badRequest(
          'bronze_is_locked',
          'Bronze carries no bonus. Set the bonus on Silver and above.',
        );
      }
    } else {
      const below = out[i - 1]!;
      const belowLabel = TIER_LABEL[TIER_LADDER[i - 1]!];
      // The design's own warning copy, verbatim: 'Must be more visits than ' + prev.name
      if (minVisits <= below.minVisits) {
        throw badRequest(
          'threshold_not_above_tier_below',
          `${label}: must be more visits than ${belowLabel} (${below.minVisits}).`,
          { tier: expected, minVisits, below: { tier: TIER_LADDER[i - 1], minVisits: below.minVisits } },
        );
      }
    }

    out.push({ name: expected, minVisits, bonusPercent });
  }

  return out;
}

/**
 * What 10.000 KD credits at each rung, priced by the same function that prices
 * the real thing. `services/topup.ts`:
 *
 *     const bonus = percentOf(input.amountFils, bonusPercent);
 *     const credit = add(input.amountFils, bonus);
 */
export function previewLadder(tiers: Tier[]): TierPreview[] {
  return tiers.map((t) => {
    const bonus = percentOf(PREVIEW_TOPUP_FILS, t.bonusPercent);
    return {
      name: t.name as LadderTierName,
      minVisits: t.minVisits,
      bonusPercent: t.bonusPercent,
      topUpFils: PREVIEW_TOPUP_FILS,
      bonusFils: bonus,
      creditFils: PREVIEW_TOPUP_FILS + bonus,
    };
  });
}

function parseStampTarget(value: unknown): number {
  const n = requireInt(value, 'stampTarget', 'Stamps');
  if (n < 1) {
    throw badRequest('invalid_stamp_target', 'A stamp card needs at least one stamp.');
  }
  if (n > 50) {
    // Not arbitrary: the wallet renders the card as a grid of dots, and a card
    // nobody can finish is a loyalty scheme that reads as a con.
    throw badRequest('invalid_stamp_target', 'A stamp card of more than 50 stamps is not a card.');
  }
  return n;
}

/** An empty string is not a translation — routes/salons.ts § NULLABLE_ARABIC. */
function parseOptionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw badRequest('invalid_request', `${field} must be a string or null.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The whole loyalty configuration, validated against the mode it claims.
 *
 * `current` supplies the fields the request does not mention, so a publish that
 * only moves Gold's threshold does not have to resend the stamp reward. The
 * result is always COMPLETE — every column this touches has a value — which is
 * what lets the caller write it as one UPDATE.
 */
export function parseLoyaltyConfig(
  body: Record<string, unknown>,
  current: LoyaltyConfig,
): LoyaltyConfig {
  let mode = current.mode;
  if ('loyaltyMode' in body) {
    const v = body.loyaltyMode;
    if (v !== 'tiers' && v !== 'stamps') {
      throw badRequest('invalid_request', 'loyaltyMode must be "tiers" or "stamps".');
    }
    mode = v;
  }

  if (mode === 'tiers') {
    const suppliesTiers = 'tiers' in body;
    /**
     * WHEN A *STORED* LADDER IS RE-VALIDATED, AND WHEN IT IS LEFT ALONE.
     *
     * The first version of this validated `current.tiers` unconditionally, on
     * the reasoning that a ladder stored before these rules existed should not
     * become publishable merely by being touched. Lane D's tenancy suite caught
     * what that actually does: `PATCH /salons/{id} { stampTarget: 8 }` against a
     * salon holding a two-rung legacy ladder answered
     *
     *     400 A ladder has all four tiers — Bronze, Silver, Gold, Black. Got 2.
     *
     * for a request that never mentioned tiers. That is not a guard, it is a
     * salon locked out of editing anything until it republishes a ladder it did
     * not ask to change — and refusing the edit does not repair the stored row,
     * so it buys nothing either.
     *
     * The narrower rule: a stored ladder is validated when the request PUTS IT
     * INTO EFFECT, which is exactly two cases — the request supplies a ladder,
     * or it switches the mechanic to `tiers` and so makes the stored one live.
     * A request that leaves both alone passes the ladder through untouched.
     */
    const activatesStoredTiers = !suppliesTiers && current.mode !== 'tiers';

    const tiers = suppliesTiers ? parseTiers(body.tiers) : current.tiers;
    if (!tiers) {
      /**
       * The CHECK `salon_loyalty_config_complete` refuses this at the database
       * too. Caught here so a salon switching stamps → tiers with no ladder gets
       * a sentence naming what is missing, rather than a constraint-violation
       * 500 — routes/staff.ts gives the same reasoning for the void/charges pair.
       */
      throw badRequest(
        'tiers_required',
        'A tiers salon needs a tier ladder. Send all four rungs with this change.',
      );
    }
    return {
      mode,
      tiers: activatesStoredTiers ? parseTiers(tiers) : tiers,
      /**
       * The stamp fields are KEPT, not cleared. A salon that trials tiers for a
       * month and switches back should find its stamp card where it left it, and
       * `salon_loyalty_config_complete` only requires the side that is active.
       */
      stampTarget: current.stampTarget,
      stampReward: current.stampReward,
      stampRewardAr: current.stampRewardAr,
    };
  }

  const suppliesTarget = 'stampTarget' in body;
  /** The mirror of `activatesStoredTiers` above, and for the same reason. */
  const activatesStoredTarget = !suppliesTarget && current.mode !== 'stamps';

  const stampTarget = suppliesTarget ? parseStampTarget(body.stampTarget) : current.stampTarget;
  if (stampTarget === null) {
    throw badRequest(
      'stamp_target_required',
      'A stamps salon needs a stamp target. Send stampTarget with this change.',
    );
  }
  return {
    mode,
    tiers: current.tiers,
    stampTarget: activatesStoredTarget ? parseStampTarget(stampTarget) : stampTarget,
    stampReward:
      'stampReward' in body ? parseOptionalText(body.stampReward, 'stampReward') : current.stampReward,
    stampRewardAr:
      'stampRewardAr' in body
        ? parseOptionalText(body.stampRewardAr, 'stampRewardAr')
        : current.stampRewardAr,
  };
}

/** A one-line summary of what changed, for the audit log's Detail column. */
export function describeLoyaltyChange(before: LoyaltyConfig, after: LoyaltyConfig): string {
  const parts: string[] = [];

  if (before.mode !== after.mode) {
    parts.push(`mechanic ${before.mode} → ${after.mode}`);
  }

  if (after.mode === 'tiers' && after.tiers) {
    const wasByName = new Map((before.tiers ?? []).map((t) => [t.name, t]));
    for (const t of after.tiers) {
      const was = wasByName.get(t.name);
      if (!was) {
        parts.push(`${TIER_LABEL[t.name as LadderTierName]} added at ${t.minVisits} visits`);
        continue;
      }
      // The design's own audit line: "Gold threshold 10 → 12 visits".
      if (was.minVisits !== t.minVisits) {
        parts.push(
          `${TIER_LABEL[t.name as LadderTierName]} threshold ${was.minVisits} → ${t.minVisits} visits`,
        );
      }
      if (was.bonusPercent !== t.bonusPercent) {
        parts.push(
          `${TIER_LABEL[t.name as LadderTierName]} bonus ${was.bonusPercent}% → ${t.bonusPercent}%`,
        );
      }
    }
  }

  if (after.mode === 'stamps' && before.stampTarget !== after.stampTarget) {
    parts.push(`stamp target ${before.stampTarget ?? '—'} → ${after.stampTarget}`);
  }
  if (before.stampReward !== after.stampReward) {
    parts.push(`stamp reward "${before.stampReward ?? '—'}" → "${after.stampReward ?? '—'}"`);
  }

  return parts.length > 0 ? parts.join(' · ') : 'no effective change';
}
