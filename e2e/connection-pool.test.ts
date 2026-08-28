/**
 * WHAT THE API DOES WHEN MORE REQUESTS ARRIVE AT ONCE THAN IT HAS CONNECTIONS.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run connection-pool.test.ts
 *
 * Boots lane A's real API against lane D's own per-run Postgres, like
 * `scanner.test.ts` and unlike the three mock-driven files. `packages/mock` cannot
 * host this question at all: it is one Node process holding `Map`s and it has no
 * connection pool to exhaust.
 *
 * =========================================================================
 * WHY THIS FILE IS SEPARATE FROM `scanner.test.ts`
 * =========================================================================
 * Because the failure it looks for does not fail one request — it wedges the API
 * PROCESS. Ten open transactions with nothing able to finish leaves every
 * subsequent request on that server hanging too, including reads that have nothing
 * to do with charging: the probe that found this watched a plain
 * `GET /members/me/wallet-token` hang twelve seconds after the burst was already
 * over and every client had gone.
 *
 * So the burst spec is the LAST thing in its own file, on an API nothing else is
 * sharing, and `afterAll` kills it. Put it in `scanner.test.ts` and one red spec
 * takes the two thousand lines after it down with it, reported as fifty unrelated
 * failures.
 *
 * =========================================================================
 * WHAT THE BURST IS ACTUALLY ABOUT — READ THIS BEFORE CHANGING THE NUMBERS
 * =========================================================================
 * `api/src/db/client.ts` opens `postgres(url, { max: 10 })`. A `db.transaction()`
 * RESERVES one of those ten for its whole life. So any code inside the transaction
 * callback that runs a query on the BASE handle rather than on `tx` is asking the
 * same pool for a SECOND connection while holding one, and ten concurrent requests
 * doing that hold all ten and each wait for an eleventh that cannot exist.
 *
 * Postgres never sees a cycle — the cycle runs through a JavaScript connection
 * pool, which is invisible to it — so `deadlock_timeout` never fires, no 40P01 is
 * raised, and nothing times out. It is a permanent hang, not a slow request.
 *
 * `api/src/services/scannerLimit.ts` § "WHERE THE CHECK SITS" is the long version:
 * the scanner rate limiter was originally inside `performCharge`'s transaction and
 * was moved out for exactly this reason, measured at twelve concurrent charges not
 * returning in 25 seconds. Lane A kept a probe for it in
 * `api/src/services/scannerLimit.int.test.ts` § "where the limiter sits".
 *
 * THAT PROBE CANNOT SEE THE ONE BELOW, AND THE DIFFERENCE IS ONE FIELD. It fires
 * twelve charges with `payload: { memberId, serviceIds, confirmDuplicate }` — no
 * `token`. The remaining second-connection call in the charge transaction is
 * behind `if (input.token)`, so a tokenless burst never reaches it and answers in
 * milliseconds. Every charge a real scanner sends carries a token, because the
 * token is how the customer's QR is presented.
 *
 * TWELVE AND NINE ARE BOTH LOAD-BEARING. Nine is the widest burst that still
 * leaves one connection free for the winner's second acquisition, so it passes
 * against the broken code; twelve is the first round number over ten. If `max` in
 * `db/client.ts` changes, these two numbers have to move with it.
 *
 * =========================================================================
 * IT IS A CLASS WITH THREE INSTANCES, NOT A LINE
 * =========================================================================
 * A scan of every `db.transaction(async (tx) => …)` body in `api/src` for a query
 * issued on the base handle finds three, and both endpoints are covered below:
 *
 *   services/charge.ts       `peekToken(db, …)`            POST /charges
 *   services/booking.ts      `computeAvailability(db, …)`  POST /bookings
 *   services/booking.ts      `computeAvailability(db, …)`  POST /bookings/{id}/reschedule
 *
 * The booking burst is the cleaner demonstration of the two and is why it is here
 * rather than only in the report. Its twelve requests take twelve DIFFERENT slots
 * and touch twelve different rows, so no row lock funnels them: they deadlock on
 * the pool alone. A reader who assumes the charge case is really about `FOR
 * UPDATE` on the member row has that reading closed off.
 *
 * The third instance — reschedule — is the same call in the same file and is left
 * to the fix rather than given a third twelve-second spec.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  B_MEMBER,
  B_MEMBER_PHONE,
  B_SCANNER_DEVICE,
  B_SERVICE,
  B_SERVICE_PRICE_FILS,
  B_STAFF_HANDLE,
  QA_MEMBER_PHONE,
  SALON_A,
  SALON_B,
  apiLogTail,
  mintWalletTokenFor,
  scalar,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** `postgres(url, { max: 10 })` in api/src/db/client.ts. Not a guess — read it. */
const POOL_MAX = 10;
/** The widest burst that still leaves a connection free. Passes against the bug. */
const UNDER_THE_POOL = POOL_MAX - 1;
/** The first round number over it. */
const OVER_THE_POOL = 12;

/** Salon A's artist and service, the pair `reschedule.test.ts` books against. */
const ARTIST = 'AR-004';
const MANICURE = 'SV-04';

let scanner = '';
let wallet = '';
let member = '';

beforeAll(async () => {
  await startTenancyApi();
  scanner = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
  wallet = await signInMember(SALON_B, B_MEMBER_PHONE);
  member = await signInMember(SALON_A, QA_MEMBER_PHONE);
}, 120_000);

/**
 * A SERVER THAT IS NOT ALREADY WEDGED.
 *
 * Every burst spec in this file can leave the API with ten open transactions and
 * nothing able to finish, and that state outlives the requests that caused it —
 * so the second burst would otherwise hang on the first one's damage and prove
 * nothing about its own endpoint. Restarting between them is what keeps each spec
 * a statement about one call site.
 *
 * The sessions survive the restart and are not minted again: `BOOT_JWT_SECRET` is
 * one constant for the whole run precisely so "a token minted by one file's API
 * verifies against the next file's", and a restart inside a file is the same
 * property used at a smaller scale.
 */
async function freshApi(): Promise<void> {
  await stopTenancyApi();
  await startTenancyApi();
}

afterAll(async () => {
  await stopTenancyApi();
});

const balanceOf = (id: string) => Number(scalar(`select balance_fils from member where id='${id}'`));

/**
 * Fire `n` charges at once, each presenting its OWN live wallet token, and report
 * what came back.
 *
 * A HANG IS REPORTED AS A STATUS, NOT RE-THROWN. `treq` turns a twelve-second
 * silence into a thrown Error, which is the right behaviour for every other caller
 * in this directory and the wrong one here for two reasons.
 *
 * `Promise.all` REJECTS ON THE FIRST THROW. Twelve hung requests would surface as
 * one error and eleven discarded results, so the failure would say "a request
 * hung" when what a reader needs is HOW MANY of the twelve did — the difference
 * between a wedged process and one slow call. The count is the diagnosis.
 *
 * AND A HANG HAS TO BE COMPARABLE WITH A STATUS CODE. The assertion this feeds is
 * about liveness, so `410` and `HUNG` have to sit in one list and be counted
 * together. That was also what made this legal as a `knownBug()` while it was one:
 * the helper re-throws anything that is not an assertion failure. It is a plain
 * `it()` since `bed3fbb` and the two reasons above are why the catch stays.
 */
async function burstWithTokens(n: number): Promise<Array<number | 'HUNG'>> {
  const tokens = await Promise.all(
    Array.from({ length: n }, () => mintWalletTokenFor(wallet, B_MEMBER)),
  );
  const stamp = Date.now();
  return Promise.all(
    tokens.map(async (token, i) => {
      try {
        const res = await treq<any>('POST', '/charges', {
          token: scanner,
          idempotencyKey: `pool-${n}-${i}-${stamp}`,
          body: {
            memberId: B_MEMBER,
            serviceIds: [B_SERVICE],
            token,
            // Twelve identical baskets inside the near-duplicate window. That guard
            // is not what is under test, and without this every charge after the
            // first would answer 409 for a reason unrelated to the pool.
            confirmDuplicate: true,
          },
        });
        return res.status;
      } catch {
        return 'HUNG' as const;
      }
    }),
  );
}

describe('a burst of charges wider than the connection pool', () => {
  /**
   * FIRST, AND IT IS THE CONTROL RATHER THAN A WARM-UP. Nine concurrent charges
   * fit inside the pool with one connection to spare, so they answer whether or
   * not the bug below exists. If THIS one goes red the machine is the problem —
   * Postgres is down, the seed is wrong, the sign-in failed — and the burst spec's
   * silence would mean nothing.
   */
  it(`${UNDER_THE_POOL} at once, each with its own token, all settle`, async () => {
    const before = balanceOf(B_MEMBER);
    const statuses = await burstWithTokens(UNDER_THE_POOL);

    expect(
      statuses,
      `a burst that fits inside the pool did not settle cleanly: ${statuses.join(', ')}\n` +
        `--- the API's own log ---\n${apiLogTail(20)}`,
    ).toEqual(Array.from({ length: UNDER_THE_POOL }, () => 200));

    // Each token is distinct and each charge is real, so every one of them moved
    // money exactly once. This is the arithmetic the burst spec below cannot check,
    // because against the bug nothing moves at all.
    expect(balanceOf(B_MEMBER)).toBe(before - UNDER_THE_POOL * B_SERVICE_PRICE_FILS);
  }, 120_000);

  /**
   * LAST IN THE FILE. Against the bug this leaves the API wedged — see the header.
   *
   * WHAT IS ASSERTED IS THAT THEY ANSWERED, which is `scannerLimit.int.test.ts`'s
   * wording for its own version of this and is right for the same reason: which
   * charges settle and which are refused is a race, and pinning the mix would make
   * this a test about `FOR UPDATE`. It is a test about whether the process is
   * alive.
   *
   * MEASURED, BOTH WAYS, AND THE NUMBERS ARE KEPT BECAUSE THEY ARE THE ARGUMENT.
   * On 2026-08-28 against `dev` at 14ff01e, before `bed3fbb`:
   *
   *   as it was then          twelve requests, twelve twelve-second aborts, zero
   *                           answers, and `pg_stat_activity` five seconds after
   *                           the last client gave up still showing ten backends —
   *                           nine on `Lock/tuple` behind the member row, one
   *                           `idle in transaction` waiting on a pool connection
   *                           that will never be free
   *   with `peekToken(tx, …)` twelve 200s in 150ms of wall clock
   *
   * This spec was a `knownBug()` for as long as that was the tree's behaviour and
   * is a plain `it()` since `bed3fbb`, which is the promotion `known-bug.ts` asks
   * for by name: "the assertion is the contract, it fails today, and the hour the
   * divergence closes the assertion passes and the spec goes RED asking to be
   * rewritten." It went red on cue. The title is the contract now, not a defect
   * report, and the sentence that made it diagnosable is kept verbatim below —
   * "each request holds one pooled connection and waits for a second" is the whole
   * mechanism, and a reader hitting this red in six months needs it in one pass.
   *
   * THE MONEY WAS NEVER AT RISK IN EITHER DIRECTION, which is worth writing down
   * beside a defect this severe. Against the bug the wedged transactions had
   * claimed an idempotency key and taken a row lock and nothing else: balance,
   * `transaction`, `ledger_entry` and `idempotency_key` were all byte-identical
   * before and after, and the rollback on process death was clean. It hung the
   * till, it did not half-move a charge.
   */
  it(
    `${OVER_THE_POOL} at once, each with its own token, all answer — a burst wider than the ` +
      'pool must not wedge the API, because each request would hold one pooled connection ' +
      'and wait for a second',
    async () => {
      const before = balanceOf(B_MEMBER);
      const statuses = await burstWithTokens(OVER_THE_POOL);
      const hung = statuses.filter((s) => s === 'HUNG').length;

      /**
       * A HUNG BURST THAT MOVED MONEY IS A DIFFERENT AND WORSE DEFECT than a hung
       * burst that moved none, so it is checked before the hang is.
       *
       * IT OUTLIVED THE `knownBug()` IT WAS WRITTEN FOR, deliberately. Its first
       * job was to stop a half-moved charge hiding inside "still broken, as
       * expected" — `knownBug()` reads an assertion failure as the bug still being
       * there, and a plain Error as a real failure, so this had to be the second
       * kind. That job is gone. The one that remains is better:
       *
       * `expect(hung).toBe(0)` is a sentence about LIVENESS and it is silent about
       * money. If this endpoint ever hangs again AND leaves the wallet half-debited,
       * the assertion below fails with a message about twelve requests not
       * answering, a reader diagnoses a repeat of `bed3fbb`, and the far worse fact
       * — that the charge transaction stopped failing safely — is never printed at
       * all. A precondition makes the worse failure announce itself in its own
       * words instead of being reported as the milder one.
       *
       * Inert on a green run, which is the point: it speaks only when the thing it
       * guards has actually gone wrong.
       */
      precondition(
        balanceOf(B_MEMBER) === before || hung === 0,
        'a burst wider than the pool hung AND moved money — the charge transaction is no ' +
          `longer failing safely. Balance went ${before} → ${balanceOf(B_MEMBER)} with ` +
          `${hung} of ${OVER_THE_POOL} requests unanswered. That is worse than the deadlock ` +
          '`bed3fbb` fixed, and it is a different defect from the one this spec is named ' +
          'after. Read this line, not the assertion under it.',
      );

      expect(
        hung,
        `${hung} of ${OVER_THE_POOL} concurrent charges never answered at all. ` +
          `Statuses: ${statuses.join(', ')}\n` +
          `--- the API's own log ---\n${apiLogTail(20)}`,
      ).toBe(0);
    },
    180_000,
  );
});

/**
 * THE SAME PROPERTY ON A SECOND ENDPOINT, AND THE CLEANER STATEMENT OF THE TWO.
 *
 * `services/booking.ts` called `computeAvailability(db, …)` inside its transaction,
 * twice — once on create and once on reschedule. Create is the one exercised here;
 * reschedule is the same call in the same file and was fixed with it in `bed3fbb`.
 *
 * WHY THIS IS THE BETTER DEMONSTRATION. The twelve requests take twelve DIFFERENT
 * slots, so they write twelve different rows and contend on nothing in Postgres at
 * all: there is no member row under `FOR UPDATE` funnelling them, no exclusion
 * constraint they collide on. Whatever wedges them is not database contention, and
 * that leaves only the pool. Measured on 2026-08-28 against `dev` at 14ff01e:
 * twelve requests, twelve twelve-second aborts, zero answers. After `bed3fbb`,
 * twelve answers in 1,763ms.
 *
 * WHAT THIS SPEC DOES NOT COVER, SAID HERE BECAUSE THE GAP IS EASY TO MISS.
 * `computeAvailability` is not a pure read. On the google-sourced path
 * `resolveWorkingWindow` raises or resolves a `calendar_disconnected` merchant
 * notification, so moving it onto `tx` moved those writes INTO the booking
 * transaction — the one genuine semantic change in `bed3fbb`. AR-004 is
 * `availabilitySource: 'manual'` and returns before either write, so nothing below
 * touches it. That path is covered in `artist-availability-source.test.ts`, which
 * owns the google fixtures and the notification helpers; this file stays about the
 * pool.
 */
describe('a burst of bookings wider than the connection pool', () => {
  /**
   * Slots the artist genuinely has free, walked forward rather than computed from
   * a fixed offset — `reschedule.test.ts` documents why: AR-004's week is closed
   * one day, so a fixed offset lands on it once every seven runs.
   */
  async function freeSlots(n: number): Promise<string[]> {
    const found: string[] = [];
    for (let d = 9; d < 25 && found.length < n; d++) {
      const date = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const day = await treq<any>('GET', `/artists/${ARTIST}/availability?date=${date}`, {
        token: member,
      });
      if (day.status !== 200) continue;
      for (const slot of (day.body?.slots ?? []).filter((s: any) => s.available === true)) {
        if (found.length < n) found.push(slot.startsAt);
      }
    }
    return found;
  }

  it(
    `${OVER_THE_POOL} bookings at once, on ${OVER_THE_POOL} DIFFERENT slots, all answer — ` +
      'availability must not be computed on `db` inside `db.transaction`, because each ' +
      'request would hold one pooled connection and wait for a second',
    async () => {
      // Never inherit the charge burst's wedged server; see `freshApi`.
      await freshApi();

      const slots = await freeSlots(OVER_THE_POOL);
      precondition(
        slots.length === OVER_THE_POOL,
        `${ARTIST} has only ${slots.length} free slots in the next fortnight, so this spec ` +
          `cannot make ${OVER_THE_POOL} non-colliding bookings. That is a defect in ` +
          'availability or in the seed, not the pool bug this spec records.',
      );

      const stamp = Date.now();
      const statuses = await Promise.all(
        slots.map(async (startsAt, i) => {
          try {
            const res = await treq<any>('POST', '/bookings', {
              token: member,
              idempotencyKey: `pool-book-${stamp}-${i}`,
              body: { artistId: ARTIST, serviceId: MANICURE, startsAt },
            });
            return res.status as number | 'HUNG';
          } catch {
            return 'HUNG' as const;
          }
        }),
      );
      const hung = statuses.filter((s) => s === 'HUNG').length;

      expect(
        hung,
        `${hung} of ${OVER_THE_POOL} concurrent bookings never answered at all, on ` +
          `${OVER_THE_POOL} slots that do not collide with each other. ` +
          `Statuses: ${statuses.join(', ')}\n` +
          `--- the API's own log ---\n${apiLogTail(20)}`,
      ).toBe(0);
    },
    240_000,
  );
});
