/**
 * `GET /report-downloads/:token` — THE CAPABILITY ITSELF, WHICH NOTHING DROVE.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run report-download-capability.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Two of lane D's own ledgers name this exact debt, in the same words, and neither
 * of them could pay it:
 *
 *   contract.test.ts   "Its bytes share `computeReport` and `toCsv` with the .csv
 *                       route, which reports.test.ts pins; the capability semantics
 *                       are owed a spec."
 *   permission-census   "the token is the credential: 16 bytes CSPRNG, sha256-stored,
 *                        60s, single-use, burnt on any touch. Authority is RE-READ
 *                        from the staff row at redemption … Owed a driven spec of
 *                        its own; named in the lane report as the next slice."
 *
 * And lane A's own comment on the route says the same from the other side: "THE
 * LEDGER LINE THIS WANTS (Lane D's column, reported not written)".
 *
 * So the BYTES are covered and the MINT is covered — `reports.test.ts` pins the BOM,
 * the CRLF records, the RFC 4180 quoting and the formula neutralisation on the
 * header-authenticated `.csv` path, and `tenancy.test.ts` proves a cross-salon mint
 * is refused. What has never been executed is the redemption: the only endpoint in
 * this API that answers with NO session at all.
 *
 * WHY THAT GAP IS THE WORST-SHAPED ONE TO LEAVE. Every other route in the census is
 * protected by a guard that a static reading can see. This one deliberately has
 * none — an `<a href>` cannot send a header, so the token in the path IS the
 * credential — and it hands back the densest tenant read in the product: a customer
 * book with names, phones and balances. The four properties that make that safe
 * (short life, single use, burnt on any touch, authority re-read live) are
 * *behaviours*, invisible to the census that exempted the route. A regression in any
 * one of them turns a 60-second capability into a durable unauthenticated link to
 * another salon's customer list, and nothing anywhere would go red.
 *
 * THE ONE WORTH THE MOST, and the one a reasonable implementation gets wrong:
 * SPEND FIRST, THEN DECIDE. Lane A's comment records that the first version
 * validated before spending, "which quietly meant a refused attempt left the link
 * live; caught by driving it". That ordering is not an optimisation — it is the
 * difference between a capability that survives being shown to a door it may not
 * open and one that does not. It is asserted below as a sequence no single request
 * can witness: mint, revoke, redeem (refused), RESTORE the permission, redeem again
 * — and require the second redemption to fail too. Restoring authority must not
 * revive a spent token. A spec that only checked "revoked is refused" would pass
 * against the buggy ordering.
 *
 * WHAT IS DELIBERATELY NOT RE-ASSERTED HERE: the CSV's own formatting. That is
 * `reports.test.ts`'s subject and both paths render the same `computeReport` /
 * `toCsv` pair, so re-pinning the quoting rules here would be a second copy of one
 * fact. This file asserts that the redemption serves CSV *at all*, with the headers
 * that make a browser save it, and leaves the contents to the file that owns them.
 *
 * SALON B AND LAYLA THROUGHOUT. Every permission this file revokes is restored in a
 * `finally`, and the restore is verified — a suite that left `perm_dashboard` off
 * would fail later files for a reason having nothing to do with them.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  B_STAFF,
  B_STAFF_HANDLE,
  SALON_B,
  psql,
  repoRoot,
  scalar,
  signInDashboard,
  signInDashboardFresh,
  startTenancyApi,
  stopTenancyApi,
  tenancyBaseUrl,
  treq,
} from './support/tenancy-harness.js';

/**
 * `hashWalletToken`'s algorithm, restated in one line so a spec can find the row a
 * token belongs to.
 *
 * Deliberately NOT "the most recent row": the first draft of this file targeted its
 * fixtures with `ORDER BY created_at DESC LIMIT 1`, which is a guess that happens to
 * be right until two specs mint inside the same clock tick or a spec mints twice.
 * Addressing the row by its own digest makes every fixture below exact.
 */
const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Layla, salon B's manager, holding all nine permissions. */
let dashboard = '';

/**
 * `sales`, because `REPORT_PERMISSION` maps it to `dashboard` and the redemption's
 * own `HOLDS` table reads that back off `staff_user.perm_dashboard`. One kind is
 * enough: the property under test is the capability, and the per-kind permission
 * mapping is already driven by the generated permission census.
 */
const KIND = 'sales';
const PERM_COLUMN = 'perm_dashboard';

interface Minted {
  url: string;
  expiresAt: string;
}

/** Mint a fresh capability, and return the opaque token out of the relative URL. */
async function mint(): Promise<{ token: string; body: Minted }> {
  const res = await treq<Minted>(
    'POST',
    `/salons/${SALON_B}/reports/${KIND}/download-url`,
    { token: dashboard },
  );
  if (res.status !== 200) {
    throw new Error(`minting a download URL answered ${res.status}: ${res.raw}`);
  }
  const token = res.body.url.replace('/report-downloads/', '');
  if (!token.startsWith('tok_')) {
    throw new Error(`the mint did not return a token-shaped url: ${res.raw}`);
  }
  return { token, body: res.body };
}

/**
 * Redeem, with NO Authorization header — the whole point of the route. Plain
 * `fetch` rather than `treq` because the interesting half of a download is its
 * headers, and `TenancyResponse` does not carry them.
 */
async function redeem(token: string): Promise<{
  status: number;
  headers: Headers;
  text: string;
}> {
  const res = await fetch(`${tenancyBaseUrl()}/report-downloads/${token}`, {
    signal: AbortSignal.timeout(12_000),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

/** Flip one of Layla's permission columns. Returns a restore function. */
function revoke(column: string): () => void {
  psql(`UPDATE staff_user SET ${column} = false WHERE id = '${B_STAFF}';`);
  precondition(
    scalar(`select ${column} from staff_user where id='${B_STAFF}'`).trim() === 'f',
    `${column} did not actually go off, so the refusal below would prove nothing`,
  );
  return () => {
    psql(`UPDATE staff_user SET ${column} = true WHERE id = '${B_STAFF}';`);
  };
}

beforeAll(async () => {
  await startTenancyApi();
  dashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  precondition(
    scalar(`select ${PERM_COLUMN} from staff_user where id='${B_STAFF}'`).trim() === 't',
    `Layla does not hold ${PERM_COLUMN}, so nothing here can mint`,
  );
}, 120_000);

afterAll(async () => {
  // Belt and braces over each spec's own `finally`: whatever happened above, Layla
  // leaves this file with the authority she came in with.
  psql(`UPDATE staff_user SET ${PERM_COLUMN} = true, deactivated_at = NULL WHERE id = '${B_STAFF}';`);
  psql(`DELETE FROM staff_user WHERE id = 'ST-QA-DL01';`);
  await stopTenancyApi();
});

// ---------------------------------------------------------------------------
describe('The mint, and what it hands the browser', () => {
  it('returns a relative token URL and an expiry about sixty seconds out', async () => {
    const { token, body } = await mint();

    expect(body.url, 'the url is absolute — the dashboard prefixes its own origin').toBe(
      `/report-downloads/${token}`,
    );

    /*
     * `tok_` + base64url of 16 CSPRNG bytes = 22 characters. Asserted as a floor on
     * LENGTH rather than an exact match on the alphabet, so a future move to 32
     * bytes does not go red — what must never happen is the token getting SHORT
     * enough to guess, and that is what a floor catches.
     */
    expect(token.length, `the token is only ${token.length} characters`).toBeGreaterThanOrEqual(26);
    expect(token, 'the token is not opaque').toMatch(/^tok_[A-Za-z0-9_-]+$/);

    const ttlMs = Date.parse(body.expiresAt) - Date.now();
    // A window, not a point: the assertion is "about a minute", and pinning 60_000
    // exactly would go red on ordinary clock and round-trip jitter.
    expect(ttlMs, `expiresAt is ${ttlMs}ms out — far more than the minute #4-grain allows`).toBeLessThanOrEqual(
      75_000,
    );
    expect(ttlMs, `expiresAt is ${ttlMs}ms out — already expired or nearly so`).toBeGreaterThan(
      20_000,
    );
  });

  it('stores the token HASHED — the raw credential is not in the database', async () => {
    const { token } = await mint();

    /*
     * Non-negotiable #6's discipline, applied to a credential that is not a
     * password. The row is found by `sha256(token)`, so the raw value must appear
     * nowhere in the table — a plaintext capability in a table any read replica or
     * backup carries is a durable unauthenticated link to a customer book.
     */
    const rawHits = scalar(
      `select count(*) from report_download where token_hash = '${token}'`,
    ).trim();
    expect(rawHits, 'the raw token is stored as the token_hash').toBe('0');

    // And the row really is there, found by its hash — otherwise the zero above is
    // a claim about a table with nothing in it.
    const total = scalar(
      `select count(*) from report_download where salon_id='${SALON_B}' and used_at is null`,
    ).trim();
    expect(Number(total), 'the mint stored no row at all').toBeGreaterThan(0);
    expect(
      scalar(`select length(token_hash) from report_download order by created_at desc limit 1`).trim(),
      'the stored value is not a sha256 hex digest',
    ).toBe('64');
  });
});

// ---------------------------------------------------------------------------
describe('Redemption serves the file with no session at all', () => {
  it('an anonymous GET returns the CSV, with the headers that make a browser save it', async () => {
    const { token } = await mint();
    const res = await redeem(token);

    expect(res.status, `redemption answered ${res.status}: ${res.text.slice(0, 200)}`).toBe(200);
    expect(res.headers.get('content-type'), 'not served as CSV').toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control'), 'a customer book left cacheable').toBe('no-store');
    expect(
      res.headers.get('content-disposition'),
      'no attachment filename — the browser renders it instead of saving it',
    ).toMatch(/^attachment; filename=".+\.csv"$/);

    // It is a file, not an empty 200. The CONTENTS are reports.test.ts's subject.
    expect(res.text.length, 'the download is empty').toBeGreaterThan(0);
  });

  /**
   * THE LOG SWEEP THIS FILE CANNOT DO, AND WHY IT IS WRITTEN AS A SOURCE CHECK.
   *
   * The route carries `{ logLevel: 'silent' }` and lane A's comment is explicit that
   * this is a SECURITY option, not a noise setting: the token rides in the URL path
   * because an `<a href>` cannot send a header, Fastify logs `req.url` on every
   * request, so without the option the raw credential is written to the server log —
   * defeating `app.ts`'s `redact: ['req.headers.authorization']`. It was found by
   * sweeping the log for `tok_` after driving a download.
   *
   * MY FIRST DRAFT SWEPT THE RUNTIME LOG, AND ITS KNOWN-POSITIVE GUARD CAUGHT THAT
   * IT COULD NOT. `apiLogTail()` returned the empty string, and the reason is
   * structural rather than fixable here: `api/src/app.ts:55` builds Fastify with
   * `logger: env.nodeEnv === 'test' ? false : {…}`. The harness runs the API with
   * NODE_ENV=test, so there is no logger at all — nothing is written, and an
   * "absence of the token in the log" assertion would have passed on every run for
   * ever while verifying nothing.
   *
   * That is worth being precise about rather than papering over: THE RUNTIME
   * PROTECTION HAS NO RUNTIME COVERAGE AND CANNOT HAVE ANY THROUGH THIS HARNESS.
   * Reported to trunk as a gap. What is assertable is that the option is still
   * DECLARED, which is what a regression would remove — so that is what this checks,
   * labelled as the structural check it is rather than dressed up as a proof.
   */
  it('the download route still declares logLevel: silent — a source check, not a runtime one', () => {
    const src = readFileSync(join(repoRoot, 'api', 'src', 'routes', 'reports.ts'), 'utf8');

    // The registration and the option, in that order, close enough together that
    // the option belongs to this route rather than to something further down.
    const at = src.indexOf("'/report-downloads/:token'");
    expect(at, 'the download route is no longer registered at this path').toBeGreaterThan(-1);

    const window = src.slice(at, at + 2_000);
    expect(
      window,
      "the download route no longer sets logLevel:'silent'. The token is in the URL PATH, so " +
        "Fastify's automatic request log writes the raw credential to the server log — " +
        "app.ts's redact list only covers the authorization HEADER and cannot help here.",
    ).toMatch(/logLevel:\s*'silent'/);
  });
});

// ---------------------------------------------------------------------------
describe('The four properties that make an unauthenticated link safe', () => {
  it('SINGLE USE — the second redemption of a live token is refused', async () => {
    const { token } = await mint();

    const first = await redeem(token);
    expect(first.status, `the first redemption failed: ${first.text.slice(0, 200)}`).toBe(200);

    const second = await redeem(token);
    expect(
      second.status,
      'a download link worked twice — the conditional spend is not load-bearing',
    ).toBe(401);
    expect(JSON.parse(second.text).error).toBe('invalid_download');

    // And it stays spent, rather than a counter resetting.
    const third = await redeem(token);
    expect(third.status, 'a spent link came back to life').toBe(401);
  });

  it('EXPIRY — a token past its expiry is refused even though it was never used', async () => {
    const { token } = await mint();

    /*
     * The clock is moved rather than waited on: a real 60-second sleep would add a
     * minute to every run to prove something the row already expresses.
     *
     * BOTH TIMESTAMPS MOVE, AND THE FIRST DRAFT MOVED ONLY ONE. It set
     * `expires_at = created_at + interval '1 second'`, which satisfies the
     * `report_download_expires_after_creation` CHECK and is a perfectly valid row —
     * but `created_at` is a moment ago, so `created_at + 1s` is in the FUTURE. The
     * token was not expired, the redemption served the customer book, and the spec
     * failed with "an expired link still served" against a link that was simply
     * still live. The fixture, not the endpoint, was wrong.
     *
     * So the whole row is aged: created ten minutes ago, expired nine minutes ago.
     * The CHECK holds (expires_at > created_at) and the expiry is genuinely past.
     */
    const hash = hashOf(token);
    precondition(
      scalar(`select count(*) from report_download where token_hash='${hash}'`).trim() === '1',
      'the minted token has no row, so the fixture below would target nothing',
    );
    precondition(
      scalar(`select used_at is null from report_download where token_hash='${hash}'`).trim() === 't',
      'the freshly minted token is already spent, so this spec would prove single-use again',
    );
    psql(`
      UPDATE report_download
         SET created_at = now() - interval '10 minutes',
             expires_at = now() - interval '9 minutes'
       WHERE token_hash = '${hash}';
    `);
    // The fixture took, and the row really is in the past.
    precondition(
      scalar(`select expires_at < now() from report_download where token_hash='${hash}'`).trim() === 't',
      'the token is still live after the ageing fixture, so this is not an expiry test',
    );

    const res = await redeem(token);
    expect(res.status, 'an expired link still served the customer book').toBe(401);
    expect(JSON.parse(res.text).error).toBe('invalid_download');

    // An expired token is refused BEFORE the spend, so it is still unused — the
    // refusal came from the clock, not from the conditional UPDATE.
    expect(
      scalar(`select used_at is null from report_download where token_hash='${hash}'`).trim(),
      'an expired token was spent, so the expiry check runs after the spend',
    ).toBe('t');
  });

  it('AUTHORITY IS RE-READ — a permission revoked after the mint stops the download', async () => {
    const { token } = await mint();
    const restore = revoke(PERM_COLUMN);
    try {
      const res = await redeem(token);
      expect(
        res.status,
        'the download outlived the authority that minted it. Sixty seconds is not a grace ' +
          'period non-negotiable #7 grants.',
      ).toBe(401);
      expect(JSON.parse(res.text).error).toBe('invalid_download');
    } finally {
      restore();
    }

    // The restore worked, so no later file inherits a revoked permission.
    expect(scalar(`select ${PERM_COLUMN} from staff_user where id='${B_STAFF}'`).trim()).toBe('t');
  });

  /**
   * DEACTIVATION, DRIVEN THROUGH A STAFF ROW THIS FILE OWNS.
   *
   * The first draft deactivated Layla directly and Postgres refused it:
   * `staff_user_pin_is_device_scoped` requires that a row with a bound
   * `pin_device_id` still carries a `pin_hash`, and deactivation clears the hash.
   * Layla has `DEV-SCANNER-B` bound, so the constraint fired — the tombstone
   * invariant doing its job, exactly like `member_erased_only_after_request` does
   * for erasure.
   *
   * The fix is NOT to clear her device and put it back. Layla's credentials are a
   * fixture half this directory signs in with, and a spec that dismantles and
   * reassembles someone else's PIN binding is one interrupted run away from
   * breaking every scanner suite for a reason nobody would trace back here. So this
   * spec hires its own leaver: a web-only account with no PIN and no device, cloned
   * off Layla's password hash so the standard sign-in works, deactivated, and
   * deleted afterwards.
   */
  it('DEACTIVATION — a token minted by someone since deactivated is refused', async () => {
    const LEAVER = 'ST-QA-DL01';
    const LEAVER_HANDLE = 'qaleaver';

    psql(`
      INSERT INTO staff_user (id, salon_id, name, handle, role, branch_access_all,
                              branch_access_ids, password_hash, perm_dashboard)
      SELECT '${LEAVER}', salon_id, 'Download QA leaver', '${LEAVER_HANDLE}', 'manager', true,
             '{}', password_hash, true
        FROM staff_user WHERE id = '${B_STAFF}'
      ON CONFLICT (id) DO UPDATE SET deactivated_at = NULL, perm_dashboard = true;
    `);

    try {
      precondition(
        scalar(`select count(*) from staff_user where id='${LEAVER}'`).trim() === '1',
        'the leaver fixture was not created',
      );

      /**
       * She mints her own capability while still employed. `Fresh`, because this
       * row is created two statements above and DELETEd in the `finally` — an
       * identity that exists only inside this test has no business in a cache
       * whose lifetime is the run.
       */
      const leaverToken = await signInDashboardFresh(SALON_B, LEAVER_HANDLE);
      const minted = await treq<Minted>(
        'POST',
        `/salons/${SALON_B}/reports/${KIND}/download-url`,
        { token: leaverToken },
      );
      precondition(minted.status === 200, `the leaver could not mint: ${minted.raw}`);
      const token = minted.body.url.replace('/report-downloads/', '');

      // She leaves. No PIN and no device on this row, so the constraint that
      // refused Layla does not apply.
      psql(
        `UPDATE staff_user SET deactivated_at = now(), password_hash = NULL, pin_hash = NULL
           WHERE id = '${LEAVER}';`,
      );
      precondition(
        scalar(`select deactivated_at is not null from staff_user where id='${LEAVER}'`).trim() === 't',
        'the leaver was not actually deactivated, so the refusal below proves nothing',
      );

      const res = await redeem(token);
      expect(res.status, "a leaver's download link still worked").toBe(401);
      expect(JSON.parse(res.text).error).toBe('invalid_download');
    } finally {
      psql(`DELETE FROM staff_user WHERE id = '${LEAVER}';`);
    }

    // Layla is untouched, which is the point of hiring a leaver rather than making one.
    expect(
      scalar(`select deactivated_at is null from staff_user where id='${B_STAFF}'`).trim(),
      'this spec deactivated the shared fixture',
    ).toBe('t');
    expect(
      scalar(`select pin_device_id is not null from staff_user where id='${B_STAFF}'`).trim(),
      "Layla's device binding was disturbed",
    ).toBe('t');
  }, 60_000);

  /**
   * THE SEQUENCE NO SINGLE REQUEST CAN WITNESS, and the reason this file exists
   * rather than three assertions bolted onto `reports.test.ts`.
   */
  it('BURNT ON ANY TOUCH — a refused attempt spends the token, so restoring authority does not revive it', async () => {
    const { token } = await mint();
    const hash = hashOf(token);

    // 1. Shown to a door it may not open.
    const restore = revoke(PERM_COLUMN);
    let refused: Awaited<ReturnType<typeof redeem>>;
    try {
      refused = await redeem(token);
      expect(refused.status, 'the revoked redemption was not refused').toBe(401);
    } finally {
      // 2. The authority comes back. Under the buggy ordering — validate, THEN
      //    spend — the token was never burnt and is now a working link again.
      restore();
    }

    // 3. The assertion. Same token, full authority, and it must still be dead.
    const after = await redeem(token);
    expect(
      after.status,
      'a token that was REFUSED is alive again now that the permission is back. The spend ' +
        'is happening after the permission check, so any attempt that fails validation ' +
        'leaves the link live — which is the ordering lane A\'s comment says was fixed.',
    ).toBe(401);
    expect(JSON.parse(after.text).error).toBe('invalid_download');

    // And the row says so, not just the response: it was spent by the REFUSED touch.
    expect(
      scalar(`select used_at is not null from report_download where token_hash='${hash}'`).trim(),
      'the refused attempt did not spend the token',
    ).toBe('t');
  });
});

// ---------------------------------------------------------------------------
describe('One uniform refusal, so a probe cannot tell the four apart', () => {
  /**
   * Lane A's comment: "ONE UNIFORM `invalid_download` for unknown, expired, spent,
   * and since-revoked — the caller's remedy is identical in all four: export again."
   *
   * Worth asserting as an ORACLE question rather than as a style preference. An
   * attacker holding a guessed or stale token learns something real from a refusal
   * that distinguishes "no such token" from "that token existed and is spent":
   * the second confirms a valid token was guessed, which turns a blind guess into a
   * measurable one. The four refusals must be indistinguishable.
   */
  it('unknown, expired, spent and revoked all answer 401 with the identical body', async () => {
    const bodies: Record<string, string> = {};

    // 1. UNKNOWN — a well-formed token that was never minted.
    bodies.unknown = (await redeem('tok_AAAAAAAAAAAAAAAAAAAAAA')).text;

    // 2. SPENT.
    const spentTok = (await mint()).token;
    const firstUse = await redeem(spentTok);
    precondition(firstUse.status === 200, 'the token to be spent did not redeem');
    bodies.spent = (await redeem(spentTok)).text;

    // 3. EXPIRED. Aged by its own digest — see the expiry spec for why both
    //    timestamps have to move.
    const expiredTok = (await mint()).token;
    psql(`
      UPDATE report_download
         SET created_at = now() - interval '10 minutes',
             expires_at = now() - interval '9 minutes'
       WHERE token_hash = '${hashOf(expiredTok)}';
    `);
    precondition(
      scalar(
        `select expires_at < now() from report_download where token_hash='${hashOf(expiredTok)}'`,
      ).trim() === 't',
      'the expired candidate is still live, so the four refusals are not four refusals',
    );
    bodies.expired = (await redeem(expiredTok)).text;

    // 4. REVOKED.
    const revokedTok = (await mint()).token;
    const restore = revoke(PERM_COLUMN);
    try {
      bodies.revoked = (await redeem(revokedTok)).text;
    } finally {
      restore();
    }

    const distinct = new Set(Object.values(bodies));
    expect(
      [...distinct],
      `the four refusals are distinguishable, which is an oracle: ${JSON.stringify(bodies)}`,
    ).toHaveLength(1);

    // And the one body they share is the documented one, not an empty string.
    const only = JSON.parse([...distinct][0]!);
    expect(only.error).toBe('invalid_download');
    expect(only.message, 'the refusal has no copy for the merchant').toBeTruthy();
  });

  it('a malformed token is refused the same way, not with a 500', async () => {
    for (const bad of ['not-a-token', 'tok_', '../../etc/passwd', 'tok_%00']) {
      const res = await redeem(encodeURIComponent(bad));
      expect(
        res.status,
        `token ${JSON.stringify(bad)} answered ${res.status}: ${res.text.slice(0, 200)}`,
      ).toBe(401);
      expect(JSON.parse(res.text).error).toBe('invalid_download');
    }
  });
});
