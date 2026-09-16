/**
 * Shop — design/AVO Wallet Home.dc.html:478-518.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE WAYS TO HAVE NO PRODUCTS, AND THEY ARE THREE DIFFERENT SENTENCES.
 *
 * `design/AVO States.dc.html` insists on this distinction and the design's own
 * example is Appointments — "nothing booked yet" versus "the Booking module is
 * switched off" must never share words. Here:
 *
 *   off        `shop_not_enabled`, a 409. This salon does not sell products. Not
 *              a failure and NOT retryable — a button that fails identically
 *              teaches her the app is broken.
 *   empty      the module is on and the catalogue is empty. The salon will add
 *              something; there is nothing for her to do.
 *   cart empty her cart. A different fact told to the same person at a different
 *              moment, and the only one of the three where "add a product to get
 *              started" is true. It lives in CartSheet.
 *
 * WHAT THE DESIGN DRAWS THAT THE API CANNOT FILL: a per-product description
 * ("For split ends", "Shine & hydration", design:1424-1428). `ProductSchema` is
 * `{id, salonId, name, priceFils, image}` and the route emits exactly those five
 * — so the row renders name and price, and the description is REPORTED rather
 * than invented. It is a column, a contract field and a merchant editor input,
 * not a string a client can supply.
 *
 * The swatch and letter the design also draws are presentation and ARE derived —
 * see `domain/cart.ts` § `swatchFor`, which cycles the design's own five hexes by
 * a stable hash of the product id so a product keeps its colour without a field.
 *
 * `image` IS NOW A FIELD, AND THE SWATCH DID NOT MOVE. `ProductImage` paints the
 * swatch for every row and fades a photograph in over it when the row has one and
 * the session can fetch it — which is a minority of rows today. Read that file's
 * header before changing anything about this square: the loading, failed and
 * offline treatments are all "the swatch, still", on purpose, and the read is
 * AUTHENTICATED, which is not something an `<Image>` handles by itself on every
 * platform.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE INVOICE — Aftab's item 5, the on-screen half.
 *
 * She used to get a toast: "Paid 22.000 KD from wallet · visit added"
 * (design:1457). That is the design's behaviour and it was faithfully built; an
 * invoice is NEW WORK Aftab asked for, not a fidelity fix.
 *
 * It is not a new component. `TransactionSheet` — the sheet the activity feed
 * already opens — takes a `detail` and grows two things a `Transaction` alone
 * cannot supply: the itemisation and the server's own balance-after. Both come
 * off the checkout response, which is a DIFFERENT OBJECT from a list row; see
 * `domain/receipt.ts` § TWO OF THOSE SIX ARRIVE AT ONE MOMENT.
 *
 * IT REPLACES THE TOAST RATHER THAN JOINING IT, and that is forced rather than
 * chosen. `Toast` is `position:absolute; bottom:40; zIndex:40` and `Sheet` is
 * `zIndex:30`, so a toast fired alongside the invoice paints ON TOP OF IT, over
 * the rows. Two acknowledgements of one payment, one physically covering the
 * other, is not shippable — and two documents of one purchase is the divergence
 * this slice exists to prevent, in UI form.
 *
 * WHAT THE TOAST SAID AND THE INVOICE DOES NOT: "visit added". The response's
 * `loyalty` carries a RUNNING TOTAL, never the delta, and the delta is 1 only
 * because `services/order.ts` passes a literal 1 — a literal that same file
 * reserves the right to change. So the sentence is not transcribed onto a
 * receipt. It is still on this screen: `copy.shopNote` (design:516) says an
 * order counts as a visit, above the catalogue, before she pays. REPORTED as
 * the one thing this slice drops.
 *
 * THE BALANCE IS A PROP, NOT A FETCH. One `useWalletHome` for the app, read in
 * App.tsx — two would be two balances and the one on screen would be whichever
 * mounted last. After an order this screen asks the owner to re-read rather than
 * storing `balanceAfterFils` (#2).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ADDRESS BOOK AND THE ORDER LIST ARE OWNED HERE, NOT IN THE SHELL.
 *
 * The cart is app state because it has to survive leaving the tab and because
 * the nav badge reads its count (App.tsx § THE CART LIVES HERE). Neither of these
 * two is like that:
 *
 *   THE ADDRESS BOOK is read when the Shop tab mounts and is only ever looked at
 *   inside the cart sheet. Nothing outside Shop draws an address, so hoisting it
 *   would be state in the shell that the shell has no use for — the test App.tsx
 *   itself sets ("unless something outside Shop ever needs it").
 *
 *   THE ORDER LIST is gated on the sheet being open, so it does not read on every
 *   visit to the tab. It is owned by this SCREEN rather than by the sheet because
 *   `Sheet` returns null when closed: a hook owned by the sheet's component would
 *   unmount and refetch on every open.
 *
 * The SELECTION, though, lives in `useShop` beside the cart — because it is part
 * of the order being composed, and because it has to survive leaving the tab for
 * exactly the reason the cart does.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { formatMoney, moneyAriaLabel, fils } from '@avo/types';
import { useLanguage } from '../i18n/language';
import type { ShopController } from '../state/useShop';
import type { OrderResult } from '../api/shop';
import type { MemberAddress, Salon, TierName } from '@avo/types';
import { CartSheet } from '../components/CartSheet';
import { AddressSheet } from '../components/AddressSheet';
import { OrdersSheet } from '../components/OrdersSheet';
import { TopUpSheet } from '../components/TopUpSheet';
import { TransactionSheet } from '../components/TransactionSheet';
import { useTopUp } from '../state/useTopUp';
import { useNewBalanceAfterTopUp } from '../state/useNewBalanceAfterTopUp';
import { topUpAmountForShortfall } from '../domain/topup';
import { useAddresses } from '../state/useAddresses';
import type { AddressPayload } from '../domain/address';
import { useOrders } from '../state/useOrders';
import { ProductImage } from '../components/ProductImage';
import { FailureScreen } from '../components/FailureScreen';
import { OfflineBanner, StaleBanner } from '../components/Banners';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { focusable } from '../theme/focus';

export function ShopScreen({
  shop,
  balanceFils,
  memberFetchedAt,
  tier,
  branches,
  onToppedUp,
  onReport,
}: {
  /**
   * OWNED BY THE SHELL, not by this screen — see App.tsx. Her cart has to survive
   * leaving the tab, and the nav badge cannot read state a child owns.
   */
  shop: ShopController;
  balanceFils: number;
  /**
   * WHEN the read `balanceFils` came out of landed — `useWalletHome`'s
   * `fetchedAt`, passed down from the shell that owns the read.
   *
   * It is here for one row: the top-up success screen's "New balance". A
   * balance alone cannot tell "the server has answered since she paid" from
   * "this is the figure from before the payment", and only the first may carry
   * that label (#2). See `state/useNewBalanceAfterTopUp.ts`.
   */
  memberFetchedAt: number | null;
  /**
   * The tier that funds the bonus, for the top-up sheet's calculation card. A
   * `TierName` and not a rendered label, because Arabic inflects it.
   */
  tier: TierName | null;
  /**
   * The salon's branches, for the invoice's Branch row.
   *
   * THE SAME ARGUMENT LIST HOME PASSES `TransactionSheet`, and it is here for
   * exactly that reason: the invoice and the feed's receipt for one purchase
   * must name the branch the same way or they are two documents again. Shop is
   * only rendered once the snapshot has landed (App.tsx), so this is never a
   * placeholder.
   */
  branches: Salon['branches'];
  /**
   * Re-read `GET /members/me` after a successful top-up. The same callback
   * `useShop` gets as `onPaid`, and for the same reason: #2 makes the balance
   * the server's answer, so nothing here adds `creditFils` to what it is holding.
   */
  onToppedUp: () => void;
  /**
   * "Report a problem with this payment" -> Account -> Contact us. The same
   * callback Home hands the same sheet; the reference is recorded by
   * `startPaymentReport` before the navigation fires.
   */
  onReport: () => void;
}) {
  const { lang, copy } = useLanguage();
  const [cartOpen, setCartOpen] = useState(false);
  const [ordersOpen, setOrdersOpen] = useState(false);
  /**
   * `null` = closed. `{ address: null }` = a blank form; `{ address }` = an edit.
   *
   * One piece of state rather than an `open` boolean beside an `editing` row, so
   * "open on nothing" is not a representable state and the sheet cannot be shown
   * mid-transition with the previous address still in it.
   */
  const [addressSheet, setAddressSheet] = useState<{ address: MemberAddress | null } | null>(null);

  /**
   * THE INVOICE. `null` = no order has been placed on this screen.
   *
   * The WHOLE response is held rather than a pre-built receipt, so the document
   * is composed at render time by the one builder — and so the language toggle
   * re-composes it. A receipt frozen into strings at checkout would be in
   * English for the rest of its life.
   *
   * IT IS NOT A BALANCE. `useShop` refuses to store `balanceAfterFils` and asks
   * the wallet to re-read instead (#2); nothing here reads this to decide what
   * she has. It is the server's statement about ONE transaction, rendered on the
   * receipt for that transaction, and it is discarded when the sheet closes.
   *
   * WHICH IS ALSO THE ANSWER TO "CAN SHE REOPEN IT": no, and not by oversight.
   * Reopening it later means the itemisation surviving the session, and nothing
   * on the wire carries it — `Transaction` has no `balanceAfterFils` and
   * `ShopOrderSchema` has no lines (it carries the fulfilment, the status and the
   * address snapshot, and no money at all). A cache would hand her a full
   * document today and a half one tomorrow, which is worse than a document that
   * is plainly a one-time acknowledgement. The activity feed keeps the durable
   * record — amount, status, date and the reference support traces by — and the
   * contract change that would close the gap is named in the report.
   */
  const [invoice, setInvoice] = useState<OrderResult | null>(null);

  /**
   * THE CART'S TOP-UP, OWNED HERE, FOR THE REASON `BookScreen` OWNS ITS OWN.
   *
   * WHAT THIS REPLACED: `onTopUp` was wired to `goHome` in App.tsx, which set
   * the screen to Home and nothing else. Tapping "Top up to continue" closed the
   * cart, switched tab, and opened nothing — so the one action offered to a
   * customer who cannot pay silently discarded her cart and left no trace of
   * what had happened. `HomeScreen:363` already did this properly one file away.
   *
   * A SHEET, NOT A NAVIGATION, and that is the whole point. Navigating away
   * loses the cart, the fulfilment choice and the address she picked, exactly as
   * navigating away from the Book flow would lose her slot. The sheet is
   * rendered last so it paints over the cart, which stays mounted underneath —
   * she tops up and is returned to the same cart with the same items.
   */
  /**
   * "New balance" for the sheet below. The stamp half lives here because only
   * this screen knows when ITS top-up settled; the comparison lives in the hook
   * because Home and Book ask the identical question.
   */
  const balance = useNewBalanceAfterTopUp(balanceFils, memberFetchedAt);
  const markSucceeded = balance.markSucceeded;

  const topUp = useTopUp({
    onSucceeded: useCallback(() => {
      // The balance changed, so the owner re-reads the member — #2, and the
      // reason nothing here touches `balanceFils` itself. The stamp is what
      // lets the success screen tell that re-read from the one already on
      // screen, which is the figure from BEFORE she paid.
      markSucceeded();
      onToppedUp();
      /*
        AND THE STALE 402 GOES, BUT ONLY THAT ONE.
        A top-up resolves exactly one refusal: `short`. Clearing the refusal
        unconditionally would re-enable Pay on a cart sitting in
        `alreadyPlaced` — a 422 that means an earlier attempt COMMITTED — and
        she can reach this CTA from that state, because a settled order is
        precisely what can have left her short. No second debit would follow
        (the idempotency key is derived from the cart, which `useShop` does not
        empty on a 422, so the same key returns the same 422 — #4 holding
        server-side), but re-arming a button over a debit that has settled is
        not something to leave to that guard.
      */
      if (shop.refusal?.kind === 'short') shop.clearRefusal();
    }, [markSucceeded, onToppedUp, shop]),
  });

  const book = useAddresses();
  // Gated: the list is not read until the sheet is open. See the header.
  const orders = useOrders(ordersOpen);

  /*
    THE SELECTION IS RE-RESOLVED WHENEVER THE BOOK CHANGES, and never falls back
    to a different address. `reconcileChoice` loses the selection instead —
    picking a destination for her because the one she chose disappeared is the
    worst available behaviour on this path.

    Runs on every successful read as well as after a delete, because the delete
    may have happened on another device.
  */
  useEffect(() => {
    if (book.addresses === null) return;
    shop.reconcileAddresses(book.addresses.map((a) => a.id));
  }, [book.addresses, shop]);

  const checkout = useCallback(async () => {
    const result = await shop.checkout();
    if (result === null) return;
    setCartOpen(false);
    /*
      THE WHOLE RESPONSE, HANDED STRAIGHT TO THE RECEIPT BUILDER.

      What was here was `onToast(copy.shopPaidToast(formatMoney(fils(result
      .totalFils), lang)))` — the design's toast at :1457, and it was right about
      the one thing that matters: quote the SERVER'S figure, never the cart's own
      sum. That principle survives intact and is now applied to six figures
      instead of one. Nothing in this file adds, subtracts or totals anything.

      The toast is gone rather than kept alongside — see the header. `Toast` sits
      at `zIndex:40` over `Sheet`'s 30, so keeping both would paint the toast
      across the invoice's rows.
    */
    setInvoice(result);
  }, [shop]);

  /**
   * Save, then SELECT WHAT SHE JUST SAVED.
   *
   * The id comes back from `useAddresses.save` rather than being read out of the
   * refetched list, because the refetch has not landed yet — and selecting by
   * position ("the newest one") would be a guess that is wrong the moment two
   * saves race. Selecting it also sets the mode to delivery, which is right: she
   * typed an address inside the delivery section.
   *
   * On a refusal the sheet STAYS OPEN with the error in it. Closing it would
   * discard nine fields she has just typed, and `writeError` is rendered where
   * she is looking.
   */
  const saveAddress = useCallback(
    async (payload: AddressPayload, id: string | null) => {
      const savedId = await book.save(payload, id);
      if (savedId === null) return;
      setAddressSheet(null);
      shop.chooseAddress(savedId);
    },
    [book, shop],
  );

  /**
   * Delete one, and let `reconcileAddresses` lose the selection if it was this
   * one — the effect above does that off the refetched list rather than this
   * handler doing it by hand, so a delete on another device is handled by the
   * same path.
   *
   * NO CONFIRMATION DIALOG, and that is a considered omission rather than a
   * missing state: the account sheets confirm because account deletion is
   * irreversible and consequential, while this is one row in an address book that
   * she can retype in nine fields, and — the part that matters — DELETING IT DOES
   * NOT TOUCH AN ORDER ALREADY PLACED TO IT. The order snapshotted the address.
   * `addressDeleteBody` says so, and it is REPORTED as a copy decision for
   * review: if a confirmation is wanted, the strings for it are already written.
   */
  const deleteAddress = useCallback(
    async (address: MemberAddress) => {
      await book.remove(address.id);
    },
    [book],
  );

  // --------------------------------------------------------------- failed --
  /*
    ONLY WHEN THERE IS NOTHING TO KEEP. `shopStatusForFailure` resolves a failure
    over an existing catalogue to `stale` / `offline` instead, and those fall
    through to the list below with a banner above it — interaction-spec.md §4:
    "Network failure keeps the last-known data visible with a stale banner rather
    than blanking." A full-page failure screen here used to be every failure.
  */
  if (shop.status === 'failed') {
    return (
      <FailureScreen
        /*
          THE SERVER'S KIND, not a hardcoded one. This was `kind="server"` with
          `copy.errorBody` as the message, which meant a 403 drew the retryable
          "we failed" screen and a Try again that could only fail again — the
          defect `FailureScreen`'s header names. `message` matters only on the
          `forbidden` branch, where the screen shows the server's own sentence
          instead of our words; the other kinds ignore it and use `errorBody`.
        */
        kind={shop.failure?.kind ?? 'server'}
        message={shop.failure?.message ?? copy.errorBody}
        reference={shop.failure?.reference ?? '—'}
        onRetry={shop.retry}
        retrying={false}
      />
    );
  }

  const products = shop.products ?? [];
  const loading = shop.status === 'loading';

  return (
    <View style={styles.screen}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/*
          The same two banners Home uses, for the same reason and with the same
          strings — no new copy, and therefore nothing new for the Arabic
          worksheet. `offline` is the connection; `stale` is a refresh that
          failed for any other reason.
        */}
        {shop.status === 'offline' ? <OfflineBanner /> : null}
        {shop.status === 'stale' && shop.fetchedAt !== null ? (
          <StaleBanner at={shop.fetchedAt} onRetry={shop.retry} />
        ) : null}

        {/* design:480-491 — the title and the cart button with its badge. */}
        <View style={styles.head}>
          <Text style={[text('displayM', lang), styles.title]}>{copy.shopTitle}</Text>
          {/*
            MY ORDERS — NOT IN THE DESIGN, which draws only the cart button here.
            An order's three statuses have to be reachable from somewhere and this
            is the screen the order was placed from; a nav tab for it would be a
            fifth tab against a design that draws four. It is text rather than a
            second glyph so it cannot be mistaken for another cart.
          */}
          <View style={styles.headActions}>
            <Pressable
              onPress={() => setOrdersOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={copy.ordersCta}
              dataSet={focusable}
              testID="shop-orders-button"
              style={styles.ordersButton}
            >
              <Text style={[text('bodyS', lang), styles.ordersText]}>{copy.ordersCta}</Text>
            </Pressable>
          <Pressable
            onPress={() => setCartOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`${copy.cartTitle} · ${copy.cartItems(shop.count)}`}
            dataSet={focusable}
            testID="shop-cart-button"
            style={styles.cartButton}
          >
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <Path
                d="M3 4h2l2.2 11.2a1.5 1.5 0 0 0 1.5 1.2h8.1a1.5 1.5 0 0 0 1.5-1.2L20.5 8H6"
                stroke={color.ink}
                strokeWidth={1.7}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <Circle cx={9.5} cy={20} r={1.4} fill={color.ink} />
              <Circle cx={17.5} cy={20} r={1.4} fill={color.ink} />
            </Svg>
            {shop.count > 0 ? (
              <View style={styles.badge} testID="shop-cart-badge">
                {/* A count — the copy layer decides the script. */}
                <Text style={[text('bodyS', lang), styles.badgeText]}>
                  {copy.qtyValue(shop.count)}
                </Text>
              </View>
            ) : null}
          </Pressable>
          </View>
        </View>
        <Text style={[text('bodyS', lang), styles.sub]}>{copy.shopSub}</Text>

        {/* ------------------------------------------------------ the module -- */}
        {shop.status === 'off' ? (
          <View style={styles.state} testID="shop-off">
            <Text style={[text('displayS', lang), styles.stateTitle]}>{copy.shopOffTitle}</Text>
            <Text style={[text('bodyS', lang), styles.stateBody]}>{copy.shopOffBody}</Text>
          </View>
        ) : loading ? (
          /*
            Skeleton rows in the shape of the real ones — interaction-spec §4 asks
            for the layout's shape, not a spinner. NO PRICE PLACEHOLDER: a money
            field skeletons as a bar and never as `0.000`, which is the single rule
            that file names as most commonly broken.
          */
          <View style={styles.list} testID="shop-skeleton">
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={styles.row}>
                <View style={[styles.swatch, styles.skeletonBlock]} />
                <View style={styles.rowText}>
                  <View style={[styles.skeletonBar, { width: '62%' }]} />
                  <View style={[styles.skeletonBar, styles.skeletonBarPrice]} />
                </View>
              </View>
            ))}
          </View>
        ) : products.length === 0 ? (
          /* The module is on and there is nothing in it — not her cart, and not off. */
          <View style={styles.state} testID="shop-empty">
            <Text style={[text('displayS', lang), styles.stateTitle]}>{copy.shopEmptyTitle}</Text>
            <Text style={[text('bodyS', lang), styles.stateBody]}>{copy.shopEmptyBody}</Text>
          </View>
        ) : (
          <>
            <View style={styles.list}>
              {products.map((p) => {
                const qty = shop.cart[p.id] ?? 0;
                return (
                  <View key={p.id} style={styles.row} testID={`shop-row-${p.id}`}>
                    <ProductImage
                      productId={p.id}
                      name={p.name}
                      image={p.image}
                      size={52}
                      radius={14}
                      letterSize={20}
                      testID={`shop-swatch-${p.id}`}
                    />
                    <View style={styles.rowText}>
                      <Text style={[text('bodyL', lang), styles.rowName]} numberOfLines={2}>
                        {p.name}
                      </Text>
                      {/*
                        design:501 draws a description line here. The API has no
                        such field — see the header. Rendering the price where the
                        design puts both, rather than inventing copy.
                        MONEY: Western digits in both languages (#12).
                      */}
                      <Text
                        style={[text('bodyL', lang), styles.rowPrice]}
                        accessibilityLabel={moneyAriaLabel(fils(p.priceFils), lang)}
                      >
                        {formatMoney(fils(p.priceFils), lang)}
                      </Text>
                    </View>

                    {qty > 0 ? (
                      /* design:504-508 — − qty + once it is in the cart. */
                      <View style={styles.stepper}>
                        <Pressable
                          onPress={() => shop.remove(p.id)}
                          accessibilityRole="button"
                          accessibilityLabel={`${p.name} −`}
                          dataSet={focusable}
                          testID={`shop-dec-${p.id}`}
                          style={[styles.stepBtn, styles.stepGhost]}
                        >
                          <Text style={[text('bodyL', lang), styles.stepGhostText]}>−</Text>
                        </Pressable>
                        <Text
                          style={[text('bodyL', lang), styles.stepQty]}
                          testID={`shop-qty-${p.id}`}
                        >
                          {copy.qtyValue(qty)}
                        </Text>
                        <Pressable
                          onPress={() => shop.add(p.id)}
                          accessibilityRole="button"
                          accessibilityLabel={`${p.name} +`}
                          dataSet={focusable}
                          testID={`shop-inc-${p.id}`}
                          style={[styles.stepBtn, styles.stepSolid]}
                        >
                          <Text style={[text('bodyL', lang), styles.stepSolidText]}>+</Text>
                        </Pressable>
                      </View>
                    ) : (
                      /* design:511 — Add, on brandTint with brandDeep text (#9). */
                      <Pressable
                        onPress={() => shop.add(p.id)}
                        accessibilityRole="button"
                        accessibilityLabel={`${copy.shopAdd} ${p.name}`}
                        dataSet={focusable}
                        testID={`shop-add-${p.id}`}
                        style={styles.addButton}
                      >
                        <Text style={[text('bodyS', lang), styles.addText]}>{copy.shopAdd}</Text>
                      </Pressable>
                    )}
                  </View>
                );
              })}
            </View>

            {/* design:516 — the brand-tinted note. A statement of fact from the API's
                own loyalty rules: an order counts as a visit. */}
            <View style={styles.note}>
              <View style={styles.noteDot} />
              <Text style={[text('bodyS', lang), styles.noteText]}>{copy.shopNote}</Text>
            </View>
          </>
        )}
      </ScrollView>

      <CartSheet
        open={cartOpen}
        lines={shop.lines}
        count={shop.count}
        total={shop.total}
        balanceFils={balanceFils}
        canAfford={shop.canAfford}
        shortfall={shop.shortfall}
        stale={shop.stale}
        busy={shop.busy}
        refusal={shop.refusal}
        fulfilment={shop.fulfilment}
        block={shop.block}
        book={book}
        onClose={() => {
          setCartOpen(false);
          shop.clearRefusal();
        }}
        onAdd={shop.add}
        onRemove={shop.remove}
        onCheckout={() => void checkout()}
        /*
          The cart stays OPEN underneath. `topUpAmountForShortfall` argues the
          choice of tile; the short version is that it is the smallest offered
          denomination that clears the shortfall, never below the default, and
          the server still decides what the tile is worth (#2).

          `shop.shortfall` is the server's `shortfallFils` once a 402 has landed
          — `useShop` swaps its local figure for the server's the moment one does
          — and the local one only until then.
        */
        onTopUp={() => topUp.open(topUpAmountForShortfall(shop.shortfall))}
        onFulfilment={shop.setFulfilment}
        onChooseAddress={shop.chooseAddress}
        onAddAddress={() => {
          book.clearWriteError();
          setAddressSheet({ address: null });
        }}
        onEditAddress={(address) => {
          book.clearWriteError();
          setAddressSheet({ address });
        }}
        onDeleteAddress={(address) => void deleteAddress(address)}
      />

      {/*
        THE FORM SHEET IS RENDERED AFTER THE CART, and the order matters: both are
        absolutely positioned overlays at the same `zIndex`, so the later one
        paints on top. The cart stays mounted underneath rather than being closed
        — she is mid-checkout, and closing it would lose the sheet she came from.
      */}
      <AddressSheet
        open={addressSheet !== null}
        editing={addressSheet?.address ?? null}
        busy={book.busy}
        writeError={book.writeError}
        onClose={() => {
          setAddressSheet(null);
          book.clearWriteError();
        }}
        onSave={(payload, id) => void saveAddress(payload, id)}
      />

      <OrdersSheet
        open={ordersOpen}
        orders={orders}
        onClose={() => setOrdersOpen(false)}
      />

      {/*
        LAST, so it paints over the cart. Same ordering argument as the address
        form sheet above: both are absolutely positioned overlays at the same
        `zIndex`, so the later one wins and the cart is preserved underneath.

        `newBalanceFils` USED TO BE A HARD-CODED `null` HERE, under a comment
        saying the "new balance" row belonged to the top-up's own success screen
        because that screen re-read the member itself. IT DOES NOT. `TopUpSheet`
        renders what it is handed, and `null` renders a skeleton bar — so on this
        screen the one row that tells her the money actually landed was a grey
        bar, a minute later and forever.

        What goes in now is the shell's member read, admitted only once that read
        landed AFTER the payment settled — #2, decided once in
        `state/useNewBalanceAfterTopUp.ts`. The old comment's objection was
        right as far as it went: nothing here adds `creditFils` to `balanceFils`,
        and nothing here ever will. It just threw away the server's own answer
        along with the local sum.
      */}
      <TopUpSheet
        stage={topUp.stage}
        controller={topUp}
        newBalanceFils={balance.newBalanceFils}
        tier={tier}
      />

      {/*
        THE INVOICE, LAST, so it paints over every other overlay — same ordering
        argument as the two sheets above.

        THE SAME COMPONENT THE ACTIVITY FEED OPENS, with `detail` supplied. Not a
        success screen: a success screen would be a second description of a
        receipt, and there is already a third in the API's email composer.

        DISMISSIBLE, because nothing is in flight — interaction-spec.md §4's rule
        for a sheet after a settled outcome, and the same reading
        `TransactionSheet` already had. What she is dismissing has already
        happened; there is no attempt to interrupt.

        AND IT NEEDS NO NETWORK. Every figure on it came back with the order, so
        going offline while it is open changes nothing on the document — there is
        no refetch to fail and nothing to blank. That is the offline state for
        this screen, and it is a property of where the data came from rather than
        a banner.
      */}
      <TransactionSheet
        transaction={invoice?.transaction ?? null}
        branches={branches}
        /*
          THE SERVER'S OWN FIELDS, PASSED THROUGH. If lane A renames one, this
          line stops compiling — which is the point of taking them off
          `OrderResult` rather than copying them into a local shape first.

          SPREAD, NOT `detail={... : undefined}`, because `exactOptionalPropertyTypes`
          is on: the prop is either present with a value or absent, and the
          absent case is the closed sheet, where there is no transaction either.
        */
        {...(invoice
          ? { detail: { items: invoice.items, balanceAfterFils: invoice.balanceAfterFils } }
          : {})}
        onClose={() => setInvoice(null)}
        onReport={onReport}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.canvas },
  scroll: { flex: 1 },
  // design:480 — padding 58/20/20, centred at the phone width like every screen.
  content: { width: '100%', maxWidth: 402, alignSelf: 'center', paddingTop: 58, paddingHorizontal: 20, paddingBottom: 24 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  headActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // The Shop row's Add button, one step quieter: brandTint is a light surface and
  // its text is brandDeep, never brand (#9).
  ordersButton: {
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: radius.chip,
    backgroundColor: color.brandTint,
  },
  ordersText: { color: color.brandDeep, fontWeight: '600' },
  title: { color: color.ink },
  sub: { color: color.textMuted, marginBottom: 18 },
  cartButton: {
    width: MIN_TAP_TARGET,
    height: MIN_TAP_TARGET,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: color.borderControl,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // design:490 — the count bubble, brandDeep because its text is white (#9).
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: color.brandDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: color.white, fontWeight: '700', fontSize: 11 },
  list: { gap: 11 },
  // design:495 — a white card per product, radius 18.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  // The SKELETON's square only. A real row's square is `ProductImage`, which owns
  // the swatch, the letter and the photograph that may cover them.
  swatch: { width: 52, height: 52, borderRadius: 14, flexShrink: 0 },
  rowText: { flex: 1, minWidth: 0, gap: 4 },
  rowName: { color: color.ink, fontWeight: '600' },
  rowPrice: { color: color.ink, fontWeight: '600' },
  addButton: {
    flexShrink: 0,
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    backgroundColor: color.brandTint,
    borderRadius: radius.chip,
    paddingHorizontal: 16,
  },
  // Brand text on a light surface is brandDeep, never brand (#9).
  addText: { color: color.brandDeep, fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 0 },
  stepBtn: {
    minWidth: MIN_TAP_TARGET,
    minHeight: MIN_TAP_TARGET,
    borderRadius: radius.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGhost: { borderWidth: 1, borderColor: color.borderControl, backgroundColor: color.white },
  stepSolid: { backgroundColor: color.brandDeep },
  stepGhostText: { color: color.ink },
  stepSolidText: { color: color.white },
  stepQty: { minWidth: 16, textAlign: 'center', color: color.ink, fontWeight: '600' },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.brandTint,
    borderRadius: radius.chip,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 16,
  },
  noteDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.brand, flexShrink: 0 },
  noteText: { color: color.brandDeeper, flex: 1 },
  state: { alignItems: 'center', paddingTop: 48, paddingHorizontal: 12 },
  stateTitle: { color: color.ink, textAlign: 'center' },
  stateBody: { color: color.textMuted, marginTop: 6, textAlign: 'center' },
  // A money field skeletons as a BAR, never as 0.000 (states-check).
  skeletonBlock: { backgroundColor: color.disabledBg },
  skeletonBar: { height: 12, borderRadius: 4, backgroundColor: color.disabledBg },
  skeletonBarPrice: { width: '34%', marginTop: 6 },
});
