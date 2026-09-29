/**
 * THE SALON'S OWN BOOKING POLICY — what it says, how it is validated, what it
 * decides, and the bell notice each publish writes.
 *
 * DECISIONS.md § "The fourth list, 2026-09-29, and four rulings from Aftab",
 * "Booking deposit: the salon's own policy replaces the return window", is the
 * specification. Migration 0066 carries the storage argument.
 *
 * =========================================================================
 * WHAT A POLICY DECIDES, AND WHAT IT DOES NOT
 * =========================================================================
 *   no-show        `keep` → the deposit is forfeited to the salon.
 *                  `return` → it goes back to her wallet.
 *                  Applied when staff mark the no-show (after `starts_at`) or when
 *                  the slot ends (`ends_at` + `BOOKING_SETTLE_GRACE_MINUTES`, 60 by
 *                  default, so she can still be charged at the till), whichever
 *                  is first — trunk's rulings.
 *   her cancel     up to three `{ hoursBefore, returnPercent }`. The first rule
 *                  whose threshold she meets wins; later than all of them, 0%.
 *                  `returnPercent` of integer fils, ROUNDED DOWN; the salon keeps
 *                  the remainder fil (`splitDeposit`).
 *   salon cancel   ALWAYS the full deposit back. Trunk's ruling: she did nothing
 *                  wrong. Not configurable, so not in the policy.
 *
 * Whatever comes back is wallet credit — non-negotiable #5. There is no path
 * from here to cash or a card.
 *
 * =========================================================================
 * THE BOOKING STAMPS THE POLICY; THIS FILE NEVER RE-READS IT FOR A BOOKING
 * =========================================================================
 * `createBooking` copies the published version's rules and text onto the row
 * (`booking.policy_*`). Every settle path reads the STAMP, never the salon's
 * current policy, so a later publish cannot change what an existing booking
 * returns. `booking_policy` is append-only for `avo_app`, so the version the
 * stamp names cannot change either.
 *
 * =========================================================================
 * LEGACY — A BOOKING WITH NO STAMP KEEPS TODAY'S BEHAVIOUR EXACTLY
 * =========================================================================
 * Every booking made before 0066, and every booking made at a salon that has
 * never published a policy. What "today's behaviour" is, stated from the code
 * rather than from memory:
 *
 *   her cancel     the FULL deposit back, and REFUSED inside the last
 *                  `BOOKING_CHANGE_WINDOW_MINUTES` (60) before `starts_at` with
 *                  409 `change_window_closed` — "after that the deposit stays with
 *                  the salon" was always enforced by refusing the cancel, never by
 *                  keeping money. No Idempotency-Key required (one is honoured if
 *                  sent); the FOR UPDATE transition is the double-refund guard.
 *   no-show        the FULL deposit back, automatically, at the stamped
 *                  `no_show_return_due_at` (= `ends_at` + the salon's
 *                  `no_show_return_minutes` at booking time), or earlier by a
 *                  manual mark after `starts_at`.
 *   salon cancel   the FULL deposit back.
 *   reschedule     the deadline is recomputed from `salon.no_show_return_minutes`,
 *                  which is now frozen at whatever each salon last set: the
 *                  merchant can no longer write it (routes/salons.ts).
 *
 * So a legacy booking never forfeits anything, which is the property the int
 * spec "a pre-migration booking keeps legacy behaviour" pins.
 */

import { desc, eq, sql } from 'drizzle-orm';
import {
  fils,
  percentOfFloor,
  subtract,
  type BookingPolicy,
  type BookingPolicyStamp,
  type Fils,
} from '@avo/types';
import type { Db } from '../db/client';
import {
  bookingPolicy,
  memberPolicyNotice,
  type CancellationRule,
  type NoShowRule,
} from '../db/schema/bookingPolicy';
import { salon } from '../db/schema/salon';
import type { StaffPrincipal } from '../auth/principal';
import { badRequest, notFound } from '../http/errors';
import { salonWallClock } from '../time/zone';
import { writeAudit, type Executor } from './audit';

export type { CancellationRule, NoShowRule };

// ------------------------------------------------------------- the bounds --

/** "Up to three" — the ruling. Restated in 0066's `booking_cancellation_rules_valid`. */
export const MAX_CANCELLATION_RULES = 3;
/**
 * Thirty days. A cut-off further out than any booking a salon takes is a rule that
 * can never be missed, which is the same as 100% and a confusing way to write it.
 */
export const MAX_HOURS_BEFORE = 720;
/**
 * Per language. The text is read on the confirm sheet before she books and on the
 * booking afterwards, and it is snapshotted onto every booking made under it, so it
 * is a paragraph, not a document. `LegalDocSchema` is the place for a document.
 */
export const MAX_POLICY_TEXT = 1000;

// ------------------------------------------------------------- the shapes --

export interface PolicyInput {
  noShow: NoShowRule;
  cancellation: CancellationRule[];
  text: { en: string; ar: string };
}

/**
 * The wire shapes are trunk's, from `@avo/types` (b23e78c): `BookingPolicy` for
 * `GET/PUT /salons/{id}/booking-policy` and the customer read, and
 * `BookingPolicyStamp` for the policy a booking carries. The api-local copies
 * this file used to declare are gone. `ar` may be '' and falls back to `en` at
 * the display boundary, as `LegalDocSchema`.
 */
export type { BookingPolicy, BookingPolicyStamp };

type PolicyRow = typeof bookingPolicy.$inferSelect;

export function serialisePolicy(row: PolicyRow): BookingPolicy {
  return {
    id: row.id,
    salonId: row.salonId,
    version: row.version,
    noShow: row.noShowRule,
    cancellation: row.cancellationRules.map((r) => ({
      hoursBefore: r.hoursBefore,
      returnPercent: r.returnPercent,
    })),
    text: { en: row.textEn, ar: row.textAr },
    publishedAt: row.publishedAt.toISOString(),
  };
}

// --------------------------------------------------------------- parsing --

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isWholeNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v);

/**
 * The cut-off rules, refused with a code per failure so the editor can put the
 * sentence beside the row that caused it. `index` in the details is 0-based.
 */
export function parseCancellationRules(value: unknown): CancellationRule[] {
  if (!Array.isArray(value)) {
    throw badRequest(
      'invalid_cancellation_rules',
      'cancellation must be a list of { hoursBefore, returnPercent } rules.',
    );
  }
  if (value.length > MAX_CANCELLATION_RULES) {
    throw badRequest(
      'too_many_cancellation_rules',
      `A policy can have at most ${MAX_CANCELLATION_RULES} cancellation rules.`,
      { max: MAX_CANCELLATION_RULES, got: value.length },
    );
  }

  const rules: CancellationRule[] = [];
  value.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      throw badRequest(
        'invalid_cancellation_rules',
        'Each cancellation rule must be { hoursBefore, returnPercent }.',
        { index },
      );
    }
    const extra = Object.keys(raw).filter((k) => k !== 'hoursBefore' && k !== 'returnPercent');
    if (extra.length > 0) {
      throw badRequest(
        'invalid_cancellation_rules',
        `Unknown field on a cancellation rule: ${extra.join(', ')}.`,
        { index },
      );
    }
    const { hoursBefore, returnPercent } = raw;
    if (!isWholeNumber(hoursBefore) || hoursBefore < 1 || hoursBefore > MAX_HOURS_BEFORE) {
      throw badRequest(
        'invalid_hours_before',
        `hoursBefore must be a whole number of hours from 1 to ${MAX_HOURS_BEFORE}.`,
        { index },
      );
    }
    if (!isWholeNumber(returnPercent) || returnPercent < 0 || returnPercent > 100) {
      throw badRequest(
        'invalid_return_percent',
        'returnPercent must be a whole number from 0 to 100.',
        { index },
      );
    }
    const prev = rules[index - 1];
    if (prev && hoursBefore >= prev.hoursBefore) {
      throw badRequest(
        'hours_before_not_descending',
        'List the cancellation rules from the earliest cut-off to the latest: each ' +
          'hoursBefore must be smaller than the one before it.',
        { index },
      );
    }
    if (prev && returnPercent > prev.returnPercent) {
      throw badRequest(
        'return_percent_increasing',
        'A later cancellation cannot return more than an earlier one: each ' +
          'returnPercent must be no higher than the one before it.',
        { index },
      );
    }
    rules.push({ hoursBefore, returnPercent });
  });
  return rules;
}

function parseText(value: unknown): { en: string; ar: string } {
  if (!isPlainObject(value)) {
    throw badRequest('invalid_policy_text', 'text must be { en, ar }.');
  }
  const extra = Object.keys(value).filter((k) => k !== 'en' && k !== 'ar');
  if (extra.length > 0) {
    throw badRequest('invalid_policy_text', `Unknown field on text: ${extra.join(', ')}.`);
  }
  if (typeof value.en !== 'string' || value.en.trim().length === 0) {
    throw badRequest('invalid_policy_text', 'The policy needs its English text.');
  }
  if (value.ar !== undefined && typeof value.ar !== 'string') {
    throw badRequest('invalid_policy_text', 'text.ar must be a string. Leave it empty to show the English.');
  }
  const en = value.en.trim();
  // An absent or blank Arabic text is stored as '' — the fallback, not a value.
  const ar = typeof value.ar === 'string' ? value.ar.trim() : '';
  for (const [lang, t] of [['en', en], ['ar', ar]] as const) {
    if (t.length > MAX_POLICY_TEXT) {
      throw badRequest(
        'policy_text_too_long',
        `The policy text can be at most ${MAX_POLICY_TEXT} characters.`,
        { lang, max: MAX_POLICY_TEXT, got: t.length },
      );
    }
  }
  return { en, ar };
}

/** The whole `PUT` body. Unknown fields are refused, not ignored. */
export function parsePolicyInput(body: unknown): PolicyInput {
  if (!isPlainObject(body)) {
    throw badRequest('invalid_policy', 'The policy must be { noShow, cancellation, text }.');
  }
  const extra = Object.keys(body).filter(
    (k) => k !== 'noShow' && k !== 'cancellation' && k !== 'text',
  );
  if (extra.length > 0) {
    throw badRequest('invalid_policy', `Unknown field on the policy: ${extra.join(', ')}.`);
  }
  if (body.noShow !== 'keep' && body.noShow !== 'return') {
    throw badRequest(
      'invalid_no_show_rule',
      'noShow must be "keep" (the salon keeps the deposit) or "return" (it goes back to her wallet).',
    );
  }
  return {
    noShow: body.noShow,
    cancellation: parseCancellationRules(body.cancellation),
    text: parseText(body.text),
  };
}

// ------------------------------------------------------------- the maths --

/**
 * `returnPercent` of the deposit, ROUNDED DOWN TO THE FIL; the salon keeps the
 * remainder fil. The ruling, verbatim.
 *
 * THE FLOOR IS `percentOfFloor` FROM @avo/types (trunk, 7c3ac5c). The wallet's
 * cancel preview is to switch to it too, and then the preview and the settlement
 * cannot round differently. The API's own copy of that integer maths is gone. It still
 * refuses a fractional or out-of-range percent and a negative deposit with a
 * RangeError, and never lets a float hold a fractional fil. This function adds
 * only the other half of the split: the salon keeps `deposit - returned`,
 * remainder fil included.
 *
 * NOT `percentOf`, which rounds half UP: at 50% of 5.005 KD it gives 2503, and
 * the ruling says 2502 back.
 */
export function splitDeposit(
  deposit: Fils,
  returnPercent: number,
): { returnedFils: Fils; keptFils: Fils } {
  const returnedFils = percentOfFloor(deposit, returnPercent);
  return { returnedFils, keptFils: subtract(deposit, returnedFils) };
}

export interface CancellationOutcome {
  /** The rule that matched, or null when she is later than every threshold. */
  rule: CancellationRule | null;
  returnPercent: number;
  returnedFils: Fils;
  keptFils: Fils;
}

/**
 * "The first rule whose threshold she meets wins." She meets `hoursBefore` when
 * she cancels at least that many hours before `starts_at` — measured in
 * milliseconds against the server's clock, never the device's. Rules are stored
 * earliest cut-off first, so the first match is the most generous one she still
 * qualifies for. Later than every threshold returns 0%.
 *
 * =========================================================================
 * `capPercent` — THE RESCHEDULE LOOPHOLE (trunk, 2026-09-29; migration 0067)
 * =========================================================================
 * Moving a booking must not buy back a return she had already lost. Under
 * 48h→100% / 24h→50%, a booking 30 hours out returns 50%; moved to next week it
 * would be 100% again. So each of HER reschedules locks in what a cancel would
 * have returned at that instant (`returnPercentAt` against the slot she left,
 * folded by `lockInCap`), and a cancel returns the SMALLER of that cap and what
 * the rules give against the CURRENT slot.
 *
 * WHY A CAP AND NOT "MEASURE EVERY CUT-OFF FROM THE FIRST SLOT FOR EVER". The
 * two agree on the case trunk named — a late move followed by a cancel returns
 * the original slot's percent. They part company only once the ORIGINAL slot's
 * time has gone by, and there the first-slot reading takes money she never
 * lost: she moves a booking from the 5th to the 20th with ten days' notice (100%
 * at the move), then cancels on the 10th, ten days before the appointment that
 * now exists — measured from the 5th, which has passed, that is 0% and the salon
 * keeps the whole deposit. The cap keeps her 100% there and still refuses the
 * buy-back. Reported to trunk.
 *
 * When the cap binds, `rule` is the stamped rule whose percent the cap equals
 * (the one that applied at the move), or null when the cap is below every rule
 * — she moved it later than every threshold.
 */
export function cancellationOutcome(
  rules: readonly CancellationRule[],
  startsAt: Date,
  now: Date,
  deposit: Fils,
  capPercent: number | null = null,
): CancellationOutcome {
  const aheadMs = startsAt.getTime() - now.getTime();
  const matched = rules.find((r) => aheadMs >= r.hoursBefore * 3_600_000) ?? null;
  const byRules = matched ? matched.returnPercent : 0;
  if (capPercent === null || capPercent >= byRules) {
    return { rule: matched, returnPercent: byRules, ...splitDeposit(deposit, byRules) };
  }
  const rule = rules.find((r) => r.returnPercent === capPercent) ?? null;
  return { rule, returnPercent: capPercent, ...splitDeposit(deposit, capPercent) };
}

/** What a cancel at `now` would return, in percent, against the slot at `startsAt`. */
export function returnPercentAt(
  rules: readonly CancellationRule[],
  startsAt: Date,
  now: Date,
  capPercent: number | null = null,
): number {
  return cancellationOutcome(rules, startsAt, now, fils(0), capPercent).returnPercent;
}

/**
 * The cap after one more of her moves: never higher than it was, never higher
 * than what she had at the moment she moved. `least()` across every move.
 */
export function lockInCap(existing: number | null, atMove: number): number {
  return existing === null ? atMove : Math.min(existing, atMove);
}

/** The no-show rule as a split. `keep` keeps everything, `return` returns everything. */
export function noShowOutcome(rule: NoShowRule, deposit: Fils): { returnedFils: Fils; keptFils: Fils } {
  return splitDeposit(deposit, rule === 'return' ? 100 : 0);
}

// ----------------------------------------------------------------- reads --

/** The salon's current version, or null if it has never published one. */
export async function readPublishedPolicy(
  exec: Db | Executor,
  salonId: string,
): Promise<PolicyRow | null> {
  const [row] = await (exec as Db)
    .select()
    .from(bookingPolicy)
    .where(eq(bookingPolicy.salonId, salonId))
    .orderBy(desc(bookingPolicy.version))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------- publish --

function sameAs(row: PolicyRow, input: PolicyInput): boolean {
  return (
    row.noShowRule === input.noShow &&
    row.textEn === input.text.en &&
    row.textAr === input.text.ar &&
    row.cancellationRules.length === input.cancellation.length &&
    row.cancellationRules.every(
      (r, i) =>
        r.hoursBefore === input.cancellation[i]?.hoursBefore &&
        r.returnPercent === input.cancellation[i]?.returnPercent,
    )
  );
}

export interface PublishResult {
  policy: BookingPolicy;
  /** False when the body was identical to the current version: nothing written. */
  published: boolean;
  /** Bell notices written by THIS publish. 0 on the second publish of a salon-day. */
  noticesWritten: number;
}

/**
 * `PUT /salons/{id}/booking-policy`. Publishes version n+1 and writes the bell.
 *
 * ONE TRANSACTION. The version, the notices and the audit row commit together:
 * a notice about a policy that rolled back cannot exist, and neither can a
 * version nobody was told about.
 *
 * THE SALON ROW IS LOCKED to serialise two publishes. Without it both would read
 * version n and both insert n+1; `booking_policy_salon_version_uq` would refuse
 * the second as a 500. With it the second waits and publishes n+2.
 *
 * AN IDENTICAL BODY PUBLISHES NOTHING. `PUT` is idempotent by definition, and a
 * double-submitted Save must not mint two versions. It returns the current
 * version with `published: false`, and writes no notice.
 *
 * THE BELL, COALESCED. One notice per non-erased member, dated the SALON's
 * calendar day, and `member_policy_notice_one_a_day_uq` refuses a second for that
 * day. `NOT EXISTS` keeps the sequence from being drawn for rows that would
 * conflict; `ON CONFLICT DO NOTHING` is what holds when two transactions race
 * past it. No push, no receipt_job, no campaign_send: this is a record in her
 * bell, not a message, which is why it does not go through campaign approval and
 * why the daily limit — not an approval — is what keeps it from becoming a route
 * around non-negotiable #8.
 */
export async function publishPolicy(
  db: Db,
  params: {
    salonId: string;
    input: PolicyInput;
    principal: StaffPrincipal;
    ipAddress?: string | null;
    userAgent?: string | null;
    now?: Date;
  },
): Promise<PublishResult> {
  return db.transaction(async (tx) => {
    const [s] = await tx
      .select({ id: salon.id, timezone: salon.timezone })
      .from(salon)
      .where(eq(salon.id, params.salonId))
      .for('update')
      .limit(1);
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    const current = await readPublishedPolicy(tx, s.id);
    if (current && sameAs(current, params.input)) {
      return { policy: serialisePolicy(current), published: false, noticesWritten: 0 };
    }

    const now = params.now ?? new Date();
    const version = (current?.version ?? 0) + 1;
    const [drawn] = (await tx.execute(
      sql`SELECT 'BP-' || nextval('booking_policy_number_seq')::text AS id`,
    )) as unknown as Array<{ id: string }>;
    if (!drawn) throw new Error('booking_policy id draw returned no row');

    const [row] = await tx
      .insert(bookingPolicy)
      .values({
        id: drawn.id,
        salonId: s.id,
        version,
        noShowRule: params.input.noShow,
        cancellationRules: params.input.cancellation,
        textEn: params.input.text.en,
        textAr: params.input.text.ar,
        publishedAt: now,
        publishedByStaffId: params.principal.id,
      })
      .returning();
    if (!row) throw new Error('booking_policy insert returned no row');

    const noticeDate = salonWallClock(now, s.timezone).date;
    const notices = (await tx.execute(sql`
      INSERT INTO ${memberPolicyNotice}
        (id, member_id, salon_id, policy_id, policy_version, notice_date, created_at)
      SELECT 'PN-' || nextval('member_policy_notice_number_seq')::text,
             m.id, ${s.id}, ${row.id}, ${version}, ${noticeDate}::date, ${now.toISOString()}::timestamptz
        FROM member m
       WHERE m.salon_id = ${s.id}
         AND m.erased_at IS NULL
         AND NOT EXISTS (
               SELECT 1 FROM ${memberPolicyNotice} n
                WHERE n.member_id = m.id
                  AND n.salon_id = ${s.id}
                  AND n.notice_date = ${noticeDate}::date)
      ON CONFLICT (member_id, salon_id, notice_date) DO NOTHING
      RETURNING id`)) as unknown as Array<{ id: string }>;

    const summary =
      params.input.cancellation.length === 0
        ? 'no cancellation refunds'
        : params.input.cancellation
            .map((r) => `${r.returnPercent}% from ${r.hoursBefore}h before`)
            .join(', ');

    await writeAudit(tx, params.principal, {
      salonId: s.id,
      kind: 'rules',
      action: 'Booking policy published',
      detail: `Version ${version} · no-show: ${params.input.noShow} · ${summary}`,
      source: 'merchant',
      subjectType: 'booking_policy',
      subjectId: row.id,
      metadata: {
        policyId: row.id,
        version,
        previousVersion: current?.version ?? null,
        noShow: params.input.noShow,
        cancellation: params.input.cancellation,
        noticesWritten: notices.length,
        noticeDate,
      },
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
    });

    return { policy: serialisePolicy(row), published: true, noticesWritten: notices.length };
  });
}
