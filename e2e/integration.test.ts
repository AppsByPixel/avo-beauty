/**
 * THE SEAMS BETWEEN THE LANES.
 *
 * Every other file in this directory tests one lane's work. This one tests the
 * places where two lanes' work meets, because that is where four branches that
 * were each green in isolation stop being green together — and none of these
 * combinations existed on one branch until the integration merge.
 *
 * Four seams, in the order they were found:
 *
 *   1. LANE C'S SIGN-IN × LANE A'S SCOPE CHECK. Lane A made the surface a
 *      required parameter at every staff gate. Lane C replaced the shim with a
 *      real `POST /auth/web/session`. Nobody had put a REAL session in front of
 *      the scope check. Every spec in that block signs in with a password or a
 *      PIN; none of them touch `AVO_TEST_PRINCIPALS`, which is the whole point —
 *      the shim decides the scope by URL prefix, so a scope proven under the shim
 *      is a property of the shim.
 *
 *   2. LANE A'S RECEIPT OUTBOX, END TO END. `receipt_job` is keyed
 *      (transaction_id, channel) so the two channels are independent jobs. That
 *      was proved against the table. This proves it through the product: a real
 *      top-up, settled by the real signed callback, queues both channels — and
 *      failing one leaves the other claimable by the worker's own claim
 *      predicate.
 *
 *   3. THE COMMISSION RULE, AS A SWEEP. design/api-contract.md now says the
 *      customer never sees `feeFils`. A single spec on the transaction feed would
 *      pass forever while someone adds the field to a different serialiser, so
 *      this walks every customer-facing response and searches the whole document.
 *
 *   4. TRUNK'S ARABIC NAMES. `nameAr` and `stampRewardAr` are nullable and fall
 *      back to the Latin name. Most of Arabic is lane B's and out of reach from
 *      here; the fallback is not, because it is only safe if the API serves a
 *      string or a real null and never the four characters `null`.
 *
 * It uses `support/tenancy-harness.ts` rather than `support/api.ts` for the same
 * reason gateway.test.ts and tenancy.test.ts do: it needs real bearer sessions,
 * its own API on its own port, and psql. It never runs against `packages/mock`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_MEMBER,
  A_STAFF_FULL,
  B_BRANCH,
  B_MEMBER,
  B_SCANNER_DEVICE,
  B_STAFF,
  B_STAFF_HANDLE,
  QA_MEMBER,
  QA_MEMBER_PHONE,
  RECEIPT_POLL_MS,
  RECEIPT_MAX_ATTEMPTS,
  RECEIPT_WORKER_ENABLED,
  SALON_A,
  SALON_B,
  psql,
  scalar,
  signInDashboard,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Salon A's seeded scanner device. `api/src/db/seed.ts`. */
const A_SCANNER_DEVICE = 'DEV-SCANNER-01';
const A_STAFF_HANDLE = 'noura';

let n = 0;
const key = (label: string) => `int-${label}-${Date.now()}-${n++}`;

/** Real sessions, minted once. Nothing below runs under the test shim. */
let dashboardA = '';
let scannerA = '';
let dashboardB = '';
let scannerB = '';
let walletQa = '';

beforeAll(async () => {
  await startTenancyApi();
  dashboardA = await signInDashboard(SALON_A, A_STAFF_HANDLE);
  scannerA = await signInScanner(SALON_A, A_STAFF_HANDLE, A_SCANNER_DEVICE);
  dashboardB = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  scannerB = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
  walletQa = await signInMember(SALON_A, QA_MEMBER_PHONE);
}, 180_000);

afterAll(async () => {
  await stopTenancyApi();
});

// ===========================================================================
// SEAM 1 — lane C's real sign-in meets lane A's scope check
// ===========================================================================

/**
 * THE TRIPWIRE THAT MAKES THE REST OF THIS BLOCK MEAN ANYTHING.
 *
 * `AVO_TEST_PRINCIPALS` is ON in this harness — the gateway suite needs it to
 * mint a wallet token for a member whose password it cannot know. Under that
 * flag an UNAUTHENTICATED request is not anonymous, it resolves to salon A's
 * ST-001, and the shim picks the scope FROM THE URL: `/charges` is treated as a
 * scanner surface, everything else as dashboard.
 *
 * So the shim can never produce a scope 403 on `/charges` — it hands out exactly
 * the scope the route wants. A scope spec run without credentials is therefore
 * guaranteed to pass and guaranteed to prove nothing, which is precisely how a
 * dashboard session reaching `POST /charges` stayed invisible in the first place.
 * These two specs establish that the tokens below are real and that the shim is
 * distinguishable from them.
 */
describe('tripwires — these are real sessions, not the test shim', () => {
  it('the dashboard token resolves to the staff row that signed in, with dashboard scope', async () => {
    const me = await treq<{ id: string; salonId: string }>('GET', '/staff/me', {
      token: dashboardB,
    });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(B_STAFF);
    expect(me.body.salonId).toBe(SALON_B);
  });

  it('and an unauthenticated request resolves to someone else entirely — the shim', async () => {
    // If this ever returns 401, the shim is off and the specs below are still
    // valid. If it returns ST-B01, the tokens above are not doing any work.
    const me = await treq<{ id: string }>('GET', '/staff/me', { token: null });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(A_STAFF_FULL);
    expect(me.body.id).not.toBe(B_STAFF);
  });
});

describe('a real web session cannot charge a wallet', () => {
  /**
   * The direction that shipped broken once. A web session is long-lived,
   * browser-based, not device-bound and refreshable for thirty days; if it can
   * debit a wallet then every control around the four-digit PIN is decoration,
   * because the easier door is open.
   *
   * Layla is a MANAGER holding all nine permissions, so this 403 cannot be a
   * permission 403 — it has to be the surface.
   */
  it('POST /charges with a dashboard bearer token → 403', async () => {
    const res = await treq<{ error?: string; message?: string }>('POST', '/charges', {
      token: dashboardB,
      idempotencyKey: key('web-charge'),
      // A token that was never minted. If the scope gate is missing, this gets
      // as far as the wallet-token lookup and answers 410 — so a 410 here is a
      // FAILURE, and a very specific one: authority was checked after the token.
      body: { memberId: B_MEMBER, serviceIds: ['SV-B01'], token: 'tok_never_minted' },
    });

    expect(res.status, `expected the surface refusal, got ${res.raw}`).toBe(403);
  });

  it('and the refusal names the surface rather than blaming her permissions', async () => {
    const res = await treq<{ message?: string }>('POST', '/charges', {
      token: dashboardB,
      idempotencyKey: key('web-charge-copy'),
      body: { memberId: B_MEMBER, serviceIds: ['SV-B01'], token: 'tok_never_minted' },
    });
    precondition(res.status === 403, `expected 403, got ${res.status} ${res.raw}`);
    // api/src/auth/principal.ts SURFACE_COPY.scanner. A manager who hits this is
    // confused, not attacking.
    expect(res.body.message ?? '').toMatch(/scanner/i);
    expect(res.body.message ?? '').not.toMatch(/permission/i);
  });

  it('moved no money and consumed no idempotency key — the refusal is the whole response', async () => {
    const before = Number(scalar(`select balance_fils from member where id='${B_MEMBER}'`));
    const k = key('web-charge-nomove');

    const refused = await treq('POST', '/charges', {
      token: dashboardB,
      idempotencyKey: k,
      body: { memberId: B_MEMBER, serviceIds: ['SV-B01'], token: 'tok_never_minted' },
    });
    precondition(refused.status === 403, `expected 403, got ${refused.status} ${refused.raw}`);

    expect(Number(scalar(`select balance_fils from member where id='${B_MEMBER}'`))).toBe(before);
    // A key burned by a request that was refused before any work would strand the
    // retry: the scanner would re-send under the same key and get the 403 back.
    expect(
      Number(scalar(`select count(*) from idempotency_key where key='${k}'`)),
      'a request refused at the scope gate still claimed its idempotency key',
    ).toBe(0);
  });

  it('the SAME staff member charging from a real PIN session gets past the scope gate', async () => {
    // The control. Without it every 403 above could be an endpoint that is simply
    // broken shut. Same person, same permissions, same salon — only the kind of
    // credential differs, and the answer changes from "wrong surface" to "that
    // token does not exist", which is the token check doing its job.
    const res = await treq<{ error?: string }>('POST', '/charges', {
      token: scannerB,
      idempotencyKey: key('pin-charge'),
      body: { memberId: B_MEMBER, serviceIds: ['SV-B01'], token: 'tok_never_minted' },
    });

    expect(res.status, `expected the token refusal, got ${res.raw}`).toBe(410);
    expect(res.body.error).toBe('token_consumed_or_unknown');
  });
});

describe('a real PIN session cannot reach the dashboard', () => {
  /**
   * The other direction, and the older half of the wall. api-contract.md
   * § StaffUser: a PIN must "never let it reach dashboard scopes". `GET /staff`
   * is the roster — who works here and what they may do — and `PATCH /staff/{id}`
   * next to it is how permissions themselves are set, so this is the surface that
   * guards privilege escalation from a tablet on the salon floor.
   */
  it('GET /staff with a scanner bearer token → 403', async () => {
    const res = await treq<{ items?: unknown[]; message?: string }>('GET', '/staff', {
      token: scannerB,
    });

    expect(res.status, `expected the surface refusal, got ${res.raw}`).toBe(403);
    expect(res.body.items, 'the roster leaked in the refusal body').toBeUndefined();
  });

  it('and the refusal tells her where the dashboard lives', async () => {
    const res = await treq<{ message?: string }>('GET', '/staff', { token: scannerB });
    precondition(res.status === 403, `expected 403, got ${res.status} ${res.raw}`);
    // SURFACE_COPY.dashboard.
    expect(res.body.message ?? '').toMatch(/dashboard/i);
  });

  it('PATCH /staff/{id} — the privilege-escalation route — is refused from the scanner too', async () => {
    const before = scalar(`select perm_team::text from staff_user where id='ST-B02'`);
    const res = await treq('PATCH', '/staff/ST-B02', {
      token: scannerB,
      body: { perms: { team: true } },
    });

    expect(res.status, `expected the surface refusal, got ${res.raw}`).toBe(403);
    expect(
      scalar(`select perm_team::text from staff_user where id='ST-B02'`),
      'a 403 that still wrote the permission',
    ).toBe(before);
  });

  it('the SAME staff member reading the roster from her web session succeeds', async () => {
    // The control again: the 403s above are about the credential, not the route.
    const res = await treq<{ items: Array<{ id: string; salonId: string }> }>('GET', '/staff', {
      token: dashboardB,
    });

    expect(res.status).toBe(200);

    /**
     * CONTAINMENT AND SCOPE, NOT AN EXACT ROSTER.
     *
     * This asserted `[B_STAFF, 'ST-B02']` exactly, and adding salon B's three
     * scanner fixtures broke it — a spec about a web session reading a roster,
     * failing because the roster legitimately grew. An exact list makes every
     * future fixture a false positive here, and this is not the file that owns
     * salon B's headcount.
     *
     * What it does own: the roster is salon-scoped, and it really contains the
     * rows this suite reasons about elsewhere. Both survive a new fixture; a
     * salon A row appearing does not.
     */
    const ids = res.body.items.map((s) => s.id);
    expect(ids).toContain(B_STAFF);
    expect(ids).toContain('ST-B02');
    expect(
      res.body.items.filter((s) => s.salonId !== SALON_B),
      "salon B's roster contains a row from another salon",
    ).toEqual([]);
  });

  it('both directions hold at salon A too — this is the gate, not salon B', async () => {
    const webCharge = await treq('POST', '/charges', {
      token: dashboardA,
      idempotencyKey: key('a-web-charge'),
      body: { memberId: A_MEMBER, serviceIds: ['SV-01'], token: 'tok_never_minted' },
    });
    const pinRoster = await treq('GET', '/staff', { token: scannerA });

    expect([webCharge.status, pinRoster.status]).toEqual([403, 403]);
  });
});

// ===========================================================================
// SEAM 2 — the receipt outbox, driven through the product
// ===========================================================================

/**
 * A settled top-up, made the way a customer makes one.
 *
 * `POST /topups` with a real wallet session, then the sandbox PSP's hosted page,
 * which fires a real HMAC-signed callback at `POST /webhooks/sandbox` over real
 * HTTP. Nothing here calls the settle service directly, so what is proved is the
 * path the real processor will take.
 */
async function settleATopUp(label: string, amountFils = 10_000): Promise<string> {
  const created = await treq<{ id: string; redirectUrl: string }>('POST', '/topups', {
    token: walletQa,
    idempotencyKey: key(label),
    body: { amountFils, method: 'knet' },
  });
  precondition(created.status === 200, `POST /topups answered ${created.status} ${created.raw}`);

  const ref = /\/_gateway\/([^/?#]+)/.exec(created.body.redirectUrl)?.[1];
  precondition(!!ref, `no sandbox reference in redirectUrl: ${created.body.redirectUrl}`);

  const paid = await treq('POST', `/_gateway/${ref}`, {
    token: null,
    body: { outcome: 'succeeded', notify: true },
  });
  precondition(paid.status === 200, `the hosted page answered ${paid.status} ${paid.raw}`);

  const txId = scalar(`select coalesce(transaction_id,'') from topup_intent where id='${created.body.id}'`);
  precondition(txId !== '', `${created.body.id} settled without a transaction id`);
  return txId;
}

const channelsFor = (txId: string): string[] => {
  const s = scalar(
    `select coalesce(string_agg(channel::text, ',' order by channel::text), '') from receipt_job where transaction_id='${txId}'`,
  );
  return s === '' ? [] : s.split(',');
};

/**
 * The worker's OWN claim predicate, copied from the partial index in
 * `api/src/db/schema/receipt.ts`:
 *
 *   index('receipt_job_claim_idx').on(availableAt).where(status IN ('queued','failed'))
 *
 * Written out rather than derived, so that if lane A narrows what a worker may
 * claim, this disagrees instead of silently following.
 *
 * `asOf` IS THE PART THAT MAKES THIS USABLE BESIDE A RUNNING WORKER.
 *
 * The predicate's time half is `available_at <= now()`. Evaluated at the real
 * `now()`, any row this function reports as claimable is a row the live worker is
 * about to claim — and did, within a poll interval, turning `queued` into
 * `sending` between the UPDATE and the SELECT. These specs went red reporting an
 * empty list, which was the worker being prompt rather than a broken predicate.
 *
 * So the horizon is a parameter. The specs park their rows in the future, out of
 * the worker's reach entirely, and ask the predicate about an instant AFTER the
 * backoff they set. What is being tested is the predicate — which statuses come
 * back, and whether a backoff excludes a row — and none of that needs the row to
 * be due right now. The worker never touches these rows, so the answer is stable.
 */
const claimableChannels = (txId: string, asOf = 'now()'): string[] => {
  const s = scalar(
    `select coalesce(string_agg(channel::text, ',' order by channel::text), '')
       from receipt_job
      where transaction_id='${txId}'
        and status in ('queued','failed')
        and available_at <= ${asOf}`,
  );
  return s === '' ? [] : s.split(',');
};

/**
 * Put a transaction's receipt rows back to the state the MONEY TRANSACTION wrote,
 * and out of the running worker's reach.
 *
 * WHY THIS EXISTS NOW AND DID NOT BEFORE
 * --------------------------------------
 * These specs were written against an API with `RECEIPT_WORKER_ENABLED=0`. The
 * outbox therefore sat still: a settled top-up left two rows in `queued` with
 * `attempts = 0` and they stayed that way, so a spec could assert those literals
 * and then mutate one row to pose its question.
 *
 * The worker is on now (see `support/tenancy-harness.ts`), and it drains the
 * outbox within a poll interval. Every one of those literals became a race — the
 * suite went red on `email:sent:1 whatsapp:sent:1`, which is the worker doing its
 * job, not a defect.
 *
 * The questions these specs ask are not about the worker. They are about the
 * composite key and the claim predicate: given two rows, does failing one leave
 * the other claimable; does a failed row come back when its backoff expires. Both
 * need a known starting state, and "whatever the worker happened to have done by
 * the time psql connected" is not one.
 *
 * So the spec builds its own. `available_at` an hour out puts both rows outside
 * the claim predicate's `available_at <= now()`, which is the worker's own gate —
 * not a flag, not a pause, the same condition production uses for backoff. The
 * rows are then stable for as long as the spec needs them, and what is asserted
 * afterwards is asserted about a state the spec put there deliberately.
 *
 * `sent_at = NULL` is not tidiness either: `receipt_job_sent_at_matches_status`
 * CHECKs `(status = 'sent') = (sent_at IS NOT NULL)`, so a row the worker has
 * already sent cannot be moved back to `queued` or `failed` without clearing it.
 * Leaving it out is what made these two specs fail with a constraint violation
 * rather than an assertion.
 *
 * ONE UPDATE IS NOW ENOUGH, AND IT WAS NOT ALWAYS — THE HISTORY IS THE POINT.
 * ---------------------------------------------------------------------------
 * The park puts the rows outside the CLAIM predicate. It used to do nothing about
 * a send the worker had ALREADY CLAIMED before the park ran, because that send
 * finished into a `markSent` that read:
 *
 *     UPDATE receipt_job SET status='sent', sent_at=now(), available_at=now()
 *      WHERE id = $1
 *
 * — keyed on `id`, with no guard on status. So the sequence WAS:
 *
 *     worker      claims the email row      status='sending'
 *     parkOutbox  parks both rows           status='queued', available_at +1h
 *     worker      the send lands            status='sent',   available_at = now()
 *
 * and the park was silently gone from that row. `claimableChannels` filters on
 * `status IN ('queued','failed')`, so the email channel simply vanished from the
 * answer and the spec reported `[ 'whatsapp' ]` against `[ 'email', 'whatsapp' ]` —
 * a message that named neither the worker nor the race.
 *
 * SEEN ONCE IN A FULL-SUITE RUN AND NOT IN THREE STANDALONE RE-RUNS, which is the
 * signature of a window this narrow, and the reason this paragraph is still here
 * after the fix: the logging driver returns almost instantly, so the worker is
 * only mid-send for a moment, and the park has to land inside that moment. A
 * standalone re-run of one file barely has a worker running; a full suite has
 * dozens of transactions settling while the worker polls, so the moment comes up.
 * If this helper ever misbehaves again, that asymmetry is the first thing to
 * recognise and the last thing to conclude anything from — a green standalone run
 * is not evidence about this helper.
 *
 * FIXED IN `da442bc` (decision 72), AND THE PARK IS NOW SELF-ENFORCING.
 * --------------------------------------------------------------------
 * Every write in `receiptWorker.ts` that follows a claim — `markSent`,
 * `markFailed`, and the give-back on an unhandled channel — now carries the claim
 * in its `WHERE` via `stillOurs`:
 *
 *     id = $1 AND status = 'sending' AND attempts = <the claim's attempts>
 *
 * and reports whether it landed, which `processJob` turns into `'lost'`. So the
 * late send in the sequence above is REFUSED rather than applied.
 *
 * WHICH MEANS THIS PARK FENCES ITS OWN ROWS, ON TWO INDEPENDENT TERMS.
 * `attempts = 0` is the interesting one, and it is not incidental. `claimJobs` is
 * the only place `attempts` is INCREMENTED — the give-back on an unhandled channel
 * decrements it back, and nothing else writes the column at all — and the claim
 * increments by `attempts + 1` off a column `receipt_job_attempts_non_negative`
 * floors at 0, with Postgres `RETURNING` handing back the NEW value. So the
 * `attempts` a claim CARRIES, which is the value `stillOurs` compares against, is
 * always at least 1 (`RECEIPT_MAX_ATTEMPTS` is a positive int, so the claim
 * predicate's `attempts < max` cannot empty that range). It can never be 0.
 * Setting `attempts = 0` therefore refuses every in-flight claim on the
 * `attempts` term ALONE, whatever the status says — and the `status = 'queued'`
 * this park also writes is a second, separately sufficient fence. A lease-steal is
 * refused the same way, which is why `attempts` and not just `status` is the term
 * that carries the weight.
 *
 * AND `claimJobs` ITSELF — the one write that does NOT carry `stillOurs` — cannot
 * reach a parked row either: it selects `available_at <= now()`, and the park sets
 * `available_at` an hour out. Both clocks are the DATABASE's, so there is no skew
 * to argue about. Every interleaving converges. If the claim's `SELECT ... FOR
 * UPDATE SKIP LOCKED` reaches the row first, the park overwrites it and the
 * in-flight write is refused; if the park holds the lock first, `SKIP LOCKED`
 * means the claim passes the row by.
 *
 * AND NO OTHER WRITER IN THE REPO CAN MOVE A PARKED ROW, which was worth checking
 * rather than assuming, because a guarded `markSent` buys nothing if something else
 * still writes keyed on `id`. The full census of `receipt_job` writes outside this
 * file: `services/receipts.ts` INSERTs, once per transaction, inside the money
 * transaction that created it — so it cannot add a row to a `txId` that already has
 * its pair; `services/erasure.ts` and `db/seed.ts` and `support/tenancy-harness.ts`
 * DELETE, which cannot resurrect a park (and would fail this helper's count check
 * loudly if one ever ran mid-spec); and the three guarded writes above. There is no
 * admin retry or resend endpoint yet. If one lands, it is the first thing to suspect
 * when this throws.
 *
 * SO THE RE-PARKING LOOP IS GONE — deliberately, not by tidying. It existed to
 * converge against a writer that could not be fenced. Now that the writer is
 * fenced, a loop would only convert the appearance of a NEW concurrent writer
 * into a silent success, and a new writer on this table is exactly the thing a
 * QA helper should be shouting about.
 *
 * IT STILL VERIFIES, AND IT STILL THROWS. A helper that returns quietly on a
 * state it did not create is how this cost an afternoon in the first place: the
 * failure has to name the outbox, not the channel list. One park, one read back.
 */
function parkOutbox(txId: string): void {
  psql(`
    UPDATE receipt_job
       SET status = 'queued', attempts = 0, last_error = NULL, sent_at = NULL,
           available_at = now() + interval '1 hour'
     WHERE transaction_id = '${txId}';
  `);

  /** Rows that are NOT parked: the worker can still see them, or has sent them. */
  const strays = Number(
    scalar(
      `select count(*) from receipt_job
        where transaction_id='${txId}'
          and (status <> 'queued' or sent_at is not null or available_at <= now())`,
    ),
  );
  if (strays === 0) return;

  throw new Error(
    `parkOutbox could not hold ${txId}'s receipt rows still — ${strays} row(s) are out of ` +
      '`queued`, carry a `sent_at`, or have `available_at` back at now(). TREAT THIS AS A NEW ' +
      'CAUSE. The race this helper used to retry around — a claimed send landing after the ' +
      'park, via a `markSent` keyed on `id` alone — was fixed in `da442bc` (decision 72): ' +
      'every post-claim write in `receiptWorker.ts` now carries `status=\'sending\' AND ' +
      'attempts=<the claim\'s>`, and this park\'s `attempts = 0` refuses all of them on its ' +
      'own. So do not go looking for that missing guard; it is there. Look for a writer this ' +
      'helper does not know about — a new endpoint or job updating `receipt_job` keyed on ' +
      '`id`, a claim predicate that stopped respecting `available_at`, or a second suite ' +
      'sharing this database. The outbox now reads: ' +
      scalar(
        `select coalesce(string_agg(channel::text || ':' || status::text || ':' ||
                  coalesce(sent_at::text,'-'), ' ' order by channel::text), '(no rows)')
           from receipt_job where transaction_id='${txId}'`,
      ),
  );
}

/** `channel:status:attempts` for every row, ordered — the whole outbox at a glance. */
const outboxOf = (txId: string): string =>
  scalar(
    `select coalesce(string_agg(channel::text || ':' || status::text || ':' || attempts::text, ' ' order by channel::text), '')
       from receipt_job where transaction_id='${txId}'`,
  );

describe('one settled payment queues two independent receipts', () => {
  it('both channels are queued, through the real gateway round trip', async () => {
    const txId = await settleATopUp('receipts-both');
    expect(
      channelsFor(txId),
      'build-plan.md phase 2: "a receipt email AND a WhatsApp receipt arrive for every settled payment"',
    ).toEqual(['email', 'whatsapp']);
  });

  it('as two rows with their own status, attempts and backoff — not one row with two destinations', async () => {
    const txId = await settleATopUp('receipts-rows');

    // Two rows with distinct primary keys is the whole claim. One row carrying
    // two destinations would be a single id, a single status and a single
    // attempts counter, and a WhatsApp outage would then hold up the email.
    const ids = scalar(
      `select coalesce(string_agg(distinct id::text, ',' order by id::text), '')
         from receipt_job where transaction_id='${txId}'`,
    ).split(',').filter(Boolean);
    expect(ids.length, 'a settled top-up did not produce two independent receipt rows').toBe(2);

    // Each with its own channel, and both of them.
    expect(channelsFor(txId)).toEqual(['email', 'whatsapp']);

    /**
     * THE OUTBOX INVARIANT, RESTATED SO A RUNNING WORKER CANNOT FALSIFY IT.
     *
     * This used to read `email:queued:0 whatsapp:queued:0`, which was true only
     * because the worker was switched off. What it was really guarding is that
     * the money transaction QUEUES the receipt and does not SEND it — an HTTP
     * call inside the charge transaction is the thing `receipt.ts` exists to
     * prevent.
     *
     * A row the money transaction had sent would be `sent` with `attempts = 0`,
     * because `attempts` is incremented by exactly one statement in the system —
     * `claimJobs()` in `api/src/services/receiptWorker.ts`, which is the worker
     * claiming the row afterwards. So `sent` with a zero attempt count is the
     * signature of a send that never went through the queue, and it is the one
     * combination that must never appear. That statement is true whether the
     * worker is running or not, which is the property the old literal lacked.
     */
    const sentWithoutBeingClaimed = scalar(
      `select count(*) from receipt_job
        where transaction_id='${txId}' and status='sent' and attempts=0`,
    );
    expect(
      sentWithoutBeingClaimed,
      'a receipt is `sent` with attempts=0, so it was sent without ever being claimed — ' +
        'that means the send happened inside the money transaction. See db/schema/receipt.ts.',
    ).toBe('0');
  });

  /**
   * THE POINT OF PUTTING THE CHANNEL IN THE KEY.
   *
   * whatsapp-templates.md draws this line one level in — "a failed WhatsApp send
   * must never roll back the transaction that triggered it" — and the composite
   * key applies it between channels. Under the old `UNIQUE (transaction_id)` the
   * email row could not exist at all, so this case could not even be posed.
   *
   * The WhatsApp job is failed the way a worker fails one: status, an error and a
   * backoff into the future. The email must remain claimable RIGHT NOW.
   */
  it('failing the WhatsApp job leaves the email claimable', async () => {
    const txId = await settleATopUp('receipts-isolation');
    precondition(
      channelsFor(txId).length === 2,
      'this case needs both channels queued to say anything',
    );
    // A known starting state, out of the running worker's reach. `parkOutbox` puts
    // both rows an hour out; the WhatsApp failure below pushes its row to two, so
    // a horizon of 90 minutes separates the two by their BACKOFF and nothing else.
    parkOutbox(txId);
    precondition(outboxOf(txId) === 'email:queued:0 whatsapp:queued:0', 'the park did not take');

    psql(`
      UPDATE receipt_job
         SET status = 'failed',
             attempts = attempts + 1,
             last_error = 'provider 503 — simulated by e2e/integration.test.ts',
             available_at = now() + interval '2 hours'
       WHERE transaction_id = '${txId}' AND channel = 'whatsapp';
    `);

    expect(
      claimableChannels(txId, "now() + interval '90 minutes'"),
      'the WhatsApp failure took the email job with it — the two are not independent',
    ).toEqual(['email']);

    // And the email row itself was not touched by the failure. This is the
    // independence claim stated directly, with no predicate in the way.
    expect(
      scalar(
        `select status::text || ':' || attempts::text || ':' || coalesce(last_error,'-') from receipt_job where transaction_id='${txId}' and channel='email'`,
      ),
    ).toBe('queued:0:-');
  });

  it('and the failed WhatsApp job is still the worker\'s to retry once its backoff expires', async () => {
    const txId = await settleATopUp('receipts-retry');
    parkOutbox(txId);
    psql(`
      UPDATE receipt_job
         SET status = 'failed', attempts = 1, sent_at = NULL,
             available_at = now() + interval '30 minutes'
       WHERE transaction_id = '${txId}' AND channel = 'whatsapp';
    `);

    // `failed` is in the claim predicate on purpose: a failed send is a retry, not
    // a dead letter. Past both backoffs, both come back — and the WhatsApp row
    // coming back is the whole assertion, because a predicate narrowed to
    // `status = 'queued'` would drop it and strand every retry in the system.
    expect(claimableChannels(txId, "now() + interval '90 minutes'")).toEqual([
      'email',
      'whatsapp',
    ]);

    // Before its backoff expires it is NOT claimable — the retry is delayed, not
    // immediate. Without this the spec above would pass on a predicate that
    // ignored `available_at` altogether.
    expect(claimableChannels(txId, "now() + interval '5 minutes'")).toEqual([]);
  });

  /**
   * `parkOutbox` PARKS AGAINST A CLAIM THAT IS STILL IN FLIGHT — the race itself,
   * staged rather than waited for.
   *
   * The helper above no longer re-parks, and "the suite went green" is not the
   * evidence for that, because the window it used to lose was narrow enough to
   * show up once in a full-suite run and never in a standalone one. Absence of a
   * flake proves nothing on this timescale. So this stages the interleaving
   * directly and asserts the outcome.
   *
   * The claim is reproduced here in SQL rather than by racing the live worker,
   * because the point is not "can we hit the window" — it is "when the window is
   * hit, what happens". A hand-written claim is the same row state the worker's
   * own claim produces (`status='sending'`, `attempts` incremented, `available_at`
   * pushed out by the lease), which is all `stillOurs` looks at.
   *
   * Lane A stages the same race from inside `send()` in
   * `api/src/services/receiptWorker.int.test.ts` — "does not resurrect a receipt
   * another writer parked while the send was in flight", whose `park()` helper is
   * commented as this function's effect, verbatim. This is the e2e-level mirror:
   * same race, real HTTP-settled transaction, real database, real SQL.
   */
  it('parks a row out from under a claim already in flight, and the late send cannot take it back', async () => {
    const txId = await settleATopUp('receipts-park-race');
    precondition(
      channelsFor(txId).length === 2,
      'this case needs both channels queued to say anything',
    );
    parkOutbox(txId);

    // A worker claims the email row, exactly as `claimJobs` would, and is now
    // "mid-send": the row is `sending` with the claim's generation on it.
    psql(`
      UPDATE receipt_job
         SET status = 'sending', attempts = attempts + 1,
             available_at = now() + interval '2 minutes'
       WHERE transaction_id = '${txId}' AND channel = 'email';
    `);
    const claimedAttempts = Number(
      scalar(
        `select attempts from receipt_job where transaction_id='${txId}' and channel='email'`,
      ),
    );
    // The generation counter is never 0 on a claimed row, which is the fact the
    // park leans on. If this ever reads 0, the reasoning in `parkOutbox` is void.
    expect(claimedAttempts, 'a claimed row must carry a non-zero generation').toBeGreaterThan(0);

    // ONE park, no retry. This is the call under test.
    parkOutbox(txId);

    /**
     * Now the send lands, late, with the CURRENT guarded predicate — `stillOurs`
     * spelled out in SQL. It must match zero rows.
     */
    const landed = Number(
      scalar(
        `with done as (
           UPDATE receipt_job
              SET status = 'sent', sent_at = now(), last_error = NULL, available_at = now()
            WHERE transaction_id = '${txId}' AND channel = 'email'
              AND status = 'sending' AND attempts = ${claimedAttempts}
          RETURNING id
         ) select count(*) from done`,
      ),
    );
    expect(
      landed,
      'the guarded markSent landed on a parked row — `stillOurs` is not fencing the claim',
    ).toBe(0);

    // And the park is intact: both rows still queued, unsent, an hour out.
    expect(outboxOf(txId)).toBe('email:queued:0 whatsapp:queued:0');
    expect(claimableChannels(txId)).toEqual([]);
    expect(
      claimableChannels(txId, "now() + interval '90 minutes'"),
      'the parked rows did not come back at all — the park overshot, which breaks the specs above',
    ).toEqual(['email', 'whatsapp']);

    /**
     * THE COUNTERFACTUAL, so this spec fails for the right reason if the guard is
     * ever removed: the OLD unguarded statement — `WHERE id = $1` — does land on
     * the same parked row. That is the lost update the retry loop existed to
     * paper over, demonstrated rather than asserted from memory.
     *
     * It runs last and is left in place; the spec owns this transaction, and the
     * park it just destroyed is not needed again.
     */
    const wouldHaveLanded = Number(
      scalar(
        `with done as (
           UPDATE receipt_job
              SET status = 'sent', sent_at = now(), last_error = NULL, available_at = now()
            WHERE transaction_id = '${txId}' AND channel = 'email'
          RETURNING id
         ) select count(*) from done`,
      ),
    );
    expect(
      wouldHaveLanded,
      'the unguarded write no longer reaches the row either — this spec is no longer ' +
        'demonstrating the race it claims to, and the docblock needs re-checking',
    ).toBe(1);
    expect(claimableChannels(txId, "now() + interval '90 minutes'")).toEqual(['whatsapp']);
  });

  /**
   * THE HALF THAT ONLY BECAME TESTABLE WHEN THE WORKER WAS SWITCHED ON.
   *
   * `gateway.test.ts` had this as a standing todo — "the receipt worker does not
   * exist; when it does, a queued job must move queued → sending → sent exactly
   * once". It exists, it runs here, and this is that spec.
   *
   * It is the other half of the outbox contract. The specs above prove the money
   * transaction does not send; this proves something eventually does, which is
   * what stops "queued" from being a euphemism for "dropped".
   */
  it('the worker drains the outbox — a queued receipt reaches `sent`, having been claimed', async () => {
    precondition(
      RECEIPT_WORKER_ENABLED,
      'the API under test runs with RECEIPT_WORKER_ENABLED=0, so nothing drains the outbox',
    );
    const txId = await settleATopUp('receipts-worker');

    const deadline = Date.now() + 15_000;
    let state = '';
    for (;;) {
      state = outboxOf(txId);
      if (state === 'email:sent:1 whatsapp:sent:1') break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    // Both channels sent, and each with exactly ONE attempt: claimed once, sent
    // once. Two attempts would mean a retry, which against the `logging` driver
    // means a send that failed — and "never send twice after a crash between the
    // send and the row update" is the guarantee the attempt count carries.
    expect(
      state,
      'the worker did not drain the outbox within 15s. RECEIPT_POLL_MS is ' +
        `${RECEIPT_POLL_MS}ms, so this is not a timing margin problem.`,
    ).toBe('email:sent:1 whatsapp:sent:1');

    // The CHECK ties these together, but asserting it here says what the column
    // MEANS: a sent receipt has a moment it was sent at.
    expect(
      Number(
        scalar(
          `select count(*) from receipt_job where transaction_id='${txId}' and status='sent' and sent_at is null`,
        ),
      ),
    ).toBe(0);
  });

  /**
   * THE DEAD LETTER, which nothing had ever held the worker to.
   *
   * `receiptWorker.ts` states the rule in its header: "Parked rows are not deleted
   * and not hidden: `failed` with `attempts >= max` is the queue's dead letter",
   * and the claim predicate implements it as `AND attempts < RECEIPT_MAX_ATTEMPTS`.
   *
   * WHY IT IS HERE. Removing that line alone — nothing else — left the whole suite
   * green: `gateway.test.ts` and this file both passed, 75 specs, exit 0. So did
   * removing `FOR UPDATE SKIP LOCKED`. Only `available_at <= now()` was covered, by
   * the two specs above. A receipt that has exhausted its budget would have been
   * re-claimed and re-sent for ever, and the queue's own dead-letter guarantee had
   * no spec behind it.
   *
   * THE CONTROL IS WHAT MAKES THE NEGATIVE MEAN ANYTHING. "The parked row was not
   * claimed" is also true of a worker that is asleep, crashed, or switched off — and
   * two of those three have really happened in this suite. So the same window holds
   * a SECOND row, one attempt below the budget, which must be claimed. When the
   * control moves and the parked row does not, the worker demonstrably ran and
   * demonstrably declined this one.
   */
  it('will not re-claim a receipt that has exhausted its attempts — and the control proves it ran', async () => {
    precondition(
      RECEIPT_WORKER_ENABLED,
      'the API under test runs with RECEIPT_WORKER_ENABLED=0, so nothing would claim either row',
    );
    const txId = await settleATopUp('receipts-deadletter');
    precondition(channelsFor(txId).length === 2, 'this case needs both channels queued');

    /**
     * BUILT OUT OF REACH, CHECKED, THEN RELEASED — in that order, and the order is
     * the whole reason this reads the way it does.
     *
     * The worker polls every ${RECEIPT_POLL_MS}ms against this database. The first
     * version of this spec wrote the fixture already claimable and then asserted
     * it, and against a build with the attempt guard removed it lost that race:
     * the precondition read back `email:sent:3 whatsapp:sent:4`, because the worker
     * had drained both rows in between. The spec still failed, but at its
     * precondition rather than at the assertion it exists for — which is the
     * difference between "this build is broken" and "this spec is flaky", and only
     * one of those gets acted on.
     *
     * So the attempt counts are set an hour out where the claim predicate cannot
     * see them, verified there, and only then released into the past by a statement
     * that touches nothing else. Nothing is asserted after the release except the
     * outcome.
     *
     * whatsapp: AT the budget, `failed`. The dead letter.
     * email:    one BELOW it, `failed`. Must be retried.
     */
    psql(`
      UPDATE receipt_job
         SET status = 'failed', sent_at = NULL, last_error = 'simulated',
             attempts = ${RECEIPT_MAX_ATTEMPTS},
             available_at = now() + interval '1 hour'
       WHERE transaction_id = '${txId}' AND channel = 'whatsapp';
      UPDATE receipt_job
         SET status = 'failed', sent_at = NULL, last_error = 'simulated',
             attempts = ${RECEIPT_MAX_ATTEMPTS - 1},
             available_at = now() + interval '1 hour'
       WHERE transaction_id = '${txId}' AND channel = 'email';
    `);
    precondition(
      outboxOf(txId) ===
        `email:failed:${RECEIPT_MAX_ATTEMPTS - 1} whatsapp:failed:${RECEIPT_MAX_ATTEMPTS}`,
      `the fixture did not take: ${outboxOf(txId)}`,
    );

    // Released. Both are now claimable by time, so `attempts` is the only thing
    // that can separate them.
    psql(`
      UPDATE receipt_job SET available_at = now() - interval '1 minute'
       WHERE transaction_id = '${txId}';
    `);

    // Wait for the CONTROL to move. That is the signal the worker has run, and it
    // is why this is not a fixed sleep.
    const deadline = Date.now() + 15_000;
    let emailState = '';
    for (;;) {
      emailState = scalar(
        `select status::text || ':' || attempts::text from receipt_job
          where transaction_id='${txId}' and channel='email'`,
      );
      if (emailState === `sent:${RECEIPT_MAX_ATTEMPTS}`) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(
      emailState,
      'the control row was never claimed, so this spec cannot say anything about the parked ' +
        `one — the worker may simply not have run. RECEIPT_POLL_MS is ${RECEIPT_POLL_MS}ms.`,
    ).toBe(`sent:${RECEIPT_MAX_ATTEMPTS}`);

    // The worker ran. Now the row it must NOT have touched.
    expect(
      scalar(
        `select status::text || ':' || attempts::text from receipt_job
          where transaction_id='${txId}' and channel='whatsapp'`,
      ),
      'a receipt past its attempt budget was claimed again. It is the dead letter — re-claiming ' +
        'it sends the customer a receipt the queue had already given up on, for ever.',
    ).toBe(`failed:${RECEIPT_MAX_ATTEMPTS}`);

    // And it was not sent, which is the harm rather than the bookkeeping.
    expect(
      Number(
        scalar(
          `select count(*) from receipt_job where transaction_id='${txId}'
            and channel='whatsapp' and sent_at is not null`,
        ),
      ),
      'the dead-lettered receipt was sent',
    ).toBe(0);
  }, 60_000);

  /**
   * THE MUTATION PROOF FOR THE KEY ITSELF.
   *
   * Two inserts that a single-column `UNIQUE (transaction_id)` would treat
   * identically and the composite key does not: a second WhatsApp row must be
   * refused, and the email row that already exists is proof the composite key is
   * the one in force. Together they pin the index shape behaviourally rather than
   * by reading `pg_indexes` — a spec that reads the catalogue tells you what is
   * declared, this tells you what the database will do.
   */
  it('a second row for a channel that already has one is refused by the database', async () => {
    const txId = await settleATopUp('receipts-unique');
    let error = '';
    try {
      psql(`
        INSERT INTO receipt_job (transaction_id, member_id, channel, payload)
        VALUES ('${txId}', '${QA_MEMBER}', 'whatsapp', '{}'::jsonb);
      `);
    } catch (err) {
      error = String((err as Error).message);
    }

    expect(error, 'a duplicate WhatsApp receipt was accepted — that is a second message to a customer')
      .toMatch(/duplicate key value violates unique constraint "receipt_job_transaction_channel_uq"/);
    expect(
      Number(
        scalar(`select count(*) from receipt_job where transaction_id='${txId}' and channel='whatsapp'`),
      ),
    ).toBe(1);
  });
});

// ===========================================================================
// SEAM 3 — the commission never reaches the customer
// ===========================================================================

/**
 * design/api-contract.md, settled during the integration: the customer never
 * sees `feeFils`. `transaction.fee_fils` and `topup_intent.fee_fils` are real
 * columns on tables the wallet reads, so the only thing between AVO's margin and
 * the customer's activity feed is a serialiser.
 *
 * WHY THIS IS A SWEEP AND NOT A SPEC.
 * `api/src/http/serialise.ts` gets this right and comments on it. But
 * `GET /members/me/transactions` does NOT use that function — it maps the row
 * inline in `api/src/routes/members.ts`, field by field. One spec pointed at one
 * of those two would pass forever while the other one leaked, and the way this
 * rule gets re-broken is exactly that: somebody adds a field to a serialiser
 * nobody wrote a spec about. So this walks every customer-facing response and
 * searches the WHOLE document, at any depth, for anything that looks like a fee.
 */
interface Leak {
  path: string;
  value: unknown;
}

/** Every path in a JSON document whose key looks like a commission. */
function feeLeaks(value: unknown, path = '$'): Leak[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => feeLeaks(v, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      // `fee`, `feeFils`, `commissionFils`, `platformFee` — the rule is about the
      // number, not about one spelling of it.
      /^(fee|commission)|([Ff]ee|[Cc]ommission)(Fils)?$/.test(k)
        ? [{ path: `${path}.${k}`, value: v }]
        : feeLeaks(v, `${path}.${k}`),
    );
  }
  return [];
}

interface CustomerEndpoint {
  what: string;
  fetch: () => Promise<{ status: number; body: unknown; raw: string }>;
}

describe('the commission is merchant-visible and customer-never', () => {
  /**
   * The sweep's own tripwire. If `feeLeaks` were broken — a bad regex, a missed
   * recursion — every spec below would pass by finding nothing, forever. So it is
   * shown finding something first.
   */
  it('the detector finds a fee at any depth, under any of its spellings', () => {
    const found = feeLeaks({
      id: 'TX-1',
      feeFils: 150,
      nested: { items: [{ commissionFils: 7 }, { amountFils: 1 }] },
      merchant: { fee: 9 },
    }).map((l) => l.path);

    expect(found.sort()).toEqual([
      '$.feeFils',
      '$.merchant.fee',
      '$.nested.items[0].commissionFils',
    ]);
    // And it does not fire on the fields that legitimately carry money.
    expect(feeLeaks({ amountFils: 1, bonusFils: 2, creditFils: 3, balanceFils: 4 })).toEqual([]);
  });

  it('sweeps every customer-facing read', async () => {
    // Settle one first, so the feed and the intent below have something in them.
    // A sweep over empty responses is a sweep that cannot fail.
    const txId = await settleATopUp('fee-sweep');
    const intentId = scalar(`select id from topup_intent where transaction_id='${txId}'`);
    precondition(intentId !== '', 'no intent behind the settled transaction');

    const endpoints: CustomerEndpoint[] = [
      { what: 'GET /members/me', fetch: () => treq('GET', '/members/me', { token: walletQa }) },
      {
        what: 'GET /members/me/transactions — the activity feed',
        fetch: () => treq('GET', '/members/me/transactions', { token: walletQa }),
      },
      {
        what: 'GET /members/me/wallet-token',
        fetch: () => treq('GET', '/members/me/wallet-token', { token: walletQa }),
      },
      {
        what: `GET /salons/${SALON_A} — the wallet's salon header`,
        fetch: () => treq('GET', `/salons/${SALON_A}`, { token: walletQa }),
      },
    ];

    const results = await Promise.all(
      endpoints.map(async (e) => ({ ...e, res: await e.fetch() })),
    );

    const leaks = results.flatMap((r) => {
      expect(r.res.status, `${r.what} answered ${r.res.status} ${r.res.raw}`).toBe(200);
      return feeLeaks(r.res.body).map((l) => `  ${r.what} → ${l.path} = ${JSON.stringify(l.value)}`);
    });

    expect(
      leaks,
      'AVO\'s commission reached a customer surface:\n' + leaks.join('\n'),
    ).toEqual([]);
  });

  it('the feed really did contain the settled transaction — the sweep swept something', async () => {
    // Guards the sweep above against the empty-collection failure mode: an
    // activity feed with no rows in it has no fee to leak.
    const feed = await treq<{ items: Array<{ id: string; kind: string }> }>(
      'GET',
      '/members/me/transactions',
      { token: walletQa },
    );
    expect(feed.status).toBe(200);
    expect(feed.body.items.length).toBeGreaterThan(0);
    expect(feed.body.items.some((t) => t.kind === 'topup')).toBe(true);
  });

  it('but the merchant CAN see it — the rule is "customer-never", not "nobody"', () => {
    // Read from the database rather than an endpoint, because the merchant
    // surface that displays it is phase 4. What matters here is that the number
    // is recorded and non-zero, so the customer-facing absence above is a
    // deliberate omission and not simply a fee nobody ever computed.
    const fee = Number(
      scalar(
        `select coalesce(max(fee_fils),-1) from transaction where member_id='${QA_MEMBER}' and kind='topup' and fee_fils > 0`,
      ),
    );
    expect(fee, 'no top-up ever recorded a commission, so the sweep proves nothing').toBeGreaterThan(0);
  });

  /**
   * THE LAST CUSTOMER SURFACE STILL CARRYING THE COMMISSION.
   *
   * This was "the open contract question" and half of it is now settled.
   * api-contract.md § Commission was amended: the customer never sees `feeFils`,
   * and `packages/types` grew `TopUpIntentPublicSchema = TopUpIntentSchema.omit({
   * feeFils: true })` to say so in a shape rather than in prose.
   *
   * Lane A applied it to the READ side — `GET /topups/{id}` goes through
   * `serialiseIntentForCustomer`, which projects onto the public key set, so a
   * field that is not in the schema cannot reach a customer even if somebody adds
   * it to the view type. That half of this spec passes.
   *
   * `POST /topups` still answers with the full shape, and the reason was in this
   * directory: five specs in `money.test.ts` asserted `feeFils` on that response,
   * so `serialiseIntent` could not move without turning them red. Those specs have
   * been restated against `topup_intent.fee_fils` — see "the commission is
   * computed and persisted" below — and the blocker is gone.
   *
   * PROMOTED — lane A applied the public shape to the write side and this flipped
   * to "appears to be FIXED" on the next run.
   *
   * WHERE it applied it is the part worth keeping in front of a reader, because
   * the obvious placement is wrong in a way no assertion on this response would
   * ever catch. `services/topup.ts` projects ABOVE `completeKey`, not at the
   * `return`:
   *
   *     const view = serialiseIntentForCustomer(row as TopUpIntentRow);
   *     await completeKey(tx, keyId, { status: 200, body: view });
   *     return view;
   *
   * Serialising only the returned object would have stored the FULL row as the
   * idempotency replay body, and `routes/topups.ts` answers a lost unique-index
   * race by replaying `stored.body` verbatim. The commission would then be absent
   * on the first call and present on every retry — the worst version of the leak,
   * because a retry is the path nobody re-reads.
   *
   * So the spec below covers the first call, and the two after it cover the
   * replay. They are separate specs rather than three assertions in one, because
   * a regression on the store side must not be reported as "the top-up endpoint
   * leaks the fee" when the first call is clean.
   */
  it('POST /topups and GET /topups/{id} both answer the customer shape', async () => {
    const created = await treq<{ id: string }>('POST', '/topups', {
      token: walletQa,
      idempotencyKey: key('fee-intent'),
      body: { amountFils: 10_000, method: 'knet' },
    });
    precondition(created.status === 200, `POST /topups answered ${created.status} ${created.raw}`);

    const read = await treq('GET', `/topups/${created.body.id}`, { token: walletQa });
    precondition(read.status === 200, `GET /topups answered ${read.status} ${read.raw}`);

    const leaks = [
      ...feeLeaks(created.body).map((l) => `  POST /topups → ${l.path} = ${JSON.stringify(l.value)}`),
      ...feeLeaks(read.body).map((l) => `  GET /topups/{id} → ${l.path} = ${JSON.stringify(l.value)}`),
    ];

    expect(
      leaks,
      'AVO\'s commission reached a customer through the top-up shape. ' +
        'api-contract.md § Commission is customer-never and TopUpIntentPublicSchema ' +
        'omits feeFils; apply serialiseIntentForCustomer to the write side too:\n' +
        leaks.join('\n'),
    ).toEqual([]);
  });

  /**
   * THE STORED REPLAY BODY — the assertion the response-shaped spec above cannot
   * make.
   *
   * `idempotency_key.response_body` is written inside the money transaction and
   * is what a retry receives verbatim. Reading it from the column rather than
   * from a replayed response is deliberate: it fails at the exact line that
   * would regress — a `serialiseIntentForCustomer` moved down to the `return` —
   * rather than one HTTP round trip away from it.
   *
   * The fee precondition is what stops this being vacuous. "No fee in the body"
   * proves nothing about a top-up that never had one, so the row is checked to
   * carry a real commission first.
   */
  it('the stored idempotency body carries no commission either — the replay cannot leak what the response did not', async () => {
    const idem = key('fee-replay-stored');
    const created = await treq<{ id: string }>('POST', '/topups', {
      token: walletQa,
      idempotencyKey: idem,
      body: { amountFils: 10_000, method: 'knet' },
    });
    precondition(created.status === 200, `POST /topups answered ${created.status} ${created.raw}`);

    // 150 fils flat on KNET — api-contract.md § Commission. If this is 0 the
    // spec below would pass on an intent that has no commission to leak.
    const fee = Number(
      scalar(`select coalesce(fee_fils, 0) from topup_intent where id='${created.body.id}'`),
    );
    precondition(fee > 0, `this intent recorded no commission (fee_fils = ${fee})`);

    const stored = scalar(
      `select coalesce(response_body::text, '') from idempotency_key
        where key='${idem}' and endpoint='POST /topups'`,
    );
    precondition(stored !== '', `no idempotency row was stored for key ${idem}`);

    const leaks = feeLeaks(JSON.parse(stored)).map(
      (l) => `  idempotency_key.response_body → ${l.path} = ${JSON.stringify(l.value)}`,
    );
    expect(
      leaks,
      'the response is clean but the STORED replay body carries the commission, so the leak ' +
        'is absent on the first call and present on every retry. `serialiseIntentForCustomer` ' +
        'must be applied ABOVE `completeKey` in services/topup.ts, not at the `return`:\n' +
        leaks.join('\n'),
    ).toEqual([]);
  });

  it('and a real retry on the same key replays that body — same intent, still no commission', async () => {
    const idem = key('fee-replay-http');
    const body = { amountFils: 10_000, method: 'knet' };

    const first = await treq<{ id: string }>('POST', '/topups', {
      token: walletQa,
      idempotencyKey: idem,
      body,
    });
    precondition(first.status === 200, `the first POST /topups answered ${first.status} ${first.raw}`);

    // Same key, same body — non-negotiable #4. This is the gateway-retry path,
    // and it is served from `stored.body` rather than recomputed.
    const retry = await treq<{ id: string }>('POST', '/topups', {
      token: walletQa,
      idempotencyKey: idem,
      body,
    });

    expect(retry.status, `the retry answered ${retry.status} ${retry.raw}`).toBe(200);
    // Replayed, not re-created: a second intent id would mean a second charge at
    // the processor, which is the defect the key exists to prevent.
    expect(retry.body.id, 'the retry created a SECOND top-up intent').toBe(first.body.id);

    const leaks = feeLeaks(retry.body).map(
      (l) => `  POST /topups (retry) → ${l.path} = ${JSON.stringify(l.value)}`,
    );
    expect(
      leaks,
      'the retried top-up carried AVO\'s commission the first call did not:\n' + leaks.join('\n'),
    ).toEqual([]);
  });
});

// ---------------------------------------------------- the commission, to the fil --

/**
 * THE RATE TABLE — api-contract.md § Commission, asserted against
 * `topup_intent.fee_fils`.
 *
 * MOVED HERE FROM `money.test.ts`, and the move is the whole point.
 *
 * Five specs there read `feeFils` off the `POST /topups` RESPONSE. That put the
 * two suites in this directory in direct contradiction: the sweep above says no
 * customer response may carry a commission, and `POST /topups` is as
 * customer-facing as the `GET` — the wallet is what calls it. Lane A had already
 * resolved the read side (`TopUpIntentPublicSchema`, `serialiseIntentForCustomer`)
 * and left `POST /topups` on the full shape with a comment naming those five
 * specs as the reason it could not move. They were the blocker.
 *
 * So they are restated against the column instead. This is the pattern the
 * receipt specs above already use, and it is stronger than what it replaces in
 * two ways rather than weaker:
 *
 *   - it survives the fix. When lane A applies the public shape to `POST /topups`
 *     these keep passing, because `fee_fils` is where the commission actually
 *     lives and a serialiser cannot move it.
 *   - it proves the number was RECORDED, not merely reported. A response field is
 *     a claim about a computation; the row is the computation's result, and the
 *     row is what a merchant statement will one day be built from.
 *
 * The expected figures are literals from § Commission, never recomputed with the
 * server's own helper. KNET 150 flat; card 2.5% + 50; Apple Pay priced as a card.
 */
describe('the commission is computed and persisted', () => {
  /** Create an intent and return the commission the database recorded for it. */
  async function persistedFee(amountFils: number, method: string): Promise<number> {
    const created = await treq<{ id: string }>('POST', '/topups', {
      token: walletQa,
      idempotencyKey: key(`fee-${method}-${amountFils}`),
      body: { amountFils, method },
    });
    precondition(
      created.status === 200,
      `POST /topups (${method}, ${amountFils}) answered ${created.status} ${created.raw}`,
    );

    const raw = scalar(`select fee_fils::text from topup_intent where id='${created.body.id}'`);
    precondition(raw !== '', `no topup_intent row for ${created.body.id}`);
    // Read as text and converted here, so a column that ever became numeric and
    // returned "150.000" fails this rather than being silently coerced to 150.
    expect(raw, `fee_fils for ${method} ${amountFils} is not an integer: "${raw}"`).toMatch(
      /^-?\d+$/,
    );
    return Number(raw);
  }

  it('KNET is 150 fils flat, at every amount', async () => {
    for (const amount of [1_000, 10_000, 25_000, 250_000]) {
      expect(
        await persistedFee(amount, 'knet'),
        `KNET fee on ${amount} fils must be flat 150`,
      ).toBe(150);
    }
  });

  it('card is 2.5% + 50 fils', async () => {
    const cases: Array<[amount: number, fee: number]> = [
      [10_000, 300], //   250 + 50
      [5_000, 175], //    125 + 50
      [25_000, 675], //   625 + 50
      [100_000, 2_550], // 2500 + 50
    ];
    for (const [amount, expected] of cases) {
      expect(await persistedFee(amount, 'card'), `card fee on ${amount} fils`).toBe(expected);
    }
  });

  it('a card percentage that lands on a half fil rounds to an integer, never a float', async () => {
    // 2.5% of 3333 = 83.325 → 83, + 50 = 133. This is the case where a float
    // implementation shows itself — and storing it in an integer column is a
    // second, independent guard, because a float would have to be truncated to
    // land there at all.
    expect(await persistedFee(3_333, 'card')).toBe(133);
    // 2.5% of 1010 = 25.25 → 25, + 50 = 75.
    expect(await persistedFee(1_010, 'card')).toBe(75);
  });

  it('Apple Pay is priced as a card', async () => {
    expect(await persistedFee(10_000, 'applepay')).toBe(300);
  });

  it('a client-supplied feeFils is ignored — the commission is the server\'s to compute', async () => {
    // The half of `money.test.ts`'s forged-bonus spec that needed the fee field.
    // A wallet that could name its own commission could set it to zero, and the
    // only place that shows is the column.
    const created = await treq<{ id: string }>('POST', '/topups', {
      token: walletQa,
      idempotencyKey: key('fee-forged'),
      body: { amountFils: 10_000, method: 'knet', feeFils: 0, creditFils: 999_999 },
    });
    precondition(created.status === 200, `POST /topups answered ${created.status} ${created.raw}`);

    const fee = Number(scalar(`select fee_fils from topup_intent where id='${created.body.id}'`));
    expect(fee, 'the forged feeFils: 0 was stored').toBe(150);

    // And the forged credit did not land either — asserted here rather than in
    // money.test.ts because this is the row, not the reply.
    const credit = Number(
      scalar(`select credit_fils from topup_intent where id='${created.body.id}'`),
    );
    expect(credit).not.toBe(999_999);
  });

  it('the commission is never taken out of what lands in the wallet', async () => {
    // The rule the customer feels. `credit_fils` is amount + bonus; the fee is
    // AVO's margin on the merchant side and touches neither.
    const created = await treq<{ id: string }>('POST', '/topups', {
      token: walletQa,
      idempotencyKey: key('fee-not-netted'),
      body: { amountFils: 10_000, method: 'card' },
    });
    precondition(created.status === 200, `POST /topups answered ${created.status} ${created.raw}`);

    const row = scalar(
      `select amount_fils || ',' || bonus_fils || ',' || credit_fils || ',' || fee_fils ` +
        `from topup_intent where id='${created.body.id}'`,
    );
    const [amount, bonus, credit, fee] = row.split(',').map(Number) as [
      number,
      number,
      number,
      number,
    ];

    expect(credit).toBe(amount + bonus);
    expect(fee, 'a card top-up recorded no commission at all').toBe(300);
    expect(credit, 'the commission was netted out of the credit').not.toBe(amount + bonus - fee);
  });
});

// ===========================================================================
// SEAM 4 — trunk's Arabic names, and the fallback
// ===========================================================================

/**
 * `packages/types` now carries `SalonSchema.nameAr`, `BranchSchema.nameAr` and
 * `SalonSchema.stampRewardAr`. All three are NULLABLE and documented to fall back
 * to the Latin name — "the same way an untranslated legal document falls back to
 * `en`".
 *
 * Arabic is otherwise lane B's, and RTL, Plex Arabic and the digit rule are not
 * reachable from an HTTP suite. The fallback is, because it has a server-side
 * half that is easy to get wrong in a way no screenshot catches: `nameAr` must
 * arrive as a string or as a real JSON `null`. A serialiser that stringifies —
 * `String(row.nameAr)`, a template literal, a `COALESCE(name_ar, 'null')` — sends
 * the four characters `null`, and every client-side `nameAr ?? name` then renders
 * the word "null" in the salon header, because a non-empty string is truthy and
 * `??` never fires.
 *
 * The specs are written against the contract. They failed when this was written;
 * migration 0006 landed the columns and the last spec in this block — the one
 * that pins the fields as PRESENT rather than merely usable — was promoted out of
 * `knownBug()` at that point.
 */
interface SalonView {
  id: string;
  name: string;
  nameAr?: string | null;
  stampReward?: string | null;
  stampRewardAr?: string | null;
  branches: Array<{ id: string; name: string; nameAr?: string | null }>;
}

/** What a renderer does. `?? ` and not `||`, so an empty string is a bug not a fallback. */
const label = (ar: string | null | undefined, latin: string): string => ar ?? latin;

const UNUSABLE = ['null', 'undefined', 'NaN', '[object Object]', ''];

async function salonAsCustomer(salonId: string, token: string): Promise<SalonView> {
  const res = await treq<SalonView>('GET', `/salons/${salonId}`, { token });
  precondition(res.status === 200, `GET /salons/${salonId} answered ${res.status} ${res.raw}`);
  return res.body;
}

describe('Arabic names fall back to the Latin name, and never to the word "null"', () => {
  it('whatever the API serves for a salon renders as usable text in Arabic', async () => {
    const s = await salonAsCustomer(SALON_A, walletQa);
    const shown = label(s.nameAr, s.name);

    expect(UNUSABLE, `the Arabic salon header would render "${shown}"`).not.toContain(shown);
    expect(shown.trim()).not.toBe('');
  });

  it('and for every branch — the case the reference implementation already handles', async () => {
    // avo-promotions.js → `branchLabel` picks `nameAr` when the language is `ar`.
    // A branch list is where this bites first, because it is rendered as a row of
    // chips with no other text to make a stray "null" look wrong.
    const s = await salonAsCustomer(SALON_A, walletQa);
    expect(s.branches.length).toBeGreaterThan(0);

    for (const b of s.branches) {
      const shown = label(b.nameAr, b.name);
      expect(UNUSABLE, `branch ${b.id} would render "${shown}" in Arabic`).not.toContain(shown);
    }
  });

  it('and for the stamp reward, which is customer-facing copy', async () => {
    const s = await salonAsCustomer(SALON_A, walletQa);
    if (s.stampReward === null || s.stampReward === undefined) return; // tiers salon, nothing to translate
    const shown = label(s.stampRewardAr, s.stampReward);
    expect(UNUSABLE, `the stamp card would render "${shown}"`).not.toContain(shown);
  });

  it('a salon that supplied no Arabic name still serves a usable Latin one', async () => {
    // Salon B is seeded by this suite's harness and has never been given an
    // Arabic name, so it is the honest "no Arabic name" case. The Latin name is
    // read from Postgres rather than written here as a literal — the harness seed
    // is `ON CONFLICT DO NOTHING`, so a row created by an older revision survives
    // and a hardcoded expectation becomes an assertion about seed history. (It
    // did: the row says "Lumière", the current seed string says "Lumiere".)
    const latin = scalar(`select name from salon where id='${SALON_B}'`);
    precondition(latin !== '', `${SALON_B} is not seeded`);

    const s = await salonAsCustomer(SALON_B, dashboardB);
    expect(s.name).toBe(latin);
    expect(label(s.nameAr, s.name)).toBe(latin);
    for (const b of s.branches) {
      expect(label(b.nameAr, b.name).trim()).not.toBe('');
      expect(UNUSABLE).not.toContain(label(b.nameAr, b.name));
    }
    expect(s.branches.map((b) => b.id)).toContain(B_BRANCH);
  });

  /**
   * PROMOTED — this was a `knownBug()` and lane A has landed it.
   *
   * What it used to report: the API served `nameAr` on nothing. There was no
   * `name_ar` column on `salon` or `branch` and no `stamp_reward_ar` on `salon`,
   * so `GET /salons/{id}` omitted all three. The fallback specs above passed by
   * accident — `undefined ?? name` and `null ?? name` agree — and lane B had
   * nothing to render even for a salon that had supplied an Arabic name.
   *
   * Migration 0006 added the columns and the serialiser now lists the fields, so
   * the contract and the live response agree. Locked in as a plain `it()`: these
   * are REQUIRED keys with nullable values in `SalonSchema` and `BranchSchema`,
   * and a client parsing the contract against this API breaks the day one of
   * them goes missing again.
   */
  it('serves every Arabic name field the contract declares', async () => {
    const s = await salonAsCustomer(SALON_A, walletQa);
    const missing: string[] = [];
    if (!('nameAr' in s)) missing.push('Salon.nameAr');
    if (!('stampRewardAr' in s) && s.stampReward != null) missing.push('Salon.stampRewardAr');
    for (const b of s.branches) if (!('nameAr' in b)) missing.push(`Branch(${b.id}).nameAr`);

    expect(
      missing,
      'packages/types declares these as required keys with nullable values; ' +
        'GET /salons/{id} omits them entirely:\n  ' + missing.join('\n  '),
    ).toEqual([]);
  });

  /**
   * The half that CANNOT be tested until the columns exist, and the one that
   * actually catches the stringify bug. A salon with a genuine SQL NULL in
   * `name_ar` must serialise to JSON `null`, not to `"null"`.
   */
  it.todo(
    'LANE A OWES THE FIXTURE: set salon B\'s name_ar to SQL NULL and salon A\'s to a real Arabic string, then assert JSON null vs a string — the stringify bug (COALESCE(name_ar, \'null\'), String(row.nameAr), a template literal) is invisible until a row actually holds NULL',
  );
});
