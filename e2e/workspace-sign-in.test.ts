/**
 * ONE WALLET APP, AND THE ACCOUNT DECIDES THE WORKSPACE — `POST /auth/member/session`
 * and `POST /auth/member/password-reset/request` with NO `salonId`. Lane A's `16414a3`.
 *
 * HOW TO RUN
 *
 *   cd e2e && AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run workspace-sign-in.test.ts
 *
 * WHAT IS UNDER TEST (routes/auth.ts § SIGN-IN WITHOUT A SALON)
 * ------------------------------------------------------------
 *   no wallet opens          401 invalid_credentials, byte-identical to an unknown phone
 *   exactly one opens        that wallet's session; `member.salonId` names the workspace
 *   two or more open         409 choose_workspace, `workspaces` at the TOP level, listing
 *                            ONLY the salons where the password verified; no session
 *   the re-post with salonId an ordinary salon-scoped sign-in
 *   salonId present          the installed builds' path, unchanged
 *   reset without a salon    one link per live wallet, the same 202, no salon named
 *
 * Lane A's `memberWorkspaceSignIn.int.test.ts` proves these through `app.inject` inside
 * the API's own process. This file asks them of the SERVED API over HTTP, with the
 * seed's own two workspaces (Dana at Amara, Maha at Forest) as the single-wallet
 * cases, and reads every claim about what was written back from Postgres.
 *
 * THE CREDENTIALS ARE THE SEED'S, printed by every `db:seed`: `dana-dev-password` and
 * `maha-dev-password` (`api/src/db/seed.ts` MEMBER_PASSWORD, FOREST_MEMBER_PASSWORD).
 * Development fixtures, not secrets. The multi-wallet phone's wallets carry COPIED
 * hashes, the harness's trick for salon B: two of them `ST-001`'s
 * (`noura-dev-password`), the Forest one Maha's — so one password opens two of the
 * three, and the third is the wallet the 409 must never name.
 *
 * THE BUDGETS. `signInLimit.ts` rations 10 per 15 minutes per claimed identity, and a
 * salon-less attempt is charged to its own `member||{phone}` bucket. The multi-wallet
 * phone is MINTED PER RUN in the `+96596…` block (`sign-in-limit.test.ts`'s rule: never
 * a digit's typo away from a seeded `+96599…` number), so its buckets are always fresh.
 * Dana's and Maha's are spent by one or two attempts each — a re-run inside the hour
 * costs that again, and nothing more.
 *
 * The reset budget is PER CONNECTION — three per fifteen minutes from one address, and
 * every request here is from loopback. This file spends two; the spec says so by
 * precondition before it spends them, rather than failing as an unexplained 429.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChooseWorkspaceSchema } from '../packages/types/dist/index.js';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  SALON_A,
  SALON_B,
  STAFF_PASSWORD,
  psql,
  scalar,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

const SALON_FOREST = 'SAL-FOREST';

/** `api/src/db/seed.ts`. */
const DANA = { id: '8842', phone: '+96599124408', password: 'dana-dev-password' };
const MAHA = { id: '8850', phone: '+96599124450', password: 'maha-dev-password' };

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();
const digits = (n: number) => String(Math.floor(Math.random() * 10 ** n)).padStart(n, '0');
/** Three wallets, one phone. See the header. */
const MULTI_PHONE = `+965968${digits(5)}`;
const W_AMARA = `QA-WS-${RUN}-A`;
const W_LUMIERE = `QA-WS-${RUN}-L`;
const W_FOREST = `QA-WS-${RUN}-F`;
const WALLETS = [W_AMARA, W_LUMIERE, W_FOREST];
/** Registered to nobody, in any salon. */
const NOBODY_PHONE = `+965969${digits(5)}`;
const WRONG_PASSWORD = 'lane-d-definitely-not-the-password';

const inList = (ids: string[]) => ids.map((i) => `'${i}'`).join(', ');

async function signIn(body: Record<string, unknown>) {
  return treq<any>('POST', '/auth/member/session', { token: null, body });
}

async function resetRequest(body: Record<string, unknown>) {
  return treq<any>('POST', '/auth/member/password-reset/request', { token: null, body });
}

const sessionsFor = (ids: string[]): number =>
  Number(scalar(`select count(*) from session where member_id in (${inList(ids)})`).trim());

function removeFixture(): void {
  // `session` and `member_password_reset` cascade; nothing else names these rows.
  psql(`DELETE FROM member WHERE id IN (${inList(WALLETS)});`);
}

beforeAll(async () => {
  await startTenancyApi();
  removeFixture();
  precondition(
    Number(scalar(`select count(*) from member where phone in ('${MULTI_PHONE}', '${NOBODY_PHONE}')`).trim()) === 0,
    `the minted phones ${MULTI_PHONE} / ${NOBODY_PHONE} already belong to somebody — re-run`,
  );
  /**
   * In one statement, so `joined_at` ties and `liveWalletsForPhone`'s `id` tie-break
   * orders them -A, -F, -L. The Forest wallet's hash is Maha's; the other two are
   * ST-001's, so `STAFF_PASSWORD` opens exactly Amara and Lumiere.
   */
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT w.id, w.salon, 'Workspace probe ' || w.id, '${MULTI_PHONE}', NULL, false, w.hash,
           0, 0, 'bronze', NULL, 1
      FROM (VALUES
        ('${W_AMARA}',   '${SALON_A}',      (SELECT password_hash FROM staff_user WHERE id = '${A_STAFF_FULL}')),
        ('${W_LUMIERE}', '${SALON_B}',      (SELECT password_hash FROM staff_user WHERE id = '${A_STAFF_FULL}')),
        ('${W_FOREST}',  '${SALON_FOREST}', (SELECT password_hash FROM member WHERE id = '${MAHA.id}'))
      ) AS w(id, salon, hash);
  `);
  precondition(
    Number(scalar(`select count(*) from member where phone = '${MULTI_PHONE}' and erased_at is null`).trim()) === 3,
    'the three-wallet fixture did not land',
  );
}, 120_000);

afterAll(async () => {
  removeFixture();
  await stopTenancyApi();
});

// ===========================================================================

describe('one wallet: the account decides the workspace', () => {
  it(`Dana, with no salonId, lands in ${SALON_A} — the session is hers and says so`, async () => {
    const res = await signIn({ phone: DANA.phone, password: DANA.password });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.member).toMatchObject({ id: DANA.id, salonId: SALON_A });
    expect(typeof res.body.accessToken).toBe('string');

    const me = await treq<any>('GET', '/members/me', { token: res.body.accessToken });
    expect(me.status, me.raw).toBe(200);
    expect(me.body).toMatchObject({ id: DANA.id, salonId: SALON_A });
  });

  it(`Maha, with no salonId, lands in ${SALON_FOREST}`, async () => {
    const res = await signIn({ phone: MAHA.phone, password: MAHA.password });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.member).toMatchObject({ id: MAHA.id, salonId: SALON_FOREST });

    const me = await treq<any>('GET', '/members/me', { token: res.body.accessToken });
    expect(me.status, me.raw).toBe(200);
    expect(me.body).toMatchObject({ id: MAHA.id, salonId: SALON_FOREST });
  });
});

// ===========================================================================

describe('several wallets: choose_workspace names only the salons the password opened', () => {
  it('409 choose_workspace, workspaces at the top level, Amara and Lumiere and never Forest — and no session', async () => {
    const before = sessionsFor(WALLETS);
    const res = await signIn({ phone: MULTI_PHONE, password: STAFF_PASSWORD });
    expect(res.status, res.raw).toBe(409);

    const parsed = ChooseWorkspaceSchema.safeParse(res.body);
    expect(parsed.success, `the 409 is not ChooseWorkspaceSchema: ${res.raw}`).toBe(true);
    expect(res.body.error).toBe('choose_workspace');
    expect(Object.keys(res.body).sort(), 'the 409 carries something besides its three keys').toEqual(
      ['error', 'message', 'workspaces'],
    );

    const salons = [SALON_A, SALON_B];
    const expected = salons.map((id) => {
      const [name, nameAr, brandColor] = scalar(
        `select concat_ws('|', name, coalesce(name_ar, '<null>'), brand_color) from salon where id = '${id}'`,
      )
        .trim()
        .split('|');
      return { salonId: id, name, nameAr: nameAr === '<null>' ? null : nameAr, brandColor };
    });
    expect(
      [...res.body.workspaces].sort((a: any, b: any) => a.salonId.localeCompare(b.salonId)),
      'the workspaces are not exactly the two salons this password opens, as their rows say',
    ).toEqual(expected.sort((a, b) => a.salonId.localeCompare(b.salonId)));

    const forest = scalar(`select concat_ws('|', name, brand_color) from salon where id = '${SALON_FOREST}'`)
      .trim()
      .split('|');
    for (const tell of [SALON_FOREST, `"${forest[0]}"`, forest[1]!, W_FOREST]) {
      expect(res.raw, `the 409 names the wallet the password did NOT open (${tell})`).not.toContain(tell);
    }
    expect(res.raw).not.toContain('accessToken');
    expect(sessionsFor(WALLETS), 'a choose_workspace answer minted a session').toBe(before);
  });

  it("the same phone with Maha's password opens only Forest, so it signs straight in there", async () => {
    const res = await signIn({ phone: MULTI_PHONE, password: MAHA.password });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.member).toMatchObject({ id: W_FOREST, salonId: SALON_FOREST });
  });

  it('the re-post with the chosen salonId signs in to that wallet, and only that one', async () => {
    const before = sessionsFor([W_AMARA, W_LUMIERE]);
    const res = await signIn({ salonId: SALON_B, phone: MULTI_PHONE, password: STAFF_PASSWORD });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.member).toMatchObject({ id: W_LUMIERE, salonId: SALON_B });
    expect(sessionsFor([W_LUMIERE])).toBeGreaterThan(0);
    expect(sessionsFor([W_AMARA, W_LUMIERE]), 'the re-post minted more than one session').toBe(before + 1);

    const me = await treq<any>('GET', '/members/me', { token: res.body.accessToken });
    expect(me.body).toMatchObject({ id: W_LUMIERE, salonId: SALON_B });
  });

  it('a re-post naming a salon the password does not open is the ordinary 401', async () => {
    const res = await signIn({ salonId: SALON_FOREST, phone: MULTI_PHONE, password: STAFF_PASSWORD });
    expect(res.status, res.raw).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });
});

// ===========================================================================

describe('a wrong password is indistinguishable from an unknown phone', () => {
  it('a three-wallet phone with the wrong password answers the unknown-phone 401, byte for byte', async () => {
    const wrong = await signIn({ phone: MULTI_PHONE, password: WRONG_PASSWORD });
    const unknown = await signIn({ phone: NOBODY_PHONE, password: WRONG_PASSWORD });

    expect(unknown.status, unknown.raw).toBe(401);
    expect(unknown.body.error).toBe('invalid_credentials');
    expect(wrong.status, wrong.raw).toBe(unknown.status);
    expect(wrong.raw, 'the miss on a known phone reads differently from an unknown one').toBe(unknown.raw);
    expect(wrong.raw).not.toContain('workspaces');
  });
});

// ===========================================================================

describe('the salon-scoped path is unchanged', () => {
  it('Dana with salonId signs in to the same wallet, in the same body shape, as without it', async () => {
    const scoped = await signIn({ salonId: SALON_A, phone: DANA.phone, password: DANA.password });
    expect(scoped.status, scoped.raw).toBe(200);
    const unscoped = await signIn({ phone: DANA.phone, password: DANA.password });
    expect(unscoped.status, unscoped.raw).toBe(200);

    expect(Object.keys(scoped.body).sort()).toEqual(['accessToken', 'expiresAt', 'member', 'refreshToken']);
    expect(Object.keys(unscoped.body).sort()).toEqual(Object.keys(scoped.body).sort());
    expect(unscoped.body.member, 'the two paths serialise the same member differently').toEqual(scoped.body.member);
  });

  it('Dana at a salon she has no wallet in is the unknown-phone 401, byte for byte', async () => {
    const elsewhere = await signIn({ salonId: SALON_B, phone: DANA.phone, password: DANA.password });
    const unknown = await signIn({ salonId: SALON_B, phone: NOBODY_PHONE, password: DANA.password });
    expect(elsewhere.status, elsewhere.raw).toBe(401);
    expect(elsewhere.raw).toBe(unknown.raw);
  });

  it("a blank salonId is still the 400 it always was — absent means absent, not ''", async () => {
    const res = await signIn({ salonId: '', phone: DANA.phone, password: DANA.password });
    expect(res.status, res.raw).toBe(400);
    expect(res.raw).not.toContain('accessToken');
  });
});

// ===========================================================================

describe('a salon-less reset never names a salon', () => {
  it('202 {accepted:true}, byte-identical to an unknown phone, one link per live wallet, no salon in the reply', async () => {
    const recent = Number(
      scalar(
        `select count(*) from member_password_reset_attempt where created_at > now() - interval '15 minutes'`,
      ).trim(),
    );
    precondition(
      recent <= 1,
      `${recent} reset requests from this machine in the last 15 minutes; the per-connection ` +
        'budget is 3 and this spec spends 2. Wait out the window rather than reading a 429 as a defect.',
    );
    const linksBefore = Number(
      scalar(`select count(*) from member_password_reset where member_id in (${inList(WALLETS)})`).trim(),
    );

    const known = await resetRequest({ phone: MULTI_PHONE });
    const unknown = await resetRequest({ phone: NOBODY_PHONE });

    expect(known.status, known.raw).toBe(202);
    expect(known.body).toEqual({ accepted: true });
    expect(known.raw, 'a three-wallet phone and an unknown phone read differently').toBe(unknown.raw);
    expect(unknown.status).toBe(202);

    const salons = scalar(`select string_agg(id || '|' || name, '|') from salon`).trim().split('|');
    for (const tell of salons) {
      expect(known.raw, `the reset reply names ${tell}`).not.toContain(tell);
    }

    // One OUTSTANDING link per wallet the phone holds — the Forest one included: a
    // reset proves the phone, not a password, so every wallet on it gets its own.
    for (const w of WALLETS) {
      expect(
        scalar(`select count(*) from member_password_reset where member_id = '${w}' and used_at is null`).trim(),
        `${w} has no outstanding reset link`,
      ).toBe('1');
    }
    expect(
      Number(scalar(`select count(*) from member_password_reset where member_id in (${inList(WALLETS)})`).trim()),
    ).toBe(linksBefore + 3);
  });
});
