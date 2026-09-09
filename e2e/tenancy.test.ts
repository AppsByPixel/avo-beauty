/**
 * TENANCY — can salon B reach salon A?
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   pnpm --dir ./api run db:up
 *   pnpm --dir ./api run db:migrate
 *   pnpm --dir ./api run db:seed
 *   cd e2e && ../node_modules/.bin/vitest run tenancy.test.ts
 *
 * This file does NOT use `support/api.ts` and is not affected by `E2E_BASE_URL`.
 * It boots lane A's real API on its own port and seeds a second salon straight
 * into lane A's docker Postgres — `support/tenancy-harness.ts` explains why and
 * exactly how. `packages/mock` has one salon and ignores the `:id` on every
 * `/salons/:id` route, so a tenancy suite pointed at it would be all red and
 * would prove nothing about the product.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The claim under audit was: "all eight salon-scoped routes call
 * `requireSameSalon`, so the hole is closed." That is a claim from reading code.
 * Nobody had ever watched a principal from salon B be refused salon A's data.
 * A multi-tenant wallet where one salon can read another's members is the worst
 * failure this product can have, so the claim needed evidence rather than
 * agreement.
 *
 * THE SHAPE OF THE EVIDENCE
 * -------------------------
 * Salon B's principal is Layla — a MANAGER at Lumière holding all nine
 * permissions, signed in for real. That matters: every 403 asserted here has to
 * come from the salon boundary. A restricted principal would produce the same
 * 403 for the wrong reason and the suite would prove nothing.
 *
 * Every refusal spec is paired with a control that performs the same call
 * against salon B's own id and expects it to succeed. A 403 from a mis-typed
 * path is not tenancy enforcement, it is a typo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import { censusOfRoutes } from './support/perm-census.js';
import {
  A_MEMBER,
  A_MEMBER_NAME,
  A_MEMBER_PHONE,
  A_SERVICE,
  A_HAPPY_HOUR,
  A_STAFF_FULL,
  A_STAFF_RESTRICTED,
  A_BRANCH,
  B_BRANCH,
  B_BRANCH_DISPOSABLE,
  B_HAPPY_HOUR,
  B_HAPPY_HOUR_DISPOSABLE,
  B_MEMBER,
  B_MEMBER_PHONE,
  B_SERVICE,
  B_SCANNER_DEVICE,
  B_STAFF,
  B_STAFF_HANDLE,
  SALON_A,
  SALON_B,
  SALON_NOWHERE,
  STAFF_NOWHERE,
  discoverSalonScopedRoutes,
  branchIdsNamed,
  mintSalonAWalletToken,
  psql,
  retireBranches,
  scalar,
  PLATFORM_OWNER_HANDLE,
  signInDashboard,
  signInMember,
  signInPlatform,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** Salon B, dashboard scope — the merchant console credential. */
let bDashboard = '';
/** Salon B, scanner scope — a real device-bound PIN session. */
let bScanner = '';
/** Salon B's own customer, wallet scope. */
let bMember = '';

/** A fresh idempotency key. Never reused across specs; the server remembers. */
let n = 0;
const key = (label: string) => `tenancy-${label}-${Date.now()}-${n++}`;

beforeAll(async () => {
  await startTenancyApi();
  bDashboard = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  bScanner = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
  bMember = await signInMember(SALON_B, B_MEMBER_PHONE);

  /**
   * THE SUBJECTS THE LEDGER'S WRITE ROUTES ADDRESS.
   *
   * SIX WHEN THIS WAS WRITTEN — lane A's shop and campaign routes — and TEN now that the
   * four image writes have landed. The count is deliberately no longer in this sentence:
   * it was, it went stale within one merge, and a number in a docblock that nobody has to
   * update is the stale-confident-sentence pattern this repository keeps paying for.
   *
   * Written with `psql` rather than through the endpoints on purpose: these rows are
   * the ledger's fixture, and creating them through the very routes the ledger is
   * about would make the fixture depend on the thing under test. The `POST` controls are
   * the only ones that genuinely create, and they do so through the endpoint as they
   * should — including the image upload, whose DELETE counterpart is therefore given a
   * blob seeded here rather than one the POST spec happened to leave behind.
   *
   * `ON CONFLICT DO UPDATE` so a run interrupted after the DELETE control has its rows
   * back on the next one. The disposable products are restored to their probe price as
   * well as re-created, because the PATCH control really writes; the image owners are
   * restored to `active` for the same reason, because `requireOwnerInSalon` filters on it.
   *
   * SALON A IS BARELY TOUCHED, and the image rows do not touch it at all. See
   * `imageOwnerFor`: an extra active service at salon A would change a list three other
   * files read, and the cross-salon probe never resolves `{oid}` anyway.
   */
  psql(`
    INSERT INTO product (id, salon_id, name, price_fils) VALUES
      ('${PROBE_PRODUCT_A}',        '${SALON_A}', 'Tenancy probe A',        1000),
      ('${PROBE_PRODUCT_B_PATCH}',  '${SALON_B}', 'Tenancy probe B patch',  1000),
      ('${PROBE_PRODUCT_B_DELETE}', '${SALON_B}', 'Tenancy probe B delete', 1000)
    ON CONFLICT (id) DO UPDATE SET price_fils = 1000, salon_id = EXCLUDED.salon_id;

    -- Only the columns without defaults. The wire field is \`when\` and the COLUMN is
    -- \`send_when\`, which is worth naming: \`"when"\` is a reserved word and writing it
    -- fails with "column does not exist" rather than a syntax error.
    -- \`branch_id\` is NULL, not 'all'. The WIRE says "all" and the COLUMN is a real
    -- foreign key to \`branch\`, so the string fails on campaign_branch_id_fkey — the
    -- serialiser is what turns a null into "all" for the client.
    INSERT INTO campaign (id, salon_id, title, body, channel, audience, branch_id,
                          send_when, status, submitted_by)
    VALUES
      ('${PROBE_CAMPAIGN_A}', '${SALON_A}', 'Tenancy probe A', 'probe', 'push', 'all',
       NULL, 'now', 'pending', 'Tenancy'),
      ('${PROBE_CAMPAIGN_B}', '${SALON_B}', 'Tenancy probe B', 'probe', 'push', 'all',
       NULL, 'now', 'pending', 'Tenancy')
    ON CONFLICT (id) DO UPDATE SET status = 'pending', salon_id = EXCLUDED.salon_id;

    -- ---------------------------------------------------------------------
    -- THE FOUR IMAGE SUBJECTS AT SALON B, and the two blobs the DELETEs detach.
    --
    -- Nothing is inserted at salon A: the probes there address PROBE_PRODUCT_A and
    -- the seed's SV-01, both of which already exist. See imageOwnerFor.
    --
    -- active = true is the default and is what requireOwnerInSalon filters on,
    -- so an inactive row would 404 the control and read as a tenancy hole.
    INSERT INTO product (id, salon_id, name, price_fils) VALUES
      ('${PROBE_PRODUCT_B_IMAGE_POST}',   '${SALON_B}', 'Tenancy probe B image post',   1000),
      ('${PROBE_PRODUCT_B_IMAGE_DELETE}', '${SALON_B}', 'Tenancy probe B image delete', 1000)
    ON CONFLICT (id) DO UPDATE SET salon_id = EXCLUDED.salon_id, active = true;

    INSERT INTO service (id, salon_id, name, price_fils) VALUES
      ('${PROBE_SERVICE_B_IMAGE_POST}',   '${SALON_B}', 'Tenancy probe B image post',   1000),
      ('${PROBE_SERVICE_B_IMAGE_DELETE}', '${SALON_B}', 'Tenancy probe B image delete', 1000)
    ON CONFLICT (id) DO UPDATE SET salon_id = EXCLUDED.salon_id, active = true;

    -- THE POST CONTROL'S SLOT IS EMPTIED, not assumed empty. It really uploads and
    -- really attaches, so without this a second run against one database would find
    -- last run's picture there and get 200-replaced where the row pins 201-created.
    -- The image row it made is left behind deliberately: markDetachedIfUnreferenced
    -- is the API's job and the reaper's, and a fixture that deleted blobs would be
    -- reaching past the boundary this file is about.
    DELETE FROM image_attachment
     WHERE salon_id = '${SALON_B}'
       AND ((owner_type = 'product' AND owner_id = '${PROBE_PRODUCT_B_IMAGE_POST}')
         OR (owner_type = 'service' AND owner_id = '${PROBE_SERVICE_B_IMAGE_POST}'));

    -- THE DELETE CONTROL'S SLOT IS FILLED, in SQL. See PROBE_IMAGE_PRODUCT: a detach
    -- never reads the store, so these rows need no bytes anywhere — and having none
    -- is what stops the fixture from being an upload through the route under test.
    INSERT INTO image (id, salon_id, storage_key, driver, content_type, byte_size,
                       width, height, checksum_sha256)
    VALUES
      ('${PROBE_IMAGE_PRODUCT}', '${SALON_B}', 'tenancy-probe/product', 'fixture',
       'image/png', 33, 1, 1,
       '1111111111111111111111111111111111111111111111111111111111111111'),
      ('${PROBE_IMAGE_SERVICE}', '${SALON_B}', 'tenancy-probe/service', 'fixture',
       'image/png', 33, 1, 1,
       '2222222222222222222222222222222222222222222222222222222222222222')
    ON CONFLICT (id) DO UPDATE SET detached_at = NULL, salon_id = EXCLUDED.salon_id;

    INSERT INTO image_attachment (id, image_id, salon_id, owner_type, owner_id, role)
    VALUES
      ('IA-TENPROBEPR', '${PROBE_IMAGE_PRODUCT}', '${SALON_B}', 'product',
       '${PROBE_PRODUCT_B_IMAGE_DELETE}', 'primary'),
      ('IA-TENPROBESV', '${PROBE_IMAGE_SERVICE}', '${SALON_B}', 'service',
       '${PROBE_SERVICE_B_IMAGE_DELETE}', 'primary')
    ON CONFLICT (id) DO NOTHING;

    -- ---------------------------------------------------------------------
    -- THE THREE TILLS THE DEVICE LEDGER ADDRESSES. See PROBE_DEVICE_A.
    --
    -- \`enrolled_by_staff_id\` is nullable and left NULL: these rows were seeded, not
    -- enrolled by anyone, and naming a staff member would be a fiction the audit trail
    -- does not contain. \`revoked_by_staff_id\` must stay NULL with it —
    -- \`device_enrolment_revocation_is_whole\` makes revoked one fact with two columns.
    --
    -- THE DELETE CONTROL'S SLOT IS RE-FILLED BY UN-REVOKING, not by re-inserting. The
    -- revoke is an UPDATE and \`device_enrolment_live_uq\` is partial on
    -- \`revoked_at IS NULL\`, so a plain re-insert would collide with last run's live row
    -- and an ON CONFLICT (id) that only touched \`salon_id\` would leave it revoked — the
    -- control would then 404 and read as a tenancy hole.
    INSERT INTO device_enrolment (id, salon_id, device_id, branch_id, label)
    VALUES
      ('ENR-TEN-A',      '${SALON_A}', '${PROBE_DEVICE_A}',        '${A_BRANCH}', 'Tenancy probe till A'),
      ('ENR-TEN-B-DEL',  '${SALON_B}', '${PROBE_DEVICE_B_DELETE}', '${B_BRANCH}', 'Tenancy probe till B')
    ON CONFLICT (id) DO UPDATE SET
      revoked_at = NULL, revoked_by_staff_id = NULL,
      salon_id = EXCLUDED.salon_id, branch_id = EXCLUDED.branch_id;

    -- THE POST CONTROL'S SLOT IS EMPTIED, not assumed empty — the image POST's rule, and
    -- here it decides a status code rather than a row: re-posting an enrolment that
    -- already names the same branch AND label returns the existing row with 200, and the
    -- table pins 201. DELETEd outright rather than revoked, because a revoked row is
    -- history the live unique index ignores and the handler would insert alongside it.
    DELETE FROM device_enrolment
     WHERE salon_id = '${SALON_B}' AND device_id = '${PROBE_DEVICE_B_POST}';

    -- SALON B'S SOCIAL LINKS. Salon A is not touched here and must not be: its four
    -- seeded handles are what \`contract.test.ts\` asserts \`salon.social\` is non-empty
    -- against, and they are also the fixture the ledger row probes across the boundary.
    --
    -- SET, not merged, and reset on every run. The per-link endpoint APPENDS a channel
    -- the salon does not have yet, so the ledger's control call adds a TikTok row to
    -- whatever is already there; without this reset the array would grow a little each
    -- run and the pair below would eventually be asserting about a link some earlier
    -- run had left behind. Writing the whole array is safe precisely because nothing
    -- outside this file reads salon B's — it exists only in this harness.
    UPDATE salon SET social = '[
      {"id":"${PROBE_SOCIAL_UNTOUCHED}","label":"Instagram","handle":"${B_SOCIAL_HANDLE}","on":true},
      {"id":"${PROBE_SOCIAL_TABLE}","label":"TikTok","handle":"","on":false}
    ]'::jsonb
    WHERE id = '${SALON_B}';
  `);
}, 120_000);

afterAll(async () => {
  /**
   * THE BRANCH THE POST CONTROL CREATED, RETIRED.
   *
   * The gap ledger's control half performs its write for real, so the moment
   * `POST /salons/{id}/branches` started working this file began adding a branch
   * to salon B on every run and leaving it there. An extra open branch changes
   * what `services/branch.ts` decides and, because lane A mints ids as `BR-` plus
   * random base36, it wins `resolveBranch`'s alphabetical tie-break about three
   * times in five — a suite that fails differently on Tuesday.
   *
   * `retireBranches` and not a DELETE, and the reason is the same tie-break one
   * level deeper: this file charges after the ledger runs, so those charges are
   * attributed to the probe branch and the row cannot be removed without
   * rewriting money history. Closing it is enough — a closed branch wins no
   * tie-breaks and counts toward nobody's open-branch total. See the helper.
   *
   * Scoped by name prefix and salon, so it can only ever match rows this file
   * made.
   */
  retireBranches(SALON_B, branchIdsNamed(SALON_B, PROBE_BRANCH_PREFIX));
  await stopTenancyApi();
});

/**
 * Salon A strings that must never appear in a response to salon B. Checked as
 * raw text, so a leak nested three objects deep in an error body is still caught.
 */
const SALON_A_TELLTALES = [
  SALON_A,
  A_MEMBER_NAME,
  A_MEMBER_PHONE,
  'dana@example.com',
  'Amara',
  'Noura',
  'Hessa',
  'Salmiya',
  'Kuwait City',
];

function expectNoSalonALeak(raw: string, what: string): void {
  const leaked = SALON_A_TELLTALES.filter((t) => raw.includes(t));
  expect(leaked, `${what} leaked salon A data in its body: ${leaked.join(', ')}\n${raw}`).toEqual(
    [],
  );
}

// ---------------------------------------------------------------- tripwires --

/**
 * If any of these four fail, every 403 below is meaningless — either the token
 * is not salon B's, or the principal is under-privileged, or the harness is
 * quietly talking to salon A through the test-principal shim.
 */
describe('tripwires — the principals are who this suite thinks they are', () => {
  it("salon B's dashboard token is a manager at salon B, not salon A's seeded staff", async () => {
    const res = await treq<{ id: string; salonId: string; perms: Record<string, boolean> }>(
      'GET',
      '/staff/me',
      { token: bDashboard },
    );
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(B_STAFF);
    expect(res.body.salonId).toBe(SALON_B);
    expect(res.body.id).not.toBe(A_STAFF_FULL);
  });

  it('that manager holds all nine permissions, so no 403 here can be a permission 403', async () => {
    const res = await treq<{ perms: Record<string, boolean> }>('GET', '/staff/me', {
      token: bDashboard,
    });
    const off = Object.entries(res.body.perms)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    expect(off, `these permissions are off, so a 403 would be ambiguous: ${off.join(', ')}`).toEqual(
      [],
    );
  });

  it("salon B's scanner token is a real PIN session, scoped scanner not dashboard", async () => {
    // A PIN must never reach a dashboard endpoint — api-contract.md § StaffUser.
    // Proving the scope here is what makes the scanner-side specs below honest.
    const res = await treq<{ id: string; error: string; message: string }>('GET', '/staff', {
      token: bScanner,
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/scanner PIN cannot reach the dashboard/i);
  });

  it('an unauthenticated request is NOT anonymous under the test shim — it is salon A', async () => {
    // This is the trap `treq()` guards against, asserted rather than assumed. If
    // this ever returns 401 the shim is off, and the wallet-token mint below
    // needs salon A's member password instead.
    const res = await treq<{ id: string; salonId: string }>('GET', '/staff/me', { token: null });
    expect(res.status).toBe(200);
    expect(res.body.salonId).toBe(SALON_A);
  });
});

// ------------------------------------------------- every salon-scoped route --

interface SalonRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /**
   * `{id}` is substituted with the salon under test.
   *
   * `{hid}` is substituted with a happy hour BELONGING TO THAT SALON — salon A's
   * seeded window when probing salon A, salon B's own when running the control. A
   * single hard-coded id cannot serve both: salon A's `HH-01` does not exist at
   * salon B, so the control would 404 and the ledger would report a tenancy hole
   * that is really a missing fixture.
   *
   * `{bid}` is the same arrangement for a branch, with one extra constraint: the
   * salon B substitution must be the DISPOSABLE branch, because the control call
   * really renames and really closes it. See `branchFor`.
   */
  template: string;
  body?: unknown;
  /** The same call against salon B's own id must succeed. */
  controlBody?: unknown;
  /**
   * What the control call answers on success. Defaults to 200.
   *
   * Not every write returns one — `POST …/happy-hours` is a 201 and
   * `DELETE …/happy-hours/{hid}` is a 204. Asserting 200 across the board turns a
   * correctly implemented route into a red ledger entry.
   */
  controlStatus?: number;
  /**
   * BYTES for the control half, for a route whose body is a FILE rather than JSON.
   *
   * Only the control needs it. The cross-salon probe deliberately sends NO body at
   * all — `requireDashboardPerm` and `requireSameSalon` are the first two statements
   * in every image handler, so the refusal happens before a byte is looked at, and
   * sending a valid upload to a salon that is not yours would only prove the same
   * thing more slowly. It would also make the `existence is not disclosed` sweep
   * below post a file to an invented salon on every run.
   */
  controlUpload?: { bytes: Uint8Array; contentType: string };
}

/**
 * The branch the POST control creates, named so `afterAll` can find it and so no
 * two runs against one database can collide on `branch_salon_name_uq`.
 *
 * Declared above the table because the table uses it. A `const` below would be
 * in its temporal dead zone at module evaluation, which is a crash and not a
 * lint.
 */
const PROBE_BRANCH_PREFIX = 'Tenancy probe branch';
const PROBE_BRANCH_NAME = `${PROBE_BRANCH_PREFIX} ${Date.now()}`;

/**
 * DISPOSABLE PRODUCTS AND CAMPAIGNS, created by `beforeAll` and named so this file
 * owns them outright.
 *
 * Lane A's shop and campaign work added six salon-scoped routes and the gap ledger
 * fired on all six, which is what it is for. Three of them are destructive —
 * `DELETE …/products/{pid}`, `DELETE …/campaigns/{cid}` — and the CONTROL call really
 * deletes, so each needs its own row at salon B rather than sharing one.
 *
 * Salon A needs them too, and for the reason `happyHourFor` documents: the
 * cross-salon probe must be refused by `requireSameSalon` BEFORE the row is looked
 * up, so the id has to be one the handler would recognise. An id that exists nowhere
 * would answer 404 and a 404 in place of a 403 is exactly how a tenancy check that
 * runs too late hides.
 *
 * The seed makes no campaign at all and puts every product at salon A, so none of
 * this can be borrowed from fixtures.
 */
const PROBE_PRODUCT_A = 'PR-TEN-A';
const PROBE_PRODUCT_B_PATCH = 'PR-TEN-B-PATCH';
const PROBE_PRODUCT_B_DELETE = 'PR-TEN-B-DEL';
const PROBE_CAMPAIGN_A = 'CMP-TEN-A';
const PROBE_CAMPAIGN_B = 'CMP-TEN-B';

/**
 * THE TILLS THE DEVICE LEDGER ADDRESSES — decision 82, lane A's `devices.ts`.
 *
 * THREE IDS, ONE PER JOB, and the reason is the one `productFor` gives: the DELETE
 * control really revokes, so it cannot share a subject with anything.
 *
 *   `PROBE_DEVICE_A`         salon A's till, so the cross-salon DELETE addresses an id
 *                            the handler WOULD recognise. `requirePerm` and
 *                            `requireSameSalon` are the first two statements in the
 *                            revoke handler, so it is refused before the lookup today —
 *                            and `happyHourFor`'s reasoning is why the fixture exists
 *                            anyway: a 404 standing in for a 403 is exactly how a
 *                            tenancy check that has drifted later hides.
 *
 *   `PROBE_DEVICE_B_DELETE`  the row the control half revokes for real. Seeded in SQL
 *                            and NOT through `POST …/devices`, which is the row above
 *                            it in this table — the rule the image fixtures state.
 *
 *   `PROBE_DEVICE_B_POST`    the enrolment the POST control creates through the
 *                            endpoint, as a POST control should. Its slot is EMPTIED in
 *                            `beforeAll` rather than assumed empty, because a repeat
 *                            naming the same branch and label answers 200 where the row
 *                            pins 201.
 *
 * A LIVE ENROLMENT CHANGES WHAT `resolveBranch` ANSWERS, which is why these ids are
 * deliberately unlike any other device string in this suite. `session.device_id` is what
 * the lookup keys on, so an enrolment is inert for every charge made with a different
 * device — `B_SCANNER_DEVICE` included. Reusing a scanner device id here would silently
 * flip that session's charges from `branch_assumed` to established, which is the
 * shared-fixture trap one table over.
 */
const PROBE_DEVICE_A = 'DEV-TEN-A';
const PROBE_DEVICE_B_DELETE = 'DEV-TEN-B-DEL';
const PROBE_DEVICE_B_POST = 'DEV-TEN-B-POST';

/**
 * SALON B'S SOCIAL LINKS, and why two channels rather than one.
 *
 * `seedSalonB()` writes `social: '[]'::jsonb` and leaves it alone on conflict, so
 * without the fixture in `beforeAll` salon B has no links at all — and an
 * "unchanged" assertion about a link that does not exist is the vacuous green this
 * whole file exists to refuse.
 *
 *   `PROBE_SOCIAL_TABLE`     the channel the ledger row below addresses. Its control
 *                            half really writes to salon B, so it is seeded with an
 *                            empty handle and `on: false` — the row's `{ on: false }`
 *                            is then the smallest true edit available and renders
 *                            nothing in anybody's wallet.
 *   `PROBE_SOCIAL_UNTOUCHED` the channel the pair below probes. Seeded WITH a handle
 *                            and switched ON, because that pair's claim is that salon
 *                            A's manager cannot change either, and neither half of
 *                            that claim can be tested against a blank.
 *
 * They are deliberately different channels: the ledger's control writes to one and
 * the pair below reads the other, so neither can make the other pass or fail by the
 * order the two happen to run in — the shared-fixture trap `productFor` documents.
 */
/**
 * LANE A'S FOUR IMAGE WRITES — the subjects, and why there are four of them.
 *
 * The `{oid}` in `/v1/salons/{id}/{products,services}/{oid}/image` is a PRODUCT or a
 * SERVICE id, so it needs its own substitution: `{pid}` already means "a product for
 * the shop-catalog rows" and those are on their own price/delete lifecycle. Two owner
 * kinds times two verbs is four disposable rows at salon B, and they cannot be shared:
 *
 *   POST's control REALLY UPLOADS, so its owner must start with an empty slot or the
 *   handler answers 200-replaced instead of 201-created — which the table would read as
 *   a failed control (see the `POST …/campaigns` note above, the same trap one field
 *   over).
 *
 *   DELETE's control REALLY DETACHES, and `detachImage` answers 404 `no_image` when
 *   there is nothing on the slot. So its owner must start WITH an image, and it must
 *   not be POST's owner — otherwise the two specs pass or fail by table order, which is
 *   the shared-fixture trap `productFor` documents.
 *
 * AT SALON A THE PROBE USES ROWS THAT ALREADY EXIST — `PROBE_PRODUCT_A`, which this
 * file owns, and `A_SERVICE`, which the stock seed owns. Nothing new is inserted at
 * salon A on purpose: an extra active service there changes what
 * `GET /salons/{A}/services` serves and three other files read that list. The ids still
 * have to be REAL, for the reason `happyHourFor` gives: `requireSameSalon` runs before
 * `requireOwnerInSalon`, so a 404 here would mean the tenancy check ran too late, and
 * an id that exists nowhere could not tell that apart from a bad fixture.
 */
const PROBE_PRODUCT_B_IMAGE_POST = 'PR-TEN-B-IMG-POST';
const PROBE_PRODUCT_B_IMAGE_DELETE = 'PR-TEN-B-IMG-DEL';
const PROBE_SERVICE_B_IMAGE_POST = 'SV-TEN-B-IMG-POST';
const PROBE_SERVICE_B_IMAGE_DELETE = 'SV-TEN-B-IMG-DEL';

/**
 * The two blobs the DELETE controls detach, SEEDED IN SQL AND NOT THROUGH THE ENDPOINT.
 *
 * The rule this file already states for the shop and campaign fixtures — "creating them
 * through the very routes the ledger is about would make the fixture depend on the thing
 * under test" — applies hardest here, because the natural way to arrange an image to
 * delete is to POST one first, and that is the route in the row above.
 *
 * It works because a DETACH never reads the store: `detachImage` deletes the
 * `image_attachment` row and marks `image.detached_at`, both in Postgres, and the bytes
 * are the reaper's problem (`services/imageAttachment.ts` § RULE 5). So an `image` row
 * with a `storage_key` pointing at nothing is a perfectly good subject for a DELETE and
 * would be a 404 for a GET — which is correct, and which is why these ids are never
 * fetched.
 *
 * The checksums are literal because `image_checksum_is_sha256` demands 64 lowercase hex
 * and `image_salon_checksum_key` demands they differ from each other. They are
 * deliberately NOT the checksum of `PROBE_PNG`: if they collided, the POST control's
 * upload would DEDUPE onto one of these rows (`imageAttachment.ts` § RULE 3) and the two
 * fixtures would stop being independent.
 */
const PROBE_IMAGE_PRODUCT = 'IM-TENPROBEPR';
const PROBE_IMAGE_SERVICE = 'IM-TENPROBESV';

/**
 * A REAL PNG, and it is exactly as much PNG as the endpoint reads.
 *
 * `api/src/images/inspect.ts` § PNG walks the signature, asserts the first chunk length
 * is 13 and its type is `IHDR`, and reads the two dimensions out of the header. It
 * decodes nothing — that is the whole design (§ rule 2: "NOTHING HERE DECODES AN
 * IMAGE"). So a 1×1 header is a file this endpoint accepts, stores and re-serves, and
 * building a real compressed PNG here would be testing zlib.
 *
 * NOT a `rawBody` string. See `treq`'s `bytes` option: `fetch` would UTF-8 encode
 * `\x89PNG` into `\xC2\x89PNG` and the handler would refuse it as `not_an_image` — the
 * probe would go green for a reason that has nothing to do with tenancy.
 */
const PROBE_PNG = ((): Uint8Array => {
  const b = Buffer.alloc(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(1, 16); // width
  b.writeUInt32BE(1, 20); // height
  b[24] = 8; // bit depth
  b[25] = 6; // colour type: RGBA
  return b;
})();

const PROBE_SOCIAL_TABLE = 'tiktok';
const PROBE_SOCIAL_UNTOUCHED = 'instagram';
const B_SOCIAL_HANDLE = '@lumiere.kw';

/**
 * The handle salon A tries to repoint salon B's Instagram at, and the same one salon
 * B's own manager then writes successfully. One string for both on purpose: the two
 * specs below are the SAME request differing only in who sends it, which is what
 * makes the 403 attributable to the principal rather than to the body.
 */
const SOCIAL_ATTACK_HANDLE = '@stolen.by.another.salon';

/**
 * Every route that carries a salon id in the path, as registered in
 * `api/src/routes/salons.ts` and `api/src/routes/platform.ts`.
 *
 * Bodies are the minimum the handler would accept if it got that far. They are
 * deliberately valid: a 400 from a rejected body would mask whether the tenancy
 * gate ran at all.
 */
const SALON_ROUTES: SalonRoute[] = [
  { method: 'GET', template: '/salons/{id}' },
  { method: 'GET', template: '/salons/{id}/metrics' },
  { method: 'GET', template: '/salons/{id}/products' },
  { method: 'GET', template: '/salons/{id}/bookings' },
  { method: 'GET', template: '/salons/{id}/services' },
  { method: 'GET', template: '/v1/salons/{id}/promotions' },
  {
    method: 'PATCH',
    template: '/salons/{id}',
    /**
     * `noShowReturnMinutes`, AND IT WAS `stampTarget` UNTIL THE LOYALTY REVERSAL.
     *
     * This row asks one question — does `requireSameSalon` fire on the merchant's
     * general-purpose settings write — and it can only ask it with a field that is
     * still MERCHANT-EDITABLE. `stampTarget` left `MERCHANT_EDITABLE` for
     * `PLATFORM_ONLY_EDITABLE` when loyalty authority moved to AVO (decision 79), so
     * both halves of the pair broke, and they broke in OPPOSITE directions:
     *
     *   the attack half still answered 403 — but `loyalty_read_only`, thrown by
     *   `buildSalonPatch` BEFORE the tenancy guard is reached. Green on the status,
     *   red on the copy, and had the copy not been asserted this row would have gone
     *   on "passing" while testing nothing about tenancy at all.
     *
     *   the control half answered 403 where it wants 200, which is the failure that
     *   actually surfaced it. That asymmetry is the argument for `controlStatus` and
     *   for asserting the refusal COPY rather than the status alone: a probe whose
     *   body has stopped being reachable looks exactly like a probe that passed.
     *
     * `60` is what `seedSalonB()` sets, so the control call restores the seeded value
     * rather than leaving salon B on a number nothing chose. `999` is a legal window
     * (`parseNoShowReturnMinutes` wants a whole number above zero), so the attack half
     * cannot be refused by validation instead of by tenancy — which is the property the
     * table header asks of every body here.
     */
    body: { noShowReturnMinutes: 999 },
    controlBody: { noShowReturnMinutes: 60 },
  },
  {
    method: 'POST',
    template: '/v1/salons/{id}/campaigns',
    body: { title: 'tenancy probe', body: 'tenancy probe', channel: 'push' },
    /**
     * 201, not the default 200. The route answers `created` and this entry asserted
     * 200 — green while the control was refused for a different reason, red the moment
     * it started succeeding, which is how it surfaced. The `controlStatus` field exists
     * for exactly this and `POST …/happy-hours` already uses it.
     */
    controlStatus: 201,
  },
  /**
   * ---- lane A's Reports routes. The gap ledger fired on both, by name, in the first
   * full run after the rebase that brought them in — the third census to catch the same
   * surface arriving (contract.test.ts's UNMODELLED and permission-census.test.ts's
   * DYNAMIC_PERMISSION ledger are the other two). A report is the densest tenant read
   * in the API — names, phones and balances by design — so the 403 here is the one that
   * matters most, and `sales` is used because a valid kind is required to get PAST the
   * vocabulary check to the salon check (see `url()`).
   */
  { method: 'GET', template: '/salons/{id}/reports/{kind}' },
  { method: 'GET', template: '/salons/{id}/reports/{kind}.csv' },
  /**
   * The download-URL mint, arriving with dev `f3ee47d` and named by the gap ledger on the
   * first run after the rebase. It matters more here than its siblings: it mints a
   * CAPABILITY that is later redeemed with no session at all, so a cross-salon mint would
   * hand out a bearer token for another salon's customer book.
   *
   * 200, NOT 201 — and I asserted 201 first, on the reasoning that a mint "creates"
   * something. The control call caught it: `{"url":"/report-downloads/tok_…","expiresAt":…}`
   * with a 200. Left at the default rather than pinned, and written down because the guess
   * was the same shape as the `POST …/campaigns` entry that once asserted 200 against a
   * 201 — a plausible status is not an observed one.
   *
   * The control really mints a token at salon B. Harmless: 60 seconds, single-use, and
   * nothing redeems it, so it expires unused inside the run that made it.
   */
  { method: 'POST', template: '/salons/{id}/reports/{kind}/download-url' },
  // ---- lane A's shop and campaign routes. The gap ledger fired on all six. ----
  { method: 'GET', template: '/v1/salons/{id}/messaging-policy' },
  { method: 'GET', template: '/v1/salons/{id}/campaigns' },
  {
    method: 'POST',
    template: '/salons/{id}/products',
    body: { name: 'Tenancy probe product', priceFils: 1000 },
    controlStatus: 201,
  },
  {
    method: 'PATCH',
    template: '/salons/{id}/products/{pid}',
    body: { priceFils: 9999 },
    controlBody: { priceFils: 1000 },
  },
  {
    method: 'DELETE',
    template: '/salons/{id}/products/{pid}',
    controlStatus: 204,
  },
  {
    method: 'DELETE',
    template: '/v1/salons/{id}/campaigns/{cid}',
    controlStatus: 204,
  },
  // Added by trunk when lane A's five new routes merged. The ledger fired
  // correctly on the merge — that is what it is for. Its sibling assertion,
  // which drives every AUTO-DISCOVERED route, already passed against all five,
  // so tenancy was proven before this list was updated; only the hand-written
  // half was stale.
  { method: 'GET', template: '/salons/{id}/artists' },
  // Lane A's customer-facing roster. Same story a third time: the auto-discovering
  // sibling passed on it the moment it landed, and lane A independently confirmed a
  // member on another salon's `/artists/bookable` gets 403. Only this half was stale.
  { method: 'GET', template: '/salons/{id}/artists/bookable' },
  { method: 'GET', template: '/salons/{id}/audit' },
  { method: 'GET', template: '/salons/{id}/activity' },
  /**
   * The loyalty READ is still a merchant door and stays here. The loyalty WRITE
   * used to sit directly below it and is gone — see the block comment on
   * `PUT /salons/{id}/loyalty` after this table.
   */
  { method: 'GET', template: '/salons/{id}/loyalty' },

  /**
   * LANE A'S FOUR PROMOTION WRITES.
   *
   * These are the first entries in this table that need real fixtures rather than
   * only a valid body, and the difference is worth stating because adding them
   * from outside the suite is what broke: the control half — "against salon B's
   * own id succeeds" — genuinely performs the write, so
   *
   *   - `PATCH` and `DELETE` need a happy hour that EXISTS AT SALON B. `{hid}` is
   *     substituted per salon for that reason; salon A's `HH-01` is not salon B's.
   *   - `DELETE`'s control really deletes it, so its fixture is re-created by
   *     `seedSalonB()` on every run. A stable id would pass once and 404 for ever.
   *   - `POST` answers 201 and `DELETE` answers 204, hence `controlStatus`.
   *
   * The bodies below are deliberately valid AND harmless. Every boost is 1x/0/1x
   * and every window is created `on: false`, because the control call writes them
   * to salon B for real and a live 2x-visit promotion would change what
   * `scanner.test.ts` observes a charge doing.
   */
  {
    method: 'PUT',
    template: '/v1/salons/{id}/promotions/boosts',
    // The identity boost — no multiplier anywhere. Proves the route runs without
    // making any other suite's money literals depend on this one having run.
    body: { boosts: { [B_BRANCH]: { visit: 1, topup: 0, stamp: 1 } } },
  },
  {
    method: 'POST',
    template: '/v1/salons/{id}/promotions/happy-hours',
    body: {
      branchId: 'all',
      days: [3],
      from: '09:00',
      to: '10:00',
      reward: 'x2visit',
      on: false,
      notify: false,
    },
    controlStatus: 201,
  },
  {
    method: 'PATCH',
    template: '/v1/salons/{id}/promotions/happy-hours/{hid}',
    body: { on: false },
  },
  {
    method: 'DELETE',
    template: '/v1/salons/{id}/promotions/happy-hours/{hid}',
    controlStatus: 204,
  },

  /**
   * LANE A'S THREE BRANCH WRITES.
   *
   * The ledger fired on the merge, correctly — its auto-discovering sibling had
   * already proved all three refuse a principal from another salon, so tenancy
   * was never in doubt; only this hand-written half was stale.
   *
   * These are the most destructive control calls in the table, and a branch is
   * not a promotion. The open-branch COUNT of a salon is what `services/branch.ts`
   * decides on, so a control call that closes the wrong row rewrites what
   * `promotions.test.ts` measures three files later. Hence:
   *
   *   - `POST` creates a REAL branch at salon B. Its name is unique per run —
   *     `branch_salon_name_uq` spans CLOSED branches, so a fixed name would 409
   *     against any database this suite ran on twice — and `afterAll` removes it.
   *     That leak, uncleaned, is what took `dev` to fifteen failures.
   *   - `PATCH` and `DELETE` point at `B_BRANCH_DISPOSABLE`, never at a fixture.
   *     A rename would collide on the unique index next run, and a close would
   *     drop salon B to one open branch, flipping every charge in the suite from
   *     "assumed" to "established".
   *   - `DELETE` answers 200 carrying the closed branch, not 204. A close is a
   *     state the merchant has to be shown, not a disappearance — so the default
   *     `controlStatus` is right and saying so here is the point.
   */
  {
    method: 'POST',
    template: '/salons/{id}/branches',
    body: { name: PROBE_BRANCH_NAME },
    controlStatus: 201,
  },
  {
    method: 'PATCH',
    template: '/salons/{id}/branches/{bid}',
    // `nameAr` rather than `name`: the Arabic twin is nullable and unconstrained,
    // so the control call cannot collide with `branch_salon_name_uq` however many
    // times this suite has run.
    body: { nameAr: 'فرع الاختبار' },
  },
  {
    method: 'DELETE',
    template: '/salons/{id}/branches/{bid}',
  },
  /**
   * The closure PREVIEW, and it is listed after the DELETE for a reason worth
   * keeping: on salon B the control calls run in order, so by the time this one
   * fires the disposable branch has already been closed by the entry above. The
   * preview answers 200 for a closed branch — `closable: false` with
   * `blockedReason: 'already_closed'` — so the control still succeeds, and the
   * ordering is harmless rather than merely lucky.
   *
   * A READ that answers what a WRITE would do, which is exactly the shape that
   * needs the cross-salon check as much as the write does: the impact report names
   * this salon's staff and counts her customers' held deposits. Leaking it would
   * leak the roster and the money without changing anything, and a route that only
   * looks is the one most easily assumed to be safe.
   */
  {
    method: 'GET',
    template: '/salons/{id}/branches/{bid}/closure-preview',
  },

  /**
   * LANE A'S THREE DEVICE-ENROLMENT DOORS — dev `45a60a1`, closing decision 82.
   *
   * The ledger fired on all three, and the AUTO-DISCOVERING SIBLING at the foot of this
   * file was ALREADY GREEN on them — "EVERY discovered route refuses salon B with 403 and
   * no salon A data" passed on the same run these three rows were missing. So tenancy was
   * never in doubt here either; only this hand-written half was behind. That is the fourth
   * time this pair has split that way, and it is the ledger's job working as intended: the
   * LIST is what goes stale, not the enforcement.
   *
   * WHAT MAKES THESE WORTH A SPEC EACH ANYWAY. A till is bound to a BRANCH, and the branch
   * is what decides whose earning rates apply to the money taken at it (`services/branch.ts`
   * § resolveBranch). A cross-salon read here would name another salon's branches; a
   * cross-salon POST would point her till at them. The composite foreign key
   * `device_enrolment_branch_same_salon_fk` means such a row cannot COMMIT — that is the
   * control — but the 403 is what stops the attempt being informative, and
   * `unknown_branch` is deliberately a 404 rather than a 403 for `resolveBranch`'s own
   * reason: a 403 would confirm the id names a real branch somewhere.
   *
   * `{bid}` IS NOT USED HERE, DELIBERATELY, and it is the one trap in this group. The POST
   * enrols into an OPEN branch — the handler filters `closedAt IS NULL` and answers
   * `unknown_branch` otherwise — and `branchFor(SALON_B)` resolves to
   * `B_BRANCH_DISPOSABLE`, which the `DELETE …/branches/{bid}` control four rows above
   * has already CLOSED by the time these run. So the control body names `B_BRANCH`, a
   * stable open branch, and this group is immune to its position in the table rather than
   * merely lucky in it.
   */
  {
    method: 'GET',
    template: '/salons/{id}/devices',
  },
  {
    method: 'POST',
    template: '/salons/{id}/devices',
    /**
     * The attack half names SALON A'S OWN BRANCH — the body a real cross-tenant attempt
     * would carry, and the table header's rule is why: a body that could be rejected on
     * its own merits would mask whether the tenancy gate ran. It is never resolved
     * (`requireSameSalon` precedes the branch lookup), which is the point.
     */
    body: { deviceId: PROBE_DEVICE_B_POST, branchId: A_BRANCH, label: 'Tenancy probe till' },
    /**
     * 201, not the default 200: a genuine enrolment answers `created`, and a REPEAT
     * naming the same branch and label answers 200 with nothing written. `beforeAll`
     * empties this device's slot for exactly that reason, so this row pins the create
     * path rather than passing on the idempotent one.
     */
    controlBody: { deviceId: PROBE_DEVICE_B_POST, branchId: B_BRANCH, label: 'Tenancy probe till' },
    controlStatus: 201,
  },
  {
    method: 'DELETE',
    template: '/salons/{id}/devices/{deviceId}',
    /**
     * 200 carrying `{ deviceId, enrolled: false }`, not 204 — the same call the branch
     * close makes and for the same reason: a revocation is a state the merchant is shown,
     * not a disappearance. So the default `controlStatus` is right, and saying so is the
     * point of this comment.
     *
     * The control really revokes, and `revoked_at IS NULL` is in the UPDATE's own WHERE
     * clause, so a second run against one database would find the row already revoked and
     * answer 404. `beforeAll` un-revokes it rather than re-inserting it.
     */
  },

  /**
   * LANE A'S PER-LINK SOCIAL WRITE — the endpoint api-contract.md named for weeks
   * without it existing, and the reason this table is hand-written as well as
   * discovered.
   *
   * The ledger fired on it in the first end-to-end `pnpm check` after the merge, by
   * name, and nothing else in that run had an opinion: trunk merged the route after
   * running api's unit and integration suites and not `e2e/`. The auto-discovering
   * sibling at the foot of this file had already passed against it — `requireSameSalon`
   * runs BEFORE the channel vocabulary check, so even a literal `:linkId` is refused
   * at the boundary — so tenancy was proven the moment the route landed. Only this
   * half was stale, which is the same story the artists and branch rows above already
   * carry and is worth writing down once more: the ledger's job is the LIST, not the
   * enforcement.
   *
   * `{linkId}` NEEDS NO PER-SALON RESOLUTION, and it is the second placeholder in this
   * table that does not. `{kind}` is the first, for the same reason: the four channel
   * ids are a closed vocabulary from the contract rather than row ids, so `tiktok`
   * addresses a link at every salon by definition, and `applySocialPatch` creates one
   * for a salon that has none. It still has to be a REAL member of that vocabulary —
   * an unknown channel is a 400 naming the four, and a 400 in place of a 403 would
   * mean the probe never reached the boundary it exists to test.
   *
   * `{ on: false }` AND NOT A HANDLE, because the control half really writes to salon
   * B. `beforeAll` seeds this channel with an empty handle, so hiding an icon that
   * renders nothing is the smallest true edit available and it is idempotent across
   * runs. Salon B's Instagram is deliberately left for the pair below, whose entire
   * claim is that it is still there afterwards.
   */
  {
    method: 'PATCH',
    template: '/v1/salons/{id}/social/{linkId}',
    body: { on: false },
  },

  /**
   * LANE A'S FOUR IMAGE WRITES, arriving with dev `b4e5cf3`. The ledger fired on all
   * four by name in the first run after the merge, and its auto-discovering sibling —
   * `EVERY discovered route refuses salon B with 403` — was already GREEN against them,
   * so tenancy was proved the hour they landed and only this hand-written half was
   * stale. That is now the sixth time that has been the story, and it is worth saying
   * once more in the place a reader meets it: THE LEDGER'S JOB IS THE LIST, NOT THE
   * ENFORCEMENT.
   *
   * These are the first rows in this table whose control half sends something that is
   * not JSON, and the first whose subject has to be arranged in two different states
   * per verb. Both are covered above `PROBE_PRODUCT_B_IMAGE_POST`.
   *
   * NO BODY ON THE PROBE, deliberately — see `controlUpload` on the interface. A POST
   * with no `Content-Type` and no body reaches the handler and is refused by
   * `requireSameSalon` before `performUpload` is ever called, which is exactly the
   * ordering `routes/images.ts` argues for at its registration sites ("AUTHORITY FIRST,
   * BEFORE THE OWNER IS LOOKED UP AND BEFORE A SINGLE BYTE IS INSPECTED") and would
   * catch a future refactor that validated the file first: an unauthorised caller who
   * gets `unsupported_image_type` back has been handed a free image-format oracle.
   *
   * 201 ON THE POST CONTROLS, because the slot starts empty. `performUpload` answers
   * 201 when it created and 200 when it replaced, and the distinction is the dashboard's
   * "added" versus "changed" toast — so pinning 201 here also pins that the disposable
   * owner really did start with nothing on it, which is what keeps this row and the
   * DELETE row independent.
   *
   * 204 ON THE DELETE CONTROLS, from `performDetach`.
   */
  {
    method: 'POST',
    template: '/v1/salons/{id}/products/{oid}/image',
    controlUpload: { bytes: PROBE_PNG, contentType: 'image/png' },
    controlStatus: 201,
  },
  {
    method: 'DELETE',
    template: '/v1/salons/{id}/products/{oid}/image',
    controlStatus: 204,
  },
  {
    method: 'POST',
    template: '/v1/salons/{id}/services/{oid}/image',
    controlUpload: { bytes: PROBE_PNG, contentType: 'image/png' },
    controlStatus: 201,
  },
  {
    method: 'DELETE',
    template: '/v1/salons/{id}/services/{oid}/image',
    controlStatus: 204,
  },
];

/**
 * A branch that belongs to the salon being addressed.
 *
 * Salon B always gets the disposable one — the PATCH renames it and the DELETE
 * closes it, and `seedSalonB()` restores both on the next run. Salon A gets a
 * real seeded branch for the same reason the happy hour does: the cross-salon
 * probe must be refused by `requireSameSalon` BEFORE the branch is read, and an
 * id that does not exist anywhere would make a 404-instead-of-403 impossible to
 * tell from the tenancy check running too late.
 */
const branchFor = (salonId: string): string =>
  salonId === SALON_B ? B_BRANCH_DISPOSABLE : A_BRANCH;

/**
 * A happy hour that belongs to the salon being addressed.
 *
 * The DELETE route gets the disposable one at salon B — the control deletes it,
 * and `seedSalonB()` puts it back on the next run. Everything else gets the
 * stable window.
 *
 * At salon A this only ever has to be an id the handler would recognise: the
 * cross-salon probes must be refused by `requireSameSalon` BEFORE the happy hour
 * is looked up, and a 404 in place of a 403 would mean the tenancy check ran too
 * late — which the ledger's own assertions would then catch, correctly.
 */
function happyHourFor(route: SalonRoute, salonId: string): string {
  if (salonId !== SALON_B) return A_HAPPY_HOUR;
  return route.method === 'DELETE' ? B_HAPPY_HOUR_DISPOSABLE : B_HAPPY_HOUR;
}

/**
 * A product belonging to the salon being addressed.
 *
 * Salon B gets a DIFFERENT disposable row per verb, because the DELETE control really
 * deletes and would otherwise take the PATCH's subject with it — the two specs run in
 * table order and would then pass or fail by that order, which is the shared-fixture
 * trap this file exists to avoid.
 */
function productFor(route: SalonRoute, salonId: string): string {
  if (salonId !== SALON_B) return PROBE_PRODUCT_A;
  return route.method === 'DELETE' ? PROBE_PRODUCT_B_DELETE : PROBE_PRODUCT_B_PATCH;
}

/**
 * The product or service an image route hangs a picture on.
 *
 * FOUR DISPOSABLE ROWS AT SALON B, one per (owner kind, verb) — see the note above
 * `PROBE_PRODUCT_B_IMAGE_POST`. At salon A it is a row that already exists, because
 * the cross-salon probe is refused before `{oid}` is ever resolved and inserting a
 * fifth active service at salon A would change a list three other files read.
 *
 * The owner KIND is read off the template rather than passed in, because the template
 * is the only place it is stated and a second parameter saying the same thing is a
 * second thing that can disagree with it.
 */
function imageOwnerFor(route: SalonRoute, salonId: string): string {
  const isProduct = route.template.includes('/products/');
  if (salonId !== SALON_B) return isProduct ? PROBE_PRODUCT_A : A_SERVICE;
  if (isProduct) {
    return route.method === 'DELETE'
      ? PROBE_PRODUCT_B_IMAGE_DELETE
      : PROBE_PRODUCT_B_IMAGE_POST;
  }
  return route.method === 'DELETE'
    ? PROBE_SERVICE_B_IMAGE_DELETE
    : PROBE_SERVICE_B_IMAGE_POST;
}

/** A campaign belonging to the salon being addressed. Only DELETE uses it. */
const campaignFor = (salonId: string): string =>
  salonId === SALON_B ? PROBE_CAMPAIGN_B : PROBE_CAMPAIGN_A;

/**
 * An ENROLLED device belonging to the salon being addressed. Only DELETE uses it.
 *
 * No per-verb split, unlike `productFor`: the DELETE is the only verb carrying `{deviceId}`,
 * because `POST …/devices` names its device in the BODY rather than the path.
 */
const deviceFor = (salonId: string): string =>
  salonId === SALON_B ? PROBE_DEVICE_B_DELETE : PROBE_DEVICE_A;

const url = (r: SalonRoute, salonId: string) =>
  r.template
    .replace('{id}', salonId)
    .replace('{hid}', happyHourFor(r, salonId))
    .replace('{bid}', branchFor(salonId))
    .replace('{pid}', productFor(r, salonId))
    .replace('{cid}', campaignFor(salonId))
    /**
     * `{deviceId}` is an enrolled device at the salon being addressed, resolved the way
     * `{cid}` is and for the same reason: the control half really revokes, so the id has
     * to be a live enrolment at THAT salon or the control 404s and the ledger reports a
     * tenancy hole that is really a missing fixture.
     *
     * AND THE BRACE NAME IS `{deviceId}` RATHER THAN `{did}` BECAUSE IT HAS TO BE. The
     * gap-ledger normaliser is the generic `\{(\w+)\}` → `:$1`, so the placeholder's
     * name IS the fastify parameter's name after substitution. `{did}` normalises to
     * `:did`, the route registers `:deviceId`, and the entry then reads as missing from a
     * table it is sitting in — the confusing hour that comment predicts, which this row
     * duly spent. Every future placeholder must match the registered parameter exactly.
     */
    .replace('{deviceId}', deviceFor(salonId))
    /**
     * `{oid}` is the image routes' owner — a product or a service, chosen by the
     * template and the verb. See `imageOwnerFor`.
     */
    .replace('{oid}', imageOwnerFor(r, salonId))
    /**
     * `{kind}` is a closed vocabulary, not a row id, so it needs no per-salon
     * resolution — `sales` exists at every salon by definition. It DOES need to be a
     * real member of the vocabulary: reports.ts validates the kind BEFORE choosing the
     * permission (the permission is selected BY the kind), so a placeholder kind is
     * refused at 400 and the probe never reaches the tenant boundary it exists to test.
     */
    .replace('{kind}', 'sales')
    /**
     * `{linkId}` is a closed vocabulary too, so it resolves the way `{kind}` does and
     * not the way `{hid}` and `{pid}` do — see the table row that uses it. It must be
     * a real channel all the same: `PATCH …/social/{linkId}` answers 400
     * `unknown_social_link` for anything outside the four, and this substitution is
     * what keeps the control half addressing a link rather than a typo.
     */
    .replace('{linkId}', PROBE_SOCIAL_TABLE);

describe("salon-scoped routes — salon B's manager calling salon A's URL", () => {
  for (const route of SALON_ROUTES) {
    const label = `${route.method} ${route.template}`;

    it(`${label} → 403, and the body is the refusal and nothing else`, async () => {
      const res = await treq<{ error: string; message: string }>(
        route.method,
        url(route, SALON_A),
        { token: bDashboard, ...(route.body === undefined ? {} : { body: route.body }) },
      );

      expect(res.status, `${label} answered ${res.status}: ${res.raw}`).toBe(403);
      expect(res.body.error).toBe('forbidden');
      expect(res.body.message).toBe('That salon is not yours.');
      // Two keys, no third. A refusal that also carries `items: []` has told the
      // caller the route exists and the shape of what it serves.
      expect(Object.keys(res.body).sort()).toEqual(['error', 'message']);
      expectNoSalonALeak(res.raw, label);
    });

    it(`${label} against salon B's own id succeeds — the 403 was tenancy, not a broken route`, async () => {
      const body = route.controlBody ?? route.body;
      const upload = route.controlUpload;
      const res = await treq(route.method, url(route, SALON_B), {
        token: bDashboard,
        // A file body and a JSON body are mutually exclusive, and `treq` refuses
        // both together rather than picking one silently.
        ...(upload
          ? { bytes: upload.bytes, headers: { 'content-type': upload.contentType } }
          : body === undefined
            ? {}
            : { body }),
      });
      expect(res.status, `the control call answered ${res.status}: ${res.raw}`).toBe(
        route.controlStatus ?? 200,
      );
    });
  }
});

/**
 * ===========================================================================
 * PUT /salons/{id}/loyalty — THE ROW THAT LEFT THE TABLE, AND WHAT REPLACES IT.
 * ===========================================================================
 * It was a `SALON_ROUTES` entry until decision 79 moved loyalty authority from the
 * merchant to AVO. It is now a CONSOLE door — `sections.salons`, merchant refused —
 * so the table's claim no longer describes it in either half:
 *
 *   the attack half asserted `forbidden` / "That salon is not yours.". The merchant
 *   is now refused one guard EARLIER, on principal kind, with `loyalty_read_only`.
 *   Same status, different fact.
 *
 *   the control half asserted 200 against salon B's own id. There is no longer any
 *   merchant call to this endpoint that answers 200, so the row could not be
 *   repaired — only moved.
 *
 * COVERAGE IS NOT DELETED WITH IT. Three things the table row used to hold are held
 * here instead, and a fourth that it never held at all:
 *
 *   1. the merchant is refused her OWN salon's ladder — the withdrawal itself, which
 *      is the assertion Aftab's reversal actually rests on. It is in
 *      `configuration.test.ts` with the rest of the loyalty editor, driven with
 *      `perms.loyalty` verified ON, per non-negotiable #7.
 *   2. the merchant is refused ANOTHER salon's ladder, and learns nothing about it.
 *      Below.
 *   3. the console reaches BOTH salons, which is the inverse claim and the one that
 *      proves the 403 above is about authority rather than a dead route. Below.
 *   4. the refusal ORDER — kind before tenancy — which the table row could not have
 *      asserted, because a table row that expects one 403 cannot tell two apart.
 *
 * The auto-discovering sweep at the bottom of this file still drives this route as
 * well: it is still `/salons/:id`-shaped, so `discoverSalonScopedRoutes()` finds it
 * and requires a 403 with no salon A data in it. That half never needed the table.
 */
describe('PUT /salons/{id}/loyalty — withdrawn from the merchant, and withdrawn the same way at every salon', () => {
  let platform = '';

  const LADDER = {
    mode: 'tiers',
    tiers: [
      { name: 'bronze', minVisits: 0, bonusPercent: 0 },
      { name: 'silver', minVisits: 4, bonusPercent: 10 },
      { name: 'gold', minVisits: 10, bonusPercent: 20 },
      { name: 'black', minVisits: 20, bonusPercent: 30 },
    ],
  };

  beforeAll(async () => {
    platform = await signInPlatform(PLATFORM_OWNER_HANDLE);
  }, 60_000);

  /**
   * THE REFUSAL IS BY PRINCIPAL KIND, SO IT IS THE SAME AT EVERY SALON — and that
   * sameness is the tenancy property, not an accident of ordering.
   *
   * `requireLoyaltyPublisher` refuses a staff principal before it has looked at the
   * salon id, the salon row, or the body. So salon B's Layla aiming at salon A gets
   * exactly the answer she gets aiming at her own salon: `403 loyalty_read_only`, no
   * mention of SAL-AMARA, and no signal about whether SAL-AMARA exists or whether she
   * is inside it. Had the guard been written the natural-looking way round —
   * `requireSameSalon` first — this call would have answered "That salon is not
   * yours." and told her both.
   *
   * Asserted as a PAIR, byte for byte, because either half alone is satisfiable by a
   * broken product: the foreign call alone cannot distinguish a kind refusal from a
   * tenancy refusal, and the own-salon call alone says nothing about disclosure.
   */
  it('a merchant is refused another salon\'s ladder in exactly the words she is refused her own', async () => {
    const foreign = await treq<{ error: string; message: string }>(
      'PUT',
      `/salons/${SALON_A}/loyalty`,
      { token: bDashboard, body: LADDER },
    );
    const own = await treq<{ error: string; message: string }>(
      'PUT',
      `/salons/${SALON_B}/loyalty`,
      { token: bDashboard, body: LADDER },
    );

    expect(foreign.status, `salon A answered ${foreign.status}: ${foreign.raw}`).toBe(403);
    expect(own.status, `salon B answered ${own.status}: ${own.raw}`).toBe(403);

    expect(foreign.body.error).toBe('loyalty_read_only');
    expect(own.body.error).toBe('loyalty_read_only');
    // The whole body, not just the code. A message that named the salon — or that
    // differed between the two — would be the existence oracle this file exists to
    // refuse, arriving through the copy rather than through the status.
    expect(foreign.body).toEqual(own.body);
    expect(Object.keys(foreign.body).sort()).toEqual(['error', 'message']);
    expectNoSalonALeak(foreign.raw, 'PUT /salons/{id}/loyalty as a foreign merchant');
  });

  /**
   * AND THE REFUSAL WROTE NOTHING AT EITHER SALON.
   *
   * `PATCH …/social/{linkId}`'s note above is the argument in full: a handler that
   * answers 403 and writes anyway passes any spec that only reads the response. The
   * ladder is one jsonb column, so "unchanged" is a single exact comparison, and it is
   * made at BOTH salons because the guard is claimed to fire before the salon id is
   * even read — if that were false, the foreign call is the one that would land.
   */
  it('and neither refusal moved a rung — at her salon or at the other one', async () => {
    const beforeA = scalar(`select tiers::text from salon where id='${SALON_A}'`);
    const beforeB = scalar(`select tiers::text from salon where id='${SALON_B}'`);

    await treq('PUT', `/salons/${SALON_A}/loyalty`, { token: bDashboard, body: LADDER });
    await treq('PUT', `/salons/${SALON_B}/loyalty`, { token: bDashboard, body: LADDER });

    expect(
      scalar(`select tiers::text from salon where id='${SALON_A}'`),
      'a refused merchant publish rewrote ANOTHER salon\'s ladder',
    ).toBe(beforeA);
    expect(
      scalar(`select tiers::text from salon where id='${SALON_B}'`),
      'a refused merchant publish rewrote her own salon\'s ladder',
    ).toBe(beforeB);
  });

  /**
   * THE INVERSE CLAIM, and without it the two specs above are satisfied by a route
   * that is broken or unregistered rather than by a route that is enforcing.
   *
   * One console credential is admitted at BOTH salons — cross-salon is the feature
   * here, exactly as it is at `GET|PATCH /v1/platform/salons/{id}`. Nothing is
   * published: `PUT` is not the assertion, ADMISSION is, so this drives the GET,
   * which takes the same `sections.salons` gate through `requireLoyaltyReader` and
   * writes nothing at all. The publish itself is proved in `configuration.test.ts`,
   * against salon B, where a written ladder is that file's own business.
   */
  it('and one console credential reads the ladder at BOTH salons — cross-salon is the feature here', async () => {
    for (const salonId of [SALON_A, SALON_B]) {
      const res = await treq<{ loyaltyMode: string }>('GET', `/salons/${salonId}/loyalty`, {
        token: platform,
      });
      expect(res.status, `the console was refused ${salonId}: ${res.raw}`).toBe(200);
      expect(res.body.loyaltyMode, `${salonId} served no loyalty mode`).toBeTruthy();
    }
  });
});

/**
 * PATCH /v1/salons/{id}/social/{linkId} — THE LEDGER ROW ABOVE, PROVED PROPERLY.
 *
 * The table's pair is the right shape for thirty routes and the wrong shape for this
 * one question. It asserts a status and asserts the control succeeds; it never looks
 * at salon B's data afterwards. Two different broken products pass it:
 *
 *   - a route that answers 403 and writes anyway, and
 *   - a route that answers 403 because it is not registered at all.
 *
 * So this pair asserts three things the table cannot.
 *
 * THE CODE, NOT THE STATUS. A 404 from a missing route and a 403 from
 * `requireSameSalon` are different facts about the product and only one of them is
 * enforcement, so `forbidden` / "That salon is not yours." is asserted by value. That
 * is the string `requireSameSalon` throws, and nothing else in this handler produces
 * it: every other refusal it can give — `unknown_social_link`, `invalid_field`,
 * `invalid_handle`, `handle_is_a_url`, `invalid_request`, `unknown_salon` — lives
 * BELOW the guard and none of them is a 403.
 *
 * THE DATA. Salon B's Instagram is read through salon B's own credential before and
 * after, and the handle and the switch are asserted INDIVIDUALLY as well as by
 * equality — an `after` that deep-equals a `before` which had already been clobbered
 * would be green, and the seeded values are asserted up front so "unchanged" is a
 * claim about a real handle rather than about a blank. The stored column is read too,
 * because a read path that filtered something would hide a write that landed.
 *
 * THE DIRECTION. Everything above this line runs B → A, because Layla is the
 * principal this file signs in. The hole runs both ways, and salon A's Noura holds
 * every permission, so her 403 can only be the salon boundary and never a missing
 * one. She is the `token: null` principal — the tripwire at the top of this file
 * asserts, rather than assumes, that `AVO_TEST_PRINCIPALS` resolves an
 * unauthenticated request to a staff member at salon A.
 *
 * WHAT WOULD STILL PASS IF THE GUARD WERE GONE? Asked, and then answered by really
 * commenting `requireSameSalon` out of this handler and running the file. Both halves
 * of the pair go red — the table row above at 200, and this spec at 200 — and the 200
 * this spec reports carries
 *
 *     "handle":"@stolen.by.another.salon" … "on":false
 *
 * in salon B's own `links` array. So the write landed: the refusal and the data are
 * two separate facts and the mutation moved both. Recorded precisely because the
 * assertion ORDER hides half of it — vitest stops this spec at the status line, so
 * the handle and column assertions below never ran; the clobbering is visible in the
 * failure message rather than named by an assertion of its own. They are the half
 * that catches the OTHER shape of defect, a handler that refuses and writes anyway,
 * which no mutation of this guard can produce.
 *
 * The same run reddened two specs this file already had — the `existence is not
 * disclosed` sweep and the auto-discovering `EVERY discovered route` sweep — so four
 * failures in total, from one commented line. Restored, re-run, 104 green. The
 * mutation was not committed; `api/` is not lane D's column.
 */
interface SocialProbe {
  id: string;
  label: string;
  handle: string;
  on: boolean;
}

describe('PATCH /v1/salons/{id}/social/{linkId} — the refusal, and salon B untouched', () => {
  /**
   * Salon B's Instagram as salon B itself sees it, through the product's own read.
   * `GET /salons/{id}` serves `social` to any principal at that salon, and `bDashboard`
   * is one, so this is the merchant's own view of her own row rather than a fixture
   * this file is holding a copy of.
   */
  async function readBInstagram(): Promise<SocialProbe> {
    const res = await treq<{ social: SocialProbe[] }>('GET', `/salons/${SALON_B}`, {
      token: bDashboard,
    });
    expect(res.status, `could not read salon B's own salon row: ${res.raw}`).toBe(200);
    const link = (res.body.social ?? []).find((l) => l.id === PROBE_SOCIAL_UNTOUCHED);
    // Not a soft skip. If the fixture did not land, every assertion below is about
    // nothing and the honest outcome is a failure naming the seed.
    expect(
      link,
      `salon B has no ${PROBE_SOCIAL_UNTOUCHED} link, so there is nothing to leave ` +
        `unchanged — the social UPDATE in beforeAll did not land: ${res.raw}`,
    ).toBeDefined();
    return link as SocialProbe;
  }

  it("salon A's manager cannot repoint salon B's Instagram, and salon B's link is unchanged", async () => {
    const before = await readBInstagram();
    // NON-VACUOUS. "Unchanged" said of an empty handle and a false switch is a
    // sentence about nothing; these two lines are what make the pair at the end of
    // this spec an assertion.
    expect(before.handle).toBe(B_SOCIAL_HANDLE);
    expect(before.on).toBe(true);

    const attack = await treq<{ error: string; message: string }>(
      'PATCH',
      `/v1/salons/${SALON_B}/social/${PROBE_SOCIAL_UNTOUCHED}`,
      {
        // Salon A's Noura, holding every permission. See the tripwires.
        token: null,
        // Deliberately VALID and deliberately meaningful: a body the handler would
        // accept, so a 400 cannot stand in for the refusal, and a handle whose
        // arrival in salon B's row would be visible in every one of her customers'
        // wallets.
        body: { handle: SOCIAL_ATTACK_HANDLE, on: false },
      },
    );

    expect(
      attack.status,
      `the cross-salon PATCH answered ${attack.status}, not 403: ${attack.raw}`,
    ).toBe(403);
    expect(attack.body.error).toBe('forbidden');
    expect(attack.body.message).toBe('That salon is not yours.');
    // Two keys, no third — the refusal must not also describe the link it refused.
    expect(Object.keys(attack.body).sort()).toEqual(['error', 'message']);

    const after = await readBInstagram();
    expect(after.handle, "salon A's PATCH repointed salon B's Instagram").toBe(B_SOCIAL_HANDLE);
    expect(after.on, "salon A's PATCH flipped salon B's Instagram off").toBe(true);
    expect(after).toEqual(before);

    /**
     * AND THE COLUMN ITSELF. The three assertions above go through the read path; if
     * that path ever filtered or reshaped what it serves, a write that really landed
     * could still read back as the old value. This asks Postgres.
     */
    const stored = scalar(`select social::text from salon where id='${SALON_B}'`);
    expect(stored).toContain(B_SOCIAL_HANDLE);
    expect(stored, "the attacker's handle is in salon B's stored social array").not.toContain(
      SOCIAL_ATTACK_HANDLE,
    );
  });

  it("and the identical PATCH from salon B's own manager writes — so the 403 was the boundary, not a broken route", async () => {
    /**
     * THE CONTROL, and it is not the same control the table row runs. That one
     * addresses TikTok with `{ on: false }`; this one sends the EXACT request salon A
     * was refused, to the EXACT link, differing in nothing but the credential. That
     * is what makes the 403 above attributable to who was calling rather than to the
     * channel, the body, or the route being absent.
     */
    const before = await readBInstagram();

    const own = await treq<{ id: string; handle: string; on: boolean; url: string | null }>(
      'PATCH',
      `/v1/salons/${SALON_B}/social/${PROBE_SOCIAL_UNTOUCHED}`,
      { token: bDashboard, body: { handle: SOCIAL_ATTACK_HANDLE, on: false } },
    );
    expect(own.status, `salon B's own manager was refused her own link: ${own.raw}`).toBe(200);
    expect(own.body.handle).toBe(SOCIAL_ATTACK_HANDLE);
    expect(own.body.on).toBe(false);
    // Read back rather than trusting the response body: the endpoint returns what it
    // says it wrote, and the question is what is in the row.
    expect((await readBInstagram()).handle).toBe(SOCIAL_ATTACK_HANDLE);

    /**
     * PUT BACK. `beforeAll` re-seeds the array every run, so a crash between here and
     * the line above heals itself on the next one — but within a single run, leaving
     * salon B holding the attacker's handle would let a re-ordered or repeated spec
     * above pass while asserting the wrong string.
     */
    const restore = await treq(
      'PATCH',
      `/v1/salons/${SALON_B}/social/${PROBE_SOCIAL_UNTOUCHED}`,
      { token: bDashboard, body: { handle: before.handle, on: before.on } },
    );
    expect(
      restore.status,
      `could not restore salon B's ${PROBE_SOCIAL_UNTOUCHED}: ${restore.raw}`,
    ).toBe(200);
    expect(await readBInstagram()).toEqual(before);
  });
});

// ------------------------------------------- PATCH /staff — the escalation route --

describe('PATCH /staff/{id} — a manager at B cannot grant herself authority at A', () => {
  it("refuses to touch salon A's staff row", async () => {
    const res = await treq<{ error: string; message: string }>('PATCH', `/staff/${A_STAFF_FULL}`, {
      token: bDashboard,
      body: { perms: { team: true, marketing: true } },
    });

    // 404, not 403, and that is the stronger answer: see the existence specs
    // below. Either way it must not be a 200.
    expect(res.status).not.toBe(200);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_staff');
    expectNoSalonALeak(res.raw, 'PATCH /staff/{A}');
  });

  it("changed nothing — salon A's restricted staff row still has charges and void off", async () => {
    // The row lane D uses everywhere as the restricted principal. If a cross-salon
    // PATCH could reach it, every permission spec in permissions.test.ts becomes
    // a fiction.
    const before = scalar(
      `select perm_charges::text || ',' || perm_void::text || ',' || perm_team::text from staff_user where id='${A_STAFF_RESTRICTED}'`,
    );
    precondition(before === 'false,false,false', `${A_STAFF_RESTRICTED} is not the restricted row: ${before}`);

    const res = await treq('PATCH', `/staff/${A_STAFF_RESTRICTED}`, {
      token: bDashboard,
      body: { perms: { charges: true, void: true, team: true } },
    });
    expect(res.status).toBe(404);

    const after = scalar(
      `select perm_charges::text || ',' || perm_void::text || ',' || perm_team::text from staff_user where id='${A_STAFF_RESTRICTED}'`,
    );
    expect(after, 'a cross-salon PATCH granted permissions at salon A').toBe('false,false,false');
  });

  it("writes no audit row against salon A — a refusal is not an event in A's log", async () => {
    const before = scalar(
      `select count(*) from audit_log where salon_id='${SALON_A}' and kind='access'`,
    );
    await treq('PATCH', `/staff/${A_STAFF_FULL}`, {
      token: bDashboard,
      body: { perms: { team: true } },
    });
    const after = scalar(
      `select count(*) from audit_log where salon_id='${SALON_A}' and kind='access'`,
    );
    expect(after).toBe(before);
  });

  it("the same call against salon B's own staff succeeds — the 404 was tenancy", async () => {
    const res = await treq<{ id: string; perms: Record<string, boolean> }>('PATCH', '/staff/ST-B02', {
      token: bDashboard,
      body: { perms: { marketing: true } },
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('ST-B02');
    expect(res.body.perms.marketing).toBe(true);

    // Put it back, so a re-run starts where this one did.
    await treq('PATCH', '/staff/ST-B02', {
      token: bDashboard,
      body: { perms: { marketing: false } },
    });
  });
});

// ------------------------------------------------- 404 vs 403 as an oracle --

/**
 * The subtle one. "That salon is not yours" and "no such salon" must be the same
 * answer, or the API is a directory: point it at ids until one answers
 * differently and you have enumerated every tenant on the platform.
 */
describe('existence is not disclosed — a salon that is not yours reads like one that never was', () => {
  it('GET /salons/{A} and GET /salons/{never existed} are byte-identical', async () => {
    const real = await treq('GET', `/salons/${SALON_A}`, { token: bDashboard });
    const fake = await treq('GET', `/salons/${SALON_NOWHERE}`, { token: bDashboard });

    expect(real.status).toBe(fake.status);
    expect(real.raw).toBe(fake.raw);
    expect(real.status).toBe(403);
  });

  it('PATCH /staff/{A staff} and PATCH /staff/{never existed} are byte-identical', async () => {
    const real = await treq('PATCH', `/staff/${A_STAFF_FULL}`, {
      token: bDashboard,
      body: { perms: { team: true } },
    });
    const fake = await treq('PATCH', `/staff/${STAFF_NOWHERE}`, {
      token: bDashboard,
      body: { perms: { team: true } },
    });

    expect(real.status).toBe(fake.status);
    expect(real.raw).toBe(fake.raw);
    expect(real.status).toBe(404);
  });

  it('every salon-scoped route answers a real foreign id exactly as it answers an invented one', async () => {
    const differing: string[] = [];
    for (const route of SALON_ROUTES) {
      const opts = { token: bDashboard, ...(route.body === undefined ? {} : { body: route.body }) };
      const real = await treq(route.method, url(route, SALON_A), opts);
      const fake = await treq(route.method, url(route, SALON_NOWHERE), opts);
      if (real.status !== fake.status || real.raw !== fake.raw) {
        differing.push(
          `${route.method} ${route.template}: real ${real.status} ${real.raw} / invented ${fake.status} ${fake.raw}`,
        );
      }
    }
    expect(differing, `these routes distinguish an existing salon from an invented one:\n${differing.join('\n')}`).toEqual([]);
  });
});

// ------------------------------------------------------ the wallet token --

/**
 * A wallet token is a bearer credential. If it is not salon-scoped at the point
 * it is consumed, one salon's scanner can act on another salon's customer.
 */
describe('the wallet token — a bearer credential minted for salon A', () => {
  /**
   * PROMOTED — this was a `knownBug()`. It found the leak, lane A closed it, the
   * helper flipped to "appears to be FIXED", and it is a plain `it()` now so the
   * behaviour stays locked in.
   *
   * The leak: `peekToken` resolved a token by its hash alone and `POST /scans`
   * fetched the member by id with no tenant predicate, so a scanner at ANY salon
   * on a legitimate device-bound PIN session could submit a QR minted for
   * another salon's customer and be handed her name, phone, email, balance, tier
   * and visit count. The service list two lines below WAS salon-scoped, which is
   * what made the response look correct.
   *
   * The fix is structural rather than a check added to this handler:
   * `peekToken` and `consumeToken` now take a REQUIRED `TokenScope`, so a future
   * call site cannot resolve a token without saying whose salon it is resolving
   * it in — there is no overload that omits it. That is why this spec asserts
   * the refusal rather than merely a non-200: the shape is the contract, and a
   * regression that answered 500 would otherwise read as green.
   */
  it("POST /scans refuses salon A's wallet token from salon B's scanner", async () => {
    const token = await mintSalonAWalletToken();

    const res = await treq<{ error: string; message: string; member?: unknown }>('POST', '/scans', {
      token: bScanner,
      body: { token },
    });

    // 404, and 404 SPECIFICALLY — see the paired spec below for why this route
    // says something different from POST /charges.
    expect(res.status, `POST /scans answered ${res.status}: ${res.raw}`).toBe(404);
    expect(res.body.error).toBe('unknown_member');
    expect(res.body.message).toBe('No such member.');
    // Nothing about the card came back with the refusal.
    expect(res.body).not.toHaveProperty('member');
    expect(res.body).not.toHaveProperty('services');
    expect(res.body).not.toHaveProperty('heldDepositFils');
    expectNoSalonALeak(res.raw, 'POST /scans with a foreign wallet token');
  });

  /**
   * SPEC CORRECTED — the first version of this asserted the wrong equivalence,
   * and the API was right.
   *
   * It expected a foreign token and a token that was never minted anywhere to be
   * byte-identical, by analogy with the salon-existence specs above. They are
   * not: a foreign token is `404 unknown_member`, a token nobody ever minted is
   * `410 token_consumed_or_unknown`. That is deliberate, and the reasoning is
   * recorded in `api/src/services/walletToken.ts`:
   *
   *   The property that has to hold is that a FOREIGN MEMBER and an ABSENT
   *   MEMBER are indistinguishable — otherwise the 404 becomes a directory of
   *   other salons' customers, which is enumerable and worth having. Folding the
   *   foreign case into the 410 would hide one further bit (whether a token
   *   string is live somewhere on the platform) at the cost of that property.
   *   A wallet token is a 45-second, 128-bit random: nobody guesses one, so the
   *   only person who can learn that bit is someone already holding the code,
   *   who learns nothing they did not have.
   *
   * The distinction is asserted rather than the equivalence, so the trade stays a
   * decision. Collapsing these two into one answer should fail here and be
   * argued, not merged.
   */
  it('a foreign token and a token nobody ever minted answer differently — the recorded trade', async () => {
    const foreign = await mintSalonAWalletToken();
    const fromAnotherSalon = await treq<{ error: string; message: string }>('POST', '/scans', {
      token: bScanner,
      body: { token: foreign },
    });
    const neverMinted = await treq<{ error: string }>('POST', '/scans', {
      token: bScanner,
      body: { token: 'wt_this_value_was_never_minted_by_anyone' },
    });

    expect([fromAnotherSalon.status, fromAnotherSalon.body.error]).toEqual([404, 'unknown_member']);
    expect([neverMinted.status, neverMinted.body.error]).toEqual([
      410,
      'token_consumed_or_unknown',
    ]);

    // THE equivalence that does have to hold: the foreign token's refusal is the
    // same answer a member id that never existed gets, verbatim.
    const absentMember = await treq<{ error: string; message: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('absent-member-body'),
      body: { memberId: 'MEMBER-DOES-NOT-EXIST', serviceIds: [B_SERVICE] },
    });
    expect(absentMember.status).toBe(404);
    expect(
      fromAnotherSalon.body,
      "another salon's customer is distinguishable from a member who does not exist",
    ).toEqual(absentMember.body);
  });

  /**
   * TWO REFUSALS, DELIBERATELY DIFFERENT — lane A's judgement call, asserted so
   * it is a decision rather than an accident.
   *
   *   POST /scans    404 unknown_member         the token is the caller's ONLY
   *                                             identifier, so "no such member"
   *                                             is simply true, and it is the
   *                                             same answer a member that never
   *                                             existed gives.
   *
   *   POST /charges  409 token_member_mismatch  the caller already NAMED a
   *                                             member of its own salon. 404
   *                                             there would be a lie about the
   *                                             customer standing at the
   *                                             counter, and it would send the
   *                                             scanner to the wrong copy.
   *
   * Different information available, different refusal. The pair is asserted in
   * one spec so that a future change which collapses them into one code fails
   * here with the reason attached, instead of quietly making one of the two
   * endpoints less honest.
   */
  it('the two refusals differ because the two callers know different things', async () => {
    const scanToken = await mintSalonAWalletToken();
    const scan = await treq<{ error: string }>('POST', '/scans', {
      token: bScanner,
      body: { token: scanToken },
    });

    const chargeToken = await mintSalonAWalletToken();
    const charge = await treq<{ error: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('refusal-shapes'),
      // A member of salon B's OWN salon, paired with salon A's code.
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token: chargeToken },
    });

    expect([scan.status, scan.body.error]).toEqual([404, 'unknown_member']);
    expect([charge.status, charge.body.error]).toEqual([409, 'token_member_mismatch']);
    // Stated as an inequality too, so "both became 404" cannot pass by having
    // updated only one of the two lines above.
    expect(scan.status).not.toBe(charge.status);
  });

  it("salon B's scanner cannot spend salon A's token — the charge refuses", async () => {
    const token = await mintSalonAWalletToken();
    const res = await treq<{ error: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('spend-foreign-token'),
      body: { memberId: A_MEMBER, serviceIds: [B_SERVICE], token },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_member');
    expectNoSalonALeak(res.raw, 'POST /charges with a foreign token');
  });

  it("and does not burn it — the refused charge leaves salon A's code unconsumed", async () => {
    // Non-negotiable #3: if the debit fails, nothing else happened. A foreign
    // scanner that could consume a token would be a denial-of-service on another
    // salon's customers even without taking a fil.
    const token = await mintSalonAWalletToken();
    const hashedRowsBefore = scalar(
      `select count(*) from wallet_token where member_id='${A_MEMBER}' and consumed_at is null`,
    );

    const res = await treq('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('burn-foreign-token'),
      body: { memberId: A_MEMBER, serviceIds: [B_SERVICE], token },
    });
    expect(res.status).toBe(404);

    const hashedRowsAfter = scalar(
      `select count(*) from wallet_token where member_id='${A_MEMBER}' and consumed_at is null`,
    );
    expect(hashedRowsAfter, 'a cross-salon charge consumed a wallet token').toBe(hashedRowsBefore);
  });

  it("salon B cannot charge its own member with salon A's token either", async () => {
    // The token is the authority for whose wallet this is. Pairing a foreign code
    // with a local member id is the other half of the same attack.
    const token = await mintSalonAWalletToken();
    const res = await treq<{ error: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('foreign-token-local-member'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], token },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('token_member_mismatch');
  });
});

// ------------------------------------------------------------------- scope --

/**
 * SCOPE IS NOT PERMISSION, AND BOTH DIRECTIONS HAVE TO BE CHECKED.
 *
 * The tripwires at the top of this file prove one direction: a scanner PIN
 * cannot reach `GET /staff`. This section is the inverse, and until lane A
 * landed `requireScannerPerm` it was open — `POST /charges` and `POST /scans`
 * checked the PERMISSION and never looked at `principal.scope`. Layla holds
 * every permission, so her WEB session debited a wallet.
 *
 * That matters because the two credentials are hardened differently on purpose.
 * The PIN is a four-digit shift credential: hashed, bound to a device, rate
 * limited per device and salon, locked after five failures — precisely BECAUSE
 * it can move money. A dashboard session has none of that. It is long-lived,
 * browser-based, bound to no device, refreshable for thirty days, and it is the
 * one a manager leaves signed in on a laptop in the back office. If it can
 * charge, every PIN control is optional, because the easier door is open.
 *
 * PROMOTED — both specs below were `knownBug()` and both flipped in one run when
 * the fix landed. While they were red they printed the damage: Layla's web
 * session debited member 9001 by 7.000 fils and was handed her card and phone.
 *
 * THIS SECTION IS THE ONE THAT HAD TO BYPASS THE TEST SHIM, and that is the
 * general lesson rather than a detail. `AVO_TEST_PRINCIPALS` assigns scanner
 * scope BY URL — `/scans`, `/charges` and `/voids` get a scanner principal
 * automatically. Every shim-driven spec in the other three suites was therefore
 * blind to this hole by construction: it could not present a dashboard
 * credential to a scanner route even if it tried. The bug was live, the suite
 * was green, and when it was fixed not one existing spec moved.
 *
 * These use a real `POST /auth/web/session` and a real Bearer token. Anything
 * that turns on WHICH KIND of credential is presented has to be tested with
 * credentials; whatever the shim decides for you, your suite cannot see.
 */
describe('scope — a dashboard credential must not reach the scanner surface', () => {
  it('POST /charges refuses a dashboard-scope session with 403, and debits nothing', async () => {
    const before = scalar(`select balance_fils from member where id='${B_MEMBER}'`);

    const res = await treq<{ error: string; message: string }>('POST', '/charges', {
      token: bDashboard,
      idempotencyKey: key('dashboard-charge'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE] },
    });

    expect(
      res.status,
      `a web session must not debit a wallet, whatever permissions it holds: ${res.raw}`,
    ).toBe(403);
    expect(res.body.error).toBe('forbidden');
    // The copy names the surface the action lives on: a manager who hits this is
    // confused, not attacking.
    expect(res.body.message).toMatch(/Charging happens on the staff scanner/i);
    expect(res.body).not.toHaveProperty('transaction');
    expect(res.body).not.toHaveProperty('balanceAfterFils');

    const after = scalar(`select balance_fils from member where id='${B_MEMBER}'`);
    expect(after, 'a dashboard-scope charge moved money').toBe(before);
  });

  it('POST /scans refuses a dashboard-scope session with 403, and discloses no card', async () => {
    // Salon B's own customer, salon B's own manager, all nine permissions held.
    // The only thing wrong is the KIND of credential.
    const minted = await treq<{ token: string }>('GET', '/members/me/wallet-token', {
      token: bMember,
    });
    precondition(minted.status === 200, `could not mint salon B's wallet token: ${minted.raw}`);

    const res = await treq<{ error: string; message: string }>('POST', '/scans', {
      token: bDashboard,
      body: { token: minted.body.token },
    });

    expect(res.status, `a web session must not resolve a wallet QR: ${res.raw}`).toBe(403);
    expect(res.body.message).toMatch(/Charging happens on the staff scanner/i);
    expect(res.body).not.toHaveProperty('member');
    expect(res.body).not.toHaveProperty('services');
    // And the refusal came BEFORE the token was resolved. A 410 here would mean
    // an unauthorised caller had already been told whether that code is live.
    expect(res.status).not.toBe(410);
  });

  it('the token a refused scan carried is still live — a wrong-surface call burns nothing', async () => {
    const minted = await treq<{ token: string }>('GET', '/members/me/wallet-token', {
      token: bMember,
    });
    precondition(minted.status === 200, `could not mint salon B's wallet token: ${minted.raw}`);

    const refused = await treq('POST', '/scans', {
      token: bDashboard,
      body: { token: minted.body.token },
    });
    expect(refused.status).toBe(403);

    const rightSurface = await treq<{ member: { id: string } }>('POST', '/scans', {
      token: bScanner,
      body: { token: minted.body.token },
    });
    expect(rightSurface.status, rightSurface.raw).toBe(200);
    expect(rightSurface.body.member.id).toBe(B_MEMBER);
  });

  it("the same two calls from salon B's SCANNER session succeed — the 403 is about scope, not the route", async () => {
    // The control. Without it, a 403 from a broken body or a missing permission
    // would have promoted the two specs above for the wrong reason.
    const minted = await treq<{ token: string }>('GET', '/members/me/wallet-token', {
      token: bMember,
    });
    precondition(minted.status === 200, `could not mint salon B's wallet token: ${minted.raw}`);

    const scan = await treq<{ member: { id: string } }>('POST', '/scans', {
      token: bScanner,
      body: { token: minted.body.token },
    });
    expect(scan.status, scan.raw).toBe(200);
    expect(scan.body.member.id).toBe(B_MEMBER);

    const charge = await treq<{ transaction: { id: string } }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('scanner-charge-control'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], confirmDuplicate: true },
    });
    expect(charge.status, charge.raw).toBe(200);
    expect(charge.body.transaction.id).toMatch(/^TX-/);
  });
});

// -------------------------------------------------------- money across salons --

describe('money — salon B cannot move salon A money', () => {
  it("POST /charges on salon A's member by id 404s and debits nothing", async () => {
    const before = scalar(`select balance_fils from member where id='${A_MEMBER}'`);

    const res = await treq<{ error: string }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('manual-lookup'),
      body: { memberId: A_MEMBER, serviceIds: [B_SERVICE] },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_member');
    // Same body as a member id that never existed — no enumeration of another
    // salon's customer list.
    expectNoSalonALeak(res.raw, 'POST /charges by member id');

    const after = scalar(`select balance_fils from member where id='${A_MEMBER}'`);
    expect(after, "salon B's charge moved salon A's balance").toBe(before);
  });

  it('a member id that never existed answers identically', async () => {
    const real = await treq('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('enum-real'),
      body: { memberId: A_MEMBER, serviceIds: [B_SERVICE] },
    });
    const fake = await treq('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('enum-fake'),
      body: { memberId: 'MEMBER-DOES-NOT-EXIST', serviceIds: [B_SERVICE] },
    });
    expect(real.status).toBe(fake.status);
    expect(real.raw).toBe(fake.raw);
  });

  it("salon A's service ids cannot be priced or charged from salon B", async () => {
    const res = await treq<{ error: string; unknown: string[] }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('foreign-service'),
      body: { memberId: B_MEMBER, serviceIds: [A_SERVICE] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_services');
    expect(res.body.unknown).toEqual([A_SERVICE]);
  });

  it("POST /voids on salon A's transaction 404s and reverses nothing", async () => {
    const target = scalar(
      `select id from transaction where salon_id='${SALON_A}' and kind='charge' order by created_at desc limit 1`,
    );
    precondition(target !== '', 'salon A has no charge to try to void — run pnpm --dir ./api run db:seed');

    const reversalsBefore = scalar(
      `select count(*) from transaction where reverses_transaction_id='${target}'`,
    );

    const res = await treq<{ error: string }>('POST', '/voids', {
      token: bScanner,
      idempotencyKey: key('foreign-void'),
      body: { transactionId: target, reason: 'tenancy probe' },
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_transaction');

    const reversalsAfter = scalar(
      `select count(*) from transaction where reverses_transaction_id='${target}'`,
    );
    expect(reversalsAfter, "salon B voided salon A's charge").toBe(reversalsBefore);
  });

  it("GET /charges shows salon B's charges only", async () => {
    // The control: salon B really can charge, so the empty cross-salon reads
    // above are not a dead scanner.
    const charge = await treq<{ transaction: { id: string } }>('POST', '/charges', {
      token: bScanner,
      idempotencyKey: key('own-charge'),
      body: { memberId: B_MEMBER, serviceIds: [B_SERVICE], confirmDuplicate: true },
    });
    expect(charge.status, charge.raw).toBe(200);
    expect(charge.body.transaction.id).toMatch(/^TX-/);

    const list = await treq<{ items: Array<{ id: string; memberId: string }> }>('GET', '/charges', {
      token: bScanner,
    });
    expect(list.status).toBe(200);
    expect(list.body.items.some((t) => t.id === charge.body.transaction.id)).toBe(true);
    expect(list.body.items.every((t) => t.memberId === B_MEMBER)).toBe(true);
    expectNoSalonALeak(list.raw, 'GET /charges');
  });

  it("GET /staff shows salon B's roster only", async () => {
    const res = await treq<{ items: Array<{ id: string; salonId: string }> }>('GET', '/staff', {
      token: bDashboard,
    });
    expect(res.status).toBe(200);
    expect(res.body.items.every((s) => s.salonId === SALON_B)).toBe(true);
    expect(res.body.items.some((s) => s.id === A_STAFF_FULL)).toBe(false);
    expectNoSalonALeak(res.raw, 'GET /staff');
  });
});

// --------------------------------------------------------------- idempotency --

/**
 * Lane A scoped the key `(scope, endpoint, key)`. The question is what `scope`
 * contains. `principalScope()` returns `kind:id` — `member:8842`, `staff:ST-001`
 * — which is NOT the salon id, so the guarantee is not "keys are salon-scoped".
 * It is stronger in one direction and worth stating precisely: a key is scoped
 * to ONE PRINCIPAL, and since a principal belongs to exactly one salon, no key
 * can cross a salon boundary. Two salons choosing "1" on the same day is the
 * ordinary case and it must not collide.
 *
 * These specs use `POST /topups`, which creates an intent and moves no balance —
 * so the proof costs nobody a fil.
 */
describe('idempotency keys do not collide across salons', () => {
  it('the same key from salon A and salon B produces two independent results', async () => {
    const shared = `shared-key-${Date.now()}`;

    // Salon A's member, via the test shim (see the harness header).
    const a = await treq<{ id: string; memberId: string }>('POST', '/topups', {
      token: null,
      idempotencyKey: shared,
      body: { amountFils: 10_000, method: 'knet' },
    });
    // Salon B's member, a real wallet session.
    const b = await treq<{ id: string; memberId: string }>('POST', '/topups', {
      token: bMember,
      idempotencyKey: shared,
      body: { amountFils: 10_000, method: 'knet' },
    });

    expect(a.status, a.raw).toBe(200);
    expect(b.status, b.raw).toBe(200);
    expect(a.body.memberId).toBe(A_MEMBER);
    expect(b.body.memberId).toBe(B_MEMBER);
    // The failure this catches: B is handed A's stored response and shown A's
    // top-up as its own.
    expect(b.body.id).not.toBe(a.body.id);
  });

  it('and stores them under two different scopes, neither of which is a bare key', async () => {
    const shared = `shared-scope-${Date.now()}`;
    await treq('POST', '/topups', {
      token: null,
      idempotencyKey: shared,
      body: { amountFils: 5_000, method: 'knet' },
    });
    await treq('POST', '/topups', {
      token: bMember,
      idempotencyKey: shared,
      body: { amountFils: 5_000, method: 'knet' },
    });

    const scopes = scalar(
      `select string_agg(scope, ',' order by scope) from idempotency_key where key='${shared}'`,
    );
    expect(scopes).toBe(`member:${A_MEMBER},member:${B_MEMBER}`);
  });

  it('the unique index is on (scope, endpoint, key), not on the key alone', async () => {
    // The structural half. Two principals colliding is prevented by the index,
    // not by a handler remembering to include the scope in a lookup.
    const index = scalar(
      "select indexdef from pg_indexes where tablename='idempotency_key' and indexdef ilike '%UNIQUE%'",
    );
    expect(index).toMatch(/\(scope, endpoint, key\)|\(scope, ?endpoint, ?key\)/i);
  });

  it("salon B's member cannot read salon A's top-up intent by id", async () => {
    const a = await treq<{ id: string }>('POST', '/topups', {
      token: null,
      idempotencyKey: key('a-intent'),
      body: { amountFils: 15_000, method: 'card' },
    });
    precondition(a.status === 200, `could not create salon A's intent: ${a.raw}`);

    const read = await treq<{ error: string }>('GET', `/topups/${a.body.id}`, { token: bMember });
    expect(read.status).toBe(404);
    expect(read.body.error).toBe('unknown_topup');
    expectNoSalonALeak(read.raw, 'GET /topups/{A intent}');
  });

  it('the same key with a DIFFERENT body is a 422, not a replay of the first result', async () => {
    // design/api-contract.md § Addendum. Replaying would tell a client that
    // retried 5 KD as 50 KD that the 50 succeeded, and it never happened.
    const k = key('mutated-body');
    const first = await treq<{ id: string; amountFils: number }>('POST', '/topups', {
      token: bMember,
      idempotencyKey: k,
      body: { amountFils: 10_000, method: 'knet' },
    });
    expect(first.status).toBe(200);

    const second = await treq<{ error: string; message: string }>('POST', '/topups', {
      token: bMember,
      idempotencyKey: k,
      body: { amountFils: 250_000, method: 'card' },
    });
    expect(second.status).toBe(422);
    expect(second.body.error).toBe('idempotency_key_reused');
  });
});

// -------------------------------------------------------------- the gap ledger --

/**
 * THE LEDGER.
 *
 * The list above is a list a human maintains, and a list a human maintains is a
 * list that is one merge behind. This block does not hold a list: it reads
 * `api/src/routes/*.ts`, finds every route whose path carries a salon id, and
 * probes each one as salon B against salon A.
 *
 * A salon-scoped route added in week three is therefore tested the day it lands,
 * guarded or not — and if it is not guarded, this fails and names it.
 *
 * The probes send no body deliberately. Every handler in `api/src/routes` calls
 * its authority guard as the first statement, before the body is parsed, so an
 * empty body still reaches the tenancy check. A route that answers 400 here has
 * validated a body before deciding whether the caller may touch that salon at
 * all, and that ordering is itself the finding — it tells an outsider which
 * fields the route takes.
 */
describe('gap ledger — every salon-scoped route lane A registers', () => {
  const discovered = discoverSalonScopedRoutes();

  it('the scanner actually finds routes (a broken regex must not pass silently)', () => {
    const paths = discovered.map((r) => `${r.method} ${r.path}`);
    /**
     * Every route known today. More is fine — fewer means the scan broke.
     *
     * KEPT IN STEP WITH THE TABLE ON PURPOSE. This list was left at the original
     * eight while nine more routes landed, which quietly weakened the tripwire to
     * the point where the regex could have lost every write route and still
     * passed. The whole job of this spec is to fail when the scanner stops seeing
     * things, and a scanner that only has to see the 2024 routes cannot do it.
     *
     * The four DELETE/PATCH/PUT/POST promotion writes matter most here: they carry
     * the awkward shapes — a second path parameter, and a generic between the
     * method and the paren — that a naive regex misses first.
     */
    for (const known of [
      'GET /salons/:id',
      'PATCH /salons/:id',
      'GET /salons/:id/metrics',
      'GET /salons/:id/products',
      'GET /salons/:id/bookings',
      'GET /salons/:id/services',
      'GET /salons/:id/artists',
      'GET /salons/:id/artists/bookable',
      'GET /salons/:id/audit',
      'GET /salons/:id/activity',
      'GET /salons/:id/loyalty',
      'PUT /salons/:id/loyalty',
      'GET /v1/salons/:id/promotions',
      'PUT /v1/salons/:id/promotions/boosts',
      'POST /v1/salons/:id/promotions/happy-hours',
      'PATCH /v1/salons/:id/promotions/happy-hours/:hid',
      'DELETE /v1/salons/:id/promotions/happy-hours/:hid',
      'POST /v1/salons/:id/campaigns',
      // Lane A's shop catalog writes and the campaign routes. The ledger fired on all
      // six when they merged; the auto-discovered sibling assertion drives them too.
      'GET /v1/salons/:id/campaigns',
      'DELETE /v1/salons/:id/campaigns/:cid',
      'GET /v1/salons/:id/messaging-policy',
      'POST /salons/:id/products',
      'PATCH /salons/:id/products/:pid',
      'DELETE /salons/:id/products/:pid',
      // Lane A's phase-4 branch writes. These are what closed the phase-4
      // criterion — a salon can open, rename and close a location without an
      // engineer — so a scan that stops seeing them is a scan that would let the
      // most destructive salon-scoped routes in the API go unprobed.
      'POST /salons/:id/branches',
      'PATCH /salons/:id/branches/:bid',
      'DELETE /salons/:id/branches/:bid',
      // Lane A's four image writes. They belong in this tripwire more than any row
      // above it, because they carry BOTH awkward shapes at once — a second path
      // parameter AND an explicit generic between the method and the paren — which
      // is the pair the comment above says a naive regex loses first. When they
      // landed, the ledger fired on all four; that is what this list keeps possible.
      'POST /v1/salons/:id/products/:oid/image',
      'DELETE /v1/salons/:id/products/:oid/image',
      'POST /v1/salons/:id/services/:oid/image',
      'DELETE /v1/salons/:id/services/:oid/image',
    ]) {
      expect(paths, `the route scan lost ${known}`).toContain(known);
    }
  });

  /**
   * THE CONSOLE DOORS, DERIVED RATHER THAN LISTED.
   *
   * `discoverSalonScopedRoutes()` matches any path containing `/salons/:`, which is
   * the right net for merchant doors and also catches
   * `GET|PATCH /v1/platform/salons/:id` — the owner console's single-salon read and
   * edit. Those are NOT merchant doors and the table above must not grow entries for
   * them: a platform admin reads and writes ACROSS salons by design, so there is no
   * tenancy boundary at that door to assert. `SALON_ROUTES`'s whole assertion —
   * "salon B's manager is refused salon A's data" — is not a claim about a console
   * route at all.
   *
   * The membership test is NOT a hand-written exemption list, because an exemption
   * list is the thing this ledger exists to replace: it would need an entry per
   * console route, and the day someone added a third one the ledger would fire on it
   * and the tempting fix would be another line. Instead the classification is read
   * from source through the permission census — a discovered route is a console door
   * IFF EVERY gate path on it is `requirePlatform`. A fourth console route classifies
   * itself.
   *
   * ---------------------------------------------------------------------------
   * `every`, AND IT WAS `some` UNTIL DECISION 79. THE SENTENCE ABOVE USED TO END
   * "A merchant door can never satisfy that", AND THAT IS NO LONGER TRUE.
   * ---------------------------------------------------------------------------
   * The census contributes ONE ROW PER GATE PATH, not one per route — its own
   * `PINNED_COVERAGE` header says so — so a DISJUNCTIVE door, one that admits either
   * principal kind by asking a different question of each, contributes two rows and
   * one of them is `requirePlatform`.
   *
   * `GET /salons/{id}/loyalty` became exactly that: `requireLoyaltyReader` takes
   * `sections.salons` from the console and `perms.loyalty` + `requireSameSalon` from
   * the merchant. Under `some` it classified as a console door — and then the
   * exemption did the precise thing the assertion below was written to catch. It
   * SWALLOWED A MERCHANT DOOR: a route that still has a real tenancy boundary, still
   * has a spec in `SALON_ROUTES` asserting it, and would have been dropped from the
   * "add it to SALON_ROUTES" ledger for ever.
   *
   * That is why the swallow assertion is not decoration. It is the half of this
   * mechanism that fired, on the first change that could make it fire, three days
   * after the mechanism was written — and the failure named the route rather than
   * leaving a silent hole.
   *
   * `every` is the honest reading of "this door is not a merchant door": a route is
   * exempt from a tenancy spec only when there is no merchant way in AT ALL.
   * `PUT /salons/{id}/loyalty` satisfies it — `requireLoyaltyPublisher` refuses a
   * staff principal outright rather than gating her, so its only gate path is the
   * console's. The GET does not, and stays probed.
   */
  const gateCounts = new Map<string, { total: number; platform: number }>();
  for (const g of censusOfRoutes().gated) {
    const key = `${g.method} ${g.route}`;
    const seen = gateCounts.get(key) ?? { total: 0, platform: 0 };
    seen.total += 1;
    if (g.guard === 'requirePlatform') seen.platform += 1;
    gateCounts.set(key, seen);
  }
  const consoleDoors = new Set(
    [...gateCounts.entries()]
      .filter(([, c]) => c.platform > 0 && c.platform === c.total)
      .map(([route]) => route),
  );

  it('the console doors classified themselves, and did not swallow a merchant door', () => {
    const discoveredConsole = discovered
      .map((r) => `${r.method} ${r.path}`)
      .filter((s) => consoleDoors.has(s));

    /*
     * NON-VACUOUS. If the census stopped resolving `requirePlatform` — a rename, a
     * wrapper it cannot see — this set would empty, the exemption below would exempt
     * nothing, and the ledger would fire on the console routes again. That failure is
     * survivable; the reverse is not, so it is asserted here rather than left implied.
     */
    expect(
      discoveredConsole,
      'no salon-scoped route is classified as a console door, so the exemption below is ' +
        'doing nothing and the census has stopped reading requirePlatform',
    ).toContain('GET /v1/platform/salons/:id');
    expect(discoveredConsole).toContain('PATCH /v1/platform/salons/:id');

    /*
     * AND THE `every` READING IS PINNED BY THE ROUTE THAT BROKE THE `some` ONE.
     *
     * `PUT /salons/:id/loyalty` is console-only and must be exempt; `GET
     * /salons/:id/loyalty` is disjunctive — the console reads it under
     * `sections.salons` and the merchant reads her own under `perms.loyalty` — and
     * must NOT be. Reverting this classification to `some` makes the GET exempt and
     * this assertion is the one that says so BY NAME, before the swallow check below
     * has to infer it from `SALON_ROUTES`.
     */
    expect(
      discoveredConsole,
      'PUT /salons/:id/loyalty is gated only by requirePlatform and is not classified ' +
        'as a console door — the exemption has stopped reading the loyalty publisher',
    ).toContain('PUT /salons/:id/loyalty');
    expect(
      discoveredConsole,
      'GET /salons/:id/loyalty is classified as a console door, but a merchant reads ' +
        'her own salon through it under perms.loyalty. The classification has gone ' +
        'back to `some`, and a merchant door with a live tenancy boundary is now exempt ' +
        'from the ledger below.',
    ).not.toContain('GET /salons/:id/loyalty');

    /*
     * AND THE EXEMPTION CANNOT EAT A MERCHANT DOOR. If `requirePlatform` ever appeared
     * in a merchant handler — or the census misattributed one — a route that genuinely
     * needs a tenancy spec would be silently exempted, which is exactly the hole an
     * exemption mechanism is capable of opening. Every route in the table must stay
     * outside the console set.
     */
    const swallowed = SALON_ROUTES
      .map((r) => `${r.method} ${r.template.replace(/\{(\w+)\}/g, ':$1')}`)
      .filter((s) => consoleDoors.has(s));
    expect(
      swallowed,
      `the console-door exemption covers a route that has a tenancy spec: ${swallowed.join(', ')}. ` +
        'That route would stop being probed for cross-salon leakage.',
    ).toEqual([]);
  });

  it('the hand-written table above covers every route the scanner finds', () => {
    // `{id}` → `:id`, `{hid}` → `:hid`, `{bid}` → `:bid`: the table writes path
    // parameters in braces so `url()` can substitute them, the route scanner
    // reads them as fastify registers them. EVERY placeholder has to be
    // translated or a route that IS in the table reads as missing — and the
    // failure lands as "add it to SALON_ROUTES" against an entry already there,
    // which is a confusing hour for whoever adds the next parameterised route.
    /**
     * GENERIC, and it was three hard-coded `.replace()` calls until it cost the hour
     * the comment above predicted. Adding `{pid}` and `{cid}` for lane A's shop and
     * campaign routes left this normaliser matching neither, so three entries that were
     * in the table read as missing from it and the failure said "add it to SALON_ROUTES"
     * about routes already there — the exact confusion that comment warned of, arriving
     * on schedule.
     *
     * `\{(\w+)\}` → `:$1` handles every placeholder the table will ever use, so the
     * next parameterised route needs a substitution in `url()` and nothing here.
     */
    const probed = new Set(
      SALON_ROUTES.map((r) => `${r.method} ${r.template.replace(/\{(\w+)\}/g, ':$1')}`),
    );
    const missing = discovered
      .map((r) => `${r.method} ${r.path}`)
      .filter((s) => !probed.has(s))
      // Console doors are exempt, and they said so themselves — see the block above.
      .filter((s) => !consoleDoors.has(s));
    expect(
      missing,
      `a salon-scoped route exists with no spec of its own. Add it to SALON_ROUTES:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('EVERY discovered route refuses salon B with 403 and no salon A data', async () => {
    const failures: string[] = [];

    for (const route of discovered) {
      /**
       * `:kind` gets a REAL kind, for the reason `url()` gives: reports.ts validates
       * the vocabulary before the permission is even chosen, so a literal `:kind`
       * answers 400 `invalid_report_kind` and this sweep never reaches the salon
       * check — it reported both reports routes as tenancy holes that were really
       * unreachable probes. Every other path parameter stays literal on purpose: for
       * them the salon check fires FIRST, which is itself part of what this sweep
       * proves.
       */
      const path = route.path.replace(/:id/, SALON_A).replace(/:kind/, 'sales');
      const res = await treq(route.method, path, { token: bDashboard });

      if (res.status !== 403) {
        failures.push(
          `${route.method} ${route.path} (${route.file}) → HTTP ${res.status}\n      ${res.raw.slice(0, 300)}`,
        );
        continue;
      }
      const leaked = SALON_A_TELLTALES.filter((t) => res.raw.includes(t));
      if (leaked.length > 0) {
        failures.push(`${route.method} ${route.path} → 403 but leaked ${leaked.join(', ')}`);
      }
    }

    expect(
      failures,
      'TENANCY HOLE — these salon-scoped routes did not refuse a principal from another salon:\n    ' +
        failures.join('\n    '),
    ).toEqual([]);
  });
});

/**
 * GAP — tenancy questions this suite cannot answer yet, each naming what has to
 * exist first. A todo here is a promotion waiting to happen, not a rediscovery.
 */
describe('GAP: tenancy surface not reachable yet', () => {
  it.todo(
    'GET /salons/{id}/audit — the audit log is the most sensitive salon-scoped read there is and the endpoint does not exist yet (lane A)',
  );
  it.todo(
    'the owner console scope reads across salons by design; when it lands, every one of its endpoints needs the inverse test — a merchant credential must not reach an owner route',
  );
  it.todo(
    'POST /orders and the shop endpoints do not exist; when they do, a product id from another salon must not be priceable (the POST /charges service-id spec above is the pattern)',
  );
  /**
   * CORRECTED — this said bookings and held deposits are "unimplemented". They
   * are: `api/drizzle/0013_booking.sql`, `api/src/services/booking.ts`, and the
   * hold is applied inside `api/src/services/charge.ts`. So the case is no longer
   * blocked on lane A; it is simply unwritten, and it is now writable.
   */
  /**
   * COVERED — `e2e/deposit.test.ts` asserts both walls: salon B's scanner cannot
   * reach a salon A member at all (404, and the refusal does not leak her name),
   * and no booking of hers is recorded against salon B. The inner wall is
   * `findApplicableHold`'s salonId predicate; the outer is the route's own tenancy
   * check, and a spec proving only the outer would go quiet the day a route stopped
   * enforcing it.
   */
  it.todo(
    'the PSP callback has no endpoint yet; a gateway reference must resolve to the salon that created the intent, or one salon confirms another salon top-up',
  );
  it.todo(
    'receipt_job rows carry member data to WhatsApp; the worker does not exist, and when it does it needs a test that a salon B job can never select a salon A member',
  );
});

// ------------------------------------------------- the console door, asserted --
/**
 * WHAT THE CONSOLE DOOR DOES INSTEAD OF A TENANCY WALL.
 *
 * Exempting `GET|PATCH /v1/platform/salons/:id` from the gap ledger is only honest
 * if something asserts what it does instead. An exemption with nothing behind it is
 * how a route stops being tested; this is the half that stops that.
 *
 * TWO CLAIMS, AND THEY ARE THE OPPOSITE OF THE MERCHANT DOORS' CLAIM:
 *
 * 1. CROSS-SALON IS THE FEATURE. One platform credential reads BOTH salons. At a
 *    merchant door that would be the leak the whole tenancy suite exists to catch;
 *    here it is the console working. The gate is `salons`, driven permission-off by
 *    the generated census, and that gate is the only boundary there is.
 *
 * 2. AN UNKNOWN SALON IS 404, NOT 403 — a deliberate divergence from every merchant
 *    door in this file, and worth stating because it looks like an inconsistency.
 *
 *    The merchant doors answer 403 for a salon that exists and is not yours AND for
 *    one that does not exist, deliberately identically: `salon-onboarding.test.ts`
 *    asserts that pair explicitly, because a 403/404 split there would be an
 *    existence oracle — an outsider could enumerate AVO's client list by watching
 *    which ids refuse differently.
 *
 *    That reasoning does not apply here and the divergence is not an oversight. A
 *    platform admin is ENTITLED to know which salons exist — the roster is the thing
 *    the console is for, and `GET /v1/platform/salons` hands her the whole list under
 *    the same permission. There is no tenancy fact left to leak, so 404 is the
 *    truthful answer rather than a disclosure, and 403 would be a lie about
 *    authority she holds.
 */
describe('the console door — cross-salon by design, and 404 where a merchant door says 403', () => {
  let platform = '';

  beforeAll(async () => {
    platform = await signInPlatform(PLATFORM_OWNER_HANDLE);
  }, 60_000);

  it('one platform credential reads BOTH salons — the opposite of a merchant door', async () => {
    const a = await treq('GET', `/v1/platform/salons/${SALON_A}`, { token: platform });
    const b = await treq('GET', `/v1/platform/salons/${SALON_B}`, { token: platform });

    expect(a.status, `the console cannot read salon A: ${a.raw}`).toBe(200);
    expect(b.status, `the console cannot read salon B: ${b.raw}`).toBe(200);

    // And it really is two different salons, not the same one twice — which a
    // handler ignoring its path parameter would produce, and which would make the
    // "reads both" claim meaningless.
    expect(a.body?.salon?.id).toBe(SALON_A);
    expect(b.body?.salon?.id).toBe(SALON_B);
    expect(a.body?.salon?.name).not.toBe(b.body?.salon?.name);
  });

  it('an unknown salon is 404 with a code — not the 403 a merchant door gives', async () => {
    const res = await treq('GET', `/v1/platform/salons/${SALON_NOWHERE}`, { token: platform });

    expect(
      res.status,
      `an unknown salon answered ${res.status}. 404 is deliberate here: a platform admin is ` +
        'entitled to know which salons exist, so there is no existence fact to protect and ' +
        `403 would misdescribe her authority. Response: ${res.raw}`,
    ).toBe(404);
    expect(res.body?.error, 'the refusal carries no machine-readable code').toBeTruthy();
    expect(res.body?.error, 'a console read answered with the surface-wall code').not.toBe(
      'forbidden',
    );

    /*
     * THE DIVERGENCE, STATED AS A COMPARISON RATHER THAN AS TWO SEPARATE FACTS.
     *
     * The same unknown id at a MERCHANT door answers 403 — indistinguishable from a
     * real salon that is not yours. Asserting both here is what makes the pair a
     * deliberate design rather than two unrelated numbers a reader has to reconcile,
     * and it goes red if either side drifts toward the other.
     */
    const merchant = await signInDashboard(SALON_B, B_STAFF_HANDLE);
    const atMerchantDoor = await treq('GET', `/salons/${SALON_NOWHERE}`, { token: merchant });
    expect(
      atMerchantDoor.status,
      'the merchant door stopped answering 403 for an unknown salon, which is the half of ' +
        'this pair that must NOT become 404 — that split is an existence oracle over the ' +
        'client list. See salon-onboarding.test.ts.',
    ).toBe(403);
  });
});
