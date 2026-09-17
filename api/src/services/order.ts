/**
 * POST /orders — the shop checkout. api-contract.md § Operations:
 * "Customer | Shop checkout | `POST /orders` (pays from wallet)".
 *
 * The same guarantee as `POST /charges`, from the other side of the counter:
 * ONE transaction, or nothing happened. A partially applied order is a money
 * bug — non-negotiable #3's spirit, which does not mention orders because the
 * contract wrote it about charges, and applies word for word.
 *
 *   1. claim the idempotency key            non-negotiable #4
 *   2. lock the wallet                      FOR UPDATE, so the balance read is the balance debited
 *   3. the module gate                      salon.modules.shop, server-side
 *   4. price the basket from `product`      never from the request body
 *   5. debit, or 402 with the exact shortfall — TWO guards, see step 5a
 *   6. the `shop` transaction + its ledger pair
 *   7. the order lines
 *   8. a visit or a stamp, and the tier evaluation
 *   9. queue the receipts
 *  10. the audit row
 *  11. store the response against the key
 *
 * Every refusal throws out of the transaction callback, so the debit, the lines,
 * the loyalty tick, the receipt rows, the audit row AND the key all vanish
 * together. In particular the key vanishing is what lets a customer retry the
 * same attempt after topping up rather than being answered with a cached 402 for
 * ever — services/idempotency.ts carries that reasoning in full.
 *
 * ============================================================================
 * NO PROMOTION IS EVALUATED ON A SHOP ORDER, AND THAT IS A DECISION
 * ============================================================================
 * A charge runs `decideEarning` inside its money transaction and can come out of
 * it with a doubled visit, a doubled stamp, or a flat `credit3` — 3.000 KD paid
 * into the wallet. This does not. The increment is one visit or one stamp, flat.
 *
 * The design says a shop purchase COUNTS as a visit — "Shop purchases count as a
 * visit toward your next tier" (wallet), "shop purchases count the same as
 * visits" (dashboard). It does not say a shop purchase EARNS AT THE HAPPY-HOUR
 * RATE, and the difference is `credit3`.
 *
 * A charge is bounded by a staff member standing at a counter with the customer
 * in front of her. An order is not bounded by anything: it is self-service, from
 * a sofa, as often as she likes. So a live `credit3` window would pay 3.000 KD
 * into the wallet for every order placed inside it, and the cheapest thing in
 * the design's own catalog is a 2.500 silk scrunchie. Buy scrunchie, receive
 * 3.000, repeat — a mint, funded by the merchant, reachable by any customer with
 * a thumb, and it would look like an enthusiastic afternoon in her reports.
 *
 * The visit and stamp multipliers are not exploitable that way, but splitting
 * them from the credit would mean a promotion that applies partly, decided here
 * rather than by `decideEarning` — a second, quieter copy of the rule that
 * `services/promotions.ts` exists to prevent there being two of. So: none of it,
 * stated once, here.
 *
 * A happy hour is a footfall promotion. It fills chairs between 16:00 and 18:00,
 * and a customer ordering shampoo from home has not filled one. If AVO decides
 * otherwise, the change is `loadPromotionInputs` + `decideEarning` in step 8 and
 * a rule about what a self-service purchase may earn — a product decision, not a
 * handler's default. Escalated rather than implemented.
 *
 * ============================================================================
 * WHAT IS DRAWN AND IS NOT SERVED: PICKUP
 * ============================================================================
 * The design has a pickup lifecycle. `AVO Wallet Home.dc.html:1573` renders a
 * shop transaction with `status: 'Picked up'`, and the dashboard's alert feed
 * carries "Shop order ready for pickup · Repair serum · paid from wallet · Hessa
 * to hand over". The contract has NO Order entity, no order status, no
 * `GET /orders` and no endpoint that could move one from paid to collected.
 *
 * That state is therefore NOT modelled here. A status column nothing can
 * transition is an unreachable branch, and this repository has already paid for
 * one: `heldDepositFils` sat hardcoded at `0` from the scanner shipping until
 * bookings landed, and the void code that depended on it under-refunded a
 * customer 3.000 of the 8.000 she had paid for a whole build, because "a branch
 * that cannot execute cannot be wrong, and cannot be tested either".
 *
 * So the order is `settled` when she has paid, which is true, and the handover is
 * reported as a gap between the design and the contract rather than half-built.
 */

import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { add, fils, subtract, type Fils, type Transaction } from '@avo/types';
import type { Db } from '../db/client';
import { member } from '../db/schema/member';
import { product } from '../db/schema/product';
import { salon } from '../db/schema/salon';
import { shopOrderLine } from '../db/schema/shopOrder';
import { transaction } from '../db/schema/transaction';
import { ledgerEntry } from '../db/schema/ledger';
import { walletSpendPosting } from '../money/ledger';
import { loyaltyEvent } from '../db/schema/loyaltyEvent';
import type { MemberPrincipal } from '../auth/principal';
import { badRequest, conflict, insufficientBalance, notFound } from '../http/errors';
import { serialiseTransactionForCustomer } from '../http/serialise';
import { resolveBranch } from './branch';
import { memberAddress, shopOrder } from '../db/schema/delivery';
import { applyStamps, applyVisits, type LoyaltyOutcome } from './loyalty';
import { claimKey, completeKey } from './idempotency';
import { queueReceipts } from './receipts';
import { writeAudit } from './audit';
import { nextTransactionId } from './ids';

/** One cart line, after validation. */
export interface OrderLineInput {
  productId: string;
  qty: number;
}

export interface OrderInput {
  items: OrderLineInput[];
  /**
   * PICKUP IS A FORK, NOT A CASUALTY (PRIOR-ART.md § Lean's shop). Lean keeps
   * both paths live, so "delivery-based" means delivery is available and chosen.
   *
   * OMITTED MEANS PICKUP, which is exactly the behaviour that shipped before
   * this field existed — every order was collected because there was nothing
   * else. So an old client is not broken and is not silently opted into
   * delivery, which is the direction that would send a bottle to an address
   * nobody chose.
   */
  fulfilment?: 'pickup' | 'delivery' | undefined;
  /** Required for delivery, refused for pickup. One of HER OWN addresses. */
  addressId?: string | undefined;
}

export interface OrderContext {
  principal: MemberPrincipal;
  idempotency: { scope: string; endpoint: string; key: string; requestHash: string };
  ipAddress?: string | null;
  userAgent?: string | null;
}

/** One priced line, as the client gets it back. */
export interface OrderLineResult {
  productId: string;
  /** The name AT THE MOMENT OF SALE, so a later rename does not rewrite a receipt. */
  name: string;
  qty: number;
  unitPriceFils: number;
  lineTotalFils: number;
}

export interface OrderResult {
  /**
   * `Transaction` from @avo/types, never a hand-written field list — the mistake
   * `ChargeResult` documents: an inline list came to be missing `voidedAt` and
   * `reversedByTransactionId`, and the most important POST in the product
   * answered a body its own contract could not parse.
   */
  transaction: Transaction;
  balanceAfterFils: number;
  totalFils: number;
  /**
   * The priced lines. The wallet's transaction detail sheet renders "Shop order"
   * with what was in it, and the customer is entitled to see the arithmetic she
   * was charged for rather than a single total.
   */
  items: OrderLineResult[];
  loyalty: LoyaltyOutcome;
  /**
   * NOT VOIDABLE, and said rather than omitted.
   *
   * A charge answers `voidableUntil` because `POST /voids` exists for it — 15
   * minutes, at the counter, in front of the customer. There is no reversal path
   * for an order: `performVoid` refuses anything whose `kind` is not `charge`
   * ("Only a charge can be voided"), the design's Shop screens draw no undo, and
   * the legal set already says what happens instead — "Opened or used products
   * cannot be returned for hygiene reasons; a damaged or wrong item is replaced
   * or returned as wallet credit" (db/legalSeed.ts § Products). That is a
   * merchant reimbursement, not a void.
   *
   * `false` is a positive statement, exactly as `voidedAt: null` is on a fresh
   * charge: a client can tell "this cannot be undone" from "this API is too old
   * to say".
   */
  voidable: false;
}

export async function performOrder(
  db: Db,
  input: OrderInput,
  ctx: OrderContext,
): Promise<OrderResult> {
  return db.transaction(async (tx) => {
    // ---------------------------------------------------------------- 1. key --
    // Inside the transaction, first. A duplicate raises a unique violation here
    // rather than after money has moved, and the caller replays the winner.
    const keyId = await claimKey(tx, ctx.idempotency);

    // ------------------------------------------------------------- 2. member --
    // FOR UPDATE serialises this against a concurrent charge, top-up or booking
    // on the same wallet, so the balance read is the balance debited.
    const [m] = await tx
      .select()
      .from(member)
      .where(eq(member.id, ctx.principal.id))
      .for('update')
      .limit(1);
    if (!m) throw notFound('unknown_member', 'No such member.');

    const [s] = await tx.select().from(salon).where(eq(salon.id, m.salonId)).limit(1);
    if (!s) throw notFound('unknown_salon', 'No such salon.');

    /**
     * ------------------------------------------------------- 3. module gate --
     *
     * `modules.shop` defaults OFF — AVO-Beauty-Product-Description-v2.md
     * § Settings, and the dashboard's own toggle copy says "Default off". A
     * wallet that hides the Shop tab for a salon with the module off is a
     * courtesy; non-negotiable #7 says a courtesy is not a control, and this
     * endpoint takes money out of a wallet. `POST /bookings` has the identical
     * gate for the identical reason.
     */
    if (!s.moduleShop) {
      throw conflict('shop_not_enabled', 'This salon does not sell products through AVO.');
    }

    // ------------------------------------------------------------- 4. basket --
    const ids = input.items.map((i) => i.productId);
    const rows = await tx
      .select({ id: product.id, name: product.name, priceFils: product.priceFils })
      .from(product)
      .where(
        and(
          inArray(product.id, ids),
          // HER OWN SALON. Another salon's product is not priceable here — the
          // same tenant boundary `POST /charges` puts on a service id, and the
          // case lane D has written down as owed for the shop.
          eq(product.salonId, m.salonId),
          eq(product.active, true),
        ),
      );

    /**
     * An unknown or retired id must not silently price at 0 and settle a real
     * transaction for goods that do not exist — the defect lane D found on the
     * mock's charge path. Named, not counted: a client cannot fix "one of your
     * items is unavailable".
     */
    const priced = new Map(rows.map((r) => [r.id, r]));
    const unknown = ids.filter((id) => !priced.has(id));
    if (unknown.length > 0) {
      throw badRequest(
        'invalid_products',
        `Unknown or unavailable product: ${unknown.join(', ')}.`,
        { unknown },
      );
    }

    /**
     * Priced from the database, line by line. A price in the request body is a
     * client that can buy a 12.000 KD mask for 0.001 — non-negotiable #2, and the
     * same rule that keeps `service.price_fils` the only source of a basket total.
     *
     * INTEGER FILS THROUGHOUT: `qty` is a validated integer, `priceFils` is a
     * `bigint` column typed `Fils`, and the accumulation goes through `add` from
     * @avo/types. `qty * priceFils` is the only multiplication of money anywhere
     * in this API, and `shop_order_line_total_matches_qty` re-checks it in the
     * database, so a float reaching it does not commit.
     */
    const lines: OrderLineResult[] = input.items.map((i) => {
      const p = priced.get(i.productId);
      // Unreachable — the `unknown` check above threw — but the map lookup is
      // typed optional and a `!` here would be the one assertion in this file.
      if (!p) throw badRequest('invalid_products', `Unknown product: ${i.productId}.`);
      const unit = fils(p.priceFils);
      return {
        productId: p.id,
        name: p.name,
        qty: i.qty,
        unitPriceFils: unit,
        lineTotalFils: fils(unit * i.qty),
      };
    });

    const total = lines.reduce<Fils>((sum, l) => add(sum, fils(l.lineTotalFils)), fils(0));

    // -------------------------------------------------------------- 5. debit --
    const balance = fils(m.balanceFils);
    if (total > balance) {
      // Nothing else happened: this throw rolls the transaction back, so the
      // idempotency key is untouched and she can retry after topping up. The
      // wallet's cart already renders the shortfall — "Balance too low by …" —
      // from the 402's `shortfallFils`.
      throw insufficientBalance(total, balance);
    }
    const balanceAfter = subtract(balance, total);

    /**
     * The branch, resolved by the SERVER, exactly as a booking's is. A customer
     * placing an order has not told us where she is and must not be asked: a
     * client naming its own branch is a client choosing its own reporting bucket
     * — services/branch.ts § "the fix that must not be taken". A single-branch
     * salon is `established`; a multi-branch one is an attribution and the row
     * says so through `branch_assumed`.
     *
     * Nothing here reads `established`, because nothing here pays out on the
     * branch — see the header on promotions. It is carried onto the row so
     * per-branch shop revenue is filterable rather than indistinguishable from a
     * figure that was known.
     */
    const branch = await resolveBranch(tx, m.salonId, undefined);
    const now = new Date();
    const txId = await nextTransactionId(tx);

    /**
     * ============================================================ 5a. THE DEBIT
     * A CONDITIONAL, RELATIVE UPDATE WHOSE ROW COUNT DECIDES — the second guard,
     * and the answer to trunk's question about whether this path needed one.
     *
     * IT DOES. The measurement that settled it: with `FOR UPDATE` removed from step
     * 2, five concurrent orders of 9.000 KD against a 15.250 balance ALL settled,
     * every one of them reported `balanceAfterFils: 6250`, and `member.balance_fils`
     * ended 36000 fils apart from the ledger. Every CHECK in the schema was
     * satisfied throughout — including both non-negative balance constraints,
     * because each writer wrote the same plausible number — and only invariant 5's
     * reconciliation could see it.
     *
     * "Is the reconciliation enough?" No, and the reason is what reconciliation IS:
     * it runs later, on demand, and it reports a discrepancy after five customers
     * have received goods for the price of one. `db:verify` is a net, not a control.
     * A charge has two layers precisely so that one failing is survivable, and
     * money-out through a self-service endpoint deserves the same.
     *
     * THIS IS THE IDIOM ALREADY TRUSTED HERE, not a new mechanism.
     * `services/walletToken.ts § consumeToken` is one conditional UPDATE whose row
     * count decides, and its header says exactly why a read-then-write cannot do
     * the job: "Two scanners racing the same code both read `consumed_at IS NULL`,
     * both decide they may proceed, and both debit. With the conditional UPDATE the
     * second statement blocks on the row lock the first holds; when the first
     * commits, the second re-evaluates its WHERE against the committed row, matches
     * nothing, and returns zero rows." Substitute "balance" for "consumed_at" and
     * the paragraph is about this statement.
     *
     * BOTH HALVES ARE LOAD-BEARING, and the relative SET is the half that is easy
     * to leave out:
     *
     *   WHERE balance_fils >= total   is what refuses the loser.
     *   SET   balance_fils - total    is what makes the winner's arithmetic happen
     *                                 IN the database.
     *
     * A conditional WHERE with `SET balance_fils = <precomputed 6250>` would still
     * write the stale number, so the lost update would survive the guard. The
     * subtraction has to be the database's.
     *
     * `RETURNING balance_fils` because the ledger's `balance_after_fils` must be
     * what actually landed, not what this transaction predicted. Under the lock in
     * step 2 those agree; the point of a second layer is to be right when the first
     * one is not there.
     *
     * A ZERO ROW COUNT IS A 402, NOT A 500. The only way the predicate fails is a
     * balance that moved between the read and the write, which means she cannot
     * afford it after all — the same answer the read-time check gives, for the same
     * reason, and the shortfall is recomputed from the row that refused.
     */
    const debited = await tx
      .update(member)
      .set({
        balanceFils: sql`${member.balanceFils} - ${total}`,
        updatedAt: now,
      })
      .where(and(eq(member.id, m.id), gte(member.balanceFils, total)))
      .returning({ balanceFils: member.balanceFils });

    const landed = debited[0];
    if (!landed) {
      /**
       * Re-read to report the truth rather than the stale figure. Unreachable while
       * step 2 holds the row — which is the point: this is the layer that speaks
       * when the other one is gone.
       */
      const [fresh] = await tx
        .select({ balanceFils: member.balanceFils })
        .from(member)
        .where(eq(member.id, m.id))
        .limit(1);
      throw insufficientBalance(total, fils(fresh?.balanceFils ?? 0));
    }
    /**
     * The database's answer, not this transaction's prediction. They agree under the
     * lock, and asserting the agreement rather than assuming it is what would have
     * caught the lost update at the moment it happened instead of at the next
     * `db:verify`.
     */
    if (landed.balanceFils !== balanceAfter) {
      throw new Error(
        `order debit landed at ${landed.balanceFils} but this transaction computed ` +
          `${balanceAfter}. The wallet moved under an open transaction, which means ` +
          `the FOR UPDATE in step 2 is not holding.`,
      );
    }

    /**
     * ------------------------------------------------ 5b. the fulfilment --
     *
     * Resolved BEFORE the transaction row is written, so a delivery to an
     * address that is not hers refuses before any money moves. The lookup is
     * scoped to `member_id`, so another customer's address id is a 404 rather
     * than a 403 — a 403 would confirm it exists.
     *
     * NOTHING HERE TOUCHES AN AMOUNT. There is no delivery fee (PRIOR-ART.md
     * § Lean: no `deliveryCharge`, `deliveryFee` or `shippingFee` anywhere), so
     * choosing delivery cannot change `total`, and this whole feature stays off
     * the money path. If a fee is ever added, that is a separate decision and
     * this comment is the thing it has to argue with.
     */
    const fulfilment = input.fulfilment ?? 'pickup';
    let address: typeof memberAddress.$inferSelect | null = null;
    if (fulfilment === 'delivery') {
      if (!input.addressId) {
        throw badRequest('address_required', 'A delivery needs one of your saved addresses.');
      }
      const [row] = await tx
        .select()
        .from(memberAddress)
        .where(
          and(
            eq(memberAddress.id, input.addressId),
            eq(memberAddress.memberId, m.id),
            isNull(memberAddress.deletedAt),
          ),
        )
        .limit(1);
      if (!row) throw notFound('unknown_address', 'No such address.');
      address = row;
    } else if (input.addressId) {
      throw badRequest(
        'address_not_for_pickup',
        'A pickup order takes no address. Choose delivery, or omit the address.',
      );
    }

    // ------------------------------------------------- 6. transaction record --
    await tx.insert(transaction).values({
      id: txId,
      memberId: m.id,
      salonId: m.salonId,
      branchId: branch.branchId,
      branchAssumed: !branch.established,
      kind: 'shop',
      // Negative: the sign CHECK on `transaction` says a `shop` row debits, and
      // `product_price_positive` is what stops it being zero.
      amountFils: fils(-total),
      method: 'wallet',
      status: 'settled',
      // "AVO-SH-76888" — the reference the design's transaction detail sheet
      // renders for a shop order, `AVO Wallet Home.dc.html:1573`.
      reference: `AVO-SH-${txId.slice(3)}`,
      /**
       * NO COMMISSION. `fee_fils` defaults to 0 and is left there, matching the
       * charge path: AVO's commission is taken when money ENTERS the ecosystem
       * through a PSP, and this purchase moves an existing balance from a wallet
       * to a salon with no gateway involved. `commissionFor` is a top-up concept.
       */
      createdAt: now,
      settledAt: now,
    });

    // ------------------------------------------------------------- 7. ledger --
    // Double entry, balanced per transaction. The DEFERRABLE constraint trigger
    // from migration 0001 checks the pair at COMMIT.
    // "Value delivered by the salon: services rendered, PRODUCTS SOLD" —
    // db/schema/ledger.ts already names this case on the account it belongs to,
    // and it is the same posting the counter charge makes, so it is the same
    // function: `walletSpendPosting`.
    await tx.insert(ledgerEntry).values(
      walletSpendPosting({
        transactionId: txId,
        salonId: m.salonId,
        memberId: m.id,
        amountFils: total,
        balanceAfterFils: balanceAfter,
      }),
    );

    // -------------------------------------------------------- 7a. the lines --
    await tx.insert(shopOrderLine).values(
      lines.map((l) => ({
        transactionId: txId,
        productId: l.productId,
        name: l.name,
        qty: l.qty,
        unitPriceFils: fils(l.unitPriceFils),
        lineTotalFils: fils(l.lineTotalFils),
      })),
    );

    /**
     * ---------------------------------------------------- 8. loyalty + tier --
     *
     * ONE visit per ORDER, not per item and not per bottle. "A purchase earns a
     * visit/stamp" (api-contract.md § Product) and "Shop purchases count as a
     * visit toward your next tier" (the wallet's own copy) are both singular, and
     * a cart of five products is one purchase. Counting per line would let a
     * customer buy five scrunchies and climb a tier, which is a ladder measured
     * in items pretending to be a ladder measured in visits.
     *
     * No multiplier is consulted. See the header.
     */
    let loyalty: LoyaltyOutcome;
    if (s.loyaltyMode === 'stamps') {
      const wasReady = (m.stamps ?? 0) >= (s.stampTarget ?? 0);
      loyalty = applyStamps(s.stampTarget ?? 0, m.stamps ?? 0, 1);
      await tx.update(member).set({ stamps: loyalty.stamps }).where(eq(member.id, m.id));

      // Only the purchase that FILLS the card, or every later one announces the
      // same reward again — services/charge.ts § 9.
      if (loyalty.rewardReady && !wasReady) {
        await tx.insert(loyaltyEvent).values({
          salonId: m.salonId,
          memberId: m.id,
          transactionId: txId,
          kind: 'stamp_reward_ready',
          stampsAfter: loyalty.stamps,
          stampTarget: loyalty.target,
        });
      }
    } else {
      loyalty = applyVisits(s.tiers ?? [], m.visits, m.tier ?? null, 1);
      await tx
        .update(member)
        .set({ visits: loyalty.visits, tier: loyalty.tier })
        .where(eq(member.id, m.id));

      // "Reem S. reached Gold tier" in the Overview feed. `member.tier` holds the
      // current rung; only this row holds the move. db/schema/loyaltyEvent.ts.
      if (loyalty.climbed && loyalty.tier !== null) {
        await tx.insert(loyaltyEvent).values({
          salonId: m.salonId,
          memberId: m.id,
          transactionId: txId,
          kind: 'tier_climb',
          fromTier: m.tier ?? null,
          toTier: loyalty.tier,
        });
      }
    }

    // ------------------------------------------------ 9. queue the receipts --
    // Rows, not network calls, inside this transaction — so the receipts are
    // queued if and only if the money moved. services/receipts.ts.
    /**
     * ------------------------------------------------ 7b. the fulfilment row --
     *
     * IN THE SAME TRANSACTION as the order, so an order with no fulfilment is
     * not a state that exists — nobody can be handed a paid order they cannot
     * find out where to send. `transaction_id` is `shop_order`'s primary key, so
     * a second fulfilment for one order is refused by the schema rather than by
     * this handler remembering.
     *
     * The address is SNAPSHOTTED, not only referenced. `shop_order_line` already
     * snapshots the product name and unit price for the reason its header gives,
     * and an address is worse: she can edit or delete it after ordering, and the
     * driver needs what she typed when she ordered. `address_id` rides along for
     * provenance and may later point at a soft-deleted row.
     */
    await tx.insert(shopOrder).values({
      transactionId: txId,
      salonId: m.salonId,
      memberId: m.id,
      fulfilment,
      // `preparing` is the column default; named here so the lifecycle's start
      // is legible at the only place that creates one.
      status: 'preparing',
      addressId: address?.id ?? null,
      addressLabel: address?.label ?? null,
      block: address?.block ?? null,
      street: address?.street ?? null,
      building: address?.building ?? null,
      floor: address?.floor ?? null,
      apartment: address?.apartment ?? null,
      area: address?.area ?? null,
      governorate: address?.governorate ?? null,
      instructions: address?.instructions ?? null,
      latitude: address?.latitude ?? null,
      longitude: address?.longitude ?? null,
    });

    await queueReceipts(tx, m, txId, {
      kind: 'shop',
      transactionId: txId,
      amountFils: total,
      /**
       * The lines, with quantities. A charge's receipt payload carries
       * `services`; a shop receipt has to carry `qty` too or the customer cannot
       * reconcile a total that came from a multiplication.
       */
      items: lines,
      balanceAfterFils: balanceAfter,
      /**
       * THE FULFILMENT SHE ACTUALLY CHOSE, not the one the shop had when it was
       * drawn. This read `pickup: true`, hardcoded, with a comment explaining
       * that nothing was being delivered — true of every order until item 7's
       * delivery half landed, and false for half of them afterwards. The value
       * is resolved in step 5b and written to `shop_order` in step 7b; taking it
       * from anywhere else was the whole defect.
       *
       * IT WAS LATENT, WHICH IS WHY NOTHING CAUGHT IT. Nothing in `api/src`
       * reads this field and `RECEIPT_DRIVER=logging` sends nothing, so the wrong
       * value was persisted into `receipt_job.payload` and consulted by nobody —
       * the exact shape of DECISIONS.md #88 (`whatsapp_enabled`: stored, served,
       * consulted by nothing) and #82. Stored-and-wrong is still wrong: the row
       * is the frozen evidence of what she bought (db/schema/receipt.ts), and a
       * renderer written next month would have read it and believed it.
       *
       * AND IT CARRIES NO SENTENCE. The design bundle has no delivery receipt
       * copy — `whatsapp-templates.md` § 3 has no pickup or delivery variable at
       * all — so this is the fact, truthfully, and what a receipt SAYS about a
       * delivery is left open rather than invented here. See
       * `services/receipts.ts` § ShopReceiptPayload.
       */
      fulfilment,
    });

    // ------------------------------------------------------------ 10. audit --
    await writeAudit(tx, ctx.principal, {
      salonId: m.salonId,
      kind: 'money',
      action: 'Shop order paid',
      /**
       * `· to collect` USED TO BE UNCONDITIONAL, which put a false sentence in
       * the salon's own audit log for every delivery order — and unlike the
       * receipt payload above, this one is NOT latent: the dashboard renders the
       * audit log today, so a merchant reading a delivery order's money row was
       * told to hand the bag over the counter.
       *
       * The two words are the dashboard's own vocabulary rather than a new
       * coinage: `ShopOrders.tsx` renders the fulfilment as a `Pickup` /
       * `Delivery` pill, and the design's shop copy is "pick up at the salon"
       * (`AVO Wallet Home.dc.html:1234`, `AVO Merchant Dashboard.dc.html:299`).
       * The design bundle specifies no shape for an audit detail — this whole
       * sentence is merchant-facing operational text this file already authors,
       * not product copy, so making it true is a data fix and not a copy change.
       */
      detail: `${(total / 1000).toFixed(3)} KD from ${m.name}'s wallet · ${lines
        .map((l) => `${l.qty}× ${l.name}`)
        .join(', ')} · ${fulfilment === 'delivery' ? 'for delivery' : 'to collect'}`,
      /**
       * `wallet`, not `merchant` or `scanner`. The customer took this action from
       * her own app; no staff member was involved, and attributing it to the
       * salon would put a row in the merchant's audit log claiming one of her
       * team did something nobody did.
       */
      source: 'wallet',
      subjectType: 'transaction',
      subjectId: txId,
      amountFils: -total,
      metadata: {
        items: lines.map((l) => ({
          productId: l.productId,
          qty: l.qty,
          unitPriceFils: l.unitPriceFils,
        })),
        totalFils: total,
        branchAssumed: !branch.established,
      },
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    const result: OrderResult = {
      transaction: serialiseTransactionForCustomer(
        {
          id: txId,
          memberId: m.id,
          branchId: branch.branchId,
          kind: 'shop',
          amountFils: -total,
          bonusFils: 0,
          // Not emitted by the serialiser — merchant-visible, customer-never —
          // and 0 is what was written to the row.
          feeFils: 0,
          method: 'wallet',
          status: 'settled',
          reference: `AVO-SH-${txId.slice(3)}`,
          createdAt: now,
          // A shop order is priced from the catalogue, and `custom_amount` is
          // CHECKed charge-only at the database (0049), so `false` here is not a
          // choice this code is making.
          customAmount: false,
          note: null,
        },
        // No reversal is possible: nothing voids a `shop` row. Stated, because
        // the parameter is required precisely so a caller that COULD have one
        // cannot forget to look.
        null,
      ),
      balanceAfterFils: balanceAfter,
      totalFils: total,
      items: lines,
      loyalty,
      voidable: false,
    };

    // ------------------------------------------------ 11. store the response --
    // Same transaction, so the key and its answer commit with the money.
    await completeKey(tx, keyId, { status: 201, body: result }, txId);

    return result;
  });
}
