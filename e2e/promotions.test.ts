/**
 * HAPPY HOURS AND BRANCH BOOSTS — what a charge actually earns.
 *
 * HOW TO RUN
 *
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run promotions.test.ts
 *
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT IN `concurrency.test.ts`
 * ---------------------------------------------------------------
 * The happy-hour boundary questions were seven `it.todo`s at the bottom of
 * `concurrency.test.ts`, each prefixed "LANE A OWES". Lane A has now landed the
 * promotion tables, the shared liveness predicate and the applied-reward field on
 * the charge response, so they are answerable — but not there. That file drives
 * `packages/mock` by default and owns no database, and every question below needs
 * a happy hour whose window is positioned to the minute against the salon's own
 * clock. So they move here, to a suite that seeds its own.
 *
 * THE WINDOWS ARE COMPUTED IN POSTGRES, ON PURPOSE
 * ------------------------------------------------
 * `api/src/services/promotions.ts` resolves liveness in salon-local time via
 * `offsetFor(salon, now)`. A test that computed its expected window with the same
 * offset logic would be asserting that the implementation agrees with itself —
 * the same trap as signing a webhook with the server's own signing helper.
 *
 * So every window here is derived from `now() AT TIME ZONE salon.timezone`,
 * evaluated by Postgres against its own tzdata. Two independent implementations
 * of "what time is it at this salon" have to agree, and if they ever stop, that
 * disagreement is exactly the defect worth finding.
 *
 * SALON B, AND NOTHING LIVE BY DEFAULT
 * ------------------------------------
 * Every window is created by this file and torn down after it. `seedSalonB()`
 * leaves salon B with two happy hours, both OFF, precisely so that no other
 * suite's money literals depend on a promotion being live — and this file puts
 * salon B back to that state in `afterEach`, so one spec's window cannot leak
 * into the next spec's charge.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
import {
  B_BRANCH,
  B_MEMBER,
  B_MEMBER_PHONE,
  B_SCANNER_DEVICE,
  B_SERVICE,
  B_SERVICE_PRICE_FILS,
  B_STAFF_HANDLE,
  SALON_B,
  mintWalletTokenFor,
  psql,
  scalar,
  signInDashboard,
  signInMember,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

let scanner = '';
let wallet = '';
/** Salon B's manager on the web. Publishes boosts through lane A's own endpoint. */
let dashboard = '';

let n = 0;
const key = (label: string) => `promo-${label}-${Date.now()}-${n++}`;

/** Windows this file created, retired after every spec. */
const MINE = 'HH-PROMO-';

/**
 * Retire everything this file created.
 *
 * SWITCHED OFF AND MOVED OUT OF THE DAY, NOT DELETED — and the reason is a rule
 * the product enforces on purpose. `transaction.promotion_id` references
 * `happy_hour`, so a window that has been applied to a charge CANNOT be removed;
 * `DELETE /v1/salons/{id}/promotions/happy-hours/{hid}` says so in as many words
 * ("the receipts refer to it. Switch it off instead"). The first draft of this
 * file deleted, the delete failed on a foreign key inside `afterEach`, and the
 * leaked window then applied itself to every later spec — which is why nine specs
 * reported the same wrong happy hour id.
 *
 * `on = false` plus a window that cannot contain the current minute is stronger
 * than a delete anyway: it is two independent reasons for the liveness predicate
 * to say no.
 */
function retireMyWindows(): void {
  psql(`
    UPDATE happy_hour
       SET "on" = false, days = '{}', "from" = '00:00', "to" = '00:01'
     WHERE id LIKE '${MINE}%';
  `);
}

beforeAll(async () => {
  await startTenancyApi();
  scanner = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
  wallet = await signInMember(SALON_B, B_MEMBER_PHONE);
  dashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);
}, 120_000);

afterEach(() => {
  // Nothing this file made stays live into the next spec, or into another suite.
  retireMyWindows();
});

afterAll(async () => {
  retireMyWindows();
  await stopTenancyApi();
});

// ------------------------------------------------------------- salon clock --

/**
 * The salon's own wall clock, as POSTGRES sees it. See the file header for why
 * this is not computed in JavaScript.
 *
 * `dow` is Postgres's day-of-week, 0 = Sunday — the same convention
 * `happy_hour.days` uses and the same one `Date.getDay()` uses, which is what
 * makes the two comparable at all. Asserted rather than assumed in the tripwire
 * below.
 */
function salonClock(): { hhmm: string; dow: number; minutes: number } {
  const row = scalar(
    `select to_char(now() AT TIME ZONE s.timezone, 'HH24:MI')
            || '|' || extract(dow from now() AT TIME ZONE s.timezone)::int
            || '|' || (extract(hour from now() AT TIME ZONE s.timezone)::int * 60
                       + extract(minute from now() AT TIME ZONE s.timezone)::int)
       from salon s where s.id = '${SALON_B}'`,
  );
  const [hhmm, dow, minutes] = row.split('|');
  return { hhmm: hhmm!, dow: Number(dow), minutes: Number(minutes) };
}

const hhmm = (minutesFromMidnight: number): string => {
  const m = ((minutesFromMidnight % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * Create a happy hour at salon B.
 *
 * `fromOffset` / `toOffset` are MINUTES RELATIVE TO THE SALON'S CURRENT WALL
 * CLOCK, so a spec says "a window that started ten minutes ago and ends in ten"
 * rather than naming times that would only be right for one hour of one day.
 */
function happyHour(opts: {
  id: string;
  fromOffset: number;
  toOffset: number;
  reward?: string;
  on?: boolean;
  branchId?: string | null;
  days?: number[];
}): string {
  const clock = salonClock();
  const id = `${MINE}${opts.id}`;
  const days = opts.days ?? [clock.dow];
  const branch = opts.branchId === undefined || opts.branchId === null
    ? 'NULL'
    : `'${opts.branchId}'`;

  // Upserted rather than replaced: a window from an earlier run may be referenced
  // by a charge and therefore undeletable. See `retireMyWindows`.
  psql(`
    INSERT INTO happy_hour (id, salon_id, branch_id, days, "from", "to", reward, "on", notify)
    VALUES ('${id}', '${SALON_B}', ${branch}, '{${days.join(',')}}',
            '${hhmm(clock.minutes + opts.fromOffset)}',
            '${hhmm(clock.minutes + opts.toOffset)}',
            '${opts.reward ?? 'x2visit'}', ${opts.on ?? true}, false)
    ON CONFLICT (id) DO UPDATE SET
      branch_id = EXCLUDED.branch_id, days = EXCLUDED.days,
      "from" = EXCLUDED."from", "to" = EXCLUDED."to",
      reward = EXCLUDED.reward, "on" = EXCLUDED."on";
  `);
  return id;
}

// ---------------------------------------------------------------- charging --

interface ChargeResult {
  transaction: { id: string };
  loyalty: { mode: string; visits?: number };
  happyHour: {
    id: string | null;
    visitMultiplier: number;
    stampMultiplier: number;
    creditFils: number;
    minutesRemaining: number;
  } | null;
}

const visitsOf = (): number =>
  Number(scalar(`select visits from member where id='${B_MEMBER}'`));

async function charge(label: string, idemKey?: string): Promise<ChargeResult> {
  const token = await mintWalletTokenFor(wallet, B_MEMBER);
  const res = await treq<ChargeResult>('POST', '/charges', {
    token: scanner,
    idempotencyKey: idemKey ?? key(label),
    body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
  });
  precondition(res.status === 200, `POST /charges answered ${res.status} ${res.raw}`);
  return res.body;
}

// ===========================================================================

describe('the fixture is positioned against the salon\'s own clock', () => {
  it('Postgres and the day-of-week convention agree with JavaScript', () => {
    // The tripwire for everything below. `happy_hour.days` is "0-6, Sunday
    // first" and so is `Date.getDay()`; if Postgres's `dow` ever disagreed,
    // every window this file builds would be positioned on the wrong day and
    // every spec would fail for a reason that has nothing to do with promotions.
    const clock = salonClock();
    expect(clock.dow).toBeGreaterThanOrEqual(0);
    expect(clock.dow).toBeLessThanOrEqual(6);
    expect(clock.hhmm).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    expect(clock.minutes).toBe(
      Number(clock.hhmm.slice(0, 2)) * 60 + Number(clock.hhmm.slice(3)),
    );
  });

  it('salon B has nothing live before this file starts', () => {
    // Otherwise a "no promotion applied" spec below could pass because the
    // fixture was off rather than because the rule works.
    const live = scalar(
      `select count(*) from happy_hour where salon_id='${SALON_B}' and "on" = true`,
    );
    expect(live, 'seedSalonB() left a happy hour switched on').toBe('0');
  });
});

// ---------------------------------------------------------------- liveness --

describe('a live happy hour applies, on the SERVER clock', () => {
  it('a window bracketing now doubles the visit, and the charge says which window did it', async () => {
    const id = happyHour({ id: 'live', fromOffset: -10, toOffset: 10 });
    const before = visitsOf();

    const res = await charge('live');

    expect(res.happyHour, 'a live x2visit window produced no promotion outcome').not.toBeNull();
    expect(res.happyHour!.id, 'the wrong window was credited').toBe(id);
    expect(res.happyHour!.visitMultiplier).toBe(2);
    // The outcome is not decoration — the visit really doubled.
    expect(visitsOf(), 'the charge reported x2 and incremented by one').toBe(before + 2);
  });

  it('and reports how long is left, which is what the scanner counts down', async () => {
    happyHour({ id: 'remaining', fromOffset: -10, toOffset: 20 });
    const res = await charge('remaining');

    precondition(res.happyHour !== null, 'no promotion applied');
    // About twenty minutes. Asserting the exact figure would be asserting the
    // clock; a range catches a field that is zero, negative, or in seconds.
    expect(res.happyHour!.minutesRemaining).toBeGreaterThan(15);
    expect(res.happyHour!.minutesRemaining).toBeLessThanOrEqual(20);
  });

  it('a window that has not started yet does not apply', async () => {
    happyHour({ id: 'future', fromOffset: 30, toOffset: 60 });
    const before = visitsOf();

    const res = await charge('future');

    expect(res.happyHour, 'a window starting in half an hour was applied now').toBeNull();
    expect(visitsOf()).toBe(before + 1);
  });

  it('a window that has already ended does not apply', async () => {
    happyHour({ id: 'past', fromOffset: -60, toOffset: -30 });
    const before = visitsOf();

    const res = await charge('past');

    expect(res.happyHour, 'a window that ended half an hour ago was applied').toBeNull();
    expect(visitsOf()).toBe(before + 1);
  });

  it('a window on another DAY does not apply, however right the time is', async () => {
    // Same hours, tomorrow. The commonest way a window predicate goes wrong is
    // to compare the clock and forget the calendar.
    const clock = salonClock();
    happyHour({
      id: 'otherday',
      fromOffset: -10,
      toOffset: 10,
      days: [(clock.dow + 1) % 7],
    });
    const before = visitsOf();

    const res = await charge('otherday');

    expect(res.happyHour, "a window scheduled for tomorrow applied today").toBeNull();
    expect(visitsOf()).toBe(before + 1);
  });

  it('a window with on:false never applies, even in the middle of its window', async () => {
    happyHour({ id: 'off', fromOffset: -10, toOffset: 10, on: false });
    const before = visitsOf();

    const res = await charge('off');

    expect(res.happyHour, 'a switched-off happy hour was applied').toBeNull();
    expect(visitsOf()).toBe(before + 1);
  });
});

// ---------------------------------------------------------------- boundary --

describe('the boundary is inclusive-start, exclusive-end', () => {
  /**
   * The two ends have to disagree, and this is the pair that proves it. A window
   * `16:00–18:00` that included both ends would make two adjacent windows overlap
   * for a minute; one that included neither would leave a minute of every window
   * unearnable. api-contract.md settles it as `from <= now < to`.
   *
   * `fromOffset: 0` is this minute, so the window opens exactly now.
   */
  it('a charge exactly at `from` earns', async () => {
    happyHour({ id: 'startnow', fromOffset: 0, toOffset: 30 });
    const res = await charge('startnow');

    expect(
      res.happyHour,
      'a window whose `from` is the current minute did not apply — the start is exclusive',
    ).not.toBeNull();
    expect(res.happyHour!.visitMultiplier).toBe(2);
  });

  it('a charge exactly at `to` does not', async () => {
    // Opened half an hour ago, closing this minute.
    happyHour({ id: 'endnow', fromOffset: -30, toOffset: 0 });
    const before = visitsOf();

    const res = await charge('endnow');

    expect(
      res.happyHour,
      'a window whose `to` is the current minute still applied — the end is inclusive',
    ).toBeNull();
    expect(visitsOf()).toBe(before + 1);
  });
});

// ------------------------------------------------------------ one instant --

describe('the reward is decided once, at one instant', () => {
  /**
   * THE BOUNDARY BUG THAT PAYS TWICE.
   *
   * A charge submitted at 17:59:59 and retried at 18:00:01 must return the reward
   * that was decided the first time. An API that re-evaluated the promotion set on
   * the replay would answer "no happy hour" to the retry of a charge that earned
   * one — or, with the window the other way round, grant a second x2 visit for one
   * blow-dry.
   *
   * Waiting out a real boundary would take a suite fifteen minutes and still race.
   * What can be proved deterministically is the mechanism that makes the boundary
   * safe: the decision is stored with the idempotency key and replayed verbatim.
   * So the window is SWITCHED OFF and moved out of the day between the two calls —
   * a far more violent change than a clock ticking over — and the replay must be
   * unmoved by it.
   *
   * Off rather than deleted because the charge now references it and the database
   * refuses; see `retireMyWindows`. For the liveness predicate the two are the
   * same answer, twice over.
   */
  it('an idempotent replay returns the SAME reward, even after the window is switched off', async () => {
    const id = happyHour({ id: 'replay', fromOffset: -10, toOffset: 10 });
    const k = key('replay-same');
    const before = visitsOf();

    /**
     * THE SAME BODY, BYTE FOR BYTE — including the wallet token.
     *
     * A replay is the same request arriving twice, and the API means it: the
     * idempotency key is fingerprinted together with the body, so re-sending with
     * a freshly minted token is a DIFFERENT request and correctly earns
     * `422 idempotency_key_reused`. The first draft of this spec minted a second
     * token and got exactly that, which is the API being right and the test being
     * wrong about what a retry is.
     *
     * A real scanner retrying a tap it never saw the answer to sends the bytes it
     * already has. So does this.
     */
    const token = await mintWalletTokenFor(wallet, B_MEMBER);
    const body = { memberId: B_MEMBER, serviceIds: [B_SERVICE], token };

    const firstRes = await treq<ChargeResult>('POST', '/charges', {
      token: scanner,
      idempotencyKey: k,
      body,
    });
    precondition(firstRes.status === 200, `the first charge failed: ${firstRes.raw}`);
    const first = firstRes.body;

    precondition(first.happyHour !== null, 'the first charge earned no promotion');
    expect(first.happyHour!.id).toBe(id);
    const afterFirst = visitsOf();
    expect(afterFirst, 'x2visit did not double the visit').toBe(before + 2);

    // The window stops being live between the two calls — switched off AND moved
    // out of every day, so the predicate has two reasons to refuse it.
    psql(
      `UPDATE happy_hour SET "on" = false, days = '{}', "from" = '00:00', "to" = '00:01' WHERE id = '${id}';`,
    );

    const replay = await treq<ChargeResult>('POST', '/charges', {
      token: scanner,
      idempotencyKey: k,
      body,
    });

    expect(replay.status, replay.raw).toBe(200);
    expect(
      replay.body.happyHour,
      'the replay re-evaluated the promotion set instead of replaying the stored decision',
    ).not.toBeNull();
    expect(replay.body.happyHour!.id).toBe(id);
    expect(replay.body.happyHour!.visitMultiplier).toBe(2);
    expect(replay.body.transaction.id).toBe(first.transaction.id);
    // And it earned nothing a second time.
    expect(visitsOf(), 'the replay granted the x2 visit again').toBe(afterFirst);
  });
});

// ------------------------------------------------------------- overlapping --

describe('overlapping windows resolve to one outcome', () => {
  it('the best live offer wins, and a flat credit is granted once', async () => {
    // Two live windows offering the same flat credit. `decideEarning` takes the
    // MAX rather than the sum — two overlapping `credit3` windows are one credit,
    // not two — and getting that wrong is money out of the merchant's pocket.
    happyHour({ id: 'ovl-a', fromOffset: -10, toOffset: 10, reward: 'credit3' });
    happyHour({ id: 'ovl-b', fromOffset: -5, toOffset: 20, reward: 'credit3' });

    const balanceBefore = Number(
      scalar(`select balance_fils from member where id='${B_MEMBER}'`),
    );
    const res = await charge('overlap');

    precondition(res.happyHour !== null, 'neither overlapping window applied');
    // 3.000 KD, once. `credit3` — design/api-contract.md § Promotions.
    expect(res.happyHour!.creditFils, 'two overlapping credit3 windows paid twice').toBe(3_000);

    // And the wallet moved by the price less that single credit.
    const balanceAfter = Number(
      scalar(`select balance_fils from member where id='${B_MEMBER}'`),
    );
    expect(balanceAfter).toBe(balanceBefore - B_SERVICE_PRICE_FILS + 3_000);
  });

  it('a x2visit and a credit window together apply both effects, once each', async () => {
    happyHour({ id: 'mix-v', fromOffset: -10, toOffset: 10, reward: 'x2visit' });
    happyHour({ id: 'mix-c', fromOffset: -10, toOffset: 10, reward: 'credit3' });

    const before = visitsOf();
    const res = await charge('mix');

    precondition(res.happyHour !== null, 'no promotion applied');
    expect(res.happyHour!.visitMultiplier).toBe(2);
    expect(res.happyHour!.creditFils).toBe(3_000);
    expect(visitsOf()).toBe(before + 2);
  });
});

// ------------------------------------------------------------ branch scope --

describe('branch scoping', () => {
  it("a window scoped to 'all' branches applies", async () => {
    // The control for the knownBug below: 'all' needs no branch to be known, so
    // it applies today and proves the window machinery itself works.
    happyHour({ id: 'allbranch', fromOffset: -10, toOffset: 10, branchId: null });
    const res = await charge('allbranch');

    expect(res.happyHour, "an 'all branches' window did not apply").not.toBeNull();
    expect(res.happyHour!.visitMultiplier).toBe(2);
  });

  /**
   * BRANCH-SCOPED PROMOTIONS ARE STORED, SERVED, AND APPLIED BY NOBODY — and the
   * near-miss on the way here is the part worth writing down.
   *
   * `POST /charges` takes `{ memberId, serviceIds[], token }`. There is no branch
   * in the contract's body and `routes/charges.ts` reads none, so
   * `decideEarning` receives `branchId: null` and skips every branch-scoped
   * window and every branch boost.
   *
   * THE NEAR-MISS. The transaction row still needs a branch for its NOT NULL
   * column, and it gets one from `defaultBranchId()` — the salon's first branch
   * BY ID. Deriving the earning rate from that instead is the obvious-looking fix
   * and it is badly wrong: lane A hit it live, and the first charge under the new
   * promotion set doubled a customer's visits because 'BR-KWC' sorts before
   * 'BR-SAL' and Kuwait City carried a 2x boost. A sort order decided a
   * multiplier. `services/charge.ts` now passes `input.branchId` explicitly and
   * says why.
   *
   * THE FIX THAT MUST NOT BE TAKEN is letting the client send its branch: a
   * client naming its branch is a client choosing its own multiplier, which is
   * non-negotiable #2 with extra steps. The branch has to come from something the
   * server established — a branch-bound scanner session — and that waits on the
   * device-enrolment decision this suite already flags in `scanner.test.ts`.
   *
   * Held rather than patched, and written down here so it cannot be quietly
   * forgotten. It flips green the day a charge knows where it happened.
   */
  knownBug('a branch-scoped happy hour never applies, because a charge does not know its branch', async () => {
    happyHour({ id: 'branchscoped', fromOffset: -10, toOffset: 10, branchId: B_BRANCH });
    const res = await charge('branchscoped');

    expect(
      res.happyHour,
      'a happy hour scoped to the branch this charge happened at did not apply, because ' +
        'POST /charges cannot establish a branch. Branch boosts have the same problem and ' +
        'the same cause — see services/promotions.ts § PromotionInputs.',
    ).not.toBeNull();
  });

  knownBug('a branch BOOST never applies, for the same reason', async () => {
    /**
     * Published through lane A's OWN endpoint rather than written to the table.
     *
     * That matters for what a failure means: if this spec wrote the row itself, a
     * red result could be "the boost was never stored" as easily as "the boost was
     * never applied", and those belong to different people. Going through
     * `PUT /v1/salons/{id}/promotions/boosts` means the storing half is asserted
     * separately, right here, and only the APPLYING half is in question.
     */
    const published = await treq('PUT', `/v1/salons/${SALON_B}/promotions/boosts`, {
      token: dashboard,
      body: { boosts: { [B_BRANCH]: { visit: 2, topup: 0, stamp: 1 } } },
    });
    precondition(
      published.status === 200,
      `could not publish the boost: ${published.status} ${published.raw}`,
    );
    precondition(
      scalar(`select visit::text from boost where salon_id='${SALON_B}' and branch_id='${B_BRANCH}'`) === '2',
      'the boost endpoint answered 200 but stored nothing — that is a different defect',
    );

    const before = visitsOf();
    try {
      await charge('branchboost');
      expect(
        visitsOf(),
        "a 2x visit boost is published against this salon's branch and the charge still earned " +
          'a single visit — the boost is stored, served to both clients, and applied by neither.',
      ).toBe(before + 2);
    } finally {
      // Back to the identity boost, through the same endpoint. A 2x visit left
      // behind would change what every other suite sees a charge do.
      await treq('PUT', `/v1/salons/${SALON_B}/promotions/boosts`, {
        token: dashboard,
        body: { boosts: { [B_BRANCH]: { visit: 1, topup: 0, stamp: 1 } } },
      });
    }
  });
});

// --------------------------------------------- the branch decision, pinned --

/**
 * WHAT LANE A DECIDED, AND WHY IT NEEDS PINNING RATHER THAN A COMMENT.
 *
 * `transaction.branch_id` is NOT NULL, so every money row needs a branch, and
 * both money paths used to get one the same way: the salon's first branch BY ID.
 * That is a defensible way to ATTRIBUTE a row and an indefensible way to decide
 * what a customer EARNS. It doubled a real customer's visits, because 'BR-KWC'
 * sorts before 'BR-SAL' and Kuwait City carried a 2x boost. Alphabetical order
 * chose a multiplier, and nothing said so.
 *
 * `services/branch.ts` splits the two questions apart:
 *
 *   branchId     always answerable, used for attribution only
 *   established  whether that value is a FACT — gate every earning on this
 *
 * and the invariant that falls out of it is subtle enough to be worth three
 * specs:
 *
 *   ONE BRANCH   there is no sort order to be at the mercy of and nowhere else
 *                the charge could have happened. It is established, its boost
 *                pays, and `branch_assumed` is false.
 *   TWO BRANCHES nobody knows where the charge happened. No boost applies, and
 *                `branch_assumed` is true — the row says of itself that its
 *                branch is a guess, so "which figures can I trust per branch" is
 *                a query rather than an assumption.
 *
 * THE FIX THAT MUST NOT BE TAKEN, and the reason the third spec exists: letting
 * the client name its branch. It is the obvious way to make the multi-branch case
 * pay, it would turn every spec above green, and it is non-negotiable #2 with
 * extra steps — a client naming its branch is a client choosing its own
 * multiplier. The branch has to arrive from something the SERVER established, and
 * that waits on device enrolment. So the third spec asserts that a `branchId` in
 * the charge body is INERT, which is the assertion a well-meaning future fix
 * trips over.
 *
 * THIS BLOCK OWNS ITS OPEN-BRANCH SET, AND DID NOT USED TO
 * ---------------------------------------------------------
 * It asserted `count(*) from branch where salon_id = B` is exactly 2, and named
 * `B_BRANCH` as the branch a multi-branch charge would be attributed to. Both
 * were true of the fixture and neither was in this file's gift.
 *
 * The day `POST /salons/{id}/branches` started working, `configuration.test.ts`
 * created real branches and did not clean them up. The count became 4, so the
 * two-branch precondition failed and the one-branch spec could not get down to
 * one by removing a single row. Worse, lane A mints branch ids as `BR-` plus six
 * random base36 characters, about 61% of which sort before `BR-LUM-HAW` — so the
 * leaked branch won `resolveBranch`'s alphabetical tie-break and the attribution
 * assertion failed on roughly three runs in five. Eight specs, one of them
 * flapping, none of them about a product defect. (The money was never at risk:
 * every such row came back `branch_assumed = true`, so no boost paid — which is
 * the invariant these specs exist for, doing its job while they failed.)
 *
 * So the fixture is now DRIVEN rather than asserted. `soleOpenBranch()` and
 * `reopenEveryBranch()` set the open-branch count this block needs, and the
 * attribution expectation is READ from the database — the first open branch by
 * id, which is what `services/branch.ts` says the answer is — instead of being a
 * literal that happens to be right. Any number of branches another suite leaves
 * behind is now invisible here.
 *
 * CLOSED, NOT DELETED. `closed_at` is how the product retires a branch and it is
 * exactly what `resolveBranch` filters on, so it is both the honest lever and the
 * one that needs no permission from the four tables that reference `branch`. The
 * old version deleted the row, which forced a precondition refusing to run if the
 * branch had ever carried a transaction, a top-up intent or a happy hour — a spec
 * one real charge away from being unrunnable.
 */
describe('the branch decision — one branch is knowledge, two branches is a guess', () => {
  /** Publish a boost through lane A's own endpoint, as the tenancy ledger does. */
  async function publishBoost(branchId: string, visit: number): Promise<void> {
    const res = await treq('PUT', `/v1/salons/${SALON_B}/promotions/boosts`, {
      token: dashboard,
      body: { boosts: { [branchId]: { visit, topup: 0, stamp: 1 } } },
    });
    precondition(res.status === 200, `could not publish the boost: ${res.status} ${res.raw}`);
  }

  /** Back to the identity boost. A live 2x left behind changes what every other suite sees. */
  const resetBoost = () => publishBoost(B_BRANCH, 1);

  const branchOf = (txId: string): string =>
    scalar(`select branch_id || '|' || branch_assumed::text from transaction where id='${txId}'`);

  /**
   * Salon B's open branches, in the order `resolveBranch` sees them.
   *
   * The same `closed_at IS NULL` and the same `ORDER BY id`. A spec that ordered
   * these differently would be asserting against a list the server never had.
   */
  function openBranches(): string[] {
    const rows = scalar(
      `select id from branch where salon_id='${SALON_B}' and closed_at is null order by id`,
    );
    return rows === '' ? [] : rows.split('\n').map((s) => s.trim());
  }

  /** What a charge at salon B must be attributed to right now, per services/branch.ts. */
  const attributedBranch = (): string => {
    const open = openBranches();
    precondition(open.length > 0, 'salon B has no open branch, so no charge can be attributed');
    return open[0]!;
  };

  /** Close every open branch except one, making the salon unambiguously single-branch. */
  function soleOpenBranch(keep: string): void {
    psql(`
      UPDATE branch SET closed_at = now()
       WHERE salon_id='${SALON_B}' AND id <> '${keep}' AND closed_at IS NULL;
    `);
    const open = openBranches();
    precondition(
      open.length === 1 && open[0] === keep,
      `expected ${keep} to be salon B's only open branch, found [${open.join(', ')}]`,
    );
  }

  /** Undo it. Runs in `afterEach`, so a spec that throws cannot leave B single-branched. */
  function reopenEveryBranch(): void {
    psql(`UPDATE branch SET closed_at = NULL WHERE salon_id='${SALON_B}';`);
  }

  afterEach(async () => {
    // Reopen FIRST. `PUT .../boosts` writes a row for every OPEN branch, so
    // resetting the boost before reopening would leave the closed ones holding
    // whatever they held when this block started.
    reopenEveryBranch();
    await resetBoost();
  });

  it('TWO BRANCHES — the boost does not pay, and the row admits its branch was assumed', async () => {
    reopenEveryBranch();
    precondition(
      openBranches().length >= 2,
      'salon B is not multi-branch, so this spec is about the other case',
    );
    // Published against the branch the charge will actually be attributed to, so
    // a boost that DID pay would be unmistakable. Naming a different branch would
    // let this pass for the boring reason.
    const expected = attributedBranch();
    await publishBoost(expected, 2);

    const before = visitsOf();
    const res = await charge('multi-branch');

    expect(
      visitsOf(),
      'a 2x boost paid at a salon where nobody knows which branch the charge happened at',
    ).toBe(before + 1);
    expect(res.happyHour, 'a boost is not a happy hour and must not be reported as one').toBeNull();

    // The attribution is still made — the column is NOT NULL — and it is marked.
    expect(
      branchOf(res.transaction.id),
      'the row presents an alphabetically-chosen branch as a fact',
    ).toBe(`${expected}|true`);
  });

  it('ONE BRANCH — the boost pays, and the row does NOT claim its branch was assumed', async () => {
    /**
     * Single-branch for the duration of this spec, and reopened in `afterEach` —
     * so a crash between the two cannot leave salon B one-branched for the next
     * file, and `seedSalonB()` clears `closed_at` on the next run regardless.
     *
     * CLOSING RATHER THAN DELETING is what makes this spec runnable at all. The
     * previous version deleted the branch row, which meant it first had to prove
     * the branch carried no `transaction`, `topup_intent` or `happy_hour` — three
     * tables that hold history and a merchant's configuration, and that a spec has
     * no business clearing to make its own DELETE succeed. It was one real charge
     * away from refusing to run. `closed_at` is the product's own retirement lever
     * and the exact column `resolveBranch` filters on, so it needs nobody's
     * permission and asserts against the mechanism that actually decides.
     *
     * The boost is published AFTER the close, because `PUT .../boosts` writes a
     * row for every OPEN branch — publishing first would leave the branches this
     * spec is about to close holding a stale row.
     */
    soleOpenBranch(B_BRANCH);
    await publishBoost(B_BRANCH, 2);

    const before = visitsOf();
    const res = await charge('single-branch');

    expect(
      visitsOf(),
      'a single-branch salon published a 2x visit boost and the charge earned one visit. ' +
        'There is no sort order to be wrong about here — the branch is knowledge, and ' +
        'services/branch.ts says the boost applies.',
    ).toBe(before + 2);
    // Still not a happy hour: `transaction.promotion_id` stays null, because no
    // window produced this. A boost that reported itself as a window would put a
    // countdown on the scanner for something that never ends.
    expect(res.happyHour).toBeNull();

    expect(
      branchOf(res.transaction.id),
      'the only branch the charge could have happened at is recorded as assumed',
    ).toBe(`${B_BRANCH}|false`);
  });

  it('A CLIENT CANNOT NAME ITS BRANCH — a branchId in the charge body is inert', async () => {
    /**
     * THE REGRESSION THIS EXISTS TO CATCH, stated as a behaviour rather than as a
     * rule in a comment.
     *
     * Salon B is multi-branch, a 2x boost is live on `B_BRANCH`, and the request
     * body says the charge happened at `B_BRANCH`. If the handler believed it,
     * the customer would earn two visits and `branch_assumed` would be false —
     * and the scanner would have chosen its own multiplier, which is exactly the
     * failure mode `POST /charges` is non-negotiable #2 about.
     *
     * `routes/charges.ts` reads `memberId`, `serviceIds` and `token` and nothing
     * else; `resolveBranch`'s `supplied` argument exists for a branch-bound
     * device session the SERVER established, and no route may start feeding it
     * from a body. Asserted here so that "no route reads a branch from a request"
     * is checkable rather than a convention.
     *
     * The body names `B_BRANCH` specifically — a REAL, OPEN branch of this very
     * salon, and the one carrying the 2x. A made-up id would prove nothing: the
     * handler could be reading the field and merely failing to find it.
     */
    reopenEveryBranch();
    precondition(
      openBranches().length >= 2,
      'salon B must be ambiguous for this spec — a single-branch salon pays its boost anyway',
    );
    const expected = attributedBranch();
    await publishBoost(B_BRANCH, 2);

    const token = await mintWalletTokenFor(wallet, B_MEMBER);
    const before = visitsOf();
    const res = await treq<ChargeResult>('POST', '/charges', {
      token: scanner,
      idempotencyKey: key('client-branch'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token, branchId: B_BRANCH },
    });
    precondition(res.status === 200, `POST /charges answered ${res.status} ${res.raw}`);

    expect(
      visitsOf(),
      'the client named its branch and was paid that branch\'s boost — a client choosing ' +
        'its own multiplier',
    ).toBe(before + 1);
    expect(
      branchOf(res.body.transaction.id),
      'a branch supplied by the client was laundered into an established one',
    ).toBe(`${expected}|true`);
  });
});

// ------------------------------------------------------------- what is left --

describe('GAP: promotion questions still out of reach', () => {
  it.todo(
    'a charge submitted at 17:59:59 and COMMITTED at 18:00:01 resolves against the submit ' +
      'instant, not the commit instant. The replay spec above proves the decision is stored ' +
      'and replayed, which is the mechanism that makes this safe; pinning the instant itself ' +
      'needs a clock-injection hook in the API that does not exist',
  );
  it.todo(
    'a happy hour that has been applied to a charge cannot be DELETED (the API answers ' +
      'happy_hour_in_use, api/src/routes/platform.ts) — needs a charge and a delete in the ' +
      'same suite, and belongs with the merchant dashboard specs rather than here',
  );
  it.todo(
    'the customer-facing countdown in GET /v1/salons/{id}/promotions names the window closest ' +
      'to ENDING, while the earning rate takes the best live offer — two different questions ' +
      'over one set. Assert they can disagree, with two overlapping windows of different rewards',
  );
});
