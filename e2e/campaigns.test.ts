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

    INSERT INTO member_consent_event (member_id, salon_id, kind, granted, source, policy_version)
    SELECT m.id, '${SALON_B}', 'marketing_offers', true, 'signup', 3
      FROM member m
     WHERE m.id IN ('${AUD[0]}', '${AUD[1]}', '${AUD[2]}')
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

/** A `pending` campaign at salon B, submitted by the merchant, audience `gold`. */
async function submit(label: string, when = 'now'): Promise<CampaignBody['campaign']> {
  /**
   * `POST /v1/salons/:id/campaigns` answers with the campaign UNWRAPPED — `reply.code(201)
   * .send(serialiseCampaign(row, ...))` — while `POST /v1/platform/campaigns/:cid/decision`
   * answers `{ campaign, delivery }`. Two shapes for the same entity on two endpoints,
   * which is worth naming here because the first draft of this file assumed the wrapper on
   * both and read `undefined.status`. Reported to lane A as an inconsistency, not a defect.
   */
  const res = await treq<CampaignBody['campaign']>('POST', `/v1/salons/${SALON_B}/campaigns`, {
    token: merchant,
    idempotencyKey: key(label),
    body: {
      title: `QA ${label}`,
      body: 'Twenty percent off blow-dries this week.',
      channel: 'push',
      audience: 'gold',
      when,
      ...(when === 'later' ? { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() } : {}),
    },
  });
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
