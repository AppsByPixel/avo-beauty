/**
 * THE PERMISSION CENSUS — non-negotiable #7, made self-maintaining.
 *
 * #7: "Permissions are enforced server-side. The UI hiding a button is a courtesy, not a
 * control. Every gated endpoint needs a test that calls it directly with the permission
 * off." `authority.test.ts` probes NINE endpoints — one per permission — and its own title
 * claims it covers all nine, a criterion that passes while #7's real requirement went
 * unmet on twenty-two. `design/go-live-checklist.md` records that gap across three Lane D
 * passes and each time names the same missing thing: a census that enumerates the gates
 * FROM SOURCE and demands a probe for each. This is it.
 *
 * WHY THE EXISTING CENSUS COULD NOT DO IT. `contract.test.ts`'s unclassified check walks
 * GET routes only, so every gated POST, PATCH, PUT and DELETE is invisible to it — and
 * that is MOST of the surface. Counted rather than estimated, at the time of writing:
 * 57 gated endpoints, of which 21 are GET and **36 are not** — 16 POST, 9 PATCH, 8 DELETE,
 * 3 PUT. Nearly two thirds of the gates in this API were outside the reach of the only
 * census that existed.
 *
 * THE PROBES ARE GENERATED, WHICH IS THE WHOLE POINT.
 *
 * Nothing here is a hand-maintained list of what has been covered. `censusOfRoutes()`
 * reads `api/src/routes/`, and every gated endpoint it finds becomes an `it()` on the
 * spot. So:
 *
 *   - a NEW gated endpoint gets a probe automatically, and fails BY NAME if its gate does
 *     not hold — nobody has to remember to add one
 *   - an endpoint gated on the WRONG permission fails by name, because the refusal copy is
 *     permission-specific
 *   - a gate that is not the FIRST statement fails by name, because something else answers
 *     before the 403
 *   - a route with no gate and no scope guard at all must be named in ANONYMOUS below,
 *     with a reason, or this file goes red
 *
 * That last clause is the `AR_GAPS` property trunk asked for: a future endpoint cannot be
 * added without either a probe or a deliberate, visible exemption.
 *
 * ASSERTING ON THE THING, NOT THE STRING — and the first draft of this file proved why it
 * matters, twice. A name-based reading reported `GET /members`, `GET /members/:id` and
 * `GET /salons/:id/products` as UNGATED. All three are gated; the guards arrive through
 * local helpers (`requireDirectoryScanner`, `productReadGate`). A customer-directory read
 * and a shopfront read, reported as open, by the very check meant to find that. Wrappers
 * are now resolved structurally — see `support/perm-census.ts` — and the source text is
 * used for ONE purpose only: deciding which permission to switch off. What decides whether
 * a gate exists is the request.
 *
 * WHAT EACH REFUSAL ASSERTS, and why the message is in there. Every permission refusal
 * carries code `forbidden`, so the code alone cannot say WHICH permission answered — and
 * `requireSameSalon` and the surface walls also answer 403 with the same code. The
 * permission's own copy is the only discriminator, it is a real product requirement (the
 * scanner renders it verbatim to a staff member standing in front of a customer), and
 * `authority.test.ts` already pins it for that reason. So each probe asserts status 403,
 * code `forbidden`, AND the copy for the permission the census attributed — three
 * assertions where the third is what makes the first two mean something.
 *
 * AND A 403 IS NOT EVIDENCE ON ITS OWN. `DECISIONS.md` dcf1e2e: a status code says nothing
 * about which guard answered, and a 404 from a missing route is the same three digits as a
 * 404 from a real refusal. So every probe is MIRRORED — the permission granted, the same
 * call, and the refusal must stop. Where granting would WRITE, the mirror is skipped and
 * the endpoint is named in `MIRROR_WOULD_WRITE` with what it would have done. That is the
 * same reasoning `authority.test.ts` applies through `controlIsRead`, generalised.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  ambiguousRegistrations,
  censusLedger,
  censusOfRoutes,
  nameOf,
  pairOf,
  registrationsIn,
  singleArgumentCallSites,
  stripComments,
  type GatedRoute,
} from './support/perm-census.js';
import {
  B_AUTH_PIN_DEVICE,
  B_STAFF_AUTH_PIN,
  B_STAFF_AUTH_PIN_HANDLE,
  B_STAFF_AUTH_WEB,
  B_STAFF_AUTH_WEB_HANDLE,
  PLATFORM_ADMIN2,
  PLATFORM_ADMIN2_HANDLE,
  SALON_B,
  psql,
  resetPinState,
  scalar,
  signInDashboard,
  signInPlatform,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

// ---------------------------------------------------------------- the tables --

/** `auth/principal.ts` § PERMISSION_COPY. The nine merchant permissions. */
const PERMISSION_COPY: Record<string, string> = {
  dashboard: "You don't have permission to see the dashboard. A manager can grant it.",
  appointments: "You don't have permission to see appointments. A manager can grant it.",
  shop: "You don't have permission to see the shop. A manager can grant it.",
  loyalty: "You don't have permission to change loyalty settings. A manager can grant it.",
  team: "You don't have permission to manage the team. A manager can grant it.",
  scanner: "You don't have permission to scan and charge. A manager can grant it.",
  charges: "You don't have permission to see today's charges. A manager can grant it.",
  void: "You don't have permission to void a charge. A manager can grant it.",
  marketing: "You don't have permission to submit a campaign. A manager can grant it.",
};

/** `auth/principal.ts` § SECTION_COPY. The nine console sections. */
const SECTION_COPY: Record<string, string> = {
  analytics: 'Your console account cannot open Analytics. The platform owner can grant it.',
  activity: 'Your console account cannot open Activity. The platform owner can grant it.',
  salons: 'Your console account cannot open Salons. The platform owner can grant it.',
  accounts: 'Your console account cannot open Accounts. The platform owner can grant it.',
  admins: 'Your console account cannot manage admins. The platform owner can grant it.',
  controls:
    'Your console account cannot change platform controls. The platform owner can grant it.',
  approvals: 'Your console account cannot decide campaigns. The platform owner can grant it.',
  policies:
    'Your console account cannot edit or publish policies. The platform owner can grant it.',
  audit:
    'Your console account cannot read the platform audit log. The platform owner can grant it.',
};

const PERM_COLUMN: Record<string, string> = {
  dashboard: 'perm_dashboard',
  appointments: 'perm_appointments',
  shop: 'perm_shop',
  loyalty: 'perm_loyalty',
  team: 'perm_team',
  scanner: 'perm_scanner',
  charges: 'perm_charges',
  void: 'perm_void',
  marketing: 'perm_marketing',
};

const SECTION_COLUMN: Record<string, string> = {
  analytics: 'perm_analytics',
  activity: 'perm_activity',
  salons: 'perm_salons',
  accounts: 'perm_accounts',
  admins: 'perm_admins',
  controls: 'perm_controls',
  approvals: 'perm_approvals',
  policies: 'perm_policies',
  audit: 'perm_audit',
};

// ------------------------------------------------------- the two exemptions --

/**
 * Routes with NO permission gate and NO scope guard: reachable with no credential at all.
 *
 * Every one needs a reason, and the list must stay short. A new entry appearing here is a
 * new unauthenticated endpoint, which is a thing somebody should have to defend — so this
 * spec fails naming it rather than letting it in quietly.
 */
const ANONYMOUS: Record<string, string> = {
  'POST /auth/member/signup': 'creating the account IS the credential; rate limited by IP',
  'POST /auth/member/session': 'the customer front door',
  'POST /auth/web/session': 'the merchant dashboard front door',
  'POST /auth/platform/session': 'the owner console front door',
  'POST /auth/refresh': 'the refresh token is the credential, and is checked as one',
  'POST /auth/staff/password-reset':
    'unauthenticated by necessity — she cannot sign in yet. The link is the credential.',
  /**
   * THE MEMBER RESET PAIR, arriving with dev `0a2a6ca` and caught here BY NAME on the
   * first run after the rebase — the ledger's whole purpose. Both halves are
   * unauthenticated for the same structural reason the staff and console halves are: a
   * customer who has forgotten her password has no credential to present.
   *
   * The REQUEST half is different in kind from the other two issue endpoints, and that
   * difference is why it belongs here rather than being gated: there is no manager
   * asking on her behalf, the caller merely CLAIMS a phone. `routes/auth.ts` takes that
   * seriously — the rate limit runs before the phone is even parsed, and it answers 202
   * with one indistinguishable body whether or not the phone holds a wallet, so it
   * cannot be turned into a customer-book enumeration oracle.
   */
  'POST /auth/member/password-reset/request':
    'the customer asks for her own reset link, holding no credential — that is the ' +
    'premise. Open by necessity and defended by posture instead: IP rate limit BEFORE ' +
    'the phone is parsed, and a constant 202 regardless of whether the phone matches, ' +
    'so it is not a member-enumeration oracle. Identity is (salonId, phone), not phone ' +
    'alone, because one phone can hold wallets at two salons.',
  'POST /auth/member/password-reset':
    'the redeem half — the link IS the credential, exactly as the staff and console ' +
    'redeem endpoints are open for. Single-use, hashed, expiring. The console twin is ' +
    'driven end to end in console-reset.test.ts; this one is owed the same treatment ' +
    'and is named in the report as the next slice rather than assumed equivalent.',
  'POST /auth/platform/password-reset':
    'the same, for the console. Driven end to end in console-reset.test.ts.',
  'POST /staff/session': 'the scanner PIN front door, device-scoped and rate limited',
  /**
   * THE PAYMENT WEBHOOK, AND IT IS IN THIS LEDGER ONLY BECAUSE THE CENSUS CAN FINALLY
   * SEE IT.
   *
   * Until the receiver widening in `support/perm-census.ts`, this route was not ungated —
   * it was ABSENT. It registers on `scoped`, an encapsulated Fastify context that carries
   * its own raw-body parser, so a `REGISTRATION` pattern anchored on `app.` never
   * enumerated it. It sat outside `totalRoutes`, outside this ledger, and outside every
   * generated probe, which means this file could not have reported a hole in it. The
   * unauthenticated endpoint whose job is to ADD MONEY TO A WALLET was the one route the
   * permission census did not know existed.
   *
   * WHY IT IS LEGITIMATELY ANONYMOUS. A PSP posts this; there is no principal to gate on
   * and there never will be. Its defence is not a permission at all — it is
   * `gateway.verifySignature(raw, req.headers)` at `webhooks.ts:93`, an HMAC over the raw
   * body with a timestamp tolerance.
   *
   * WHAT THIS LINE DOES AND DOES NOT BUY. It makes the route's unauthenticated status a
   * recorded decision rather than an absence, and it makes the NEXT encapsulated route
   * fail this file by name instead of vanishing. It does NOT probe the signature check —
   * an ANONYMOUS entry is an exemption from permission probing by definition. That guard
   * is covered, and covered well, in `gateway.test.ts`: five bad-signature cases each
   * asserting 401 AND that the balance did not move, paired with a correctly-signed
   * control that settles, so a webhook broken shut cannot pass them either.
   */
  'POST /webhooks/:provider':
    'the payment gateway posts this; there is no principal to gate on. Defended by HMAC ' +
    'signature verification over the RAW body with a timestamp tolerance (webhooks.ts:93), ' +
    'not by perms — and driven end to end, including five forgery cases, in gateway.test.ts.',
  'GET /v1/platform/policies':
    'the PUBLISHED legal set. Non-negotiable #10 has the customer app render it before ' +
    'there is a session, so a gate here would break signup. The draft and publish verbs ' +
    'are the gated ones.',
  /**
   * THE DOWNLOAD CAPABILITY, and it is the most interesting line in this ledger because
   * "unauthenticated" is structurally true of it and semantically misleading.
   *
   * There is no `require*` guard in the handler, so the census classifies it here — which
   * is the honest reading of the code and is exactly what lane A wanted it to say: it
   * SPLIT this route out of the `.csv` handler because as a `?dl=` branch the census
   * reported the whole thing GATED, true of the header path and blind to the token path.
   * Verified adversarially after the split: the census now reports the token path with no
   * gate and no scope guard, which is what it is.
   *
   * But it is not OPEN. The token IS the credential — 16 bytes CSPRNG, stored only as a
   * sha256, 60 seconds, single-use and burnt on ANY presentation including one that then
   * fails the permission re-check. And the authority is re-read from the `staff_user` row
   * at redemption: deactivation, a salon mismatch, or the report's own permission having
   * been revoked all refuse. So it is a bearer capability in the path rather than a
   * session in a header, and it carries LESS standing authority than a session, not more.
   *
   * The path placement is why the route silences its own request log: Fastify logs
   * `req.url`, so the raw credential was being written to the server log, defeating
   * `app.ts`'s `redact: ['req.headers.authorization']`. Lane A found that by sweeping the
   * log for `tok_` after driving a download.
   */
  'GET /report-downloads/:token':
    'the CSV download capability. No session guard by necessity — an <a href> cannot send ' +
    'a header — so the token is the credential: 16 bytes CSPRNG, sha256-stored, 60s, ' +
    'single-use, burnt on any touch. Authority is RE-READ from the staff row at ' +
    'redemption, so a revoked permission or a deactivated account stops the download. ' +
    'Owed a driven spec of its own; named in the lane report as the next slice.',
  'GET /_gateway/:ref': 'the sandbox gateway, not a product route',
  'POST /_gateway/:ref': 'the sandbox gateway, not a product route',
};

/**
 * Gated endpoints whose GRANTED mirror is skipped, with what granting would have done.
 *
 * The mirror exists to prove a 403 came from the gate rather than from a broken route. For
 * a read, granting and taking a 200 is free. For these, granting and firing the request
 * would publish, discard, or overwrite real state in the run database — and a later suite
 * asserting against that state would fail for a reason that has nothing to do with it.
 * Their gate is proved by the refusal plus the permission-specific copy, which already
 * distinguishes it from every other 403 the API can produce.
 */
const MIRROR_WOULD_WRITE: Record<string, string> = {
  'PUT /salons/:id/loyalty': 'publishes a tier ladder — a half-published ladder is a money bug',
  'PUT /v1/salons/:id/promotions/boosts': 'overwrites the salon\'s boost set',
  'PATCH /salons/:id':
    'writes salon settings — brand colour, deposit, modules, timezone, hours, social. '  +
    'It said "including the loyalty mode" until decision 79 moved the five loyalty ' +
    'fields out of MERCHANT_EDITABLE; this door no longer writes any of them, and a ' +
    'merchant who sends one gets 403 loyalty_read_only rather than a write.',
  'PATCH /v1/platform/settings': 'moves the commission that prices every top-up',
  'PATCH /v1/platform/messaging-policy': 'rewrites the caps and quiet hours #8 enforces',
  'POST /v1/platform/policies/publish': 'publishes the legal set and stamps a version',
  'POST /v1/platform/policies/discard': 'destroys the current draft',
};

// ------------------------------------------------------------ path building --

/**
 * A concrete path for a probe.
 *
 * THE SALON ID MUST BE THE PROBE'S OWN SALON. `requireSameSalon` throws 403 too — with
 * `'That salon is not yours.'` — so a foreign salon id would produce a 403 for the wrong
 * reason, and the granted mirror would keep refusing and report a gate that is not there.
 * The copy assertion would catch it, but building the path correctly is better than
 * catching it afterwards.
 *
 * EVERY OTHER PARAMETER IS DELIBERATELY BOGUS. A permission gate is the handler's first
 * statement, so it fires before any lookup — and on the granted mirror a nonexistent id
 * yields 404 or 400, which is all the mirror needs ("no longer refused for authority")
 * while guaranteeing the call cannot delete a staff member, cancel a campaign or retire a
 * product as a side effect.
 */
const MISSING = 'ZZ-NO-SUCH-THING';

function pathFor(r: GatedRoute): string {
  let out = r.path;
  // `/salons/:id`, `/v1/salons/:id/...` — the tenant segment.
  out = out.replace(/^(\/v1)?\/salons\/:id/, (m) => m.replace(':id', SALON_B));
  // Everything else: a value nothing resolves to.
  out = out.replace(/:[A-Za-z]+/g, MISSING);
  return out;
}

/** An empty object for verbs that take a body. A missing body is a different refusal. */
const bodyFor = (r: GatedRoute): unknown =>
  r.method === 'GET' || r.method === 'DELETE' ? undefined : {};

// ----------------------------------------------------------------- fixtures --

const census = censusOfRoutes();
const probeable = census.gated;
const merchantGates = probeable.filter((g) => g.surface !== 'platform');
const platformGates = probeable.filter((g) => g.surface === 'platform');

let web = '';
let pin = '';
let salem = '';

function revokeAllMerchant(): void {
  const off = Object.values(PERM_COLUMN)
    .map((c) => `${c} = false`)
    .join(', ');
  psql(
    `UPDATE staff_user SET ${off} WHERE id IN ('${B_STAFF_AUTH_WEB}', '${B_STAFF_AUTH_PIN}');`,
  );
}

/**
 * Grant exactly one permission. `void` needs `charges` with it: the database CHECK refuses
 * that combination, and `permsOf` filters `void` through `charges` again, so an effective
 * void without charges is not a state that can exist.
 */
function grantMerchant(staffId: string, perm: string): void {
  const cols = perm === 'void' ? [PERM_COLUMN.charges, PERM_COLUMN.void] : [PERM_COLUMN[perm]];
  psql(`UPDATE staff_user SET ${cols.map((c) => `${c} = true`).join(', ')} WHERE id = '${staffId}';`);
}

const grantAllSections = (): void => {
  psql(`
    UPDATE platform_admin SET
      perm_analytics = true, perm_activity = true, perm_salons = true, perm_accounts = true,
      perm_admins = true, perm_controls = true, perm_approvals = true, perm_policies = true,
      perm_audit = true, active = true
    WHERE id = '${PLATFORM_ADMIN2}';
  `);
};

const setSection = (section: string, on: boolean): void => {
  psql(
    `UPDATE platform_admin SET ${SECTION_COLUMN[section]} = ${on} WHERE id = '${PLATFORM_ADMIN2}';`,
  );
};

const tokenFor = (r: GatedRoute): string => (r.surface === 'scanner' ? pin : web);
const staffFor = (r: GatedRoute): string =>
  r.surface === 'scanner' ? B_STAFF_AUTH_PIN : B_STAFF_AUTH_WEB;

beforeAll(async () => {
  await startTenancyApi();
  revokeAllMerchant();
  grantAllSections();
  resetPinState(B_STAFF_AUTH_PIN, B_AUTH_PIN_DEVICE);
  web = await signInDashboard(SALON_B, B_STAFF_AUTH_WEB_HANDLE);
  pin = await signInScanner(SALON_B, B_STAFF_AUTH_PIN_HANDLE, B_AUTH_PIN_DEVICE);
  salem = await signInPlatform(PLATFORM_ADMIN2_HANDLE);
}, 180_000);

afterAll(async () => {
  revokeAllMerchant();
  grantAllSections();
  await stopTenancyApi();
});

// ===========================================================================

describe('the census reads the route table, and the reading is itself checked', () => {
  it('finds every route file and a plausible number of routes', () => {
    expect(census.files.length, 'no route files were read at all').toBeGreaterThan(15);
    expect(
      census.totalRoutes,
      'the registration regex matched almost nothing, so every count below is meaningless',
    ).toBeGreaterThan(80);
    /**
     * COUNTED BY REGISTRATION, not by probe. One registration whose permission is chosen
     * through a lookup table expands into one PROBE per key — the five reports kinds — so
     * `gated.length` legitimately exceeds the number of routes. `route` carries the path
     * as registered, which is what has to reconcile with the scan.
     *
     * This assertion caught its own obsolescence the run after the expansion landed, which
     * is the right outcome: an invariant that silently absorbed a 4-for-1 change would
     * stop being able to detect a route going missing.
     */
    const registrations = new Set([
      ...census.gated.map((g) => `${g.method} ${g.route}`),
      ...census.ungated.map((u) => `${u.method} ${u.path}`),
    ]);
    expect(
      registrations.size,
      'the classified registrations do not reconcile with the routes scanned, so some ' +
        'route was counted twice or dropped',
    ).toBe(census.totalRoutes);
  });

  /**
   * THE COUNTS, PINNED — as a floor, not an equality. An exact number would go red every
   * time lane A ships an endpoint, which trains people to update the number without
   * reading why it moved; that is how the "29 call sites" in an earlier brief became 31 in
   * a census and 35 here. A floor catches the thing that actually matters — gates
   * DISAPPEARING — and lets new ones through to be probed.
   */
  it('sees at least the gates counted when this file was written', () => {
    expect(merchantGates.length, 'merchant gates went DOWN — a gate was removed').toBeGreaterThanOrEqual(38);
    expect(platformGates.length, 'console gates went DOWN — a section gate was removed').toBeGreaterThanOrEqual(19);
  });

  it('resolves every gate to a permission it can name', () => {
    const unresolved = census.gated.filter((g) => g.permission === '');
    expect(
      unresolved.map((g) => `${nameOf(g)} (${g.file}:${g.line})`),
      'a gate was found whose permission this census cannot name, so no probe can know ' +
        'what to revoke. If it is chosen through a lookup table, the table needs to be ' +
        'shaped so `discoverPermissionMaps` can read it; if it is computed some other ' +
        'way, the endpoint ships with a gate nothing drives.',
    ).toEqual([]);
  });

  /**
   * THE LOOKUP TABLE IS READ, NOT COPIED — and this spec is why that distinction is worth
   * the parser. `routes/reports.ts` gates on `REPORT_PERMISSION[kind]`, so the permission
   * is not a literal. The first fix was a hand-kept ledger naming the two reports routes,
   * and it broke within a day: lane A added a THIRD (`POST …/download-url`) and the
   * ledger, listing two, failed on it. An exemption list needs an entry per route.
   *
   * So the map is parsed out of `api/src` and each indexed gate EXPANDS into one probe per
   * key. A kind added to `REPORT_PERMISSION` is probed on the next run with no edit here —
   * which is the same property that makes the census worth more than its green count.
   */
  it('read REPORT_PERMISSION from source and expanded every kind into its own probe', () => {
    const map = census.permissionMaps.find((m) => m.name === 'REPORT_PERMISSION');
    expect(
      map,
      'REPORT_PERMISSION was not found in api/src. Either it moved, or its shape changed ' +
        'past what discoverPermissionMaps reads — and the reports gates are now unprobed.',
    ).toBeDefined();

    /**
     * The mapping itself, pinned. This is the one place the five pairs are written down in
     * this suite, and it is an ASSERTION against the source rather than a copy used to
     * build probes: the probes come from the parsed map, so if this disagrees with lane
     * A's file the spec fails instead of quietly probing the wrong permission.
     *
     * The pairs matter beyond bookkeeping — they are the FRONTDESK property, and it is
     * stated here against the SEED rather than against a preset table, because there is
     * no preset table: `staff_user.role` is a bare enum label and the nine permissions
     * are nine independent booleans per row (db/schema/staff.ts), so "the frontdesk
     * preset holds X" is only ever a claim about what `db/seed.ts` writes. What it
     * writes for ST-002 Hessa, `role: 'frontdesk'`, is `perm_appointments: true` with
     * `perm_dashboard: false` and `perm_team: false`.
     *
     * So the property that bites is per-kind, not one sentence:
     *
     *   - `customers → team` matters because a salon that grants its front desk
     *     `dashboard` — which several will, it is the tablet's own overview — must not
     *     thereby hand it every customer's name, phone and wallet balance.
     *   - `artist-performance → team` matters against the seed as written: Hessa HOLDS
     *     `appointments`, so gating this kind on the section its rows come FROM would
     *     put every artist's earnings on the front-desk tablet today, with no
     *     permission change by anybody.
     *
     * `team` is also the permission that already gates reading a person's row at all —
     * `GET /staff`, `GET /salons/:id/artists` and `PATCH /staff/:id` are all `→ team`
     * in the ledger below — so nobody can export an artist's takings who could not
     * already open Accounts and read her. That consistency, not an ordering over
     * permissions, is why `team` is the right answer for a row that names a person.
     */
    expect(Object.fromEntries(map!.entries)).toEqual({
      customers: 'team',
      sales: 'dashboard',
      'best-selling-services': 'appointments',
      'products-sold': 'shop',
      'artist-performance': 'team',
    });

    // And every kind really became its own probe, with `:kind` substituted.
    const reportProbes = census.gated
      .filter((g) => g.path.includes('/reports/'))
      .map((g) => `${nameOf(g)} → ${g.permission}`);
    for (const kind of map!.entries.map(([k]) => k)) {
      expect(
        reportProbes.some((r) => r.includes(`/reports/${kind}`)),
        `no probe was generated for reports kind "${kind}". Probes found:\n  ` +
          reportProbes.join('\n  '),
      ).toBe(true);
    }
  });

  it('and every permission it names is a real one', () => {
    const known = new Set([...Object.keys(PERMISSION_COPY), ...Object.keys(SECTION_COPY)]);
    const strange = probeable.filter((g) => !known.has(g.permission));
    expect(
      strange.map((g) => `${pairOf(g)} (${g.file}:${g.line})`),
      'a gate names a permission this spec has no copy for — either a new permission ' +
        'landed and needs adding here, or the census misread an argument',
    ).toEqual([]);
  });

  /**
   * THE COMMENT STRIPPER, tested directly. If it failed open, prose naming a guard would
   * invent gates and prose naming `app.get` would invent routes — and both would pass as
   * green probes against endpoints that do not exist.
   */
  it('does not read guards or routes out of comments', () => {
    const src = [
      "// app.get('/fake/line-comment')  requireDashboardPerm(req, 'team')",
      '/* app.post(\'/fake/block\')  requirePlatform(req, "admins") */',
      "const real = 'app.get(/not-a-route)';",
      "app.get('/actually/here', async () => { requireDashboardPerm(req, 'shop'); });",
    ].join('\n');
    const stripped = stripComments(src);

    expect(stripped, 'a line comment survived').not.toContain('line-comment');
    expect(stripped, 'a block comment survived').not.toContain('fake/block');
    expect(stripped, 'the stripper ate a string literal, which is where route paths live')
      .toContain('app.get(/not-a-route)');
    expect(stripped, 'the stripper ate real code').toContain('/actually/here');
    // Line count is preserved, so reported line numbers point at the right line.
    expect(stripped.split('\n').length).toBe(src.split('\n').length);
  });

  it('and it resolved the wrapper gates rather than calling them ungated', () => {
    const viaWrapper = census.gated.filter((g) => g.via !== null).map(pairOf);
    expect(
      viaWrapper,
      'no wrapper gate was resolved. `requireDirectoryScanner` in routes/members.ts and ' +
        '`productReadGate` in routes/salons.ts are gates under another name; if this is ' +
        'empty the census has regressed to a name-based reading and is reporting ' +
        'customer-directory reads as ungated.',
    ).toContain('GET /members → scanner');
    expect(viaWrapper).toContain('GET /salons/:id/products → shop');
  });
});

// ===========================================================================


// ===========================================================================
// THE COVERAGE PIN — a census that covers less than it did must SAY SO
// ===========================================================================

/**
 * EVERY ROUTE THIS CENSUS COULD READ, AND WHAT IT DECIDED ABOUT IT.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS, WHEN THE FILE ALREADY HAS FOUR SELF-CHECKS
 * ------------------------------------------------------------------------
 * Everything above this line polices the census's READING. Nothing above it polices
 * the census's REACH, and those are different failures:
 *
 *   a misread gate produces a probe that fails BY NAME — that is the whole design
 *   an unread ROUTE produces no probe at all, and no failure, and no name
 *
 * The guards that look like they cover the second do not, and the slack in each of them
 * is measurable rather than arguable:
 *
 *   `totalRoutes > 80` against 129 registrations. FORTY-EIGHT routes can vanish inside
 *   that floor.
 *
 *   `registrations.size === census.totalRoutes` reconciles the scan against ITSELF. A
 *   route that leaves the scan leaves both sides of the equation, so it still balances —
 *   this catches a route counted twice or classified twice, never one that was not read.
 *
 *   `merchantGates >= 38` against 57 today, and `platformGates >= 19` against 33. That is
 *   NINETEEN merchant gates and FOURTEEN console gates of headroom, and the headroom grows
 *   every time lane A ships an endpoint, because a floor on a SUM lets a new gate PAY FOR
 *   a lost one. The four image gates that arrived this week widened it by four.
 *
 * Every one of those is a real check and none of them is this one.
 *
 * ------------------------------------------------------------------------
 * MEASURED, ON THIS TREE, BEFORE ANY OF IT WAS WRITTEN
 * ------------------------------------------------------------------------
 * `api/src/routes/staff.ts` registers the scanner's member resolve as
 * `app.post('/scans', handler)`. Extracting that path — `const SCANS_ROUTE = '/scans'`,
 * then `app.post(SCANS_ROUTE, handler)` — is a refactor nobody would stop at review. It
 * takes this census from 129 routes to 128, and THIS FILE FROM 183 SPECS TO 181, GREEN.
 * The two specs that stopped existing are the permission-off probe and the grant-back
 * probe on `POST /scans → scanner`. Nothing anywhere reported that the API's most
 * security-sensitive scanner write had stopped being probed.
 *
 * That is not hypothetical drift; it is the same defect twice on this project already.
 * `api/src/routes/images.ts` carries lane A's own account of losing four merchant writes
 * to a curried handler factory, and lane C lost an endpoint out of
 * `merchantScopeGates.test.ts` — 44 cases to 43 — by extracting a path into a helper.
 * Both were found by a human noticing, which is the mechanism this suite exists to replace.
 *
 * ------------------------------------------------------------------------
 * WHY A PINNED SET AND NOT A TIGHTER NUMBER
 * ------------------------------------------------------------------------
 * A tighter number was the obvious answer and it is the wrong one. `expect(gates).toBe(90)`
 * goes red every time lane A ships an endpoint, which trains whoever is holding the merge
 * to move the number without reading why it moved — the exact habit the floor above was
 * written to avoid, and how "29 call sites" in one brief became 31 in a census and 35 in
 * this file. A number also cannot say WHICH gate went; a set can, and the name is the only
 * part of the failure that is actionable.
 *
 * So: one line per decision, and TWO specs, because a pin with one is a pin that rots.
 *
 *   NOTHING DISAPPEARS. A pinned line the census no longer produces is a route or a gate
 *   that stopped being readable. It may still be enforced perfectly at runtime — lane A's
 *   four were — and that is precisely the point: it is now UNPROBED, and unprobed is what
 *   #7 forbids.
 *
 *   NOTHING ARRIVES UNPINNED. Without this the pin under-covers a little more with every
 *   merge and ends up policing the 2026 API for ever. It also puts a DELIBERATE ACT in
 *   front of every coverage change: a helper extraction that hides a route can no longer
 *   land quietly, because making this file green again means DELETING a line from a
 *   ledger, in another lane's column, in a diff a reviewer can see.
 *
 * The failure messages print paste-ready blocks, because a ledger that is annoying to
 * amend is a ledger someone will delete.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS STILL DOES NOT CATCH, SAID PLAINLY
 * ------------------------------------------------------------------------
 * A route BORN unreadable was never pinned, so its absence proves nothing.
 * `ambiguousRegistrations()` is the answer to that half and has its own spec below. What
 * neither catches is a NEW route whose registration is readable, whose scope guard is
 * readable, and whose permission gate is two levels of helper down — it would arrive
 * classified as `[requireSalonScoped]`, which is a legitimate shape (`GET /v1/images/:imageId`
 * genuinely is one). It is pinned as such the day it lands, so it can never SILENTLY
 * become that later; whether it should have carried a permission is a judgement this
 * scanner cannot make and a reviewer reading the new ledger line can.
 *
 * ------------------------------------------------------------------------
 * FORMAT
 * ------------------------------------------------------------------------
 *   `POST /scans → scanner`                 gated, and on which permission
 *   `GET /members/me [requireMember]`       authenticated, no permission applies
 *   `POST /webhooks/:provider [ANONYMOUS]`  authenticates nobody; ANONYMOUS above says why
 *
 * A gated route contributes one line PER GATE PATH, not per registration — a disjunctive
 * wrapper contributes two, an indexed permission table one per key. The probe set is the
 * thing that must not shrink, and it stopped equalling the route count the day
 * `REPORT_PERMISSION` was expanded.
 */
const PINNED_COVERAGE: string[] = [
  'DELETE /artists/:id/calendar → team',
  'DELETE /bookings/:id [requireMember]',
  'DELETE /members/me/deletion [requireMember]',
  /**
   * =======================================================================
   * ITEM 7'S SEVEN DOORS — the address book, her order list, and the merchant's
   * fulfilment board. dev `e4b411a`. The census named all seven on the first run
   * after the merge, which is what this half of the pin is for.
   * =======================================================================
   * SEVEN, NOT SIX. The brief that dispatched this slice said "the two merchant
   * routes → shop, and the four member routes as [requireMember]". There are
   * FIVE member routes: `GET` and `POST /members/me/addresses`, `PUT` and
   * `DELETE /members/me/addresses/:id`, and `GET /members/me/orders`. The
   * census's own output is the authority and it listed all five — recorded
   * because a hand-counted ledger line is exactly the thing this pin exists to
   * stop anyone trusting, including when the hand belongs to trunk.
   *
   * `[requireMember]` IS THE RIGHT CLASSIFICATION AND IT IS THE INTERESTING ONE.
   * A `[scopeGuard]` line, per this ledger's own header, is "legitimate for a
   * customer's own record or a shared catalog read, and a bug for a merchant
   * write". All five are a customer's own record: no route in `routes/addresses.ts`
   * or the member half of `routes/orders.ts` reads a member id from a path, a query
   * or a body, so the principal IS the scope. `POST /members/me/addresses` goes
   * further and REFUSES a `memberId` in the body by name
   * (`member_not_client_supplied`) rather than ignoring it, which is the
   * treatment `POST /orders` gives a client-supplied price.
   *
   * BUT "THE PRINCIPAL IS THE SCOPE" IS A CLAIM ABOUT CODE, AND THIS LEDGER
   * CANNOT TEST IT. `PUT` and `DELETE /members/me/addresses/:id` take an ADDRESS
   * id in the path, and what keeps one customer out of another's book is the
   * second term of a WHERE clause — `eq(memberAddress.memberId, p.id)` — not a
   * guard the census can read. A `[requireMember]` line is byte-identical whether
   * that term is there or not. So the cross-member probe is driven directly, by
   * request, in `delivery-address-privacy.test.ts` § "one member cannot reach
   * another's address book", and this line is the register that the door exists
   * rather than the evidence it is bolted.
   */
  'DELETE /members/me/addresses/:id [requireMember]',
  'DELETE /salons/:id/branches/:bid → loyalty',
  'DELETE /salons/:id/devices/:deviceId → dashboard',
  'DELETE /salons/:id/products/:pid → shop',
  'DELETE /staff/:id → team',
  'DELETE /v1/platform/admins/:id → admins',
  'DELETE /v1/platform/policies/draft/:docId → policies',
  'DELETE /v1/platform/support/topics/:id → policies',
  'DELETE /v1/salons/:id/campaigns/:cid → marketing',
  'DELETE /v1/salons/:id/products/:oid/image → shop',
  'DELETE /v1/salons/:id/promotions/happy-hours/:hid → marketing',
  'DELETE /v1/salons/:id/services/:oid/image → appointments',
  'DELETE /v1/vouchers/:id → accounts',
  'GET /_gateway/:ref [ANONYMOUS]',
  'GET /artists/:id/availability [requireSalonScoped]',
  'GET /artists/me [requireScannerScope]',
  'GET /artists/me/bookings [requireScannerScope]',
  'GET /bookings [requireMember]',
  'GET /bookings/:id [requireMember]',
  'GET /charges → charges',
  'GET /members → scanner',
  'GET /members/:id → scanner',
  'GET /members/me [requireMember]',
  'GET /members/me/deletion [requireMember]',
  'GET /members/me/addresses [requireMember]',
  'GET /members/me/notifications [requireMember]',
  'GET /members/me/orders [requireMember]',
  'GET /members/me/policy-acceptance [requireMember]',
  'GET /members/me/transactions [requireMember]',
  'GET /members/me/wallet-token [requireMember]',
  'GET /report-downloads/:token [ANONYMOUS]',
  'GET /salons/:id [requireSalonScoped]',
  'GET /salons/:id/activity → dashboard',
  'GET /salons/:id/artists → team',
  'GET /salons/:id/artists/bookable [requireSalonScoped]',
  'GET /salons/:id/audit → dashboard',
  'GET /salons/:id/bookings → appointments',
  'GET /salons/:id/branches/:bid/closure-preview → loyalty',
  /**
   * THE THREE DEVICE-ENROLMENT DOORS, on dev `45a60a1`, closing decision 82.
   *
   * `→ dashboard` IS CONFIRMED, AND NOT BY THIS LINE. Lane A reports the census
   * derived `dashboard` independently; it did not, and the distinction is worth
   * keeping. `surfaceOf`/`censusOfRoutes` read the LAST QUOTED ARGUMENT of
   * `requirePerm(req, 'either', 'dashboard')` — the same token a reader reads. A pin
   * agreeing with the source there is a tautology, not a second opinion.
   *
   * What DOES confirm it is behavioural and already green: the generated probes below
   * revoke `dashboard` and require a 403 carrying `dashboard`'s OWN copy, then grant
   * `dashboard` alone and require the refusal to stop. A gate on `team`, `marketing` or
   * `scanner` fails both halves by name. So the permission half of the classification is
   * driven by the request, exactly as this file's header promises — and the agreement
   * between this ledger and the source is a separate, weaker fact.
   *
   * THE SURFACE HALF IS CONFIRMED BY NOTHING HERE, AND IT IS THE UNUSUAL HALF.
   * `requirePerm(req, 'either', …)` is the only `'either'` gate in this API, and
   * `GatedRoute['surface']` has no `'either'` member to record it with, so `surfaceOf`
   * collapses it to `'dashboard'` and `tokenFor` hands every probe a WEB session. The
   * scanner door — decision 82's 'Set up this device' flow, and per `routes/devices.ts`
   * the PRIMARY one — is driven by the pair of specs at the bottom of this file rather
   * than by the generated sweep, because the sweep structurally cannot see it. Neither
   * can this ledger line: `→ dashboard` is byte-identical whether the guard says
   * `'either'` or `'dashboard'`.
   */
  'GET /salons/:id/devices → dashboard',
  /**
   * TWO LINES FOR ONE ROUTE, and it is the disjunctive-wrapper case the header
   * describes — "a disjunctive wrapper contributes two". `requireLoyaltyReader`
   * asks a different question of each principal kind: `sections.salons` of the
   * console, `perms.loyalty` + `requireSameSalon` of the merchant. Both gate paths
   * are probed, which is the whole reason the census resolves wrappers rather than
   * reading the first guard it finds.
   *
   * The `→ loyalty` line is UNCHANGED by decision 79. Read-only is the point of the
   * reversal, so the merchant's door here stays exactly where it was; what she lost
   * is the PUT below.
   */
  'GET /salons/:id/loyalty → loyalty',
  'GET /salons/:id/loyalty → salons',
  'GET /salons/:id/metrics → dashboard',
  'GET /salons/:id/products → shop',
  'GET /salons/:id/reports/artist-performance → team',
  'GET /salons/:id/reports/artist-performance.csv → team',
  'GET /salons/:id/reports/best-selling-services → appointments',
  'GET /salons/:id/reports/best-selling-services.csv → appointments',
  'GET /salons/:id/reports/customers → team',
  'GET /salons/:id/reports/customers.csv → team',
  'GET /salons/:id/reports/products-sold → shop',
  'GET /salons/:id/reports/products-sold.csv → shop',
  'GET /salons/:id/reports/sales → dashboard',
  'GET /salons/:id/reports/sales.csv → dashboard',
  'GET /salons/:id/services [requireSalonScoped]',
  'GET /staff → team',
  'GET /staff/me [requireStaff]',
  'GET /topups/:id [requireMember]',
  'GET /v1/images/:imageId [requireSalonScoped]',
  'GET /v1/platform/accounts → accounts',
  'GET /v1/platform/activity → activity',
  'GET /v1/platform/admins → admins',
  'GET /v1/platform/audit → audit',
  'GET /v1/platform/campaigns → approvals',
  'GET /v1/platform/messaging-policy → approvals',
  'GET /v1/platform/metrics → analytics',
  'GET /v1/platform/policies [ANONYMOUS]',
  'GET /v1/platform/policies/draft → policies',
  'GET /v1/platform/salons → salons',
  'GET /v1/platform/salons/:id → salons',
  'GET /v1/platform/settings → controls',
  'GET /v1/platform/support [requirePrincipal]',
  'GET /v1/salons/:id/campaigns → marketing',
  'GET /v1/salons/:id/messaging-policy → marketing',
  'GET /v1/salons/:id/orders → shop',
  'GET /v1/salons/:id/promotions [requireSalonScoped]',
  'GET /v1/support/tickets → dashboard',
  'GET /v1/support/tickets → policies',
  'GET /v1/vouchers → accounts',
  'PATCH /members/me [requireMember]',
  'PATCH /members/me/notifications [requireMember]',
  'PATCH /salons/:id → loyalty',
  'PATCH /salons/:id/branches/:bid → loyalty',
  'PATCH /salons/:id/products/:pid → shop',
  'PATCH /staff/:id → team',
  'PATCH /v1/platform/admins/:id → admins',
  'PATCH /v1/platform/messaging-policy → approvals',
  'PATCH /v1/platform/policies/draft/:docId → policies',
  'PATCH /v1/platform/salons/:id → salons',
  'PATCH /v1/platform/settings → controls',
  'PATCH /v1/platform/support/channels → policies',
  'PATCH /v1/platform/support/topics/:id → policies',
  /**
   * THE MERCHANT FULFILMENT BOARD AND ITS TRANSITION. Both `→ shop`.
   *
   * `→ shop` IS THE RIGHT PERMISSION, AND THE CENSUS AGREEING IS NOT WHY.
   *
   * Lane A reports that the census derived `shop` independently. It did not, and
   * this is the second time the distinction has had to be drawn — the
   * device-enrolment block above draws it for `→ dashboard` and decision 82.
   * `censusOfRoutes` takes "the LAST quoted argument"
   * (`support/perm-census.ts:655`) of `requireDashboardPerm(req, 'shop')`. That
   * is the literal token `'shop'`, the same six characters a reader reads off the
   * source line. A pin agreeing with the source there is a TAUTOLOGY, not a
   * second opinion, and calling it independent corroboration would make every
   * line in this ledger self-confirming.
   *
   * WHAT DOES CONFIRM IT is behavioural and generated from these lines: the sweep
   * revokes `shop`, requires a 403 carrying `shop`'s own refusal copy, then grants
   * `shop` alone and requires the refusal to stop. A gate really written on
   * `dashboard`, `appointments` or `marketing` fails both halves by name. That is
   * non-negotiable #7's second half — "a test that calls it directly with the
   * permission off" — and it is what makes these two lines worth pasting.
   *
   * AND THE CHOICE IS RIGHT ON ITS MERITS, which is a third and separate question
   * the census cannot ask at all. Lane A's argument is that the board carries a
   * customer's DELIVERY ADDRESS, so it must not sit behind `dashboard` — checked
   * and agreed, and the check is `serialiseShopOrder` in `routes/orders.ts:46`,
   * which returns the full snapshot (`block`, `street`, `building`, `floor`,
   * `apartment`, `instructions`, `latitude`, `longitude`) on every delivery row.
   * `dashboard` is the Overview section's permission and the widest chip a
   * receptionist holds; `shop` is the same gate as the catalogue and the
   * `products-sold` report (`services/reports.ts:127`), which is the section this
   * screen belongs to. Not `appointments`, which is a different section entirely.
   *
   * ONE THING THE PERMISSION CANNOT DO, and it is reported rather than pinned: the
   * board has no time horizon. `closed` is in `ORDER_STATUS_FLOW` and the query
   * applies no date floor, so `perms.shop` reads the home address of every
   * delivery customer the salon has ever had, indefinitely — see
   * `delivery-address-privacy.test.ts` § 4, "the board serves the erased order
   * without an address and a live member's closed order in full", which pins both
   * sides of it. A permission decides WHO; retention decides FOR HOW LONG, and
   * nothing in this feature decides the second.
   *
   * ERASURE IS NOT THE HORIZON AND DOES NOT BECOME ONE. Lane A closed
   * DECISIONS.md #97 in `1f6bfb3`, so an order belonging to a member who ASKED to
   * be erased is now served with `address: null`. That narrows the exposure to
   * members who have asked for nothing, which is the whole population minus a
   * handful — so the sentence above is still true and is still nobody's to answer
   * here. `shop_order.address_erased_at` is the column a retention job would set,
   * and today only erasure sets it.
   */
  'PATCH /v1/salons/:id/orders/:tid → shop',
  'PATCH /v1/salons/:id/promotions/happy-hours/:hid → marketing',
  'PATCH /v1/salons/:id/social/:linkId → loyalty',
  'PATCH /v1/support/tickets/:id → dashboard',
  'PATCH /v1/support/tickets/:id → policies',
  'POST /_gateway/:ref [ANONYMOUS]',
  'POST /accounts/:id/reset-link → accounts',
  'POST /artists/:id/calendar/connect → team',
  'POST /auth/member/password-reset [ANONYMOUS]',
  'POST /auth/member/password-reset/request [ANONYMOUS]',
  'POST /auth/member/session [ANONYMOUS]',
  'POST /auth/member/signup [ANONYMOUS]',
  'POST /auth/platform/password-reset [ANONYMOUS]',
  'POST /auth/platform/session [ANONYMOUS]',
  'POST /auth/refresh [ANONYMOUS]',
  'POST /auth/sign-out [requirePrincipal]',
  'POST /auth/staff/password-reset [ANONYMOUS]',
  'POST /auth/web/session [ANONYMOUS]',
  'POST /bookings [requireMember]',
  'POST /bookings/:id/reschedule [requireMember]',
  'POST /charges → scanner',
  'POST /members/:id/adjustments → accounts',
  'POST /members/me/addresses [requireMember]',
  'POST /members/me/deletion [requireMember]',
  'POST /members/me/password [requirePrincipal]',
  'POST /members/me/phone-change [requireMember]',
  'POST /members/me/phone-change/:id/verify [requireMember]',
  'POST /members/me/policy-acceptance [requireMember]',
  'POST /members/me/vouchers/redeem [requireMember]',
  'POST /orders [requireMember]',
  'POST /salons/:id/branches → loyalty',
  'POST /salons/:id/devices → dashboard',
  'POST /salons/:id/products → shop',
  'POST /salons/:id/reports/artist-performance/download-url → team',
  'POST /salons/:id/reports/best-selling-services/download-url → appointments',
  'POST /salons/:id/reports/customers/download-url → team',
  'POST /salons/:id/reports/products-sold/download-url → shop',
  'POST /salons/:id/reports/sales/download-url → dashboard',
  'POST /scans → scanner',
  'POST /staff → team',
  'POST /staff/:id/password-reset → team',
  'POST /staff/session [ANONYMOUS]',
  'POST /topups [requireMember]',
  'POST /v1/platform/admins → admins',
  'POST /v1/platform/admins/:id/password-reset → admins',
  'POST /v1/platform/campaigns/:cid/decision → approvals',
  'POST /v1/platform/policies/discard → policies',
  'POST /v1/platform/policies/draft → policies',
  'POST /v1/platform/policies/publish → policies',
  'POST /v1/platform/salons → salons',
  'POST /v1/platform/support/topics → policies',
  'POST /v1/salons/:id/campaigns → marketing',
  'POST /v1/salons/:id/products/:oid/image → shop',
  'POST /v1/salons/:id/promotions/happy-hours → marketing',
  'POST /v1/salons/:id/services/:oid/image → appointments',
  'POST /v1/support/tickets [requireMember]',
  /**
   * =======================================================================
   * ITEM 10'S FOUR DOORS — AVO issues, AVO lists, AVO voids, she redeems.
   * dev `a1be122`. Registered a slice LATE, and the reason is worth the line:
   * the previous lane D session was briefed on item 7's ledgers and registered
   * them correctly; item 10 merged AFTER that brief, so these four routes did
   * not exist when it was written. The pin did its job — `dev`'s gate sat at
   * 10 of 11 with the census naming all four by path and file, which is the
   * arrival mechanism working rather than a coverage miss.
   *
   * FOUR LINES, NOT THREE. The brief that dispatched this slice relayed lane
   * A's own list as three: `POST|GET /v1/vouchers`, `DELETE /v1/vouchers/:id`,
   * `POST /members/me/vouchers/redeem`. That collapses the POST and the GET
   * into one line, and this ledger is one line PER GATE PATH. The census's own
   * output is the authority and it printed four — the same correction item 7's
   * block above records, arriving the same way, from the same direction.
   *
   * -----------------------------------------------------------------------
   * WHAT CONFIRMS `accounts` HERE, AND WHAT ONLY LOOKS LIKE IT DOES
   * -----------------------------------------------------------------------
   * NOT this line. `perm-census.ts` reads the gate's last quoted argument out
   * of `routes/vouchers.ts`, so a pinned line saying `→ accounts` agrees with
   * the source BY CONSTRUCTION — it would still say `accounts` if the gate
   * were wrong, and it would move in lockstep if someone changed it. Pinning
   * it proves the door is READ, not that it is BOLTED. That distinction has
   * now been established twice in this lane and it is restated here because
   * this is the third route family where the tempting reading is available.
   *
   * WHAT ACTUALLY CONFIRMS IT is the generated console sweep below, and it is
   * a real HTTP call with two properties this ledger has neither of:
   *
   *   - `grantAllSections()` THEN `setSection('accounts', false)`. The probe
   *     admin holds EVERY OTHER SECTION, so a 403 cannot be "no permissions at
   *     all" — it isolates this one. A precondition re-reads the column and
   *     fails if the revoke did not take.
   *   - `expect(res.body.message).toBe(SECTION_COPY.accounts)`. `forbidden` is
   *     also the code for a wrong surface and for a salon-scope refusal, so the
   *     COPY is what says the refusal came from `accounts` and not from
   *     something else that also says no. This is precisely the assertion that
   *     would fail if the census had attributed the wrong permission — which is
   *     the check that keeps the tautology above from mattering.
   *
   * Both directions already ran GREEN on all three console verbs before these
   * lines existed, because the sweep is generated from the census rather than
   * from this ledger. So the behavioural evidence for `accounts` on vouchers
   * predates its registration; what was missing was only the register.
   *
   * -----------------------------------------------------------------------
   * AND WHAT `accounts` NOW GRANTS — read before widening this section
   * -----------------------------------------------------------------------
   * Six routes, across four files, and two of them CREATE MONEY:
   *
   *   POST   /members/:id/adjustments   routes/adjustments.ts   signed wallet delta
   *   POST   /v1/vouchers              routes/vouchers.ts      mints a credit instrument
   *   GET    /v1/vouchers              routes/vouchers.ts
   *   DELETE /v1/vouchers/:id          routes/vouchers.ts      the only recall
   *   POST   /accounts/:id/reset-link  routes/accountResets.ts
   *   GET    /v1/platform/accounts     routes/accounts.ts      the widest read in the product
   *
   * THE BRIEF'S FRAMING IS OFF BY ONE FEATURE AND THE CORRECTION MATTERS.
   * A voucher is NOT the first object that lets AVO put credit into a salon's
   * wallet liability without the salon acting — `POST /members/:id/adjustments`
   * already did, on THIS SAME GATE, and `walletAdjustedPosting` credits
   * `member_wallet` against `gateway_clearing` exactly as
   * `voucherRedeemedPosting` credits it against `avo_voucher_funding`. So item
   * 10 added a second INSTRUMENT on an existing authority, not a new authority.
   * That matters because it dates the exposure below to whenever adjustments
   * and the `support` preset first coexisted, not to `a1be122` — so nobody
   * closes it by reverting vouchers.
   *
   * WHAT IS GENUINELY NEW is that a voucher is DEFERRED. An adjustment moves
   * money at the moment of the act, under the actor's own principal; an issued
   * voucher is a commitment that materialises later, on a `requireMember`
   * endpoint, at a moment the issuer does not choose. `DELETE /v1/vouchers/:id`
   * is the only recall and it stops working the instant she redeems, by both the
   * handler's predicate and `voucher_is_not_both_redeemed_and_voided`.
   *
   * THE PRESET EXPOSURE, AND IT IS LATENT RATHER THAN LIVE.
   * `PLATFORM_ROLE_PRESETS` (`api/src/db/schema/platformAdmin.ts:153-170`, the
   * `support` entry at :166-169) gives
   * `accounts: true` to `support` — the design's "Support — accounts & salons"
   * — alongside `audit: false`. So the support preset carries the power to mint
   * wallet credit and to issue an instrument a customer redeems later, and not
   * the power to read the platform authority log that records either. `analyst`
   * is correctly `accounts: false`.
   *
   * LATENT, asserted against this lane's own database rather than inferred from
   * the seed file: `select role, perm_accounts from platform_admin` returns
   * owner/t, analyst/f, admin/t and NO `support` row, so nobody holds it today.
   * One `POST /v1/platform/admins {role:'support'}` makes it live — the preset is
   * applied at invite and re-applied on every role change in
   * `routes/platformAdmins.ts` — and that route is gated `admins`, which only
   * owner and admin hold. Reported to trunk rather than changed here: presets are
   * lane A's column, and whether support should mint money is Aftab's call, not a
   * test's.
   */
  'POST /v1/vouchers → accounts',
  'POST /voids → void',
  'POST /webhooks/:provider [ANONYMOUS]',
  'PUT /artists/:id/availability → team',
  'PUT /artists/:id/branch → team',
  'PUT /artists/me/availability [requireScannerScope]',
  'PUT /members/me/addresses/:id [requireMember]',
  /**
   * `→ salons`, AND IT WAS `→ loyalty` UNTIL DECISION 79 — a line that MOVED rather
   * than one that arrived, which is the amendment this ledger is least able to
   * distinguish on its own and the reason both halves of the pin exist. Dropped from
   * the "still readable" half and added to the "reads unpinned" half in the same
   * edit; either alone would have been green.
   *
   * ONE LINE, NOT TWO, and that is the difference from the GET above.
   * `requireLoyaltyPublisher` does not GATE a merchant on a permission — it refuses
   * her outright with `403 loyalty_read_only` — so there is no merchant gate path to
   * probe and the census correctly reports none. If a `PUT … → loyalty` line ever
   * comes back here, the merchant has a permission that opens this endpoint again.
   */
  'PUT /salons/:id/loyalty → salons',
  'PUT /v1/salons/:id/promotions/boosts → marketing',
];

describe('the census still reaches every route it reached when this was pinned', () => {
  const live = new Set(censusLedger(census));
  const pinned = new Set(PINNED_COVERAGE);

  it('the pin is not vacuous — it is the size of the API, not a stub', () => {
    // If PINNED_COVERAGE were ever emptied to make a merge green, the two specs
    // below would both pass and this file would silently stop pinning anything.
    expect(PINNED_COVERAGE.length).toBeGreaterThan(120);
    expect(
      new Set(PINNED_COVERAGE).size,
      'PINNED_COVERAGE has duplicate lines, so its length is not a coverage figure',
    ).toBe(PINNED_COVERAGE.length);
  });

  it('every pinned route and gate is still one the census can read', () => {
    const lost = PINNED_COVERAGE.filter((l) => !live.has(l));
    const blind = ambiguousRegistrations();
    expect(
      lost,
      'THE CENSUS NOW COVERS LESS THAN IT DID. These routes or gates were readable when ' +
        'this ledger was pinned and are not any more, so the probes generated from them ' +
        'have stopped being generated — silently, because a probe that is not generated ' +
        'cannot fail:\n  ' +
        lost.join('\n  ') +
        '\n\nThis is NOT evidence that the endpoint is unguarded at runtime. Lane A\'s four ' +
        'image writes were enforced correctly the whole time they were invisible here. It ' +
        'is evidence that non-negotiable #7\'s second half — "a test that calls it directly ' +
        'with the permission off" — no longer holds for them.\n\n' +
        'THREE THINGS IT CAN BE, in the order worth checking:\n' +
        '  1. the route was DELETED. Delete its line here too, in the same commit.\n' +
        '  2. the route was RENAMED or its gate changed permission. Replace the line.\n' +
        '  3. the registration or the guard stopped being a LITERAL — a path moved into a ' +
        'const, a handler moved into a factory, a guard moved into a helper. Move it back, ' +
        'or resolve it in support/perm-census.ts. Do not delete the line.\n\n' +
        (blind.length > 0
          ? 'AND THE SCANNER IS ALREADY REPORTING UNREADABLE REGISTRATION SITES, which ' +
            'makes (3) the likely answer:\n  ' +
            blind.map((b) => `${b.method} at ${b.file}:${b.line} — first argument \`${b.first}\``).join('\n  ')
          : 'No registration site is unreadable, so (3) would have to be a guard rather ' +
            'than a path — check for a helper introduced between the registration and the ' +
            'gate.'),
    ).toEqual([]);
  });

  it('every route and gate the census reads is pinned', () => {
    const unpinned = [...live].filter((l) => !pinned.has(l)).sort();
    expect(
      unpinned,
      'The census reads routes or gates this ledger does not list. That is the normal ' +
        'outcome of lane A shipping an endpoint, and the amendment is deliberate on ' +
        'purpose: it is what stops a coverage DROP from being hidden by an unrelated ' +
        'coverage GAIN, which is the failure mode the aggregate floors above cannot see.\n\n' +
        'Read each line before pasting it. A `→ permission` line means a probe now drives ' +
        'that gate. A `[scopeGuard]` line means the route authenticates somebody and ' +
        'carries NO permission — legitimate for a customer\'s own record or a shared ' +
        'catalog read, and a bug for a merchant write. A `[ANONYMOUS]` line means the ' +
        'route authenticates nobody and also needs an entry in ANONYMOUS above.\n\n' +
        'Paste into PINNED_COVERAGE:\n' +
        unpinned.map((l) => `  '${l.replace(/'/g, "\\'")}',`).join('\n'),
    ).toEqual([]);
  });
});

/**
 * THE OTHER HALF: a route BORN unreadable.
 *
 * The pin above compares today against a recorded yesterday, so it cannot see a route
 * that was never readable — it was never pinned, and its absence looks exactly like a
 * route that does not exist. That is not a corner case: it is lane A's images slice as
 * originally written, and it is what a developer produces the first time they factor two
 * near-identical registrations into a shared constant.
 *
 * So the scanner is made to fail on a call site it CAN see and CANNOT resolve, which is
 * the honest thing for a tool that reads text to say. `ambiguousRegistrations()` carries
 * the discriminator and why the receiver's NAME could not be it.
 */
describe('no route registration is written in a way this census cannot read', () => {
  it('the ambiguity scan is not vacuous — it still sees the calls that are NOT routes', () => {
    /**
     * NON-VACUOUS, and this is the assertion that keeps the one below honest. The scan
     * separates routes from Map reads and Drizzle deletes by ARITY, so if it ever stopped
     * seeing the one-argument calls entirely — a regex that matched nothing, a walker that
     * threw and was caught — the spec below would pass over an empty list for ever.
     *
     * Fifteen today: `names.get`, `labels.get`, `images.get`, `imageStore.get`, `db.delete`
     * and `tx.delete` across six route files, plus the colocated int tests that live in
     * this directory. A floor rather than an equality, for the reason the gate floors give.
     */
    expect(
      singleArgumentCallSites(),
      'the ambiguity scan no longer finds the one-argument .get/.delete calls it is ' +
        'supposed to be distinguishing routes FROM, so it is not reading the files at all',
    ).toBeGreaterThanOrEqual(10);
  });

  it('every registration-shaped call site resolves to a path literal', () => {
    const blind = ambiguousRegistrations();
    expect(
      blind.map((b) => `${b.method} at ${b.file}:${b.line} — first argument \`${b.first}\``),
      'A call site takes two or more arguments — the shape of a Fastify route ' +
        'registration, never the shape of a Map read — and its first argument is not a ' +
        'path literal. This census reads route paths as literals at the registration ' +
        'site, so it cannot see this route: no permission-off probe, no tenancy sweep, ' +
        'no GET census entry, and no failure anywhere saying so. `routes/images.ts` and ' +
        '`routes/reports.ts` both record this lesson from lane A\'s side and reach the ' +
        'same conclusion — "splitting it makes the security shape visible to the tool ' +
        'built to see it, instead of hiding a capability behind a conditional".\n\n' +
        'PUT THE PATH BACK AT THE REGISTRATION SITE. Two registrations that share a path ' +
        'cost one duplicated string; a route the census cannot see costs every automated ' +
        'guard this suite has. If the indirection is genuinely worth keeping, teach ' +
        '`support/perm-census.ts` to resolve it and delete this exemption-free spec\'s ' +
        'reason for firing — do not add an exemption list, which is the mechanism this ' +
        'whole module was written to replace.',
    ).toEqual([]);
  });
});

/**
 * THE THIRD HALF: a registration read against SOMEBODY ELSE'S PATH.
 *
 * The two describes above cover a route that is LOST — pinned yesterday and unreadable
 * today, or born unreadable and reported by file and line. Neither can see the worse
 * outcome, which is a scanner that loses a route and INVENTS one in its place.
 *
 * WHY THERE IS NO FIXTURE FOR THIS IN `api/src/routes/`. Every path in that directory is
 * an inline string literal today, so the census is correct on this tree and stays correct
 * whichever reader it uses — measured, not assumed: `censusOfRoutes()` returns the same
 * 144 routes, the same 103 gates and the same 159 ledger lines before and after the fix
 * this spec pins. The trigger is not a defect anywhere in lane A's code. It is an
 * ORDINARY REFACTOR: lifting one path into a `const`, which `routes/images.ts` is
 * precisely the file someone would do it to, since two of its registrations share a
 * prefix. So the bug is a property of the SCANNER and the only honest place to assert it
 * is on source text this file writes.
 *
 * WHAT IT DID. The registration scan matched the type arguments as `(?:<[\s\S]*?>)?` —
 * lazy, and crossing newlines. Given
 *
 *     const SERVICE_IMAGE = '/v1/salons/:id/services/:oid/image';
 *     app.delete<{ Params: … }>(SERVICE_IMAGE, handler);
 *     app.get<{ Params: … }>('/v1/images/:imageId', handler);
 *
 * the DELETE's generic could not be followed by a path literal, so it grew: past the end
 * of its own registration, through the `>` of an arrow function, and closed on the `}>`
 * of the GET below — whose literal then satisfied the pattern. The scan reported ONE
 * route, `DELETE /v1/images/:imageId`, which nobody wrote and which no router serves, and
 * BOTH real routes vanished with it.
 *
 * WHY IT IS WORSE THAN A MISCOUNT, in the terms this file already uses. The DELETE
 * disappearing is the `PINNED_COVERAGE` failure above, which is loud and says the right
 * thing. The GET disappearing with it is a second pinned line lost for a reason nothing
 * explains. And the ghost is reported by the third spec as a route that "reads unpinned",
 * pointing a reader at a source line that says something else entirely — the shape of
 * decision 90, where a permission turned out to be asserted by nothing while every
 * aggregate stayed green.
 *
 * THE FIX IS ONE READER, NOT A BETTER REGEX. `registrationsIn` now walks the type
 * arguments with the same `skipTypeArgs` the ambiguity pass has used since it was
 * written, so this module has ONE definition of where a registration ends rather than two
 * that can disagree about the same file — which matters because the two are consumed
 * together: the census names the route, the ambiguity pass names the site that defeated
 * it. A registration this reader cannot resolve is left for `ambiguousRegistrations()` to
 * report, never re-attached to a later path.
 */
describe("a registration's path is read from its own argument list", () => {
  /** The shape every path in `api/src/routes/` has today. Both routes must be read. */
  const INLINE = `
    app.delete<{ Params: { id: string; oid: string } }>(
      '/v1/salons/:id/services/:oid/image',
      async (req, reply) => { return performDetach(req, reply, p, 'service'); },
    );

    app.get<{ Params: { imageId: string } }>('/v1/images/:imageId', async (req, reply) => {
      return serve(req, reply);
    });
  `;

  /** The same file after one ordinary refactor. Nothing else changed. */
  const CONST_PATH = `
    const SERVICE_IMAGE = '/v1/salons/:id/services/:oid/image';

    app.delete<{ Params: { id: string; oid: string } }>(
      SERVICE_IMAGE,
      async (req, reply) => { return performDetach(req, reply, p, 'service'); },
    );

    app.get<{ Params: { imageId: string } }>('/v1/images/:imageId', async (req, reply) => {
      return serve(req, reply);
    });
  `;

  const namesIn = (src: string): string[] =>
    registrationsIn(src).map((r) => `${r.method} ${r.path}`);

  it('reads both registrations when both paths are literals — the tree as it stands', () => {
    expect(namesIn(INLINE)).toEqual([
      'DELETE /v1/salons/:id/services/:oid/image',
      'GET /v1/images/:imageId',
    ]);
  });

  /**
   * THE SPEC THAT FAILS ON THE OLD REGEX. Verified in both directions rather than
   * asserted: with `REGISTRATION`'s lazy `(?:<[\s\S]*?>)?` restored, this returns
   * `['DELETE /v1/images/:imageId']` and the equality below goes red naming the ghost;
   * with the walked reader it returns the GET alone and passes.
   */
  it('never welds one registration’s method to the next one’s path', () => {
    expect(
      namesIn(CONST_PATH),
      'the scanner read a path that does not belong to the registration it was reading. ' +
        'An UNREADABLE registration must be dropped here and reported by ' +
        '`ambiguousRegistrations()`, never re-attached to a later literal: a census that ' +
        'invents a route sends whoever reads the failure to a line that says something ' +
        'else, and takes the real route down with it.',
    ).toEqual(['GET /v1/images/:imageId']);
  });

  it('invents no route with a method and a path that were never written together', () => {
    const read = registrationsIn(CONST_PATH);
    expect(
      read.filter((r) => r.method === 'DELETE'),
      'the const-lifted DELETE is unreadable at its registration site, so it must be ' +
        'absent — not present under some other path',
    ).toEqual([]);
    // And the route that IS still readable did not vanish under the one that is not.
    expect(read.map((r) => r.path)).toContain('/v1/images/:imageId');
  });

  /**
   * THE WALKED READER MUST NOT BE NARROWER THAN THE REGEX IT REPLACED, and it was, in
   * one shape, until `skipTypeArgs` stopped counting the `>` of an arrow. That closed the
   * type-argument list early, so the next character was not `(`, and BOTH passes dropped
   * the call — no census entry, and no ambiguity report either, because `callSites` reads
   * "not followed by `(`" as "not a call at all". A route lost by the fix for the ghost
   * would have been a strictly worse trade than the ghost.
   */
  it('reads a registration whose type arguments contain an arrow type', () => {
    expect(
      namesIn(`
        app.get<{ Params: { id: string }; Reply: { render: () => Map<string, number> } }>(
          '/v1/salons/:id/report',
          handler,
        );
      `),
    ).toEqual(['GET /v1/salons/:id/report']);
  });

  /**
   * The division of labour, stated as a spec. A generic that does not balance is not
   * guessed at here — it is dropped, and `ambiguousRegistrations()` is what says so by
   * file and line. That is why the census going quiet about a route can never be the
   * whole story this suite tells.
   */
  it('drops a registration whose type arguments do not balance, rather than guessing', () => {
    expect(
      namesIn(`
        app.post<{ Body: Partial<Thing }>('/v1/things', handler);
        app.get('/v1/things', handler);
      `),
    ).toEqual(['GET /v1/things']);
  });

  /** A Map read and a Drizzle delete are not registrations, whatever they are called. */
  it('reads no route out of a one-argument call on the same method names', () => {
    expect(
      namesIn(`
        const row = names.get(t.memberId);
        await db.delete(campaign);
        const blob = await imageStore.get(row.storageKey);
      `),
    ).toEqual([]);
  });
});

describe('every route with no gate is either scope-guarded or a named exemption', () => {
  /**
   * The clause that makes this file self-maintaining. An ungated route carrying a scope
   * guard is a legitimate shape — `GET /members/me` is the customer's own record and no
   * permission could apply. An ungated route with NO guard at all is reachable by anyone,
   * and has to be defended in `ANONYMOUS` above.
   */
  it('names no unauthenticated route this spec has not accounted for', () => {
    const anonymous = census.ungated.filter((u) => u.scope === null);
    const undefended = anonymous
      .filter((u) => !(nameOf(u) in ANONYMOUS))
      .map((u) => `${nameOf(u)}  (${u.file}:${u.line})`);

    expect(
      undefended,
      'these endpoints authenticate NOBODY and are not in the ANONYMOUS ledger. Either ' +
        'they need a guard, or they need a line there saying why they are open.',
    ).toEqual([]);
  });

  it('and the ledger has no entries for routes that no longer exist', () => {
    const live = new Set(census.ungated.filter((u) => u.scope === null).map(nameOf));
    const stale = Object.keys(ANONYMOUS).filter((k) => !live.has(k));
    expect(
      stale,
      'the ANONYMOUS ledger defends routes that are gone or have since been guarded. A ' +
        'stale exemption is how a future unauthenticated endpoint slips in under an old name.',
    ).toEqual([]);
  });

  it('and MIRROR_WOULD_WRITE names only endpoints that are actually gated', () => {
    const gatedNames = new Set(census.gated.map(nameOf));
    const stale = Object.keys(MIRROR_WOULD_WRITE).filter((k) => !gatedNames.has(k));
    expect(stale, 'a mirror exemption names an endpoint the census does not see as gated').toEqual(
      [],
    );
  });
});

// ===========================================================================

describe('every gated MERCHANT endpoint refuses a principal holding no permissions', () => {
  for (const route of merchantGates) {
    it(`${nameOf(route)} → perms.${route.permission}`, async () => {
      revokeAllMerchant();
      precondition(
        scalar(
          `select ${Object.values(PERM_COLUMN).map((c) => `${c}::text`).join(" || ',' || ")}
             from staff_user where id='${staffFor(route)}'`,
        ).trim() === 'false,false,false,false,false,false,false,false,false',
        'the probe principal still holds a permission, so a 403 here would be ambiguous',
      );

      const res = await treq<any>(route.method, pathFor(route), {
        token: tokenFor(route),
        body: bodyFor(route),
      });

      expect(
        res.status,
        `perms.${route.permission} is NOT enforced on ${nameOf(route)} ` +
          `(${route.file}:${route.line}${route.via ? `, via ${route.via}` : ''}): it answered ` +
          `${res.status} to a ${route.surface} principal holding no permissions at all. ` +
          `Non-negotiable #7.\n${res.raw}`,
      ).toBe(403);
      expect(res.body.error).toBe('forbidden');
      /**
       * THE DISCRIMINATOR. `forbidden` is also the code for a wrong surface and for
       * `requireSameSalon`, so the copy is what says this 403 came from
       * perms.<permission> and not from something else that also refuses.
       */
      expect(
        res.body.message,
        `${nameOf(route)} refused, but not for perms.${route.permission} — it answered ` +
          `"${res.body.message}". Either the census attributed the wrong permission, or ` +
          'the endpoint is gated on a different one than its source suggests.',
      ).toBe(PERMISSION_COPY[route.permission]);
    }, 60_000);
  }
});

// ===========================================================================

describe('and each of those stops refusing once that one permission is granted', () => {
  for (const route of merchantGates.filter((r) => !(nameOf(r) in MIRROR_WOULD_WRITE))) {
    it(`${nameOf(route)} — granted perms.${route.permission}`, async () => {
      revokeAllMerchant();
      try {
        grantMerchant(staffFor(route), route.permission);
        const res = await treq<any>(route.method, pathFor(route), {
          token: tokenFor(route),
          body: bodyFor(route),
        });

        /**
         * NOT asserted to be 200 — a bogus path parameter is a 404 and an empty body is a
         * 400, both of which mean the gate opened. What must not happen is the SAME
         * authority refusal, because then the probe above was measuring a broken route, a
         * wrong surface or a missing fixture rather than a permission.
         */
        const stillRefused =
          res.status === 403 && res.body?.message === PERMISSION_COPY[route.permission];
        expect(
          stillRefused,
          `${nameOf(route)} still refuses perms.${route.permission} after it was GRANTED, so ` +
            `the refusal in the ledger above proves nothing about a gate.\n${res.raw}`,
        ).toBe(false);
      } finally {
        revokeAllMerchant();
      }
    }, 60_000);
  }
});

// ===========================================================================

describe('every gated CONSOLE endpoint refuses an admin without that section', () => {
  for (const route of platformGates) {
    it(`${nameOf(route)} → ${route.permission}`, async () => {
      grantAllSections();
      setSection(route.permission, false);
      precondition(
        scalar(
          `select ${SECTION_COLUMN[route.permission]} from platform_admin where id='${PLATFORM_ADMIN2}'`,
        ).trim() === 'f',
        'the section revoke did not take, so this case would pass with it ON',
      );

      const res = await treq<any>(route.method, pathFor(route), {
        token: salem,
        body: bodyFor(route),
      });

      expect(
        res.status,
        `the ${route.permission} section is NOT enforced on ${nameOf(route)} ` +
          `(${route.file}:${route.line}): it answered ${res.status} to a console admin ` +
          `without it.\n${res.raw}`,
      ).toBe(403);
      expect(res.body.error).toBe('forbidden');
      expect(
        res.body.message,
        `${nameOf(route)} refused, but not for the ${route.permission} section — it said ` +
          `"${res.body.message}".`,
      ).toBe(SECTION_COPY[route.permission]);
    }, 60_000);
  }
});

// ===========================================================================

describe('and each console endpoint stops refusing with the section restored', () => {
  for (const route of platformGates.filter((r) => !(nameOf(r) in MIRROR_WOULD_WRITE))) {
    it(`${nameOf(route)} — granted ${route.permission}`, async () => {
      try {
        grantAllSections();
        const res = await treq<any>(route.method, pathFor(route), {
          token: salem,
          body: bodyFor(route),
        });
        const stillRefused =
          res.status === 403 && res.body?.message === SECTION_COPY[route.permission];
        expect(
          stillRefused,
          `${nameOf(route)} still refuses the ${route.permission} section after it was ` +
            `granted.\n${res.raw}`,
        ).toBe(false);
      } finally {
        grantAllSections();
      }
    }, 60_000);
  }
});

// ===========================================================================

/**
 * THE `'either'` SURFACE, WHICH THE GENERATED SWEEP ABOVE STRUCTURALLY CANNOT SEE.
 *
 * WHY THESE ARE HAND-WRITTEN IN A FILE WHOSE WHOLE POINT IS THAT NOTHING IS.
 * `requirePerm(req, surface, permission)` takes three surface values —
 * `'scanner' | 'dashboard' | 'either'` (`auth/principal.ts` § StaffSurface) — and
 * `GatedRoute['surface']` in `support/perm-census.ts` takes two plus `'platform'`. There
 * is no `'either'` member to record it with, so `surfaceOf` collapses it:
 *
 *     const named = args[1];
 *     return named === 'scanner' ? 'scanner' : 'dashboard';
 *
 * `'either'` is not `'scanner'`, so it reads `'dashboard'`, `tokenFor` hands the probe the
 * WEB session, and the scanner door is never knocked on. Nothing reports this — the
 * collapse is silent, and the ledger line `GET /salons/:id/devices → dashboard` is
 * byte-identical whether the guard says `'either'` or `'dashboard'`.
 *
 * SO A REAL REGRESSION IS INVISIBLE TO EVERY OTHER SPEC IN THIS SUITE. Narrow
 * `'either'` to `'dashboard'` and: the census still reads `dashboard`, the pin does not
 * move, both generated probes stay green on the web token, `tenancy.test.ts` stays green
 * because its ledger drives the dashboard session too — and the scanner's 'Set up this
 * device' flow, which `routes/devices.ts` calls "the PRIMARY flow" and decision 82 assigns
 * to lane B, answers 403 for ever with the wrong-credential copy.
 *
 * `perms.dashboard` on `'either'` is the ONLY gate of its kind in this API, and it is the
 * half of the classification lane A argued hardest for. It should not rest on the half of
 * the census that cannot represent it.
 *
 * THE FIX IS NOT HERE, DELIBERATELY. Teaching `surfaceOf` to return `'either'` and
 * `tokenFor` to yield both tokens belongs in `support/perm-census.ts`, which another lane D
 * session is holding uncommitted; a two-value union widening under it would be a
 * conflict for the sake of tidiness. These specs are the interim, and they are written to
 * become REDUNDANT rather than to last — see the guard below, which goes red the hour the
 * census learns the third value, so "interim" cannot quietly become "permanent".
 */
const SURFACE_COPY_DASHBOARD =
  'A scanner PIN cannot reach the dashboard. Sign in on the web with a username and password.';

/**
 * The three doors, written out rather than filtered from the census — the census's view of
 * their surface is the thing under test, so deriving the list from it would be circular.
 */
const EITHER_SURFACE_ROUTES: { method: 'GET' | 'POST' | 'DELETE'; path: string }[] = [
  { method: 'GET', path: `/salons/${SALON_B}/devices` },
  { method: 'POST', path: `/salons/${SALON_B}/devices` },
  { method: 'DELETE', path: `/salons/${SALON_B}/devices/${MISSING}` },
];

describe("the device doors accept a SCANNER credential — perms.dashboard on 'either'", () => {
  for (const route of EITHER_SURFACE_ROUTES) {
    it(`${route.method} ${route.path.replace(SALON_B, ':id')} — a PIN session is not refused for its SURFACE`, async () => {
      revokeAllMerchant();
      try {
        grantMerchant(B_STAFF_AUTH_PIN, 'dashboard');
        const res = await treq<any>(route.method, route.path, {
          token: pin,
          body: route.method === 'POST' ? {} : undefined,
        });

        /**
         * NOT asserted to be 200, for the reason the generated mirror gives: the DELETE
         * addresses a device id nothing resolves to and the POST sends an empty body, so a
         * 404 and a 400 both mean the gate opened. What must not happen is the SURFACE
         * refusal — that is `requireStaff` rejecting the KIND of credential, and it is the
         * exact answer a narrowing of `'either'` to `'dashboard'` would produce.
         */
        const refusedForSurface =
          res.status === 403 && res.body?.message === SURFACE_COPY_DASHBOARD;
        expect(
          refusedForSurface,
          `${route.method} ${route.path} refused a scanner PIN holding perms.dashboard for ` +
            'its SURFACE. `requirePerm(req, \'either\', \'dashboard\')` has been narrowed to ' +
            "`'dashboard'`, and decision 82's 'Set up this device' flow on the scanner is now " +
            'unreachable. Nothing else in this suite can see this: the census collapses ' +
            "`'either'` to `'dashboard'`, so the ledger line and both generated probes stay " +
            `green on the web token.\n${res.raw}`,
        ).toBe(false);
      } finally {
        revokeAllMerchant();
      }
    }, 60_000);
  }
});

// ===========================================================================

describe('and the scanner door is the PERMISSION, not the surface', () => {
  for (const route of EITHER_SURFACE_ROUTES) {
    it(`${route.method} ${route.path.replace(SALON_B, ':id')} — a PIN session without perms.dashboard → 403 dashboard`, async () => {
      revokeAllMerchant();
      const res = await treq<any>(route.method, route.path, {
        token: pin,
        body: route.method === 'POST' ? {} : undefined,
      });

      expect(res.status, `answered ${res.status}: ${res.raw}`).toBe(403);
      /**
       * THE DISCRIMINATOR, and it is doing more work here than in the generated sweep.
       * There a wrong-surface 403 and a permission 403 are told apart to prove the gate
       * exists; here the SAME distinction proves the gate is the one lane A argued for. If
       * this answered `SURFACE_COPY_DASHBOARD` the pair above would be green — the door is
       * shut either way — and the reason would be the credential rather than the authority.
       * Gating this family on the scanner surface at all is `services/branch.ts` § THE FIX
       * THAT MUST NOT BE TAKEN arriving through a side door.
       */
      expect(
        res.body.message,
        `${route.method} ${route.path} refused a scanner PIN, but for the wrong reason — it ` +
          `answered "${res.body.message}". A scanner session with perms.dashboard is a ` +
          'legitimate caller here by design; what must refuse it is the missing permission.',
      ).toBe(PERMISSION_COPY.dashboard);
    }, 60_000);
  }
});

// ===========================================================================

/**
 * THE SELF-EXPIRY, so the four specs above cannot outlive their reason.
 *
 * They exist ONLY because `surfaceOf` cannot say `'either'`. The hour it can — a third
 * member on `GatedRoute['surface']` and a `tokenFor` that yields both credentials — the
 * generated sweep covers this family on both surfaces and the hand-written pairs become
 * duplicated coverage nobody is maintaining. This goes red then, by name, and says so.
 *
 * The same idiom as `NEEDS_PLATFORM_CREDENTIAL` and `AWAITING_MERGE` above: an excuse in
 * this file has to assert that its own excuse still holds.
 */
describe("the census still cannot represent the 'either' surface", () => {
  it('reads the device doors as `dashboard`, which is why the pairs above are hand-written', () => {
    const deviceGates = census.gated.filter((g) => g.path.includes('/devices'));

    expect(
      deviceGates.map(pairOf).sort(),
      'the census no longer reads all three device doors as gated. If they moved, the ' +
        'hand-written pairs above address paths that are gone.',
    ).toEqual([
      'DELETE /salons/:id/devices/:deviceId → dashboard',
      'GET /salons/:id/devices → dashboard',
      'POST /salons/:id/devices → dashboard',
    ]);

    const surfaces = [...new Set(deviceGates.map((g) => g.surface))];
    expect(
      surfaces,
      "`surfaceOf` now distinguishes the 'either' surface, so the generated sweep can probe " +
        'these three on the scanner credential itself. DELETE the two hand-written describe ' +
        'blocks above and this spec with them — they are duplicated coverage now, and this ' +
        'assertion exists to say so rather than let them rot.',
    ).toEqual(['dashboard']);
  });
});
