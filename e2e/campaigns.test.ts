/**
 * CAMPAIGNS, THE OWNER CONSOLE'S PRINCIPAL, AND NON-NEGOTIABLE #8.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   cd e2e && ../node_modules/.bin/vitest run campaigns.test.ts
 *
 * Like `tenancy.test.ts`, `scanner.test.ts` and `deposit.test.ts`, this boots lane A's
 * real API against lane D's own per-run Postgres — `support/tenancy-harness.ts` carries
 * the mechanics. It cannot run against `packages/mock`: the mock has no platform
 * principal, no `campaign` table and no send-time enforcement, so every assertion below
 * would either be red or vacuous.
 *
 * =========================================================================
 * WHY THIS FILE EXISTS
 * =========================================================================
 * Non-negotiable #8: "A merchant cannot send a customer message. `POST /campaigns` only
 * creates `pending`. Delivery happens on the platform decision endpoint, and caps and
 * quiet hours are enforced again at send time."
 *
 * Until migration 0028 the FIRST half held only because there was no second half.
 * `POST /campaigns` built an object literal, wrote an audit row and returned the
 * literal — it persisted nothing, so the `status: 'pending'` it hardcoded was true of a
 * value that existed for the length of one HTTP response, and nothing could send
 * because nothing was stored. Trunk counted the other half in `api/src`:
 * `requireApproval` 0 occurrences, `weeklyCapPerCustomer` 0, `monthlyCapPerSalon` 0,
 * `quietFrom` 0. `PlatformMessagingPolicySchema` and `isInQuietHours` were both written
 * and neither was called.
 *
 * All of that now exists and NONE of it had been driven. This file drives it.
 *
 * =========================================================================
 * THE TWO SHAPES OF ENFORCEMENT, WHICH ARE NOT THE SAME SHAPE
 * =========================================================================
 * `services/campaign.ts` treats the three rules differently on purpose, and a spec
 * that expected one behaviour from all three would be wrong about two of them:
 *
 *   QUIET HOURS and the MONTHLY CAP are properties of the CAMPAIGN. Either the whole
 *   send is happening now or it is not — so the campaign is HELD: `held_reason` and
 *   `held_at` are set, `status` STAYS `approved`, a `campaign_held` merchant
 *   notification is raised and an audit row is written. Held, reported, never silently
 *   dropped.
 *
 *   The WEEKLY CAP is a property of the CUSTOMER — "a hard cap across ALL salons". So
 *   the customers over their cap are SKIPPED and everyone else receives it. Holding six
 *   hundred people's campaign because twelve of them are capped would punish the 588 and
 *   would be undeliverable for a reason the merchant cannot see or fix.
 *
 * A HOLD IS NOT A FIFTH STATUS, and that is the fact that makes `heldReason`/`heldAt`
 * load-bearing rather than cosmetic. `CampaignSchema` declares four statuses, and a
 * fifth on the wire is a value every client's `.parse()` rejects — so those two fields
 * are the ONLY thing distinguishing a campaign the platform refused to send from one on
 * its way out. `contract.test.ts` pins their SHAPE on an ordinary campaign; this file
 * pins their VALUES on a campaign that really gets held.
 *
 * =========================================================================
 * TIME, AND WHY NO SPEC HERE HAS A HARDCODED HOUR
 * =========================================================================
 * Quiet hours resolve in the SALON'S zone, not the platform's or this machine's. Salon
 * B is `Asia/Kuwait` (UTC+3, no DST) and this machine runs PKT (UTC+5), two hours
 * AHEAD — so a naive spec written against the local clock is wrong by two hours in the
 * direction that feels safe.
 *
 * Every quiet-hours fixture below is therefore computed from the salon's own current
 * time as a window RELATIVE to it: `quietWindowCovering()` builds one that contains
 * this instant and `quietWindowAvoiding()` one that does not. Both work at every hour
 * of the day, including across midnight, because the shared predicate handles a
 * wrapping window (`from > to`) and a relative window is sometimes one. This suite's
 * predecessor fixed a happy-hour suite that could not pass between 23:00 and 01:00
 * Kuwait by moving the salon's clock rather than clamping the window; this is the same
 * lesson applied before the bug.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  B_MEMBER,
  B_MEMBER_PHONE,
  B_SCANNER_DEVICE,
  B_STAFF_HANDLE,
  PLATFORM_ANALYST_HANDLE,
  PLATFORM_OWNER,
  PLATFORM_OWNER_HANDLE,
  PLATFORM_OWNER_NAME,
  POLICY_MONTHLY_CAP_PER_SALON,
  POLICY_QUIET_FROM,
  POLICY_QUIET_TO,
  POLICY_WEEKLY_CAP_PER_CUSTOMER,
  SALON_B,
  pgDb,
  psql,
  reconcileWalletLedger,
  repoRoot,
  runApiDbScriptResult,
  scalar,
  signInDashboard,
  signInMember,
  signInPlatform,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** The owner console, every section. The control for every refusal below. */
let owner = '';
/** Mariam — analytics and activity only. `approvals` OFF and `policies` OFF. */
let analyst = '';
/** Salon B's manager, all nine merchant permissions. `marketing` included. */
let merchant = '';
/** A scanner session, for the surface probes. */
let scanner = '';
/** Salon B's own customer, signed in for real. */
let walletSession = '';

let n = 0;
const key = (label: string) => `cmp-${label}-${Date.now()}-${n++}`;

/**
 * THREE CAMPAIGN FIXTURE CUSTOMERS AT SALON B, ALL TIER `gold`.
 *
 * WHY A `gold` AUDIENCE AND NOT `all`. `all` would include Fatima (`9001`) the moment
 * any other spec in this suite grants her marketing consent, and the arithmetic below
 * counts recipients exactly — "two received it, one was skipped" is the assertion that
 * distinguishes a working weekly cap from a broken one. An audience whose size depends
 * on what another file did is an assertion that passes or fails on file order.
 *
 * `gold` is `member.tier IN ('gold', 'black')` (`services/campaign.ts`
 * § `GOLD_AND_ABOVE`). Fatima is reset to `bronze` on every run by the harness, and
 * nothing else at salon B is gold — so this audience is exactly these three rows, and it
 * stays that way whatever else runs.
 *
 * CONSENT IS GRANTED FOR ALL THREE, and it has to be seeded here because
 * `resolveAudience` filters the segment through `grantedMarketingConsent` last: salon B
 * has no consent rows at all in the seed, so every audience there is empty and every
 * campaign would be held with "Nobody is in this audience right now" — a hold for the
 * wrong reason, which would make the quiet-hours and cap specs below pass without ever
 * reaching their subject.
 *
 * INSERTED, NEVER UPDATED. `member_consent_event` is append-only for everyone — 0020
 * revokes UPDATE and DELETE from `avo_app`, and 0023 adds triggers that refuse them to
 * the owner too — so this seed is guarded by a `NOT EXISTS` rather than an upsert.
 * A per-run database makes that safe; there is nothing to clean up because there is
 * nothing that can be cleaned up.
 */
const AUD = ['QA-CMP-0001', 'QA-CMP-0002', 'QA-CMP-0003'] as const;

/**
 * A FOURTH CONSENTING CUSTOMER, AND THE ONLY REASON SHE EXISTS IS `lowbal`.
 *
 * The three `AUD` members above are gold with 50.000 KD each, and `LOW_BALANCE_FILS` is
 * 5000 — so before this row the `lowbal` audience at salon B was EMPTY, and a derived
 * spec that submitted it would have been held with "Nobody is in this audience right
 * now" rather than releasing anything. A hold is not a send, and the half of this bug
 * that only a real release can reach is the send.
 *
 * AND THE FIRST DRAFT OF THE SPEC BELOW ASSERTED SHE WAS THE ONLY ONE, WHICH WAS WRONG.
 * It read `expect(c.reach).toBe(1)` on the reasoning that `B_MEMBER` holds
 * `B_MEMBER_BALANCE_FILS` (500.000 KD) and the `AUD` trio 50.000 KD each, so nothing else
 * at salon B could be under 5.000 KD. That passed when this file was run alone and FAILED
 * on the full suite with `expected 2 to be 1`: earlier files create their own consenting
 * customers at salon B and spend balances down, and one of them was under the threshold by
 * the time this file ran. Salon B's member list is not a fact this file owns.
 *
 * Which is the file header's own warning — "an audience whose size depends on what another
 * file did is an assertion that passes or fails on file order" — arriving from the other
 * direction, and it is recorded rather than quietly patched because the fix is the
 * interesting part: the spec no longer counts. It asserts that the recipient set CONTAINS
 * this row, contains NONE of the gold trio, and that every member it reached really is
 * under the threshold, read back off `member.balance_fils`. Those are claims about the
 * PREDICATE rather than about the population, so they are true whatever else has run — and
 * they are strictly stronger than the count they replaced, which a predicate returning
 * every member of a one-customer salon would also have satisfied.
 *
 * BRONZE AND BACK-DATED ON PURPOSE. `bronze` keeps her out of `gold`, so every assertion
 * above that counts `AUD.length` is untouched by her arrival — checked call site by call
 * site. `joined_at` a year back keeps her out of `new`, which makes `new` and `gold` the
 * same three rows and `lowbal` the one row: the audiences DISCRIMINATE against this
 * fixture rather than all resolving to the same set, and a predicate that quietly
 * returned every member of the salon would fail the exact spec instead of passing it.
 */
const LOWBAL = 'QA-CMP-0004';

/**
 * `LOW_BALANCE_FILS` from `api/src/services/campaign.ts`, mirrored because it is private
 * to that module. Mirroring a constant is only acceptable where a divergence FAILS rather
 * than passes quietly, which is the case here: the exact spec below reads recipients'
 * balances against this number, so a threshold that moved in the service turns it red.
 */
const LOW_BALANCE_FILS_MIRROR = 5_000;

/** Under `LOW_BALANCE_FILS_MIRROR` by a wide margin, so no rounding argument can reach it. */
const LOWBAL_BALANCE_FILS = 1_000;

function seedAudience(): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT v.id, '${SALON_B}', v.name, v.phone, NULL, false, s.password_hash,
           50000, 12, 'gold', NULL, 3
      FROM (VALUES ('${AUD[0]}', 'Campaign One',   '+96599778001'),
                   ('${AUD[1]}', 'Campaign Two',   '+96599778002'),
                   ('${AUD[2]}', 'Campaign Three', '+96599778003'))
             AS v(id, name, phone),
           staff_user s
     WHERE s.id = 'ST-001'
    ON CONFLICT (id) DO UPDATE SET tier = 'gold', visits = 12, balance_fils = 50000;

    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version, joined_at)
    SELECT '${LOWBAL}', '${SALON_B}', 'Campaign Low Balance', '+96599778004', NULL, false,
           s.password_hash, ${LOWBAL_BALANCE_FILS}, 1, 'bronze', NULL, 3,
           now() - interval '400 days'
      FROM staff_user s
     WHERE s.id = 'ST-001'
    ON CONFLICT (id) DO UPDATE SET tier = 'bronze',
                                   visits = 1,
                                   balance_fils = ${LOWBAL_BALANCE_FILS},
                                   joined_at = now() - interval '400 days';

    INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
    SELECT m.id, '${SALON_B}', 'marketing_offers', true, 'signup', 3
      FROM member m
     WHERE m.id IN ('${AUD[0]}', '${AUD[1]}', '${AUD[2]}', '${LOWBAL}')
       AND NOT EXISTS (
             SELECT 1 FROM member_consent_event e
              WHERE e.member_id = m.id AND e.kind = 'marketing_offers');
  `);
}

// ------------------------------------------------------------------ the clock --

/**
 * The salon's own wall-clock minutes since midnight. `Asia/Kuwait` is UTC+3 with no
 * DST, which is why this is arithmetic rather than a timezone library — and it is the
 * SALON'S offset, not this machine's, which is the whole point. See the file header.
 */
function salonMinutesNow(): number {
  const d = new Date();
  return (d.getUTCHours() * 60 + d.getUTCMinutes() + 180) % 1440;
}

const hhmm = (minutes: number): string => {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * A quiet window that CONTAINS this instant, at any hour of the day.
 *
 * Two hours either side. When that straddles midnight the window wraps (`from > to`)
 * and `isInQuietHours` handles it — `t >= from || t < to` — so this is correct at 00:30
 * and at 09:40 alike, which a literal '22:00'-'09:00' fixture would not be.
 */
const quietWindowCovering = (): { quiet_from: string; quiet_to: string } => ({
  quiet_from: hhmm(salonMinutesNow() - 120),
  quiet_to: hhmm(salonMinutesNow() + 120),
});

/**
 * A quiet window that EXCLUDES this instant: the two hours starting two hours from now.
 * Also correct at every hour, and also sometimes wrapping.
 */
const quietWindowAvoiding = (): { quiet_from: string; quiet_to: string } => ({
  quiet_from: hhmm(salonMinutesNow() + 120),
  quiet_to: hhmm(salonMinutesNow() + 240),
});

function setPolicy(patch: Record<string, string | number | boolean>): void {
  const sets = Object.entries(patch)
    .map(([k, v]) => `${k} = ${typeof v === 'string' ? `'${v}'` : String(v)}`)
    .join(', ');
  psql(`UPDATE platform_messaging_policy SET ${sets} WHERE id = 'avo';`);
}

/** Back to migration 0028's defaults, so no spec inherits another's policy. */
function resetPolicy(): void {
  setPolicy({
    require_approval: true,
    weekly_cap_per_customer: POLICY_WEEKLY_CAP_PER_CUSTOMER,
    monthly_cap_per_salon: POLICY_MONTHLY_CAP_PER_SALON,
    quiet_from: POLICY_QUIET_FROM,
    quiet_to: POLICY_QUIET_TO,
  });
}

/**
 * SET THE POLICY ABSOLUTELY: defaults first, then this spec's patch.
 *
 * EVERY SPEC BELOW GOES THROUGH THIS RATHER THAN `setPolicy`, AND A LEAK IS WHY.
 * `platform_messaging_policy` is a SINGLETON — one row for the whole platform, by CHECK
 * — so it is shared mutable state between every spec in this file. The monthly-cap spec
 * sets `monthly_cap_per_salon: 1`; the weekly-cap spec that follows patched only the
 * quiet window and the weekly cap, inherited the cap of 1, and was HELD BY THE MONTHLY
 * CAP while asserting about the weekly one. It failed, saying "the weekly cap held the
 * campaign instead of skipping" — a true sentence about the wrong cap.
 *
 * That is the lucky direction. The same leak with the caps the other way round would
 * have PASSED, and the file would have claimed the weekly cap skips recipients while
 * never exercising it. A spec that shares a mutable row with its neighbours has to state
 * every value it depends on, not just the ones it changes.
 */
function policy(patch: Record<string, string | number | boolean> = {}): void {
  resetPolicy();
  if (Object.keys(patch).length > 0) setPolicy(patch);
}

// ------------------------------------------------------------------- helpers --

/**
 * Clear every campaign and every send row at salon B.
 *
 * AS THE OWNER, WHICH `avo_app` COULD NOT DO — and that asymmetry is asserted rather
 * than merely relied on, in § "the cap's own evidence". 0028 revokes UPDATE and DELETE
 * on `campaign_send` from `avo_app` for the reason 0026 gives about `signup_attempt`: a
 * cap whose rows the application can delete is not a cap. The suite is not the
 * application, so it may reset its own fixtures.
 *
 * `campaign_send` first — it references `campaign` with `ON DELETE restrict`, which is
 * itself the point: a delivery record cannot be discarded by removing the campaign.
 */
function clearCampaigns(): void {
  psql(`
    DELETE FROM campaign_send
     WHERE campaign_id IN (SELECT id FROM campaign WHERE salon_id = '${SALON_B}');
    DELETE FROM campaign WHERE salon_id = '${SALON_B}';
  `);
}

interface CampaignBody {
  campaign: {
    id: string;
    status: string;
    reach: number;
    heldReason: string | null;
    heldAt: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
    note: string | null;
    result: string | null;
  };
}

/**
 * The RAW `POST /v1/salons/:id/campaigns`, status included.
 *
 * SEPARATED FROM `submit()` BECAUSE OF THE BUG § THE AUDIENCE DIMENSION IS ABOUT.
 * `submit()` preconditions on a 2xx, which is right for every spec whose subject is
 * further down the flow — but it means a 500 arrives as "precondition failed" from
 * inside a helper, and the audience specs' whole subject IS the status code. So the
 * request is here and the precondition is one level up.
 *
 * `POST /v1/salons/:id/campaigns` answers with the campaign UNWRAPPED — `reply.code(201)
 * .send(serialiseCampaign(row, ...))` — while `POST /v1/platform/campaigns/:cid/decision`
 * answers `{ campaign, delivery }`. Two shapes for the same entity on two endpoints,
 * which is worth naming here because the first draft of this file assumed the wrapper on
 * both and read `undefined.status`. Reported to lane A as an inconsistency, not a defect.
 */
async function postCampaign(
  label: string,
  opts: { audience?: string; when?: string } = {},
): Promise<{ status: number; body: CampaignBody['campaign']; raw: string }> {
  const when = opts.when ?? 'now';
  return treq<CampaignBody['campaign']>('POST', `/v1/salons/${SALON_B}/campaigns`, {
    token: merchant,
    idempotencyKey: key(label),
    body: {
      title: `QA ${label}`,
      body: 'Twenty percent off blow-dries this week.',
      channel: 'push',
      audience: opts.audience ?? 'gold',
      when,
      ...(when === 'later' ? { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() } : {}),
    },
  });
}

/**
 * A `pending` campaign at salon B, submitted by the merchant. Audience `gold` by
 * DEFAULT rather than by hardcoding — see § THE AUDIENCE DIMENSION for why that
 * distinction is the whole point of this section.
 */
async function submit(
  label: string,
  when = 'now',
  audience = 'gold',
): Promise<CampaignBody['campaign']> {
  const res = await postCampaign(label, { when, audience });
  precondition(res.status === 201 || res.status === 200, `POST /campaigns: ${res.status} ${res.raw}`);
  return res.body;
}

interface DecisionBody {
  campaign: CampaignBody['campaign'];
  delivery: { status: string; sent: number; cappedOut: number; heldReason: string | null } | null;
}

async function decide(
  cid: string,
  status: 'approved' | 'rejected',
  note?: string,
  token = owner,
): Promise<{ status: number; body: DecisionBody; raw: string }> {
  return treq<DecisionBody>('POST', `/v1/platform/campaigns/${cid}/decision`, {
    token,
    idempotencyKey: key('decide'),
    body: { status, ...(note ? { note } : {}) },
  });
}

const sendsFor = (cid: string): number =>
  Number(scalar(`select count(*) from campaign_send where campaign_id='${cid}'`));

const sentTo = (cid: string): string[] => {
  const raw = scalar(
    `select coalesce(string_agg(member_id, ',' order by member_id), '') from campaign_send
      where campaign_id='${cid}'`,
  );
  return raw === '' ? [] : raw.split(',');
};

const heldNotifications = (cid: string): number =>
  Number(
    scalar(
      `select count(*) from merchant_notification
        where kind='campaign_held' and subject_id='${cid}' and resolved_at is null`,
    ),
  );

const auditRows = (cid: string, action: string): number =>
  Number(
    scalar(
      `select count(*) from audit_log where subject_id='${cid}' and action='${action}'`,
    ),
  );

/** The wire's own view of one campaign, through the merchant's list. */
async function fromWire(cid: string): Promise<CampaignBody['campaign'] | undefined> {
  const res = await treq<{ items: CampaignBody['campaign'][] }>(
    'GET',
    `/v1/salons/${SALON_B}/campaigns`,
    { token: merchant },
  );
  precondition(res.status === 200, `GET campaigns: ${res.raw}`);
  return res.body.items.find((c) => c.id === cid);
}

function runReleaseJob(): {
  considered: number;
  sent: number;
  stillHeld: number;
  recipients: number;
  cappedOut: number;
  reasons: string[];
  results: string[];
} {
  const res = runApiDbScriptResult('src/jobs/campaign-release-once.ts', pgDb());
  if (!res.ok) {
    throw new Error(
      `the campaign release job failed to run at all.\n--- stdout ---\n${res.stdout}\n` +
        `--- stderr ---\n${res.stderr}`,
    );
  }
  const start = res.stdout.indexOf('{');
  if (start < 0) throw new Error(`the job printed no JSON:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start));
}

beforeAll(async () => {
  await startTenancyApi();
  owner = await signInPlatform(PLATFORM_OWNER_HANDLE);
  analyst = await signInPlatform(PLATFORM_ANALYST_HANDLE);
  merchant = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  scanner = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
  walletSession = await signInMember(SALON_B, B_MEMBER_PHONE);
  seedAudience();
  resetPolicy();
  clearCampaigns();
}, 180_000);

afterAll(async () => {
  resetPolicy();

  /*
   * AND LEAVE THIS FILE'S MEMBERS RECONCILING TO THEIR WALLET LEDGERS.
   *
   * The three audience members and the low-balance one are INSERTed with opening
   * balances that no ledger entry accounts for — the clone copies `balance_fils`
   * and not the ledger behind it. That is `db:verify` invariant 5, a balance with
   * no originating entry, and `support/global-setup.ts` § the wallet census is
   * what measures it. Posted last, because the census reads the FINAL state of
   * the database and the writes above are what is being answered for.
   */
  for (const id of AUD) reconcileWalletLedger(id, 'QACMP');
  reconcileWalletLedger(LOWBAL, 'QACMPL');

  await stopTenancyApi();
});

// ===========================================================================
// THE PLATFORM PRINCIPAL
// ===========================================================================

describe('the platform principal — a second auth scope, not a second app', () => {
  it('console sign-in mints a platform session with NO salon, and the database says so', async () => {
    /**
     * THE STRUCTURAL CLAIM MIGRATION 0028 MAKES, asserted against the row rather than
     * against the reply. `PlatformPrincipal` has no `salonId` FIELD — not a null one, no
     * field at all — so `requireSameSalon` on it does not compile. A nullable field
     * would make the tenancy check silently pass instead, which is the failure mode the
     * design chose the type system to prevent.
     *
     * What a spec CAN check is the other half of that decision: the session row carries
     * no salon, and `session_salon_matches_principal` requires that in both directions.
     * Read out of the database, because the API's own reply is not evidence about the
     * row it wrote.
     */
    const row = scalar(
      `select principal_kind::text || '|' || coalesce(salon_id, '<null>') || '|' || scope::text
         from session
        where platform_admin_id = '${PLATFORM_OWNER}' and revoked_at is null
        order by created_at desc limit 1`,
    );
    expect(row, 'no live platform session for the owner after a successful sign-in').not.toBe('');
    expect(row).toBe('platform_admin|<null>|platform');
  });

  it('a merchant credential cannot reach an owner-console route — all three of them', async () => {
    /**
     * THE INVERSE TEST `tenancy.test.ts` RECORDED AS OWED: "when it lands, every one of
     * its endpoints needs the inverse test — a merchant credential must not reach an
     * owner route."
     *
     * All three merchant credentials, because they fail for different reasons and a
     * single probe would leave two doors untried: a dashboard session is the one a
     * confused manager actually holds, a scanner PIN session is the lowest-trust
     * credential in the product, and a wallet session belongs to a customer.
     *
     * ASSERTED AS A REFUSAL WITH ITS COPY, not merely as a non-200. The message names
     * the SURFACE rather than the authority — "this endpoint is the AVO owner console,
     * not the salon dashboard" — because a manager who lands here is confused, not
     * attacking, and a bare 403 sends her to ask for a permission that would not help.
     */
    for (const [name, token] of [
      ['dashboard', merchant],
      ['scanner', scanner],
      ['wallet', walletSession],
    ] as const) {
      const res = await treq<{ error: string; message: string }>(
        'GET',
        '/v1/platform/campaigns',
        { token },
      );
      expect(
        res.status,
        `a ${name} credential reached the owner console's approval queue: ${res.raw}`,
      ).toBe(403);
      expect(res.body.message, `the refusal to the ${name} session names no surface`).toMatch(
        /owner console/i,
      );
    }
  });

  it('and a platform credential cannot reach a merchant route — she has no staff row', async () => {
    /**
     * THE OTHER DIRECTION, AND IT IS THE ONE THAT COULD HAVE BEEN A 500.
     * `requireDashboardPerm` reads `staff_user`, a table a platform admin has no row
     * in, so the interesting question is not whether she is refused but whether she is
     * refused CLEANLY. A 500 here would be an unhandled null on an authorisation path.
     *
     * `session_scope_matches_principal` is the structural half — a platform admin can
     * only hold a `platform` scope, never `dashboard` — and this is the runtime half.
     */
    /**
     * `/salons/:id/activity`, with NO `/v1` prefix — the merchant routes and the
     * `/v1/platform/*` and `/v1/salons/*` console routes are differently prefixed in
     * this API, and a probe on the wrong path answers 404 rather than 403, which would
     * read as "refused" to a careless assertion. That is why the 404 is excluded by name
     * below rather than the spec merely checking `not 200`.
     */
    const res = await treq<{ error: string }>('GET', `/salons/${SALON_B}/activity`, {
      token: owner,
    });
    expect(
      res.status,
      `the owner console reached a merchant route, or failed messily doing it: ${res.raw}`,
    ).toBe(403);
    expect(res.status, 'an authorisation path threw rather than refusing').not.toBe(500);
    expect(
      res.status,
      'the probe hit no endpoint at all, so it proves nothing about authorisation',
    ).not.toBe(404);
  });

  it('every console section gate refuses directly with the section OFF, and grants with it ON', async () => {
    /**
     * NON-NEGOTIABLE #7 ON THE CONSOLE'S OWN ROUTES: "every gated endpoint needs a test
     * that calls it directly with the permission off."
     *
     * Mariam (`PLT-002`, analyst) holds `analytics` and `activity` and nothing else — a
     * genuinely restricted console principal, which is why the seed has one. An
     * owner-only fixture could not express this spec at all: the owner holds every
     * section by CHECK (`platform_admin_owner_holds_everything`), so there is no section
     * she could be refused for.
     *
     * AND THE MIRROR, ON EVERY ROW. Each probe is run twice — once as Mariam, once as
     * Yousef — because a 403 from a route that is broken shut looks exactly like a 403
     * from a working gate. The mirror is what makes the refusal mean "authority" rather
     * than "route".
     *
     * `requirePlatform` takes its section with NO DEFAULT, for the reason `StaffSurface`
     * has none: a default here would be a default answer to a security question.
     */
    const probes = [
      ['approvals', 'GET', '/v1/platform/campaigns'],
      ['approvals', 'GET', '/v1/platform/messaging-policy'],
      /**
       * `/policies/DRAFT`, not `/policies`.
       *
       * `GET /v1/platform/policies` is DELIBERATELY UNGATED and probing it here was this
       * spec's own first mistake — it answered 200 to the analyst and looked for a moment
       * like an ungated console endpoint breaching #7. It is not: it serves the PUBLISHED
       * policy set, which is the text non-negotiable #10 has the customer app render
       * ("the customer app holds no legal copy... it renders the published policy set from
       * the API"). Published terms being publicly readable is the normal state of affairs
       * for terms, and `routes/platform.ts` says so where the route is defined.
       *
       * The DRAFT and the publish verbs are the gated ones, because those are authority
       * over what the customer is legally held to. Named here so the next reader does not
       * repeat the same wrong conclusion.
       */
      ['policies', 'GET', '/v1/platform/policies/draft'],
    ] as const;

    for (const [section, method, path] of probes) {
      const off = await treq<{ error: string; message: string }>(method, path, { token: analyst });
      expect(
        off.status,
        `${method} ${path} served a console account without \`${section}\`: ${off.raw}`,
      ).toBe(403);
      expect(
        off.body.message,
        `the refusal on ${path} does not say who can grant \`${section}\``,
      ).toMatch(/platform owner can grant it/i);

      const on = await treq(method, path, { token: owner });
      expect(
        on.status,
        `${method} ${path} refused the OWNER too, so the 403 above was a broken route rather ` +
          `than the \`${section}\` gate: ${on.raw}`,
      ).toBe(200);
    }
  });

  it('the decision endpoint itself is gated, and a refused decision decides nothing', async () => {
    /**
     * THE GATE THAT MATTERS MOST, PROBED WITH A REAL CAMPAIGN AND A REAL STATE
     * ASSERTION. The three probes above are reads; this one is the write that releases a
     * message to customers, so "the system refused" is asserted twice — once on the
     * status and once on the campaign STILL BEING `pending` afterwards.
     *
     * "Nothing changed" alone would be satisfied by a request that never arrived.
     */
    clearCampaigns();
    const c = await submit('gate');

    const refused = await decide(c.id, 'approved', undefined, analyst);
    expect(
      refused.status,
      `a console account without \`approvals\` decided a campaign: ${refused.raw}`,
    ).toBe(403);

    expect(
      scalar(`select status from campaign where id='${c.id}'`),
      'the refused decision changed the campaign anyway',
    ).toBe('pending');
    expect(
      scalar(`select coalesce(decided_by, '<null>') from campaign where id='${c.id}'`),
      'the refused decision attributed itself to somebody',
    ).toBe('<null>');
  });
});

// ===========================================================================
// #8's FIRST HALF — A MERCHANT CANNOT SEND
// ===========================================================================

describe('a merchant cannot send a customer message (non-negotiable #8)', () => {
  it('POST /campaigns creates pending, computes reach server-side, and sends nothing', async () => {
    clearCampaigns();
    const c = await submit('pending-only');

    expect(c.status, 'a merchant-submitted campaign was not pending').toBe('pending');
    expect(
      c.decidedBy,
      'a pending campaign carries a decider, which reads to a merchant as "somebody looked at ' +
        'this and did nothing"',
    ).toBeNull();
    expect(c.decidedAt).toBeNull();

    /**
     * REACH IS THE SERVER'S NUMBER. The contract marks the field "server-computed, never
     * trusted from the client", and it is computed at SUBMISSION and never recomputed on
     * read — the number a reviewer approves against must not change under her while she
     * reads the queue. Three consenting gold customers at salon B, so three.
     */
    expect(c.reach, 'reach was not computed from the real audience').toBe(AUD.length);

    // And nothing was delivered. The row count, not the reply.
    expect(sendsFor(c.id), 'a merchant-submitted campaign wrote delivery rows').toBe(0);
    expect(
      scalar(`select coalesce(result, '<null>') from campaign where id='${c.id}'`),
      'a pending campaign carries a delivery result',
    ).toBe('<null>');
  });

  it('a merchant cannot set her own status, reach, or hold — the wire strips what it does not own', async () => {
    /**
     * THE ATTACK #8 IS ACTUALLY ABOUT. "A merchant cannot send" is not only about the
     * absence of a send endpoint; it is about her not being able to reach `sent` by
     * asking for it. She controls the whole body of `POST /campaigns`, so every field
     * that decides delivery has to be ignored on the way in.
     *
     * `reach` is the sharper half: it is the number a platform reviewer approves
     * against, so a merchant who could inflate it could not send anything, but she could
     * lie to the reviewer.
     */
    clearCampaigns();
    const res = await treq<CampaignBody['campaign']>('POST', `/v1/salons/${SALON_B}/campaigns`, {
      token: merchant,
      idempotencyKey: key('forge'),
      body: {
        title: 'QA forge',
        body: 'Trying to send this myself.',
        channel: 'push',
        audience: 'gold',
        when: 'now',
        status: 'sent',
        reach: 999_999,
        heldReason: null,
        heldAt: null,
        decidedBy: 'Yousef',
        decidedAt: new Date().toISOString(),
        result: '999999 reached',
      },
    });
    precondition(res.status === 201 || res.status === 200, `POST /campaigns: ${res.raw}`);
    const c = res.body;

    expect(c.status, 'a merchant set her own campaign to sent').toBe('pending');
    expect(c.reach, 'a merchant set her own reach and lied to the reviewer').toBe(AUD.length);
    expect(c.decidedBy, 'a merchant attributed a decision to a platform admin').toBeNull();
    expect(c.result).toBeNull();
    expect(sendsFor(c.id), 'a forged campaign delivered to customers').toBe(0);

    // And the database agrees with the reply, which is the half a serialiser could fake.
    expect(scalar(`select status from campaign where id='${c.id}'`)).toBe('pending');
    expect(scalar(`select reach::text from campaign where id='${c.id}'`)).toBe(String(AUD.length));
  });
});

// ===========================================================================
// #8's SECOND HALF — CAPS AND QUIET HOURS, AT SEND TIME
// ===========================================================================

describe('quiet hours HOLD the campaign — held and reported, never silently dropped', () => {
  it('an approval inside quiet hours holds it, tells the merchant, and delivers nothing', async () => {
    clearCampaigns();
    policy(quietWindowCovering());

    const c = await submit('quiet');
    const decision = await decide(c.id, 'approved');
    expect(decision.status, `the approval failed: ${decision.raw}`).toBe(200);

    /**
     * STATUS STAYS `approved`. This is the fact that makes `heldReason`/`heldAt`
     * load-bearing: there is no `held` status to read, because a fifth status on the
     * wire is a value every client's `.parse()` rejects. AVO did release it; the
     * platform did not send it; both are true.
     */
    expect(
      decision.body.campaign.status,
      'a held campaign reported a status other than approved, which no client can parse',
    ).toBe('approved');

    expect(
      decision.body.campaign.heldReason,
      'a campaign held for quiet hours carries no reason, so the merchant sees an approved ' +
        'campaign that never went out — the silent drop #8 forbids',
    ).toBeTruthy();
    expect(
      decision.body.campaign.heldReason,
      'the hold reason does not name quiet hours, so the merchant cannot tell it from a cap',
    ).toMatch(/quiet hours/i);
    expect(
      decision.body.campaign.heldAt,
      '`campaign_hold_is_complete` requires both fields together',
    ).toBeTruthy();

    // NOTHING WAS DELIVERED. Rows, not the reply.
    expect(sendsFor(c.id), 'a campaign held for quiet hours delivered to customers anyway').toBe(0);

    /**
     * REPORTED, IN BOTH PLACES IT HAS TO BE. A hold that committed without its
     * notification would be exactly the silent drop — the salon was told her campaign was
     * approved and it would never go out.
     */
    expect(
      heldNotifications(c.id),
      'no `campaign_held` merchant notification — this is the only place a merchant can learn ' +
        'of a hold, because CampaignSchema declares no status for one',
    ).toBe(1);
    expect(auditRows(c.id, 'Campaign held'), 'the platform kept no record of its own hold').toBe(1);
  });

  it('and the hold reaches the WIRE, where a client can render it', async () => {
    /**
     * QUEUE ITEM 4, AND THE HALF `contract.test.ts` CANNOT COVER. That file pins the
     * SHAPE — both keys present, `null` on an ordinary campaign — against the never-held
     * campaign every merchant sees first. This pins the VALUES on a campaign that really
     * got held, read back through the merchant's own list endpoint rather than out of the
     * decision reply.
     *
     * The distinction is not pedantic: `serialiseCampaign` is one function, but the
     * decision endpoint returns it from an in-memory row it just wrote, while the list
     * endpoint reads the row back from Postgres. A `heldAt` that round-trips as a Date and
     * serialises to `''` instead of an ISO string would pass the first and fail here.
     */
    const held = scalar(
      `select id from campaign where salon_id='${SALON_B}' and held_reason is not null
        order by decided_at desc limit 1`,
    );
    precondition(held !== '', 'no held campaign to read back, so this spec proves nothing');

    const wire = await fromWire(held);
    expect(wire, 'a held campaign vanished from the merchant\'s own list').toBeTruthy();
    expect(wire!.status, 'the wire reports a held campaign as something other than approved').toBe(
      'approved',
    );
    expect(wire!.heldReason, 'heldReason does not survive the round trip to the database').toMatch(
      /quiet hours/i,
    );
    expect(
      wire!.heldAt,
      'heldAt does not survive the round trip. A held campaign rendering as sent is exactly ' +
        'what #8 prevents.',
    ).toBeTruthy();
    expect(
      String(wire!.heldAt),
      'heldAt is not an ISO instant, so a client cannot show "held at" as a time',
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('the hold is a REASON, not a rejection — it sends when quiet hours end', async () => {
    /**
     * THE PROPERTY THAT MAKES A HOLD DIFFERENT FROM A SILENT DROP, and the reason
     * `jobs/campaign-release-once.ts` has to exist: "a hold nothing ever retries IS a
     * silent drop with a paper trail."
     *
     * The clock is moved by moving the POLICY rather than by waiting for 09:00 — the same
     * decision this suite's predecessor made for the happy-hour boundary, and for the same
     * reason: a spec that can only be exercised by waiting is a claim nobody checks.
     *
     * THE JOB IS RUN AS A JOB, through `src/jobs/campaign-release-once.ts`. STATUS.md
     * records that the no-show runner was built for evidence and then "never once executed
     * by a spec"; this is that runner's sibling and it is executed here.
     */
    clearCampaigns();
    policy(quietWindowCovering());

    const c = await submit('release');
    const decision = await decide(c.id, 'approved');
    precondition(
      decision.body.campaign.heldReason !== null,
      `the campaign was not held, so there is nothing to release: ${decision.raw}`,
    );
    precondition(sendsFor(c.id) === 0, 'the held campaign already delivered');
    precondition(heldNotifications(c.id) === 1, 'the hold raised no notification to clear');

    // Quiet hours end. A PARTIAL patch on purpose: everything else about the policy must
    // stay exactly as the hold was created under, or the release below could succeed for a
    // reason this spec did not set up.
    setPolicy(quietWindowAvoiding());

    const tick = runReleaseJob();
    expect(
      tick.sent,
      `the release job sent nothing once quiet hours ended: ${JSON.stringify(tick)}`,
    ).toBe(1);

    expect(scalar(`select status from campaign where id='${c.id}'`)).toBe('sent');
    expect(
      scalar(`select coalesce(held_reason, '<null>') from campaign where id='${c.id}'`),
      'the campaign sent but still reads as held, so the merchant sees a stale hold for ever',
    ).toBe('<null>');
    expect(sentTo(c.id), 'the released campaign did not reach the audience').toEqual([...AUD]);

    /**
     * AND THE BELL CLEARS. `services/notifications.ts`: "a notification that never clears
     * trains a merchant to ignore the bell". It also frees the partial unique index, so a
     * LATER hold on the same campaign raises a new row instead of being deduped against a
     * stale fact.
     */
    expect(
      heldNotifications(c.id),
      'the `campaign_held` notification is still unresolved after the campaign sent',
    ).toBe(0);

    // And a second pass finds nothing left to do rather than sending again.
    const second = runReleaseJob();
    expect(
      second.sent,
      `a second release pass sent the campaign again: ${JSON.stringify(second)}`,
    ).toBe(0);
    expect(sendsFor(c.id), 'a second release pass double-messaged the audience').toBe(AUD.length);
  });

  it('a retried hold raises ONE bell, not one per pass', async () => {
    /**
     * The dedupe on `(salon, kind, subject_type, subject_id) WHERE resolved_at IS NULL`.
     * A scheduler retrying a held campaign every ten minutes must produce one bell rather
     * than a hundred and forty — and this is the spec that fails if the partial index or
     * the `resolved_at` predicate goes.
     */
    clearCampaigns();
    policy(quietWindowCovering());

    const c = await submit('rebell');
    await decide(c.id, 'approved');
    precondition(heldNotifications(c.id) === 1, 'the first hold raised no bell');

    // Still quiet. Three more passes.
    for (let i = 0; i < 3; i += 1) runReleaseJob();

    expect(
      scalar(`select status from campaign where id='${c.id}'`),
      'a campaign sent while still inside quiet hours',
    ).toBe('approved');
    expect(sendsFor(c.id), 'a held campaign delivered on a retry that should have held it').toBe(0);
    expect(
      heldNotifications(c.id),
      'each retry raised its own bell. A merchant with a hundred identical notifications ' +
        'stops reading them, which is the same outcome as never being told.',
    ).toBe(1);
  });
});

describe('the caps, and the two different things they do', () => {
  it('the MONTHLY cap holds the whole campaign — it is a property of the salon', async () => {
    clearCampaigns();
    policy({ ...quietWindowAvoiding(), monthly_cap_per_salon: 1 });

    // One campaign released this month, which fills a cap of one.
    const first = await submit('cap-first');
    const firstDecision = await decide(first.id, 'approved');
    precondition(
      firstDecision.body.campaign.status === 'sent',
      `the first campaign did not send, so the cap below is not what holds the second: ` +
        firstDecision.raw,
    );

    const second = await submit('cap-second');
    const decision = await decide(second.id, 'approved');
    expect(decision.status, decision.raw).toBe(200);

    expect(
      decision.body.campaign.heldReason,
      'the second campaign was sent past a monthly cap of one',
    ).toBeTruthy();
    expect(
      decision.body.campaign.heldReason,
      'the hold does not name the platform limit, so the merchant cannot tell it from quiet hours',
    ).toMatch(/limit of 1 campaigns this month/i);
    expect(decision.body.campaign.status, 'a held campaign reported a fifth status').toBe(
      'approved',
    );
    expect(sendsFor(second.id), 'the capped campaign delivered anyway').toBe(0);
    expect(heldNotifications(second.id), 'the monthly cap held silently').toBe(1);
  });

  it('the WEEKLY cap SKIPS the capped customers and delivers to the rest', async () => {
    /**
     * THE SHAPE THAT IS DELIBERATELY NOT A HOLD, and getting this wrong in either
     * direction is a real product failure. `weeklyCapPerCustomer` is "a hard cap across ALL
     * salons" — a property of the CUSTOMER — so holding six hundred people's campaign
     * because twelve are capped would punish the 588 and would be undeliverable for a
     * reason the merchant cannot see or fix.
     *
     * FUNDED SO THE TWO OUTCOMES CANNOT BE CONFUSED, the same asymmetry `orders.test.ts`
     * uses: with a cap of 1 and ONE of the three customers already messaged, the correct
     * answer is two recipients and one skipped. A spec where all three were capped would
     * read the same whether the cap skipped or held.
     */
    clearCampaigns();
    policy({ ...quietWindowAvoiding(), weekly_cap_per_customer: 1 });

    /**
     * Her prior message, this week, AT ANOTHER CAMPAIGN. Inserted as the owner because
     * `campaign_send` is INSERT-only for `avo_app` — and it needs a campaign to reference,
     * so a delivered one is created for it to hang off rather than the row being forged
     * against nothing.
     */
    const earlier = await submit('cap-earlier');
    const earlierDecision = await decide(earlier.id, 'approved');
    precondition(
      earlierDecision.body.campaign.status === 'sent',
      `the priming campaign did not send: ${earlierDecision.raw}`,
    );
    precondition(
      sendsFor(earlier.id) === AUD.length,
      'the priming campaign did not reach all three, so the cap arithmetic below is wrong',
    );

    // Now everyone has had one. Free two of them again by removing their rows, so exactly
    // one customer is over a cap of one.
    psql(
      `DELETE FROM campaign_send
        WHERE campaign_id='${earlier.id}' AND member_id IN ('${AUD[1]}', '${AUD[2]}');`,
    );
    precondition(
      sentTo(earlier.id).length === 1 && sentTo(earlier.id)[0] === AUD[0],
      'the fixture did not leave exactly one capped customer',
    );

    const c = await submit('cap-weekly');
    const decision = await decide(c.id, 'approved');
    expect(decision.status, decision.raw).toBe(200);

    expect(
      decision.body.campaign.status,
      'the weekly cap HELD the campaign instead of skipping the capped customer. That punishes ' +
        'everyone in the audience for one person\'s inbox.',
    ).toBe('sent');
    expect(
      decision.body.campaign.heldReason,
      'a campaign that sent carries a hold reason',
    ).toBeNull();

    expect(
      sentTo(c.id),
      'the wrong customers received it — the capped one should be skipped and the other two ' +
        'should receive it',
    ).toEqual([AUD[1], AUD[2]]);

    /**
     * AND THE MERCHANT IS TOLD WHAT WAS HELD BACK. `result` is what the design's Decided
     * list renders verbatim; a bare "2 reached" would hide that a third customer exists and
     * did not get it.
     */
    expect(
      decision.body.campaign.result,
      'the result does not report the customers held back by the cap',
    ).toMatch(/2 reached · 1 over the weekly cap/);
  });

  it('an audience that is ENTIRELY capped out is a hold, not a send to nobody', async () => {
    /**
     * "Zero recipients out of six hundred is not 'delivered to nobody' — it is the cap
     * refusing the whole campaign, and `result: \"0 reached\"` would report that as a
     * successful send of nothing."
     *
     * This is the boundary between the two shapes above, and it is the one a
     * skip-everyone implementation gets wrong while passing both of them.
     */
    clearCampaigns();
    policy({ ...quietWindowAvoiding(), weekly_cap_per_customer: 1 });

    const earlier = await submit('all-capped-prime');
    const primed = await decide(earlier.id, 'approved');
    precondition(
      primed.body.campaign.status === 'sent' && sendsFor(earlier.id) === AUD.length,
      `the priming campaign did not reach all three: ${primed.raw}`,
    );

    const c = await submit('all-capped');
    const decision = await decide(c.id, 'approved');
    expect(decision.status, decision.raw).toBe(200);

    expect(
      decision.body.campaign.status,
      'a campaign whose entire audience was capped reported as SENT. The merchant reads ' +
        '"delivered" about a message nobody received.',
    ).toBe('approved');
    expect(decision.body.campaign.heldReason).toMatch(/already had 1 message\(s\) this week/i);
    expect(decision.body.campaign.result, 'a held campaign carries a delivery result').toBeNull();
    expect(sendsFor(c.id)).toBe(0);
    expect(heldNotifications(c.id), 'the fully-capped campaign held silently').toBe(1);
  });

  it("the cap's own evidence cannot be edited or deleted by the application", async () => {
    /**
     * A CAP WHOSE ROWS THE APPLICATION CAN DELETE IS NOT A CAP — 0026's reasoning about
     * `signup_attempt`, which applies more strongly here because `campaign_send` is BOTH
     * the rate-limit counter AND the evidence that a customer was contacted. 0028 revokes
     * UPDATE and DELETE from `avo_app` on exactly those grounds.
     *
     * Driven AS `avo_app`, and asserted as a refusal by name in both directions. A
     * "nothing changed" assertion would be satisfied by a `WHERE` that matched nothing,
     * which is a mistake this suite has actually shipped.
     */
    clearCampaigns();
    policy(quietWindowAvoiding());
    const c = await submit('evidence');
    const decision = await decide(c.id, 'approved');
    precondition(
      decision.body.campaign.status === 'sent' && sendsFor(c.id) === AUD.length,
      `the campaign did not deliver, so there is no evidence to try to erase: ${decision.raw}`,
    );

    for (const [verb, sql] of [
      ['UPDATE', `UPDATE campaign_send SET sent_at = now() - interval '30 days'
                   WHERE campaign_id = '${c.id}'`],
      ['DELETE', `DELETE FROM campaign_send WHERE campaign_id = '${c.id}'`],
    ] as const) {
      let refusal = '';
      try {
        psql(`SET ROLE avo_app; ${sql};`);
      } catch (err) {
        refusal = String((err as Error).message ?? err);
      }
      expect(
        refusal,
        `avo_app was allowed to ${verb} campaign_send. The API can then move a customer out of ` +
          'her own weekly window, and the cap is advisory.',
      ).toMatch(/permission denied/i);
    }

    expect(
      sendsFor(c.id),
      'the refused statements changed the evidence anyway',
    ).toBe(AUD.length);
  });
});

// ===========================================================================
// THE DECISION ITSELF
// ===========================================================================

describe('the platform decision endpoint', () => {
  it('a rejection carries a reason, and a reason-less rejection is refused', async () => {
    clearCampaigns();
    const c = await submit('reject');

    const bare = await decide(c.id, 'rejected');
    expect(bare.status, `a rejection with no note was accepted: ${bare.raw}`).toBe(400);
    expect(scalar(`select status from campaign where id='${c.id}'`)).toBe('pending');

    const withNote = await decide(c.id, 'rejected', 'The offer breaches the discount cap.');
    expect(withNote.status, withNote.raw).toBe(200);
    expect(withNote.body.campaign.status).toBe('rejected');
    expect(
      withNote.body.campaign.note,
      'the merchant sees the rejection reason verbatim; it is not stored',
    ).toBe('The offer breaches the discount cap.');
    expect(
      withNote.body.campaign.decidedBy,
      'the decision is not attributed, so the merchant cannot tell who refused her',
    ).toBe(PLATFORM_OWNER_NAME);
    expect(sendsFor(c.id), 'a rejected campaign delivered to customers').toBe(0);
  });

  it('a campaign can only be decided once', async () => {
    clearCampaigns();
    policy(quietWindowAvoiding());
    const c = await submit('twice');

    const first = await decide(c.id, 'approved');
    precondition(first.status === 200, `the first decision failed: ${first.raw}`);
    const sendsAfterFirst = sendsFor(c.id);

    const again = await decide(c.id, 'rejected', 'changed my mind');
    expect(
      again.status,
      `a decided campaign was decided again: ${again.raw}`,
    ).toBe(409);
    expect(again.body).toMatchObject({ error: 'campaign_already_decided' } as never);

    expect(
      scalar(`select status from campaign where id='${c.id}'`),
      'the second decision overwrote the first',
    ).toBe('sent');
    expect(
      sendsFor(c.id),
      'the second decision delivered the campaign a second time',
    ).toBe(sendsAfterFirst);
  });

  it('a scheduled campaign is NOT delivered at approval — the caps are checked at send', async () => {
    /**
     * #8's "again at send time", as a distinction rather than a phrase. A `later` campaign
     * approved now is released to be delivered later, so its send-time check happens
     * THEN — because a cap that was clear at approval can be full by the scheduled hour.
     *
     * A `now` campaign approved in the same breath IS send time, which is why the specs
     * above see delivery on the decision.
     */
    clearCampaigns();
    policy(quietWindowAvoiding());
    const c = await submit('later', 'later');

    const decision = await decide(c.id, 'approved');
    expect(decision.status, decision.raw).toBe(200);
    expect(decision.body.campaign.status, 'a scheduled campaign sent at approval').toBe('approved');
    expect(
      decision.body.delivery,
      'a scheduled campaign reported a delivery outcome at approval time',
    ).toBeNull();
    expect(sendsFor(c.id), 'a scheduled campaign delivered at approval time').toBe(0);

    /**
     * AND IT IS NOT A HOLD EITHER — no `heldReason`, because nothing refused it. A
     * scheduled campaign carrying a hold reason would show the merchant a problem that
     * does not exist, and `campaign_hold_requires_approved` would let it through.
     */
    expect(
      decision.body.campaign.heldReason,
      'a scheduled campaign was marked held, which tells the merchant something is wrong when ' +
        'nothing is',
    ).toBeNull();
  });
});

// ===========================================================================
// THE AUDIENCE DIMENSION — DERIVED FROM THE CONSTANT, NOT ENUMERATED HERE
// ===========================================================================

/**
 * THIS SECTION IS THIS FILE'S OWN COVERAGE HOLE, AND THE HOLE SHIPPED A 500.
 *
 * `POST /v1/salons/{id}/campaigns` with `audience: "lapsed"` answered 500 `server_error`
 * for the entire life of the endpoint, and so did releasing an already-approved `lapsed`
 * campaign. Everything above this line proves submission, approval, the weekly cap, the
 * monthly cap, quiet hours and double-release idempotency — thoroughly enough that the
 * money paths are trustworthy — and every one of those specs pinned `audience: 'gold'`
 * at its call site. Five audiences exist in `CAMPAIGN_AUDIENCES`. The suite exercised
 * the one that happened to work.
 *
 * The depth was never the problem. `lapsed` is "Not seen in 60 days", the campaign a
 * salon asks for FIRST, and non-negotiable #8 routes every campaign through the platform
 * — so a merchant met a 500 at the moment she asked for something she is entitled to
 * ask for, and this suite could not have told her.
 *
 * `services/campaign.ts` § BUILT WITH THE HELPERS carries the mechanism in full. The
 * short version: the `lapsed` branch alone interpolated a JS `Date` into a raw `sql`
 * template, `drizzle()` REPLACES postgres.js's date serializer with an identity function
 * on construction, and a parameter Drizzle did not encode against a column therefore
 * reaches `Bind` as a live `Date` and dies in `Buffer.byteLength`. The other four
 * branches were built from `lt` / `inArray` / `gte`, which carry the column's own
 * encoder. That was the whole difference — which is precisely why a suite pinned to one
 * value could not see it, and why the fix worth having is a COVERAGE SHAPE rather than a
 * sixth spec about `lapsed`.
 *
 * =========================================================================
 * WHAT IS HERE, AND WHAT IS DELIBERATELY LEFT TO LANE A
 * =========================================================================
 * Lane A already covers the audience dimension twice, derived from the same constant,
 * and this section repeats neither:
 *
 *   `api/src/services/campaignAudience.test.ts` (7 specs, inside `pnpm check`) — for
 *   every audience, the COMPILED PREDICATE binds no parameter the driver cannot encode.
 *   A property of the SQL: no database, no connection, no HTTP.
 *
 *   `api/src/services/campaignAudience.int.test.ts` (16 specs, real driver) — every
 *   audience through `computeReach`, through `resolveAudience`, and through
 *   `deliverCampaign` on an approved campaign, the releases inside rolled-back
 *   transactions.
 *
 * So the bindability of the predicate, the reach arithmetic per audience, and the shape
 * of the resolved id list are NOT asserted here. They are asserted closer to the code,
 * more cheaply, and one of them runs in the gate — duplicating them would buy a slower
 * suite and no new information.
 *
 * WHAT ONLY THIS SUITE CAN SAY is the round trip, and it is the half the merchant
 * actually met:
 *
 *   1. THE STATUS CODE ON THE WIRE. Lane A's int specs call `computeReach` as a
 *      function. A function that returns a number says nothing about whether
 *      `POST /campaigns` answers 201 — the route also validates the audience against
 *      `CAMPAIGN_AUDIENCES`, writes an idempotency record, inserts a row against a CHECK
 *      constraint and serialises a reply, and the reported symptom was a status code.
 *
 *   2. THE PLATFORM'S DECISION ENDPOINT, over HTTP, as the owner. `deliverCampaign` is
 *      called by a route behind `requirePlatform`; the int suite calls the service.
 *
 *   3. SENDS THAT COMMIT. Lane A's release specs roll back on purpose and say so — they
 *      make no claim about the state of the database afterwards. Whether a
 *      `campaign_send` row SURVIVES for an audience other than `gold` is a claim only a
 *      committed round trip can make, and `campaign_send` is what the weekly cap counts.
 *
 *   4. THE TWO CALL SITES AGREEING. `resolveAudience` runs twice in a campaign's life —
 *      `computeReach` at submission and `deliverCampaign` step 3 at release. Nothing
 *      before this section checks that the number the reviewer approved against is the
 *      number that went out, because that needs both endpoints and a real commit
 *      between them. `sent + cappedOut === reach` is asserted for every audience below.
 *
 * =========================================================================
 * DERIVED FROM THE CONSTANT, AND CROSS-CHECKED AGAINST THE CHECK CONSTRAINT
 * =========================================================================
 * There is no list of five audiences typed in this file. `campaignAudiencesFromSource()`
 * reads `CAMPAIGN_AUDIENCES` out of `api/src/db/schema/campaign.ts` — the same `as const`
 * the route's 400 message is built from — so a sixth audience is covered on the day it is
 * added to the constant rather than on the day somebody remembers this file. That is the
 * technique `support/perm-census.ts` and `apps/dashboard/src/shell/consoleNavGates.test.ts`
 * already use, and Lane A's two audience suites use it too.
 *
 * READ FROM SOURCE TEXT RATHER THAN IMPORTED, which is a convention this package holds
 * deliberately: nothing in `e2e/` imports from `api/src` — `console-reset.test.ts` says so
 * in as many words — because the suite is meant to drive the API from outside it. The
 * cases have to exist at COLLECTION time, before `beforeAll` has provisioned a database,
 * so they cannot come from a query either.
 *
 * COMMENTS ARE NOT STRIPPED BEFORE PARSING, WHICH IS A DEPARTURE FROM
 * `perm-census.ts` AND IS SAFE HERE FOR A REASON RATHER THAN BY LUCK. That module strips
 * them because prose naming `requireDashboardPerm` outnumbers the real calls two to one,
 * and a false match invents a gate nothing checks. Here the declaration is a single line
 * of literals and, more to the point, a mis-read list does not survive: the CHECK
 * cross-check below compares whatever was read against the constraint the database
 * actually enforces, so a stray literal picked up from prose fails that spec by name
 * instead of quietly widening or narrowing the loops. If the constant is ever reformatted
 * across lines with a comment inside it, strip comments then.
 *
 * A ZERO RESULT IS A CLAIM ABOUT THE PARSER, so `campaignAudiencesFromSource()` THROWS
 * rather than returning `[]`. A parse that silently found nothing would delete every
 * derived spec below and report the file green with the audience dimension untested —
 * which is the exact failure this section exists to end, reintroduced one level down.
 * The known positives are asserted too, in § "the derivation itself".
 *
 * AND THE DATABASE IS CROSS-CHECKED, because the constant is not the only gate. The
 * route validates against `CAMPAIGN_AUDIENCES` in TypeScript; the row is admitted by a
 * SEPARATE CHECK constraint, `campaign_audience_is_known`, written out by a migration.
 * A sixth audience added to the constant WITHOUT the migration passes the route's 400 and
 * then violates the CHECK — a 500 on `POST /campaigns`, the same family of bug as the one
 * above and reached by the same door. So one spec below reads
 * `pg_get_constraintdef()` and requires the two lists to agree.
 */

const AUDIENCE_CONSTANT_FILE = join(repoRoot, 'api', 'src', 'db', 'schema', 'campaign.ts');

/**
 * Every single-quoted literal in a fragment of text, in order.
 *
 * Used against BOTH the `as const` in lane A's schema module and the
 * `pg_get_constraintdef()` rendering of the CHECK, because the two say the same thing in
 * two syntaxes — `['all', 'lapsed', …] as const` and
 * `audience = ANY (ARRAY['all'::text, …])` — and the literals are the part that matters
 * in each. Matching the syntax instead would need two readers and would break the first
 * time Postgres renders the constraint differently.
 */
const quotedStrings = (text: string): string[] =>
  [...text.matchAll(/'([^']*)'/g)].flatMap((m) => (m[1] ? [m[1]] : []));

/**
 * `CAMPAIGN_AUDIENCES`, read out of lane A's schema module as text.
 *
 * Throws rather than returning empty — see the section header. The message names the
 * file and both plausible causes, because the reader of this failure is somebody who
 * just renamed or moved a constant and has no reason to expect a QA suite to care.
 */
function campaignAudiencesFromSource(): string[] {
  const src = readFileSync(AUDIENCE_CONSTANT_FILE, 'utf8');
  const decl = /export const CAMPAIGN_AUDIENCES\s*=\s*\[([^\]]*)\]\s*as const/.exec(src);
  if (!decl) {
    throw new Error(
      `CAMPAIGN_AUDIENCES could not be found in ${AUDIENCE_CONSTANT_FILE}.\n` +
        'Every audience spec in e2e/campaigns.test.ts is derived from that constant, so a ' +
        'failed parse would silently delete them all — hence this throw rather than an ' +
        'empty list.\nIf the constant was renamed, moved, or reformatted across lines, ' +
        'update this reader. Do NOT replace it with a list typed here: a hardcoded list is ' +
        'what let `audience: "lapsed"` answer 500 for the life of the endpoint.',
    );
  }
  const found = quotedStrings(decl[1] ?? '');
  if (found.length === 0) {
    throw new Error(
      `CAMPAIGN_AUDIENCES was found in ${AUDIENCE_CONSTANT_FILE} but no audience was read ` +
        `out of it. The declaration matched as: ${decl[0]}`,
    );
  }
  return found;
}

const AUDIENCES = campaignAudiencesFromSource();

/**
 * The consenting members of salon B with NO settled charge — so, `lapsed`, by the
 * predicate's own definition. Sorted, because `sentTo()` reads `ORDER BY member_id`.
 *
 * A SUPERSET ASSERTION AND NOT AN EQUALITY, deliberately: Fatima (`9001`) has no settled
 * charge at salon B either, so she joins this audience the moment any other file grants
 * her marketing consent. The file header explains why every spec above chose `gold` for
 * exactly this reason. Where an EXACT recipient set is needed, § "the full round trip"
 * uses `lowbal`, which her balance keeps her out of whatever else runs.
 */
const LAPSED_COHORT = [...AUD, LOWBAL].sort();

describe('the audience dimension — every member of CAMPAIGN_AUDIENCES, derived', () => {
  // -------------------------------------------------- the derivation itself --
  it("the constant was read out of lane A's schema, and it contains the known positives", () => {
    /**
     * THE PARSER IS LOAD-BEARING, so it is proved against known positives before
     * anything is concluded from it. A regex that matched the declaration but read no
     * strings out of it would make every loop below iterate zero times and report green.
     *
     * THE COUNT IS NOT PINNED AT 5 HERE, AND THAT IS A CONSIDERED DIFFERENCE FROM LANE
     * A'S TWO SUITES, both of which assert `toHaveLength(5)`. Their reason is sound —
     * an emptied constant must not make a derived spec vanish — and it is already met
     * twice, plus by the two throws in `campaignAudiencesFromSource()`, which is the
     * failure mode a third `toHaveLength(5)` would guard. What pinning the count WOULD
     * add is a third suite turning red on the day somebody deliberately adds a sixth
     * audience, when this suite's entire purpose is that the sixth is COVERED rather
     * than that it does not exist.
     */
    expect(
      AUDIENCES.length,
      `only ${AUDIENCES.length} audience(s) were read out of ${AUDIENCE_CONSTANT_FILE}. ` +
        'The reader matched the declaration but is mis-reading its contents.',
    ).toBeGreaterThanOrEqual(2);

    for (const known of ['gold', 'lapsed'] as const) {
      expect(
        AUDIENCES,
        `"${known}" is not among the audiences read from source (${AUDIENCES.join(', ')}). ` +
          'Either the constant genuinely lost it, or the reader is wrong — and if the ' +
          'reader is wrong, every derived spec below is testing the wrong set.',
      ).toContain(known);
    }
  });

  it('the database CHECK admits exactly the audiences the route validates against', () => {
    /**
     * TWO INDEPENDENT GATES ON ONE FIELD, and a divergence between them is a 500.
     *
     * `routes/campaigns.ts` answers 400 for anything not in `CAMPAIGN_AUDIENCES`;
     * `campaign_audience_is_known` is a CHECK written out by a migration. A sixth
     * audience added to the constant and not to the migration passes the 400 and then
     * violates the CHECK on INSERT — `server_error`, on the endpoint this whole section
     * is about, reached by a different door.
     *
     * Read with `pg_get_constraintdef()` rather than from the migration file, because
     * what matters is the constraint that is actually deployed in front of this run.
     * Postgres normalises the `IN (...)` list to `= ANY (ARRAY[...])`, so the quoted
     * literals are extracted rather than the syntax being matched.
     */
    const def = scalar(
      "select pg_get_constraintdef(oid) from pg_constraint where conname='campaign_audience_is_known'",
    );
    expect(
      def,
      'the CHECK constraint `campaign_audience_is_known` is not on this database. Either the ' +
        'migration that adds it was dropped, or it was renamed — in which case this spec is ' +
        'reading nothing and proving nothing.',
    ).not.toBe('');

    const admitted = quotedStrings(def);
    expect(
      [...admitted].sort(),
      'the audiences the DATABASE admits and the audiences the ROUTE validates against ' +
        `disagree.\n  CHECK constraint: ${admitted.join(', ')}\n  CAMPAIGN_AUDIENCES: ` +
        `${AUDIENCES.join(', ')}\nAn audience in the constant but not in the CHECK passes the ` +
        "route's 400 and then answers 500 on INSERT. An audience in the CHECK but not in the " +
        'constant is unreachable and untested.',
    ).toEqual([...AUDIENCES].sort());
  });

  // ------------------------------------------------------ 1. the create path --
  /**
   * THE MERCHANT'S REQUEST, one spec per audience, and the whole subject is the status
   * code. This is the spec that was missing: with `audience: 'lapsed'` it answers 500,
   * and with any other audience it answers 201.
   */
  for (const audience of AUDIENCES) {
    it(`POST /campaigns accepts audience "${audience}" and creates it pending`, async () => {
      clearCampaigns();
      policy(quietWindowAvoiding());

      const res = await postCampaign(`aud-create-${audience}`, { audience });

      expect(
        [200, 201],
        `POST /v1/salons/${SALON_B}/campaigns with audience "${audience}" answered ` +
          `${res.status}.\n${res.raw}\n\nA 500 here is the bug this section exists for: a ` +
          'bound parameter the driver cannot encode, thrown at BIND time. See ' +
          '`api/src/services/campaign.ts` § BUILT WITH THE HELPERS. A 400 means the route ' +
          'validates against a narrower list than `CAMPAIGN_AUDIENCES`.',
      ).toContain(res.status);

      const c = res.body;
      expect(c.status, `a "${audience}" campaign was not created pending`).toBe('pending');

      /**
       * REACH IS ASSERTED AS A SHAPE, NOT AS A NUMBER. The per-audience arithmetic is
       * Lane A's `campaignAudience.int.test.ts`; what matters here is that the server
       * computed one at all, because `computeReach` is the database work `POST /campaigns`
       * does before the insert and it is where the 500 came from.
       */
      expect(
        Number.isInteger(c.reach),
        `reach for "${audience}" came back as ${JSON.stringify(c.reach)}`,
      ).toBe(true);
      expect(c.reach).toBeGreaterThanOrEqual(0);

      // #8's first half still holds for every audience, not only for `gold`.
      expect(
        sendsFor(c.id),
        `a merchant-submitted "${audience}" campaign wrote delivery rows`,
      ).toBe(0);
    });
  }

  // ----------------------------------------------------- 2. the release path --
  /**
   * THE PLATFORM RELEASES IT AND THE SENDS COMMIT, one spec per audience.
   *
   * This is the SECOND 500, and it is the one a merchant could not have worked around:
   * `resolveAudience` runs again at `deliverCampaign` step 3 — #8's "caps and quiet hours
   * are enforced again at send time", which cannot be enforced against an audience
   * without resolving one — so an already-approved `lapsed` campaign could not be
   * released either.
   *
   * STEP 3 IS AFTER THE QUIET-HOURS AND MONTHLY-CAP HOLDS, which is why `policy()` sets
   * a window that avoids this instant and restores the default cap first: a campaign held
   * at step 1 or step 2 never resolves an audience at all, and would be a green run that
   * proved nothing. `policy()` sets the whole policy absolutely for the reason its own
   * docstring gives.
   */
  for (const audience of AUDIENCES) {
    it(`the platform releases an approved "${audience}" campaign and the sends commit`, async () => {
      clearCampaigns();
      policy(quietWindowAvoiding());

      const c = await submit(`aud-release-${audience}`, 'now', audience);

      /**
       * THE FIXTURE, NOT THE CODE, IS WHAT THIS PRECONDITION IS ABOUT. `seedAudience()`
       * puts somebody in all five audiences at salon B — three gold members for `gold`,
       * `new` and `all`, and `QA-CMP-0004` for `lowbal` — so an empty one here means the
       * fixture stopped covering this audience, not that delivery is broken. Reported as
       * a precondition so the two cannot be confused.
       *
       * The one way this fires without a fixture change: a run that crosses a UTC month
       * boundary mid-file empties `new`, because `joined_at` lands in the previous month
       * while the predicate's month start has moved on. Sub-second per month, named here
       * rather than engineered around.
       */
      precondition(
        c.reach > 0,
        `no consenting member of salon B is in the "${audience}" audience, so this spec ` +
          'cannot prove a send. `seedAudience()` is meant to populate all five — check it ' +
          'before reading this as a delivery defect.',
      );

      const decision = await decide(c.id, 'approved');
      expect(
        decision.status,
        `the platform decision on a "${audience}" campaign answered ${decision.status}.\n` +
          `${decision.raw}\n\nA 500 here is the RELEASE half of the same bug: ` +
          '`deliverCampaign` step 3 resolves the audience again, so a predicate that cannot ' +
          'bind fails on the platform endpoint as well as on the merchant one.',
      ).toBe(200);

      const delivery = decision.body.delivery;
      expect(
        delivery,
        `a "${audience}" campaign approved for immediate send reported no delivery outcome`,
      ).not.toBeNull();
      expect(
        delivery?.heldReason,
        `the "${audience}" campaign was HELD rather than sent: ${delivery?.heldReason}. ` +
          'The policy was set to avoid quiet hours and to the default monthly cap, and the ' +
          'audience is non-empty, so none of the three holds should be reachable.',
      ).toBeNull();
      expect(decision.body.campaign.status).toBe('sent');

      /**
       * THE ROWS, AFTER THE TRANSACTION COMMITTED — which is the claim Lane A's int suite
       * deliberately does not make, because its releases run inside a rolled-back
       * transaction. `campaign_send` is what the weekly cap counts, so its survival is
       * not a detail.
       */
      const sent = delivery?.sent ?? 0;
      expect(sent, `the "${audience}" campaign reported ${sent} recipients`).toBeGreaterThan(0);
      expect(
        sendsFor(c.id),
        `the "${audience}" release reported ${sent} sends and the database holds ` +
          `${sendsFor(c.id)}. The reply is not evidence about the rows it wrote.`,
      ).toBe(sent);

      /**
       * AND THE TWO CALL SITES AGREE. `reach` was computed by `computeReach` at
       * SUBMISSION and the recipients by `resolveAudience` at RELEASE — the same
       * predicate, two endpoints, a commit in between. A predicate that resolved
       * differently on the two paths would show up here and nowhere else, because
       * nothing else in the product holds both numbers at once.
       */
      expect(
        sent + (delivery?.cappedOut ?? 0),
        `the "${audience}" audience was ${c.reach} people when the reviewer approved it and ` +
          `${sent} + ${delivery?.cappedOut ?? 0} when it went out. The number a platform ` +
          'reviewer decides against must be the number that is reached.',
      ).toBe(c.reach);
    });
  }

  // ------------------------------------------------- 3. the exact round trip --
  it('the full round trip for a NON-GOLD audience: lowbal reaches the low-balance customer and no gold one', async () => {
    /**
     * WHO ACTUALLY RECEIVED IT, which is the claim the loops above cannot make: they
     * assert shapes and an invariant across five audiences of unknown size, and that is
     * all a derived spec can honestly say.
     *
     * ASSERTED AS PROPERTIES OF THE PREDICATE, NOT AS A COUNT. § LOWBAL records the
     * first draft of this spec, which counted, and why counting was wrong. The three
     * claims here are:
     *
     *   1. the low-balance fixture IS reached — the audience is not empty
     *   2. NO gold fixture is reached — and this is the one a `gold`-pinned suite could
     *      never make. All three are members of salon B, all three have marketing
     *      consent, and all three must be excluded. A predicate that quietly returned
     *      every member of the salon — the shape a mislaid `and()` produces — passes a
     *      count assertion with a bigger number and fails this one by name.
     *   3. every recipient really is under the threshold, checked against
     *      `member.balance_fils` itself rather than against a list of expected ids.
     *
     * (3) IS THE ONE NOTHING ELSE IN THE PRODUCT ASSERTS at any layer. Lane A's
     * `campaignAudience.int.test.ts` requires `resolveAudience` to return an array of
     * strings and `computeReach` a non-negative integer — deliberately, because its
     * subject is that the query RUNS. Whether the rows that came back are the rows the
     * audience means is checked here, against the column the predicate claims to filter
     * on.
     */
    clearCampaigns();
    policy(quietWindowAvoiding());

    const c = await submit('aud-exact-lowbal', 'now', 'lowbal');
    const decision = await decide(c.id, 'approved');
    expect(decision.status, decision.raw).toBe(200);
    expect(decision.body.campaign.status, 'the lowbal campaign did not send').toBe('sent');
    expect(decision.body.campaign.heldReason).toBeNull();

    const reached = sentTo(c.id);
    expect(
      reached,
      `${LOWBAL} holds ${LOWBAL_BALANCE_FILS} fils, which is under LOW_BALANCE_FILS, and did ` +
        `not receive the lowbal campaign. Reached: ${reached.join(', ') || '(nobody)'}`,
    ).toContain(LOWBAL);

    for (const gold of AUD) {
      expect(
        reached,
        `${gold} holds 50000 fils — ten times LOW_BALANCE_FILS — and received a "lowbal" ` +
          'campaign. A non-gold audience delivering to the gold fixtures means the predicate ' +
          'is not filtering at all.',
      ).not.toContain(gold);
    }

    /**
     * THE PREDICATE AGAINST THE COLUMN. `LOW_BALANCE_FILS` is private to
     * `services/campaign.ts`, so the threshold is mirrored here — and a divergence
     * between the two shows up as this spec going red rather than as silence, which is
     * the only reason a mirrored constant is acceptable.
     */
    const overThreshold = scalar(
      `select coalesce(string_agg(m.id || ' = ' || m.balance_fils, ', ' order by m.id), '')
         from campaign_send s join member m on m.id = s.member_id
        where s.campaign_id = '${c.id}' and m.balance_fils >= ${LOW_BALANCE_FILS_MIRROR}`,
    );
    expect(
      overThreshold,
      'the lowbal campaign reached customers who are NOT low on balance: ' +
        `${overThreshold}. Either the predicate is wrong or LOW_BALANCE_FILS moved away ` +
        `from the ${LOW_BALANCE_FILS_MIRROR} mirrored in this file.`,
    ).toBe('');

    expect(
      reached.length,
      `the reviewer approved a reach of ${c.reach} and ${reached.length} customers were ` +
        'reached. `computeReach` and `resolveAudience` disagreed across the two endpoints.',
    ).toBe(c.reach);

    /**
     * THE MERCHANT'S OWN VIEW, because the decision reply is the PLATFORM's view of the
     * same row and the merchant is who reads `result`. `services/campaign.ts`: "the
     * design's Decided list renders it verbatim".
     */
    const wire = await fromWire(c.id);
    expect(wire?.status, 'the merchant does not see her non-gold campaign as sent').toBe('sent');
    expect(wire?.result, 'the merchant reads no delivery result for a non-gold audience').toBe(
      `${reached.length} reached`,
    );
    expect(
      auditRows(c.id, 'Campaign released'),
      'the platform kept no record of releasing a non-gold campaign',
    ).toBe(1);
  });

  it('the lapsed branch — the one that answered 500 — submits, releases, and commits its sends', async () => {
    /**
     * NAMED ON ITS OWN, THOUGH THE LOOPS ABOVE COVER IT. Lane A's
     * `campaignAudience.test.ts` gives the reason and it holds here too: the loop would
     * catch a regression, but a named spec is what a bisect run reads, and this is the
     * branch that has to keep working.
     *
     * WHAT IT ADDS OVER THE LOOP is the membership claim. `lapsed` is "no settled charge
     * in 60 days", and all four campaign fixtures have no transactions at all — the
     * deliberate inclusion `services/campaign.ts` argues for at length, since "a customer
     * who signed up and never came is the strongest case in a 'we miss you' audience".
     * A superset rather than an equality, for the reason § LAPSED_COHORT gives.
     */
    clearCampaigns();
    policy(quietWindowAvoiding());

    const c = await submit('aud-lapsed', 'now', 'lapsed');
    expect(
      c.reach,
      `the lapsed audience is ${c.reach} people; the four consenting fixtures at salon B ` +
        'have no settled charge at all, so it cannot be fewer than four.',
    ).toBeGreaterThanOrEqual(LAPSED_COHORT.length);

    const decision = await decide(c.id, 'approved');
    expect(
      decision.status,
      `releasing an approved lapsed campaign answered ${decision.status}: ${decision.raw}`,
    ).toBe(200);
    expect(decision.body.campaign.status).toBe('sent');
    expect(decision.body.campaign.heldReason).toBeNull();

    const reached = sentTo(c.id);
    for (const id of LAPSED_COHORT) {
      expect(
        reached,
        `${id} has never been charged and did not receive the "we miss you" campaign. ` +
          `Reached: ${reached.join(', ') || '(nobody)'}`,
      ).toContain(id);
    }
    expect(heldNotifications(c.id), 'a campaign that sent left a hold on the merchant bell').toBe(0);
  });
});
