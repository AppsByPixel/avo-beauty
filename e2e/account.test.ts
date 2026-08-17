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
 * Lane B has built the Account screen — profile edit, phone confirmation, change
 * password, the policy renderer, contact us, notification switches, deletion —
 * and `apps/wallet/src/api/account.ts` is the list of endpoints it calls. Six of
 * them. One exists.
 *
 * That is not a criticism of lane B's work; the client is written against
 * api-contract.md and says so at every call site, including the ones where it
 * refuses to fake a success it cannot back. It is the reason this file is mostly
 * `knownBug()`. A screen built against an absent server is a phase that reports
 * done twice — once when the screen renders and once, months later, when someone
 * discovers the customer cannot actually change her name.
 *
 * The two non-negotiables in play are the ones that cannot be retro-fitted:
 *
 *   #10  the customer app holds no legal copy. It renders the published set from
 *        the API and stamps the version against the member. With no endpoint,
 *        the wallet's policy section renders nothing at all — which lane B has
 *        made testable rather than accidental, and which is still an empty
 *        Terms screen in front of a customer.
 *   #11  support routing is resolved SERVER-SIDE from `topicId`. There is no
 *        server. A client-supplied route is exactly what the rule forbids and
 *        exactly what an eventual "we'll pass the route through for now" would
 *        be.
 *
 * ITS OWN MEMBER, SEEDED HERE. The password specs below change a password for
 * real and revoke sessions for real. Doing that to `B_MEMBER` would leave every
 * other file's `signInMember()` depending on the order the files happened to run
 * in — the shared-fixture failure this suite has now been bitten by three times.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
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
// Everything else the screen calls. Written as the contract says it should
// behave, so each one flips the day lane A ships it.
// ===========================================================================

describe('GAP: the Account screen calls five endpoints that do not exist — lane A', () => {
  /**
   * `apps/wallet/src/api/account.ts` § profile. api-contract.md rule 1 defines
   * both halves: the profile edit takes `name` and `email`, and it must REJECT a
   * `phone` field because the phone is the login identity and moves through the
   * challenge pair below.
   */
  knownBug('PATCH /members/me edits the profile and answers the updated Member', async () => {
    const res = await treq<MemberView>('PATCH', '/members/me', {
      token: member,
      body: { name: 'Sara Al-Mutairi-Ahmed' },
    });
    expect(
      res.status,
      `PATCH /members/me answered ${res.status} — a customer cannot change her own name`,
    ).toBe(200);
    expect(res.body.name).toBe('Sara Al-Mutairi-Ahmed');
  });

  knownBug('PATCH /members/me REFUSES a phone field (api-contract rule 1)', async () => {
    const res = await treq<{ error?: string }>('PATCH', '/members/me', {
      token: member,
      body: { phone: '+96599000000' },
    });
    // 404 today because the route is absent. When it lands, a 404 here would mean
    // the route exists and quietly accepted the identity change — which is why
    // this asserts the code and not merely "not 200".
    expect(res.status, `PATCH /members/me { phone } answered ${res.status}`).toBe(400);
    expect(scalar(`select phone from member where id='${MEMBER}'`)).toBe(MEMBER_PHONE);
  });

  /**
   * The phone confirmation pair. Changing the login identity cannot be a single
   * PATCH — the new number has to prove it can receive a code, and the OLD number
   * is notified by the server that it happened.
   */
  knownBug('POST /members/me/phone-change starts a challenge on the NEW number', async () => {
    const res = await treq<{ challengeId?: string; expiresAt?: string }>(
      'POST',
      '/members/me/phone-change',
      { token: member, body: { phone: '+96599777399' } },
    );
    expect(res.status, `POST /members/me/phone-change answered ${res.status}`).toBe(200);
    expect(res.body.challengeId, 'no challenge to verify against').toBeTruthy();
    // Unverified, the identity has not moved.
    expect(scalar(`select phone from member where id='${MEMBER}'`)).toBe(MEMBER_PHONE);
  });

  /**
   * NON-NEGOTIABLE #10, in one request.
   *
   * The wallet has no bundled legal set and no fallback branch — lane B made that
   * a property of the code rather than a promise. So with no endpoint the Terms
   * screen is blank, and the version stamped against the member refers to a
   * document nobody can produce.
   */
  knownBug('GET /v1/platform/policies serves the published legal set', async () => {
    const res = await treq<{ published?: { version?: number; docs?: unknown[] } }>(
      'GET',
      '/v1/platform/policies',
      { token: member },
    );
    expect(
      res.status,
      `GET /v1/platform/policies answered ${res.status} — the wallet's Terms screen is empty`,
    ).toBe(200);
    expect(Array.isArray(res.body.published?.docs), 'no documents in the published set').toBe(true);
    expect(res.body.published?.version, 'the set carries no version to stamp').toBeTruthy();
  });

  knownBug('GET /v1/platform/support serves the channels, the hours and the topics', async () => {
    const res = await treq<{ topics?: Array<{ id: string; route: string }> }>(
      'GET',
      '/v1/platform/support',
      { token: member },
    );
    expect(res.status, `GET /v1/platform/support answered ${res.status}`).toBe(200);
    expect(Array.isArray(res.body.topics), 'no topic list for the Contact us form').toBe(true);
  });

  /**
   * NON-NEGOTIABLE #11 — and the assertion is deliberately about what the SERVER
   * decides, not about the ticket being created.
   *
   * The client sends `topicId` and never `route`; lane B's `TicketDraft` makes
   * sending one a compile error. The rule this spec will hold when the endpoint
   * lands is the other half: a route supplied anyway must not be honoured, or a
   * wallet dispute lands in a salon's inbox and the customer's money question is
   * answered by the merchant she is disputing.
   */
  knownBug('POST /v1/support/tickets resolves the route from topicId, server-side', async () => {
    const res = await treq<{ id?: string; route?: string }>('POST', '/v1/support/tickets', {
      token: member,
      idempotencyKey: `support-${Date.now()}`,
      body: {
        topicId: 'wallet-balance',
        message: 'My top-up has not arrived.',
        ref: '',
        via: 'email',
        // Supplied on purpose. The server must ignore it.
        route: 'salon',
      },
    });
    expect(res.status, `POST /v1/support/tickets answered ${res.status}`).toBe(200);
    expect(
      res.body.route,
      'a client-supplied route was honoured — a wallet dispute can be routed to the salon',
    ).toBe('avo');
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
