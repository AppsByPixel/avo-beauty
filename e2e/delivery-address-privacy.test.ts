/**
 * WHERE A CUSTOMER LIVES — item 7's address book and the snapshot on her order.
 *
 * THIS IS THE FIRST FEATURE IN THIS PRODUCT THAT STORES A HOME ADDRESS, and that
 * changes what a gap costs rather than only where it is. Every earlier
 * tenant-boundary suite in this directory guards names, phones, balances and
 * appointment times. A street address is a different class of fact: it identifies
 * a HOUSEHOLD, it is actionable by a stranger, and unlike a phone number it
 * cannot be changed in response to a leak.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT IS NOT. It is not a re-run of lane A's
 * `api/src/routes/delivery.int.test.ts`, which covers placement, the status
 * transitions and the field validation, and is lane A's column. This file asks
 * the three questions that suite cannot ask from inside its own package:
 *
 *   1. CAN ONE CUSTOMER REACH ANOTHER'S ADDRESS? Driven directly, by request,
 *      through every door that takes an address id — because
 *      `permission-census.test.ts` classifies all five member routes
 *      `[requireMember]` and a `[requireMember]` line is byte-identical whether
 *      the WHERE clause carries `member_id` or not. See § one member cannot reach.
 *
 *   2. DOES THE 30-DAY ERASURE PROMISE REACH THE ADDRESS? It does not, in either
 *      of the two places the address lives. See § the erasure job has never heard
 *      of either table. That is the finding this file exists for and it is lane
 *      A's to fix.
 *
 *   3. THE TWO PLACES THE SHAPE IS NOT THE WHOLE CONTRACT. `contract.test.ts`
 *      probes all three reads against `MemberAddressSchema` and `ShopOrderSchema`
 *      (trunk landed both in `65ab72e`), so the KEY SETS are covered there and are
 *      deliberately not re-asserted here — two files asserting one shape means one
 *      of them rots. What is left is the pair of facts a schema cannot carry: that
 *      `nextCursor` is permanently null rather than occasionally, and that the
 *      column is wider than the schema. See § the two the schema cannot say.
 *
 * THE ADDRESS EXISTS IN TWO PLACES WITH TWO LIFETIMES, and that fact organises
 * the whole file:
 *
 *   `member_address`         HER BOOK. Editable, soft-deletable, hers.
 *   `shop_order.block/…`     AN IMMUTABLE SNAPSHOT on a past order. Written by
 *                            `services/order.ts` § 5b, never updated, and read by
 *                            both her order list and the merchant's board.
 *
 * A deletion story that covers one and not the other is not a partial fix, it is
 * no fix: the snapshot is the copy a salon reads.
 *
 * ---------------------------------------------------------------------------
 * FIXTURES ARE AT SALON A, WHICH IS UNUSUAL IN THIS DIRECTORY AND FORCED.
 * ---------------------------------------------------------------------------
 * `tenancy.test.ts` establishes salon B as the disposable one and most files
 * follow it. `POST /orders` cannot be driven there: `salon.module_shop` is FALSE
 * at `SAL-LUMIERE` in the seed, and `services/order.ts:217` throws
 * `shop_not_enabled` BEFORE the address is resolved — so a cross-member probe run
 * at salon B would be refused by the module check and never reach the thing under
 * test. That is the same trap `tenancy.test.ts`'s `{kind}` note records for a
 * placeholder report kind, and the answer is the same: address the salon where
 * the probe can reach its subject.
 *
 * NOTHING HERE PLACES A SUCCESSFUL ORDER, deliberately, and it is the reason
 * salon A is safe to use. Every `POST /orders` below is one that must be REFUSED,
 * and a refusal rolls the whole `db.transaction` back, so this file creates no
 * `transaction` row through the API and moves no money. The two orders it needs
 * as READ fixtures are written with `psql`, for `tenancy.test.ts`'s reason —
 * "creating them through the very routes the ledger is about would make the
 * fixture depend on the thing under test" — and because the snapshot WRITE is
 * already lane A's spec.
 *
 * `dropFixtures()` RUNS FIRST AND LAST. Salon A is read by `reports.test.ts` and
 * counted by `platform-salons.test.ts`, both of which run after this file
 * alphabetically, and one of the specs below leaves a member ERASED — a state
 * `platform-salons.test.ts` has a precondition about. So the teardown is not
 * hygiene, it is what keeps two other files honest, and it deletes in FK order:
 * `shop_order` → `transaction` → `member_address` → `member`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { knownBug, precondition } from './support/known-bug.js';
import {
  A_BRANCH,
  A_STAFF_FULL,
  SALON_A,
  pgDb,
  psql,
  runApiDbScriptResult,
  scalar,
  signInMember,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

// ---------------------------------------------------------------------------
// The people. Three, because the question needs a victim and an attacker who are
// not the same person, and the erasure subject must be a THIRD — erasing her is
// irreversible inside the run and the cross-member specs need both their members
// alive afterwards regardless of spec order.
// ---------------------------------------------------------------------------
const HER = 'QA-ADR-0001';
const HER_PHONE = '+96599778101';
const NEIGHBOUR = 'QA-ADR-0002';
const NEIGHBOUR_PHONE = '+96599778102';
const ERASED = 'QA-ADR-0003';
const ERASED_PHONE = '+96599778103';

/**
 * THE `+9659977 81xx` BLOCK, AND IT WAS `7740x` UNTIL A CLASH WAS SPOTTED.
 * `contract.test.ts`'s `PIN_MEMBER_PHONE` is `+96599777401`, which this file also
 * took. It would NOT have failed today — `member_phone_salon_uq` is per salon and
 * that member is at salon B while these three are at salon A — so both files
 * would have passed while sharing a number, and the collision would have surfaced
 * the day either file moved salon. That is the shape of fixture bug this suite's
 * own database-naming incident was about: a name two checkouts resolve the same
 * way, harmless until it is not. Moved to a block `grep -rhoE '\+9659977[0-9]{4}'`
 * shows free across the whole directory.
 */

/**
 * Address ids are `ADR-${randomUUID()}` when the route mints them. These are
 * fixture rows and the prefix is kept so a stray one is greppable, but they are
 * deliberately NOT uuid-shaped: a spec that failed because it guessed a real id
 * should look nothing like one that failed because a fixture is missing.
 */
const HER_ADDRESS = 'ADR-QAADR-HERS';
const HER_DELETED_ADDRESS = 'ADR-QAADR-HERS-GONE';
const NEIGHBOUR_ADDRESS = 'ADR-QAADR-NEIGHBOUR';
const ERASED_ADDRESS = 'ADR-QAADR-ERASED';

const HER_ORDER = 'TX-QAADR-HERS';
const ERASED_ORDER = 'TX-QAADR-ERASED';

/**
 * THE SNAPSHOT VALUES ARE SENTINELS, NOT PLAUSIBLE ADDRESSES, and that is a
 * property the specs depend on rather than a style choice. Every leak assertion
 * below greps a raw response body for these strings; a plausible street name
 * cannot be told apart from a real one in a `.raw`, so a false negative would
 * look exactly like a pass. `expectNoSalonALeak` in `tenancy.test.ts` makes the
 * same argument for the same reason.
 */
const NEIGHBOUR_STREET = 'QAADR-NEIGHBOUR-STREET-SENTINEL';
const NEIGHBOUR_BLOCK = 'QAADR-NEIGHBOUR-BLOCK-SENTINEL';
const NEIGHBOUR_INSTRUCTIONS = 'QAADR-NEIGHBOUR-GATECODE-SENTINEL';
const HER_STREET = 'QAADR-HER-STREET-SENTINEL';
const ERASED_STREET = 'QAADR-ERASED-STREET-SENTINEL';
const ERASED_INSTRUCTIONS = 'QAADR-ERASED-GATECODE-SENTINEL';

let her = '';
let neighbour = '';

// ---------------------------------------------------------------------------

function seedMember(id: string, name: string, phone: string): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${id}', '${SALON_A}', '${name}', '${phone}', NULL, false,
           s.password_hash, ${BALANCE_FILS}, 0, 'bronze', NULL, 3
    FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET
      name                  = EXCLUDED.name,
      phone                 = EXCLUDED.phone,
      password_hash         = EXCLUDED.password_hash,
      balance_fils          = ${BALANCE_FILS},
      erased_at             = NULL,
      deletion_requested_at = NULL,
      deletion_due_at       = NULL;
  `);
}

/**
 * A BALANCE SHE CAN AFFORD AN ORDER WITH, and it has to be one: every
 * `POST /orders` below must be refused for the reason under test, and
 * `insufficient_balance` is a refusal that arrives EARLIER than the address
 * lookup. A probe refused for having no money would report a green cross-member
 * result while proving nothing — the failure mode this whole directory is built
 * against.
 *
 * NO `member_wallet` ENTRY TO MATCH IT, and no debt to the ledger either. The
 * wallet census (`db:verify` invariant 5, printed by `support/global-setup.ts`)
 * reconciles `member.balance_fils` against `member_wallet`, so a seeded balance
 * does drift — but `dropFixtures()` deletes these three members before the census
 * runs at teardown, so they are never among the rows it measures. That is why
 * this file calls no `reconcileWalletLedger`, unlike `reports.test.ts`.
 */
const BALANCE_FILS = 50_000;

/**
 * One address row, written straight to the table.
 *
 * `latitude`/`longitude` ARE TEXT AND ARE SENT AS TEXT. `db/schema/delivery.ts`
 * records why they are not `numeric`: `scripts/verify-constraints.sql` § 4 bans
 * the float family and refuses `numeric` with it, because a money column one join
 * away from a float is the invariant's whole subject. Nothing does arithmetic on
 * a coordinate, so it is text with a CHECK on the shape. A fixture that wrote
 * them as bare numbers would still round-trip as strings and the shape pins below
 * would read as passing for the wrong reason.
 */
function seedAddress(
  id: string,
  memberId: string,
  opts: { block: string; street: string; instructions?: string; deleted?: boolean },
): void {
  psql(`
    INSERT INTO member_address (id, member_id, label, block, street, building,
                                floor, apartment, area, governorate, instructions,
                                latitude, longitude, deleted_at)
    VALUES ('${id}', '${memberId}', 'QAADR label', '${opts.block}', '${opts.street}',
            'QAADR building', '3', '12', 'Salmiya', 'Hawalli',
            ${opts.instructions ? `'${opts.instructions}'` : 'NULL'},
            '29.336670', '48.077500',
            ${opts.deleted ? 'now()' : 'NULL'})
    ON CONFLICT (id) DO UPDATE SET
      member_id   = EXCLUDED.member_id,
      block       = EXCLUDED.block,
      street      = EXCLUDED.street,
      instructions = EXCLUDED.instructions,
      deleted_at  = EXCLUDED.deleted_at;
  `);
}

/**
 * A settled `shop` transaction and the delivery order hanging off it.
 *
 * `kind = 'shop'` forces `amount_fils < 0` and `status = 'settled'` forces
 * `settled_at` non-null — both real CHECKs, and both the real shape: an order
 * hangs off a charge that already settled, which is why moving it along touches
 * no money.
 *
 * `address_id` IS PASSED, unlike `tenancy.test.ts`'s fixture, because two specs
 * below turn on the FK being present while the row it points at is soft-deleted —
 * the exact state `routes/addresses.ts` § SOFT DELETE says the `ON DELETE
 * restrict` exists to make representable.
 */
function seedOrder(
  transactionId: string,
  memberId: string,
  addressId: string,
  snapshot: { block: string; street: string; instructions?: string },
): void {
  psql(`
    INSERT INTO transaction (id, member_id, salon_id, branch_id, kind, amount_fils,
                             method, status, settled_at)
    VALUES ('${transactionId}', '${memberId}', '${SALON_A}', '${A_BRANCH}', 'shop',
            -1000, 'wallet', 'settled', now())
    ON CONFLICT (id) DO UPDATE SET salon_id = EXCLUDED.salon_id;

    INSERT INTO shop_order (transaction_id, salon_id, member_id, fulfilment, status,
                            address_id, address_label, block, street, building,
                            floor, apartment, area, governorate, instructions,
                            latitude, longitude)
    VALUES ('${transactionId}', '${SALON_A}', '${memberId}', 'delivery', 'preparing',
            '${addressId}', 'QAADR label', '${snapshot.block}', '${snapshot.street}',
            'QAADR building', '3', '12', 'Salmiya', 'Hawalli',
            ${snapshot.instructions ? `'${snapshot.instructions}'` : 'NULL'},
            '29.336670', '48.077500')
    ON CONFLICT (transaction_id) DO UPDATE SET
      status = 'preparing', ready_at = NULL, closed_at = NULL,
      block = EXCLUDED.block, street = EXCLUDED.street;
  `);
}

/**
 * FK ORDER, AND EVERY LINE OF IT IS LOAD-BEARING.
 *
 *   `shop_order.transaction_id`  → `transaction`, restrict. Orders first.
 *   `shop_order.address_id`      → `member_address`, restrict. Orders before
 *                                  addresses, which is the FK that makes the soft
 *                                  delete necessary in the product and necessary
 *                                  here.
 *   `transaction.member_id`      → `member`, restrict. Transactions before members
 *                                  — and this is why erasure is a SCRUB rather
 *                                  than a DELETE in the first place.
 *
 * `audit_log` IS LEFT ALONE. `audit_log_no_delete` refuses a DELETE outright and
 * that is the table working; the erasure job's own row accumulates across runs
 * and names nobody, by design (`services/erasure.ts` § THE JOB'S OWN AUDIT ROW).
 */
function dropFixtures(): void {
  const ids = `'${HER}', '${NEIGHBOUR}', '${ERASED}'`;
  psql(`
    DELETE FROM shop_order  WHERE member_id IN (${ids});
    DELETE FROM transaction WHERE member_id IN (${ids});
    DELETE FROM member_address WHERE member_id IN (${ids});
    DELETE FROM session     WHERE member_id IN (${ids});
    DELETE FROM wallet_token WHERE member_id IN (${ids});
    DELETE FROM member      WHERE id IN (${ids});
  `);
}

function seedEverything(): void {
  seedMember(HER, 'Address Fixture Her', HER_PHONE);
  seedMember(NEIGHBOUR, 'Address Fixture Neighbour', NEIGHBOUR_PHONE);
  seedMember(ERASED, 'Address Fixture Erased', ERASED_PHONE);

  seedAddress(HER_ADDRESS, HER, { block: 'QAADR-HER-BLOCK', street: HER_STREET });
  seedAddress(HER_DELETED_ADDRESS, HER, {
    block: 'QAADR-HER-GONE-BLOCK',
    street: 'QAADR-HER-GONE-STREET-SENTINEL',
    deleted: true,
  });
  seedAddress(NEIGHBOUR_ADDRESS, NEIGHBOUR, {
    block: NEIGHBOUR_BLOCK,
    street: NEIGHBOUR_STREET,
    instructions: NEIGHBOUR_INSTRUCTIONS,
  });
  seedAddress(ERASED_ADDRESS, ERASED, {
    block: 'QAADR-ERASED-BLOCK',
    street: ERASED_STREET,
    instructions: ERASED_INSTRUCTIONS,
  });

  /**
   * HER order points at the SOFT-DELETED address, which is the interesting pair:
   * the row is gone from her book and the snapshot on the order is not.
   */
  seedOrder(HER_ORDER, HER, HER_DELETED_ADDRESS, {
    block: 'QAADR-HER-GONE-BLOCK',
    street: 'QAADR-HER-GONE-STREET-SENTINEL',
  });
  seedOrder(ERASED_ORDER, ERASED, ERASED_ADDRESS, {
    block: 'QAADR-ERASED-BLOCK',
    street: ERASED_STREET,
    instructions: ERASED_INSTRUCTIONS,
  });
}

interface ErasureResult {
  candidates: number;
  erased: number;
  deferredBalance: number;
  deferredEscrow: number;
  deferredPendingTopup: number;
  skipped: number;
  failed: number;
}

/**
 * `support-routing.test.ts` runs this job too, with an identical helper, and the
 * duplication is deliberate rather than an oversight: that file's copy lives
 * inside a describe about ticket routing and importing it would couple two
 * unrelated suites through a fixture. Six lines is cheaper than the coupling.
 */
function runErasureJob(): ErasureResult {
  const res = runApiDbScriptResult('src/jobs/erasure-once.ts', pgDb());
  if (!res.ok) {
    throw new Error(
      `the erasure job failed to run at all.\n--- stdout ---\n${res.stdout}\n` +
        `--- stderr ---\n${res.stderr}`,
    );
  }
  const start = res.stdout.indexOf('{');
  if (start < 0) throw new Error(`the erasure job printed no JSON:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start)) as ErasureResult;
}

const count = (sql: string): number => Number(scalar(sql).trim());

let n = 0;
const key = (label: string) => `qaadr-${label}-${Date.now()}-${n++}`;

beforeAll(async () => {
  await startTenancyApi();
  dropFixtures();
  seedEverything();

  her = await signInMember(SALON_A, HER_PHONE);
  neighbour = await signInMember(SALON_A, NEIGHBOUR_PHONE);

  precondition(
    count(`select count(*) from member_address where member_id='${NEIGHBOUR}'`) === 1,
    'the neighbour has no address, so nothing below can attempt to read one',
  );
  precondition(
    scalar(`select module_shop from salon where id='${SALON_A}'`).trim() === 't',
    `salon A has the shop module OFF, so every POST /orders below will be refused with ` +
      `shop_not_enabled before it reaches the address lookup it is about`,
  );
}, 120_000);

afterAll(async () => {
  dropFixtures();
  await stopTenancyApi();
});

// ===========================================================================
// 1. ONE MEMBER CANNOT REACH ANOTHER'S ADDRESS BOOK
// ===========================================================================
/**
 * DRIVEN DIRECTLY, PER NON-NEGOTIABLE #7's SECOND HALF, and the reason it needs
 * saying for a route with no permission on it is that the census cannot help.
 *
 * `permission-census.test.ts` pins all five member routes as `[requireMember]`,
 * which is the correct classification and says nothing about scope: the ledger
 * line is byte-identical whether `routes/addresses.ts` carries
 * `eq(memberAddress.memberId, p.id)` in its WHERE or not. The generated sweep
 * cannot fill the gap either — it revokes PERMISSIONS, and there is no permission
 * here to revoke. So the only thing that can distinguish a scoped route from an
 * unscoped one is a second member's token and a first member's row id.
 *
 * "FAMILY RESEMBLANCE" IS THE THING BEING AVOIDED. There are eleven other
 * `[requireMember]` routes already pinned and several are probed cross-member
 * elsewhere, which makes it tempting to treat this set as covered by pattern. It
 * is not a pattern, it is a WHERE clause, written once per handler and omittable
 * once per handler — and the worst outcome available in this feature is a member
 * reading another member's home address. Worse than a salon boundary crossing,
 * because a salon is an accountable business with a contract and a stranger is
 * not.
 *
 * A 404 AND NOT A 403 IS THE RIGHT REFUSAL, and it is asserted as such rather
 * than tolerated. `routes/addresses.ts` scopes the lookup inside the WHERE, so an
 * id belonging to somebody else is indistinguishable from an id belonging to
 * nobody — which is the property that matters: a 403 would confirm the address
 * exists, and existence is itself a fact about a stranger.
 */
describe('one member cannot reach another member\'s address book', () => {
  it('GET /members/me/addresses serves HERS and contains no trace of the neighbour', async () => {
    const res = await treq<{ items: Array<{ id: string }> }>(
      'GET',
      '/members/me/addresses',
      { token: her },
    );
    expect(res.status, `answered ${res.status}: ${res.raw}`).toBe(200);

    const ids = res.body.items.map((a) => a.id);
    expect(ids, 'her live address is missing from her own book').toContain(HER_ADDRESS);
    expect(ids, 'the neighbour\'s address is in HER book').not.toContain(NEIGHBOUR_ADDRESS);
    // The soft-deleted one is gone from the book. Its snapshot is a separate
    // question, asked in § the snapshot outlives the book below.
    expect(ids, 'a soft-deleted address is still listed in her book').not.toContain(
      HER_DELETED_ADDRESS,
    );

    for (const sentinel of [NEIGHBOUR_STREET, NEIGHBOUR_BLOCK, NEIGHBOUR_INSTRUCTIONS]) {
      expect(res.raw, `her address list leaked the neighbour's ${sentinel}`).not.toContain(
        sentinel,
      );
    }
  });

  it('PUT /members/me/addresses/:id on the NEIGHBOUR\'s id is a 404 and edits nothing', async () => {
    const before = scalar(
      `select street from member_address where id='${NEIGHBOUR_ADDRESS}'`,
    ).trim();
    precondition(before === NEIGHBOUR_STREET, `the fixture street is "${before}"`);

    const res = await treq<{ error: string; message: string }>(
      'PUT',
      `/members/me/addresses/${NEIGHBOUR_ADDRESS}`,
      {
        token: her,
        body: {
          label: 'overwritten',
          block: 'overwritten',
          street: 'QAADR-OVERWRITTEN-BY-HER',
          building: 'overwritten',
        },
      },
    );

    expect(res.status, `answered ${res.status}: ${res.raw}`).toBe(404);
    expect(res.body.error).toBe('unknown_address');
    // A 403 would confirm the row exists, which is a fact about somebody else.
    expect(
      res.body.message,
      'the refusal distinguishes "not yours" from "not there", which tells her it exists',
    ).toBe('No such address.');
    expect(res.raw, 'the refusal echoed the neighbour\'s street back').not.toContain(
      NEIGHBOUR_STREET,
    );

    expect(
      scalar(`select street from member_address where id='${NEIGHBOUR_ADDRESS}'`).trim(),
      'THE NEIGHBOUR\'S ADDRESS WAS REWRITTEN BY ANOTHER CUSTOMER. The 404 is not the ' +
        'whole assertion — a handler that refuses after writing has refused nothing.',
    ).toBe(NEIGHBOUR_STREET);
  });

  it('DELETE /members/me/addresses/:id on the NEIGHBOUR\'s id is a 404 and deletes nothing', async () => {
    const res = await treq<{ error: string }>(
      'DELETE',
      `/members/me/addresses/${NEIGHBOUR_ADDRESS}`,
      { token: her },
    );
    expect(res.status, `answered ${res.status}: ${res.raw}`).toBe(404);
    expect(res.body.error).toBe('unknown_address');

    expect(
      count(
        `select count(*) from member_address
          where id='${NEIGHBOUR_ADDRESS}' and deleted_at is null`,
      ),
      'ANOTHER CUSTOMER SOFT-DELETED THE NEIGHBOUR\'S ADDRESS. She would find it gone ' +
        'from her own book with no way to get it back and no record of who did it.',
    ).toBe(1);

    // And it is still hers to read — the neighbour's own book is unchanged.
    const hers = await treq<{ items: Array<{ id: string }> }>(
      'GET',
      '/members/me/addresses',
      { token: neighbour },
    );
    expect(hers.status).toBe(200);
    expect(
      hers.body.items.map((a) => a.id),
      'the neighbour has lost her address from her own book',
    ).toContain(NEIGHBOUR_ADDRESS);
  });

  it('POST /members/me/addresses cannot write into the neighbour\'s book', async () => {
    /**
     * REFUSED BY NAME rather than ignored, which is the stronger treatment and the
     * one `POST /orders` gives a price. A silently-ignored `memberId` means a
     * client that believed it was choosing the owner is told it succeeded.
     */
    const res = await treq<{ error: string }>('POST', '/members/me/addresses', {
      token: her,
      body: {
        memberId: NEIGHBOUR,
        label: 'planted',
        block: 'planted',
        street: 'QAADR-PLANTED-IN-NEIGHBOUR-BOOK',
        building: 'planted',
      },
    });

    expect(res.status, `answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('member_not_client_supplied');
    expect(
      count(
        `select count(*) from member_address
          where member_id='${NEIGHBOUR}'
            and street='QAADR-PLANTED-IN-NEIGHBOUR-BOOK'`,
      ),
      'a row was planted in the neighbour\'s address book by another customer',
    ).toBe(0);
  });

  it('GET /members/me/orders serves HERS and no trace of another member\'s snapshot', async () => {
    const res = await treq<{ items: Array<{ transactionId: string }> }>(
      'GET',
      '/members/me/orders',
      { token: her },
    );
    expect(res.status, `answered ${res.status}: ${res.raw}`).toBe(200);

    const ids = res.body.items.map((o) => o.transactionId);
    expect(ids, 'her own order is missing from her list').toContain(HER_ORDER);
    expect(ids, 'another member\'s order is in her list').not.toContain(ERASED_ORDER);
    for (const sentinel of [ERASED_STREET, ERASED_INSTRUCTIONS, NEIGHBOUR_STREET]) {
      expect(res.raw, `her order list leaked ${sentinel}`).not.toContain(sentinel);
    }
  });
});

// ===========================================================================
// 2. THE SECOND DOOR TO AN ADDRESS — POST /orders
// ===========================================================================
/**
 * THE ORDER PATH IS A READ OF THE ADDRESS BOOK, and it is the door a probe set
 * built around `/members/me/addresses` would miss entirely.
 *
 * `POST /orders` takes an `addressId` and SNAPSHOTS the row onto the order
 * (`services/order.ts` § 5b). If that lookup were not scoped to the member, a
 * customer could copy a stranger's home address onto her own order and then read
 * it back at leisure through `GET /members/me/orders` — a cross-member address
 * read dressed as her own order history, and one that leaves a permanent,
 * immutable copy behind. The address routes could all be perfectly scoped and
 * this would still be open.
 *
 * BOTH REFUSALS ALSO HAVE TO MOVE NO MONEY, and that half is not decoration. The
 * address is resolved at step 5b, AFTER the wallet debit at step 5 — the comment
 * above it says "refuses before any money moves", which is true only because the
 * whole thing is one `db.transaction` and the throw rolls the debit back. That is
 * a claim about atomicity, so it is asserted against her balance rather than
 * assumed from the status code. Non-negotiable #3's shape, on a path that is not
 * `POST /charges`.
 */
describe('POST /orders cannot snapshot an address that is not hers', () => {
  it('the NEIGHBOUR\'s addressId is a 404, no order is written, and no money moves', async () => {
    const before = count(`select balance_fils from member where id='${HER}'`);
    const ordersBefore = count(
      `select count(*) from shop_order where member_id='${HER}'`,
    );

    const res = await treq<{ error: string; message: string }>('POST', '/orders', {
      token: her,
      idempotencyKey: key('cross-member-address'),
      body: {
        items: [{ productId: await someProductAtSalonA(), qty: 1 }],
        fulfilment: 'delivery',
        addressId: NEIGHBOUR_ADDRESS,
      },
    });

    expect(res.status, `answered ${res.status}: ${res.raw}`).toBe(404);
    expect(res.body.error).toBe('unknown_address');
    expect(res.raw, 'the refusal echoed the neighbour\'s address').not.toContain(
      NEIGHBOUR_STREET,
    );

    expect(
      count(`select count(*) from shop_order where member_id='${HER}'`),
      'an order was written despite the refusal',
    ).toBe(ordersBefore);
    expect(
      count(`select balance_fils from member where id='${HER}'`),
      'HER WALLET WAS DEBITED FOR A REFUSED ORDER. The address is resolved at ' +
        'services/order.ts § 5b, after the debit at step 5, so the rollback is the only ' +
        'thing that makes "refuses before any money moves" true.',
    ).toBe(before);

    expect(
      count(
        `select count(*) from shop_order
          where address_id='${NEIGHBOUR_ADDRESS}' and member_id='${HER}'`,
      ),
      'the neighbour\'s address is now snapshotted onto another customer\'s order',
    ).toBe(0);
  });

  it('her OWN soft-deleted addressId is refused too — the book is the live rows', async () => {
    /**
     * The `isNull(deletedAt)` term, driven separately from the `memberId` term.
     * Both are in one `and(...)` and either could be dropped without the other
     * failing, so a probe that only crossed members would leave this half unread —
     * and a delivery to an address she deliberately removed is a bottle sent
     * somewhere she has left.
     */
    const before = count(`select balance_fils from member where id='${HER}'`);

    const res = await treq<{ error: string }>('POST', '/orders', {
      token: her,
      idempotencyKey: key('own-deleted-address'),
      body: {
        items: [{ productId: await someProductAtSalonA(), qty: 1 }],
        fulfilment: 'delivery',
        addressId: HER_DELETED_ADDRESS,
      },
    });

    expect(res.status, `answered ${res.status}: ${res.raw}`).toBe(404);
    expect(res.body.error).toBe('unknown_address');
    expect(
      count(`select balance_fils from member where id='${HER}'`),
      'her wallet was debited for an order to an address she had deleted',
    ).toBe(before);
  });
});

/**
 * ANY active product at salon A. Read rather than seeded, and the read is the
 * point: this file must not add a product to salon A, whose catalogue three other
 * files list. A cart line is a precondition here, not a subject — every order
 * below is refused for its ADDRESS, and it has to reach the address check to be
 * refused for it.
 */
let cachedProduct = '';
async function someProductAtSalonA(): Promise<string> {
  if (cachedProduct) return cachedProduct;
  cachedProduct = scalar(
    `select id from product where salon_id='${SALON_A}' and active order by id limit 1`,
  ).trim();
  precondition(
    cachedProduct !== '',
    'salon A has no active product, so no order can be composed and every spec in this ' +
      'section would be refused for an empty cart rather than for its address',
  );
  return cachedProduct;
}

// ===========================================================================
// 3. THE SNAPSHOT OUTLIVES THE BOOK — behaviour, pinned rather than complained about
// ===========================================================================
/**
 * A SOFT-DELETED ADDRESS IS STILL FULLY READABLE THROUGH THE ORDER, AND THAT IS
 * NOT THE BUG. It is documented, deliberate, and defensible three ways:
 * `shop_order.address_id` is `ON DELETE restrict` so a hard delete would refuse
 * for exactly the addresses that have been used; the driver needs what she typed;
 * and `shop_order_line` snapshots price and name for the same reason.
 *
 * IT IS PINNED HERE ANYWAY, and the reason is precisely what `contract.test.ts`
 * CANNOT see. That file now probes both order reads against `ShopOrderSchema`, so
 * the address is guaranteed to be present and well-shaped — but `paginated(
 * ShopOrderSchema)` is satisfied identically whether the snapshot is served from
 * `shop_order`'s own columns or joined live from `member_address`. Those are the
 * same SHAPE and opposite BEHAVIOUR: joined live, a soft-deleted address makes the
 * `address` null or 404s a driver's order. A schema cannot distinguish them; a
 * soft-deleted row and a request can, which is what this spec is.
 *
 * And it is the precise fact that makes the erasure finding below a finding: "she
 * can delete an address" is true of her book and false of the copy a salon reads,
 * and the two are easy to conflate when only one of them has a DELETE endpoint.
 *
 * WHAT IS ACTUALLY MISSING IS REPORTED, NOT ASSERTED, because it is a product
 * decision and not a defect: there is no route, on any surface, that removes an
 * address from a past order, and no horizon after which it stops being served.
 * `DELETE /members/me/addresses/:id` is the only deletion the customer has and it
 * reaches one of the two copies.
 */
describe('the snapshot outlives the book, and the book\'s DELETE does not reach it', () => {
  it('her deleted address is gone from the book and intact on the order', async () => {
    precondition(
      scalar(
        `select deleted_at is not null from member_address where id='${HER_DELETED_ADDRESS}'`,
      ).trim() === 't',
      'the fixture address is not soft-deleted, so this spec is asking nothing',
    );

    const book = await treq<{ items: Array<{ id: string }> }>(
      'GET',
      '/members/me/addresses',
      { token: her },
    );
    expect(book.body.items.map((a) => a.id)).not.toContain(HER_DELETED_ADDRESS);

    const orders = await treq<{
      items: Array<{
        transactionId: string;
        address: null | { id: string | null; street: string | null };
      }>;
    }>('GET', '/members/me/orders', { token: her });
    expect(orders.status, `answered ${orders.status}: ${orders.raw}`).toBe(200);

    const row = orders.body.items.find((o) => o.transactionId === HER_ORDER);
    expect(row, 'her order is not in her own order list').toBeDefined();
    expect(
      row!.address,
      'the snapshot is null, so the order no longer says where it was going — the ' +
        'address is now served from the LIVE row rather than the snapshot, and a ' +
        'deleted address has taken a driver\'s destination with it',
    ).not.toBeNull();
    expect(
      row!.address!.street,
      'the snapshot no longer carries the street she typed',
    ).toBe('QAADR-HER-GONE-STREET-SENTINEL');
    expect(
      row!.address!.id,
      'address_id was cleared, so the provenance link to her book is gone',
    ).toBe(HER_DELETED_ADDRESS);
  });
});

// ===========================================================================
// 4. THE FINDING — the erasure job has never heard of either table
// ===========================================================================
/**
 * ===========================================================================
 * THE 30-DAY ERASURE PROMISE DOES NOT REACH A CUSTOMER'S HOME ADDRESS.
 * NEITHER COPY OF IT. LANE A'S TO FIX.
 * ===========================================================================
 * `services/erasure.ts` executes the published privacy policy's § 5, quoted
 * verbatim in its own header: "The rest of your account data is deleted within 30
 * days of a deletion request." Its header is then a table, table by table, of
 * what the scrub does and why — `session`, `wallet_token`,
 * `member_password_reset`, `phone_change_challenge`, `merchant_notification`,
 * `receipt_job`, `support_ticket`, `booking`, `loyalty_event`, `campaign_send`,
 * `member_consent_event`, `audit_log`. Twelve tables, each with a decision
 * attached, and three of them FLAGGED to trunk rather than silently decided,
 * which is the standard this file is measuring against.
 *
 * `member_address` AND `shop_order` ARE NOT IN THAT TABLE AND NOT IN THE CODE.
 * Not deleted, not scrubbed, not KEPT-with-a-reason, not deferred, not flagged.
 * `git log` on `services/erasure.ts` ends at `94eeb90`; migration 0045 landed
 * item 7 afterwards, and nothing brought the job forward with it. The two tables
 * are absent in the way a table nobody has thought about is absent, which is
 * different from `booking` and `loyalty_event` being absent from the DELETE list
 * — those are KEPT, on an argument, in writing.
 *
 * WHY THE JOB'S OWN STANDING ARGUMENT CANNOT BE STRETCHED TO COVER THIS, and this
 * is the part worth reading before deciding it is a small fix. Erasure keeps
 * `booking`, `loyalty_event`, `campaign_send` and the member's own aggregates on
 * one reasoning, stated three times in its header: "a booking pointing at a
 * tombstone identifies nobody", "reward history de-identified rather than
 * destroyed". That is TRUE of a visit count, a stamp total and a campaign send
 * row. It is FALSE of a street address. A block, a street, a building, a floor and
 * an apartment identify a household directly and without help; they are not
 * de-identified by the name beside them turning into 'Deleted account', because
 * the address IS the identifier. So the scrub's central justification inverts here
 * rather than extending, and that is why this needs a decision rather than a line
 * of SQL.
 *
 * TWO PLACES, TWO DIFFERENT DECISIONS, and a fix that treats them as one thing
 * will get one of them wrong:
 *
 *   `member_address`   HER BOOK. Nothing references these rows except her own
 *                      orders, and the policy's "rest of your account data" covers
 *                      them with no ambiguity at all — there is no seven-year
 *                      books argument here, because an address is not a financial
 *                      record. This one looks like a straight DELETE, in the same
 *                      list as `wallet_token`.
 *
 *   `shop_order.*`     THE SNAPSHOT. Harder, and genuinely arguable. The row hangs
 *                      off a `transaction` that survives seven years by financial
 *                      rule, and a salon may have an operational claim on a
 *                      fulfilment record. But the address COLUMNS are separable
 *                      from the order: nulling block/street/building/floor/
 *                      apartment/instructions/coordinates leaves the order, its
 *                      lines, its money and its status intact and removes the
 *                      household. `shop_order_delivery_has_an_address` would
 *                      REFUSE that update as written — a delivery must have the
 *                      three parts — so it is a migration and not a one-liner,
 *                      which is exactly why it should not be decided in passing.
 *
 * AND A THIRD THING THAT IS NOT LANE A'S AT ALL — CLIENT-OWNED, per CLAUDE.md's
 * escalations. The policy's § 2 is the collection notice and it enumerates what
 * was collected: "your name, phone number, appointment history, transaction and
 * reward history, and basic device data". A HOME ADDRESS IS NOT IN THAT LIST. The
 * published text predates item 7, so the product now stores a category of personal
 * data its own privacy policy does not disclose. That is counsel's, not
 * engineering's, and it is the reason this section reports rather than proposes.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. This is not an erasure audit — the brief
 * that dispatched this slice said not to build one and it is the right call: the
 * job's twelve-table header is lane A's own work and re-deriving it would be
 * expensive and would not change the finding. The two specs below establish the
 * fact behaviourally, name the tables, and stop.
 */
describe('the erasure job has never heard of member_address or shop_order', () => {
  /**
   * ONE JOB RUN SERVES BOTH SPECS AND IS PERFORMED HERE, not in each. It is
   * irreversible for the member it erases, and running it twice would make the
   * second spec's subject a member already erased — which is a different state and
   * would read as a different bug.
   *
   * THE JOB IS SHARED WITH EVERY OTHER MEMBER IN THE DATABASE, so nothing below
   * asserts on `candidates` or `erased`. Another file's fixture with a past due
   * date is legitimately erased by the same pass, and a spec that counted would go
   * red for somebody else's reasons. What is asserted is this member's own state.
   */
  let result: ErasureResult | null = null;

  beforeAll(() => {
    precondition(
      count(`select count(*) from member_address where member_id='${ERASED}'`) === 1 &&
        count(`select count(*) from shop_order where member_id='${ERASED}'`) === 1,
      'the erasure subject has no address or no order, so the job has nothing to miss',
    );

    // Due yesterday. `runErasureOnce` selects on `deletion_due_at <= now()` with
    // `erased_at IS NULL`, and re-checks both inside the member row's FOR UPDATE.
    psql(`
      UPDATE member
         SET deletion_requested_at = now() - interval '31 days',
             deletion_due_at       = now() - interval '1 day',
             balance_fils          = 0
       WHERE id = '${ERASED}';
    `);
    result = runErasureJob();

    precondition(
      scalar(`select erased_at is not null from member where id='${ERASED}'`).trim() === 't',
      `the job did not erase the subject at all, so neither spec below is about what it ` +
        `says it is about. The job reported ${JSON.stringify(result)} — a nonzero ` +
        `deferredBalance or deferredEscrow means the fixture has money state the job ` +
        `refuses to decide, which is the job working and a broken fixture.`,
    );
  }, 120_000);

  knownBug(
    'her address book is deleted with the rest of her account data',
    () => {
      precondition(
        scalar(`select name from member where id='${ERASED}'`).trim() === 'Deleted account',
        'the member is not a tombstone, so the scrub did not run on her',
      );

      expect(
        count(`select count(*) from member_address where member_id='${ERASED}'`),
        'HER SAVED ADDRESS BOOK SURVIVED THE ERASURE, INTACT.\n\n' +
          'The published privacy policy promises "the rest of your account data is deleted ' +
          'within 30 days", the job carries out that promise for twelve other tables, and ' +
          '`member_address` is in neither its code nor its header. The rows are not kept ' +
          'on an argument the way `booking` and `loyalty_event` are — they are absent, ' +
          'because migration 0045 landed after the job was written and nothing brought the ' +
          'job forward.\n\n' +
          'AND THE JOB\'S OWN STANDING ARGUMENT DOES NOT COVER THEM. It keeps de-identified ' +
          'rows on the grounds that "a booking pointing at a tombstone identifies nobody". ' +
          'A street address is not de-identified by the name beside it becoming ' +
          '"Deleted account": block, street, building, floor and apartment identify a ' +
          'household on their own.\n\n' +
          'THE FIX IS LANE A\'S and looks like a DELETE in the same list as `wallet_token` — ' +
          'nothing references these rows but her own orders, and an address is not a ' +
          'financial record, so the seven-year books argument does not reach it. See this ' +
          'file\'s § 4 header for the snapshot half, which is harder, and for the disclosure ' +
          'question that is counsel\'s rather than engineering\'s.',
      ).toBe(0);
    },
    120_000,
  );

  knownBug(
    'the address snapshot on her past order is scrubbed with her',
    () => {
      precondition(
        count(`select count(*) from shop_order where member_id='${ERASED}'`) === 1,
        'the order row is gone entirely, which is a different outcome than this asserts',
      );

      const survives = count(`
        select count(*) from shop_order
         where member_id='${ERASED}'
           and (street is not null or block is not null or building is not null
                or floor is not null or apartment is not null
                or instructions is not null
                or latitude is not null or longitude is not null)
      `);

      expect(
        survives,
        'THE HOME ADDRESS ON HER PAST ORDER SURVIVED THE ERASURE, AND THIS IS THE COPY A ' +
          'SALON READS.\n\n' +
          'The snapshot is served by `GET /v1/salons/{id}/orders` behind `perms.shop`, with ' +
          'every component: block, street, building, floor, apartment, instructions and ' +
          'coordinates. The member row is a tombstone — name "Deleted account", a synthetic ' +
          '+990 phone — and the merchant board still renders exactly where she lives beside ' +
          'it. De-identifying the name and keeping the address is the worst of the two ' +
          'available outcomes, because it removes the accountability and keeps the exposure.\n\n' +
          'THE ORDER ITSELF NEED NOT GO. The address columns are separable: nulling them ' +
          'leaves the transaction, the lines, the money and the status intact. But ' +
          '`shop_order_delivery_has_an_address` REFUSES that update as written — a delivery ' +
          'row must carry block, street and building — so this is a migration plus a job ' +
          'clause, not a one-line addition, and that is why it is reported rather than ' +
          'guessed at.\n\n' +
          'IF THE DECISION IS TO KEEP IT, that is a legitimate answer and it belongs in the ' +
          'job\'s header beside `booking` and `loyalty_event`, with the argument written ' +
          'down — the standard the rest of that file already meets. What is not acceptable ' +
          'is the current state, where the table is absent rather than decided.',
      ).toBe(0);
    },
    120_000,
  );

  /**
   * THE HALF THAT IS NOT A BUG, ASSERTED SO THE TWO ABOVE CANNOT BE READ AS "THE
   * JOB DOES NOT WORK". It does work, on everything it knows about — and that is
   * what makes the two absences findings about item 7 rather than about erasure.
   */
  it('everything the job DOES know about was scrubbed — the finding is the gap, not the job', () => {
    expect(scalar(`select name from member where id='${ERASED}'`).trim()).toBe(
      'Deleted account',
    );
    expect(
      scalar(`select phone from member where id='${ERASED}'`).trim(),
      'the tombstone phone is not the synthetic +990 value',
    ).toMatch(/^\+990\d+$/);
    expect(
      count(`select count(*) from session where member_id='${ERASED}'`),
      'her sessions survived, which the job explicitly deletes',
    ).toBe(0);
    expect(
      result?.failed,
      `the job reported failures: ${JSON.stringify(result)}`,
    ).toBe(0);
  });

  /**
   * AND THE READ PATH, WHICH IS WHERE THE COST LANDS. The two knownBugs are about
   * rows; this is about a response, and it is the one a reviewer should look at
   * first because it is what a salon actually sees.
   *
   * A PLAIN `it`, NOT A `knownBug`, and the distinction is deliberate: this
   * asserts what the API DOES today so the claim cannot rot, and it will keep
   * passing after the erasure gap is closed for the orders of members who have NOT
   * asked to be erased — which is correct behaviour. What it pins is that the
   * merchant board serves the full snapshot for a CLOSED order with no horizon,
   * which is a retention question rather than a defect.
   */
  it('the board has no horizon — a closed order still serves the full snapshot', async () => {
    psql(`
      UPDATE shop_order
         SET status = 'closed', ready_at = now() - interval '2 days',
             closed_at = now() - interval '2 days'
       WHERE transaction_id = '${ERASED_ORDER}';
    `);

    const merchant = await treq<{
      items: Array<{
        transactionId: string;
        memberName: string;
        address: null | { street: string | null; instructions: string | null };
      }>;
      truncated: boolean;
      nextCursor: string | null;
    }>('GET', `/v1/salons/${SALON_A}/orders?status=closed`, {
      token: await merchantToken(),
    });
    expect(merchant.status, `answered ${merchant.status}: ${merchant.raw}`).toBe(200);

    const row = merchant.body.items.find((o) => o.transactionId === ERASED_ORDER);
    precondition(row !== undefined, 'the closed order is not on the board at all');

    /**
     * REPORTED, NOT REFUSED. There is nothing wrong with the merchant reading her
     * own salon's fulfilment history, and `perms.shop` is the right gate for it
     * (see permission-census.test.ts's note). What this pins is the SHAPE of the
     * exposure so the retention decision is taken deliberately: the row is closed,
     * two days old, its member is an erased tombstone, and the board still carries
     * the street and the gate code. A permission decides who; nothing in this
     * feature decides for how long.
     */
    expect(row!.address, 'the snapshot is gone from the board').not.toBeNull();
    expect(row!.address!.street).toBe(ERASED_STREET);
    expect(
      row!.address!.instructions,
      'the free-text delivery instruction — a gate code, a "ring twice" — is served too',
    ).toBe(ERASED_INSTRUCTIONS);
    expect(
      row!.memberName,
      'the board names the tombstone, which is the point: the identity is de-identified ' +
        'and the address beside it is not',
    ).toBe('Deleted account');
  });
});

/**
 * The merchant credential for salon A. Minted lazily and once: `signInDashboard`
 * caches per run, and this file needs it in exactly one spec, so importing it into
 * the top-level `beforeAll` would spend a sign-in every run for a spec that might
 * be filtered out.
 */
let cachedMerchant = '';
async function merchantToken(): Promise<string> {
  if (cachedMerchant) return cachedMerchant;
  const { signInDashboard } = await import('./support/tenancy-harness.js');
  cachedMerchant = await signInDashboard(SALON_A, 'noura');
  return cachedMerchant;
}

// ===========================================================================
// 5. THE TWO THINGS THE SCHEMA CANNOT SAY
// ===========================================================================
/**
 * THIS SECTION USED TO PIN ALL THREE KEY SETS AND NO LONGER DOES, because the
 * reason it existed stopped being true while this file was being written.
 *
 * It was three specs asserting the exact served keys of the address book, the
 * order list and the merchant board, on the grounds that `packages/types`
 * declared neither entity and `contract.test.ts` therefore had nothing to compare
 * against. Trunk landed `MemberAddressSchema`, `OrderStatusSchema` and
 * `ShopOrderSchema` in `65ab72e`, so `contract.test.ts` now PROBES all three in
 * both directions — a key the schema declares and the wire drops, and a key the
 * wire sends and the parse deletes. Keeping the key lists here as well would mean
 * two files asserting one shape, and the one nobody edits is the one that rots.
 *
 * WHAT IS LEFT IS WHAT A ZOD SCHEMA STRUCTURALLY CANNOT ASSERT. Both are about
 * the gap between what a shape permits and what the product means.
 */
describe('the two the schema cannot say', () => {
  /**
   * `truncated` IS NOT A CURSOR, AND A CLIENT THAT PAGES ON `nextCursor` GETS THE
   * BUG LANE C ALREADY PAID FOR ONCE.
   *
   * `GET /salons/{id}/bookings` served `nextCursor: null` on a `LIMIT 200` list.
   * Lane C believed it, loaded 211 further-out bookings, and its closure-impact
   * screen read 0 deposit-held appointments where `closure-preview` correctly
   * reported 3 — because the order is `starts_at DESC` and the rows dropped first
   * were the ones starting soonest. Lane A fixed that route with a real cursor in
   * the same merge that brought this feature.
   *
   * THESE TWO ORDER LISTS DID NOT GET ONE, and `contract.test.ts` cannot say so.
   * Its `wireOnly` annotation records that `truncated` exists and belongs to no
   * schema; it cannot record that `nextCursor` is null BY CONSTRUCTION rather than
   * because this page happens to be the last. `paginated(ShopOrderSchema)` is
   * satisfied by a real cursor and by a hardcoded null equally, so a client author
   * reading the schema learns nothing about which. This spec is the difference.
   */
  it('nextCursor is permanently null and truncated is the field to read instead', async () => {
    const mine = await treq<{ items: unknown[]; truncated: unknown; nextCursor: unknown }>(
      'GET',
      '/members/me/orders',
      { token: her },
    );
    precondition(mine.status === 200, `answered ${mine.status}: ${mine.raw}`);
    expect(
      mine.body.nextCursor,
      'GET /members/me/orders GREW A CURSOR — good news. Delete this spec, drop the ' +
        '`$.truncated` wireOnly note in contract.test.ts, and check whether `truncated` is ' +
        'still served at all.',
    ).toBeNull();
    expect(
      typeof mine.body.truncated,
      '`truncated` is not a boolean, so a client cannot act on it',
    ).toBe('boolean');
    /**
     * THE FIXTURE IS ONE ORDER, so `truncated` must be FALSE — and this half is
     * what makes the assertion above mean something. A route that hardcoded
     * `truncated: true` would satisfy "is a boolean" while telling every client its
     * list is incomplete, and a route that hardcoded `false` would be the bookings
     * bug wearing a different field name.
     */
    expect(
      mine.body.truncated,
      'one order in the fixture and the list reports itself truncated',
    ).toBe(false);

    const board = await treq<{ truncated: unknown; nextCursor: unknown }>(
      'GET',
      `/v1/salons/${SALON_A}/orders`,
      { token: await merchantToken() },
    );
    precondition(board.status === 200, `the board answered ${board.status}: ${board.raw}`);
    expect(board.body.nextCursor, 'the merchant board grew a cursor — same as above').toBeNull();
    expect(typeof board.body.truncated).toBe('boolean');
  });

  /**
   * THE COLUMN IS WIDER THAN THE SCHEMA — `shop_order.address_id` is NULLABLE and
   * `ShopOrderSchema.address.id` is `IdSchema`, which is `z.string().min(1)`.
   *
   * REPORTED, NOT ASSERTED AS A BUG, because no API path can produce the state
   * today and this spec says exactly that. `services/order.ts` § 5b resolves the
   * address before writing the row and throws if it is not hers, so a delivery
   * order always gets a real id; and the FK is `ON DELETE restrict`, so the row it
   * points at cannot be removed underneath it. The only writer that can produce
   * `address_id IS NULL` on a delivery is direct SQL.
   *
   * IT IS WORTH A SPEC ANYWAY, for two reasons that have nothing to do with it
   * being reachable. First, it already cost something: `tenancy.test.ts`'s order
   * fixture seeded `address_id` NULL — legal, and its own specs passed — and that
   * row would have failed `contract.test.ts`'s board probe, in a third file, for a
   * state the product cannot reach. That note is now on `PROBE_ORDER_A`. Second,
   * the honest fix is a decision rather than a patch: either the column becomes
   * NOT NULL for deliveries (a migration, and `shop_order_delivery_has_an_address`
   * is the natural place), or `ShopOrderSchema.address.id` becomes nullable and
   * every client learns to render an order whose address has no provenance. Lane A
   * owns the first, trunk the second.
   */
  it('the column permits an address_id the schema refuses, and no API path produces it', () => {
    const nullableColumn = scalar(`
      select is_nullable from information_schema.columns
       where table_name = 'shop_order' and column_name = 'address_id'
    `).trim();
    precondition(
      nullableColumn === 'YES' || nullableColumn === 'NO',
      `information_schema returned "${nullableColumn}" for shop_order.address_id`,
    );

    if (nullableColumn === 'NO') {
      /**
       * The gap closed. Good — say so rather than keep reporting it, and this is the
       * branch that makes the spec self-retiring instead of a permanent complaint.
       */
      expect(nullableColumn).toBe('NO');
      return;
    }

    /**
     * The column is nullable, so the claim to check is the NARROW one: every
     * delivery order in this database has a real `address_id`. That is the property
     * the product actually depends on, and it is the one a future writer — a bulk
     * import, an admin tool, a migration backfill — would break.
     */
    expect(
      count(`
        select count(*) from shop_order
         where fulfilment = 'delivery' and address_id is null
      `),
      'A DELIVERY ORDER HAS NO address_id. The column allows it and ' +
        '`ShopOrderSchema.address.id` (IdSchema, z.string().min(1)) does NOT, so this row ' +
        'cannot be serialised to any client — `contract.test.ts`\'s probes on both order ' +
        'reads will fail on it.\n\n' +
        'If a TEST fixture wrote it, point its `address_id` at a real `member_address` row; ' +
        '`tenancy.test.ts`\'s PROBE_ORDER_A carries the same note for the same reason. If an ' +
        'API path wrote it, that is a defect in lane A\'s column and the finding is that ' +
        '`services/order.ts` § 5b can now leave the provenance link empty on a delivery.',
    ).toBe(0);
  });
});
