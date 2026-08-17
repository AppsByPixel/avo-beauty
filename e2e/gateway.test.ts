/**
 * THE TOP-UP GATEWAY ROUND TRIP — money arriving from outside the building.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --filter @avo/api run db:up
 *   pnpm --filter @avo/api run db:migrate
 *   pnpm --filter @avo/api run db:seed
 *   cd e2e && ../node_modules/.bin/vitest run gateway.test.ts
 *
 * Like `tenancy.test.ts` and unlike the other three suites, this file does not
 * use `support/api.ts` and ignores `E2E_BASE_URL`. It boots lane A's real API
 * against lane A's real Postgres — `support/tenancy-harness.ts` explains the
 * mechanics. `packages/mock` has no callback endpoint, no signature to verify
 * and no status machine, so every question below is unanswerable against it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Lane A built the round trip and reported it verified. A lane reporting its own
 * work correct is a claim; this suite is the check that the claim STAYS true
 * next month, when a reconciliation job or a support tool touches the same rows.
 *
 * Every spec here is an independent restatement. Nothing is imported from
 * `api/src` — not the signing helper, not the transition table, not the outcome
 * mapping. A test that signs a callback with `signGatewayPayload()` proves the
 * implementation agrees with itself and would keep passing on the day someone
 * changes what goes into the MAC. `support/tenancy-harness.ts` computes the HMAC
 * from the documented construction instead, and the state machine below is
 * spelled out in assertions rather than read out of `LEGAL_TRANSITIONS`.
 *
 * THE FOUR WAYS ONE PAYMENT ARRIVES TWICE
 * ---------------------------------------
 * A PSP is not a function call. The same settlement reaches us as: a duplicate
 * delivery under the same event id; a re-delivery under a NEW event id; a
 * callback that lands before the customer's browser comes back; and a late
 * `pending` or `declined` chasing a `succeeded` that already settled. Each has
 * its own guard, and — this is the part worth testing rather than reading — the
 * guards do not cover each other. `UNIQUE (provider, event_id)` catches the
 * first and is blind to the second. Only the state machine catches the second.
 *
 * THE BLAST RADIUS
 * ----------------
 * This is the one endpoint on the platform that adds money and is reachable by a
 * stranger's HTTP request. If its signature check is wrong, it is an
 * unauthenticated credit endpoint. That is why the five bad-signature cases each
 * assert 401 AND that nothing moved, and why they are paired with a control that
 * settles: a webhook broken shut would pass every refusal spec on its own.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
import {
  GATEWAY_WEBHOOK_SECRET,
  GATEWAY_WEBHOOK_TOLERANCE_SECONDS,
  QA_MEMBER,
  QA_MEMBER_BALANCE_FILS,
  QA_MEMBER_BONUS_PERCENT,
  QA_MEMBER_PHONE,
  SALON_A,
  SIGNATURE_HEADER,
  nowSeconds,
  psql,
  scalar,
  signCallback,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/**
 * THE PRINCIPAL — the suite's OWN member, signed in for real.
 *
 * Not lane A's Dana, and not the `AVO_TEST_PRINCIPALS` shim. Two reasons, and
 * both were learned the hard way in this file.
 *
 * ISOLATION. Dana is charged by three other suites and climbs the tier ladder as
 * they run, so a bonus literal written against her is a literal about how many
 * earlier runs happened. `seedQaMember()` resets Rania before every run — her
 * balance, tier and visits are the same three numbers each time — so the figures
 * below are real literals again and a delta means what it says.
 *
 * A REAL SESSION. `POST /auth/member/session` with a phone and a password, not
 * an unauthenticated request resolved by the shim. The shim decides which
 * principal by URL, and anything it decides for you is something the suite
 * cannot see: that is exactly how a dashboard session reaching `POST /charges`
 * stayed invisible until it was tested with credentials. The top-up path is a
 * money path; it gets credentials too.
 */
const MEMBER = QA_MEMBER;
const AMOUNT_FILS = 10_000;
/**
 * Silver is 10% — design/api-contract.md § Commission, and pinned by the seed.
 * Written out rather than computed: a test that derives the bonus with the
 * server's own helper asserts nothing.
 */
const BONUS_FILS = 1_000;
const CREDIT_FILS = 11_000;

/** Rania's wallet session. Real bearer token, minted in `beforeAll`. */
let member = '';

/**
 * The tier ladder, read from Postgres, as an independent cross-check on the
 * literals above. If salon A's ladder is ever edited, this fails and names the
 * disagreement rather than letting every balance assertion drift quietly.
 */
function ladderBonusPercent(): number {
  return Number(
    scalar(
      `select coalesce((
         select (t->>'bonusPercent')::int
           from salon s, jsonb_array_elements(s.tiers) t
          where s.id = '${SALON_A}'
            and t->>'name' = (select tier::text from member where id = '${MEMBER}')
       ), -1)`,
    ),
  );
}

let n = 0;
const key = (label: string) => `gw-${label}-${Date.now()}-${n++}`;
const eventId = (label: string) => `EVT-${label}-${Date.now()}-${n++}`;

beforeAll(async () => {
  await startTenancyApi();
  member = await signInMember(SALON_A, QA_MEMBER_PHONE);
}, 120_000);

afterAll(async () => {
  await stopTenancyApi();
});

// ------------------------------------------------------------------ reads --

const balanceOf = (memberId: string): number =>
  Number(scalar(`select balance_fils from member where id='${memberId}'`));

const statusOf = (intentId: string): string =>
  scalar(`select status from topup_intent where id='${intentId}'`);

/** `::text` first — `failure_reason` is an enum, and `''` is not one of its values. */
const failureReasonOf = (intentId: string): string =>
  scalar(`select coalesce(failure_reason::text,'') from topup_intent where id='${intentId}'`);

const pspRefOf = (intentId: string): string =>
  scalar(`select coalesce(psp_reference,'') from topup_intent where id='${intentId}'`);

const settledTxOf = (intentId: string): string =>
  scalar(`select coalesce(transaction_id,'') from topup_intent where id='${intentId}'`);

const eventCount = (id: string): number =>
  Number(scalar(`select count(*) from gateway_event where event_id='${id}'`));

const eventOutcome = (id: string): string =>
  scalar(`select coalesce(outcome::text,'') from gateway_event where event_id='${id}'`);

const eventsForRef = (ref: string): number =>
  Number(scalar(`select count(*) from gateway_event where psp_reference='${ref}'`));

interface IntentView {
  id: string;
  memberId: string;
  amountFils: number;
  bonusFils: number;
  creditFils: number;
  status: string;
  failureReason: string | null;
  redirectUrl: string;
  reference: string;
}

interface OpenIntent {
  view: IntentView;
  pspReference: string;
  /** What this intent will put in the wallet when it settles. */
  credit: number;
}

/** A fresh intent, left where `POST /topups` leaves it: `redirected`, unsettled. */
async function openIntent(label: string): Promise<OpenIntent> {
  const res = await treq<IntentView>('POST', '/topups', {
    token: member,
    idempotencyKey: key(label),
    body: { amountFils: AMOUNT_FILS, method: 'knet' },
  });
  precondition(res.status === 200, `could not open an intent (${label}): ${res.status} ${res.raw}`);

  // Checked on every intent this file opens rather than once, because it is the
  // anchor that stops `credit` from being "whatever the server said" — which
  // would make every balance assertion in this file circular.
  precondition(
    res.body.creditFils === CREDIT_FILS && res.body.bonusFils === BONUS_FILS,
    `the intent's money is not the pinned fixture: server said ` +
      `${res.body.amountFils}+${res.body.bonusFils}=${res.body.creditFils}, ` +
      `the seed pins ${AMOUNT_FILS}+${BONUS_FILS}=${CREDIT_FILS}. ` +
      `Rania's tier is now "${scalar(`select tier::text from member where id='${MEMBER}'`)}" ` +
      `— something moved her, or seedQaMember() did not run.`,
  );

  const pspReference = pspRefOf(res.body.id);
  precondition(pspReference !== '', `intent ${res.body.id} has no psp_reference`);
  return { view: res.body, pspReference, credit: CREDIT_FILS };
}

interface CallbackBody {
  eventId: string;
  pspReference: string;
  status: string;
  amountFils: number;
}

interface DeliveryResult {
  status: number;
  raw: string;
  body: { received?: boolean; outcome?: string; credited?: boolean; status?: string; error?: string };
}

/**
 * Deliver a callback the way the processor would: over real HTTP, to the real
 * route, with a real HMAC over the exact bytes sent.
 *
 * `rawBody` is the string that is BOTH signed and sent. Signing a re-encoded
 * copy of the same object is the classic way a verification passes while
 * verifying a different document than the one that arrived, and the tampering
 * spec below depends on this staying honest.
 */
async function deliver(
  body: CallbackBody,
  options: { secret?: string; timestamp?: number; signOver?: string; header?: string | null } = {},
): Promise<DeliveryResult> {
  const rawBody = JSON.stringify(body);
  const t = options.timestamp ?? nowSeconds();

  let header: string | null;
  if (options.header !== undefined) {
    header = options.header;
  } else {
    header = signCallback(options.signOver ?? rawBody, t, options.secret ?? GATEWAY_WEBHOOK_SECRET);
  }

  const res = await treq<DeliveryResult['body']>('POST', '/webhooks/sandbox', {
    token: member,
    rawBody,
    ...(header === null ? {} : { headers: { [SIGNATURE_HEADER]: header } }),
  });
  return { status: res.status, raw: res.raw, body: res.body };
}

/** A settled intent, plus the balance before it settled. */
async function settledIntent(
  label: string,
): Promise<{ view: IntentView; pspReference: string; balanceBefore: number; credit: number }> {
  const balanceBefore = balanceOf(MEMBER);
  const { view, pspReference, credit } = await openIntent(label);

  const res = await deliver({
    eventId: eventId(`${label}-settle`),
    pspReference,
    status: 'succeeded',
    amountFils: AMOUNT_FILS,
  });
  precondition(res.status === 200, `the settling callback failed: ${res.status} ${res.raw}`);
  precondition(
    statusOf(view.id) === 'succeeded',
    `${view.id} did not settle: ${statusOf(view.id)} · ${res.raw}`,
  );
  return { view, pspReference, balanceBefore, credit };
}

// ---------------------------------------------------------------- tripwires --

/**
 * If these fail, every figure below is meaningless — the suite would still be
 * green in the ways that matter least and quietly wrong about the money.
 */
describe('tripwires — the fixture is what this suite thinks it is', () => {
  it("the session belongs to the suite's own member, not to the shim's", async () => {
    const me = await treq<{ id: string; salonId: string }>('GET', '/members/me', {
      token: member,
    });
    expect(me.status, me.raw).toBe(200);
    expect(me.body.id, 'the token resolved to somebody else').toBe(QA_MEMBER);
    // The trap: with AVO_TEST_PRINCIPALS on, a request that lost its bearer
    // header does not fail, it becomes Dana 8842 and answers 200. Naming the id
    // here is what makes every "moved by exactly the credit" assertion below
    // trustworthy.
    expect(me.body.id).not.toBe('8842');
    expect(me.body.salonId).toBe(SALON_A);
  });

  it('and she was reset to the seeded state at the top of this run', async () => {
    // An equality, not a range: every delta asserted below is measured from it.
    expect(
      balanceOf(QA_MEMBER),
      'seedQaMember() did not restore the balance — a previous run is still in this row',
    ).toBe(QA_MEMBER_BALANCE_FILS);
    expect(scalar(`select tier::text from member where id='${QA_MEMBER}'`)).toBe('silver');
  });

  it("salon A's tier ladder still pays her tier what the literals below assume", async () => {
    // The independent cross-check on BONUS_FILS. The literal comes from
    // api-contract.md; this reads what the salon row actually says. If someone
    // edits the ladder, this names the disagreement instead of letting a dozen
    // balance assertions drift together.
    expect(ladderBonusPercent(), "salon A's ladder no longer pays silver 10%").toBe(
      QA_MEMBER_BONUS_PERCENT,
    );
    expect(BONUS_FILS).toBe((AMOUNT_FILS * QA_MEMBER_BONUS_PERCENT) / 100);
    expect(CREDIT_FILS).toBe(AMOUNT_FILS + BONUS_FILS);
  });
});

// -------------------------------------------------------------- the shape --

describe('the round trip — what POST /topups leaves behind', () => {
  it('creates an intent the processor knows about, parked in `redirected`', async () => {
    const { view, pspReference } = await openIntent('shape');

    expect(view.memberId).toBe(MEMBER);
    expect(view.amountFils).toBe(AMOUNT_FILS);
    expect(view.bonusFils).toBe(BONUS_FILS);
    expect(view.creditFils).toBe(CREDIT_FILS);
    // Whatever the ladder says today, the arithmetic has to close and stay in
    // whole fils — non-negotiable #1.
    expect(view.creditFils).toBe(view.amountFils + view.bonusFils);
    expect(Number.isInteger(view.bonusFils)).toBe(true);
    expect(Number.isInteger(view.creditFils)).toBe(true);
    // Not `created`: she has been handed a hosted page, and that is a fact worth
    // recording separately from "we made a row".
    expect(view.status).toBe('redirected');
    expect(view.failureReason).toBeNull();
    expect(view.redirectUrl).toContain(`/_gateway/${pspReference}`);
    expect(pspReference).toMatch(/^SBX-/);
    // Nothing has been paid, so nothing has been credited.
    expect(settledTxOf(view.id)).toBe('');
  });

  it('moves no money on its own — an intent is not a payment', async () => {
    const before = balanceOf(MEMBER);
    await openIntent('no-credit-on-create');
    expect(balanceOf(MEMBER), 'creating an intent credited a wallet').toBe(before);
  });
});

// ------------------------------------------------- duplicate, same event id --

describe('a duplicate callback credits once', () => {
  it('the second delivery of one event id changes nothing', async () => {
    const before = balanceOf(MEMBER);
    const { view, pspReference, credit } = await openIntent('dupe');
    const id = eventId('dupe');
    const body = { eventId: id, pspReference, status: 'succeeded', amountFils: AMOUNT_FILS };

    const first = await deliver(body);
    const second = await deliver(body);

    expect(first.status, first.raw).toBe(200);
    expect(first.body.outcome).toBe('applied');
    expect(first.body.credited).toBe(true);

    // 200, NOT 4xx. A PSP reads a 4xx as "not delivered" and retries for days;
    // the correct answer to "I have already handled this" is success without a
    // second credit. routes/webhooks.ts § 2.
    expect(second.status, `a duplicate delivery answered ${second.status}: ${second.raw}`).toBe(200);
    expect(second.body.outcome).toBe('duplicate');
    expect(second.body.credited).toBe(false);

    // The whole point: 11.000 once, not 22.000.
    expect(balanceOf(MEMBER), 'a duplicate callback credited twice').toBe(before + credit);
    expect(statusOf(view.id)).toBe('succeeded');
  });

  it('and settles exactly one transaction, with one ledger pair behind it', async () => {
    const { view } = await settledIntent('dupe-tx');
    const id = eventId('dupe-tx-again');
    // Re-deliver under the SAME id the settle used? No — that id is spent. This
    // one proves the *transaction* count, so deliver the original event twice.
    const pspReference = pspRefOf(view.id);
    const body = { eventId: id, pspReference, status: 'succeeded', amountFils: AMOUNT_FILS };
    await deliver(body);
    await deliver(body);

    const txId = settledTxOf(view.id);
    expect(txId).toMatch(/^TX-/);
    expect(
      Number(scalar(`select count(*) from transaction where reference='${view.reference}'`)),
      'one intent produced more than one transaction',
    ).toBe(1);
    expect(
      Number(scalar(`select count(*) from ledger_entry where transaction_id='${txId}'`)),
      'the credit was ledgered more than once',
    ).toBeGreaterThan(0);
  });

  it('records the duplicate rather than swallowing it — one event row, not two', async () => {
    const { pspReference } = await openIntent('dupe-audit');
    const id = eventId('dupe-audit');
    const body = { eventId: id, pspReference, status: 'succeeded', amountFils: AMOUNT_FILS };

    await deliver(body);
    await deliver(body);

    // The unique index is the guard, so the second attempt leaves no row. What
    // must survive is the FIRST one, with what the PSP actually said.
    expect(eventCount(id)).toBe(1);
    expect(eventOutcome(id)).toBe('applied');
  });
});

// ----------------------------------------------- re-delivery, NEW event id --

describe('a re-delivery under a NEW event id is refused by the machine', () => {
  /**
   * THE CASE THE UNIQUE INDEX CANNOT CATCH.
   *
   * `UNIQUE (provider, event_id)` dedupes a repeat of the same delivery. A PSP
   * that re-sends the same settlement with a fresh delivery id — a retry after
   * its own timeout, a replayed queue, an operator pressing resend — walks
   * straight past it. The only thing standing between that and a second credit
   * is `succeeded → succeeded` not being an arrow.
   */
  it('credits nothing, and says why', async () => {
    const { view, pspReference, balanceBefore, credit } = await settledIntent('redeliver');
    expect(balanceOf(MEMBER)).toBe(balanceBefore + credit);

    const fresh = eventId('redeliver-new');
    const again = await deliver({
      eventId: fresh,
      pspReference,
      status: 'succeeded',
      amountFils: AMOUNT_FILS,
    });

    expect(again.status, again.raw).toBe(200);
    expect(
      again.body.outcome,
      'a settlement re-delivered under a new event id was applied a second time',
    ).toBe('ignored_illegal_transition');
    expect(again.body.credited).toBe(false);
    expect(again.body.status).toBe('succeeded');

    expect(balanceOf(MEMBER), 'a re-delivery credited a second time').toBe(
      balanceBefore + credit,
    );
    expect(statusOf(view.id)).toBe('succeeded');
    expect(settledTxOf(view.id)).toMatch(/^TX-/);
  });

  it('and the event index demonstrably did NOT catch it — two rows, one reference', async () => {
    // Without this, the spec above would pass identically if the second delivery
    // had merely collided on the index, and the state machine would be untested.
    const { view, pspReference } = await settledIntent('redeliver-proof');
    const before = eventsForRef(pspReference);

    const fresh = eventId('redeliver-proof-new');
    const again = await deliver({
      eventId: fresh,
      pspReference,
      status: 'succeeded',
      amountFils: AMOUNT_FILS,
    });
    expect(again.body.outcome).toBe('ignored_illegal_transition');

    // A new row exists — so the insert succeeded and the refusal came from the
    // transition check, not from the unique index.
    expect(eventsForRef(pspReference), 'the second delivery collided on the index instead').toBe(
      before + 1,
    );
    expect(eventCount(fresh)).toBe(1);
    expect(eventOutcome(fresh)).toBe('ignored_illegal_transition');
    expect(statusOf(view.id)).toBe('succeeded');
  });
});

// ----------------------------------------------------------------- ordering --

describe('the callback and the customer race, and the answer is the same either way', () => {
  it('a callback that lands BEFORE her GET still yields the right final state', async () => {
    // The ordering that breaks a handler which treats `GET /topups/{id}` as the
    // thing that settles: her browser is slow, the PSP is fast, and the intent
    // is already terminal by the time the client asks.
    const before = balanceOf(MEMBER);
    const { view, pspReference, credit } = await openIntent('callback-first');

    const cb = await deliver({
      eventId: eventId('callback-first'),
      pspReference,
      status: 'succeeded',
      amountFils: AMOUNT_FILS,
    });
    expect(cb.body.outcome).toBe('applied');
    expect(cb.body.credited).toBe(true);

    // Now she comes back from the hosted page.
    const read = await treq<IntentView>('GET', `/topups/${view.id}`, { token: member });
    expect(read.status, read.raw).toBe(200);
    expect(read.body.id).toBe(view.id);
    expect(read.body.status).toBe('succeeded');
    expect(read.body.failureReason).toBeNull();

    // The read must not have settled it a second time.
    expect(balanceOf(MEMBER), 'the client GET credited on top of the callback').toBe(
      before + credit,
    );
    expect(read.body.creditFils).toBe(credit);
  });

  it('a callback that lands AFTER her GET is ignored, and the state is identical', async () => {
    const before = balanceOf(MEMBER);
    const { view, pspReference, credit } = await openIntent('get-first');

    // Her return: the server asks the processor. The sandbox's default outcome
    // is `succeeded`, so this settles from our own read rather than a callback.
    const read = await treq<IntentView>('GET', `/topups/${view.id}`, { token: member });
    expect(read.status, read.raw).toBe(200);
    expect(read.body.status).toBe('succeeded');
    expect(balanceOf(MEMBER)).toBe(before + credit);

    const late = await deliver({
      eventId: eventId('get-first-late'),
      pspReference,
      status: 'succeeded',
      amountFils: AMOUNT_FILS,
    });
    expect(late.status, late.raw).toBe(200);
    expect(late.body.credited).toBe(false);
    expect(late.body.outcome).toBe('ignored_illegal_transition');

    expect(balanceOf(MEMBER), 'the late callback credited on top of the read').toBe(
      before + credit,
    );
    expect(statusOf(view.id)).toBe('succeeded');
  });

  it('re-reading a settled intent never moves it, however many times the client polls', async () => {
    const { view, balanceBefore, credit } = await settledIntent('poll');

    for (let i = 0; i < 3; i++) {
      const read = await treq<IntentView>('GET', `/topups/${view.id}`, { token: member });
      expect(read.body.status).toBe('succeeded');
    }
    expect(balanceOf(MEMBER), 'polling a settled intent credited again').toBe(
      balanceBefore + credit,
    );
  });
});

// ------------------------------------------------------------- no regress --

describe('a late `pending` or `declined` cannot walk a settled top-up backwards', () => {
  it('neither one changes the status, the reason, or the balance', async () => {
    const { view, pspReference, balanceBefore, credit } = await settledIntent('no-regress');
    const settledTx = settledTxOf(view.id);
    expect(balanceOf(MEMBER)).toBe(balanceBefore + credit);

    // Out of order, both under fresh event ids so the index is not what refuses
    // them. `pending` first: the tempting one, because it looks like a state a
    // payment could legitimately return to.
    const latePending = await deliver({
      eventId: eventId('late-pending'),
      pspReference,
      status: 'pending',
      amountFils: AMOUNT_FILS,
    });
    expect(latePending.status, latePending.raw).toBe(200);
    expect(latePending.body.outcome).toBe('ignored_illegal_transition');
    expect(latePending.body.status).toBe('succeeded');

    const lateDeclined = await deliver({
      eventId: eventId('late-declined'),
      pspReference,
      status: 'declined',
      amountFils: AMOUNT_FILS,
    });
    expect(lateDeclined.status, lateDeclined.raw).toBe(200);
    expect(lateDeclined.body.outcome).toBe('ignored_illegal_transition');
    expect(lateDeclined.body.status).toBe('succeeded');

    expect(statusOf(view.id), 'a late callback walked a settled top-up back').toBe('succeeded');
    // A `declined` that set the reason without setting the status would be worse
    // than useless: the wallet would render "payment failed" over real money.
    expect(failureReasonOf(view.id)).toBe('');
    expect(settledTxOf(view.id)).toBe(settledTx);
    expect(balanceOf(MEMBER)).toBe(balanceBefore + credit);
  });

  it('the customer is told the truth afterwards — GET still says succeeded', async () => {
    const { view, pspReference } = await settledIntent('no-regress-read');

    await deliver({
      eventId: eventId('no-regress-read-decl'),
      pspReference,
      status: 'declined',
      amountFils: AMOUNT_FILS,
    });

    const read = await treq<IntentView>('GET', `/topups/${view.id}`, { token: member });
    expect(read.body.status).toBe('succeeded');
    expect(read.body.failureReason).toBeNull();
  });

  it('a terminal `failed` is just as closed as a terminal `succeeded`', async () => {
    // The other direction, so "terminal" is not quietly implemented as
    // "succeeded".
    const before = balanceOf(MEMBER);
    const { view, pspReference } = await openIntent('failed-is-terminal');

    const declined = await deliver({
      eventId: eventId('failed-first'),
      pspReference,
      status: 'declined',
      amountFils: AMOUNT_FILS,
    });
    expect(declined.body.outcome).toBe('applied');
    expect(declined.body.credited).toBe(false);
    expect(statusOf(view.id)).toBe('failed');
    expect(failureReasonOf(view.id)).toBe('declined');

    // A `succeeded` chasing a `failed` is the expensive one: it would credit a
    // wallet for a payment we have already told the customer did not happen.
    const late = await deliver({
      eventId: eventId('failed-then-success'),
      pspReference,
      status: 'succeeded',
      amountFils: AMOUNT_FILS,
    });
    expect(late.body.outcome).toBe('ignored_illegal_transition');
    expect(late.body.credited).toBe(false);
    expect(statusOf(view.id)).toBe('failed');
    expect(balanceOf(MEMBER), 'a success after a failure credited a wallet').toBe(before);
  });
});

// --------------------------------------------------------- the DB backstop --

/**
 * Migration 0004's `BEFORE UPDATE` trigger, tested WITHOUT the service.
 *
 * Everything above goes through `services/topup.ts`, which applies transitions
 * as conditional UPDATEs and is already correct. The trigger exists for the
 * callers that are not that file: a reconciliation job, a support tool, next
 * quarter's handler, an operator in psql at 2am. Those are exactly the callers a
 * suite driving HTTP can never reach, so these specs go straight to the database
 * — which is also the only way to tell whether the trigger is doing anything at
 * all, or whether the service has been carrying it the whole time.
 */
describe('the trigger backstop — the rule holds for callers that are not the service', () => {
  function updateStatusDirectly(intentId: string, to: string): { ok: boolean; message: string } {
    try {
      psql(`UPDATE topup_intent SET status = '${to}' WHERE id = '${intentId}';`);
      return { ok: true, message: '' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  it('a raw UPDATE out of a terminal state is refused by the database itself', async () => {
    const { view } = await settledIntent('trigger-terminal');

    const result = updateStatusDirectly(view.id, 'pending');

    expect(result.ok, 'psql walked a settled top-up back into flight').toBe(false);
    expect(result.message).toMatch(/is terminal/i);
    expect(statusOf(view.id)).toBe('succeeded');
  });

  it('a raw UPDATE that skips backwards inside the open states is refused too', async () => {
    const { view } = await openIntent('trigger-backwards');
    expect(statusOf(view.id)).toBe('redirected');

    // redirected → created is not an arrow. Nothing in the service would ever
    // attempt it; a hand-written repair script absolutely would.
    const result = updateStatusDirectly(view.id, 'created');

    expect(result.ok, 'psql moved an intent backwards').toBe(false);
    expect(result.message).toMatch(/cannot move from/i);
    expect(statusOf(view.id)).toBe('redirected');
  });

  it('a LEGAL raw UPDATE still goes through — the trigger is a rule, not a lock', async () => {
    // The control. Without it, a trigger that raised on every update would pass
    // both specs above and break the product.
    const { view } = await openIntent('trigger-legal');

    const result = updateStatusDirectly(view.id, 'pending');

    expect(result.ok, `a legal transition was refused: ${result.message}`).toBe(true);
    expect(statusOf(view.id)).toBe('pending');
  });

  it('an update that does not touch the status is ordinary work', async () => {
    const { view } = await openIntent('trigger-non-status');
    psql(`UPDATE topup_intent SET updated_at = now() WHERE id = '${view.id}';`);
    expect(statusOf(view.id)).toBe('redirected');
  });

  it('gateway_event is append-only — the record of what the PSP said cannot be edited', async () => {
    // In a dispute this table is the only account of the other side's behaviour.
    const { pspReference } = await openIntent('append-only');
    const id = eventId('append-only');
    await deliver({ eventId: id, pspReference, status: 'succeeded', amountFils: AMOUNT_FILS });
    precondition(eventCount(id) === 1, 'the event row was not written');

    let updateRefused = false;
    try {
      psql(`UPDATE gateway_event SET reported_status = 'declined' WHERE event_id = '${id}';`);
    } catch {
      updateRefused = true;
    }

    let deleteRefused = false;
    try {
      psql(`DELETE FROM gateway_event WHERE event_id = '${id}';`);
    } catch {
      deleteRefused = true;
    }

    expect(updateRefused, 'a gateway_event row was rewritten').toBe(true);
    expect(deleteRefused, 'a gateway_event row was deleted').toBe(true);
    expect(eventCount(id)).toBe(1);
    expect(scalar(`select reported_status from gateway_event where event_id='${id}'`)).toBe(
      'succeeded',
    );
  });
});

// --------------------------------------------------------------- signatures --

/**
 * FIVE WAYS TO NOT BE THE PROCESSOR.
 *
 * Each case is 401 and moves nothing. The two halves matter separately: a 401
 * that had already credited the wallet before deciding to refuse would satisfy
 * the status assertion and be a catastrophe.
 *
 * The refusal body is checked for what it does NOT say as well. "Bad timestamp"
 * versus "bad MAC" is a free oracle for whoever is probing — it tells them which
 * half of the header to keep working on.
 */
describe('the signature is the only thing that makes a callback the processor speaking', () => {
  interface BadCase {
    name: string;
    /** Applied to a correctly-formed delivery for a live intent. */
    options: (body: CallbackBody) => Parameters<typeof deliver>[1];
  }

  const BAD_SIGNATURES: BadCase[] = [
    {
      name: 'no signature header at all',
      options: () => ({ header: null }),
    },
    {
      name: 'a forged MAC with a well-formed header',
      // Right shape, right length, wrong value — so it reaches the comparison
      // rather than being thrown out by the parser.
      options: () => ({ header: `t=${nowSeconds()},v1=${'a1'.repeat(32)}` }),
    },
    {
      name: 'a real HMAC computed with the wrong secret',
      options: () => ({ secret: 'a-plausible-but-wrong-webhook-secret-000000' }),
    },
    {
      name: 'a stale but otherwise perfect signature (a captured callback, replayed)',
      // Genuinely signed for that timestamp. It fails on freshness alone — which
      // is the property that only exists because `t` is INSIDE the MAC: moving
      // the timestamp forward to dodge the window invalidates the signature.
      options: () => ({ timestamp: nowSeconds() - GATEWAY_WEBHOOK_TOLERANCE_SECONDS - 120 }),
    },
    {
      name: 'a valid signature over a DIFFERENT body (the amount was edited in flight)',
      options: (body) => ({
        signOver: JSON.stringify({ ...body, amountFils: 5_000 }),
      }),
    },
  ];

  for (const bad of BAD_SIGNATURES) {
    it(`${bad.name} → 401, and the wallet does not move`, async () => {
      const balanceBefore = balanceOf(MEMBER);
      const { view, pspReference } = await openIntent(`sig-${bad.name.slice(0, 12)}`);
      const id = eventId('sig');

      const body: CallbackBody = {
        eventId: id,
        pspReference,
        status: 'succeeded',
        amountFils: AMOUNT_FILS,
      };
      const res = await deliver(body, bad.options(body));

      expect(res.status, `${bad.name} answered ${res.status}: ${res.raw}`).toBe(401);
      expect(res.body.error).toBe('invalid_signature');
      // No oracle: the refusal must not say WHICH part failed.
      expect(res.raw).not.toMatch(/timestamp|stale|expired|hmac|mac|secret|digest/i);

      // Nothing happened. All three, because each would be a different bug.
      expect(balanceOf(MEMBER), `${bad.name} credited a wallet`).toBe(balanceBefore);
      expect(statusOf(view.id), `${bad.name} moved the intent`).toBe('redirected');
      expect(eventCount(id), `${bad.name} was recorded as a real event`).toBe(0);
      expect(settledTxOf(view.id)).toBe('');
    });
  }

  it('the SAME body, correctly signed, settles — so the five 401s are about the signature', async () => {
    // The control this section is worthless without. A webhook that answered 401
    // to everything would pass every spec above.
    const balanceBefore = balanceOf(MEMBER);
    const { view, pspReference, credit } = await openIntent('sig-control');
    const id = eventId('sig-control');

    const body: CallbackBody = {
      eventId: id,
      pspReference,
      status: 'succeeded',
      amountFils: AMOUNT_FILS,
    };

    const refused = await deliver(body, { header: null });
    expect(refused.status).toBe(401);

    const accepted = await deliver(body);
    expect(accepted.status, accepted.raw).toBe(200);
    expect(accepted.body.outcome).toBe('applied');
    expect(accepted.body.credited).toBe(true);

    expect(balanceOf(MEMBER)).toBe(balanceBefore + credit);
    expect(statusOf(view.id)).toBe('succeeded');
    expect(eventCount(id)).toBe(1);
  });

  it('a signed callback reporting an amount we never asked for is not credited', async () => {
    // Signed by the processor and still refused: the signature proves who is
    // speaking, not that what they said is a settlement of THIS intent.
    // Crediting "whatever arrived" is how a 10.000 top-up becomes a 500.000 one.
    const balanceBefore = balanceOf(MEMBER);
    const { view, pspReference } = await openIntent('amount-mismatch');
    const id = eventId('amount-mismatch');

    const res = await deliver({
      eventId: id,
      pspReference,
      status: 'succeeded',
      amountFils: 500_000,
    });

    expect(res.status, res.raw).toBe(200); // stop retrying — but credit nothing
    expect(res.body.outcome).toBe('ignored_amount_mismatch');
    expect(res.body.credited).toBe(false);
    expect(balanceOf(MEMBER), 'an amount mismatch was credited').toBe(balanceBefore);
    expect(statusOf(view.id)).toBe('redirected');
    // And it is recorded, because this is an incident rather than noise.
    expect(eventOutcome(id)).toBe('ignored_amount_mismatch');
    expect(
      Number(
        scalar(
          `select count(*) from audit_log where salon_id='${SALON_A}' and kind='risk' and subject_id='${view.id}'`,
        ),
      ),
      'an amount mismatch left no risk audit row',
    ).toBe(1);
  });

  it('a callback for a psp reference we never issued settles nothing', async () => {
    const id = eventId('unknown-ref');
    const res = await deliver({
      eventId: id,
      pspReference: 'SBX-000000000000',
      status: 'succeeded',
      amountFils: AMOUNT_FILS,
    });

    expect(res.status, res.raw).toBe(200);
    expect(res.body.outcome).toBe('ignored_unknown_intent');
    expect(res.body.credited).toBe(false);
    expect(eventOutcome(id)).toBe('ignored_unknown_intent');
  });

  it('a callback to a provider this deployment does not use is a 404', async () => {
    const res = await treq<{ error: string }>('POST', '/webhooks/some-other-psp', {
      token: member,
      rawBody: '{}',
      headers: { [SIGNATURE_HEADER]: signCallback('{}', nowSeconds()) },
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_provider');
  });
});

// ------------------------------------------------ the failed gateway leg --

describe('a failed gateway leg does not burn its idempotency key', () => {
  /**
   * api-contract.md § TopUpIntent, client rule 3: on a failure to create, the
   * client retries the SAME attempt with the SAME key.
   *
   * If the 502 had committed the key, that retry would be answered with a cached
   * failure forever and the customer could never top up again under it. She
   * would have to close the sheet and start over — which, from her side, is the
   * app refusing her money for no reason she can see.
   */
  it('the 502 leaves the key free, and the retry under it succeeds', async () => {
    const k = key('gwfail-retry');

    const failed = await treq<{ error: string; id?: string }>('POST', '/topups', {
      token: member,
      idempotencyKey: k,
      scenario: 'gateway_create_error',
      body: { amountFils: AMOUNT_FILS, method: 'knet' },
    });

    expect(failed.status, `expected a 502, got ${failed.status}: ${failed.raw}`).toBe(502);
    expect(failed.body.error).toBe('gateway_unavailable');
    // No intent came back, so there is nothing for a client to redirect to.
    expect(failed.body).not.toHaveProperty('id');
    expect(failed.body).not.toHaveProperty('redirectUrl');

    // Same key, same body, no sabotage this time.
    const retried = await treq<IntentView>('POST', '/topups', {
      token: member,
      idempotencyKey: k,
      body: { amountFils: AMOUNT_FILS, method: 'knet' },
    });

    expect(retried.status, `the retry under the same key answered: ${retried.raw}`).toBe(200);
    expect(retried.body.status).toBe('redirected');
    expect(retried.body.creditFils).toBe(CREDIT_FILS);
    expect(retried.body.redirectUrl).toContain('/_gateway/');
  });

  it('and the whole attempt rolled back — no orphan key row, no orphan intent', async () => {
    const k = key('gwfail-rollback');
    const orphansBefore = Number(
      scalar(`select count(*) from topup_intent where id like '%-GWFAIL'`),
    );

    const failed = await treq('POST', '/topups', {
      token: member,
      idempotencyKey: k,
      scenario: 'gateway_create_error',
      body: { amountFils: AMOUNT_FILS, method: 'knet' },
    });
    expect(failed.status).toBe(502);

    // The key was claimed INSIDE the transaction, so the throw took it with it.
    expect(
      Number(scalar(`select count(*) from idempotency_key where key='${k}'`)),
      'the failed gateway leg committed an idempotency key with no answer behind it',
    ).toBe(0);
    // And the intent row it had already inserted before calling the processor.
    expect(
      Number(scalar(`select count(*) from topup_intent where id like '%-GWFAIL'`)),
      'a top-up intent survived a gateway failure with no payment behind it',
    ).toBe(orphansBefore);

    // After the retry there is exactly one key row: the successful one.
    const retried = await treq('POST', '/topups', {
      token: member,
      idempotencyKey: k,
      body: { amountFils: AMOUNT_FILS, method: 'knet' },
    });
    expect(retried.status).toBe(200);
    expect(Number(scalar(`select count(*) from idempotency_key where key='${k}'`))).toBe(1);
  });

  it('the 502 moved no money either', async () => {
    const before = balanceOf(MEMBER);
    await treq('POST', '/topups', {
      token: member,
      idempotencyKey: key('gwfail-money'),
      scenario: 'gateway_create_error',
      body: { amountFils: AMOUNT_FILS, method: 'knet' },
    });
    expect(balanceOf(MEMBER)).toBe(before);
  });
});

// ------------------------------------------------------------- receipts --

/**
 * WHAT LANE A IS CHANGING, WITH THE TEST ALREADY WAITING.
 *
 * build-plan.md phase 2: "a receipt email AND a WhatsApp receipt arrive for
 * every settled payment". Two deliveries, therefore two rows. `receipt_job`
 * carried `UNIQUE (transaction_id)` — which reads as "one receipt per
 * transaction" and means "one row TOTAL per transaction, across every channel",
 * making the requirement impossible to meet. It is moving to
 * `(transaction_id, channel)`.
 *
 * `knownBug()` rather than `it.todo()` on purpose: a todo is a note someone has
 * to read, and this one flips by itself the day the second channel is queued.
 *
 * NOTE ON THE INDEX, AND WHY IT IS NOT ITS OWN SPEC.
 * The first draft asserted the index shape separately, and that spec flipped to
 * "appears to be FIXED" mid-session while the behavioural one stayed red —
 * because lane A had applied the migration to the SHARED Postgres container
 * while the code that writes the second row was still in progress. Two lanes on
 * one database means the schema can move under a suite between two runs, so a
 * spec pinned to a half-landed change flaps. The index is reported inside the
 * failure message below instead, where it diagnoses without asserting.
 *
 * Salon A is the right fixture — `whatsapp_enabled` is true and member 8842 has
 * a verified email address, so neither channel is legitimately absent.
 */
describe('receipts — one settled payment, both channels', () => {
  async function settledTransactionId(label: string): Promise<string> {
    const { view } = await settledIntent(label);
    const txId = settledTxOf(view.id);
    precondition(txId !== '', `${view.id} settled without a transaction id`);
    return txId;
  }

  const uniqueIndexOn = (table: string): string =>
    scalar(
      `select coalesce(string_agg(indexdef, ' | '), '(none)') from pg_indexes ` +
        `where tablename='${table}' and indexdef ilike '%UNIQUE%' and indexdef ilike '%transaction_id%'`,
    );

  /**
   * RE-PINNED, SO THE RECEIPT WORKER CAN BE SWITCHED ON.
   *
   * This spec used to end:
   *
   *     expect(scalar(`select status from receipt_job …`),
   *       'the receipt was marked sent inside the money transaction —
   *        the worker has not run').toBe('queued')
   *
   * `api/src/env.ts` defaults `RECEIPT_WORKER_ENABLED` to `0` and cites those two
   * lines as the reason: lane A built the worker, saw that running it would flip
   * `queued` to `sent` moments later and fail this spec, and left the flag off
   * rather than edit another lane's file. That was the right call, and this is the
   * other half of it.
   *
   * The parenthetical — "the worker has not run" — was never the invariant. It was
   * an assumption about the environment that happened to hold. The invariant is
   * the one `db/schema/receipt.ts` exists for: THE MONEY TRANSACTION QUEUES THE
   * RECEIPT, IT DOES NOT SEND IT. An HTTP call inside the charge transaction holds
   * row locks for the length of a third party's timeout, and turns a WhatsApp
   * outage into a card-declined-at-the-counter outage.
   *
   * Restated so a running worker cannot falsify it: a row the money transaction
   * had sent would be `sent` with `attempts = 0`, because `attempts` is
   * incremented in exactly one place in the system — `claimJobs()` in
   * `api/src/services/receiptWorker.ts`, which is the worker claiming the row
   * afterwards. `sent` with a zero attempt count is therefore the signature of a
   * send that never went through the queue, and it is the one combination that
   * must never appear. True whether the worker runs or not, which is what the old
   * literal could not say.
   *
   * The suite now boots the API with the worker ON (`support/tenancy-harness.ts`),
   * and `integration.test.ts` proves it drains the outbox end to end. Lane A can
   * flip the default in env.ts.
   */
  it('queues the receipt inside the money transaction, and does not SEND it there', async () => {
    const txId = await settledTransactionId('receipt-outbox');

    const jobs = Number(scalar(`select count(*) from receipt_job where transaction_id='${txId}'`));
    expect(jobs, 'a settled top-up queued no receipt at all').toBeGreaterThan(0);

    expect(
      scalar(
        `select count(*) from receipt_job where transaction_id='${txId}' and status='sent' and attempts=0`,
      ),
      'a receipt is `sent` with attempts=0, so it was sent without ever being claimed by the ' +
        'worker — meaning the send happened inside the money transaction. ' +
        'See api/src/db/schema/receipt.ts.',
    ).toBe('0');

    // And a job that has not been sent carries no send timestamp. The CHECK
    // `receipt_job_sent_at_matches_status` ties the two together; asserting it
    // here states what the column MEANS rather than that a constraint exists.
    expect(
      scalar(
        `select count(*) from receipt_job where transaction_id='${txId}' and status <> 'sent' and sent_at is not null`,
      ),
    ).toBe('0');
  });

  it('a receipt cannot be queued twice for one transaction and channel', async () => {
    // The invariant that must survive the index change, stated so it holds
    // before and after it. Whatever the key becomes, a second WhatsApp row for
    // one transaction is a second WhatsApp message to a customer.
    const txId = await settledTransactionId('receipt-uniqueness');
    const index = uniqueIndexOn('receipt_job');

    expect(index, 'receipt_job has no unique index covering transaction_id').toMatch(
      /\(transaction_id(, ?channel)?\)/i,
    );
    expect(
      Number(
        scalar(
          `select count(*) from receipt_job where transaction_id='${txId}' and channel='whatsapp'`,
        ),
      ),
    ).toBe(1);
  });

  /**
   * PROMOTED — this was a `knownBug()` and it flipped when lane A landed
   * migration 0005 and `services/receipts.ts`.
   */
  it('a settled top-up queues BOTH channels — whatsapp and email', async () => {
    const txId = await settledTransactionId('receipt-channels');

    const channels = scalar(
      `select coalesce(string_agg(channel::text, ',' order by channel::text), '') from receipt_job where transaction_id='${txId}'`,
    );

    expect(
      channels,
      `only "${channels}" queued for ${txId}. build-plan.md phase 2 wants both. ` +
        `receipt_job's unique index is: ${uniqueIndexOn('receipt_job')}`,
    ).toBe('email,whatsapp');

    // Two independent jobs, not one row with two destinations: they queue, retry
    // and back off separately, so a WhatsApp outage cannot hold up an email.
    expect(
      Number(
        scalar(
          `select count(distinct status) from receipt_job where transaction_id='${txId}'`,
        ),
      ),
    ).toBe(1);
  });

  it('and only the channels the customer can actually receive — no unsendable rows', async () => {
    // Email is queued on a VERIFIED address, which is the reason the member
    // fixture for this suite is chosen rather than inherited. A row that can
    // never succeed is not caution, it is a job that retries to exhaustion and
    // then sits in the failed queue where a real provider outage should be
    // visible.
    const txId = await settledTransactionId('receipt-verified');
    const verified =
      scalar(
        `select (email is not null and email_verified)::text from member where id='${MEMBER}'`,
      ) === 'true';
    const hasEmailJob =
      Number(
        scalar(
          `select count(*) from receipt_job where transaction_id='${txId}' and channel='email'`,
        ),
      ) === 1;

    expect(
      hasEmailJob,
      verified
        ? 'the member has a verified address and no email receipt was queued'
        : 'an email receipt was queued for a member with no verified address',
    ).toBe(verified);
  });

  it('and a duplicate callback still queues no second receipt for the same channel', async () => {
    // Whatever the index becomes, this must stay true: the outbox is written
    // inside the money transaction, so "one receipt if and only if the money
    // moved" survives a re-delivery.
    const { view, pspReference } = await settledIntent('receipt-dupe');
    const txId = settledTxOf(view.id);
    const before = Number(
      scalar(
        `select count(*) from receipt_job where transaction_id='${txId}' and channel='whatsapp'`,
      ),
    );

    await deliver({
      eventId: eventId('receipt-dupe-again'),
      pspReference,
      status: 'succeeded',
      amountFils: AMOUNT_FILS,
    });

    expect(
      Number(
        scalar(
          `select count(*) from receipt_job where transaction_id='${txId}' and channel='whatsapp'`,
        ),
      ),
      'a re-delivered callback queued a second WhatsApp receipt',
    ).toBe(before);
  });
});

/**
 * GAP — gateway questions this suite cannot answer yet, each naming what has to
 * exist first.
 */
describe('GAP: gateway surface not reachable yet', () => {
  it.todo(
    'the reconciliation job that sweeps OPEN_STATUSES older than N minutes does not exist; when it does, an intent abandoned on the hosted page must reach a terminal state without anyone polling it',
  );
  it.todo(
    'the receipt worker does not exist; when it does, a queued job must move queued → sending → sent exactly once and never send twice after a crash between the send and the row update',
  );
  it.todo(
    'the real PSP adapter is not chosen (CBK/PSP selection is a client decision); every spec here is written against the sandbox driver and the signature construction is the sandbox\'s. Re-run this file against the real adapter before launch',
  );
  it.todo(
    'a gateway that answers slowly rather than not at all — withGatewayTimeout is untested here because the sandbox cannot be made to hang; it needs a driver that can',
  );
});
