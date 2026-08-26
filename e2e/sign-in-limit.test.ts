/**
 * THE SIGN-IN LIMITER, ASSERTED AGAINST THE THREE ENDPOINTS IT IS SUPPOSED TO BE
 * WIRED INTO.
 *
 * =========================================================================
 * WHY THIS FILE EXISTS, AND IT IS NOT "MORE COVERAGE"
 * =========================================================================
 * `api/src/services/signInLimit.ts` closed the most serious gap in this codebase:
 * `POST /auth/member/session`, `POST /auth/web/session` and
 * `POST /auth/platform/session` verified a password, answered
 * `invalid_credentials`, and recorded NOTHING — no limit, no lockout, no attempt
 * row, and no global limiter behind them.
 *
 * It shipped with a measurement attached, and the measurement is the reason this
 * file is here. With the limiter exempted under `AVO_TEST_PRINCIPALS`, trunk
 * deleted the `chargeSignInBudget` call out of the member handler and ran the
 * default gate:
 *
 *     pnpm check   235 green, unchanged
 *
 * The limiter was disconnected from the customer wallet's front door and every
 * check in the repository still passed. Only `signInLimit.int.test.ts` caught it —
 * 8 specs red — and that suite needs `AVO_INT_DATABASE_URL` and is not in
 * `pnpm check`. So "the check is green" and "the limiter is wired to the three
 * endpoints" were two different claims, and nothing in the gate connected them.
 *
 * `signInLimit.test.ts` does not close that, and it is worth saying why rather than
 * assuming it: it is a unit suite over the key derivation, the tier order and the
 * check-then-record pairing. Every one of those can be perfect while the handler
 * never calls any of it. THE CALL IS THE THING THAT WAS MISSING, and a call can
 * only be proved from outside.
 *
 * =========================================================================
 * WHAT IT ASSERTS, AND WHY EACH ONE IS SEPARATE
 * =========================================================================
 * THE WIRING, ONCE PER SURFACE. Three endpoints, three independent call sites,
 * three separate specs. A single spec over the member door would have gone green
 * with `web` and `platform` unlimited — which is two thirds of the original defect
 * still shipping, including the owner console, which is the most valuable
 * credential on the platform.
 *
 * THE ORDER: THE CHARGE IS BEFORE THE VERIFY. A spent bucket refuses the CORRECT
 * password. If the charge sat below the credential check, a successful sign-in
 * would cost nothing and an attacker's last guess would always be free.
 *
 * THE BUCKET IS PER IDENTITY, NOT GLOBAL. Spending one identity's budget must not
 * refuse anybody else. A limiter that had accidentally been keyed on something
 * shared — a constant, `req.ip` behind an untrusted proxy — would pass every spec
 * above and lock the whole platform out on the first busy afternoon.
 *
 * AND IT IS NOT AN ORACLE. This is the property `signInLimit.ts`'s header is built
 * around: a bucket spent by a number nobody has registered and a bucket spent by a
 * real customer must be THE SAME CODE PATH. Asserted as byte equality of the two
 * responses, because "both are 429" is the weaker claim — a body or a header that
 * differed would still be an enumeration oracle, and a louder one than the timing
 * channel `burnVerifyTime` exists to remove.
 *
 * =========================================================================
 * IDENTITIES NOTHING ELSE IN THIS SUITE TOUCHES
 * =========================================================================
 * Every identity below is either invented or seeded by this file alone, and that
 * is a hard requirement rather than tidiness. Spending eleven attempts on a shared
 * fixture — `layla`, the platform owner, salon B's member — would leave the next
 * file's `beforeAll` unable to sign in, which is exactly the failure this lane
 * just finished removing from the other direction. The phone numbers, usernames
 * and handles here appear in no seed and in no other spec.
 *
 * THE UNREGISTERED ONES ARE NOT A SHORTCUT. Because the bucket is derived from what
 * the request CLAIMS, before any table is read, an identity that does not exist is
 * limited exactly as one that does — so most of this file needs no fixture at all,
 * and the fact that it does not is itself the no-oracle property being exercised.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  A_STAFF_FULL,
  BOOT_JWT_SECRET,
  SALON_B,
  STAFF_PASSWORD,
  psql,
  scalar,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/**
 * `signInLimit.ts`: 10 per 15 minutes, 20 per hour, per claimed identity, the
 * ceiling checked first.
 *
 * PINNED AS LITERALS RATHER THAN IMPORTED, and this is the one place in this file
 * where that choice needs defending. Importing `SIGN_IN_MAX_PER_WINDOW` from
 * `api/src` would make every spec below agree with the constant whatever it became
 * — including 10_000, which is the shape of the change somebody makes to get a red
 * suite green. `signInLimit.ts § THRESHOLDS` says these numbers are an engineering
 * default that should become a DECISIONS.md entry, so they WILL move; when they do,
 * this file is supposed to fail and be updated deliberately.
 */
const BURST_MAX = 10;

/**
 * `sign_in_rate_limited` is the burst tier (10 per 15 minutes) and
 * `sign_in_hourly_limit` is the ceiling (20 per hour, reported FIRST when both are
 * spent). Every spec here spends exactly one burst window, so the burst code is the
 * one that should arrive; a `sign_in_hourly_limit` in any of these would mean this
 * file had already spent twice its budget somewhere above.
 */
const BURST_ERROR = 'sign_in_rate_limited';

const WRONG_PASSWORD = 'lane-d-definitely-not-the-password';

/**
 * A member this file seeds and nothing else reads, so its budget is spendable.
 *
 * The password hash is COPIED from salon A's `ST-001`, which is the trick
 * `tenancy-harness.ts` uses for salon B and for the QA member, and for its reason:
 * hashing argon2id here would mean importing lane A's password module into a
 * package that does not depend on it, and a copied hash cannot drift from the seed.
 */
const LIMITED_MEMBER = 'QA-SIL-0001';
const LIMITED_MEMBER_PHONE = '+96596881001';

/**
 * Invented, in a salon that exists. Registered to nobody, in any seed.
 *
 * THE `+96596…` BLOCK IS DELIBERATELY NOT `+96599…`. Every seeded number in this
 * suite is `+96599…` — `A_MEMBER_PHONE` is `+96599124408`, `B_MEMBER_PHONE` is
 * `+96599555001`, `QA_MEMBER_PHONE` is `+96599777001` — and this file SPENDS the
 * budget of every number it names. A digit's typo inside the same block would leave
 * a real fixture unable to sign in for fifteen minutes, in whichever file ran next,
 * reported as that file's `beforeAll` failing. A different prefix makes the typo
 * visible instead of expensive.
 */
const GHOST_PHONE = '+96596881002';
const GHOST_USERNAME = 'qa.sil.nobody';
const GHOST_HANDLE = 'qa.sil.no.such.admin';
/** A second invented number, to prove the bucket is not shared. */
const BYSTANDER_PHONE = '+96596881003';
/**
 * ONE STRING USED AS BOTH A PHONE AND A USERNAME, in the SAME salon.
 *
 * PHONE-SHAPED SO IT IS LEGAL ON BOTH DOORS, and that is the whole design of the
 * surface-isolation spec below. `requireString(body.phone, 'phone', 20)` imposes no
 * format, and the dashboard's `username` is a free string, so this value reaches
 * `chargeSignInBudget` unchanged on either endpoint. Holding the salon and the
 * identifier equal leaves the SURFACE as the only difference between the two
 * buckets, which is the only way to assert that the surface is in the key at all.
 */
const SHARED_IDENTIFIER = '+96596881004';

// ---------------------------------------------------------------- the buckets --

/**
 * `sign_in_attempt.identity_key`, RECOMPUTED here.
 *
 * `signInLimit.ts § THE BUCKET`: HMAC-SHA256 keyed with the deployment's
 * `JWT_SECRET`, over a domain-separated, versioned label. Recomputed rather than
 * imported for `console-reset.test.ts`'s reason about the reset token's sha256 — a
 * spec that imported the production derivation would still agree with it if it
 * changed to something reversible, and the whole point of this column is that it
 * is a key and not the phone number.
 *
 * WHAT THAT BUYS: the row counts below are for ONE bucket rather than for the
 * table, so they stay exact whatever else in the suite has signed in.
 */
function bucketOf(surface: string, salonId: string | null, identifier: string): string {
  return createHmac('sha256', BOOT_JWT_SECRET)
    .update(`avo.sign-in-limit.v1|${surface}|${salonId ?? ''}|${identifier}`)
    .digest('hex');
}

const attemptsIn = (bucket: string): number =>
  Number(scalar(`select count(*) from sign_in_attempt where identity_key='${bucket}'`).trim());

/**
 * AND THE COLUMN REALLY IS A KEY, asserted before anything counts rows through it.
 *
 * If `identity_key` held the phone number — or an unkeyed digest of it, which is a
 * laptop-minute from the same thing for an eight-digit Kuwaiti mobile — then every
 * count below would still be correct and this table would be a list of the people
 * who tried to sign in, retained indefinitely. Migration 0026 refused exactly that
 * for `signup_attempt`.
 */
function assertBucketIsAKey(bucket: string, identifier: string): void {
  expect(bucket, 'the bucket is not a sha256-shaped hex digest').toMatch(/^[0-9a-f]{64}$/);
  expect(bucket, 'the identity is recoverable from its own bucket name').not.toContain(
    identifier.replace('+', ''),
  );
}

// ------------------------------------------------------------------- the doors --

interface Attempt {
  status: number;
  error: string | undefined;
  raw: string;
}

async function memberSignIn(phone: string, password = WRONG_PASSWORD): Promise<Attempt> {
  const res = await treq<{ error?: string }>('POST', '/auth/member/session', {
    token: null,
    body: { salonId: SALON_B, phone, password },
  });
  return { status: res.status, error: res.body?.error, raw: res.raw };
}

async function webSignIn(username: string, password = WRONG_PASSWORD): Promise<Attempt> {
  const res = await treq<{ error?: string }>('POST', '/auth/web/session', {
    token: null,
    body: { salonId: SALON_B, username, password },
  });
  return { status: res.status, error: res.body?.error, raw: res.raw };
}

async function platformSignIn(handle: string, password = WRONG_PASSWORD): Promise<Attempt> {
  const res = await treq<{ error?: string }>('POST', '/auth/platform/session', {
    token: null,
    body: { username: handle, password },
  });
  return { status: res.status, error: res.body?.error, raw: res.raw };
}

/**
 * Spend a whole burst window, SEQUENTIALLY and asserting each one on the way.
 *
 * NOT `Promise.all`, deliberately. `recordSignInAttempt` writes before the verify
 * precisely so that a burst of simultaneous requests cannot all read a count of
 * zero, but a concurrent spender here would make the attempt at which the refusal
 * arrives nondeterministic — and this file's subject is the boundary, not the
 * concurrency. `console-reset.test.ts` covers a race where a race is the claim.
 *
 * EVERY ONE OF THE FIRST TEN IS ASSERTED to be a credential refusal rather than a
 * rate-limit refusal. Without that, a limiter that refused from the FIRST attempt
 * would satisfy "the eleventh is 429" and would also mean nobody can ever sign in.
 */
async function spendBurst(door: (id: string) => Promise<Attempt>, identity: string): Promise<void> {
  for (let i = 1; i <= BURST_MAX; i++) {
    const res = await door(identity);
    expect(
      res.status,
      `attempt ${i} of ${BURST_MAX} answered ${res.status} (${res.error}): ${res.raw}. ` +
        'The budget was refusing before it was spent, so the boundary below means nothing.',
    ).toBe(401);
    expect(res.error, `attempt ${i} carried ${res.error}`).toBe('invalid_credentials');
  }
}

beforeAll(async () => {
  await startTenancyApi();

  psql(`
INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                    balance_fils, visits, tier, stamps, policy_version)
SELECT '${LIMITED_MEMBER}', '${SALON_B}', 'QA Sign-In Limit', '${LIMITED_MEMBER_PHONE}',
       'qa.sil@example.test', true, s.password_hash, 0, 0, 'bronze', NULL, 3
FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
`);

  /**
   * THE FIXTURE IS ASSERTED BEFORE IT IS USED. If the hash copy silently failed,
   * `the correct password is refused too` would pass for the wrong reason — she
   * would be refused because her credential never worked.
   */
  const canSignIn = await memberSignIn(LIMITED_MEMBER_PHONE, STAFF_PASSWORD);
  expect(
    canSignIn.status,
    `the seeded member cannot sign in at all (${canSignIn.raw}), so nothing below is ` +
      'measuring a limiter. The hash copy from ST-001 did not take.',
  ).toBe(200);

  /**
   * AND HER BUCKET IS PUT BACK TO EMPTY, because the check above just spent one of
   * her ten — `signInLimit.ts § COUNTED BEFORE THE VERIFY` means a SUCCESSFUL
   * sign-in costs budget too, so `spendBurst` would hit the refusal on its tenth
   * attempt rather than its eleventh and every boundary in this file would be off
   * by one.
   *
   * DELETED BY BUCKET, NOT `DELETE FROM sign_in_attempt`. That is not fastidiousness
   * — a table-wide delete here would refill every OTHER identity's budget as a side
   * effect, and this file has no control over whether it runs before or after the
   * fifteen files that share one salon manager's handle. It would therefore hide
   * exactly the over-budget failure the session cache in `tenancy-harness.ts` was
   * built to fix, and the suite would go green whether that cache worked or not.
   * Emptying only the bucket this file spent leaves every other file's budget
   * exactly as it found it.
   */
  psql(
    `DELETE FROM sign_in_attempt WHERE identity_key = '${bucketOf('member', SALON_B, LIMITED_MEMBER_PHONE)}';`,
  );
  expect(
    attemptsIn(bucketOf('member', SALON_B, LIMITED_MEMBER_PHONE)),
    'the fixture sign-in is still in her bucket, so every boundary below is off by one',
  ).toBe(0);
}, 180_000);

afterAll(async () => {
  psql(`DELETE FROM member WHERE id = '${LIMITED_MEMBER}';`);
  await stopTenancyApi();
});

// ===========================================================================

describe('the limiter is wired into all three password endpoints, called directly', () => {
  /**
   * ONE SPEC PER DOOR. `chargeSignInBudget` is called three times in
   * `routes/auth.ts` — once per handler — and three call sites are three things
   * that can be missing. Deleting any one of them turns exactly one of these red,
   * which is the property that makes this file worth its runtime.
   */

  it('POST /auth/member/session — the eleventh attempt on one number is refused', async () => {
    await spendBurst(memberSignIn, GHOST_PHONE);

    const over = await memberSignIn(GHOST_PHONE);
    expect(
      over.status,
      `the customer wallet's front door answered ${over.status} to attempt ` +
        `${BURST_MAX + 1} against one number: ${over.raw}. ` +
        'The limiter is not wired into the member handler — this is the unbounded ' +
        'password-guessing endpoint signInLimit.ts was written to close.',
    ).toBe(429);
    expect(over.error).toBe(BURST_ERROR);
  }, 120_000);

  it('POST /auth/web/session — the same, for the merchant dashboard', async () => {
    await spendBurst(webSignIn, GHOST_USERNAME);

    const over = await webSignIn(GHOST_USERNAME);
    expect(
      over.status,
      `the dashboard's front door answered ${over.status}: ${over.raw}. The limiter is ` +
        'not wired into the web handler.',
    ).toBe(429);
    expect(over.error).toBe(BURST_ERROR);
  }, 120_000);

  it('POST /auth/platform/session — and for the owner console, the most valuable of the three', async () => {
    await spendBurst(platformSignIn, GHOST_HANDLE);

    const over = await platformSignIn(GHOST_HANDLE);
    expect(
      over.status,
      `the owner console's front door answered ${over.status}: ${over.raw}. The limiter is ` +
        'not wired into the platform handler — the credential that reaches every salon ' +
        'on the platform is the one still guessable without bound.',
    ).toBe(429);
    expect(over.error).toBe(BURST_ERROR);
  }, 120_000);
});

// ===========================================================================

describe('the refusal is charged before the credential is read', () => {
  /**
   * THE ORDER IS THE CLAIM HERE, and it is not the same claim as "the limiter
   * exists". `signInLimit.ts § WHERE THE CHECK SITS` puts the charge above the
   * account lookup and above any hashing, and gets three properties from that: a
   * throttled caller reads no table, pays for no argon2, and therefore learns
   * nothing about which numbers are registered.
   *
   * Only the first of those is observable from out here, and it is the one that
   * matters: if the charge sat BELOW the verify, a caller's successful attempt would
   * cost nothing, and an attacker's final correct guess would always be free no
   * matter how many wrong ones came before it.
   */
  it('a spent bucket refuses the CORRECT password — so a success costs budget too', async () => {
    // She really can sign in; asserted in beforeAll, and again here after the spend.
    await spendBurst(memberSignIn, LIMITED_MEMBER_PHONE);

    const withTheRightPassword = await memberSignIn(LIMITED_MEMBER_PHONE, STAFF_PASSWORD);
    expect(
      withTheRightPassword.status,
      `a member with a SPENT bucket signed in anyway (${withTheRightPassword.raw}). The ` +
        'charge is below the credential check, so every attacker gets one free guess per ' +
        'window and a correct password is never rationed.',
    ).toBe(429);
    expect(withTheRightPassword.error).toBe(BURST_ERROR);
  }, 120_000);
});

// ===========================================================================

describe('the bucket is the claimed identity, and nothing wider', () => {
  /**
   * WHY THIS IS NOT PARANOIA. `signupLimit.ts` keys on `req.ip`, so an
   * address-keyed tier is the house pattern and would have looked right here.
   * `signInLimit.ts § KEYING` refuses it, because `app.ts` sets
   * `trustProxy: env.trustProxy` and that is OFF until `TRUST_PROXY` names the real
   * proxy — behind a load balancer every caller on the platform would share ONE
   * bucket, and eleven guesses would sign every customer out at once.
   *
   * Every request in this file arrives from the same address, so if the key were
   * the address rather than the identity, the spec below is the one that notices.
   */
  it('a bystander on the same connection still signs in after another number is spent', async () => {
    // GHOST_PHONE's bucket was spent in the first describe and has not had 15 minutes.
    const stillSpent = await memberSignIn(GHOST_PHONE);
    expect(
      stillSpent.status,
      'the spent bucket refilled inside the window, so the check below proves nothing',
    ).toBe(429);

    const bystander = await memberSignIn(BYSTANDER_PHONE);
    expect(
      bystander.status,
      `an untouched number was refused with ${bystander.status}: ${bystander.raw}. The ` +
        'bucket is keyed on something shared — an address, or a constant — rather than on ' +
        'the claimed identity, which is a platform-wide lockout waiting for one attacker.',
    ).toBe(401);
    expect(bystander.error).toBe('invalid_credentials');
  }, 120_000);

  it('and the surface is part of the key — a spent wallet bucket is not a spent dashboard bucket', async () => {
    /**
     * SALON AND IDENTIFIER HELD EQUAL, so the surface is the only variable.
     *
     * `signInIdentityKey` puts the surface into the HMAC label —
     * `avo.sign-in-limit.v1|{surface}|{salon}|{identifier}` — and if it did not,
     * a customer spending her wallet's budget would refuse a manager whose handle
     * happened to match her number, in her own salon.
     *
     * Comparing the WALLET against the CONSOLE would not have tested this: the
     * console has no salon, so those two keys differ in the salon field whether the
     * surface is in the label or not, and the spec would pass on the wrong reason.
     */
    await spendBurst(memberSignIn, SHARED_IDENTIFIER);

    const overOnWallet = await memberSignIn(SHARED_IDENTIFIER);
    expect(overOnWallet.status, 'the wallet bucket did not spend').toBe(429);

    const onDashboard = await webSignIn(SHARED_IDENTIFIER);
    expect(
      onDashboard.status,
      `the same identifier in the same salon answered ${onDashboard.status} on the ` +
        `dashboard door: ${onDashboard.raw}. The surface is not in the key, so the two ` +
        'doors share one bucket per (salon, identifier) pair.',
    ).toBe(401);
    expect(onDashboard.error).toBe('invalid_credentials');
  }, 120_000);
});

// ===========================================================================

describe('the counter counts, and a refused request does not extend the window', () => {
  /**
   * THE PAIRING, FROM OUTSIDE. `chargeSignInBudget` checks and THEN records, and
   * `signInLimit.ts` is explicit about what the reverse order would cost: "an
   * attacker hammering in a loop pushes the window forward with every request and
   * the customer never gets back in at all". That is not a cosmetic difference — it
   * turns a rolling window into an indefinite lockout that any stranger can hold
   * open, on the surface where the victim has no manager to call.
   *
   * It is visible as a row count. The bucket must hold exactly the budget after the
   * budget is spent, and the REFUSED attempts on top of it must add nothing.
   */
  it('a spent bucket holds exactly the budget, and the refusals above it wrote no rows', async () => {
    const bucket = bucketOf('member', SALON_B, GHOST_PHONE);
    assertBucketIsAKey(bucket, GHOST_PHONE);

    /**
     * GHOST_PHONE was spent (10 counted) in the first describe and refused several
     * times since, by the specs between. That accumulated state is exactly what this
     * assertion wants — a bucket that has been hammered well past its budget — which
     * is why it reads the existing one rather than seeding a clean bucket of its own.
     */
    expect(
      attemptsIn(bucket),
      `the bucket holds ${attemptsIn(bucket)} rows. More than ${BURST_MAX} means a ` +
        'REFUSED attempt was recorded, so the record runs before the check and every ' +
        'request an attacker sends pushes the window forward — the customer never gets ' +
        'back in. Fewer means the counter is not counting what the limiter reads.',
    ).toBe(BURST_MAX);

    // One more refusal, and the count must not move.
    const refused = await memberSignIn(GHOST_PHONE);
    expect(refused.status).toBe(429);
    expect(
      attemptsIn(bucket),
      'a 429 was written to the counter, so a caller who is already over budget can ' +
        'hold their own window open for ever',
    ).toBe(BURST_MAX);
  }, 120_000);

  it('and the row records the surface and the salon, but never the phone number', async () => {
    const bucket = bucketOf('member', SALON_B, GHOST_PHONE);

    expect(
      scalar(`select distinct surface from sign_in_attempt where identity_key='${bucket}'`).trim(),
    ).toBe('member');
    expect(
      scalar(`select distinct salon_id from sign_in_attempt where identity_key='${bucket}'`).trim(),
    ).toBe(SALON_B);

    /**
     * AND THE NUMBER IS NOWHERE IN THE TABLE, swept across every column rather than
     * asserted about `identity_key` alone — the leak this is guarding against would
     * most likely arrive as a well-meaning extra column, not as a changed one.
     * `console-reset.test.ts`'s sweep, with its control: the query is first pointed
     * at a value that IS present, so an absence cannot pass vacuously.
     */
    const bare = GHOST_PHONE.replace('+', '');
    for (const needle of [GHOST_PHONE, bare]) {
      expect(
        scalar(
          `select count(*) from sign_in_attempt
            where strpos(identity_key, '${needle}') > 0
               or strpos(coalesce(salon_id,''), '${needle}') > 0
               or strpos(surface, '${needle}') > 0`,
        ).trim(),
        `the phone number is readable from sign_in_attempt as "${needle}" — this table ` +
          'is a list of identities somebody TRIED, which includes people who hold no ' +
          'account here (migration 0026)',
      ).toBe('0');
    }

    const control = scalar(
      `select count(*) from sign_in_attempt where strpos(identity_key, '${bucket}') > 0`,
    ).trim();
    expect(
      Number(control),
      'the sweep cannot find the bucket it just counted, so it would not have found a ' +
        'phone number either — the query passed, not the schema',
    ).toBeGreaterThan(0);
  }, 60_000);
});

// ===========================================================================

describe('and a spent bucket is not an enumeration oracle', () => {
  /**
   * THE PROPERTY `signInLimit.ts` IS BUILT AROUND, and the one an "obvious" lockout
   * would have destroyed. `routes/auth.ts`'s header: "Every failure path answers
   * with the same body and burns the same argon2 time, whether the account exists
   * or not. 'Wrong password' and 'no such phone number' being distinguishable turns
   * a login form into a customer-list oracle."
   *
   * A limiter that counted against the ACCOUNT ROW hands that straight back and
   * louder — `429 locked` for numbers that are registered, `401` for numbers that
   * are not, one request per number, no statistics required. The limiter therefore
   * keys on what the request claims and never learns whether the account exists.
   *
   * BYTE EQUALITY, NOT "BOTH 429". Two 429s whose bodies differed by a field, a
   * message or a retry hint would still be an oracle. The comparison is on the raw
   * response, which is the only form in which "indistinguishable" is a testable
   * word.
   */
  it('a real customer and a number nobody has registered are refused identically', async () => {
    // LIMITED_MEMBER_PHONE is a real, signed-in-able member, spent above.
    // GHOST_PHONE is registered to nobody, spent above.
    const real = await memberSignIn(LIMITED_MEMBER_PHONE);
    const invented = await memberSignIn(GHOST_PHONE);

    expect(real.status, `the real member answered ${real.status}: ${real.raw}`).toBe(429);
    expect(invented.status, `the invented number answered ${invented.status}`).toBe(429);

    expect(
      invented.raw,
      'a spent bucket for a REGISTERED number answers differently from a spent bucket ' +
        'for one nobody has. That is an enumeration oracle with a bigger signal than the ' +
        'timing channel burnVerifyTime exists to remove: one request per number, and a ' +
        'definitive answer.',
    ).toBe(real.raw);
  }, 120_000);

  it('and the refusal names the act rather than the credential', async () => {
    /**
     * `sign_in_rate_limited` is deliberately NOT folded into `invalid_credentials`.
     * `signInLimit.ts § the refusal codes` has the reason and it is a product one:
     * telling a customer who mistyped twice that her password is wrong when it is
     * not sends her to a reset flow she does not need. It is not a leak, because it
     * says the CALLER has been asking too often and says nothing about whether the
     * identity exists — which is the previous spec, in the other direction.
     */
    const over = await memberSignIn(GHOST_PHONE);
    expect(over.error).toBe(BURST_ERROR);
    expect(over.error).not.toBe('invalid_credentials');

    /** And it never echoes the password back, on any path. Non-negotiable #6. */
    expect(over.raw, 'the rate-limit refusal echoed the password back').not.toContain(
      WRONG_PASSWORD,
    );
  }, 60_000);

  it('the window is rolling and nothing was latched onto her account', async () => {
    /**
     * THE SECOND TRAP, ASSERTED AS AN ABSENCE. `staff_user.pin_locked_until` is a
     * latch and is right where it is — a manager is standing in the salon. Nobody is
     * standing next to Dana's phone, so a latch on a customer wallet would let anyone
     * who knows her number bar her from her own money for the cost of ten wrong
     * guesses.
     *
     * So `signInLimit.ts` writes NOTHING to `member`, `staff_user` or
     * `platform_admin`. This is the spec that would fail the day somebody "improves"
     * the limiter by adding a `locked_until` column to `member` — which is the
     * obvious next change, and the one that must not happen without a decision.
     */
    const columns = scalar(
      `select count(*) from information_schema.columns
        where table_name = 'member'
          and (column_name like '%lock%' or column_name like '%locked%')`,
    ).trim();
    expect(
      columns,
      'a lock column has appeared on `member`. A latch on a customer wallet is a ' +
        'denial-of-service any stranger can hold, with no manager to unlock it — ' +
        'signInLimit.ts § THE SECOND TRAP refused it deliberately, so this is a ' +
        'decision and not a refactor.',
    ).toBe('0');

    /** And her row is untouched by eleven failed attempts. */
    expect(
      scalar(
        `select count(*) from member where id='${LIMITED_MEMBER}' and password_hash is not null`,
      ).trim(),
      'the spend altered her credential',
    ).toBe('1');
  }, 60_000);
});
