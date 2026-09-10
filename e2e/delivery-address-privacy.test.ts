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
 *   2. DOES THE 30-DAY ERASURE PROMISE REACH THE ADDRESS? It did not, in either
 *      of the two places the address lives — the finding this file was written
 *      for. Lane A fixed both halves in `1f6bfb3` (DECISIONS.md #97, migration
 *      0048) and § 4 now pins the SHAPE of that fix rather than the gap: the book
 *      goes whole, the snapshot is nulled and stamped, the money stays, and the
 *      two writes happen in the only order the schema permits. What is still open
 *      is a retention HORIZON for the members who never asked, which is
 *      client-owned and which § 4's last spec keeps visible without inventing.
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
 * no fix: the snapshot is the copy a salon reads. Two lifetimes also means two
 * ERASURE outcomes — the book is deleted and the snapshot is scrubbed in place —
 * and § 4 asserts them apart for that reason.
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * `knownBug` IS NO LONGER IMPORTED, AND THAT IS THE STATE THIS FILE WANTED. Both
 * of its `knownBug()`s were promoted to plain `it()`s when lane A closed #97 —
 * the helper went red asking for exactly that, which is the whole point of it
 * over a comment. `precondition` stays, and is still the reason a dead server
 * cannot be mistaken for a passing assertion.
 */
import { precondition } from './support/known-bug.js';
import {
  A_BRANCH,
  A_STAFF_FULL,
  SALON_A,
  pgDb,
  psql,
  repoRoot,
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
/**
 * A SECOND ADDRESS FOR THE ERASURE SUBJECT, SOFT-DELETED AND REFERENCED BY
 * NOTHING — and it is the half of her book that a `deleted_at`-aware DELETE would
 * have left behind.
 *
 * `ERASED_ADDRESS` is the *used* one: `ERASED_ORDER` points at it, so the
 * `ON DELETE restrict` FK forces the snapshot null-out to happen first. This one
 * is the opposite case and needs the fixture precisely because the two failure
 * modes are opposite. A job that scoped its delete `AND deleted_at IS NULL` —
 * mirroring the addresses route, which is where that clause is correct — would
 * pass every assertion about the used row and silently keep this one, which still
 * carries a block, a street, a building and a coordinate pair.
 */
const ERASED_DELETED_ADDRESS = 'ADR-QAADR-ERASED-GONE';

const HER_ORDER = 'TX-QAADR-HERS';
const ERASED_ORDER = 'TX-QAADR-ERASED';

/**
 * `api/src/db/seed.ts`: PR-01 Argan hair oil, salon A. `orders.test.ts` uses the
 * same row for the same reason — it is the only shop product at this salon that
 * every seed has.
 *
 * THE PRICE HERE IS A SNAPSHOT AND IS DELIBERATELY NOT LOOKED UP.
 * `shop_order_line.unit_price_fils` is what the product cost at the moment of
 * sale, so a fixture that read `product.price_fils` today would couple itself to
 * a seed value that is free to change — and would be asserting the wrong thing
 * anyway. 8500 is a price this line was sold at, full stop.
 */
const ORDER_PRODUCT = 'PR-01';
const ORDER_PRODUCT_NAME = 'Argan hair oil 100ml';
const ORDER_PRICE_FILS = 8500;

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
const HER_GONE_STREET = 'QAADR-HER-GONE-STREET-SENTINEL';
/**
 * A GATE CODE ON *HER* ORDER, WHICH SHE HAS NEVER ASKED TO BE ERASED FROM, and
 * the fixture exists to carry the horizon question after the erasure gap closed.
 * The § 4 spec that pins the board's exposure used to read the ERASED member's
 * order; that row is now `address: null` by design, so the concern needs a
 * subject the scrub does not reach — which is also the far larger population the
 * question is actually about.
 */
const HER_INSTRUCTIONS = 'QAADR-HER-GATECODE-SENTINEL';
const ERASED_STREET = 'QAADR-ERASED-STREET-SENTINEL';
const ERASED_INSTRUCTIONS = 'QAADR-ERASED-GATECODE-SENTINEL';
const ERASED_GONE_STREET = 'QAADR-ERASED-GONE-STREET-SENTINEL';

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
 *
 * ---------------------------------------------------------------------------
 * ONE `shop_order_line`, AND THE ORDER'S AMOUNT IS DERIVED FROM IT.
 * ---------------------------------------------------------------------------
 * The line is what makes "the money survived the erasure" a real assertion
 * rather than a statement about one row. `shop_order_line` has UPDATE and DELETE
 * revoked from `avo_app` (migration 0027) exactly as `ledger_entry` does, so a
 * scrub that reached it would be reaching into append-only purchase evidence —
 * and nothing but this fixture would have noticed, because before this the
 * fixture orders had no lines at all.
 *
 * The transaction amount is `-(qty × unit_price)` rather than a round number, so
 * `transaction_amount_sign_matches_kind` and
 * `shop_order_line_total_matches_qty` are both satisfied by the same figure and
 * the fixture cannot drift into a shape the product cannot produce.
 *
 * ---------------------------------------------------------------------------
 * NO `ledger_entry` ROWS, AND THIS IS A LIMIT RATHER THAN AN OVERSIGHT.
 * ---------------------------------------------------------------------------
 * `ledger_entry` is append-only by TRIGGER (`ledger_entry_is_immutable`,
 * migration 0001), not by grant — so a fixture row can never be removed, by any
 * role, including the one `psql()` connects as. `ledger_entry.transaction_id` is
 * `ON DELETE restrict`, so a single seeded ledger row would make
 * `dropFixtures()`'s `DELETE FROM transaction` fail for ever, and this file's
 * teardown is what keeps `reports.test.ts` and `platform-salons.test.ts` honest.
 * `reports-applied-deposit.test.ts` hit the same wall and guards its insert on
 * presence because it cannot clean up either.
 *
 * So the ledger half of "the money survived" is asserted STRUCTURALLY below
 * instead — from the grants and the trigger, which is a statement about every
 * transaction rather than about one fixture pair. Lane A's
 * `services/erasureAddress.int.test.ts` asserts it behaviourally, to the fils, on
 * a member whose money arrives and leaves through the real paths; that suite is
 * the right place for it and cannot be replaced here.
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
            ${-ORDER_PRICE_FILS}, 'wallet', 'settled', now())
    ON CONFLICT (id) DO UPDATE SET salon_id = EXCLUDED.salon_id,
                                   amount_fils = EXCLUDED.amount_fils;

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
      address_id = EXCLUDED.address_id, address_label = EXCLUDED.address_label,
      block = EXCLUDED.block, street = EXCLUDED.street,
      building = EXCLUDED.building, floor = EXCLUDED.floor,
      apartment = EXCLUDED.apartment, area = EXCLUDED.area,
      governorate = EXCLUDED.governorate, instructions = EXCLUDED.instructions,
      latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
      address_erased_at = NULL;

    INSERT INTO shop_order_line (transaction_id, product_id, name, qty,
                                 unit_price_fils, line_total_fils)
    VALUES ('${transactionId}', '${ORDER_PRODUCT}', '${ORDER_PRODUCT_NAME}', 1,
            ${ORDER_PRICE_FILS}, ${ORDER_PRICE_FILS})
    ON CONFLICT (transaction_id, product_id) DO UPDATE SET
      qty = EXCLUDED.qty, line_total_fils = EXCLUDED.line_total_fils;
  `);
}

/**
 * FK ORDER, AND EVERY LINE OF IT IS LOAD-BEARING.
 *
 *   `shop_order_line.transaction_id` → `transaction`, restrict. Lines first, and
 *                                  they CAN be deleted here: 0027 revokes UPDATE
 *                                  and DELETE from `avo_app` by GRANT, not by
 *                                  trigger, and `psql()` is not `avo_app`. That
 *                                  asymmetry with `ledger_entry` is deliberate
 *                                  and 0027's header states it, which is the only
 *                                  reason the line fixture above is possible at
 *                                  all.
 *   `shop_order.transaction_id`  → `transaction`, restrict. Orders first.
 *   `shop_order.address_id`      → `member_address`, restrict. Orders before
 *                                  addresses, which is the FK that makes the soft
 *                                  delete necessary in the product and necessary
 *                                  here.
 *   `transaction.member_id`      → `member`, restrict. Transactions before members
 *                                  — and this is why erasure is a SCRUB rather
 *                                  than a DELETE in the first place.
 *
 * DELETED BY TRANSACTION ID AND NOT BY MEMBER, for the lines only: after erasure
 * `shop_order_line` has no member column to scope by and never did. The ids are
 * this file's own two.
 *
 * `audit_log` IS LEFT ALONE. `audit_log_no_delete` refuses a DELETE outright and
 * that is the table working; the erasure job's own row accumulates across runs
 * and names nobody, by design (`services/erasure.ts` § THE JOB'S OWN AUDIT ROW).
 */
function dropFixtures(): void {
  const ids = `'${HER}', '${NEIGHBOUR}', '${ERASED}'`;
  psql(`
    DELETE FROM shop_order_line WHERE transaction_id IN ('${HER_ORDER}', '${ERASED_ORDER}');
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
    street: HER_GONE_STREET,
    deleted: true,
  });
  seedAddress(NEIGHBOUR_ADDRESS, NEIGHBOUR, {
    block: NEIGHBOUR_BLOCK,
    street: NEIGHBOUR_STREET,
    instructions: NEIGHBOUR_INSTRUCTIONS,
  });
  /**
   * TWO ADDRESSES FOR THE ERASURE SUBJECT, ONE USED AND ONE SOFT-DELETED, because
   * the two halves of her book fail differently and a job can get one right while
   * getting the other wrong. The used one forces the ordered pair of writes; the
   * soft-deleted one is the row `deleted_at` would hide from a naive scope.
   */
  seedAddress(ERASED_ADDRESS, ERASED, {
    block: 'QAADR-ERASED-BLOCK',
    street: ERASED_STREET,
    instructions: ERASED_INSTRUCTIONS,
  });
  seedAddress(ERASED_DELETED_ADDRESS, ERASED, {
    block: 'QAADR-ERASED-GONE-BLOCK',
    street: ERASED_GONE_STREET,
    deleted: true,
  });

  /**
   * HER order points at the SOFT-DELETED address, which is the interesting pair:
   * the row is gone from her book and the snapshot on the order is not.
   *
   * IT CARRIES A GATE CODE, which the § 4 horizon spec reads. She has asked for
   * nothing, so the scrub never reaches this row — which is the whole point of
   * putting the concern on her rather than on the erased member.
   */
  seedOrder(HER_ORDER, HER, HER_DELETED_ADDRESS, {
    block: 'QAADR-HER-GONE-BLOCK',
    street: HER_GONE_STREET,
    instructions: HER_INSTRUCTIONS,
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
    ).toBe(HER_GONE_STREET);
    expect(
      row!.address!.id,
      'address_id was cleared, so the provenance link to her book is gone',
    ).toBe(HER_DELETED_ADDRESS);
  });
});

// ===========================================================================
// 4. WHAT THE FIX DOES — erasure reaches both copies of where she lives
// ===========================================================================
/**
 * ===========================================================================
 * THE 30-DAY ERASURE PROMISE NOW REACHES A CUSTOMER'S HOME ADDRESS, IN BOTH
 * PLACES IT LIVES — AND THE SHAPE IS SPECIFIC ENOUGH TO BE WORTH PINNING.
 * ===========================================================================
 * THIS SECTION WAS A FINDING AND IS NOW A GUARD. It was two `knownBug()` specs
 * establishing behaviourally that `services/erasure.ts` had never heard of
 * `member_address` or `shop_order`: after the job ran, her address book survived
 * intact and the snapshot survived with it, served to a `perms.shop` holder
 * beside a member row reading "Deleted account". Lane A closed both halves in
 * `1f6bfb3` — migration 0048 and the job's two new writes — so both specs went
 * RED asking to be promoted, which is exactly what `knownBug()` is for. They are
 * plain `it()`s below.
 *
 * WHY THIS ASSERTS THE FIX AND NOT MERELY THE ABSENCE OF THE GAP. "No address
 * columns survive" would pass against a job that deleted the whole order, and
 * against one that deleted the book but left the coordinates on the snapshot, and
 * against one that scoped its delete `AND deleted_at IS NULL`. Three different
 * wrong answers, all of them green. So each spec below names the outcome:
 *
 *   member_address              DELETED WHOLE, soft-deleted rows included.
 *                               `deleted_at` hides an address from her own list;
 *                               it does not stop the street naming a household,
 *                               and the addresses route's own soft delete is what
 *                               makes the wrong scope a plausible mistake.
 *   shop_order.<address cols>   NULLED AND STAMPED — every component, the
 *                               coordinate pair included, plus a new
 *                               `shop_order.address_erased_at`. Stamped, not
 *                               merely blank: the CHECK's erased arm requires the
 *                               stamp, so nulling without it is still refused, and
 *                               the live-delivery arm requires the stamp to be
 *                               ABSENT, so "erased" cannot become a label somebody
 *                               sets while the street is still there.
 *   the order, its lines,       ALL SURVIVE. A money row does not disappear
 *   its transaction, the        because a customer left (non-negotiables #1/#3),
 *   ledger                      and `ledger_entry.transaction_id` is `ON DELETE
 *                               restrict` precisely so nobody can resolve a
 *                               privacy finding by deleting the evidence.
 *   THE ORDER OF THE TWO        FORCED, NOT CHOSEN — and this is the one worth a
 *   WRITES                      spec of its own. See below.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERED PAIR IS THE CASE A NAIVE FIX BREAKS, AND IT BREAKS SILENTLY.
 * ---------------------------------------------------------------------------
 * `shop_order.address_id` references `member_address` with `ON DELETE restrict` —
 * which is why `routes/addresses.ts` soft-deletes rather than deleting — so the
 * book cannot be deleted while an order still points into it. The job therefore
 * nulls the snapshot FIRST and deletes the book SECOND, in one transaction.
 *
 * DECISIONS.md #97 records that trunk's own first reading, "the address book is a
 * plain DELETE", was wrong on exactly this point. And the failure mode is the
 * expensive kind: `runErasureOnce` wraps each member in `try { … } catch { }` and
 * the catch does nothing but `result.failed += 1`. No throw, no log, no name. So a
 * regression here does not crash the job — it quietly stops erasing precisely the
 * members who had ORDERED something, which is to say the ones with the most data,
 * while the run report still looks like a run report.
 *
 * That is why the fixture gives the erasure subject an order pointing INTO her
 * book, and why one spec below asserts the FK's delete rule from the catalogue
 * rather than trusting the comment that describes it. A spec that only checked
 * "the book is empty" against a member who had never ordered would be green on
 * the day this breaks.
 *
 * ---------------------------------------------------------------------------
 * AND THIS IS THE ONLY PLACE IN `pnpm check` WHERE ANY OF IT IS GUARDED.
 * ---------------------------------------------------------------------------
 * Do not delete these as duplicates of lane A's own suite. That suite —
 * `api/src/services/erasureAddress.int.test.ts` — is deeper than this section on
 * the money half and should stay so: it drives a real top-up and a real order
 * through the real handlers and reconciles `ledger_entry` to the fils, which this
 * file cannot do because a seeded ledger row can never be torn down (see
 * `seedOrder`).
 *
 * But it is an `*.int.test.ts`, and `api/vitest.config.ts` EXCLUDES that pattern,
 * so it does not run under `pnpm check`. It is also gated on
 * `AVO_INT_DATABASE_URL`, which `.github/workflows/ci.yml` never sets — CI runs
 * `pnpm check` and `db:verify` and nothing else. So lane A's suite is skipped in
 * the pipeline, `describe.skip` and green, and the specs below are what actually
 * stands between #97 and a regression. Two layers asserting one behaviour is
 * normally rot; two layers where one of them never executes is not.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS ARE STILL OPEN, AND NEITHER IS LANE A'S.
 * ---------------------------------------------------------------------------
 * THE DISCLOSURE. The published policy's § 2 collection notice enumerates what
 * was collected — "your name, phone number, appointment history, transaction and
 * reward history, and basic device data" — and A HOME ADDRESS IS NOT IN THAT LIST.
 * Migration 0048 assumes § 5's "the rest of your account data" covers it, which is
 * the reading under which the old state was a defect at all. Whether § 2 must also
 * disclose the collection is counsel's, and that document is with counsel now.
 * Nothing here is a fix for it and nothing here should be read as one.
 *
 * THE HORIZON. The scrub fires only on ERASURE — a member who asked, 30+ days ago.
 * It sets no retention horizon for the far larger case: a salon's fulfilment board
 * serving a two-day-old CLOSED order's street and gate code for a member who never
 * asked for anything. A salon has a plausible claim there (its own delivery
 * history, a dispute), the policy is silent, and a horizon is CLIENT-OWNED per
 * CLAUDE.md's escalations. `address_erased_at` is the column such a job would set;
 * nothing but erasure sets it today. The last spec in this section pins that
 * exposure on a member the scrub does not reach, so the question stays visible and
 * stays unanswered here.
 */
describe('erasure reaches both copies of where she lives', () => {
  /**
   * ONE JOB RUN SERVES EVERY SPEC AND IS PERFORMED HERE, not in each. It is
   * irreversible for the member it erases, and running it twice would make the
   * later specs' subject a member already erased — which is a different state and
   * would read as a different result.
   *
   * THE JOB IS SHARED WITH EVERY OTHER MEMBER IN THE DATABASE, so nothing below
   * asserts on `candidates` or `erased`. Another file's fixture with a past due
   * date is legitimately erased by the same pass, and a spec that counted would go
   * red for somebody else's reasons. What is asserted is this member's own state,
   * plus `failed`, which is per-member and is the one figure a regression in the
   * ordered pair of writes would move.
   */
  let result: ErasureResult | null = null;

  /**
   * THE PRE-STATE, CAPTURED BEFORE THE JOB RUNS, because after it runs every
   * trace of it is gone — which is the whole outcome under test and also what
   * makes the preconditions below unrecoverable afterwards.
   *
   * `orderPointedAtBook` is the one that matters. The claim the ordering spec
   * makes is "an erasure for a member who HAD ordered something", and after the
   * scrub `shop_order.address_id` is NULL, so the only moment that fact is
   * observable is now.
   */
  const pre = {
    bookRows: 0,
    softDeletedRows: 0,
    orders: 0,
    orderPointedAtBook: false,
    orderLines: 0,
  };

  beforeAll(() => {
    pre.bookRows = count(`select count(*) from member_address where member_id='${ERASED}'`);
    pre.orders = count(`select count(*) from shop_order where member_id='${ERASED}'`);
    pre.softDeletedRows = count(`
      select count(*) from member_address
       where member_id='${ERASED}' and deleted_at is not null
    `);
    pre.orderPointedAtBook =
      scalar(`
        select exists (
          select 1 from shop_order o
            join member_address a ON a.id = o.address_id
           where o.member_id='${ERASED}' and o.fulfilment='delivery'
        )
      `).trim() === 't';
    pre.orderLines = count(
      `select count(*) from shop_order_line where transaction_id='${ERASED_ORDER}'`,
    );

    precondition(
      pre.bookRows === 2 && pre.orders === 1,
      `the erasure subject should have two addresses and one order and has ` +
        `${pre.bookRows} and ${pre.orders}. Both halves matter: two addresses because ` +
        `one is soft-deleted and one is USED, and the spec about the ordered pair of ` +
        `writes needs the used one.`,
    );
    precondition(
      pre.softDeletedRows === 1,
      'the erasure subject has no soft-deleted address, so "soft-deleted rows included" ' +
        'below would assert nothing — a job scoped `AND deleted_at IS NULL` would pass it',
    );
    precondition(
      pre.orderPointedAtBook,
      'the erasure subject\'s order does not point into her address book, so the ordered ' +
        'pair of writes is not exercised and a plain DELETE of the book would pass every ' +
        'spec here. This is the precondition DECISIONS.md #97 is about.',
    );
    precondition(
      pre.orderLines === 1,
      'the erasure subject\'s order has no lines, so "the lines survive" asserts nothing',
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
      `the job did not erase the subject at all, so no spec below is about what it ` +
        `says it is about. The job reported ${JSON.stringify(result)} — a nonzero ` +
        `deferredBalance or deferredEscrow means the fixture has money state the job ` +
        `refuses to decide, which is the job working and a broken fixture; a nonzero ` +
        `failed with this fixture is most likely the ordered pair of writes, which the ` +
        `spec below reports properly.`,
    );
  }, 120_000);

  /**
   * PROMOTED FROM `knownBug()` — lane A closed this in `1f6bfb3` and the helper
   * went red asking for it, which is the promotion path working as designed.
   *
   * THE ASSERTION IS NOT "THE BOOK IS EMPTY". It is "the book is empty INCLUDING
   * the row `deleted_at` hides", and the two are different claims because the
   * plausible wrong fix is a specific one: `routes/addresses.ts` scopes every read
   * and write `AND deleted_at IS NULL`, correctly, because a soft-deleted address
   * must stay resolvable from a past order. Copying that clause into the erasure
   * job would look consistent, would pass a spec that counted live rows, and would
   * leave a block, a street, a building and a coordinate pair on disk for ever.
   *
   * `deleted_at` IS A UI FACT. It hides an address from her own list. It does not
   * make the street stop naming a household, and a household is what the whole
   * finding was about.
   */
  it('her address book is deleted WHOLE — soft-deleted rows included', () => {
    precondition(
      scalar(`select name from member where id='${ERASED}'`).trim() === 'Deleted account',
      'the member is not a tombstone, so the scrub did not run on her',
    );

    /**
     * THE SOFT-DELETED ROW BY ID, AND IT IS ASSERTED **FIRST** ON PURPOSE. A total
     * would fail on this row too, so putting the total first would make this
     * assertion unreachable and its message — the one that names the actual
     * mistake — dead code. Vitest stops a spec at its first failure, so the order
     * of two assertions that overlap decides which diagnosis a reader gets.
     */
    expect(
      count(`select count(*) from member_address where id='${ERASED_DELETED_ADDRESS}'`),
      'THE SOFT-DELETED ADDRESS SURVIVED THE ERASURE. This is the signature of a job ' +
        'scoped `AND deleted_at IS NULL` — the clause `routes/addresses.ts` is right to ' +
        'carry, because a soft-deleted address must stay resolvable from a past order, ' +
        'and the erasure job must not. `deleted_at` hides an address from her own list; ' +
        'the street still names a household, and this row still carries a block, a ' +
        'building and a coordinate pair. Check the total below too: if it is 1, the live ' +
        'rows went and only the hidden one stayed, which is that exact mistake.',
    ).toBe(0);

    expect(
      count(`select count(*) from member_address where member_id='${ERASED}'`),
      `HER SAVED ADDRESS BOOK SURVIVED THE ERASURE. It had ${pre.bookRows} rows before ` +
        'the job ran and should have none after: nothing but her own orders references ' +
        'these rows, an address is not a financial record, and the seven-year books ' +
        'argument that keeps `transaction` and `ledger_entry` does not reach it. ' +
        'DECISIONS.md #97, migration 0048.',
    ).toBe(0);

    /**
     * AND NO SENTINEL SURVIVES ANYWHERE IN THE TABLE, scoped by string rather than
     * by member id — because the two assertions above are both scoped by a column
     * the fix itself rewrites nothing in, and a fix that reparented a row instead of
     * deleting it would satisfy both. The sentinels are unique to this file
     * (`seedAddress` writes them and nothing else does), so a nonzero count here is
     * a row that still exists under some other owner.
     */
    expect(
      count(`
        select count(*) from member_address
         where street IN ('${ERASED_STREET}', '${ERASED_GONE_STREET}')
      `),
      'one of the erased member\'s street sentinels is still in `member_address` under ' +
        'a different member_id — the row was moved rather than deleted',
    ).toBe(0);
  });

  /**
   * PROMOTED FROM `knownBug()`, same merge, and this is the half that needed a
   * migration rather than a line of SQL.
   *
   * EVERY COMPONENT, ENUMERATED, AND THE COORDINATE PAIR BY NAME. The old
   * knownBug checked eight columns; the erased arm of
   * `shop_order_delivery_has_an_address` names twelve, enumerated one-for-one below
   * so the two lists cannot drift, and the ones it did not check are the sharp ones. `area` and `governorate` are
   * coarser than a street but they still narrow. `latitude`/`longitude` are worse
   * than the street they sit beside: A COORDINATE PAIR WITH THE STREET REMOVED
   * STILL LOCATES THE ADDRESS EXACTLY, to about 0.1m at this latitude. "The street
   * is gone" and "the address is gone" are not the same claim, so this asserts the
   * second one.
   *
   * AND THE STAMP, WHICH IS THE PART THAT MAKES THE STATE REPRESENTABLE RATHER
   * THAN MERELY PERMITTED. Migration 0048 did not relax
   * `shop_order_delivery_has_an_address`; it added a third arm requiring
   * `address_erased_at IS NOT NULL` alongside all-null columns, and added
   * `address_erased_at IS NULL` to the live-delivery arm. So the CHECK still
   * refuses a delivery order whose snapshot `services/order.ts` simply forgot to
   * copy — the invariant survives the fix — and a row cannot carry a street AND an
   * erasure stamp, so "erased" cannot become a label somebody sets while the data
   * is still there. Both directions are asserted below.
   */
  it('the snapshot is nulled and STAMPED, and the order, its lines and its money survive', () => {
    precondition(
      count(`select count(*) from shop_order where member_id='${ERASED}'`) === 1,
      'the order row is gone entirely, which is a DIFFERENT outcome than this asserts ' +
        'and a worse one: the order hangs off a settled transaction that a salon\'s books ' +
        'keep for seven years, and deleting it is how a privacy finding gets resolved by ' +
        'destroying money evidence',
    );

    /**
     * ALL THIRTEEN, IN ONE COUNT WITH A NAMED FAILURE. A per-column loop would
     * report the first survivor and stop; this reports which ones survived, which is
     * the useful thing when the answer is "the coordinates".
     */
    const survivors = scalar(`
      select coalesce(string_agg(c, ', ' ORDER BY c), '') FROM (
        select 'address_id' AS c FROM shop_order
         WHERE member_id='${ERASED}' AND address_id IS NOT NULL
        UNION ALL select 'address_label' FROM shop_order
         WHERE member_id='${ERASED}' AND address_label IS NOT NULL
        UNION ALL select 'block' FROM shop_order
         WHERE member_id='${ERASED}' AND block IS NOT NULL
        UNION ALL select 'street' FROM shop_order
         WHERE member_id='${ERASED}' AND street IS NOT NULL
        UNION ALL select 'building' FROM shop_order
         WHERE member_id='${ERASED}' AND building IS NOT NULL
        UNION ALL select 'floor' FROM shop_order
         WHERE member_id='${ERASED}' AND floor IS NOT NULL
        UNION ALL select 'apartment' FROM shop_order
         WHERE member_id='${ERASED}' AND apartment IS NOT NULL
        UNION ALL select 'area' FROM shop_order
         WHERE member_id='${ERASED}' AND area IS NOT NULL
        UNION ALL select 'governorate' FROM shop_order
         WHERE member_id='${ERASED}' AND governorate IS NOT NULL
        UNION ALL select 'instructions' FROM shop_order
         WHERE member_id='${ERASED}' AND instructions IS NOT NULL
        UNION ALL select 'latitude' FROM shop_order
         WHERE member_id='${ERASED}' AND latitude IS NOT NULL
        UNION ALL select 'longitude' FROM shop_order
         WHERE member_id='${ERASED}' AND longitude IS NOT NULL
      ) s
    `).trim();

    expect(
      survivors,
      'A COMPONENT OF HER HOME ADDRESS SURVIVED ON THE ORDER SNAPSHOT, AND THIS IS THE ' +
        'COPY A SALON READS — served by `GET /v1/salons/{id}/orders` behind `perms.shop`, ' +
        'beside a member row now reading "Deleted account". A PARTIAL SCRUB IS THE ' +
        'OUTCOME MIGRATION 0048 REFUSED TO LEAVE AVAILABLE: if the columns named above ' +
        'are `latitude, longitude`, note that a coordinate pair locates the address ' +
        'exactly on its own, so the street being gone bought nothing.',
    ).toBe('');

    /**
     * THE STAMP. Not merely blank — the CHECK's erased arm requires it, so a job
     * that nulled without stamping could not have committed at all; asserting it is
     * how this spec distinguishes "the fix ran" from "somebody dropped the
     * constraint and nulled the columns".
     */
    expect(
      scalar(`
        select address_erased_at is not null from shop_order where member_id='${ERASED}'
      `).trim(),
      '`address_erased_at` IS NOT SET. If the columns are null and the stamp is not, the ' +
        'CHECK constraint that should have refused that row is gone — check whether ' +
        '`shop_order_delivery_has_an_address` still has its three arms, because the ' +
        'alternative migration 0048 rejected was to RELAX the constraint, and a relaxed ' +
        'one lets `services/order.ts` commit a live delivery whose snapshot it forgot.',
    ).toBe('t');

    /** The fulfilment kind does NOT change. A scrubbed delivery is not a pickup. */
    expect(
      scalar(`select fulfilment from shop_order where member_id='${ERASED}'`).trim(),
      'the order was turned into a `pickup` to satisfy the CHECK — that rewrites what ' +
        'happened rather than erasing who it happened to, and the pickup arm requires ' +
        '`address_erased_at IS NULL`, so the stamp would be gone with it',
    ).toBe('delivery');

    /**
     * THE MONEY, WHICH IS THE OTHER HALF OF EVERY ASSERTION IN THIS SECTION. The
     * order, its status, its transaction and its lines. `shop_order_line` has UPDATE
     * and DELETE revoked from `avo_app` exactly as `ledger_entry` does, so a scrub
     * reaching it would be reaching into append-only purchase evidence.
     */
    expect(
      scalar(`select status from shop_order where member_id='${ERASED}'`).trim(),
      'the order status moved, so something other than the address was rewritten',
    ).toBe('preparing');
    expect(
      scalar(`
        select kind || '/' || status || '/' || amount_fils
          from transaction where id='${ERASED_ORDER}'
      `).trim(),
      'the settled shop transaction under her order changed or is gone — non-negotiable ' +
        '#1: a deleted member\'s charges still happened and commission was still owed',
    ).toBe(`shop/settled/${-ORDER_PRICE_FILS}`);
    expect(
      count(`
        select count(*) from shop_order_line
         where transaction_id='${ERASED_ORDER}' and line_total_fils=${ORDER_PRICE_FILS}
      `),
      'the order LINE is gone or was re-itemised. It is append-only purchase evidence ' +
        '(migration 0027) and holds a product name, a quantity and a price — no address, ' +
        'so the scrub has no business there',
    ).toBe(pre.orderLines);

    /**
     * AND THE LEDGER, STRUCTURALLY. This file cannot seed `ledger_entry` rows —
     * append-only by TRIGGER, so a fixture row could never be torn down and this
     * file's teardown is what keeps two other suites honest (see `seedOrder`). So
     * the claim is made about the mechanism instead, which is a statement about
     * every transaction rather than about one fixture pair: `avo_app` — the role the
     * job runs as — holds no UPDATE and no DELETE on the table, and a trigger
     * refuses both for every role including the owner.
     *
     * Lane A's `services/erasureAddress.int.test.ts` asserts the behavioural half,
     * reconciling count and sum to the fils on a member whose money moved through
     * the real handlers. That suite does not run under `pnpm check` (see this
     * section's header), which is why the structural claim is here rather than
     * assumed.
     */
    expect(
      scalar(`
        select coalesce(string_agg(privilege_type, ',' ORDER BY privilege_type), '')
          from information_schema.role_table_grants
         where table_name = 'ledger_entry' and grantee = 'avo_app'
           and privilege_type IN ('UPDATE','DELETE')
      `).trim(),
      'THE ERASURE ROLE CAN NOW WRITE OVER THE MONEY LEDGER. `avo_app` held only SELECT ' +
        'and INSERT on `ledger_entry` (migration 0001) and that grant is what makes ' +
        '"erasure cannot reach the money" true by construction rather than by the job ' +
        'choosing not to.',
    ).toBe('');
    expect(
      count(`
        select count(*) from pg_trigger t
          join pg_class c ON c.oid = t.tgrelid
         where c.relname = 'ledger_entry' and t.tgname = 'ledger_entry_is_immutable'
           and NOT t.tgisinternal
      `),
      '`ledger_entry_is_immutable` is gone. It is the trigger that refuses UPDATE and ' +
        'DELETE on the money ledger for EVERY role — the reason `shop_order` could be ' +
        'admitted an erased state and `ledger_entry` could not. Migration 0048\'s whole ' +
        'argument for resolving differently from decision 12 rests on this asymmetry.',
    ).toBe(1);
  });

  /**
   * ===========================================================================
   * THE TWO WRITES ARE ORDERED BY FORCE, NOT BY CHOICE — AND A REGRESSION HERE
   * IS SILENT.
   * ===========================================================================
   * THE CASE A NAIVE FIX BREAKS IS AN ERASURE FOR A MEMBER WHO HAD ORDERED
   * SOMETHING, and it is worth its own spec because every other spec in this
   * section would stay green while it broke.
   *
   * `shop_order.address_id` references `member_address` with `ON DELETE restrict`,
   * so the book cannot be deleted while an order points into it. DECISIONS.md #97
   * records trunk's own first reading — "the address book looks like a plain
   * DELETE, in the same list as `wallet_token`" — as wrong on exactly this point.
   * A plain DELETE succeeds for every member who never ordered anything and fails
   * for every member who did.
   *
   * AND IT FAILS INTO A COUNTER. `runErasureOnce` wraps each member in
   * `try { … } catch { result.failed += 1; }` — no rethrow, no log line, no member
   * id. So the regression does not look like a crash. It looks like a job that
   * ran, and quietly stopped erasing the members with the most data on file, and
   * kept saying so once per run in a number nobody reads. Deferred states are
   * broken out (`deferredBalance`, `deferredEscrow`, `deferredPendingTopup`) and
   * are the job REFUSING to decide, on an argument; `failed` is the job not
   * knowing what happened.
   *
   * THREE THINGS ARE ASSERTED AND NONE OF THEM ALONE IS THE CLAIM: that the FK is
   * still `restrict` (read from the catalogue, not from the comment that describes
   * it), that this member's order genuinely pointed into her book before the job
   * ran, and that `failed` is zero. The first says the ordering is still forced;
   * the second says the forced case was exercised; the third says it succeeded.
   */
  it('an erasure for a member who HAD ordered something does not fail silently', () => {
    /**
     * THE FK'S DELETE RULE, FROM `pg_constraint`. `confdeltype` is 'r' for
     * RESTRICT, 'a' for NO ACTION, 'c' for CASCADE, 'n' for SET NULL.
     *
     * READ FROM THE CATALOGUE RATHER THAN TRUSTED, because the whole reason the
     * ordering is forced is this one letter, and it is currently asserted by four
     * prose comments and nothing else. A migration that changed it to CASCADE would
     * make the job's careful ordering unnecessary and its comments wrong, and would
     * ALSO silently make `DELETE /members/me/addresses/:id` destroy the snapshot on
     * a past order — the exact thing § 3 of this file proves it does not do.
     */
    const rule = scalar(`
      select c.confdeltype from pg_constraint c
        join pg_class src ON src.oid = c.conrelid
        join pg_class tgt ON tgt.oid = c.confrelid
       where c.contype = 'f' and src.relname = 'shop_order' and tgt.relname = 'member_address'
    `).trim();
    expect(
      rule,
      `shop_order.address_id -> member_address is no longer ON DELETE restrict ` +
        `(pg_constraint.confdeltype = "${rule}"; r=restrict, a=no action, c=cascade, ` +
        `n=set null).\n\n` +
        'IF IT IS NOW CASCADE, two things silently changed and neither is in a test that ' +
        'names it: the erasure job\'s snapshot-first ordering became unnecessary (its ' +
        'header and migration 0048 both explain it at length and would now be wrong), and ' +
        '`DELETE /members/me/addresses/:id` — a soft delete precisely BECAUSE of this ' +
        'restrict — would take a past order\'s destination with it if it were ever ' +
        'changed to a hard delete. IF IT IS NOW SET NULL, the snapshot loses its ' +
        'provenance link without the erasure stamp, which no arm of ' +
        '`shop_order_delivery_has_an_address` permits.',
    ).toBe('r');

    precondition(
      pre.orderPointedAtBook,
      'captured before the job ran: her order did not point into her book, so this spec ' +
        'is not exercising the ordered pair at all',
    );

    expect(
      result?.failed,
      `THE ERASURE JOB REPORTED A FAILURE, and with this fixture the ordered pair of ` +
        `writes is the first thing to check. The job reported ` +
        `${JSON.stringify(result)}.\n\n` +
        'A `member_address` DELETE attempted BEFORE the snapshot null-out raises a ' +
        'foreign key violation on `shop_order_address_id_member_address_id_fk`, the whole ' +
        'per-member transaction rolls back, and `runErasureOnce`\'s bare `catch` turns ' +
        'that into `failed += 1` with no message anywhere. Which means: this member is ' +
        'still un-erased, she will be retried and fail identically every run for ever, ' +
        'and the only visible symptom is this integer. Read the job\'s stderr for the ' +
        'constraint name; a `deferred*` count instead would be the job working.',
    ).toBe(0);

    /**
     * AND THE COMPLETED STATE, which is the positive form of the same claim: the
     * transaction is per-member and all-or-nothing, so a tombstoned member row is
     * proof that BOTH address writes committed. A run that failed on the book delete
     * would have rolled the name back with it.
     */
    expect(
      scalar(`
        select (erased_at is not null)::text || '/' || name
          from member where id='${ERASED}'
      `).trim(),
      'the member is not a tombstone even though `failed` is 0, which means she was ' +
        'skipped rather than erased — check `deletion_due_at` and the re-check inside ' +
        'the FOR UPDATE',
    ).toBe('true/Deleted account');
  });

  /**
   * ===========================================================================
   * AND THE JOB'S OWN CENSUS NAMES BOTH TABLES — because the count in the prose
   * that used to be here was wrong twice, and a number nothing checks is the
   * defect DECISIONS.md row 26 is about.
   * ===========================================================================
   * THIS SECTION'S HEADER CALLED `services/erasure.ts`'s table-by-table header a
   * "twelve-table header", in two places. It was 13 rows when that was written and
   * is 15 now (14 sibling tables plus `member` itself); DECISIONS.md #97 carried
   * the same wrong figure and trunk has corrected it there. Row 26's ruling is
   * STOP COUNTING: "a number in this row is the same defect the row is about."
   *
   * So the prose no longer states a count anywhere, and this spec asserts the part
   * that actually matters instead. The failure that produced #97 was not a wrong
   * number — it was `member_address` and `shop_order` being ABSENT from that
   * census, in the way a table nobody has thought about is absent, which is
   * different from `booking` and `loyalty_event` being absent from the DELETE list
   * on a written argument. This is the assertion that goes red if either table
   * ever falls back out of it.
   *
   * WHAT THIS CAN AND CANNOT SAY, stated plainly because asserting on a comment is
   * weak and pretending otherwise is worse. It CANNOT say the job does the right
   * thing — the specs above do that, behaviourally, and they are the real guard.
   * What it CAN say is that the job's own record of its decisions still accounts
   * for the two tables holding a street, which is the standard the rest of that
   * file meets and the standard item 7 slipped past. A future table with personal
   * data in it will slip past the same way, and the honest version of this guard is
   * derived from the schema rather than from a list — which is trunk's to scope,
   * not something to invent here.
   */
  it('`services/erasure.ts` still accounts for member_address and shop_order by name', () => {
    const source = readFileSync(join(repoRoot, 'api', 'src', 'services', 'erasure.ts'), 'utf8');

    /**
     * THE CENSUS IS THE LEADING DOCBLOCK'S TABLE, and it is parsed rather than
     * grepped so a mention anywhere else in the file cannot satisfy this. Each row
     * is ` *   <table_name><padding><Decision…>`; the decision text is what makes a
     * row a decision rather than a passing reference.
     */
    const docblockEnd = source.indexOf('*/');
    precondition(
      docblockEnd > 0,
      'services/erasure.ts has no leading docblock, so its census cannot be read. The ' +
        'file was restructured; re-derive this spec or delete it, but do not leave it ' +
        'parsing nothing and reporting green.',
    );
    const census = [
      ...source
        .slice(0, docblockEnd)
        .matchAll(/^ \* {3}([a-z_]+) {2,}(?=\S)/gm),
    ].map((m) => m[1]);

    precondition(
      census.length >= 10,
      `only ${census.length} census rows parsed out of services/erasure.ts — the header's ` +
        `format changed and this spec is no longer reading what it thinks it is. Rows ` +
        `found: ${JSON.stringify(census)}`,
    );

    for (const table of ['member_address', 'shop_order']) {
      expect(
        census,
        `\`${table}\` IS NO LONGER IN THE ERASURE JOB'S TABLE-BY-TABLE HEADER. That header ` +
          `is where every decision about what the scrub reaches is written down, and the ` +
          `absence of these two tables from it IS decision #97 — item 7 landed the first ` +
          `personal data in this product with a street in it and nothing brought the job ` +
          `forward. The census currently names ${census.length} tables: ` +
          `${census.join(', ')}.\n\n` +
          `If the row was removed because the behaviour changed, the specs above will be ` +
          `red too and those are the ones to read. If the row was removed and the ` +
          `behaviour did not change, put it back: a scrub whose reasoning is not written ` +
          `down is how this happened the first time.`,
      ).toContain(table);
    }
  });

  /**
   * THE REST OF THE SCRUB, ASSERTED SO A FAILURE ABOVE CAN BE LOCALISED. When it
   * was written this existed to stop the two `knownBug`s being read as "the job
   * does not work"; it now does the opposite job and is worth keeping for it. If
   * the address specs go red and this one is green, the address writes are the
   * regression. If both go red, the job did not run on her at all and every
   * message above is misleading.
   *
   * `failed` MOVED to the ordering spec, which is the one that can explain it.
   */
  it('the rest of the scrub still ran — a failure above is about the address, not the job', () => {
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
  });

  /**
   * ===========================================================================
   * AND THE READ PATH — TWO CLOSED ORDERS ON ONE BOARD, WHICH IS WHERE BOTH THE
   * FIX AND THE OPEN QUESTION ARE VISIBLE AT ONCE.
   * ===========================================================================
   * THIS SPEC USED TO ASSERT `row.address` WAS NOT NULL, AND IT RAN AGAINST THE
   * ERASED MEMBER'S ORDER. Its own header predicted it would keep passing "for the
   * orders of members who have NOT asked to be erased" — correctly — but it read
   * the one order the scrub does reach, so `1f6bfb3` turned it red. The concern it
   * was written to flag is untouched by that; only its subject was wrong.
   *
   * SO IT NOW READS BOTH ROWS FROM ONE BOARD RESPONSE, and the contrast is the
   * assertion:
   *
   *   the ERASED member's order   `address: null`. The read-path half of #97, and
   *                               a state that cannot arise any other way — a LIVE
   *                               delivery is CHECKed to carry block, street and
   *                               building. Also the reason `contract.test.ts`
   *                               stayed green through the fix: the serialiser
   *                               returns `address: null` rather than an object
   *                               with null fields, so `ShopOrderSchema` never sees
   *                               an address whose `id` is missing.
   *   HER order                   THE FULL SNAPSHOT — street and gate code — on a
   *                               CLOSED order, two days old, for a member who has
   *                               asked for nothing and is not a candidate for
   *                               erasure. No expiry, on any surface.
   *
   * THE SECOND ROW IS THE HORIZON QUESTION AND IT IS NOT ANSWERED HERE.
   * REPORTED, NOT REFUSED: there is nothing wrong with a merchant reading her own
   * salon's fulfilment history, and `perms.shop` is the right gate for it (see
   * `permission-census.test.ts`'s note). A permission decides WHO. Nothing in this
   * feature decides FOR HOW LONG, the published policy is silent on it, and a
   * retention horizon is CLIENT-OWNED per CLAUDE.md's escalations.
   *
   * WHAT WOULD MAKE THIS SPEC RED IS A HORIZON BEING BUILT, which is the outcome
   * it exists to notice rather than to prevent. `address_erased_at` is the column
   * such a job would set, and today nothing but erasure sets it — so if this goes
   * red, read the failure as "the decision was taken" and rewrite the spec to
   * assert the rule that was chosen. Do NOT relax it to `.toBeDefined()`; a
   * silently-loosened assertion here is how the exposure stops being visible
   * without anyone deciding it should.
   */
  it('the board serves the erased order without an address and a live member\'s closed order in full', async () => {
    /**
     * BOTH ORDERS CLOSED AND AGED, in one statement, so the two rows differ in
     * exactly one respect: whether their member asked to be erased.
     */
    psql(`
      UPDATE shop_order
         SET status = 'closed', ready_at = now() - interval '2 days',
             closed_at = now() - interval '2 days'
       WHERE transaction_id IN ('${ERASED_ORDER}', '${HER_ORDER}');
    `);

    const merchant = await treq<{
      items: Array<{
        transactionId: string;
        memberName: string;
        fulfilment: string;
        address: null | { street: string | null; instructions: string | null };
      }>;
      truncated: boolean;
      nextCursor: string | null;
    }>('GET', `/v1/salons/${SALON_A}/orders?status=closed`, {
      token: await merchantToken(),
    });
    expect(merchant.status, `answered ${merchant.status}: ${merchant.raw}`).toBe(200);

    const erasedRow = merchant.body.items.find((o) => o.transactionId === ERASED_ORDER);
    const herRow = merchant.body.items.find((o) => o.transactionId === HER_ORDER);
    precondition(
      erasedRow !== undefined && herRow !== undefined,
      'one of the two closed orders is not on the board, so the contrast this spec is ' +
        'about cannot be read. Check `truncated` — the board has no cursor (see § 5).',
    );

    // ---- the erased member's order: the fix, as a merchant sees it ----
    expect(
      erasedRow!.address,
      'THE ERASED MEMBER\'S HOME ADDRESS IS STILL ON THE MERCHANT BOARD. This is the ' +
        'read path for #97 and the copy that actually mattered: the member row is a ' +
        'tombstone — name "Deleted account", a synthetic +990 phone — and the board ' +
        'renders exactly where she lives beside it. De-identifying the name and keeping ' +
        'the address is the worst of the two available outcomes, because it removes the ' +
        'accountability and keeps the exposure.',
    ).toBeNull();
    expect(
      erasedRow!.fulfilment,
      'the erased order is served as a pickup, which rewrites what happened. It WAS a ' +
        'delivery; `fulfilment: \'delivery\'` with `address: null` is the state the fix ' +
        'creates and a merchant should see it as such',
    ).toBe('delivery');
    expect(
      erasedRow!.memberName,
      'the board no longer names the tombstone — a different change from this one',
    ).toBe('Deleted account');
    /**
     * NO COMPONENT ANYWHERE IN THE RAW RESPONSE, which the typed read above cannot
     * say. `address: null` is a claim about one key; the sentinels are unique to
     * this file, so their absence from the whole body is a claim about every key,
     * including ones no schema declares. Same argument as `expectNoSalonALeak`.
     */
    for (const sentinel of [ERASED_STREET, ERASED_INSTRUCTIONS, ERASED_GONE_STREET]) {
      expect(
        merchant.raw.includes(sentinel),
        `the board response still contains "${sentinel}" somewhere — the typed ` +
          '`address` key is null but a component of her address is being served under ' +
          'another key',
      ).toBe(false);
    }

    // ---- her order: the horizon, which nothing has decided ----
    expect(
      herRow!.address,
      'A LIVE MEMBER\'S SNAPSHOT IS GONE FROM THE BOARD. If a retention horizon was ' +
        'built, this spec is now asserting the wrong thing — read this file\'s § 4 ' +
        'header and rewrite it to assert whatever rule was chosen. If no horizon was ' +
        'built, the address has been scrubbed from a member who never asked, which is a ' +
        'defect: a salon cannot answer a dispute about an order it can no longer locate.',
    ).not.toBeNull();
    expect(
      herRow!.address!.street,
      'the street she typed is no longer on her own closed order',
    ).toBe(HER_GONE_STREET);
    expect(
      herRow!.address!.instructions,
      'the free-text delivery instruction — a gate code, a "ring twice" — is served too, ' +
        'two days after the order closed, with no expiry',
    ).toBe(HER_INSTRUCTIONS);

    /**
     * AND THE STAMP IS WHAT SEPARATES THEM, asserted in the database rather than
     * inferred from the two responses — because the honest statement of the open
     * question is precisely "this column is set by exactly one thing".
     *
     * If a retention job is ever built, `address_erased_at` is the column it would
     * set, and this count is what would change first.
     */
    expect(
      count(`
        select count(*) from shop_order
         where address_erased_at is not null and transaction_id='${HER_ORDER}'
      `),
      'HER order carries an `address_erased_at` stamp and she never asked to be erased. ' +
        'Today the only writer of that column is `services/erasure.ts`, so either a ' +
        'retention horizon now exists — in which case this file\'s § 4 header is stale ' +
        'and the client decision it describes as open has been taken — or something else ' +
        'has learned to stamp it.',
    ).toBe(0);
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
   * ---------------------------------------------------------------------------
   * THE INVARIANT WAS STATED ONE CONDITION TOO BROADLY, AND #97 IS WHAT FOUND IT.
   * ---------------------------------------------------------------------------
   * This counted `fulfilment='delivery' AND address_id IS NULL` and expected zero.
   * After `1f6bfb3` the count is 1 and correctly so: erasure nulls the provenance
   * link along with the snapshot, because the FK is `ON DELETE restrict` and the
   * book cannot be deleted while an order points into it. The condition is now
   * `AND address_erased_at IS NULL` — a LIVE delivery has a real `address_id`, and
   * an erased one has none by construction.
   *
   * TWO SENTENCES IN THE OLD VERSION OF THIS BLOCK WERE FALSE AND ARE WORTH
   * NAMING, because both were the confident kind:
   *
   *   "THE ONLY WRITER THAT CAN PRODUCE `address_id IS NULL` ON A DELIVERY IS
   *   DIRECT SQL." It was true when written. `services/erasure.ts` is now a second
   *   writer, and a deliberate one — migration 0048's third CHECK arm exists
   *   precisely to make that row storable.
   *
   *   "THIS ROW CANNOT BE SERIALISED TO ANY CLIENT — `contract.test.ts`'s probes on
   *   both order reads will fail on it." FALSE FOR AN ERASED ROW SPECIFICALLY, and
   *   the reason matters more than the correction: the serialiser returns
   *   `address: null` rather than building an object with a null `id`, so
   *   `ShopOrderSchema` never sees the shape the claim was about. That is why
   *   `contract.test.ts` stayed green straight through the fix, and it is also the
   *   read-path behaviour § 4's board spec now pins. The claim survives for the
   *   state this spec still checks — a row with a live snapshot and no provenance
   *   link — because there the serialiser DOES build an address object.
   *
   * IT IS STILL WORTH A SPEC, for the two reasons that have nothing to do with the
   * state being reachable. First, it already cost something: `tenancy.test.ts`'s
   * order fixture seeded `address_id` NULL — legal, and its own specs passed — and
   * that row would have failed `contract.test.ts`'s board probe, in a third file,
   * for a state the product cannot reach. That note is now on `PROBE_ORDER_A`.
   * Second, the honest fix is a decision rather than a patch — and 0048 removed one
   * of the two options that used to be available. The column can no longer become
   * NOT NULL, for deliveries or otherwise: the erased arm of
   * `shop_order_delivery_has_an_address` REQUIRES `address_id IS NULL`, so a NOT
   * NULL column would make an erased order unstorable and #97 unfixable. What is
   * left is trunk's half: `ShopOrderSchema.address.id` becomes nullable and every
   * client learns to render an order whose address has no provenance — or the
   * schema keeps refusing a shape the serialiser never emits, which is the status
   * quo and is defensible as long as it is deliberate.
   */
  it('a LIVE delivery has a real address_id — erased orders are the one exception', () => {
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
       * NOT A SELF-RETIRING BRANCH ANY MORE — A CONTRADICTION. This used to be the
       * "gap closed, good" branch. It cannot be that now: migration 0048's erased arm
       * requires `address_id IS NULL`, so a NOT NULL column and that CHECK cannot both
       * exist, and reaching here means one of them was dropped.
       */
      expect(
        nullableColumn,
        '`shop_order.address_id` IS NOW NOT NULL, WHICH CONTRADICTS MIGRATION 0048. Its ' +
          'erased arm of `shop_order_delivery_has_an_address` requires `address_id IS ' +
          'NULL`, so either that constraint was dropped — and § 4\'s specs should be red ' +
          'too — or a migration made the column NOT NULL and no erasure can ever commit ' +
          'again for a member who ordered something. Either way this is not the gap ' +
          'closing; do not delete this spec on the strength of it.',
      ).toBe('YES');
      return;
    }

    /**
     * The column is nullable, so the claim to check is the NARROW one: every LIVE
     * delivery order in this database has a real `address_id`. That is the property
     * the product actually depends on, and it is the one a future writer — a bulk
     * import, an admin tool, a migration backfill — would break.
     *
     * `address_erased_at IS NULL` IS WHAT MAKES IT AN INVARIANT RATHER THAN A COUNT.
     * Without it the assertion goes red every time this file's own § 4 runs, which is
     * how it read after `1f6bfb3`.
     */
    expect(
      count(`
        select count(*) from shop_order
         where fulfilment = 'delivery'
           and address_erased_at is null
           and address_id is null
      `),
      'A LIVE DELIVERY ORDER HAS NO address_id. The column allows it and ' +
        '`ShopOrderSchema.address.id` (IdSchema, z.string().min(1)) does NOT, and for a ' +
        'row in THIS state the serialiser does build an address object — so it cannot be ' +
        'serialised and `contract.test.ts`\'s probes on both order reads will fail on it. ' +
        '(An ERASED row is excluded above and is a different matter: the serialiser ' +
        'returns `address: null` for it and never builds an object with a null `id`, which ' +
        'is why that state is safe and why it needs excluding here.)\n\n' +
        'If a TEST fixture wrote it, point its `address_id` at a real `member_address` row; ' +
        '`tenancy.test.ts`\'s PROBE_ORDER_A carries the same note for the same reason. If an ' +
        'API path wrote it, that is a defect in lane A\'s column and the finding is that ' +
        '`services/order.ts` § 5b can now leave the provenance link empty on a delivery. ' +
        'If `services/erasure.ts` wrote it WITHOUT stamping `address_erased_at`, the CHECK ' +
        'that should have refused that row is gone — see § 4.',
    ).toBe(0);
  });
});
