/**
 * The money endpoints on the scanner: charge, today's charges, void.
 *
 * `POST /charges` had NO authority check at all in the mock — it debited a
 * wallet unconditionally. It now requires `perms.scanner`, checked as the first
 * statement of the handler, before the body is parsed and before the token is
 * resolved.
 *
 * `POST /voids` moves money back into a wallet, so non-negotiable #4 applies to
 * it as much as to a charge: a retried void with no key is a double refund.
 *
 * THE REPLAY WRAPPER
 * ------------------
 * `withIdempotency` is the pattern every money-moving POST here uses:
 *
 *     try { …one transaction that claims the key and does the work… }
 *     catch (unique violation) { …read the winner's stored response, replay it… }
 *
 * The claim happens INSIDE the transaction, so the database — not a Map, not an
 * `if` — resolves two simultaneous requests. The loser does not compute a second
 * result and does not guess; it waits for the winner's committed response and
 * returns it verbatim. See services/idempotency.ts for why the check-then-act
 * version passes Lane D's suite on the mock and would not survive here.
 */

import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fils, formatMoney } from '@avo/types';
import { db } from '../db/client';
import { booking } from '../db/schema/booking';
import { member } from '../db/schema/member';
import { ledgerEntry } from '../db/schema/ledger';
import { chargeReversedPosting } from '../money/ledger';
import { readTransactionRevenue } from '../money/revenue';
import {
  transaction,
  VOID_REASON_CODES,
  type VoidReasonCode,
} from '../db/schema/transaction';
import { requireScannerPerm, hasScenario } from '../auth/principal';
import { env } from '../env';
import { badRequest, conflict, notFound } from '../http/errors';
import { parseAmountFils, requireString, requireStringArray } from '../money/validate';
import {
  awaitCommittedKey,
  claimKey,
  completeKey,
  hashRequestBody,
  isUniqueViolation,
  principalScope,
  readIdempotencyKey,
  violatedConstraint,
} from '../services/idempotency';
import {
  CUSTOM_AMOUNT_MAX_FILS,
  performCharge,
  VOID_WINDOW_MINUTES,
} from '../services/charge';
import { chargeScannerBudget } from '../services/scannerLimit';
import { writeAudit } from '../services/audit';
import type { StaffPrincipal } from '../auth/principal';
import { nextTransactionId } from '../services/ids';

/**
 * Lane D pins the low-balance case with `x-avo-scenario: lowbal`, which the mock
 * served by substituting a hardcoded balance. A real API cannot fabricate a
 * balance without lying about the money, so under the test flag the scenario
 * selects a SEEDED low-balance member instead. The handler then runs completely
 * unmodified — the 402 it produces is a real shortfall against a real row.
 */
const LOWBAL_MEMBER_ID = '8843';

function resolveMemberId(req: FastifyRequest, requested: string): string {
  if (env.testPrincipals && hasScenario(req, 'lowbal')) return LOWBAL_MEMBER_ID;
  return requested;
}

/** Claim-inside-the-transaction, replay-on-duplicate. */
async function withIdempotency<T>(
  params: { scope: string; endpoint: string; key: string; requestHash: string },
  run: () => Promise<T>,
): Promise<{ status: number; body: unknown }> {
  try {
    const result = await run();
    return { status: 200, body: result };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    /**
     * NOT EVERY UNIQUE VIOLATION IS AN IDEMPOTENCY-KEY COLLISION, and assuming
     * so is what made a double void answer "still being processed".
     *
     * Two voids of one charge under two DIFFERENT keys race; one wins; the loser
     * violates `transaction_reverses_uq`, not the key index. Falling through to
     * the replay below would search for a committed response under a key that
     * never collided, find nothing, and report a transient condition for a state
     * that is permanent. `performVoid` catches the ordinary sequential case with
     * a read; this is the same truth told for the race.
     */
    if (violatedConstraint(err) === 'transaction_reverses_uq') {
      throw conflict(
        'already_voided',
        'That charge has already been voided. The customer was refunded to her wallet.',
      );
    }

    // Another request holds this key. Wait for its committed response and
    // replay it byte for byte rather than computing a second one.
    const stored = await awaitCommittedKey(db, params);
    if (stored) return stored;

    throw conflict(
      'request_in_progress',
      'That request is still being processed. Try again in a moment.',
    );
  }
}

export async function registerChargeRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------- POST /charges --
  app.post('/charges', async (req, reply) => {
    // FIRST. A wallet is not debited by a principal with no scanner authority —
    // and not from a browser tab, whatever authority it holds.
    const p = requireScannerPerm(req, 'scanner');

    // Then the key — a money-moving POST without one is refused before any work.
    const key = readIdempotencyKey(req);

    const body = (req.body ?? {}) as Record<string, unknown>;

    /**
     * SECOND, AND ABOVE THE BUDGET: is this caller allowed to NAME A PRICE?
     *
     * `wantsCustom` is read here, before `chargeScannerBudget`, because that call
     * WRITES — a `scanner_attempt` row, which is the whole point of it
     * (services/scannerLimit.ts: "a refusal is an attempt"). Non-negotiable #7
     * wants authority decided before any work, and a permission gate that sits
     * after a write is a gate that lets an unauthorised caller spend the till's
     * shared budget. Reading `req.body` costs nothing: fastify has already parsed
     * it, and this line does not touch the database.
     *
     * The gate itself, and the whole argument for `perms.void` over `perms.charges`
     * and `perms.scanner`, is at `custom` below.
     */
    const wantsCustom = 'amountFils' in body;
    if (wantsCustom) {
      requireScannerPerm(req, 'void');
    }

    /**
     * The till's budget — BEFORE any transaction is opened. See
     * services/scannerLimit.ts § WHERE THE CHECK SITS for why this line is here
     * and not four frames down inside `performCharge`, which is where it was until
     * a concurrency probe proved that version deadlocks the connection pool.
     */
    await chargeScannerBudget(db, p, 'charge');

    const memberId = resolveMemberId(req, requireString(body.memberId, 'memberId', 100));

    /**
     * ========================================================================
     * A CUSTOM AMOUNT — A PRICE A MANAGER TYPED.  (migration 0049)
     * ========================================================================
     * The scanner could only ever charge what was on the service menu. A salon
     * doing something the menu does not name had no way to take the money
     * through AVO at all. Aftab ruled the authority to type a figure to
     * MANAGERS; what follows is the shape of it.
     *
     * ------------------------------------------------------------------------
     * THE GATE IS ON THE PRESENCE OF THE FIELD, NOT ON THE BRANCH TAKEN.
     * ------------------------------------------------------------------------
     * This is the single most important line in the feature and it is easy to
     * write the other way round. The tempting version checks the permission
     * inside the `if (custom)` branch, or — worse — ignores `amountFils` when the
     * caller lacks authority and prices the basket instead. Both are wrong, and
     * the second is a silent money bug of exactly the class the idempotency
     * addendum rules against: a staff member types 40.000, the server charges the
     * menu's 8.000, and the response says the charge succeeded. She has no way to
     * learn that a different number moved.
     *
     * So an `amountFils` in the body is a CLAIM OF AUTHORITY, and it is answered
     * before it is read. `'amountFils' in body` — not a truthiness test — so a
     * `null`, a `0` and a string all reach the refusal rather than being dropped.
     *
     * ------------------------------------------------------------------------
     * WHY `perms.void`, AND WHY NOT THE OTHER TWO.
     * ------------------------------------------------------------------------
     *   `scanner` is the base permission every artist on the floor holds — it is
     *       what "can scan & charge" means, and gating on it would be no gate.
     *
     *   `charges` is a READ. api-contract.md § StaffUser: "can open Today's
     *       charges ON THE SCANNER". It is senior because the day's takings and
     *       every customer's name are on that screen, but it moves no money.
     *       Reusing a read to grant a write is precisely the overload
     *       `auth/principal.ts § StaffPerms.loyalty` spends forty lines
     *       apologising for — a permission whose name stopped describing what it
     *       controls, now unrenameable without a four-way break. Doing it
     *       deliberately a second time to save a migration would be repeating a
     *       mistake this codebase has already written down. It is also concretely
     *       wrong: `charges: true, void: false` is the supervisor shape — trusted
     *       to read the till, not to move money — and it is exactly the person
     *       who must not be able to invent a price.
     *
     *   `void` is the senior scanner WRITE: "can reverse a charge within 15 min",
     *       and it implies `charges` both in `permsOf` and at the database. It is
     *       a staff member's own judgement substituted for what the menu said,
     *       moving money outside the catalogue. A custom amount is structurally
     *       the same authority pointed the other way — a void decides this visit
     *       was worth nothing, a custom amount decides it was worth 25.000 — and
     *       it is operationally "manager", which is the ruling.
     *
     * ------------------------------------------------------------------------
     * THE COST OF NOT ADDING A TENTH PERMISSION, STATED RATHER THAN BURIED.
     * ------------------------------------------------------------------------
     * A void is BOUNDED — it can only return what was already taken, only within
     * fifteen minutes. A custom amount is unbounded and forward-looking. So
     * `void` is strictly LESS authority than what it is now gating, and granting
     * it today silently widens what every existing holder can do tomorrow.
     *
     * That is a real consequence and the alternative is a tenth permission —
     * `perms.customAmount` — which would be the honest gate and is a four-way
     * break a lane may not make: `PERMISSION_NAMES`, `PERM_COLUMN`, a
     * `staff_user` column, `StaffPermsSchema` in trunk-owned `packages/types`,
     * `PERMISSION_COPY`, the Accounts → Team chips in Lane C's column and Lane
     * D's permission census all move together. Escalated, not done.
     *
     * What makes the widening survivable in the meantime is that it is not
     * silent where it matters: every custom charge is a `custom_amount = true`
     * row with a required reason, its own audit action, and a fifteen-minute
     * void window.
     *
     * THE CHECK ITSELF IS HOISTED, twenty lines up, above `chargeScannerBudget`.
     * It has to be: that call writes a `scanner_attempt` row, and an authority
     * decided after a write is decided too late. The argument lives here, beside
     * the field it is about; the statement lives where it can be first.
     */

    /**
     * EXACTLY ONE PRICING SOURCE. Both is refused rather than resolved by
     * precedence, because every precedence rule is a rule somebody has to know:
     * a client that sends a basket AND a figure has lost track of what it is
     * charging, and silently picking one would charge a number nobody chose. The
     * same refusal `POST /charges` gives a repeated service id, for the same
     * reason it gives it.
     */
    if (wantsCustom && body.serviceIds !== undefined) {
      throw badRequest(
        'ambiguous_pricing',
        'Send either serviceIds or amountFils, not both. A custom amount replaces the basket.',
      );
    }

    const serviceIds = wantsCustom ? [] : requireStringArray(body.serviceIds, 'serviceIds');

    /**
     * The figure, and the words beside it.
     *
     * `parseAmountFils` is the money boundary — it refuses a non-number, a NaN, a
     * fraction (the 18.5-means-18.500-KD mix-up), zero and anything negative,
     * each with a 400 a client can act on rather than the 500 a bare `fils()`
     * would produce. Non-negotiable #1: what reaches `performCharge` is a branded
     * `Fils` and no float has touched it.
     *
     * THE CEILING. `services/charge.ts § CUSTOM_AMOUNT_MAX_FILS` carries the
     * argument in full, including the honest limit of what a ceiling buys. The
     * short version: an unbounded number field on a money path is a decision
     * nobody made, the balance check is loosest exactly where a typo is most
     * expensive, and 200.000 KD bounds the blast radius without blocking
     * anything a salon legitimately does in one visit.
     *
     * THE REASON IS REQUIRED. A menu charge is self-describing; a custom one has
     * no service row anywhere and `best-selling-services` cannot attribute it, so
     * this string is the only thing that will ever answer "what was this for".
     * 300 characters, matching the owner adjustment's reason — the other place
     * this product makes somebody justify a number in a free-text field.
     */
    const custom = wantsCustom
      ? (() => {
          const amountFils = parseAmountFils(body.amountFils);
          if (amountFils > CUSTOM_AMOUNT_MAX_FILS) {
            /**
             * `formatMoney`, NOT A HAND-ROLLED `/ 1000 .toFixed(3)`.
             *
             * `packages/types/src/money.ts` is the display boundary and the only
             * sanctioned place money stops being an integer. It also groups
             * thousands, which matters precisely here: a figure large enough to
             * hit this ceiling is a figure a staff member needs to read at a
             * glance, and `1,500.000 KD` is legible where `1500.000 KD` is the
             * number she just mistyped in a different costume.
             *
             * Sibling strings in this file and in `services/charge.ts` still
             * build money by hand. They are unchanged deliberately — Lane D and
             * the scanner assert on several of them verbatim — and converting
             * them is a mechanical pass of its own rather than a rider on this
             * one. Reported.
             */
            throw badRequest(
              'amount_above_ceiling',
              `A custom amount cannot exceed ${formatMoney(fils(CUSTOM_AMOUNT_MAX_FILS))}. ` +
                `Check the figure — ${formatMoney(amountFils)} looks like a typing mistake.`,
              { maxFils: CUSTOM_AMOUNT_MAX_FILS, amountFils },
            );
          }
          return { amountFils, reason: requireString(body.reason, 'reason', 300) };
        })()
      : undefined;

    /**
     * A REPEATED SERVICE ID IS REFUSED, AND IT USED TO BE SILENTLY COLLAPSED.
     *
     * `performCharge` prices the basket with `inArray(service.id, serviceIds)`, which
     * returns one row per DISTINCT id, and sums those rows. So `[SV-01, SV-01]` was
     * charged as ONE blow-dry: 8.000 KD for two, and the salon absorbed the
     * difference with nothing anywhere recording that it had. The `unknown` check
     * could not catch it either, because it compares against a Set.
     *
     * WHY REFUSE RATHER THAN PRICE PER OCCURRENCE. Both are defensible and refusing
     * is the one that cannot be wrong about money: pricing per occurrence would
     * change what an existing client is charged, and no client asks for it — the
     * scanner builds `serviceIds` from a Set (`apps/scanner/src/screens/MemberScreen.tsx:136`)
     * and cannot produce a duplicate. So the collapse was unreachable from the
     * scanner and reachable from anything else, and closing it costs nobody a
     * behaviour they had. A basket that genuinely needs two of one service needs
     * quantities, which is a contract change and not a thing to infer from a
     * repeated string.
     *
     * The same refusal `POST /orders` gives a repeated `productId`, by name, for the
     * same reason: a client that has lost track of its own basket should be told.
     */
    const duplicates = serviceIds.filter((id, i) => serviceIds.indexOf(id) !== i);
    if (duplicates.length > 0) {
      throw badRequest(
        'duplicate_services',
        `${[...new Set(duplicates)].join(', ')} appears more than once in serviceIds. ` +
          'A service is charged once per basket.',
        { duplicates: [...new Set(duplicates)] },
      );
    }

    const token = typeof body.token === 'string' && body.token.trim() !== '' ? body.token.trim() : undefined;

    /**
     * The explicit confirm for the near-duplicate guard — DECISIONS.md item 3, and
     * `services/charge.ts § NEAR_DUPLICATE_WINDOW_SECONDS` carries the reasoning.
     *
     * REFUSED IF IT IS NOT A BOOLEAN, rather than coerced. `confirmDuplicate: "no"`
     * and `confirmDuplicate: 1` are both truthy, and a string that reads as a refusal
     * turning into a confirmation is the one coercion on this endpoint that moves
     * money. The same treatment `POST /auth/member/signup` gives its `wa` flag, for
     * the same reason it gives it: "Leaving it out would turn it on."
     */
    if ('confirmDuplicate' in body && typeof body.confirmDuplicate !== 'boolean') {
      throw badRequest(
        'invalid_confirm',
        'confirmDuplicate must be true or false. It authorises a second charge for the same basket.',
      );
    }
    const confirmDuplicate = body.confirmDuplicate === true;

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /charges',
      key,
      /**
       * `confirmDuplicate` IS DELIBERATELY NOT IN THE HASH. It is a decision about
       * how to handle a refusal, not part of what is being charged, so the confirmed
       * retry is the SAME request finally allowed to proceed rather than a different
       * one. Including it would answer that retry with a 422
       * `idempotency_key_reused` — the client would have to mint a new key to confirm,
       * which is precisely the state where a lost response causes a double charge.
       */
      /**
       * THE TYPED FIGURE IS IN THE HASH, and leaving it out would be the exact
       * defect api-contract.md's idempotency addendum was written about: "a
       * customer who retries a 5 KD top-up as 50 KD would be shown a 5 KD success
       * and never learn the 50 never happened." Same key, different amount is a
       * 422 naming the mismatch — not a replay, and not a second charge.
       *
       * THE REASON IS IN IT TOO. It lands on the row and in the audit log as the
       * only description of what the money was for, so two different reasons under
       * one key are two different requests. Unlike `confirmDuplicate` below, it is
       * part of WHAT IS BEING CHARGED rather than a decision about how to handle a
       * refusal.
       */
      requestHash: hashRequestBody({
        memberId,
        serviceIds,
        token: token ?? null,
        custom: custom ? { amountFils: custom.amountFils, reason: custom.reason } : null,
      }),
    };

    const { status, body: out } = await withIdempotency(idem, () =>
      performCharge(
        db,
        { memberId, serviceIds, token, confirmDuplicate, custom },
        {
          principal: p,
          idempotency: idem,
          ipAddress: req.ip ?? null,
          userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
        },
      ),
    );

    return reply.code(status).send(out);
  });

  // -------------------------------------------------------------- GET /charges --
  /**
   * perms.charges — "senior permission", api-contract.md § StaffUser, which
   * spells the surface out too: "can open Today's charges ON THE SCANNER". The
   * merchant dashboard has no today's-charges screen; its only mention of
   * `charges` and `void` is the Accounts → Team permission editor, where they
   * are labels on a checkbox, not actions.
   *
   * So this is scanner-scoped like the charge itself. The list names every
   * customer charged today with amounts — reading it from an unattended browser
   * tab is a smaller harm than debiting from one, but it is the same door.
   */
  app.get('/charges', async (req, reply) => {
    const p = requireScannerPerm(req, 'charges');

    const since = new Date();
    since.setHours(0, 0, 0, 0);

    /**
     * THE VOID IS A SEPARATE ROW, so the list has to go and look for it.
     *
     * A void is a compensating `adjustment` pointing back at the charge through
     * `reverses_transaction_id` — the charge itself is never edited. That is
     * right for the ledger and wrong for this screen, which was rendering a
     * refunded charge identically to a live one and offering "Void this charge"
     * a second time. The staff member then tapped it in front of the customer
     * and got an error for doing what the screen invited.
     *
     * A self-join rather than a second query, so the flag cannot disagree with
     * the row it is attached to. `reverses_transaction_id` is uniquely indexed,
     * so this matches at most one reversal per charge and the join cannot
     * duplicate a row.
     */
    const reversal = alias(transaction, 'reversal');

    const rows = await db
      .select({ charge: transaction, reversal })
      .from(transaction)
      .leftJoin(reversal, eq(reversal.reversesTransactionId, transaction.id))
      .where(
        and(
          eq(transaction.salonId, p.salonId),
          eq(transaction.kind, 'charge'),
          gte(transaction.createdAt, since),
        ),
      )
      .orderBy(desc(transaction.createdAt))
      .limit(200);

    return reply.send({
      items: rows.map(({ charge: t, reversal: v }) => ({
        id: t.id,
        memberId: t.memberId,
        branchId: t.branchId,
        kind: t.kind,
        amountFils: t.amountFils,
        bonusFils: t.bonusFils,
        method: t.method,
        status: t.status,
        reference: t.reference,
        createdAt: t.createdAt.toISOString(),
        /**
         * WHETHER THIS PRICE WAS TYPED, and the reason if it was.
         *
         * The same argument `voidedAt` carries two fields down: this screen was
         * rendering a charge that somebody had invented the price of identically
         * to one that came off the menu, and the person most likely to be looking
         * at it is a manager reviewing the day. Both fields are always present and
         * `null`/`false` is a positive statement — not typed — rather than an
         * omission a client has to interpret.
         */
        customAmount: t.customAmount,
        note: t.customAmount ? t.note : null,
        /**
         * Both, and deliberately not one.
         *
         * `voidedAt` is what the list renders — "Voided 14:32" is the sentence a
         * human reads. `reversedByTransactionId` is what makes it auditable: it
         * names the refund row, so "where did the money go" is answerable from
         * the screen the question is asked on rather than from a ledger export.
         * Null on a live charge, and null is a positive statement here — not
         * voided — which is why the fields are always present rather than
         * omitted when absent.
         */
        voidedAt: v ? v.createdAt.toISOString() : null,
        reversedByTransactionId: v ? v.id : null,
      })),
      nextCursor: null,
    });
  });

  // --------------------------------------------------------------- POST /voids --
  /**
   * A void is a compensating `adjustment` row pointing back at the charge, not
   * an edit of it — the ledger and the transaction table are both append-only in
   * spirit and the unique index on `reverses_transaction_id` makes "void once" a
   * database fact rather than a handler's good intentions.
   *
   * Refunds are wallet credit. Non-negotiable #5: no cash, no card reversal, on
   * any surface, ever.
   *
   * Scanner-scoped. A void moves money back into a wallet inside a 15-minute
   * window — it is the undo of something that just happened at the counter, in
   * front of the customer, and the design puts it there: `Void` appears
   * throughout AVO Staff Scanner.dc.html and nowhere in the dashboard but the
   * permission editor. If the window has closed, the merchant reimburses; there
   * is no dashboard path back into a wallet, by design.
   */
  app.post('/voids', async (req, reply) => {
    const p = requireScannerPerm(req, 'void');
    const key = readIdempotencyKey(req);

    /**
     * A void draws on the SAME budget as a scan and a charge —
     * services/scannerLimit.ts § ONE BUDGET FOR ALL THREE argues why: the thing
     * being protected is the till, so three separate budgets would be three doors
     * into it. Before the transaction, for the reason the charge above is.
     */
    await chargeScannerBudget(db, p, 'void');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const transactionId = requireString(body.transactionId, 'transactionId', 100);
    // Every void carries a reason into the audit log — api-contract.md § Operations.
    if (typeof body.reason !== 'string' || body.reason.trim() === '') {
      throw badRequest('reason_required', 'A void needs a reason.');
    }
    /**
     * A CAP, ADDED HERE RATHER THAN BY SWITCHING TO `requireString`.
     *
     * `requireString` would refuse the empty case as `invalid_request`, and
     * `reason_required` is pinned by `e2e/permissions.test.ts`,
     * `e2e/scanner.test.ts` and `packages/mock`. So the empty refusal keeps its
     * code and the length refusal gets its own.
     *
     * WHY A CAP AT ALL. This string lands in `transaction.note`, in the audit
     * log's `detail`, and — through `describeTransaction` — in the sentence the
     * merchant's Overview feed and the platform console's live feed both render.
     * It was bounded only by Fastify's 256 KiB `bodyLimit` (`app.ts`), so any
     * client holding a scanner token could write a quarter of a megabyte into
     * three staff screens. 300 is generous for the longest written label the
     * design offers and short enough to render.
     */
    if (body.reason.trim().length > 300) {
      throw badRequest('invalid_request', 'reason is too long.');
    }
    const reason = body.reason.trim();
    /**
     * THE CODE, AND WHY IT IS OPTIONAL.
     *
     * `reason` is what the audit log records in words; `reasonCode` is what an
     * artist's day renders (`GET /artists/me/bookings` § voidReason). They are
     * not redundant — see migration 0050 — and this one is optional because
     * every client that exists today sends only the label, and a required field
     * would 400 the till on deploy. Absent means NULL, which the screen renders
     * as nothing, which is what it renders now.
     *
     * VALIDATED AGAINST THE CONSTANT, not merely typed. An unknown code is a 400
     * rather than a stored NULL: silently dropping it would leave a client
     * believing it had recorded a reason, which is the failure mode this whole
     * slice exists to close.
     */
    let reasonCode: VoidReasonCode | null = null;
    if (body.reasonCode !== undefined && body.reasonCode !== null) {
      if (
        typeof body.reasonCode !== 'string' ||
        !(VOID_REASON_CODES as readonly string[]).includes(body.reasonCode)
      ) {
        throw badRequest(
          'invalid_reason_code',
          `reasonCode must be one of ${VOID_REASON_CODES.join(', ')}.`,
        );
      }
      reasonCode = body.reasonCode as VoidReasonCode;
    }

    const idem = {
      scope: principalScope(p),
      endpoint: 'POST /voids',
      key,
      /**
       * `reasonCode` joins the hash. #4's guarantee is that one key names one
       * request: a retry that changes the recorded reason is a DIFFERENT void
       * request, and the conflict is the honest answer rather than silently
       * replaying the first body's code.
       */
      requestHash: hashRequestBody({ transactionId, reason, reasonCode }),
    };

    const { status, body: out } = await withIdempotency(idem, () =>
      performVoid(transactionId, reason, reasonCode, p, req, idem),
    );

    return reply.code(status).send(out);
  });
}

/** The void, as one transaction. Same shape of guarantee as the charge. */
async function performVoid(
  targetId: string,
  reason: string,
  reasonCode: VoidReasonCode | null,
  principal: StaffPrincipal,
  req: FastifyRequest,
  idem: { scope: string; endpoint: string; key: string; requestHash: string },
) {
  return db.transaction(async (tx) => {
    const keyId = await claimKey(tx, idem);

    const rows = await tx
      .select()
      .from(transaction)
      .where(and(eq(transaction.id, targetId), eq(transaction.salonId, principal.salonId)))
      .limit(1);
    const target = rows[0];
    if (!target) throw notFound('unknown_transaction', 'No such charge.');
    if (target.kind !== 'charge') {
      throw badRequest('not_voidable', 'Only a charge can be voided.');
    }

    /**
     * ALREADY VOIDED IS ITS OWN ANSWER, not a retryable one.
     *
     * Without this the second void reached the insert, violated
     * `transaction_reverses_uq`, and `withIdempotency` — which assumed every
     * unique violation was an idempotency-key collision — answered `409
     * request_in_progress`. The scanner then told the staff member "that request
     * is still being processed, try again in a moment", in front of the
     * customer: wrong, an invitation to try a third time, and concealing the
     * actual state, which is that the charge was already refunded.
     *
     * The money was never at risk — the unique index held, and still does. This
     * is about telling the truth. `already_voided` is a different sentence and a
     * different screen.
     *
     * The read is inside the money transaction, so it cannot go stale between
     * check and insert; the index below is still what makes "void once" true
     * under a genuine race, and the catch in the caller translates that case to
     * the same error rather than letting it read as transient.
     */
    const existingReversal = await tx
      .select({ id: transaction.id })
      .from(transaction)
      .where(eq(transaction.reversesTransactionId, target.id))
      .limit(1);
    if (existingReversal[0]) {
      throw conflict(
        'already_voided',
        'That charge has already been voided. The customer was refunded to her wallet.',
      );
    }

    // The 15-minute window. Past it, the merchant reimburses instead.
    const age = Date.now() - target.createdAt.getTime();
    if (age > VOID_WINDOW_MINUTES * 60_000) {
      throw conflict(
        'void_window_closed',
        `A charge can only be voided within ${VOID_WINDOW_MINUTES} minutes. Reimburse the customer instead.`,
      );
    }

    const memberRows = await tx
      .select()
      .from(member)
      .where(eq(member.id, target.memberId))
      .for('update')
      .limit(1);
    const m = memberRows[0];
    if (!m) throw notFound('unknown_member', 'No such member.');

    /**
     * THE REFUND IS WHAT THE VISIT WAS WORTH, AND THAT IS NOW ONE DEFINITION.
     *
     * `abs(target.amountFils)` alone was right while deposits did not exist and
     * became a silent under-refund the moment they did. The charge row records
     * what was debited AFTER the deposit was applied — 3.000, on the design's
     * 8.000 service with a 5.000 deposit — so refunding only that hands back
     * three of the eight the customer actually paid, and the other five stays
     * with the salon for a visit that has just been declared not to have
     * happened.
     *
     * This file used to compute that here, from the ledger, with three predicates
     * written out inline — and it was the ONLY place in the build that had the
     * arithmetic right. `sales` and `best-selling-services` both summed
     * `-amount_fils` and understated every booked appointment by its deposit for
     * their whole life (DECISIONS.md #81). So the expression moved to
     * `money/revenue.ts` and the `transaction_revenue` view behind it, and this
     * handler now reads the same relation the reports do.
     *
     * `earnedFils` IS the refund, and it is the reports' revenue column too. That
     * is not a coincidence to be tidied away: "what the salon must give back if
     * this is voided" and "what the salon earned" are one quantity, which is the
     * whole argument for there being one definition of it.
     *
     * The view reads the applied deposit from the LEDGER rather than from the
     * booking, and that is deliberate: the `deposit_held` debit on this
     * transaction is exactly what was applied, already net of any remainder that
     * was handed straight back at charge time (services/charge.ts § 7a). Reading
     * `booking.deposit_fils` instead would refund a remainder she has already
     * received.
     *
     * A NULL HERE IS NOT ZERO. The view covers settled `charge` and `shop` rows,
     * and `target` is one by the query above — so null means the row moved
     * underneath us, and the throw rolls the whole void back rather than
     * refunding nothing and reporting success.
     */
    const worth = await readTransactionRevenue(tx, target.id);
    if (!worth) {
      throw conflict('charge_not_voidable', 'That charge is no longer a settled charge.', {
        chargeId: target.id,
      });
    }
    const depositApplied = worth.depositAppliedFils;
    const refund = worth.earnedFils;
    const balanceAfter = fils(m.balanceFils + refund);
    const now = new Date();
    const voidId = await nextTransactionId(tx);

    /**
     * The booking the deposit came from, if there was one. Its money is going
     * back to the customer, so it cannot stay `completed` — that status asserts
     * the salon earned the deposit. It becomes `cancelled`, settled by the void,
     * which is the closest true statement: the appointment's money returned to
     * her wallet.
     *
     * It does NOT become `deposit_held` again. The deposit is not held any more;
     * it is spendable balance, and a booking claiming a hold that no ledger entry
     * backs is the kind of disagreement the whole state machine exists to prevent.
     * A customer who still wants the appointment rebooks, and holds again.
     */
    const [heldBooking] = depositApplied
      ? await tx
          .select({ id: booking.id })
          .from(booking)
          .where(eq(booking.settledTransactionId, target.id))
          .for('update')
          .limit(1)
      : [undefined];

    await tx
      .update(member)
      .set({ balanceFils: balanceAfter, visits: Math.max(0, m.visits - 1), updatedAt: now })
      .where(eq(member.id, m.id));

    // A compensating row. The unique index on reverses_transaction_id is what
    // makes a second void of the same charge impossible, whatever two concurrent
    // scanner taps believe.
    await tx.insert(transaction).values({
      id: voidId,
      memberId: m.id,
      salonId: principal.salonId,
      branchId: target.branchId,
      // Inherited with the branch, not re-derived. A reversal is attributed
      // exactly as confidently as the charge it undoes — claiming `false` here
      // would launder a guessed branch into an established one on the way back.
      branchAssumed: target.branchAssumed,
      kind: 'adjustment',
      amountFils: refund,
      method: 'wallet',
      status: 'settled',
      reference: `AVO-VOID-${voidId.slice(3)}`,
      note: reason,
      /**
       * The same fact, twice, on purpose: the words for the record and the code
       * for the screen. `transaction_void_reason_code_is_reversal_only` makes
       * this the only INSERT in the API that may carry a non-null code, because
       * it is the only one that sets `reverses_transaction_id`.
       */
      voidReasonCode: reasonCode,
      reversesTransactionId: target.id,
      createdByStaffId: principal.id,
      createdAt: now,
      settledAt: now,
    });

    await tx.insert(ledgerEntry).values(
      chargeReversedPosting({
        transactionId: voidId,
        salonId: principal.salonId,
        memberId: m.id,
        amountFils: refund,
        balanceAfterFils: balanceAfter,
      }),
    );

    /**
     * The whole refund comes out of `salon_revenue`, INCLUDING the deposit
     * portion, and that is correct rather than a shortcut: the deposit stopped
     * being a `deposit_held` liability the moment the charge discharged it into
     * revenue (services/charge.ts § 7). Crediting `deposit_held` back here would
     * reopen a liability nobody holds and leave that account permanently out.
     */
    if (heldBooking) {
      await tx
        .update(booking)
        .set({
          status: 'cancelled',
          settledTransactionId: voidId,
          completedAt: null,
          cancelledAt: now,
          updatedAt: now,
        })
        .where(eq(booking.id, heldBooking.id));
    }

    await writeAudit(tx, principal, {
      salonId: principal.salonId,
      kind: 'money',
      action: 'Charge voided',
      detail:
        `${(refund / 1000).toFixed(3)} KD returned to ${m.name} · ${reason}` +
        (depositApplied > 0
          ? ` · includes ${(depositApplied / 1000).toFixed(3)} KD of held deposit`
          : ''),
      source: 'scanner',
      subjectType: 'transaction',
      subjectId: target.id,
      amountFils: refund,
      metadata: {
        reason,
        voidTransactionId: voidId,
        chargedFils: Math.abs(target.amountFils),
        depositReturnedFils: depositApplied,
        bookingId: heldBooking?.id ?? null,
      },
      ipAddress: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    });

    const result = {
      ok: true,
      refundedFils: refund,
      /**
       * Broken out, because "8.000 was returned" on a charge whose row says
       * −3.000 is a number the staff member cannot reconcile in front of the
       * customer without being told where the other five came from.
       */
      depositReturnedFils: depositApplied,
      bookingId: heldBooking?.id ?? null,
      visitRemoved: true,
    };
    await completeKey(tx, keyId, { status: 200, body: result }, voidId);
    return result;
  });
}

export { sql };
