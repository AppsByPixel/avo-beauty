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
 * `{id, salonId, name, priceFils}` and the route emits exactly those four — so
 * the row renders name and price, and the description is REPORTED rather than
 * invented. It is a column, a contract field and a merchant editor input, not a
 * string a client can supply.
 *
 * The swatch and letter the design also draws are presentation and ARE derived —
 * see `domain/cart.ts` § `swatchFor`, which cycles the design's own five hexes by
 * a stable hash of the product id so a product keeps its colour without a field.
 *
 * THE BALANCE IS A PROP, NOT A FETCH. One `useWalletHome` for the app, read in
 * App.tsx — two would be two balances and the one on screen would be whichever
 * mounted last. After an order this screen asks the owner to re-read rather than
 * storing `balanceAfterFils` (#2).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { formatMoney, moneyAriaLabel, fils } from '@avo/types';
import { useLanguage } from '../i18n/language';
import type { ShopController } from '../state/useShop';
import { initialFor, swatchFor } from '../domain/cart';
import { CartSheet } from '../components/CartSheet';
import { FailureScreen } from '../components/FailureScreen';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { focusable } from '../theme/focus';

export function ShopScreen({
  shop,
  balanceFils,
  onToast,
  onTopUp,
}: {
  /**
   * OWNED BY THE SHELL, not by this screen — see App.tsx. Her cart has to survive
   * leaving the tab, and the nav badge cannot read state a child owns.
   */
  shop: ShopController;
  balanceFils: number;
  onToast: (message: string) => void;
  /** The shortfall CTA's destination. */
  onTopUp: () => void;
}) {
  const { lang, copy } = useLanguage();
  const [cartOpen, setCartOpen] = useState(false);

  const checkout = useCallback(async () => {
    const result = await shop.checkout();
    if (result === null) return;
    setCartOpen(false);
    /*
      The toast quotes `totalFils` FROM THE RESPONSE, not the cart's own sum. The
      two agree today and the server is the authority on what was charged — the
      design's own toast is the amount paid (:1457), and quoting a locally computed
      figure is how a receipt and a screen come to disagree.
    */
    onToast(copy.shopPaidToast(formatMoney(fils(result.totalFils), lang)));
  }, [shop, copy, lang, onToast]);

  // --------------------------------------------------------------- failed --
  if (shop.status === 'failed') {
    return (
      <FailureScreen
        kind="server"
        message={copy.errorBody}
        reference={shop.reference ?? '—'}
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
        {/* design:480-491 — the title and the cart button with its badge. */}
        <View style={styles.head}>
          <Text style={[text('displayM', lang), styles.title]}>{copy.shopTitle}</Text>
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
                    <View style={[styles.swatch, { backgroundColor: swatchFor(p.id) }]}>
                      <Text style={[text('displayS', lang), styles.swatchLetter]}>
                        {initialFor(p.name)}
                      </Text>
                    </View>
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
        onClose={() => {
          setCartOpen(false);
          shop.clearRefusal();
        }}
        onAdd={shop.add}
        onRemove={shop.remove}
        onCheckout={() => void checkout()}
        onTopUp={() => {
          setCartOpen(false);
          onTopUp();
        }}
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
  swatch: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  swatchLetter: { color: color.textMutedSoft, fontSize: 20 },
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
