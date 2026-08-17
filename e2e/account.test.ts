/**
 * THE WALLET'S ACCOUNT SCREEN, FROM THE SERVER'S SIDE.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --filter @avo/api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run account.test.ts
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Lane B built the Account screen — profile edit, phone confirmation, change
 * password, the policy renderer, contact us, notification switches, deletion —
 * and `apps/wallet/src/api/account.ts` is the list of endpoints it calls. When
 * this file was written there were six of them and one existed. Every other spec
 * here was a `knownBug()` holding the contract's assertion against an absent
 * route, which is the only form of "this is missing" that cannot quietly stop
 * being true.
 *
 * Lane A's phase-4 merge landed five of the six and they all flipped in one run.
 * They are plain `it()` now, and mostly with MORE assertions than the knownBug
 * carried: a knownBug only has to prove a route is missing, so its call can be a
 * gesture, while a passing spec is what will be defended.
 *
 * The two non-negotiables in play are the ones that could not be retro-fitted:
 *
 *   #10  the customer app holds no legal copy. It renders the published set from
 *        the API and stamps the version against the member. Lane B built the
 *        wallet with no bundled fallback set at all — a property of the code,
 *        not a promise — so the endpoint's absence WAS an empty Terms screen in
 *        front of a customer, and its arrival is what makes the stamped version
 *        refer to something.
 *   #11  support routing is resolved SERVER-SIDE from `topicId`. The spec below
 *        supplies a `route` on purpose, and the opposite of the right one: a
 *        client-supplied route is exactly what the rule forbids, and "we'll pass
 *        the route through for now" is exactly the shape the eventual mistake
 *        would take.
 *
 * ITS OWN MEMBER, SEEDED HERE. The password specs below change a password for
 * real and revoke sessions for real. Doing that to `B_MEMBER` would leave every
 * other file's `signInMember()` depending on the order the files happened to run
 * in — the shared-fixture failure this suite has now been bitten by three times.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  SALON_B,
  psql,
  scalar,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** This file's member. Nothing else reads or writes her. */
const MEMBER = 'QA-ACC-0001';
const MEMBER_NAME = 'Sara Al-Mutairi';
const MEMBER_PHONE = '+96599777301';
const MEMBER_BALANCE_FILS = 12_000;

/**
 * The password every seeded principal shares.
 *
 * Copied from `staff_user` the way `seedSalonB()` copies it, and for the same
 * reason: `hashSecret()` is one function for staff and members, so the hash is
 * portable and cannot drift out of step with lane A's seed the way a pasted
 * constant would. The literal is only needed because the password specs have to
 * present the CURRENT password to change it.
 */
const PASSWORD = 'noura-dev-password';

let member = '';

/** Restore the row to the state `beforeAll` created, whatever the specs did. */
function reseedMember(): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${MEMBER}', '${SALON_B}', '${MEMBER_NAME}', '${MEMBER_PHONE}',
           'qa-account@example.invalid', false, s.password_hash,
           ${MEMBER_BALANCE_FILS}, 3, 'bronze', NULL, 3
    FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET
      name           = EXCLUDED.name,
      email          = EXCLUDED.email,
      email_verified = false,
      password_hash  = EXCLUDED.password_hash,
      balance_fils   = ${MEMBER_BALANCE_FILS},
      visits         = 3,
      tier           = 'bronze',
      policy_version = 3;
  `);
}

beforeAll(async () => {
  await startTenancyApi();
  reseedMember();
  member = await signInMember(SALON_B, MEMBER_PHONE);
}, 120_000);

afterAll(async () => {
  // Leave the password where the next run expects it, whether or not the
  // password specs got that far.
  reseedMember();
  await stopTenancyApi();
});

// ===========================================================================

interface MemberView {
  id: string;
  salonId: string;
  name: string;
  phone: string;
  email: string | null;
  emailVerified: boolean;
  balanceFils: number;
  visits: number;
  tier: string;
  policyVersion: number | null;
  joinedAt: string;
}

describe('the screen\'s own read — GET /members/me', () => {
  it('carries everything the Account header and profile rows render', async () => {
    const res = await treq<MemberView>('GET', '/members/me', { token: member });
    expect(res.status, res.raw).toBe(200);

    expect(res.body.id).toBe(MEMBER);
    expect(res.body.name).toBe(MEMBER_NAME);
    expect(res.body.phone).toBe(MEMBER_PHONE);
    // `emailVerified` is a separate field on purpose: the design shows "Unverified"
    // beside an email that is present but unconfirmed, which an email string alone
    // cannot express.
    expect(typeof res.body.emailVerified).toBe('boolean');
    expect(Number.isInteger(res.body.balanceFils), 'the balance is not integer fils').toBe(true);
    expect(res.body.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('stamps the accepted policy version against the member (non-negotiable #10)', async () => {
    const res = await treq<MemberView>('GET', '/members/me', { token: member });
    precondition(res.status === 200, `GET /members/me answered ${res.status}`);
    // The version is what makes "she accepted THESE terms" answerable later. A
    // client that renders policies without one has rendered a document nobody can
    // prove was the one shown.
    expect(res.body.policyVersion, 'no accepted policy version on the member').not.toBeNull();
  });

  it('and never a credential, at any nesting (non-negotiable #6)', async () => {
    const res = await treq('GET', '/members/me', { token: member });
    for (const smell of ['passwordHash', 'password_hash', 'password', '$argon2']) {
      expect(res.raw, `GET /members/me leaked ${smell}`).not.toContain(smell);
    }
  });
});

// ===========================================================================
// Change password — the one Account endpoint that exists, and the one that
// makes a security promise to the customer's face.
// ===========================================================================

describe('change password — the sentence on the screen is true only if the server did it', () => {
  it('the wrong current password is refused, and nothing changes', async () => {
    const hashBefore = scalar(`select password_hash from member where id='${MEMBER}'`);

    const res = await treq('POST', '/members/me/password', {
      token: member,
      body: { current: 'not-my-password', next: 'a-new-password-1' },
    });
    expect(res.status, res.raw).toBe(401);
    expect(res.raw, 'the refusal echoed a password back').not.toContain('a-new-password-1');
    expect(scalar(`select password_hash from member where id='${MEMBER}'`)).toBe(hashBefore);
  });

  it('a new password shorter than six characters is refused before the hash is even read', async () => {
    const res = await treq<{ error?: string }>('POST', '/members/me/password', {
      token: member,
      body: { current: PASSWORD, next: 'short' },
    });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('password_too_short');
  });

  it('and a "new" password identical to the old one is refused', async () => {
    const res = await treq<{ error?: string }>('POST', '/members/me/password', {
      token: member,
      body: { current: PASSWORD, next: PASSWORD },
    });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('password_unchanged');
  });

  it('a real change signs the OTHER devices out and keeps this one in — the design\'s own promise', async () => {
    // Two devices, both real sessions.
    const otherDevice = await signInMember(SALON_B, MEMBER_PHONE);
    const otherAlive = await treq('GET', '/members/me', { token: otherDevice });
    precondition(otherAlive.status === 200, 'the second device was never signed in');

    const nextPassword = 'a-new-password-1';
    const changed = await treq('POST', '/members/me/password', {
      token: member,
      body: { current: PASSWORD, next: nextPassword },
    });
    // 204: there is no body, so there is no body to leak a credential in.
    expect(changed.status, changed.raw).toBe(204);
    expect(changed.raw).toBe('');

    // The caller stays in. If this 401s, the screen's "You stay logged in on this
    // phone" is a lie in the opposite direction.
    const stillMe = await treq('GET', '/members/me', { token: member });
    expect(stillMe.status, 'the calling device was signed out by its own password change').toBe(200);

    // The other device drops on its very next request.
    const otherNow = await treq('GET', '/members/me', { token: otherDevice });
    expect(otherNow.status, 'the other device is still signed in after a password change').toBe(401);

    // And the new password is the one that works.
    const reSignedIn = await treq<{ accessToken?: string }>('POST', '/auth/member/session', {
      token: null,
      body: { salonId: SALON_B, phone: MEMBER_PHONE, password: nextPassword },
    });
    expect(reSignedIn.status, reSignedIn.raw).toBe(200);
    expect(reSignedIn.body.accessToken).toBeTruthy();

    // The old one is not.
    const oldPassword = await treq('POST', '/auth/member/session', {
      token: null,
      body: { salonId: SALON_B, phone: MEMBER_PHONE, password: PASSWORD },
    });
    expect(oldPassword.status, 'the old password still signs in').toBe(401);

    // Back to the seeded hash, and a fresh token for anything after this.
    reseedMember();
    member = await signInMember(SALON_B, MEMBER_PHONE);
  });

  it('and it is written down under Access, because a credential moved', async () => {
    const before = Number(
      scalar(
        `select count(*) from audit_log where subject_id='${MEMBER}' and action='Password changed'`,
      ),
    );

    const res = await treq('POST', '/members/me/password', {
      token: member,
      body: { current: PASSWORD, next: 'another-new-password-2' },
    });
    precondition(res.status === 204, `the change answered ${res.status} ${res.raw}`);

    const after = Number(
      scalar(
        `select count(*) from audit_log where subject_id='${MEMBER}' and action='Password changed'`,
      ),
    );
    expect(after, 'a password changed with nothing written down').toBe(before + 1);

    // And the row itself must not carry the credential it is about.
    const detail = scalar(
      `select coalesce(detail,'') || ' ' || coalesce(metadata::text,'')
         from audit_log where subject_id='${MEMBER}' and action='Password changed'
        order by seq desc limit 1`,
    );
    expect(detail, 'the audit row recorded the password').not.toContain('another-new-password-2');

    reseedMember();
    member = await signInMember(SALON_B, MEMBER_PHONE);
  });
});

// ===========================================================================
// PROMOTED. Five of these six were knownBug() reporting an absent endpoint, and
// lane A's phase-4 merge landed all of them. The sixth was red for a reason that
// was mine: it sent `topicId: 'wallet-balance'`, an id that exists in no seed.
//
// The topic id had three spellings across three surfaces — the design says
// `wallet`, `packages/mock` says `tp-wallet`, and this file had invented a
// third. Lane A seeded the design's, which settles it. Lane B's wallet echoes
// `topic.id` straight from the config it fetched, so it was never wrong; only
// this literal and the mock's fixture were, and the mock is trunk's.
// ===========================================================================

describe('the profile, the policy set and support — the rest of the Account screen', () => {
  /**
   * `apps/wallet/src/api/account.ts` § profile. api-contract.md rule 1 defines
   * both halves: the profile edit takes `name` and `email`, and it must REFUSE a
   * `phone` field, because the phone is the login identity and moves only through
   * the challenge pair below.
   */
  it('PATCH /members/me edits the profile and answers the updated Member', async () => {
    const renamed = 'Sara Al-Mutairi-Ahmed';
    const res = await treq<MemberView>('PATCH', '/members/me', {
      token: member,
      body: { name: renamed },
    });
    expect(
      res.status,
      `PATCH /members/me answered ${res.status} — a customer cannot change her own name`,
    ).toBe(200);
    expect(res.body.name).toBe(renamed);
    // The second request. The response could be an echo; the row cannot.
    expect(scalar(`select name from member where id='${MEMBER}'`)).toBe(renamed);

    await treq('PATCH', '/members/me', { token: member, body: { name: MEMBER_NAME } });
  });

  it('changing the email clears emailVerified, because the new one has proved nothing', async () => {
    psql(`UPDATE member SET email_verified = true WHERE id='${MEMBER}';`);
    const res = await treq<MemberView>('PATCH', '/members/me', {
      token: member,
      body: { email: 'qa-account-changed@example.invalid' },
    });
    precondition(res.status === 200, `PATCH answered ${res.status}: ${res.raw}`);

    expect(
      res.body.emailVerified,
      'a new, unconfirmed address inherited the old one\'s verified flag',
    ).toBe(false);
    expect(scalar(`select email_verified::text from member where id='${MEMBER}'`)).toBe('false');
  });

  it('PATCH /members/me REFUSES a phone field (api-contract rule 1)', async () => {
    const res = await treq<{ error?: string }>('PATCH', '/members/me', {
      token: member,
      body: { phone: '+96599000000' },
    });
    // Refused by name, not silently dropped: a 200 that ignored the field would
    // tell the client the identity moved when it did not.
    expect(res.status, `PATCH /members/me { phone } answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBeTruthy();
    expect(scalar(`select phone from member where id='${MEMBER}'`)).toBe(MEMBER_PHONE);
  });

  /**
   * The phone confirmation pair. Changing the login identity cannot be a single
   * PATCH — the new number has to prove it can receive a code, and the OLD number
   * is notified by the server that it happened.
   */
  it('POST /members/me/phone-change starts a challenge and does NOT move the identity', async () => {
    const res = await treq<{
      challengeId?: string;
      expiresAt?: string;
      newPhone?: string;
      codeSent?: boolean;
      code?: unknown;
    }>('POST', '/members/me/phone-change', { token: member, body: { phone: '+96599777399' } });

    expect(res.status, `POST /members/me/phone-change answered ${res.status}: ${res.raw}`).toBe(200);
    expect(res.body.challengeId, 'no challenge to verify against').toBeTruthy();
    expect(res.body.expiresAt, 'a challenge with no expiry is a challenge that never closes').toBeTruthy();

    // Unverified, the identity has not moved. This is the assertion that matters:
    // a challenge that changed the phone before the code was entered would let
    // anyone holding a session lock the customer out of her own account.
    expect(scalar(`select phone from member where id='${MEMBER}'`)).toBe(MEMBER_PHONE);

    /**
     * THE CODE IS NOT IN THE BODY. Asserted on the KEY, not on the substring.
     *
     * The first draft banned the substring "code" and failed on `codeSent: false`
     * — a field that exists precisely because delivery is not wired and this API
     * refuses to let a client render "we've texted you" on top of nothing. That is
     * the honest design, and a spec should not read it as a leak.
     *
     * What must never appear is the challenge secret itself: anyone holding the
     * session could read it and verify immediately, which is the exact property a
     * second factor exists to deny.
     */
    expect(res.body.code, 'the challenge code was returned to the caller').toBeUndefined();
    expect(res.body.codeSent, 'the API claimed a delivery it has no sender for').toBe(false);
    expect(
      res.raw,
      'a bare numeric code appears in the response body',
    ).not.toMatch(/"\s*\d{4,8}\s*"/);
  });

  /**
   * NON-NEGOTIABLE #10, in one request.
   *
   * The wallet has no bundled legal set and no fallback branch — lane B made that
   * a property of the code rather than a promise, so until this endpoint existed
   * the Terms screen was blank and the version stamped against the member named a
   * document nobody could produce.
   */
  it('GET /v1/platform/policies serves the published legal set, with a version to stamp', async () => {
    const res = await treq<{
      published?: { version?: number; docs?: Array<{ id: string; title: { en: string; ar: string } }> };
    }>('GET', '/v1/platform/policies', { token: member });

    expect(
      res.status,
      `GET /v1/platform/policies answered ${res.status} — the wallet's Terms screen is empty`,
    ).toBe(200);
    const docs = res.body.published?.docs ?? [];
    expect(docs.length, 'no documents in the published set').toBeGreaterThan(0);
    expect(res.body.published?.version, 'the set carries no version to stamp').toBeTruthy();

    // Every document carries both languages as keys, even when `ar` is empty —
    // the contract's per-document fallback needs the key to exist to fall back
    // FROM, and lane B's `localiseDoc` reads `doc.title.ar` unconditionally.
    for (const doc of docs) {
      expect(doc.id, 'a policy document with no id cannot be linked to').toBeTruthy();
      expect(typeof doc.title?.en, `${doc.id} has no English title`).toBe('string');
      expect(typeof doc.title?.ar, `${doc.id} has no Arabic title key to fall back from`).toBe(
        'string',
      );
    }
  });

  it('GET /v1/platform/support serves the channels, the hours and the topics', async () => {
    const res = await treq<{ topics?: Array<{ id: string; route: string }> }>(
      'GET',
      '/v1/platform/support',
      { token: member },
    );
    expect(res.status, `GET /v1/platform/support answered ${res.status}: ${res.raw}`).toBe(200);
    const topics = res.body.topics ?? [];
    expect(topics.length, 'no topic list for the Contact us form').toBeGreaterThan(0);

    // The route is SERVED so the wallet can draw the "Salon" / "AVO" chip beside
    // each topic — the design shows the customer who answers before she picks.
    // Displaying it and sending it are different things; the next spec is the
    // other half.
    for (const t of topics) {
      expect(['salon', 'avo'], `topic ${t.id} has route "${t.route}"`).toContain(t.route);
    }
    expect(topics.map((t) => t.id), 'the wallet topic is not in the list').toContain('wallet');
  });

  /**
   * NON-NEGOTIABLE #11 — and the assertion is deliberately about what the SERVER
   * decides, not about a ticket being created.
   *
   * The client sends `topicId` and never `route`; lane B's `TicketDraft` makes
   * sending one a compile error. This holds the other half: a route supplied
   * anyway must not be honoured, or a wallet dispute lands in a salon's inbox and
   * the customer's money question is answered by the merchant she is disputing.
   */
  it('POST /v1/support/tickets resolves the route from topicId, server-side', async () => {
    const res = await treq<{ id?: string; route?: string; topicId?: string }>(
      'POST',
      '/v1/support/tickets',
      {
        token: member,
        idempotencyKey: `support-${Date.now()}`,
        body: {
          topicId: 'wallet',
          message: `My top-up has not arrived. ${Date.now()}`,
          ref: '',
          via: 'email',
          // Supplied on purpose, and the opposite of the right answer. `wallet`
          // routes to AVO; this asks for the salon.
          route: 'salon',
        },
      },
    );
    expect(res.status, `POST /v1/support/tickets answered ${res.status}: ${res.raw}`).toBe(200);
    expect(
      res.body.route,
      'a client-supplied route was honoured — a wallet dispute can be routed to the salon',
    ).toBe('avo');

    // And it is the ROW that carries the server's answer, not just the response.
    expect(
      scalar(`select route from support_ticket where id='${res.body.id}'`),
      'the stored ticket carries the route the client asked for',
    ).toBe('avo');
  });

  it('an unknown topic is refused with the list, never routed somewhere sensible', async () => {
    const res = await treq<{ error?: string; message?: string }>('POST', '/v1/support/tickets', {
      token: member,
      body: { topicId: 'wallet-balance', message: 'anything', ref: '', via: 'email' },
    });
    // `wallet-balance` is the id this file used to send. Guessing a route for an
    // unknown topic is exactly the decision this endpoint exists to take away
    // from guesswork.
    expect(res.status, 'an unknown topic was accepted').toBe(400);
    expect(res.body.error).toBe('unknown_topic');
    expect(res.body.message, 'the refusal does not say which topics are valid').toContain('wallet');
  });
});

/**
 * GAP — the parts of this screen whose SHAPE is not a client decision, so they
 * cannot be written as a knownBug without inventing the contract first. Each
 * names what has to be decided before a spec can exist.
 */
describe('GAP: Account behaviour with no contract yet', () => {
  it.todo(
    'account deletion has no endpoint anywhere — not in api-contract.md, not in packages/mock, not in api/src/routes. Whether it is a ticket, a queued 30-day job or a state on the member changes what the confirmation is allowed to say, and the copy already promises "removed within 30 days" (lane A + product)',
  );
  it.todo(
    'the notification switches have no persisted home; the wallet holds them locally today, so a reinstall silently re-enables everything the customer turned off (lane A)',
  );
  it.todo(
    'POST /members/me/phone-change/{id}/verify — the second half of the challenge pair, including the notice the server sends to the OLD number (lane A)',
  );
  it.todo(
    'accepting a new policy version: the member stamps a version but nothing lets her accept a newer one, so a re-published set has no path to consent (lane A)',
  );
});
