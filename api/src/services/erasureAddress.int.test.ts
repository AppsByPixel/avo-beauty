/**
 * ERASURE REACHES THE ADDRESS — proved against a real database, through the real
 * endpoints, and read back in SQL.        (DECISIONS.md #97, migration 0048)
 *
 * `vitest.int.config.ts` carries why this suite is separate and why it is not in
 * `pnpm check`. `topupReaper.int.test.ts` carries the house rules it follows:
 * real handlers rather than hand-forged fixtures, and the `AVO_INT_DATABASE_URL`
 * skip rather than a fallback to whatever URL happens to be exported.
 *
 * ======================================================================
 * THE CLAIM WORTH HAVING: THE HOUSEHOLD IS GONE AND THE MONEY IS NOT
 * ======================================================================
 * Erasure had never heard of `member_address` or `shop_order`, so after the job
 * ran her address book survived intact and the snapshot survived with it — served
 * to a `perms.shop` holder beside a member row reading "Deleted account". That is
 * the worst of the two available outcomes: the record still locates a person and
 * no longer says who.
 *
 * So every spec below asserts BOTH halves at once, because either one alone is a
 * different bug:
 *
 *   member_address              no rows, soft-deleted ones included
 *   shop_order address columns  every one NULL, coordinates included
 *   shop_order.address_erased_at  set — the state is stamped, not merely blank
 *   shop_order                  STILL THERE, same status
 *   transaction + lines         STILL THERE, settled, same amount
 *   ledger_entry                count and sum unchanged, to the fils
 *
 * THE COORDINATE PAIR IS ASSERTED SEPARATELY AND BY NAME. `latitude`/`longitude`
 * are text on both copies and a pair with the street removed still locates the
 * address exactly — about 0.1m at this latitude — so "the street is gone" is not
 * the same claim as "the address is gone".
 *
 * ======================================================================
 * A FRESH MEMBER PER RUN, AND WHY IT IS NOT OPTIONAL HERE
 * ======================================================================
 * Erasure is the one irreversible act in this codebase. A suite that erased a
 * SEEDED member would work once and then hand every later run — and every other
 * int suite sharing the lane database — a tombstone where its fixture used to be.
 * `topupReaper` gets to reuse 8842 because reaping is reversible in effect; this
 * cannot.
 *
 * AND HER MONEY ARRIVES AND LEAVES THROUGH THE REAL PATHS, which is a constraint
 * rather than a flourish. `member.balance_fils` is a cached aggregate and
 * `verify-constraints.sql` invariant 5 reconciles every member against her
 * `member_wallet` ledger entries — so a fixture that SET a balance would leave
 * this lane's `db:verify` permanently red, in the file whose whole job is to
 * notice that. She is created at zero, credited by a real settled top-up, and
 * spent back to zero by a real order. Which is also what makes the job's own
 * `balance_fils > 0` precondition a genuine pass rather than an arrangement.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const INT_URL = process.env.AVO_INT_DATABASE_URL;
const suite = INT_URL ? describe : describe.skip;

const SALON = 'SAL-AMARA';
/** Seeded, 8500 fils. Read back from the row rather than trusted, below. */
const PRODUCT = 'PR-01';
/** Seeded manager, and the board is gated on `perms.shop`. */
const MANAGER = 'ST-001';

/**
 * DISTINCTIVE ON PURPOSE, AND THE FIRST DRAFT WAS NOT. The whole-row scan at the
 * bottom of this file greps a serialised `shop_order` for each of these, and a
 * realistic `block` of `'4'` matched a digit inside a timestamp — a FAILURE
 * REPORTING A LEAK THAT WAS NOT THERE, which is the worst kind of red. A needle
 * short enough to occur by accident cannot be evidence, so every component below
 * is a string nothing else in a row can produce.
 */
const STREET = 'Street 12 int-erase';
const BLOCK = 'Block-4A-int-erase';
const BUILDING = 'House-7B-int-erase';
const FLOOR = 'Floor-2C-int-erase';
const APARTMENT = 'Apt-5D-int-erase';
const AREA = 'Salmiya-int-erase';
const GOVERNORATE = 'Hawalli-int-erase';
/** The free-text field a leak costs the most: a gate code, a "ring twice". */
const INSTRUCTIONS = 'Green door, ring twice — int-erase';
const LATITUDE = '29.336700';
const LONGITUDE = '48.075300';

suite('erasure reaches the address, in both places it lives', () => {
  let app: FastifyInstance;

  let db: typeof import('../db/client')['db'];
  let member: typeof import('../db/schema/member')['member'];
  let memberAddress: typeof import('../db/schema/delivery')['memberAddress'];
  let shopOrder: typeof import('../db/schema/delivery')['shopOrder'];
  let shopOrderLine: typeof import('../db/schema/shopOrder')['shopOrderLine'];
  let transaction: typeof import('../db/schema/transaction')['transaction'];
  let ledgerEntry: typeof import('../db/schema/ledger')['ledgerEntry'];
  let product: typeof import('../db/schema/product')['product'];
  let erasure: typeof import('./erasure');
  let topup: typeof import('./topup');
  let topUpIntent: typeof import('../db/schema/topup')['topUpIntent'];
  let sandbox: NonNullable<ReturnType<typeof import('../gateway')['sandboxGateway']>>;
  let orm: typeof import('drizzle-orm');
  let issueSession: typeof import('../auth/sessions')['issueSession'];

  /** Hers, minted for this run and erased by it. Never a seeded member. */
  let MEMBER = '';
  let bearer = '';
  /** A seeded manager with `perms.shop` — the board's own gate. */
  let staffBearer = '';
  let addressId = '';
  let orderTxId = '';
  let priceFils = 0;

  /** Read before the job and compared after: the money must not move. */
  let moneyBefore: { balanceFils: number; transactions: number; ledgerRows: number; ledgerSum: number };
  let result: Awaited<ReturnType<typeof import('./erasure')['runErasureOnce']>> | null = null;

  beforeAll(async () => {
    db = (await import('../db/client')).db;
    member = (await import('../db/schema/member')).member;
    memberAddress = (await import('../db/schema/delivery')).memberAddress;
    shopOrder = (await import('../db/schema/delivery')).shopOrder;
    shopOrderLine = (await import('../db/schema/shopOrder')).shopOrderLine;
    transaction = (await import('../db/schema/transaction')).transaction;
    ledgerEntry = (await import('../db/schema/ledger')).ledgerEntry;
    product = (await import('../db/schema/product')).product;
    erasure = await import('./erasure');
    topup = await import('./topup');
    topUpIntent = (await import('../db/schema/topup')).topUpIntent;
    orm = await import('drizzle-orm');
    issueSession = (await import('../auth/sessions')).issueSession;

    const gw = (await import('../gateway')).sandboxGateway();
    if (!gw) throw new Error('this suite requires GATEWAY_DRIVER=sandbox');
    sandbox = gw;

    app = await (await import('../app')).buildApp();

    // ---------------------------------------------------- her, from scratch --
    const stamp = Date.now().toString().slice(-8);
    MEMBER = `MB-INT-ERASE-${stamp}-${Math.floor(Math.random() * 1000)}`;
    /**
     * `+965` + 8 digits, which `member_phone_is_e164` accepts and the per-salon
     * unique index has not seen. A collision would refuse the INSERT loudly
     * rather than reusing somebody's row.
     */
    const phone = `+9655${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

    const [seeded] = await db
      .select({ policyVersion: member.policyVersion })
      .from(member)
      .where(orm.eq(member.salonId, SALON))
      .limit(1);

    await db.insert(member).values({
      id: MEMBER,
      salonId: SALON,
      name: 'Int Erasure Subject',
      phone,
      // Not a parseable argon2 string, and nothing here signs in with a password.
      passwordHash: '$argon2id$int-test-not-a-real-hash',
      tier: 'bronze',
      policyVersion: seeded?.policyVersion ?? 1,
    });

    const s = await issueSession(db, {
      principalKind: 'member',
      memberId: MEMBER,
      salonId: SALON,
      scope: 'wallet',
    });
    bearer = s.accessToken;

    staffBearer = (
      await issueSession(db, {
        principalKind: 'staff',
        staffId: MANAGER,
        salonId: SALON,
        scope: 'dashboard',
      })
    ).accessToken;

    const [p] = await db
      .select({ priceFils: product.priceFils })
      .from(product)
      .where(orm.eq(product.id, PRODUCT))
      .limit(1);
    if (!p) throw new Error(`the seed has no ${PRODUCT}; this suite prices its order from it`);
    priceFils = p.priceFils;

    // ------------------------------------------ her address, her real book --
    const addr = await app.inject({
      method: 'POST',
      url: '/members/me/addresses',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        label: 'Home',
        block: BLOCK,
        street: STREET,
        building: BUILDING,
        floor: FLOOR,
        apartment: APARTMENT,
        area: AREA,
        governorate: GOVERNORATE,
        instructions: INSTRUCTIONS,
        latitude: Number(LATITUDE),
        longitude: Number(LONGITUDE),
      },
    });
    expect(addr.statusCode, addr.body).toBe(201);
    addressId = JSON.parse(addr.body).address.id as string;

    /**
     * A SECOND ADDRESS, SOFT-DELETED. `deleted_at` hides a row from her own list;
     * it does not make the street stop naming a household, and the DELETE the job
     * performs has to reach it too. This is the copy a `WHERE deleted_at IS NULL`
     * would have quietly left behind.
     */
    const second = await app.inject({
      method: 'POST',
      url: '/members/me/addresses',
      headers: { authorization: `Bearer ${bearer}` },
      payload: { label: "Mum's", block: '9', street: 'Street 40', building: 'House 2' },
    });
    expect(second.statusCode, second.body).toBe(201);
    const secondId = JSON.parse(second.body).address.id as string;
    const gone = await app.inject({
      method: 'DELETE',
      url: `/members/me/addresses/${secondId}`,
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(gone.statusCode, gone.body).toBe(204);

    // ------------------------------ her money, credited the way money is --
    const intent = await app.inject({
      method: 'POST',
      url: '/topups',
      headers: {
        authorization: `Bearer ${bearer}`,
        'idempotency-key': `int-erase-topup-${randomUUID()}`,
      },
      payload: { amountFils: priceFils, method: 'knet' },
    });
    expect(intent.statusCode, intent.body).toBe(200);
    const intentId = JSON.parse(intent.body).id as string;

    const [row] = await db
      .select()
      .from(topUpIntent)
      .where(orm.eq(topUpIntent.id, intentId))
      .limit(1);
    if (!row) throw new Error(`no intent ${intentId}`);
    await sandbox.setOutcome(row.pspReference as string, 'succeeded');
    const settled = await topup.settleFromGatewayRead(
      db,
      row as unknown as import('./topup').TopUpIntentRow,
      'succeeded',
      row.amountFils,
    );
    expect(settled.kind).toBe('applied');

    // ------------------------------ and a real DELIVERY order to that address --
    const order = await app.inject({
      method: 'POST',
      url: '/orders',
      headers: {
        authorization: `Bearer ${bearer}`,
        'idempotency-key': `int-erase-order-${randomUUID()}`,
      },
      payload: { items: [{ productId: PRODUCT, qty: 1 }], fulfilment: 'delivery', addressId },
    });
    expect(order.statusCode, order.body).toBe(201);
    orderTxId = JSON.parse(order.body).transaction.id as string;

    /**
     * SHE IS BACK AT ZERO, which the job requires and this suite arranged
     * honestly: a real top-up in, a real order out, both through the ledger. A
     * non-zero balance here would make the job DEFER her, and every spec below
     * would then be about a member who was never erased.
     */
    moneyBefore = await moneyState();
    expect(moneyBefore.balanceFils).toBe(0);

    // ---------------------------------------------- the clock, then the job --
    await db
      .update(member)
      .set({
        deletionRequestedAt: new Date(Date.now() - 31 * 24 * 3600_000),
        deletionDueAt: new Date(Date.now() - 24 * 3600_000),
      })
      .where(orm.eq(member.id, MEMBER));

    result = await erasure.runErasureOnce(db, 500);

    const [after] = await db
      .select({ erasedAt: member.erasedAt, name: member.name })
      .from(member)
      .where(orm.eq(member.id, MEMBER))
      .limit(1);
    if (!after?.erasedAt) {
      throw new Error(
        `the job did not erase the subject, so no spec below is about what it says it is ` +
          `about. It reported ${JSON.stringify(result)} — a nonzero deferredBalance or ` +
          `deferredEscrow means the fixture has money state the job refuses to decide, ` +
          `which is the job working and a broken fixture.`,
      );
    }
    expect(after.name).toBe(erasure.TOMBSTONE_NAME);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
  });

  /** Everything the erasure must not move, read at one instant. */
  async function moneyState(): Promise<{
    balanceFils: number;
    transactions: number;
    ledgerRows: number;
    ledgerSum: number;
  }> {
    const [bal] = await db
      .select({ balanceFils: member.balanceFils })
      .from(member)
      .where(orm.eq(member.id, MEMBER));
    const [txs] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(transaction)
      .where(orm.eq(transaction.memberId, MEMBER));
    const [led] = await db
      .select({
        n: orm.sql<number>`count(*)::int`,
        sum: orm.sql<number>`coalesce(sum(${ledgerEntry.amountFils}),0)::int`,
      })
      .from(ledgerEntry)
      .where(orm.eq(ledgerEntry.memberId, MEMBER));
    return {
      balanceFils: bal?.balanceFils ?? -1,
      transactions: txs?.n ?? -1,
      ledgerRows: led?.n ?? -1,
      ledgerSum: led?.sum ?? -1,
    };
  }

  // ------------------------------------------------------------ her book ----

  it('her address book is gone — soft-deleted rows included', async () => {
    const [row] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(memberAddress)
      .where(orm.eq(memberAddress.memberId, MEMBER));
    expect(
      row?.n,
      'HER SAVED ADDRESS BOOK SURVIVED THE ERASURE. The published policy promises "the ' +
        'rest of your account data is deleted within 30 days"; an address is not a ' +
        'financial record, so the seven-year books argument does not reach it.',
    ).toBe(0);
  });

  it('the coordinate pair went with the street, in her book', async () => {
    /**
     * A SEPARATE SPEC BECAUSE IT IS A SEPARATE CLAIM. "No rows" implies it, and
     * saying so out loud is what stops a future "scrub the street, keep the pin"
     * from reading as a fix: a latitude/longitude pair locates the address
     * exactly on its own.
     */
    const [row] = await db
      .select({ n: orm.sql<number>`count(*)::int` })
      .from(memberAddress)
      .where(
        orm.and(
          orm.eq(memberAddress.memberId, MEMBER),
          orm.or(
            orm.isNotNull(memberAddress.latitude),
            orm.isNotNull(memberAddress.longitude),
          ),
        ),
      );
    expect(row?.n, 'a coordinate survived in her address book').toBe(0);
  });

  // ------------------------------------------------------- the snapshot ----

  it('the address snapshot on her past order is scrubbed and stamped', async () => {
    const [row] = await db
      .select()
      .from(shopOrder)
      .where(orm.eq(shopOrder.transactionId, orderTxId))
      .limit(1);
    if (!row) throw new Error('the order row is gone entirely, which is a different outcome');

    /** Every component, named one at a time so a failure says WHICH survived. */
    expect(row.addressId, 'address_id').toBeNull();
    expect(row.addressLabel, 'address_label').toBeNull();
    expect(row.block, 'block').toBeNull();
    expect(row.street, 'street').toBeNull();
    expect(row.building, 'building').toBeNull();
    expect(row.floor, 'floor').toBeNull();
    expect(row.apartment, 'apartment').toBeNull();
    expect(row.area, 'area').toBeNull();
    expect(row.governorate, 'governorate').toBeNull();
    expect(row.instructions, 'instructions — the gate code').toBeNull();
    expect(row.latitude, 'latitude — a pin locates the household on its own').toBeNull();
    expect(row.longitude, 'longitude').toBeNull();

    /**
     * STAMPED, not merely blank, and this is the half migration 0048 exists for.
     * A relaxed CHECK would have made "delivery with no address" a legal state
     * everywhere, including for an order path that simply forgot to copy the
     * snapshot. The stamp is what separates the deliberate state from that bug.
     */
    expect(row.addressErasedAt, 'address_erased_at was not set').not.toBeNull();
    expect(row.fulfilment, 'the order is still a delivery — it was one').toBe('delivery');
  });

  it('the order, its lines and its money are untouched', async () => {
    const [order] = await db
      .select({ status: shopOrder.status })
      .from(shopOrder)
      .where(orm.eq(shopOrder.transactionId, orderTxId))
      .limit(1);
    expect(order?.status, 'the order row itself must survive').toBe('preparing');

    const [tx] = await db
      .select({ kind: transaction.kind, amountFils: transaction.amountFils, status: transaction.status })
      .from(transaction)
      .where(orm.eq(transaction.id, orderTxId))
      .limit(1);
    expect(tx?.kind).toBe('shop');
    expect(tx?.status).toBe('settled');
    expect(tx?.amountFils, 'the debit is what she was charged, still').toBe(-priceFils);

    const [lines] = await db
      .select({
        n: orm.sql<number>`count(*)::int`,
        total: orm.sql<number>`coalesce(sum(${shopOrderLine.lineTotalFils}),0)::int`,
      })
      .from(shopOrderLine)
      .where(orm.eq(shopOrderLine.transactionId, orderTxId));
    expect(lines?.n, 'the lines are append-only evidence and must still be there').toBe(1);
    expect(lines?.total).toBe(priceFils);

    /**
     * THE LEDGER, TO THE FILS. `ledger_entry.transaction_id` is
     * `ON DELETE restrict` precisely so a money row cannot disappear because a
     * customer left, and this is the assertion that says nobody solved #97 by
     * deleting the order.
     */
    expect(await moneyState()).toEqual(moneyBefore);
  });

  it('the job reported no failures', () => {
    expect(result?.failed, `the job reported failures: ${JSON.stringify(result)}`).toBe(0);
    expect(result?.erased, 'the subject was erased, so at least one').toBeGreaterThanOrEqual(1);
  });

  // ------------------------------------------------------ the merchant board ----

  it('the merchant board serves a delivery order with no address, not a blank one', async () => {
    /**
     * WHAT A MERCHANT SEES, which is where the cost of the gap actually landed:
     * `GET /v1/salons/{id}/orders` behind `perms.shop` used to render the street
     * and the gate code beside a member row reading "Deleted account".
     *
     * `fulfilment: 'delivery'` WITH `address: null` is the state, and it is
     * unambiguous rather than a hole: a LIVE delivery is CHECKed to carry block,
     * street and building, so the pair cannot arise any other way — not from a
     * pickup, which says `pickup`, and not from a forgotten snapshot, which the
     * database refuses. A client renders "Address removed" from it with no new
     * wire field, which is also why `ShopOrderSchema` needs no change: `address`
     * is already `.nullable()` there and `contract.test.ts` keeps passing.
     *
     * THE MERCHANT STILL SEES THE TOMBSTONE'S NAME AND PHONE, joined from
     * `member` — "Deleted account" and the synthetic `+990`. That is the erasure
     * working, not a leak, and it is asserted here so the pair is read together:
     * the identity is de-identified AND the address is gone, rather than one of
     * the two.
     */
    const board = await app.inject({
      method: 'GET',
      url: `/v1/salons/${SALON}/orders`,
      headers: { authorization: `Bearer ${staffBearer}` },
    });
    expect(board.statusCode, board.body).toBe(200);

    const items = JSON.parse(board.body).items as Array<{
      transactionId: string;
      fulfilment: string;
      address: unknown;
      memberName: string;
      memberPhone: string;
    }>;
    const row = items.find((o) => o.transactionId === orderTxId);
    if (!row) throw new Error('her order is not on the board at all, which asserts nothing');

    expect(row.fulfilment, 'it was a delivery and still was one').toBe('delivery');
    expect(
      row.address,
      'THE BOARD STILL SERVES HER ADDRESS. This is the response the gap cost — the ' +
        'street and the gate code rendered beside a member row reading "Deleted account".',
    ).toBeNull();
    expect(row.memberName).toBe(erasure.TOMBSTONE_NAME);
    expect(row.memberPhone).toMatch(/^\+990\d+$/);

    /**
     * AND THE WHOLE RESPONSE, not only this row's address object: a component
     * reachable through some other key on the board is the same leak arriving
     * through a different door.
     */
    for (const secret of [STREET, BUILDING, INSTRUCTIONS, LATITUDE, LONGITUDE, addressId]) {
      expect(board.body.includes(secret), `"${secret}" is still on the board`).toBe(false);
    }
  });

  it('the board response carries no component of her address', async () => {
    /**
     * THE WHOLE-ROW FORM, and it is here to survive a column this suite does not
     * know about. The spec above names twelve columns; a thirteenth added to
     * `shop_order` next month and not added to the job's scrub list would pass
     * every one of them. `select *` serialised and scanned for her own strings
     * fails instead, and the message says what to do about it.
     */
    const [row] = await db
      .select()
      .from(shopOrder)
      .where(orm.eq(shopOrder.transactionId, orderTxId))
      .limit(1);
    if (!row) throw new Error('the order row is gone entirely');

    const haystack = JSON.stringify(row);
    for (const secret of [
      STREET,
      BLOCK,
      BUILDING,
      FLOOR,
      APARTMENT,
      AREA,
      GOVERNORATE,
      INSTRUCTIONS,
      LATITUDE,
      LONGITUDE,
      addressId,
      'Home',
    ]) {
      expect(
        haystack.includes(secret),
        `"${secret}" is still on the order row after erasure. If this is a NEW column, ` +
          `add it to the scrub in services/erasure.ts and to the erased arm of ` +
          `shop_order_delivery_has_an_address — a component the CHECK does not name is a ` +
          `component the scrub is not forced to clear.`,
      ).toBe(false);
    }
  });
});
