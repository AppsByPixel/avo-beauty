/**
 * THE CONSOLE PASSWORD RESET, DRIVEN END TO END — the first redemption any spec in
 * this repository has ever executed, for either surface.
 *
 * Lane A closed a real gap: `POST /v1/platform/admins` creates an invited admin with
 * `password_hash` NULL, because non-negotiable #6 permits a link and nothing else, and
 * `POST /auth/platform/session` refuses a NULL hash. Both halves correct, no door
 * between them — an invited platform admin could not sign in at all. The door is
 * `POST /v1/platform/admins/{id}/password-reset` (issue, `admins`) and
 * `POST /auth/platform/password-reset` (redeem, unauthenticated, because she cannot
 * sign in yet).
 *
 * WHY THIS NEEDS NO TEST HOOK IN `api/`, and why that is the whole point.
 * `DECISIONS.md` § "A reset redemption can be driven end to end with no production test
 * hook" settles it. The raw token is stored only as a sha256, returned by no endpoint,
 * and no sender is wired — so `configuration.test.ts` stopped at the `202` and the
 * redemption half was untested. The pieces to go further were already here:
 *
 *   1. mint a token in the spec — `randomBytes`, so it is not a fixture string
 *   2. sha256 hex it in the spec, with node's own `crypto`
 *   3. `UPDATE ... SET token_hash = ...` on the row the REAL issue endpoint created
 *   4. POST the raw token to the REAL redeem endpoint
 *
 * STEP 3 IS THE DELIVERY STEP AND ONLY THE DELIVERY STEP. It stands in for the
 * WhatsApp message, which is blocked on a client escalation (template approval, sending
 * domain). Everything the endpoint does runs for real: the hash lookup, the
 * `used_at IS NULL` conditional spend, the argon2id write, the session revocation, and
 * every one of the four refusals. Nothing is imported from `api/src` — the sha256 is
 * recomputed here, so a spec that agreed with a broken hash would still disagree with
 * this one.
 *
 * REVIEWED ADVERSARIALLY. Lane A verified its own work; two of its claims are
 * reproduced here independently rather than taken on trust, and both are the
 * "reachable alone" discipline this lane already applies to the order path:
 *
 *   - THE RACE. The `used_at IS NULL` on the UPDATE must be load-bearing rather than
 *     shadowed by the SELECT above it. It is, and the reason is structural: the SELECT
 *     runs OUTSIDE the transaction and unlocked, so both racers pass it. The conditional
 *     UPDATE is the only thing that separates them. The assertion that matters is not
 *     "one was refused" but "the loser's password does not authenticate" — a lost update
 *     here would answer 204 twice and leave whichever hash landed last.
 *   - THE DEACTIVATION GUARD, ALONE. Deactivating spends her outstanding links, AND the
 *     redeem endpoint refuses an inactive admin. Two guards, so the second is isolated
 *     by un-spending the link by hand while the admin stays deactivated.
 */

import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  PLATFORM_OWNER_HANDLE,
  psql,
  scalar,
  signInPlatform,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/**
 * `auth/tokens.ts:hashPasswordResetToken` is `sha256(raw).digest('hex')`. RECOMPUTED
 * here rather than imported: a spec that imported the production hash would agree with
 * it even if it changed to something reversible, and this is the function that decides
 * whether the stored value is a credential or a copy of one.
 */
const sha256Hex = (raw: string): string => createHash('sha256').update(raw).digest('hex');

/** The production format, `auth/tokens.ts:168` — `rst_` + 32 CSPRNG bytes, base64url. */
const mintToken = (): string => `rst_${randomBytes(32).toString('base64url')}`;

const NEW_PASSWORD = 'lane-d-console-pw-1';
const INVITE_HANDLE = 'qa.reset.subject';

let owner = '';
/**
 * READ OUT OF THE INVITE RESPONSE, never re-derived. `platformAdmins.ts` builds it as
 * `PA-` + the handle stripped of punctuation, truncated to 12 and upper-cased, and a
 * spec that recomputed that would be a second copy of a rule with one owner — this one
 * was written by hand first and was wrong by a single character, which is exactly the
 * failure a duplicated derivation produces.
 */
let inviteId = '';

/** The live (unspent) link row for the invited admin, or ''. */
const liveLinkId = (): string =>
  scalar(
    `select id from platform_admin_password_reset
      where platform_admin_id='${inviteId}' and used_at is null
      order by created_at desc limit 1`,
  ).trim();

const linkCount = (): number =>
  Number(
    scalar(
      `select count(*) from platform_admin_password_reset where platform_admin_id='${inviteId}'`,
    ),
  );

const spentCount = (): number =>
  Number(
    scalar(
      `select count(*) from platform_admin_password_reset
        where platform_admin_id='${inviteId}' and used_at is not null`,
    ),
  );

const passwordHashOf = (): string =>
  scalar(`select coalesce(password_hash, '') from platform_admin where id='${inviteId}'`).trim();

/** Issue a link through the REAL endpoint, then deliver it the way a message would. */
async function issueAndDeliver(): Promise<string> {
  const res = await treq<any>('POST', `/v1/platform/admins/${inviteId}/password-reset`, {
    token: owner,
    body: {},
  });
  precondition(res.status === 202, `the issue endpoint answered ${res.status}: ${res.raw}`);

  /**
   * AND IT DOES NOT HAND BACK THE TOKEN. Asserted on every single issue rather than
   * once, because this is the property that makes step 3 below a simulation of a
   * messenger instead of a shortcut around one. A token in this body would sit in the
   * inviter's network log and let her set the admin's password herself.
   */
  expect(
    JSON.stringify(res.body),
    'the 202 carried something token-shaped, so the link came back through the inviter',
  ).not.toMatch(/rst_/);

  const id = liveLinkId();
  precondition(id !== '', 'the issue endpoint created no live link row');

  const token = mintToken();
  psql(`UPDATE platform_admin_password_reset SET token_hash = '${sha256Hex(token)}' WHERE id = '${id}';`);
  return token;
}

const redeem = (token: string, password = NEW_PASSWORD) =>
  treq<any>('POST', '/auth/platform/password-reset', {
    token: null,
    body: { token, password },
  });

const signInWith = (password: string) =>
  treq<any>('POST', '/auth/platform/session', {
    token: null,
    body: { username: INVITE_HANDLE, password },
  });

beforeAll(async () => {
  await startTenancyApi();
  owner = await signInPlatform(PLATFORM_OWNER_HANDLE);

  /**
   * INVITED THROUGH THE REAL ENDPOINT, not inserted. The `password_hash IS NULL` state
   * this whole file turns on is something the invite produces; a hand-written row would
   * be this spec asserting its own SQL.
   */
  /**
   * Cleaned BY HANDLE, because the id is not known until the invite answers. `handle` is
   * globally unique on `platform_admin` — there is one platform, so there is one of her.
   */
  psql(`
    DELETE FROM platform_admin_password_reset
     WHERE platform_admin_id IN (SELECT id FROM platform_admin WHERE handle = '${INVITE_HANDLE}');
  `);
  psql(`DELETE FROM platform_admin WHERE handle = '${INVITE_HANDLE}';`);

  const invited = await treq<any>('POST', '/v1/platform/admins', {
    token: owner,
    body: { name: 'QA Reset Subject', username: INVITE_HANDLE, role: 'analyst' },
  });
  precondition(
    invited.status === 201,
    `the invite answered ${invited.status}: ${invited.raw}`,
  );
  inviteId = String(invited.body?.admin?.id ?? invited.body?.id ?? '');
  precondition(
    inviteId !== '',
    `the invite response carried no admin id: ${invited.raw}`,
  );
  precondition(
    scalar(`select count(*) from platform_admin where id='${inviteId}'`).trim() === '1',
    `${inviteId} came back from the invite but is not in platform_admin`,
  );
}, 120_000);

afterAll(async () => {
  await stopTenancyApi();
});

// ===========================================================================

describe('an invited console admin cannot sign in until she redeems a link', () => {
  it('arrives with no password hash at all — non-negotiable #6', () => {
    expect(
      passwordHashOf(),
      'the invite stored a password hash, so the console set a credential for her',
    ).toBe('');
  });

  it('and is refused at the front door while that is true', async () => {
    const res = await signInWith(NEW_PASSWORD);
    expect(
      res.status,
      `an admin with a NULL hash signed in: ${res.raw}. This is the defect lane A closed.`,
    ).toBe(401);
  }, 60_000);
});

// ===========================================================================

describe('the redemption runs end to end, and the password it sets is real', () => {
  it('issues, delivers, redeems 204, and she signs in with the password she chose', async () => {
    const token = await issueAndDeliver();

    const redeemed = await redeem(token);
    expect(redeemed.status, `the redemption answered ${redeemed.status}: ${redeemed.raw}`).toBe(204);
    expect(redeemed.raw, 'the 204 carried a body, which is a body that can leak a credential').toBe(
      '',
    );

    /**
     * THE DATABASE, not the reply. A 204 from an endpoint that wrote nothing looks
     * identical to a 204 from one that worked.
     */
    expect(passwordHashOf(), 'the redemption set no password hash').not.toBe('');
    expect(
      passwordHashOf(),
      'the password was stored in a form that is not an argon2id hash — non-negotiable #6',
    ).toMatch(/^\$argon2id\$/);
    expect(
      passwordHashOf(),
      'the plaintext password is recoverable from the stored hash',
    ).not.toContain(NEW_PASSWORD);

    // And the credential actually works, which is the only proof the hash is of HER password.
    const signedIn = await signInWith(NEW_PASSWORD);
    expect(
      signedIn.status,
      `she could not sign in with the password she just set: ${signedIn.raw}`,
    ).toBe(200);
    expect(signedIn.body.accessToken, 'the sign-in returned no token').toBeTruthy();

    // The link is spent, and spent exactly once.
    expect(liveLinkId(), 'the redeemed link is still live').toBe('');
  }, 60_000);

  it('and the same link cannot be redeemed twice — sequentially', async () => {
    const token = await issueAndDeliver();

    const first = await redeem(token, 'lane-d-first-pw-1');
    precondition(first.status === 204, `the first redemption failed: ${first.raw}`);

    const second = await redeem(token, 'lane-d-second-pw-2');
    expect(second.status, `the replay answered ${second.status}: ${second.raw}`).toBe(400);
    expect(second.body.error).toBe('invalid_reset_token');

    /** And the second password never took. The refusal is the point, not the status. */
    const withSecond = await signInWith('lane-d-second-pw-2');
    expect(
      withSecond.status,
      'the refused second redemption set the password anyway',
    ).toBe(401);
    const withFirst = await signInWith('lane-d-first-pw-1');
    expect(withFirst.status, `the winner's password stopped working: ${withFirst.raw}`).toBe(200);
  }, 60_000);
});

// ===========================================================================

describe('two simultaneous redemptions of one link: one wins, and only one password lands', () => {
  /**
   * REPRODUCED INDEPENDENTLY, because lane A verified its own race — and then pushed
   * further, because the first version of this spec passed on the first run and a race
   * that passes first time is the weakest evidence in this repository. My own brief
   * records why: with both charge-path guards removed, five simultaneous charges all
   * reported the same `balanceAfterFils` while every sequential spec in that describe
   * still passed, including the one named for the exact property that was broken.
   *
   * THE TRAP HERE, STATED PLAINLY. There are TWO places a second redemption can be
   * refused, and from outside they are byte-identical — same 400, same
   * `invalid_reset_token`, same one-row-spent in SQL:
   *
   *   the SELECT   `if (!reset || reset.usedAt || expired) throw REFUSED()`
   *                — outside the transaction, unlocked
   *   the UPDATE   `.where(and(eq(id), isNull(usedAt)))`, `burned.length === 0`
   *                — the actual serialising guard
   *
   * If the second request happens to arrive after the first has COMMITTED, the SELECT
   * refuses it and the conditional UPDATE is never exercised at all. The test would be
   * green and the guard it claims to cover would be untouched — which is precisely the
   * sequential-specs-pass-while-the-race-is-broken shape. So concurrency is asserted,
   * not assumed.
   *
   * HOW OVERLAP IS PROVED, with no access to `api/`. Each request is timestamped either
   * side. If the LAST request to start did so before the FIRST one finished, then every
   * request was in flight simultaneously. The handler's first database statement is the
   * SELECT and its last is the commit, so simultaneous flight means every SELECT ran
   * before any commit — and therefore every racer read `used_at IS NULL` and the SELECT
   * cannot be what separated them. Only the conditional UPDATE can be.
   *
   * The window is wide enough for this to be reliable rather than lucky: `hashSecret` is
   * argon2id at 19 MiB and runs BETWEEN the SELECT and the transaction, on every racer.
   *
   * FIVE RACERS WITH FIVE DISTINCT PASSWORDS, and the distinctness is what makes it a
   * test. Sharing one password would make a lost update — several redemptions committing,
   * the last hash overwriting the rest — indistinguishable from correct behaviour, since
   * she would sign in either way. Five different passwords mean exactly one may
   * authenticate and four must not.
   */
  const RACERS = 5;

  it('exactly one 204 and four refusals, all in flight at once, and only the winner authenticates', async () => {
    const token = await issueAndDeliver();
    const spentBefore = spentCount();
    const passwords = Array.from({ length: RACERS }, (_, i) => `lane-d-racer-${i}-pw`);

    const timed = await Promise.all(
      passwords.map(async (pw) => {
        const startedAt = Date.now();
        const res = await redeem(token, pw);
        return { pw, res, startedAt, finishedAt: Date.now() };
      }),
    );

    /**
     * THE CONCURRENCY ASSERTION, and it gates the meaning of everything below it. A
     * `precondition` rather than an `expect`: if the requests did not overlap, this case
     * has not measured the guard, and reporting that as a failure of the guard would be
     * the false finding this whole comment exists to avoid.
     */
    const lastStart = Math.max(...timed.map((t) => t.startedAt));
    const firstFinish = Math.min(...timed.map((t) => t.finishedAt));
    precondition(
      lastStart <= firstFinish,
      `the redemptions did not overlap — the last started at ${lastStart} and the first ` +
        `finished at ${firstFinish}. The SELECT could have refused the stragglers, so the ` +
        'conditional UPDATE is unmeasured and this run proves nothing about the race.',
    );

    const winners = timed.filter((t) => t.res.status === 204);
    const losers = timed.filter((t) => t.res.status !== 204);

    expect(
      winners.length,
      `${winners.length} of ${RACERS} simultaneous redemptions answered 204: ` +
        timed.map((t) => `${t.pw}=${t.res.status}`).join(', ') +
        '. More than one is a lost update on a credential.',
    ).toBe(1);

    for (const l of losers) {
      expect(l.res.status, `a loser answered ${l.res.status}: ${l.res.raw}`).toBe(400);
      expect(l.res.body.error).toBe('invalid_reset_token');
    }

    /** Spent ONCE, from SQL. Five spends of one row is the defect stated another way. */
    expect(
      spentCount(),
      'the race spent the link more than once, so more than one transaction committed',
    ).toBe(spentBefore + 1);

    /**
     * AND THE ASSERTION THE WHOLE CASE EXISTS FOR. "Four were refused" is weaker than
     * "the four refused ones changed nothing": every racer computes its argon2id hash
     * BEFORE the transaction, so all five arrive holding a valid hash. A guard that
     * failed to separate them would write four of those over the winner's, answer 204
     * more than once or not, and leave whichever landed last — and the only thing that
     * can tell the difference is which password opens the door.
     */
    const winner = winners[0]!;
    const asWinner = await signInWith(winner.pw);
    expect(asWinner.status, `the winner cannot sign in: ${asWinner.raw}`).toBe(200);

    for (const l of losers) {
      const asLoser = await signInWith(l.pw);
      expect(
        asLoser.status,
        `a LOSER's password (${l.pw}) authenticates. Its redemption answered ` +
          `${l.res.status} and wrote its hash anyway — the refusal is cosmetic and ` +
          '`used_at IS NULL` is not holding.',
      ).toBe(401);
    }
  }, 60_000);

  /**
   * AND AGAIN, TWICE MORE. One race is one sample of a nondeterministic event; this
   * build has three separate records of a single green run being wrong. Repeating on a
   * fresh link each time is the cheapest real evidence available.
   */
  for (const round of [2, 3]) {
    it(`holds on repeat round ${round}`, async () => {
      const token = await issueAndDeliver();
      const passwords = Array.from({ length: RACERS }, (_, i) => `lane-d-r${round}-${i}-pw`);

      const timed = await Promise.all(
        passwords.map(async (pw) => {
          const startedAt = Date.now();
          const res = await redeem(token, pw);
          return { pw, res, startedAt, finishedAt: Date.now() };
        }),
      );

      precondition(
        Math.max(...timed.map((t) => t.startedAt)) <= Math.min(...timed.map((t) => t.finishedAt)),
        'the redemptions did not overlap, so this round measured nothing',
      );

      const winners = timed.filter((t) => t.res.status === 204);
      expect(
        winners.length,
        `round ${round}: ${winners.length} winners — ` +
          timed.map((t) => `${t.res.status}`).join(','),
      ).toBe(1);

      for (const l of timed.filter((t) => t.res.status !== 204)) {
        expect(await signInWith(l.pw).then((r) => r.status), `round ${round}: loser ${l.pw} authenticates`).toBe(401);
      }
      expect(await signInWith(winners[0]!.pw).then((r) => r.status)).toBe(200);
    }, 60_000);
  }
});

// ===========================================================================

describe('deactivation spends her links, and the redeem guard holds on its own', () => {
  /**
   * TWO INDEPENDENT GUARDS, and the second is the one no ordering reaches:
   *
   *   guard 1  DELETE /v1/platform/admins/{id} spends every unspent link in the same
   *            transaction as `active = false`
   *   guard 2  the redeem endpoint refuses when `!admin.active`
   *
   * Guard 1 normally fires first, which makes guard 2 exactly the kind of layer this
   * build keeps finding untested — reachable only when its sibling did not run. So it is
   * isolated the way the brief asks: deactivate (guard 1 fires, link spent), then
   * UN-SPEND the link by hand while she stays deactivated, and redeem. Only guard 2 can
   * refuse that, and if it does not, the response is a password set for a removed admin.
   */
  it('guard 1: the ✕ spends the outstanding link in the same breath', async () => {
    await issueAndDeliver();
    const linkId = liveLinkId();
    precondition(linkId !== '', 'there is no live link to spend');

    psql(`UPDATE platform_admin SET active = true WHERE id = '${inviteId}';`);
    const removed = await treq<any>('DELETE', `/v1/platform/admins/${inviteId}`, {
      token: owner,
    });
    precondition(removed.status === 204 || removed.status === 200, `the ✕ answered ${removed.raw}`);

    expect(
      scalar(`select active from platform_admin where id='${inviteId}'`).trim(),
      'the ✕ did not deactivate her',
    ).toBe('f');
    expect(
      scalar(
        `select coalesce(used_at::text, '') from platform_admin_password_reset where id='${linkId}'`,
      ).trim(),
      'her outstanding reset link survived the ✕, so it can still set a password',
    ).not.toBe('');
  }, 60_000);

  it('guard 2, ALONE: an un-spent link on a deactivated admin is still refused', async () => {
    /**
     * The link is re-issued while she is active, then she is deactivated by SQL rather
     * than by the endpoint — so guard 1 never runs at all and the link stays live. That
     * is the concurrent-deactivation window the handler's comment describes, reproduced
     * without needing to hit it by timing.
     */
    psql(`UPDATE platform_admin SET active = true WHERE id = '${inviteId}';`);
    const token = await issueAndDeliver();
    const linkId = liveLinkId();

    psql(`UPDATE platform_admin SET active = false WHERE id = '${inviteId}';`);
    // Belt and braces: guard 1 is defeated by construction, and asserted to be.
    psql(`UPDATE platform_admin_password_reset SET used_at = NULL WHERE id = '${linkId}';`);

    precondition(
      scalar(`select active from platform_admin where id='${inviteId}'`).trim() === 'f',
      'she is still active, so this measures nothing',
    );
    precondition(
      scalar(
        `select coalesce(used_at::text,'') from platform_admin_password_reset where id='${linkId}'`,
      ).trim() === '',
      'the link is spent, so guard 1 would refuse this and guard 2 stays unmeasured',
    );

    const hashBefore = passwordHashOf();
    const res = await redeem(token, 'lane-d-deactivated-pw-3');

    expect(
      res.status,
      `a live link on a DEACTIVATED admin answered ${res.status}: ${res.raw}. ` +
        'That is a way back into the owner console for somebody deliberately removed.',
    ).toBe(400);
    expect(res.body.error).toBe('invalid_reset_token');
    expect(passwordHashOf(), 'the refused redemption changed her password hash').toBe(hashBefore);

    const signedIn = await signInWith('lane-d-deactivated-pw-3');
    expect(signedIn.status, 'a removed admin signed in with a redeemed link').toBe(401);

    /** The refusal did NOT spend the link — it never reached the transaction. */
    expect(
      scalar(
        `select coalesce(used_at::text,'') from platform_admin_password_reset where id='${linkId}'`,
      ).trim(),
      'the guard-2 refusal spent the link, which the handler cannot do before the tx',
    ).toBe('');
  }, 60_000);
});

// ===========================================================================

describe('the rest of the refusals, each with the link left where it should be', () => {
  beforeAll(() => {
    psql(`UPDATE platform_admin SET active = true WHERE id = '${inviteId}';`);
  });

  it('an unknown token is refused, and is indistinguishable from a spent one', async () => {
    const res = await redeem(mintToken());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_reset_token');
  }, 60_000);

  it('an expired link is refused even though it is unspent', async () => {
    const token = await issueAndDeliver();
    const linkId = liveLinkId();
    /**
     * `expires_at > created_at` is a CHECK, so the row cannot simply be back-dated in
     * one column — both move. This machine runs PKT, two hours ahead of Kuwait, which is
     * why the arithmetic is done by Postgres relative to `now()` rather than in JS.
     */
    psql(`
      UPDATE platform_admin_password_reset
         SET created_at = now() - interval '3 hours', expires_at = now() - interval '2 hours'
       WHERE id = '${linkId}';
    `);

    const res = await redeem(token);
    expect(res.status, `an expired link answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('invalid_reset_token');
    /** Refused BEFORE the transaction, so it is still unspent — the refusal is the clock. */
    expect(
      scalar(
        `select coalesce(used_at::text,'') from platform_admin_password_reset where id='${linkId}'`,
      ).trim(),
    ).toBe('');
  }, 60_000);

  it('a too-short password is refused without spending the link', async () => {
    const token = await issueAndDeliver();
    const linkId = liveLinkId();

    const res = await redeem(token, 'abc');
    expect(res.status, `a 3-character password answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('password_too_short');

    /**
     * AND THE LINK SURVIVES, which matters more than the status: the length check runs
     * before the lookup, so a typo must not burn her one link and leave her unable to
     * sign in with no way to tell that from a link somebody else redeemed.
     */
    expect(
      scalar(
        `select coalesce(used_at::text,'') from platform_admin_password_reset where id='${linkId}'`,
      ).trim(),
      'a rejected password spent the reset link',
    ).toBe('');

    // And it still works afterwards.
    const good = await redeem(token, 'lane-d-after-short-1');
    expect(good.status, `the link did not survive the typo: ${good.raw}`).toBe(204);
  }, 60_000);

  it('issuing a second link spends the first, and the old token stops working', async () => {
    const firstToken = await issueAndDeliver();
    const firstId = liveLinkId();

    const secondToken = await issueAndDeliver();
    const secondId = liveLinkId();

    expect(secondId, 'the second issue reused the first row instead of creating one').not.toBe(
      firstId,
    );
    expect(
      scalar(
        `select coalesce(used_at::text,'') from platform_admin_password_reset where id='${firstId}'`,
      ).trim(),
      'the first link is still live, so two links can set a password at once',
    ).not.toBe('');

    const old = await redeem(firstToken, 'lane-d-superseded-1');
    expect(old.status, `the superseded link answered ${old.status}: ${old.raw}`).toBe(400);
    expect(old.body.error).toBe('invalid_reset_token');

    const fresh = await redeem(secondToken, 'lane-d-current-1');
    expect(fresh.status, `the current link failed: ${fresh.raw}`).toBe(204);
  }, 60_000);
});

// ===========================================================================

describe('and the raw token is nowhere it could be read', () => {
  /**
   * THE QUERY IS `strpos` WITH A LITERAL, NOT `LIKE '%rst_%'`, and the distinction is
   * the reason this describe reads the way it does. `_` is a single-character LIKE
   * wildcard, so `LIKE '%rst_%'` matches the word "fi**rst**" — lane A's first sweep
   * reported 8 audit rows containing `rst_` and all 8 were the word "first". An alarm
   * satisfied by an accident is the same defect as an assertion satisfied by one.
   */
  it('does not appear in any audit row, by exact substring', async () => {
    psql(`UPDATE platform_admin SET active = true WHERE id = '${inviteId}';`);
    const token = await issueAndDeliver();
    const redeemed = await redeem(token, 'lane-d-leak-sweep-1');
    precondition(redeemed.status === 204, `the redemption failed: ${redeemed.raw}`);

    /**
     * The whole token, and then its 24-character body without the `rst_` prefix — a
     * substring is what a truncated log would leave, and the prefix is the only part of
     * the value that is not secret.
     */
    const body = token.slice('rst_'.length);
    for (const needle of [token, body.slice(0, 24)]) {
      const hits = scalar(
        `select count(*) from audit_log
          where strpos(coalesce(detail,''), '${needle}') > 0
             or strpos(coalesce(metadata::text,''), '${needle}') > 0
             or strpos(coalesce(action,''), '${needle}') > 0`,
      ).trim();
      expect(hits, `the raw reset token is readable in audit_log`).toBe('0');
    }

    /** The control on the query: the same sweep MUST find a string that is there. */
    const control = scalar(
      `select count(*) from audit_log where strpos(coalesce(detail,''), '${INVITE_HANDLE}') > 0`,
    ).trim();
    expect(
      Number(control),
      'the leak sweep found no audit row mentioning the admin at all, so it would not ' +
        'have found the token either — the query, not the code, is what passed',
    ).toBeGreaterThan(0);
  }, 60_000);

  it('and only its sha256 is stored, never the value', () => {
    const stored = scalar(
      `select token_hash from platform_admin_password_reset
        where platform_admin_id='${inviteId}' order by created_at desc limit 1`,
    ).trim();

    expect(stored, 'the stored value is not a sha256 hex digest').toMatch(/^[0-9a-f]{64}$/);
    expect(stored, 'the raw token is stored alongside its hash').not.toContain('rst_');
    expect(linkCount(), 'this file created no links, so nothing above ran').toBeGreaterThan(0);
  });
});
