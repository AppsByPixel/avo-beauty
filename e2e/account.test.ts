/**
 * THE WALLET'S ACCOUNT SCREEN, FROM THE SERVER'S SIDE.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  B_SCANNER_DEVICE,
  B_STAFF_HANDLE,
  SALON_B,
  psql,
  reconcileWalletLedger,
  scalar,
  forgetSession,
  signInDashboard,
  signInMember,
  signInMemberFresh,
  signInScanner,
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
let victim = '';

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
      policy_version = 3,
      -- The four preference columns and the deletion clock, because this function
      -- claims to restore the row to what beforeAll created and until the
      -- notification and deletion specs below existed it silently did not: the
      -- INSERT never names these, so the column DEFAULTs only apply on a first
      -- insert and a re-seed left whatever the last run's specs had set. That is
      -- the shape of the trap lane D was warned about in the seed itself, which
      -- prints "(24.500 KD)" while not restoring balance_fils.
      notify_push    = true,
      notify_remind  = true,
      notify_wa      = true,
      notify_receipt = true,
      deletion_requested_at = NULL,
      deletion_due_at       = NULL;
  `);
  /**
   * Her consent trail, and the verb matters. `member_consent_event` refuses UPDATE
   * and TRUNCATE to EVERYONE including the owner (migrations 0020 and 0023), and
   * leaves DELETE alone — deliberately, because `member_id` is ON DELETE CASCADE
   * and a DELETE trigger here would make the 30-day erasure impossible. This is the
   * owner connection using the one verb that is open, which is why the reset works
   * at all. "Append-only like audit_log" would be the wrong description of this
   * table in two of the three verbs; the specs below name each one.
   */
  psql(`DELETE FROM member_consent_event WHERE member_id = '${MEMBER}';`);
}

/**
 * A SECOND MEMBER, WHOSE ONLY JOB IS TO BE LEFT ALONE.
 *
 * Every tenancy spec below asks the same question in a different way: can one
 * customer's session reach another customer's row. That question needs a second
 * row, and it must not be `B_MEMBER` — she is the salon B fixture half this suite
 * signs in as, and if one of these probes DID land, the leak would arrive in
 * other files as an unrelated failure somewhere downstream. A dedicated victim
 * means a hole shows up here, named, in the spec that went looking for it.
 *
 * She is deliberately given a NON-DEFAULT preference state and a positive
 * balance, so "nothing changed" is a comparison against something distinctive
 * rather than against the defaults every member happens to share.
 */
const VICTIM = 'QA-ACC-0002';
const VICTIM_PHONE = '+96599777302';
const VICTIM_BALANCE_FILS = 3_000;

function reseedVictim(): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version,
                        notify_push, notify_remind, notify_wa, notify_receipt)
    SELECT '${VICTIM}', '${SALON_B}', 'Hanan Al-Rashid', '${VICTIM_PHONE}',
           NULL, false, s.password_hash,
           ${VICTIM_BALANCE_FILS}, 1, 'bronze', NULL, 3,
           false, false, false, false
    FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET
      password_hash  = EXCLUDED.password_hash,
      balance_fils   = ${VICTIM_BALANCE_FILS},
      policy_version = 3,
      notify_push    = false,
      notify_remind  = false,
      notify_wa      = false,
      notify_receipt = false,
      deletion_requested_at = NULL,
      deletion_due_at       = NULL;
  `);
  psql(`DELETE FROM member_consent_event WHERE member_id = '${VICTIM}';`);
}

// ------------------------------------------------ reading the row directly --

/**
 * The four preference COLUMNS, straight out of Postgres.
 *
 * Read from the table and not from the endpoint on purpose. `wa` and `receipt`
 * are not client-owned settings — the receipt outbox reads the row, not the
 * phone — so the only assertion that means anything about them is one against
 * the column the sender will consult. An endpoint that echoed a switch back
 * without persisting it would satisfy a response-only test perfectly, and the
 * customer would still get the receipt she turned off.
 */
function preferenceColumns(id: string): Record<string, boolean> {
  const row = scalar(
    `select notify_push::text || ',' || notify_remind::text || ',' ||
            notify_wa::text || ',' || notify_receipt::text
       from member where id='${id}'`,
  );
  const [push, remind, wa, receipt] = row.split(',');
  return {
    push: push === 'true',
    remind: remind === 'true',
    wa: wa === 'true',
    receipt: receipt === 'true',
  };
}

/** Her whole consent trail, oldest first. The evidence, not the derived boolean. */
function consentTrail(id: string): Array<{ granted: boolean; source: string; policyVersion: number }> {
  const raw = scalar(
    `select coalesce(string_agg(granted::text || ':' || source || ':' || policy_version::text,
                                '|' order by created_at, id), '')
       from member_consent_event
      where member_id='${id}' and kind='marketing_offers'`,
  );
  if (raw === '') return [];
  return raw.split('|').map((row) => {
    const [granted, source, policyVersion] = row.split(':');
    return { granted: granted === 'true', source: source!, policyVersion: Number(policyVersion) };
  });
}

/** The deletion clock as the eventual erasure job will read it. */
function deletionColumns(id: string): { requestedAt: string; dueAt: string } {
  const raw = scalar(
    `select coalesce(deletion_requested_at::text,'') || '|' || coalesce(deletion_due_at::text,'')
       from member where id='${id}'`,
  );
  const [requestedAt, dueAt] = raw.split('|');
  return { requestedAt: requestedAt ?? '', dueAt: dueAt ?? '' };
}

/**
 * Audit rows for one subject and one action.
 *
 * ALWAYS COMPARED AS A DELTA, never against an absolute number, and that is not
 * fastidiousness — it is the table's defining property. `freshRows()` resets the
 * member and her consent trail because the owner connection may; it cannot reset
 * `audit_log`, because the owner may not either. So counts accumulate across every
 * spec in this file, and an absolute expectation would be a spec whose value
 * depends on how many specs ran before it. The first draft of this block asserted
 * `toBe(1)` in four places and went red on all four for exactly that reason, with
 * the API behaving correctly.
 */
function auditCount(id: string, action: string): number {
  return Number(
    scalar(`select count(*) from audit_log where subject_id='${id}' and action='${action}'`),
  );
}

function setBalance(id: string, fils: number): void {
  psql(`UPDATE member SET balance_fils = ${fils} WHERE id='${id}';`);
}

beforeAll(async () => {
  await startTenancyApi();
  reseedMember();
  reseedVictim();
  member = await signInMember(SALON_B, MEMBER_PHONE);
  victim = await signInMember(SALON_B, VICTIM_PHONE);
}, 120_000);

afterAll(async () => {
  // Leave the password where the next run expects it, whether or not the
  // password specs got that far.
  reseedMember();
  reseedVictim();

  /*
   * AND LEAVE BOTH MEMBERS RECONCILING TO THEIR OWN WALLET LEDGERS.
   *
   * These two reseeds are exactly what made this file's members drift in the
   * wallet census (`support/global-setup.ts`): `reseedMember()` puts
   * `balance_fils` back to 12.000 by SQL AFTER the specs above have driven real
   * charges through her, so her ledger is left ahead of her balance and she
   * drifts NEGATIVE — −8.000 when the census landed. `reseedVictim()` writes an
   * opening 3.000 that no entry accounts for, which drifts the other way.
   *
   * Both are the same defect wearing two signs: a balance nothing explains. So
   * the last thing this file does is post the pair that closes each gap. It runs
   * after the reseeds, because the reseeds are the writes being answered for.
   */
  reconcileWalletLedger(MEMBER, 'QAACC');
  reconcileWalletLedger(VICTIM, 'QAACCV');

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
    /**
     * TWO devices, two DISTINCT sessions — `signInMemberFresh`, deliberately, and
     * this call is the reason that helper exists.
     *
     * `signInMember` holds one session per number per run so the suite fits under
     * `signInLimit.ts`'s per-identity budget. Handed the cached token twice, this
     * spec would compare a session against ITSELF: the assertion below that the
     * other device drops would be looking at the calling device, find it still
     * signed in — correctly, that is the promise — and report that lane A's
     * password change does not revoke. A green handler, named as broken, by the
     * harness.
     */
    const otherDevice = await signInMemberFresh(SALON_B, MEMBER_PHONE);
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

    /**
     * Back to the seeded hash, and a fresh token for anything after this.
     *
     * `forgetSession` FIRST, because the cache is keyed on the identity and not on
     * the credential: this spec has just changed her password twice and revoked a
     * session, so whatever is cached for her is no longer something a later caller
     * should be handed.
     */
    reseedMember();
    forgetSession('member', SALON_B, MEMBER_PHONE);
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
    forgetSession('member', SALON_B, MEMBER_PHONE);
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

// ===========================================================================
// PROMOTED, THE SECOND TIME. The two `it.todo`s at the bottom of this file said
// account deletion and the notification switches had no server behind them at
// all. Migrations 0020 and 0021 landed both, the wallet already calls all four
// routes, and neither had a spec or an entry in the contract-drift guard — so
// four live endpoints on the most sensitive screen in the app were, between them,
// covered by two sentences saying they did not exist.
//
// The shapes are pinned in `contract.test.ts`. What follows is the behaviour.
// ===========================================================================

/** The five keys of the notification response. `serialiseNotifications`. */
interface NotificationView {
  push: boolean;
  remind: boolean;
  wa: boolean;
  receipt: boolean;
  offers: boolean;
  offersConsent: {
    granted: boolean;
    at: string | null;
    source: string | null;
    policyVersion: number | null;
  };
}

interface DeletionView {
  requestedAt: string | null;
  erasureDueAt: string | null;
  status: string;
  graceDays: number;
  erasureScheduled: boolean;
}

/** Every spec below starts from the seeded row, not from the last spec's leavings. */
function freshRows(): void {
  reseedMember();
  reseedVictim();
}

describe('the notification switches — four preferences and one consent, behind one screen', () => {
  beforeEach(freshRows);

  it('the seeded read is three service channels on, offers off, and NEVER ASKED beside it', async () => {
    const res = await treq<NotificationView>('GET', '/members/me/notifications', { token: member });
    expect(res.status, res.raw).toBe(200);

    // Migration 0020: the three service channels default TRUE because they are
    // how a customer is told about her own money and her own appointments.
    expect(res.body.push).toBe(true);
    expect(res.body.remind).toBe(true);
    expect(res.body.wa).toBe(true);
    expect(res.body.receipt).toBe(true);

    // And `offers` is deliberately absent from that list: consent is never a
    // default. The three nulls are the load-bearing part — they are what makes
    // "she has never been asked" a DIFFERENT fact from "she said no", which is
    // the distinction non-negotiable #8's send path has to be able to make.
    expect(res.body.offers).toBe(false);
    expect(res.body.offersConsent).toEqual({
      granted: false,
      at: null,
      source: null,
      policyVersion: null,
    });
  });

  it('turning a switch off writes the COLUMN the sender reads, not just the response', async () => {
    const res = await treq<NotificationView>('PATCH', '/members/me/notifications', {
      token: member,
      body: { receipt: false, wa: false },
    });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.receipt).toBe(false);
    expect(res.body.wa).toBe(false);

    /**
     * THE ASSERTION THIS SLICE EXISTS FOR.
     *
     * `wa` and `receipt` are not client-owned settings. The receipt outbox does
     * not consult a phone before it queues a message, so a switch held anywhere
     * but this row does not stop a receipt — and the customer has been told it
     * did. An endpoint that echoed the value back without persisting it would
     * satisfy the response check above perfectly.
     */
    expect(preferenceColumns(MEMBER)).toEqual({
      push: true,
      remind: true,
      wa: false,
      receipt: false,
    });

    // And the switches she did not touch are untouched, not defaulted back on.
    const after = await treq<NotificationView>('GET', '/members/me/notifications', {
      token: member,
    });
    expect(after.body.push, 'a partial PATCH reset a switch it was not given').toBe(true);
    expect(after.body.receipt, 'the switch did not survive a re-read').toBe(false);
  });

  it('an unknown switch is refused by NAME, and the refusal names the five that exist', async () => {
    const res = await treq<{ error?: string; message?: string }>(
      'PATCH',
      '/members/me/notifications',
      { token: member, body: { nope: true } },
    );
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('not_editable');
    for (const known of ['push', 'remind', 'wa', 'receipt', 'offers']) {
      expect(res.body.message, `the refusal does not name \`${known}\``).toContain(known);
    }
  });

  it('an empty body is refused rather than treated as a no-op success', async () => {
    const res = await treq<{ error?: string }>('PATCH', '/members/me/notifications', {
      token: member,
      body: {},
    });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('and a switch that is not a boolean is refused before anything is written', async () => {
    const res = await treq<{ error?: string }>('PATCH', '/members/me/notifications', {
      token: member,
      // The shape a form sends when nobody coerced it — and `'false'` is truthy,
      // so a handler that took the value on trust would turn the switch ON while
      // the customer was turning it off.
      body: { push: 'false' },
    });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(preferenceColumns(MEMBER).push, 'a rejected value still reached the column').toBe(true);
  });

  it('a strict body check is also what refuses a client-supplied member id', async () => {
    const before = preferenceColumns(VICTIM);
    const res = await treq<{ error?: string; message?: string }>(
      'PATCH',
      '/members/me/notifications',
      { token: member, body: { offers: true, memberId: VICTIM } },
    );

    // 400 and not a partial success: the whole body is refused, so `offers` is
    // not applied either. A handler that ignored unknown keys instead would have
    // written the switch and quietly discarded the id — the same outcome here,
    // but only by luck, and no test would notice the day someone read the id.
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error).toBe('not_editable');
    expect(res.body.message, 'the refusal does not name the key it refused').toContain('memberId');
    expect(consentTrail(MEMBER), 'the refused body still recorded a consent event').toEqual([]);
    expect(preferenceColumns(VICTIM), 'another member\'s row moved').toEqual(before);
  });
});

describe('`offers` is marketing consent, so it is an EVENT and not a column (non-negotiable #8)', () => {
  beforeEach(freshRows);

  it('granting it appends an event carrying when, where and under which terms', async () => {
    const res = await treq<NotificationView>('PATCH', '/members/me/notifications', {
      token: member,
      body: { offers: true },
    });
    expect(res.status, res.raw).toBe(200);

    expect(res.body.offers).toBe(true);
    expect(res.body.offersConsent.granted).toBe(true);
    expect(res.body.offersConsent.at, 'a grant with no timestamp').toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // `wallet_account` and not `signup`: a cap auditing a send has to know she
    // chose it on the Account screen rather than inheriting it at registration.
    expect(res.body.offersConsent.source).toBe('wallet_account');
    // The terms in force for her. The privacy policy is the document the consent
    // is given under, and it is republishable.
    expect(res.body.offersConsent.policyVersion).toBe(3);

    // The row, not the response. This is what the platform send path reads.
    expect(consentTrail(MEMBER)).toEqual([
      { granted: true, source: 'wallet_account', policyVersion: 3 },
    ]);
  });

  it('there is no `offers` column at all, so the boolean CANNOT fall out of step with the trail', () => {
    /**
     * services/consent.ts rests its whole argument on this: "There is no cached
     * boolean to fall out of step with the trail." That is a claim about the
     * schema, and it is the kind of claim that stops being true the first time
     * somebody adds a column for a query that felt slow. Asserted against
     * `information_schema` rather than against the response, because a cached
     * column would serve an identical response right up until the day it drifted.
     */
    const offersColumns = scalar(
      `select coalesce(string_agg(column_name, ', ' order by column_name), '')
         from information_schema.columns
        where table_name = 'member' and column_name like '%offer%'`,
    );
    expect(
      offersColumns,
      'a member column now caches the offers answer. The response would look identical and the ' +
        'send path would read one of the two, so the day they disagree is the day a customer who ' +
        'turned offers off receives a campaign. The state is derived from the newest event.',
    ).toBe('');
  });

  it('re-sending the SAME answer changes nothing — a re-render is not consenting again', async () => {
    const first = await treq<NotificationView>('PATCH', '/members/me/notifications', {
      token: member,
      body: { offers: true },
    });
    precondition(first.status === 200, `the first grant answered ${first.status} ${first.raw}`);
    const firstAt = first.body.offersConsent.at;

    const again = await treq<NotificationView>('PATCH', '/members/me/notifications', {
      token: member,
      body: { offers: true },
    });
    expect(again.status, again.raw).toBe(200);
    expect(
      again.body.offersConsent.at,
      'the second identical PATCH moved the consent timestamp. A client re-rendering the Account ' +
        'screen is not the customer agreeing again, and a trail full of duplicate grants makes ' +
        'the moment she actually agreed harder to find rather than easier.',
    ).toBe(firstAt);

    expect(consentTrail(MEMBER), 'an identical answer appended a second event').toHaveLength(1);
  });

  it('withdrawing it APPENDS a withdrawal — the grant is still in the trail afterwards', async () => {
    const granted = await treq('PATCH', '/members/me/notifications', {
      token: member,
      body: { offers: true },
    });
    precondition(granted.status === 200, `the grant answered ${granted.status} ${granted.raw}`);

    const withdrawn = await treq<NotificationView>('PATCH', '/members/me/notifications', {
      token: member,
      body: { offers: false },
    });
    expect(withdrawn.status, withdrawn.raw).toBe(200);
    expect(withdrawn.body.offers).toBe(false);
    expect(withdrawn.body.offersConsent.granted).toBe(false);
    // Not null. A withdrawal is a fact with a time, not the absence of a grant —
    // and `at` reverting to null would make her indistinguishable from a member
    // who has never been asked.
    expect(withdrawn.body.offersConsent.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(
      consentTrail(MEMBER),
      'the withdrawal replaced the grant instead of following it. "She turned it on in August ' +
        'and off in October" is the history a regulator asks for, and an UPDATE erases it.',
    ).toEqual([
      { granted: true, source: 'wallet_account', policyVersion: 3 },
      { granted: false, source: 'wallet_account', policyVersion: 3 },
    ]);
  });

  it('a consent change is written down under Access, and an unchanged answer is not', async () => {
    const before = auditCount(MEMBER, 'Marketing consent given');
    const withdrawalsBefore = auditCount(MEMBER, 'Marketing consent withdrawn');

    const granted = await treq('PATCH', '/members/me/notifications', {
      token: member,
      body: { offers: true },
    });
    precondition(granted.status === 200, `the grant answered ${granted.status} ${granted.raw}`);
    expect(auditCount(MEMBER, 'Marketing consent given')).toBe(before + 1);

    // The same answer again: no event, and so no audit row either. The two have
    // to agree, or the log and the trail tell different stories about one screen.
    const again = await treq('PATCH', '/members/me/notifications', {
      token: member,
      body: { offers: true },
    });
    precondition(again.status === 200, `the repeat answered ${again.status} ${again.raw}`);
    expect(
      auditCount(MEMBER, 'Marketing consent given'),
      'an unchanged answer still wrote an audit row, so the log disagrees with the consent trail',
    ).toBe(before + 1);

    const withdrawn = await treq('PATCH', '/members/me/notifications', {
      token: member,
      body: { offers: false },
    });
    precondition(withdrawn.status === 200, `the withdrawal answered ${withdrawn.status}`);
    expect(auditCount(MEMBER, 'Marketing consent withdrawn')).toBe(withdrawalsBefore + 1);

    // And the row must not carry the customer's contact details as "detail".
    const detail = scalar(
      `select coalesce(detail,'') from audit_log
        where subject_id='${MEMBER}' and action='Marketing consent withdrawn'
        order by seq desc limit 1`,
    );
    expect(detail).toContain('policy v3');
    expect(detail, 'the audit row carries her phone number').not.toContain(MEMBER_PHONE);
  });

  it('and the trail cannot be rewritten — UPDATE and TRUNCATE are refused to the OWNER too', async () => {
    const granted = await treq('PATCH', '/members/me/notifications', {
      token: member,
      body: { offers: true },
    });
    precondition(granted.status === 200, `the grant answered ${granted.status} ${granted.raw}`);
    precondition(consentTrail(MEMBER).length === 1, 'there is no event to attempt this against');

    /**
     * `SET ROLE` rather than a second connection, the construction `scanner.test.ts`
     * uses on `audit_log`: the privilege check runs as `avo_app` on a connection
     * `psql()` already has, so what comes back is Postgres refusing rather than a
     * test asserting that a grant table looks right.
     */
    const asApp = (statement: string): string => {
      try {
        psql(`SET ROLE avo_app; ${statement}`);
        return '';
      } catch (err) {
        return String((err as Error).message);
      }
    };
    const asOwner = (statement: string): string => {
      try {
        psql(statement);
        return '';
      } catch (err) {
        return String((err as Error).message);
      }
    };

    // The application role: refused by the grants (migration 0020).
    expect(
      asApp(`UPDATE member_consent_event SET granted = false WHERE member_id='${MEMBER}';`),
      'the application role can UPDATE member_consent_event. A consent trail the application can ' +
        'rewrite is not evidence of anything, and this table exists to be evidence.',
    ).toMatch(/permission denied/i);
    expect(
      asApp(`DELETE FROM member_consent_event WHERE member_id='${MEMBER}';`),
      'the application role can DELETE from member_consent_event',
    ).toMatch(/permission denied/i);

    /**
     * AND THE OWNER, which is what migration 0023 added and what 0020 only claimed.
     * 0020 said it gave this table "the same treatment `audit_log` gets"; it gave it
     * half — a REVOKE and no trigger — so the owner could still rewrite a consent
     * record silently. UPDATE and TRUNCATE are now refused to everybody.
     *
     * TRUNCATE matters on its own: it is not reachable through a cascade, because
     * `TRUNCATE member CASCADE` would have to name this table and no code does, and
     * it is the one statement that could empty the table without deleting a single
     * member.
     */
    expect(
      asOwner(`UPDATE member_consent_event SET granted = false WHERE member_id='${MEMBER}';`),
      'the database OWNER can edit a consent record, so "she agreed" can be written after the ' +
        'fact by anybody with the owner connection',
    ).toMatch(/append-only/i);
    expect(
      asOwner('TRUNCATE member_consent_event;'),
      'the OWNER can TRUNCATE member_consent_event — the one statement that empties the trail ' +
        'without erasing a single customer',
    ).toMatch(/append-only/i);

    // Still exactly one row, and still a grant.
    expect(consentTrail(MEMBER)).toEqual([
      { granted: true, source: 'wallet_account', policyVersion: 3 },
    ]);
  });

  /**
   * AND DELETE IS DELIBERATELY *NOT* REFUSED, WHICH IS THE HALF A CARELESS SPEC
   * WOULD GET BACKWARDS.
   *
   * "Append-only like `audit_log`" is the wrong model and this spec exists to stop
   * anybody restoring it. `member_consent_event.member_id` is `ON DELETE CASCADE`
   * from `member`, whereas `audit_log`'s salon FK is `RESTRICT`. A DELETE trigger
   * here makes the cascade fail, which makes `DELETE FROM member` fail, which makes
   * the 30-day erasure the published privacy policy promises IMPOSSIBLE. Migration
   * 0023 records the exact error it saw when it tried.
   *
   * So the trail must be destructible by exactly one route — erasing the whole
   * person — and by no other. A spec demanding DELETE be refused would be demanding
   * that the privacy policy be breakable, and it would look like the more rigorous
   * spec while doing it.
   *
   * HER OWN DISPOSABLE MEMBER, because this really does delete a row: a member with
   * transactions cannot be deleted at all (`transaction` is RESTRICT), which is the
   * whole reason deletion is an erasure of personal data rather than a DELETE.
   */
  it('but the CASCADE still works — a consent row cannot outlive the customer it is about', async () => {
    const doomed = 'QA-ACC-0009';
    psql(`
      INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                          balance_fils, visits, tier, stamps, policy_version)
      SELECT '${doomed}', '${SALON_B}', 'Erasure Fixture', '+96599777309', NULL, false,
             s.password_hash, 0, 0, 'bronze', NULL, 3
      FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
      VALUES ('${doomed}', '${SALON_B}', 'marketing_offers', true, 'signup', 3);
    `);
    precondition(consentTrail(doomed).length === 1, 'the fixture has no consent row to cascade');

    // The erasure the privacy policy promises. It must succeed.
    let failure = '';
    try {
      psql(`DELETE FROM member WHERE id='${doomed}';`);
    } catch (err) {
      failure = String((err as Error).message);
    }
    expect(
      failure,
      'DELETING A MEMBER FAILED, and if the reason is a trigger on member_consent_event then the ' +
        '30-day erasure this product has published in a legal document cannot be carried out at ' +
        'all. Migration 0023 leaves DELETE to the cascade for exactly this reason. Do not "fix" ' +
        'this by adding a DELETE trigger.',
    ).toBe('');

    expect(
      consentTrail(doomed),
      'the member was erased and her consent rows survived her, so the trail outlived the ' +
        'customer it is about',
    ).toEqual([]);
  });
});

describe('account deletion — a state with a clock, and the clock must not be nudged', () => {
  beforeEach(freshRows);

  it('the wrong password is refused and NOTHING starts — no clock, no audit row', async () => {
    setBalance(MEMBER, 0);
    const auditBefore = auditCount(MEMBER, 'Account deletion requested');

    const res = await treq<{ error?: string; message?: string }>('POST', '/members/me/deletion', {
      token: member,
      body: { password: 'not-my-password' },
    });
    expect(res.status, res.raw).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
    expect(res.body.message).toBe('That password does not match.');

    /**
     * The session alone is not enough for this one, and the reason is the threat
     * it is written against: an unlocked handset on a salon counter. So the
     * refusal has to be TOTAL — a 401 that had already stamped the row would give
     * whoever picked the phone up the outcome anyway.
     */
    expect(deletionColumns(MEMBER)).toEqual({ requestedAt: '', dueAt: '' });
    expect(auditCount(MEMBER, 'Account deletion requested')).toBe(auditBefore);

    // And the refusal never echoes the attempt back.
    expect(res.raw).not.toContain('not-my-password');
  });

  it('credit in the wallet refuses the request, in integer fils, and names the amount', async () => {
    setBalance(MEMBER, 24_500);

    const res = await treq<{ error?: string; balanceFils?: number }>(
      'POST',
      '/members/me/deletion',
      { token: member, body: { password: PASSWORD } },
    );
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error).toBe('balance_outstanding');

    /**
     * Non-negotiable #1 and #5 together. Her balance is prepaid credit the salon
     * owes her and every refund is wallet credit, so erasing the account that
     * NAMES the money while the money is still owed is the one outcome nobody can
     * undo. The amount is in the refusal because the way out is "spend it or ask
     * the salon", and a customer cannot act on "you have a balance".
     */
    expect(res.body.balanceFils).toBe(24_500);
    expect(
      Number.isInteger(res.body.balanceFils),
      'the outstanding balance is not integer fils',
    ).toBe(true);
    // 24.5 is what a float would look like here, and it would type-check nowhere
    // except on the wire.
    expect(res.raw, 'the balance was serialised as a decimal').not.toContain('24.5');

    expect(deletionColumns(MEMBER), 'a refused request still started the clock').toEqual({
      requestedAt: '',
      dueAt: '',
    });
  });

  it('at zero balance the request is accepted, and the due date is exactly 30 days out', async () => {
    setBalance(MEMBER, 0);

    const res = await treq<DeletionView>('POST', '/members/me/deletion', {
      token: member,
      body: { password: PASSWORD },
    });
    expect(res.status, res.raw).toBe(200);

    expect(res.body.status).toBe('pending');
    expect(res.body.graceDays).toBe(30);
    /**
     * `erasureScheduled: false` is the honest field, and the one a reader is most
     * likely to "tidy away". The clock is real and the state is real; the job that
     * does the erasing is not built, because which columns are nulled at the due
     * date and which survive the 7-year financial record is the client's retention
     * decision. A confirmation screen that said otherwise would be untrue.
     */
    expect(
      res.body.erasureScheduled,
      'the API now claims an erasure is scheduled. If the job exists, this spec should be ' +
        'rewritten around it; if it does not, the confirmation screen is saying something untrue.',
    ).toBe(false);

    expect(res.body.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.erasureDueAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 30 days is the number the privacy policy publishes and the wallet's copy
    // repeats, so it is asserted as an exact interval and not as "about a month".
    const span = Date.parse(res.body.erasureDueAt!) - Date.parse(res.body.requestedAt!);
    expect(span, `erasureDueAt is ${span}ms after requestedAt, not 30 days`).toBe(30 * 86_400_000);

    // The clock is on the row the eventual job will read, not only in the reply.
    const columns = deletionColumns(MEMBER);
    expect(columns.requestedAt, 'the request was acknowledged and not recorded').not.toBe('');
    expect(columns.dueAt).not.toBe('');
  });

  it('asking twice is one request — a mis-tapped button must not extend the 30 days', async () => {
    setBalance(MEMBER, 0);
    const auditBefore = auditCount(MEMBER, 'Account deletion requested');

    const first = await treq<DeletionView>('POST', '/members/me/deletion', {
      token: member,
      body: { password: PASSWORD },
    });
    precondition(first.status === 200, `the first request answered ${first.status} ${first.raw}`);
    const columnsAfterFirst = deletionColumns(MEMBER);

    const second = await treq<DeletionView>('POST', '/members/me/deletion', {
      token: member,
      body: { password: PASSWORD },
    });
    expect(second.status, second.raw).toBe(200);
    expect(
      second.body.requestedAt,
      'the second request restarted the clock. A double tap would then quietly buy 30 more days, ' +
        'and the customer would be told the same thing both times.',
    ).toBe(first.body.requestedAt);
    expect(second.body.erasureDueAt).toBe(first.body.erasureDueAt);
    expect(deletionColumns(MEMBER)).toEqual(columnsAfterFirst);

    // One request, one audit row. Non-negotiable #4's reasoning applied to a
    // non-money POST: the second call is the same request, so it is not an event.
    expect(
      auditCount(MEMBER, 'Account deletion requested'),
      'the idempotent replay wrote a second audit row, so the log says she asked twice',
    ).toBe(auditBefore + 1);
  });

  it('her session survives the request, deliberately — the grace window has to be reachable', async () => {
    setBalance(MEMBER, 0);

    const requested = await treq('POST', '/members/me/deletion', {
      token: member,
      body: { password: PASSWORD },
    });
    precondition(requested.status === 200, `the request answered ${requested.status}`);

    /**
     * The opposite of the password change, which revokes every OTHER session on
     * purpose. Here nothing is revoked, and that is the design: the 30 days are a
     * grace window, and an account she is locked out of the moment she asks is one
     * she cannot change her mind about. If this ever starts returning 401, the
     * cancel below becomes unreachable and the window is decorative.
     */
    const stillIn = await treq('GET', '/members/me', { token: member });
    expect(
      stillIn.status,
      'the deletion request signed her out, so she cannot reach the cancel that the 30-day ' +
        'grace window exists to give her',
    ).toBe(200);

    // And she can still sign in fresh, not merely continue on an old token.
    const reSignedIn = await treq<{ accessToken?: string }>('POST', '/auth/member/session', {
      token: null,
      body: { salonId: SALON_B, phone: MEMBER_PHONE, password: PASSWORD },
    });
    expect(reSignedIn.status, reSignedIn.raw).toBe(200);
  });

  it('cancelling clears the clock and says so in the same five keys', async () => {
    setBalance(MEMBER, 0);
    const auditBefore = auditCount(MEMBER, 'Account deletion cancelled');
    const requested = await treq('POST', '/members/me/deletion', {
      token: member,
      body: { password: PASSWORD },
    });
    precondition(requested.status === 200, `the request answered ${requested.status}`);

    // No body, and therefore NO `content-type` header — which is what the real
    // client sends. A body-less request that declares `application/json` makes
    // Fastify answer 400 before the handler runs, and a suite that sent one would
    // be testing its own HTTP client.
    const res = await treq<DeletionView>('DELETE', '/members/me/deletion', { token: member });
    expect(res.status, res.raw).toBe(200);

    expect(res.body.status).toBe('none');
    expect(res.body.requestedAt).toBeNull();
    expect(res.body.erasureDueAt).toBeNull();
    // The two constants do not become meaningless because the state went back to
    // none — the screen still renders "removed within 30 days" beside the button.
    expect(res.body.graceDays).toBe(30);
    expect(res.body.erasureScheduled).toBe(false);

    expect(deletionColumns(MEMBER)).toEqual({ requestedAt: '', dueAt: '' });
    expect(auditCount(MEMBER, 'Account deletion cancelled')).toBe(auditBefore + 1);
  });

  it('and cancelling a request that does not exist is a 404, not a silent success', async () => {
    const auditBefore = auditCount(MEMBER, 'Account deletion cancelled');
    const res = await treq<{ error?: string }>('DELETE', '/members/me/deletion', { token: member });
    expect(res.status, res.raw).toBe(404);
    expect(res.body.error).toBe('no_deletion_request');
    // A 404 that logged a cancellation would put an event in the audit log that
    // never happened, on the one screen where the log is the customer's evidence.
    expect(auditCount(MEMBER, 'Account deletion cancelled')).toBe(auditBefore);
  });

  it('both mutating handlers write an audit row, and audit_log refuses to give it back', async () => {
    setBalance(MEMBER, 0);
    const requestedBefore = auditCount(MEMBER, 'Account deletion requested');
    const cancelledBefore = auditCount(MEMBER, 'Account deletion cancelled');
    const requested = await treq('POST', '/members/me/deletion', {
      token: member,
      body: { password: PASSWORD },
    });
    precondition(requested.status === 200, `the request answered ${requested.status}`);
    const cancelled = await treq('DELETE', '/members/me/deletion', { token: member });
    precondition(cancelled.status === 200, `the cancel answered ${cancelled.status}`);

    expect(auditCount(MEMBER, 'Account deletion requested')).toBe(requestedBefore + 1);
    expect(auditCount(MEMBER, 'Account deletion cancelled')).toBe(cancelledBefore + 1);

    // Both halves this time, because `audit_log` claims both: the grants stop the
    // application role and the trigger stops even the owner.
    const attempt = (prefix: string, statement: string): string => {
      try {
        psql(`${prefix}${statement}`);
        return '';
      } catch (err) {
        return String((err as Error).message);
      }
    };
    const rows = `WHERE subject_id='${MEMBER}' AND action LIKE 'Account deletion%'`;

    expect(
      attempt('SET ROLE avo_app; ', `DELETE FROM audit_log ${rows};`),
      'the application role can DELETE the deletion audit rows',
    ).toMatch(/permission denied/i);
    expect(
      attempt('SET ROLE avo_app; ', `UPDATE audit_log SET action='edited' ${rows};`),
      'the application role can UPDATE the deletion audit rows',
    ).toMatch(/permission denied/i);
    expect(
      attempt('', `DELETE FROM audit_log ${rows};`),
      'the database OWNER can delete the deletion audit rows, so append-only is a grant and not ' +
        'a rule',
    ).toMatch(/append-only/i);
    expect(
      attempt('', `UPDATE audit_log SET action='edited' ${rows};`),
      'the database OWNER can edit the deletion audit rows',
    ).toMatch(/append-only/i);
    /**
     * AND TRUNCATE, WHICH IS NEITHER OF THE ABOVE. A `BEFORE … FOR EACH ROW`
     * trigger never fires for TRUNCATE, because TRUNCATE produces no row events —
     * so a table can refuse every UPDATE and every DELETE and still be emptied by
     * one statement. `audit_log` has had the statement-level trigger since 0001;
     * `ledger_entry` and `gateway_event` had only two triggers until 0024, and
     * `TRUNCATE ledger_entry` really did return "TRUNCATE TABLE" and leave every
     * balance a number with no derivation behind it.
     *
     * Asserted here because this file's whole argument is that the deletion trail
     * cannot be trimmed, and "cannot be trimmed" that stops at DELETE is not the
     * claim it sounds like.
     */
    expect(
      attempt('', 'TRUNCATE audit_log;'),
      'audit_log can be TRUNCATEd. Refusing UPDATE and DELETE is not enough — a row-level ' +
        'trigger never fires for TRUNCATE, so one statement empties the log that is the ' +
        'customer\'s evidence.',
    ).toMatch(/append-only/i);

    // Four refused attempts later, both rows are still exactly where they were.
    expect(auditCount(MEMBER, 'Account deletion requested')).toBe(requestedBefore + 1);
    expect(auditCount(MEMBER, 'Account deletion cancelled')).toBe(cancelledBefore + 1);
  });

  /**
   * THE HOLE I REPORTED, NOW CLOSED — AND THE SPEC IS ABOUT THE TRANSACTION.
   *
   * The balance check on `POST /members/me/deletion` runs once, at request time.
   * Nothing stopped her topping up afterwards, so `deletion_requested_at` over a
   * positive `balance_fils` was reachable: the exact state the 409 exists to
   * prevent, arrived at from the other direction, with an erasure job due to run on
   * an account holding money the salon owes her.
   *
   * The fix cancels the deletion IN THE SAME TRANSACTION as the credit, on the
   * member row already held FOR UPDATE — so there is no window in which the money
   * has landed and the clock is still running. That is non-negotiable #3's reasoning
   * applied to a state rather than to money, and it is what this spec checks: not
   * "both things eventually happened" but "there is no ordering in which one
   * happened without the other".
   */
  it('a top-up on a member with a pending deletion CANCELS it, in the same transaction as the credit', async () => {
    setBalance(MEMBER, 0);
    const requested = await treq<DeletionView>('POST', '/members/me/deletion', {
      token: member,
      body: { password: PASSWORD },
    });
    precondition(requested.status === 200, `the request answered ${requested.status} ${requested.raw}`);
    precondition(deletionColumns(MEMBER).requestedAt !== '', 'no clock was started to cancel');
    const cancelsBefore = auditCount(MEMBER, 'Account deletion cancelled');

    const topup = await treq<any>('POST', '/topups', {
      token: member,
      idempotencyKey: `acct-deletion-topup-${Date.now()}`,
      body: { amountFils: 10_000, method: 'knet' },
    });
    precondition(topup.status === 200, `POST /topups answered ${topup.status} ${topup.raw}`);
    const ref = /\/_gateway\/([^/?#]+)/.exec(topup.body.redirectUrl ?? '')?.[1];
    precondition(Boolean(ref), `no sandbox gateway ref in ${topup.body.redirectUrl}`);

    const settled = await treq('POST', `/_gateway/${ref}`, {
      token: null,
      body: { outcome: 'succeeded', notify: true },
    });
    precondition(settled.status === 200, `the gateway settle answered ${settled.status}`);

    // The money landed AND the clock stopped. Both, or the state this closes is
    // still reachable.
    expect(
      Number(scalar(`select balance_fils from member where id='${MEMBER}'`)),
      'the top-up did not credit her',
    ).toBeGreaterThan(0);
    expect(
      deletionColumns(MEMBER),
      'her balance is positive and the deletion clock is STILL RUNNING. That is the state the 409 ' +
        'refuses to create, reached from the other side, with an erasure due on an account holding ' +
        'credit the salon owes her.',
    ).toEqual({ requestedAt: '', dueAt: '' });

    // And the read agrees, because the wallet renders the banner from it.
    const state = await treq<DeletionView>('GET', '/members/me/deletion', { token: member });
    expect(state.status, state.raw).toBe(200);
    expect(state.body.status).toBe('none');

    expect(auditCount(MEMBER, 'Account deletion cancelled')).toBe(cancelsBefore + 1);
  });

  it('and that cancellation is attributed to the SYSTEM, not to a button she never saw', async () => {
    setBalance(MEMBER, 0);
    const requested = await treq('POST', '/members/me/deletion', {
      token: member,
      body: { password: PASSWORD },
    });
    precondition(requested.status === 200, `the request answered ${requested.status}`);

    const topup = await treq<any>('POST', '/topups', {
      token: member,
      idempotencyKey: `acct-deletion-attrib-${Date.now()}`,
      body: { amountFils: 5_000, method: 'knet' },
    });
    precondition(topup.status === 200, `POST /topups answered ${topup.status} ${topup.raw}`);
    const ref = /\/_gateway\/([^/?#]+)/.exec(topup.body.redirectUrl ?? '')?.[1];
    precondition(Boolean(ref), 'no sandbox gateway ref');
    const settled = await treq('POST', `/_gateway/${ref}`, {
      token: null,
      body: { outcome: 'succeeded', notify: true },
    });
    precondition(settled.status === 200, `the gateway settle answered ${settled.status}`);

    const row = scalar(
      `select actor_kind || '|' || coalesce(actor_id,'') || '|' || (metadata ->> 'reason')
         from audit_log
        where subject_id='${MEMBER}' and action='Account deletion cancelled'
        order by seq desc limit 1`,
    );
    const [actorKind, actorId, reason] = row.split('|');

    /**
     * `system`, and the reasoning is worth keeping because it is easy to "improve"
     * this into a lie. This path runs from the PSP WEBHOOK as often as from the
     * client, so there is frequently no session behind it — and naming her as the
     * actor would assert she pressed a cancel button she never saw. She has not
     * been told; the row says the system did it on her money's behalf.
     */
    expect(
      actorKind,
      'the automatic cancellation is attributed to the customer. She never saw a cancel button — ' +
        'this can run from the PSP webhook with no session at all — so naming her as the actor is ' +
        'the audit log asserting something that did not happen.',
    ).toBe('system');
    expect(actorId, 'a system actor should not carry a staff or member id').toBe('');
    expect(reason).toBe('topup_after_deletion_request');
  });

  it('a top-up with NO pending deletion writes no cancellation row — the trail records events, not code paths', async () => {
    setBalance(MEMBER, 0);
    precondition(
      deletionColumns(MEMBER).requestedAt === '',
      'this spec needs her with no pending deletion',
    );
    const cancelsBefore = auditCount(MEMBER, 'Account deletion cancelled');

    const topup = await treq<any>('POST', '/topups', {
      token: member,
      idempotencyKey: `acct-deletion-none-${Date.now()}`,
      body: { amountFils: 5_000, method: 'knet' },
    });
    precondition(topup.status === 200, `POST /topups answered ${topup.status} ${topup.raw}`);
    const ref = /\/_gateway\/([^/?#]+)/.exec(topup.body.redirectUrl ?? '')?.[1];
    precondition(Boolean(ref), 'no sandbox gateway ref');
    const settled = await treq('POST', `/_gateway/${ref}`, {
      token: null,
      body: { outcome: 'succeeded', notify: true },
    });
    precondition(settled.status === 200, `the gateway settle answered ${settled.status}`);

    expect(
      auditCount(MEMBER, 'Account deletion cancelled'),
      'a top-up on a member with nothing to cancel still wrote "Account deletion cancelled". The ' +
        'audit log is the record of what HAPPENED to her, not of which branches the code took, ' +
        'and a cancellation of a request that never existed is a sentence nobody can act on.',
    ).toBe(cancelsBefore);
  });

  it('and no response on this screen carries a credential, at any nesting (non-negotiable #6)', async () => {
    setBalance(MEMBER, 0);
    const responses = [
      await treq('GET', '/members/me/notifications', { token: member }),
      await treq('PATCH', '/members/me/notifications', { token: member, body: { offers: true } }),
      await treq('POST', '/members/me/deletion', { token: member, body: { password: PASSWORD } }),
      await treq('DELETE', '/members/me/deletion', { token: member }),
    ];
    for (const res of responses) {
      for (const smell of ['passwordHash', 'password_hash', 'password', '$argon2', PASSWORD]) {
        expect(res.raw, `a response on this screen leaked ${smell}`).not.toContain(smell);
      }
    }
  });
});

// ===========================================================================
// SCOPE. Five routes that are member-only, called with every other kind of
// credential this API issues. Four when this block was written; lane A's
// `GET /members/me/deletion` made it five, and it cost one entry in `calls`
// because the matrix is generated rather than written out per route.
//
// This project has already shipped a browser session that could debit a wallet —
// `requireStaff`'s `surface` parameter exists because that check ran in one
// direction only — so "the endpoint reads `requireMember`" is a claim to be
// tested, not a reason not to test. A PIN session and a web session are two
// DIFFERENT wrong credentials here, and they fail through different code, so
// both are called directly.
// ===========================================================================

describe('the five member routes are member-scoped, and every other credential is refused', () => {
  let web = '';
  let pin = '';

  beforeAll(async () => {
    web = await signInDashboard(SALON_B, B_STAFF_HANDLE);
    pin = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
  }, 60_000);

  beforeEach(freshRows);

  /** The four calls, as a real client makes them. Reused per credential. */
  const calls: Array<{ name: string; run: (token: string) => Promise<{ status: number; raw: string }> }> = [
    {
      name: 'GET /members/me/notifications',
      run: (token) => treq('GET', '/members/me/notifications', { token }),
    },
    {
      name: 'PATCH /members/me/notifications',
      run: (token) => treq('PATCH', '/members/me/notifications', { token, body: { offers: true } }),
    },
    {
      // Arrived in lane A's 540b3f1, after the other four. The contract guard's
      // AWAITING_MERGE note said to add it here on merge, and this is that.
      name: 'GET /members/me/deletion',
      run: (token) => treq('GET', '/members/me/deletion', { token }),
    },
    {
      name: 'POST /members/me/deletion',
      run: (token) => treq('POST', '/members/me/deletion', { token, body: { password: PASSWORD } }),
    },
    {
      name: 'DELETE /members/me/deletion',
      run: (token) => treq('DELETE', '/members/me/deletion', { token }),
    },
  ];

  for (const surface of [
    {
      label: 'a dashboard web session',
      token: () => web,
      why:
        'a web session is long-lived, browser-based and refreshable for thirty days. It is the ' +
        'credential that could already debit a wallet once.',
    },
    {
      label: 'a scanner PIN session',
      token: () => pin,
      why:
        'a PIN belongs on the salon counter. Salon staff reading or writing a customer\'s ' +
        'marketing consent — or starting the erasure of her account — is not an under-privileged ' +
        'action, it is the wrong kind of key entirely.',
    },
  ]) {
    for (const call of calls) {
      it(`${call.name} refuses ${surface.label}`, async () => {
        const before = { ...preferenceColumns(MEMBER), ...deletionColumns(MEMBER) };

        const res = await call.run(surface.token());
        expect(
          res.status,
          `${call.name} answered ${res.status} to ${surface.label}. ${surface.why}\n${res.raw}`,
        ).toBe(403);
        expect(res.raw, 'the refusal does not say whose endpoint this is').toContain('customers');

        // A 403 that had already written is not a refusal. And nothing must have
        // been resolved either: a staff principal reaching this handler at all
        // would have to be resolved to SOME member first, and whichever one it
        // picked would be somebody's row.
        expect({ ...preferenceColumns(MEMBER), ...deletionColumns(MEMBER) }).toEqual(before);
      });
    }
  }

  it('a forged bearer token is a 401 on all four — the token path never falls back to the test shim', async () => {
    /**
     * WHY THIS AND NOT AN ANONYMOUS REQUEST.
     *
     * `AVO_TEST_PRINCIPALS` is on in this harness, and under it a request with NO
     * Authorization header is not anonymous: `testPrincipalFor` resolves anything
     * under `/members/` to a seeded member. So an anonymous probe here would be
     * testing the shim, not the API.
     *
     * A GARBAGE BEARER IS THE HONEST PROBE, and it is also the more interesting
     * one: `resolvePrincipal` takes the bearer branch the moment a header is
     * present, and the shim is unreachable from there. If a malformed token ever
     * fell through to the shim, every one of these would answer 200 as a real
     * seeded customer.
     */
    for (const call of calls) {
      const res = await call.run('not.a.real.token');
      expect(res.status, `${call.name} accepted a forged bearer: ${res.raw}`).toBe(401);
    }
  });

  it('and the password gate stands even when a principal is handed over for free', async () => {
    /**
     * The one assertion worth making about the shim rather than around it.
     *
     * With `AVO_TEST_PRINCIPALS` on, an unauthenticated `POST /members/me/deletion`
     * arrives holding a real member principal. It is still refused, because the
     * password is a SECOND factor and not a restatement of the session — the same
     * reasoning that makes `POST /members/me/password` demand `current`. That is
     * what stops the most destructive endpoint in the wallet from being reachable
     * by anyone who can reach the port.
     */
    const res = await treq<{ error?: string }>('POST', '/members/me/deletion', {
      token: null,
      body: {},
    });
    expect(
      res.status,
      `an unauthenticated deletion request answered ${res.status}: ${res.raw}`,
    ).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });
});

// ===========================================================================
// TENANCY. One customer's session against another customer's row.
// ===========================================================================

describe('one member cannot read or write another member\'s notifications or deletion state', () => {
  beforeEach(freshRows);

  it('each session reads HER OWN preferences — two members, two different answers', async () => {
    /**
     * The bug class this is written against shipped on this project once already:
     * a dashboard showed one staff member the previous user's figures. A read that
     * is keyed on anything but the calling principal — a cache, a module-level
     * variable, a header — passes every single-user test there is.
     *
     * The victim is seeded with all four switches OFF and the member with all four
     * ON, so the two answers cannot be confused for each other and neither is the
     * column default.
     */
    const mine = await treq<NotificationView>('GET', '/members/me/notifications', {
      token: member,
    });
    const hers = await treq<NotificationView>('GET', '/members/me/notifications', {
      token: victim,
    });
    expect(mine.status, mine.raw).toBe(200);
    expect(hers.status, hers.raw).toBe(200);

    expect(mine.body.push).toBe(true);
    expect(mine.body.receipt).toBe(true);
    expect(hers.body.push, 'the second session was served the first member\'s row').toBe(false);
    expect(hers.body.receipt).toBe(false);

    // Interleaved, in case the leak is a cache filled by whoever asked first.
    const mineAgain = await treq<NotificationView>('GET', '/members/me/notifications', {
      token: member,
    });
    expect(mineAgain.body.push, 'the second session\'s read changed the first\'s answer').toBe(true);
  });

  it('a query parameter naming another member is ignored, not honoured', async () => {
    const before = preferenceColumns(VICTIM);

    // `?memberId=` is the cheapest possible attempt and the one a broken handler
    // would honour: `scenariosOf` already reads `req.query.scenario`, so query
    // parameters are not inert on this API.
    const res = await treq<NotificationView>(
      'PATCH',
      `/members/me/notifications?memberId=${VICTIM}`,
      { token: member, body: { offers: true } },
    );
    expect(res.status, res.raw).toBe(200);

    // It wrote HER OWN consent, which is correct — the parameter is noise.
    expect(consentTrail(MEMBER)).toHaveLength(1);
    expect(
      consentTrail(VICTIM),
      'a query parameter redirected a consent event onto another member. `offers` is marketing ' +
        'consent, so this is a campaign arriving at somebody who never agreed to one.',
    ).toEqual([]);
    expect(preferenceColumns(VICTIM)).toEqual(before);
  });

  it('there is no by-id route to reach another member\'s notifications through', async () => {
    for (const path of [
      `/members/${VICTIM}/notifications`,
      `/members/${VICTIM}/deletion`,
    ]) {
      const res = await treq('GET', path, { token: member });
      expect(
        res.status,
        `GET ${path} answered ${res.status}. A by-id route on this screen would be a customer ` +
          `reading another customer's row, which is the leak this project has already shipped ` +
          `once at the salon level.\n${res.raw}`,
      ).toBe(404);
    }
  });

  it('and a deletion request naming another member starts HER clock and only hers', async () => {
    setBalance(MEMBER, 0);
    setBalance(VICTIM, 0);
    // A delta, not `toBe(0)`: the last spec in this block makes a LEGITIMATE
    // deletion request as the victim, and an absolute zero here would then depend
    // on the order the specs happen to be declared in.
    const victimAuditBefore = auditCount(VICTIM, 'Account deletion requested');

    /**
     * Both members share the same password hash — `seedSalonB()`'s construction,
     * copied here — so `password` cannot be what stops this. If the handler read
     * `memberId` from the body, the credential check would pass and the victim's
     * 30-day clock would start. That is the whole point of using a hash they
     * share: it removes the accidental defence and leaves only the real one.
     */
    const res = await treq<DeletionView>('POST', '/members/me/deletion', {
      token: member,
      body: { password: PASSWORD, memberId: VICTIM, id: VICTIM },
    });
    expect(res.status, res.raw).toBe(200);

    expect(deletionColumns(MEMBER).requestedAt, 'her own request did not start').not.toBe('');
    expect(
      deletionColumns(VICTIM),
      'a body field started ANOTHER customer\'s account erasure. She was never asked, never ' +
        'authenticated, and the first she would know of it is the account being gone.',
    ).toEqual({ requestedAt: '', dueAt: '' });
    expect(auditCount(VICTIM, 'Account deletion requested')).toBe(victimAuditBefore);

    // And the cancel is hers too: it must not clear a request it did not create.
    const cancelled = await treq('DELETE', `/members/me/deletion?memberId=${VICTIM}`, {
      token: member,
    });
    expect(cancelled.status, cancelled.raw).toBe(200);
    expect(deletionColumns(MEMBER)).toEqual({ requestedAt: '', dueAt: '' });
  });

  it('a member with a pending deletion request cannot be cancelled by another member\'s session', async () => {
    setBalance(VICTIM, 0);
    const hers = await treq('POST', '/members/me/deletion', {
      token: victim,
      body: { password: PASSWORD },
    });
    precondition(hers.status === 200, `the victim's own request answered ${hers.status} ${hers.raw}`);
    const victimClock = deletionColumns(VICTIM);
    precondition(victimClock.requestedAt !== '', 'the victim has no pending request to protect');

    // The other member has none of her own, so a handler that resolved the
    // subject from anywhere but the token would either clear the victim's or 404.
    // A 404 is the correct answer and the victim's clock must be untouched.
    const res = await treq<{ error?: string }>('DELETE', '/members/me/deletion', { token: member });
    expect(res.status, res.raw).toBe(404);
    expect(res.body.error).toBe('no_deletion_request');
    expect(
      deletionColumns(VICTIM),
      'one member\'s cancel cleared another member\'s pending deletion request',
    ).toEqual(victimClock);
  });
});

/**
 * GAP — the parts of this screen whose SHAPE is not a client decision, so they
 * cannot be written as a knownBug without inventing the contract first. Each
 * names what has to be decided before a spec can exist.
 */
describe('GAP: Account behaviour with no contract yet', () => {
  it.todo(
    'POST /members/me/phone-change/{id}/verify — the second half of the challenge pair, including the notice the server sends to the OLD number (lane A)',
  );
  it.todo(
    'accepting a new policy version: the member stamps a version but nothing lets her accept a newer one, so a re-published set has no path to consent (lane A)',
  );
  /**
   * RESOLVED — this said the balance check runs once, so a top-up after a pending
   * request reaches the state the 409 exists to prevent. It did, and it does not
   * now: the top-up cancels the deletion in the same transaction as the credit.
   * Three specs above cover it, including the one that matters most — that the
   * cancellation is attributed to the SYSTEM and not to a button she never saw.
   */
  it.todo(
    'the erasure itself. `erasureScheduled` is false on every response and no job reads `member_deletion_due_idx`, so the 30-day promise in the published privacy policy currently has a clock and no hand. Which columns are nulled at the due date and which survive the 7-year financial record is the client\'s retention decision — CLAUDE.md § Escalate (client)',
  );
  it.todo(
    'nothing lets a member EXPORT her data, which the same privacy policy offers alongside deletion. No endpoint, no design screen, no contract (lane A + product)',
  );
});
