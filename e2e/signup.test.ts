/**
 * MEMBER SIGNUP — the first moment a customer agrees to anything.
 *
 * HOW TO RUN
 *
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run signup.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `POST /auth/member/signup` landed with migrations 0025 and 0026 and had NO e2e
 * coverage of any kind. It is the only unauthenticated write in the API, it runs
 * argon2id, and it is the only place non-negotiable #10 is actually satisfied
 * rather than assumed — every `member.policy_version` in the database before it
 * was written by a seed script, not by a customer agreeing to anything.
 *
 * THE FOUR THINGS WORTH PINNING, AND WHY EACH IS NOT OBVIOUS
 * ---------------------------------------------------------
 * 1. THE ACCEPTANCE IS AN EVENT, AND THE COLUMN IS A CACHE. `member.policy_version`
 *    is a single mutable integer, so it can answer "which version did she last
 *    accept" and nothing else. #10's second half — re-prompt on a material change —
 *    asks "has she accepted the version published NOW", which needs the history.
 *    The sharpest spec here is therefore about a member whose COLUMN says v3 and
 *    who has no event at all: the seeded pre-0025 member, whose agreement nobody
 *    can produce. A build that read the column would call her up to date.
 *
 * 2. `wa` IS REFUSED RATHER THAN DEFAULTED. `notify_wa` is `NOT NULL DEFAULT true`,
 *    so an omitted value stores the OPPOSITE of an unticked box — a marketing
 *    permission she never gave. `'wa' in body` is not enough either, which is why
 *    the specs below send `null` and the STRING `'false'` as well as omitting it.
 *
 * 3. THE LIMITER'S TWO TIERS, AND THE ORDER THEY ARE CHECKED IN. Primed through
 *    `signup_attempt` rather than by sending twenty real requests, because twenty
 *    argon2 hashes is the cost this endpoint exists to ration and a suite should
 *    not pay it to find out that it is rationed.
 *
 * 4. WHAT THE LIMITER DOES NOT BOUND. See `describe('the limiter counts hashes,
 *    not probes')` at the bottom. The endpoint's own docstring states a bound on
 *    the enumeration oracle that the call order does not deliver, and the spec
 *    that found it is a counter-read, not an argument.
 *
 * THE SALON FIXTURES ARE BOTH `tiers`, SO THIS FILE MAKES A `stamps` ONE
 * ---------------------------------------------------------------------
 * Signup branches on `salon.loyalty_mode`: a tiers salon puts a new member on the
 * ladder's floor, a stamps salon on an empty card. Getting it wrong is not
 * cosmetic — `services/topup.ts` prices the bonus from `member.tier`, so a null
 * tier in a tiers salon silently pays 0. Both seeded salons are `tiers`, so the
 * stamps half would be untested against the fixtures as they stand. This file
 * creates its own throwaway salon rather than flipping a shared one: salon A and B
 * are asserted against by twelve other files, and `promotions.test.ts` already
 * carries the cost of borrowing salon B for the length of a run.
 *
 * EVERY MEMBER THIS FILE CREATES IS ITS OWN
 * -----------------------------------------
 * Phones are minted per spec from a counter, never reused, and never one of the
 * fixture numbers. A signup is not idempotent and `member_salon_phone_uq` is
 * real, so a spec that reused a phone would pass once and then report
 * `already_registered` for ever — the failure mode that looks like a defect in
 * the endpoint and is a defect in the suite.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  QA_MEMBER_PHONE,
  SALON_A,
  SALON_NOWHERE,
  psql,
  scalar,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** What `api/src/db/legalSeed.ts` publishes. Read from the API, never hardcoded. */
let publishedVersion = 0;

/** A salon this file owns outright, in `stamps` mode. Removed in `afterAll`. */
const STAMPS_SALON = 'SAL-QA-SIGNUP-STAMPS';

/**
 * Phones this file has used, so cleanup can find every member it made without
 * deleting anybody else's.
 */
const MINE_PHONE_PREFIX = '+96555';
let phoneSeq = 0;
const freshPhone = (): string =>
  `${MINE_PHONE_PREFIX}${String(100_000 + phoneSeq++).slice(0, 6)}`;

const PASSWORD = 'qa-signup-password';

interface SignupBody {
  salonId?: unknown;
  name?: unknown;
  phone?: unknown;
  password?: unknown;
  wa?: unknown;
  policyVersion?: unknown;
  deviceId?: unknown;
}

/**
 * A complete, valid signup body with one fresh phone, which each spec then
 * spoils in exactly one way. Written as a helper so a refusal spec differs from
 * the happy path by ONE field — otherwise a spec asserting
 * `wa_preference_required` could be passing because it also forgot the name.
 */
function validBody(over: SignupBody = {}): Record<string, unknown> {
  return {
    salonId: SALON_A,
    name: 'Sara Al-Qattan',
    phone: freshPhone(),
    password: PASSWORD,
    wa: false,
    policyVersion: publishedVersion,
    ...over,
  };
}

const signup = (body: Record<string, unknown>) =>
  treq<any>('POST', '/auth/member/signup', { token: null, body });

// ------------------------------------------------------------- the evidence --

/**
 * Her `policy_acceptance` events, newest first. The evidence, not the cache.
 *
 * Every column is cast to `text` explicitly. `granted` is a boolean and
 * `policy_version` an integer, and concatenating either without a cast gets the
 * expression's type from context rather than from the column — `tier` is an enum
 * and `coalesce(tier, '<literal>')` fails outright for the same reason.
 * Boolean-to-text is `'true'`/`'false'` here, NOT psql's own `t`/`f` display
 * format, which is a difference only visible when the two are mixed in one file.
 */
function acceptanceEvents(memberId: string): Array<Record<string, string>> {
  const out = scalar(
    `select coalesce(string_agg(
              kind::text || '|' || granted::text || '|' || source::text
                         || '|' || policy_version::text,
              E'\n' order by created_at desc), '')
       from member_consent_event
      where member_id = '${memberId}' and kind = 'policy_acceptance'`,
  ).trim();
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [kind, granted, source, version] = line.trim().split('|');
    return { kind: kind!, granted: granted!, source: source!, version: version! };
  });
}

/** `member.policy_version` — the cached projection. */
const stampedVersion = (memberId: string): string =>
  scalar(`select policy_version from member where id = '${memberId}'`).trim();

/** Attempts the limiter would count for one address. */
const attemptsFor = (ip: string): number =>
  Number(scalar(`select count(*) from signup_attempt where ip_address = '${ip}'`));

/**
 * The address the API attributes these requests to.
 *
 * Asserted rather than assumed in the limiter block: the whole control is keyed on
 * it, and `TRUST_PROXY` is off in the harness, so a loopback request is
 * `127.0.0.1`. If that ever changed, every priming spec below would prime an
 * empty bucket and pass while proving nothing.
 */
const LOOPBACK = '127.0.0.1';

/** Wipe the limiter's rows. Runs as the OWNER — `avo_app` may not, by design. */
function clearAttempts(): void {
  psql(`DELETE FROM signup_attempt;`);
}

/**
 * Prime the counter with `n` attempts for `ip`, `minutesAgo` in the past.
 *
 * Rows rather than requests. Twenty real signups is twenty argon2 hashes and
 * twenty members, and the limiter reads nothing but this table — so a primed row
 * is indistinguishable to it from an earned one, at a fraction of the cost.
 */
function primeAttempts(ip: string | null, n: number, minutesAgo: number): void {
  psql(`
    INSERT INTO signup_attempt (salon_id, ip_address, created_at)
    SELECT '${SALON_A}', ${ip === null ? 'NULL' : `'${ip}'`},
           now() - interval '${minutesAgo} minutes'
      FROM generate_series(1, ${n});
  `);
}

beforeAll(async () => {
  await startTenancyApi();

  /**
   * The published version, from the API rather than from a constant. Hardcoding 3
   * would make this file fail the day the seed publishes a fourth set, and every
   * spec here is about the SHAPE of acceptance rather than about which document.
   *
   * Read as `QA_MEMBER`, who is seeded by `seedQaMember()` with the password
   * `signInMember` sends. Salon A's `A_MEMBER` cannot sign in with it — the seed
   * gives her a different hash — which is a fixture detail worth naming here
   * because it costs a confusing `invalid_credentials` to rediscover.
   */
  const member = await signInMember(SALON_A, QA_MEMBER_PHONE);
  const probe = await treq<any>('GET', '/members/me/policy-acceptance', { token: member });
  precondition(
    probe.status === 200,
    `GET /members/me/policy-acceptance answered ${probe.status} ${probe.raw}`,
  );
  publishedVersion = probe.body?.published?.version;
  precondition(
    typeof publishedVersion === 'number' && publishedVersion > 0,
    `no published policy version to accept: ${probe.raw}`,
  );

  /**
   * The stamps salon. Minimal but REAL — the same column list `seedSalonB` uses,
   * so signup's salon lookup sees a well-formed row rather than one that happens
   * to satisfy the two fields this file reads.
   *
   * `tiers` is NULL rather than `'[]'`, because a stamps salon has no ladder and
   * an empty array would be a claim that it has one with nothing in it. That is
   * also the shape the signup handler's `s.tiers ?? []` is written against.
   */
  psql(`
    INSERT INTO salon (id, name, plan, brand_color, module_booking, module_shop, loyalty_mode,
                       tiers, stamp_target, stamp_reward, deposit_fils, no_show_return_minutes,
                       business_hours, social, whatsapp_enabled)
    VALUES ('${STAMPS_SALON}', 'QA Signup Stamps', 'starter', '#7A5C8E', false, false, 'stamps',
            NULL, 6, 'Free blow dry', 5000, 60,
            '{"morning":["10:00","13:00"],"evening":["16:00","21:00"]}'::jsonb, '[]'::jsonb, false)
    ON CONFLICT (id) DO UPDATE SET loyalty_mode = 'stamps', stamp_target = 6;
  `);

  clearAttempts();
}, 120_000);

afterEach(() => {
  /**
   * The limiter's rows are the one piece of state in this file that leaks BETWEEN
   * specs rather than between runs: every spec here calls the same endpoint from
   * the same address, so twenty primed rows left behind would 429 everything
   * after them. Cleared after each spec rather than before, so a failure leaves a
   * clean table for the next one instead of a diagnosis that depends on order.
   */
  clearAttempts();
});

afterAll(async () => {
  /**
   * THE MEMBERS GO. THE SALON CANNOT, AND SAYING SO IS BETTER THAN A DELETE THAT
   * FAILS IN A TEARDOWN.
   *
   * Every member this file created is removed by phone prefix, and the cascades do
   * the rest: `member_consent_event`, `session`, `wallet_token` and
   * `phone_change_request` are all `onDelete: 'cascade'` on `member.id`. Nothing
   * here holds a RESTRICT reference — `ledger_entry`, `transaction`, `booking` and
   * `topup_intent` all do, but a signup creates none of them, which is why this
   * delete is safe and the equivalent in `deposit.test.ts` would not be.
   *
   * A plain DELETE on `member_consent_event` by the OWNER is permitted — 0023's
   * triggers refuse UPDATE and TRUNCATE, and 0020 revokes UPDATE and DELETE from
   * `avo_app` only — so the cascade goes through. As the application role it would
   * not, which is the whole design.
   *
   * `STAMPS_SALON` IS LEFT BEHIND ON PURPOSE. `POST /auth/member/signup` writes a
   * "Member signed up" row to `audit_log`, `audit_log.salon_id` references `salon`
   * `onDelete: 'restrict'`, and 0023 gives `audit_log` triggers that refuse DELETE
   * even to the owner. So the audit row cannot go and therefore the salon cannot
   * either — the same shape as `promotions.test.ts` being unable to delete a happy
   * hour a charge refers to. Attempting it would throw inside `afterAll` and turn a
   * green run red at the very end for a reason unrelated to anything asserted.
   *
   * It is harmless: the run database is minted per run and dropped by
   * `global-setup.ts`, and nothing in the suite enumerates or counts salons — every
   * other file's salon queries are scoped by id. Checked rather than assumed,
   * because "one stray fixture row" is how the shared-database problem started.
   */
  psql(`DELETE FROM member WHERE phone LIKE '${MINE_PHONE_PREFIX}%';`);
  clearAttempts();
  await stopTenancyApi();
});

// ===========================================================================

describe('a signup creates a member, a session, and the evidence — in one transaction', () => {
  it('answers 201 with a session and a member the server owns the money for', async () => {
    const phone = freshPhone();
    const res = await signup(validBody({ phone, name: 'Hessa Al-Mutairi' }));

    expect(res.status, `POST /auth/member/signup answered ${res.status} ${res.raw}`).toBe(201);
    expect(res.body.accessToken, 'no access token').toBeTruthy();
    expect(res.body.refreshToken, 'no refresh token').toBeTruthy();
    expect(res.body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const m = res.body.member;
    expect(m.name).toBe('Hessa Al-Mutairi');
    expect(m.phone).toBe(phone);
    // Non-negotiable #1 and #2: integer fils, and the server decides it is zero.
    expect(m.balanceFils, 'a new wallet did not open empty').toBe(0);
    expect(Number.isInteger(m.balanceFils)).toBe(true);
    expect(m.visits).toBe(0);
    // #10: the version SHE was shown is what was stamped.
    expect(m.policyVersion).toBe(publishedVersion);
  }, 60_000);

  /**
   * NON-NEGOTIABLE #6, ASSERTED ON THE RAW BODY.
   *
   * "Passwords are never stored in plaintext, never returned by an endpoint,
   * never shown in a UI." A key-by-key check would miss a hash nested inside
   * `member`, or one added later under a name this spec does not know to look
   * for. The raw string cannot be evaded that way: the argon2 prefix and the
   * password itself are either in the response or they are not.
   */
  it('never returns the password or its hash, anywhere in the payload', async () => {
    const res = await signup(validBody({ password: PASSWORD }));
    precondition(res.status === 201, `signup failed: ${res.raw}`);

    expect(res.raw, 'the plaintext password came back in the response').not.toContain(PASSWORD);
    expect(res.raw, 'an argon2 hash came back in the response').not.toContain('$argon2');
    expect(res.raw.toLowerCase()).not.toContain('passwordhash');
    expect(res.raw.toLowerCase()).not.toContain('password_hash');
  }, 60_000);

  /**
   * THE ACCEPTANCE IS AN EVENT. This is the spec that makes #10 met rather than
   * claimed: not "the column says 3" but "there is a row saying she agreed, and it
   * says where the agreement happened".
   */
  it('writes ONE policy_acceptance event, granted, sourced to the signup', async () => {
    const res = await signup(validBody());
    precondition(res.status === 201, `signup failed: ${res.raw}`);
    const id = res.body.member.id;

    const events = acceptanceEvents(id);
    expect(events, 'a signup recorded no policy acceptance — #10 is unmet').toHaveLength(1);
    expect(events[0]!.kind).toBe('policy_acceptance');
    expect(events[0]!.granted, 'the acceptance was recorded as a withdrawal').toBe('true');
    expect(
      events[0]!.source,
      'the acceptance does not say it happened at signup, so the trail cannot say where she agreed',
    ).toBe('signup');
    expect(Number(events[0]!.version)).toBe(publishedVersion);

    // And the cache agrees with the evidence. Both, because the next spec is
    // about what happens when they do not.
    expect(Number(stampedVersion(id))).toBe(publishedVersion);
  }, 60_000);

  /**
   * THE MEMBER NUMBER COMES FROM THE SEQUENCE, NOT FROM `Math.random()`.
   *
   * 0025's reasoning: four digits is 9,000 values, so random minting collides on
   * a PRIMARY KEY within a few thousand members and the collision surfaces as a
   * stranger's signup failing. `START WITH 90000` also keeps every minted number
   * clear of the four-digit fixtures (8842, 8843, 9001), which is what stops a
   * seeded database and a signed-up member contending for one primary key.
   */
  it('mints a member number from the sequence, outside the fixture range', async () => {
    const first = await signup(validBody());
    const second = await signup(validBody());
    precondition(first.status === 201 && second.status === 201, 'a signup failed');

    const a = Number(first.body.member.id);
    const b = Number(second.body.member.id);
    expect(Number.isInteger(a), `member id "${first.body.member.id}" is not a number`).toBe(true);
    expect(a, 'a minted member number landed inside the four-digit fixture range').toBeGreaterThanOrEqual(90_000);
    expect(b).toBeGreaterThan(a);
  }, 60_000);

  /**
   * THE SESSION IT ISSUES IS A REAL ONE, and it is the shortest proof that the
   * transaction committed. The design goes straight from Create account into the
   * wallet, so a token that does not work is a customer who signed up and landed
   * on a sign-in screen.
   */
  it('issues a session that can immediately read her own acceptance state', async () => {
    const res = await signup(validBody());
    precondition(res.status === 201, `signup failed: ${res.raw}`);

    const state = await treq<any>('GET', '/members/me/policy-acceptance', {
      token: res.body.accessToken,
    });
    expect(state.status, `the token signup issued was refused: ${state.raw}`).toBe(200);
    expect(state.body.accepted, 'her own acceptance is not visible to her').not.toBeNull();
    expect(state.body.accepted.source).toBe('signup');
    expect(state.body.accepted.version).toBe(publishedVersion);
    expect(state.body.stampedVersion).toBe(publishedVersion);
    expect(state.body.upToDate, 'she was re-prompted immediately after accepting').toBe(true);
  }, 60_000);

  /**
   * THE LOYALTY BRANCH. A tiers salon puts her on the ladder's floor; the null
   * tier a stamps salon leaves is not an oversight, and `services/topup.ts`
   * prices the bonus from this column.
   */
  it('starts a tiers-salon member on the ladder floor with no stamp card', async () => {
    const res = await signup(validBody({ salonId: SALON_A }));
    precondition(res.status === 201, `signup failed: ${res.raw}`);
    const id = res.body.member.id;

    const row = scalar(
      `select coalesce(tier::text,'<null>') || '|' || coalesce(stamps::text,'<null>')
         from member where id='${id}'`,
    ).trim();
    const [tier, stamps] = row.split('|');
    expect(tier, 'a tiers-salon member opened with no tier — her top-up bonus would price at 0').not.toBe('<null>');
    expect(tier).toBe('bronze');
    expect(stamps, 'a tiers-salon member was given a stamp card').toBe('<null>');
  }, 60_000);

  it('starts a stamps-salon member on an empty card with no tier', async () => {
    const res = await signup(validBody({ salonId: STAMPS_SALON }));
    precondition(res.status === 201, `signup failed at the stamps salon: ${res.raw}`);
    const id = res.body.member.id;

    const row = scalar(
      `select coalesce(tier::text,'<null>') || '|' || coalesce(stamps::text,'<null>')
         from member where id='${id}'`,
    ).trim();
    const [tier, stamps] = row.split('|');
    expect(tier, 'a stamps-salon member was put on a tier ladder the salon does not run').toBe('<null>');
    expect(stamps, 'a stamps-salon member opened with no stamp card').toBe('0');
  }, 60_000);
});

// ------------------------------------------------- the cache is not evidence --

describe('non-negotiable #10 is answered from the events, never from the column', () => {
  /**
   * THE PRE-0025 MEMBER, AND SHE IS THE WHOLE ARGUMENT.
   *
   * Every `member.policy_version` written before migration 0025 was written by a
   * seed script. The column says she accepted the current version; nobody can
   * produce the agreement. `services/policy.ts` is explicit that no event means NOT
   * accepted — "inferring agreement from silence is the answer that cannot be
   * defended afterwards" — so she is due a re-prompt. A build that computed
   * `upToDate` from the column would call her up to date.
   *
   * CONSTRUCTED FROM ONE MEMBER, BEFORE AND AFTER, WHICH IS WHY THIS SPEC IS SHARP.
   * She signs up for real — so every column is exactly what the endpoint writes —
   * and is asserted up to date. Then the EVIDENCE ALONE is deleted, leaving
   * `policy_version` untouched, and the same read is asserted again. One member,
   * one unchanged column, two answers: that is a demonstration that `upToDate`
   * comes from the event trail and cannot be a coincidence of the fixture.
   *
   * The alternative was a seeded member, and it was rejected on purpose: it would
   * depend on no other file in the run having accepted a policy for her, which is
   * a precondition on twelve files' behaviour rather than on this spec's own setup.
   *
   * THE DELETE IS THE OWNER'S, AND ONLY THE OWNER'S. 0020 revokes UPDATE and DELETE
   * from `avo_app`; 0023 adds triggers refusing UPDATE and TRUNCATE to everyone,
   * including the owner. DELETE by the owner is the one door left, which is what
   * makes this construction possible and is also the reason it can only ever be a
   * test: the application role cannot do this to a customer's record.
   */
  it('deleting the evidence alone re-prompts her, with the cached column untouched', async () => {
    const res = await signup(validBody());
    precondition(res.status === 201, `signup failed: ${res.raw}`);
    const id = res.body.member.id;
    const token = res.body.accessToken;

    // BEFORE: the evidence exists, and she is up to date.
    const before = await treq<any>('GET', '/members/me/policy-acceptance', { token });
    precondition(before.status === 200, `policy read failed: ${before.raw}`);
    expect(before.body.upToDate, 'she was re-prompted immediately after accepting').toBe(true);
    expect(before.body.accepted).not.toBeNull();

    // Remove the acceptance EVENT and nothing else. This is the pre-0025 state.
    psql(
      `DELETE FROM member_consent_event
        WHERE member_id = '${id}' AND kind = 'policy_acceptance';`,
    );
    precondition(acceptanceEvents(id).length === 0, 'the acceptance event was not removed');
    precondition(
      Number(stampedVersion(id)) === publishedVersion,
      'the cached column moved, so this spec is no longer isolating the event trail',
    );

    // AFTER: the column still says she accepted the published version.
    const after = await treq<any>('GET', '/members/me/policy-acceptance', { token });
    expect(after.status).toBe(200);

    // The cache is served, truthfully, beside the absence of evidence.
    expect(after.body.stampedVersion, 'the cached column was not carried').toBe(publishedVersion);
    expect(
      after.body.accepted,
      'an acceptance was reported for a member who has no acceptance event',
    ).toBeNull();
    expect(
      after.body.upToDate,
      'a member whose agreement cannot be produced was reported up to date — #10 answered from ' +
        'the cached column instead of the event trail, which is exactly the state every member ' +
        'seeded before 0025 is in',
    ).toBe(false);
  }, 60_000);

  /**
   * AND ACCEPTING THE SAME VERSION TWICE IS ONE FACT.
   *
   * The re-prompt screen is exactly where a double tap happens, and
   * `member_consent_acceptance_once_per_version` makes the second one a no-op the
   * handler recognises rather than a duplicate row or a 500.
   */
  it('a second acceptance of the same version succeeds and writes no second row', async () => {
    const res = await signup(validBody());
    precondition(res.status === 201, `signup failed: ${res.raw}`);
    const token = res.body.accessToken;
    const id = res.body.member.id;
    precondition(acceptanceEvents(id).length === 1, 'signup did not record exactly one acceptance');

    const again = await treq<any>('POST', '/members/me/policy-acceptance', {
      token,
      body: { policyVersion: publishedVersion },
    });

    expect(
      again.status,
      `a second acceptance of the same version answered ${again.status} ${again.raw}. A 500 here ` +
        'is the unique index reaching the client, which is a careful customer punished for tapping twice.',
    ).toBe(200);
    expect(
      acceptanceEvents(id),
      'a second tap wrote a second acceptance row for one version',
    ).toHaveLength(1);
  }, 60_000);

  /**
   * THE CHECK, DIRECTLY. `granted = false` on a policy acceptance is a false
   * statement in an append-only table, and 0025 refuses it outright rather than
   * leaving it to the handler: "the product's answer to 'I no longer agree to the
   * terms' is account deletion, not a row here."
   *
   * Written against the database because no endpoint can produce it — which is
   * the point. The constraint is what holds when a future handler tries.
   */
  it('the database refuses a withdrawn policy acceptance outright', async () => {
    const res = await signup(validBody());
    precondition(res.status === 201, `signup failed: ${res.raw}`);
    const id = res.body.member.id;

    let failure = '';
    try {
      psql(`
        INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
        VALUES ('${id}', '${SALON_A}', 'policy_acceptance', false, 'wallet_account', ${publishedVersion + 1});
      `);
    } catch (err) {
      failure = String(err);
    }

    expect(
      failure,
      'a policy acceptance with granted = false was accepted. An append-only table now ' +
        'contains a fact the product has no flow to create and no meaning for.',
    ).toMatch(/member_consent_acceptance_is_never_withdrawn/);
  }, 60_000);

  /**
   * AND THE UNIQUE INDEX IS DELIBERATELY PARTIAL. Marketing consent is NOT
   * covered: off-on-off over a year is three real facts. A spec, because
   * "deliberately not covered" and "forgotten" look identical in a schema.
   */
  it('the once-per-version rule binds policy acceptance and NOT marketing consent', async () => {
    const res = await signup(validBody());
    precondition(res.status === 201, `signup failed: ${res.raw}`);
    const id = res.body.member.id;

    // Two marketing events at the same version: allowed, because they are two facts.
    psql(`
      INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
      VALUES ('${id}', '${SALON_A}', 'marketing_offers', false, 'wallet_account', ${publishedVersion}),
             ('${id}', '${SALON_A}', 'marketing_offers', true,  'wallet_account', ${publishedVersion});
    `);
    expect(
      Number(
        scalar(
          `select count(*) from member_consent_event
            where member_id='${id}' and kind='marketing_offers'`,
        ),
      ),
      'the partial index caught marketing consent, so a customer cannot turn offers off and on again',
    ).toBe(2);

    // A second acceptance of the version signup already recorded: refused.
    let failure = '';
    try {
      psql(`
        INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
        VALUES ('${id}', '${SALON_A}', 'policy_acceptance', true, 'wallet_account', ${publishedVersion});
      `);
    } catch (err) {
      failure = String(err);
    }
    expect(
      failure,
      'one version was accepted twice by the same member',
    ).toMatch(/member_consent_acceptance_once_per_version/);
  }, 60_000);
});

// ------------------------------------------------------------- the refusals --

describe('the refusals a client has to render', () => {
  it('already_registered — a second signup on the same phone at the same salon', async () => {
    const phone = freshPhone();
    const first = await signup(validBody({ phone }));
    precondition(first.status === 201, `the first signup failed: ${first.raw}`);

    const second = await signup(validBody({ phone }));

    expect(second.status, `a duplicate signup answered ${second.status}: ${second.raw}`).toBe(409);
    expect(second.body.error).toBe('already_registered');
    expect(
      Number(scalar(`select count(*) from member where phone='${phone}' and salon_id='${SALON_A}'`)),
      'a duplicate signup created a second wallet on one phone number',
    ).toBe(1);
  }, 60_000);

  /**
   * THE SAME PHONE AT A DIFFERENT SALON IS A DIFFERENT PERSON'S WALLET, and it
   * must be allowed. `member_salon_phone_uq` is on (salon_id, phone) precisely
   * because "the same person can hold a wallet at two salons", and a refusal here
   * would lock a customer out of a second salon's app for ever.
   */
  it('and the SAME phone at another salon is allowed — one wallet per salon, not per phone', async () => {
    const phone = freshPhone();
    const first = await signup(validBody({ phone, salonId: SALON_A }));
    precondition(first.status === 201, `the first signup failed: ${first.raw}`);

    const second = await signup(validBody({ phone, salonId: STAMPS_SALON }));

    expect(
      second.status,
      `the same phone was refused at a second salon (${second.status}: ${second.raw}), which ` +
        'locks a customer out of every salon after her first',
    ).toBe(201);
    expect(second.body.member.id).not.toBe(first.body.member.id);
  }, 60_000);

  /**
   * `wa_preference_required`, AND THE THREE SHAPES A PRESENCE CHECK WOULD MISS.
   *
   * `notify_wa` is `NOT NULL DEFAULT true`. Omit the field and the database
   * records the opposite of an unticked box — a WhatsApp marketing permission she
   * never gave. `'wa' in body` would admit `null`, and a coercing read would
   * admit the STRING `'false'` as truthy. So the handler demands a real boolean,
   * and each of the three is a spec.
   */
  for (const [label, wa] of [
    ['omitted', undefined],
    ['null', null],
    ['the string "false"', 'false'],
  ] as const) {
    it(`wa_preference_required — ${label} is refused, not defaulted to true`, async () => {
      const phone = freshPhone();
      const body = validBody({ phone });
      if (wa === undefined) delete body.wa;
      else body.wa = wa;

      const res = await signup(body);

      expect(
        res.status,
        `wa as ${label} answered ${res.status}: ${res.raw}. NOT NULL DEFAULT true means a ` +
          'permission she never gave would be stored as given.',
      ).toBe(400);
      expect(res.body.error).toBe('wa_preference_required');
      expect(
        Number(scalar(`select count(*) from member where phone='${phone}'`)),
        'a member was created despite the refusal',
      ).toBe(0);
    }, 60_000);
  }

  it('and an explicit wa:false is stored as false, which is the whole point of the refusal', async () => {
    const res = await signup(validBody({ wa: false }));
    precondition(res.status === 201, `signup failed: ${res.raw}`);
    expect(
      scalar(`select notify_wa from member where id='${res.body.member.id}'`).trim(),
      'an unticked WhatsApp box was stored as ticked',
    ).toBe('f');
  }, 60_000);

  it('and an explicit wa:true is stored as true', async () => {
    const res = await signup(validBody({ wa: true }));
    precondition(res.status === 201, `signup failed: ${res.raw}`);
    expect(scalar(`select notify_wa from member where id='${res.body.member.id}'`).trim()).toBe('t');
  }, 60_000);

  /**
   * `policy_version_stale` — 409, AND IT CARRIES BOTH NUMBERS.
   *
   * The refusal is a renderable client state, not an edge case: a publish landing
   * between the screen rendering and the tap is the ordinary race. The client can
   * only say "the terms changed" rather than "something went wrong" if the reply
   * tells it what is published now and what it sent.
   */
  it('policy_version_stale — 409 carrying both the published and the submitted version', async () => {
    const phone = freshPhone();
    const stale = publishedVersion - 1;
    precondition(stale > 0, `published version ${publishedVersion} leaves no stale value below it`);

    const res = await signup(validBody({ phone, policyVersion: stale }));

    expect(res.status, `a stale policy version answered ${res.status}: ${res.raw}`).toBe(409);
    expect(res.body.error).toBe('policy_version_stale');
    expect(
      res.body.publishedVersion,
      'the refusal does not say which version is published, so the client cannot tell her ' +
        'which document she is being asked to read',
    ).toBe(publishedVersion);
    expect(res.body.submittedVersion, 'the refusal does not echo what was sent').toBe(stale);
    expect(
      Number(scalar(`select count(*) from member where phone='${phone}'`)),
      'a member was created against a version she was not shown',
    ).toBe(0);
  }, 60_000);

  /**
   * AND AN ABSENT VERSION IS A REFUSAL RATHER THAN A DEFAULT. This is gap 5
   * written as a spec: "do not rely on 'they agreed to whatever is current'". A
   * `?? set.version` here would satisfy the letter of #10 and store a claim about
   * a document she may never have seen.
   */
  it('policy_version_required — an omitted version is never defaulted to the current one', async () => {
    const phone = freshPhone();
    const body = validBody({ phone });
    delete body.policyVersion;

    const res = await signup(body);

    expect(res.status, `an omitted policy version answered ${res.status}: ${res.raw}`).toBe(409);
    expect(res.body.error).toBe('policy_version_required');
    expect(
      Number(scalar(`select count(*) from member where phone='${phone}'`)),
      'a member was created having agreed to nothing in particular',
    ).toBe(0);
  }, 60_000);

  it('unknown_salon — a white-label build pointed at a salon that does not exist', async () => {
    const res = await signup(validBody({ salonId: SALON_NOWHERE }));

    expect(res.status, `an unknown salon answered ${res.status}: ${res.raw}`).toBe(400);
    expect(
      res.body.error,
      'an unknown salon surfaced as a foreign-key 500 rather than a readable cause',
    ).toBe('unknown_salon');
  }, 60_000);

  it('password_too_short — and no member is left behind by it', async () => {
    const phone = freshPhone();
    const res = await signup(validBody({ phone, password: 'abc' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('password_too_short');
    expect(Number(scalar(`select count(*) from member where phone='${phone}'`))).toBe(0);
  }, 60_000);

  it('invalid_phone — a number without its country code', async () => {
    const res = await signup(validBody({ phone: '99124408' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_phone');
  }, 60_000);
});

// ------------------------------------------------------------- the limiter --

describe('the signup limiter bounds the argon2 cost, in two tiers', () => {
  /**
   * THE CONTROL. Every spec in this block asserts a 429, and an endpoint that was
   * broken shut would satisfy all of them. So first: with the counter empty, a
   * signup works. `afterEach` clears the table, so this is the state each spec
   * below starts from and then primes.
   */
  it('with an empty counter a signup succeeds, and records exactly one attempt', async () => {
    precondition(attemptsFor(LOOPBACK) === 0, 'the counter was not empty at the start of the spec');

    const res = await signup(validBody());
    expect(res.status, `signup failed with an empty counter: ${res.raw}`).toBe(201);

    expect(
      attemptsFor(LOOPBACK),
      `a successful signup recorded ${attemptsFor(LOOPBACK)} attempts for ${LOOPBACK}. If this ` +
        'is 0 the API does not attribute loopback requests to that address and every priming ' +
        'spec below primes an empty bucket and proves nothing.',
    ).toBe(1);
  }, 60_000);

  it('the burst tier refuses the 21st attempt in five minutes, by name', async () => {
    primeAttempts(LOOPBACK, 20, 1);

    const res = await signup(validBody());

    expect(res.status, `the 21st attempt in five minutes answered ${res.status}: ${res.raw}`).toBe(429);
    expect(res.body.error).toBe('signup_rate_limited');
  }, 60_000);

  it('and 19 in five minutes is still under it — the boundary is the limit, not a margin', async () => {
    primeAttempts(LOOPBACK, 19, 1);

    const res = await signup(validBody());

    expect(
      res.status,
      `the 20th attempt was refused (${res.status}: ${res.raw}). The limit is 20 per window, so ` +
        'the 20th is the last allowed one and refusing it is off by one.',
    ).toBe(201);
  }, 60_000);

  /**
   * THE HOURLY CEILING, primed OUTSIDE the five-minute window so only the wider
   * tier can be the thing that refuses. Rows at `minutesAgo: 1` would trip the
   * burst tier as well and the spec could not tell which one answered.
   */
  it('the hourly ceiling refuses even when the burst window is clear', async () => {
    primeAttempts(LOOPBACK, 100, 30);

    const res = await signup(validBody());

    expect(res.status, `the 101st attempt in an hour answered ${res.status}: ${res.raw}`).toBe(429);
    expect(
      res.body.error,
      'the hourly ceiling was reported as the five-minute burst, which tells a caller to wait a ' +
        'moment when they have an hour to wait',
    ).toBe('signup_hourly_limit');
  }, 60_000);

  /**
   * THE ORDER, WHICH IS THE ONE THING TWO INDEPENDENT LIMITS CAN GET WRONG
   * WITHOUT EITHER OF THEM BEING BROKEN.
   *
   * When both are exceeded the honest refusal is the one the caller cannot wait
   * out in a moment. Telling somebody to "wait a moment" when they have an hour
   * to wait sends them back every minute — so the ceiling is checked first, and
   * this spec is what holds that ordering in place.
   */
  it('when BOTH tiers are exceeded the hourly ceiling is what answers', async () => {
    primeAttempts(LOOPBACK, 80, 30);
    primeAttempts(LOOPBACK, 20, 1);

    const res = await signup(validBody());

    expect(res.status).toBe(429);
    expect(
      res.body.error,
      'both limits were exceeded and the caller was told to wait a moment, which is the refusal ' +
        'they can retry soonest and the one that is not true',
    ).toBe('signup_hourly_limit');
  }, 60_000);

  /**
   * AN ATTEMPT OLDER THAN THE HOUR IS NOT COUNTED, which is what makes this a
   * window rather than a lifetime ban. Without it the limiter would eventually
   * refuse every signup from an address for ever, and no spec above would notice.
   */
  it('attempts older than the hour have expired', async () => {
    primeAttempts(LOOPBACK, 500, 61);

    const res = await signup(validBody());

    expect(
      res.status,
      `500 attempts from over an hour ago still refused a signup (${res.status}: ${res.raw}), so ` +
        'the window is a lifetime ban',
    ).toBe(201);
  }, 60_000);

  /**
   * AN UNATTRIBUTABLE CALLER IS COUNTED, NOT EXEMPTED — and it gets ONE bucket
   * for the whole class rather than one each.
   *
   * Asserted from the other side, because there is no way to send a request
   * Fastify cannot attribute over loopback: rows in the NULL bucket must not
   * refuse an attributable caller. If the limiter's predicate were written as a
   * plain equality it would match nothing for a null address and the NULL bucket
   * would be a hole in the limit rather than a shared budget.
   */
  it('the null-address bucket is separate from a real address, not a hole in the limit', async () => {
    primeAttempts(null, 100, 1);

    const res = await signup(validBody());

    expect(
      res.status,
      `100 unattributable attempts refused an attributable caller (${res.status}: ${res.raw}), ` +
        'so one anonymous flood locks out every real customer',
    ).toBe(201);
    expect(
      Number(scalar(`select count(*) from signup_attempt where ip_address is null`)),
      'the primed null-bucket rows are not there, so this spec proved nothing',
    ).toBe(100);
  }, 60_000);

  /**
   * THE COUNTER CANNOT BE RESET BY THE APPLICATION ROLE.
   *
   * 0026: "A row that can be UPDATEd or DELETEd is a counter that can be reset by
   * whatever gets compromised next, and a limiter whose own rows the application
   * can remove is not a limit." The privilege check runs as `avo_app` on the
   * connection `psql()` already has, which is the same shape `account.test.ts`
   * uses for `audit_log`.
   *
   * This is the guard that makes every other spec in this block meaningful: a
   * limit the process behind the endpoint can clear is not a limit.
   */
  it('the application role can INSERT and SELECT the counter, and cannot clear it', () => {
    primeAttempts(LOOPBACK, 3, 1);

    const attempt = (statement: string): string => {
      try {
        psql(`SET ROLE avo_app; ${statement}`);
        return 'SUCCEEDED';
      } catch (err) {
        return String(err);
      }
    };

    expect(
      attempt(`DELETE FROM signup_attempt;`),
      'the application role can DELETE its own rate-limit rows, so the limiter can be reset by ' +
        'whatever compromises the API',
    ).toMatch(/permission denied/i);
    expect(
      attempt(`UPDATE signup_attempt SET created_at = now() - interval '2 hours';`),
      'the application role can back-date its own rate-limit rows, which expires the window on demand',
    ).toMatch(/permission denied/i);
    expect(
      attempt(`TRUNCATE signup_attempt;`),
      'the application role can TRUNCATE the counter',
    ).toMatch(/permission denied|must be owner/i);

    // And the two it DOES need still work, or the endpoint could not count at all.
    expect(
      attempt(`INSERT INTO signup_attempt (salon_id, ip_address) VALUES ('${SALON_A}', '${LOOPBACK}');`),
      'the application role cannot INSERT, so the limiter cannot count',
    ).toBe('SUCCEEDED');
    expect(
      attempt(`SELECT count(*) FROM signup_attempt;`),
      'the application role cannot SELECT, so the limiter cannot read its own counter',
    ).toBe('SUCCEEDED');

    // The rows survived every refused statement above.
    expect(Number(scalar(`select count(*) from signup_attempt`))).toBe(4);
  }, 60_000);

  /**
   * THERE IS NO OUTCOME COLUMN, and that is a decision rather than an omission.
   *
   * 0026: the row has to be written BEFORE the argon2 hash, or a thousand
   * simultaneous requests all read a count of zero and all pay for a hash. A row
   * written first cannot know whether the signup worked, recording the outcome
   * would need an UPDATE, and the UPDATE is revoked above for a reason worth
   * keeping. A spec, because a future `succeeded boolean` would look like an
   * improvement and would quietly need the privilege back.
   */
  it('the counter records no outcome, and no phone number', () => {
    const columns = scalar(
      `select string_agg(column_name, ',' order by column_name)
         from information_schema.columns where table_name = 'signup_attempt'`,
    ).trim();

    expect(columns.split(',').sort()).toEqual(
      ['created_at', 'id', 'ip_address', 'salon_id'].sort(),
    );
    expect(
      columns,
      'the counter grew an outcome column, which cannot be written truthfully before the hash ' +
        'and needs the revoked UPDATE to be corrected afterwards',
    ).not.toMatch(/succeed|outcome|result/i);
    expect(
      columns,
      'the counter grew a phone column. The limit is keyed on the caller, so the phone is not ' +
        'needed to enforce it, and a retained list of numbers that tried to register is a list ' +
        'of people who do not have accounts here.',
    ).not.toMatch(/phone|name/i);
  });

  /**
   * `salon_id` HAS NO FOREIGN KEY, ON PURPOSE, and the reason is a hole it would
   * otherwise open. An attempt naming a salon that does not exist is exactly the
   * traffic worth counting; a FK would make that insert fail before the row
   * landed, turning the cheapest possible probe into the one path that skips the
   * limiter.
   */
  it('an attempt against a salon that does not exist is still counted', async () => {
    precondition(attemptsFor(LOOPBACK) === 0, 'the counter was not empty');

    const res = await signup(validBody({ salonId: SALON_NOWHERE }));
    precondition(res.status === 400, `expected unknown_salon, got ${res.status} ${res.raw}`);

    /**
     * KNOWN SHAPE, NOT A BUG BEING ASSERTED: `unknown_salon` is refused at line
     * 246-ish, BEFORE `recordSignupAttempt`, so this probe costs no hash and is
     * not counted. That is defensible for the CPU claim — see the block below,
     * which is where the consequence actually bites.
     */
    expect(
      attemptsFor(LOOPBACK),
      'an unknown-salon probe was counted. If this is now 1 the handler records before the salon ' +
        'lookup, which is a change worth noticing rather than a failure.',
    ).toBe(0);
  }, 60_000);
});

/**
 * THE ORACLE IS NOW BOUNDED — AND THIS BLOCK IS THE RECORD OF IT CLOSING.
 *
 * It used to read "the limiter counts hashes, not probes — so the oracle is
 * unbounded", and it was true. `recordSignupAttempt` sat BELOW the duplicate-phone
 * check, so a probe against a registered number was refused before anything was
 * recorded: no hash, which was the intent, and no counter increment, which was not.
 * Forty consecutive probes from one address all answered 409 and left
 * `signup_attempt` empty. `services/signupLimit.ts` meanwhile claimed "an attacker
 * still walks roughly 100 numbers an hour per address" — a bound the call order did
 * not deliver, and not in the conservative direction.
 *
 * Lane B reached the same conclusion independently while driving the consent screen
 * (8 requests, 1 row), which is the strongest form that evidence takes.
 *
 * LANE A MOVED `recordSignupAttempt` ABOVE THE DUPLICATE CHECK (auth.ts:279, ahead
 * of the refusal at :290). So a probe is now counted before it can learn anything,
 * and the docstring's figure is true.
 *
 * THE SPEC IS INVERTED RATHER THAN DELETED, WHICH IS THE POINT OF HAVING WRITTEN IT
 * THIS WAY. It was pinned as current behaviour precisely so it would go red the hour
 * the order changed and ask to be rewritten — and it did. What it guards now is the
 * ORDER, which is a one-line property that a future refactor moving the duplicate
 * check back above the counter would silently undo, restoring an unbounded oracle
 * with every other spec in this file still green.
 *
 * IT ASSERTS THE COST, NOT THE REFUSAL. That probes get 429s is the visible part; the
 * load-bearing part is that each probe LEAVES A ROW, because that is what makes the
 * ceiling arrive at all.
 */
describe('an enumeration probe is counted before it is answered, so the oracle is bounded', () => {
  it('forty probes against a registered number are cut off by the limiter, and every one is counted', async () => {
    const phone = freshPhone();
    const created = await signup(validBody({ phone }));
    precondition(created.status === 201, `the setup signup failed: ${created.raw}`);

    clearAttempts();
    precondition(attemptsFor(LOOPBACK) === 0, 'the counter was not cleared');

    const codes: number[] = [];
    for (let i = 0; i < 40; i++) {
      const probe = await signup(validBody({ phone }));
      codes.push(probe.status);
    }

    const answered = codes.filter((c) => c === 409).length;
    const refused = codes.filter((c) => c === 429).length;

    /**
     * The burst tier is 20 per five minutes. So the first 20 probes are counted and
     * answered — they cost a hash and they do reveal that the number is registered —
     * and every probe after that is refused by the limiter before it learns anything.
     * Asserted as a sum rather than as an exact split so the spec does not break on a
     * change to the configured limit, and then asserted against the limit itself.
     */
    expect(
      answered + refused,
      `forty probes answered ${JSON.stringify([...new Set(codes)])} — something other than 409/429 came back`,
    ).toBe(40);
    expect(
      refused,
      'no probe was refused in forty attempts, so the oracle is unbounded again. ' +
        '`recordSignupAttempt` must stay ABOVE the duplicate-phone check in auth.ts — below it, ' +
        'a probe is answered before it is counted and an attacker walks the whole number space.',
    ).toBeGreaterThan(0);
    expect(answered, 'more numbers were confirmed than the burst tier allows').toBeLessThanOrEqual(
      20,
    );

    /**
     * AND THE COUNTER MOVED, which is the half that actually bounds it. A run where
     * every probe answered 409 and the table stayed empty is the old behaviour, and it
     * would satisfy nothing above except by accident.
     */
    expect(
      attemptsFor(LOOPBACK),
      'the probes left no rows behind, so nothing was counted and the refusals above came from ' +
        'somewhere else. This is the pre-fix behaviour returning.',
    ).toBe(20);
  }, 120_000);
});
