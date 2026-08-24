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
  censusOfRoutes,
  nameOf,
  pairOf,
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
  'PATCH /salons/:id': 'writes salon settings, including the loyalty mode',
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
     * through a lookup table expands into one PROBE per key — the four reports kinds — so
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
     * The mapping itself, pinned. This is the one place the four pairs are written down in
     * this suite, and it is an ASSERTION against the source rather than a copy used to
     * build probes: the probes come from the parsed map, so if this disagrees with lane
     * A's file the spec fails instead of quietly probing the wrong permission.
     *
     * The pairs matter beyond bookkeeping — they are the FRONTDESK property. `frontdesk`
     * holds `dashboard` and not `team`, so a blanket `dashboard` gate on reports would
     * hand every front-desk tablet the customer book with phones and balances.
     */
    expect(Object.fromEntries(map!.entries)).toEqual({
      customers: 'team',
      sales: 'dashboard',
      'best-selling-services': 'appointments',
      'products-sold': 'shop',
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
