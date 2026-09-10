/**
 * Her orders — `preparing → ready → closed`, and where each one is going.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOT IN THE DESIGN BUNDLE. Nothing in `design/` draws an order list: the shop
 * was collection-only and an order reached her only as an activity row and its
 * receipt. So this borrows the cart sheet's furniture wholesale — the same
 * `Sheet`, the same title-and-count head, the same hairline-separated rows, the
 * same danger chip for a failure — and adds no shape of its own.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THREE STATUSES, AND THE ADDRESS IS A SNAPSHOT.
 *
 * `preparing → ready → closed` is the whole lifecycle. `closed` means BOTH
 * collected and delivered, which is why the sentence differs by fulfilment while
 * the enum does not — `orderStatusLabel` in `domain/shopOrders.ts` owns those
 * six strings.
 *
 * THE ADDRESS ON AN ORDER IS RENDERED AS TEXT AND IS NEVER A CONTROL. This is
 * the rule most likely to be broken by a well-meaning edit, so it is stated
 * here as well as in the domain module:
 *
 *   no edit affordance on it;
 *   no tap through to the address book;
 *   no "same as saved" indicator;
 *   and it is NEVER matched by id against the live book to relabel it.
 *
 * That last one is the trap. `ShopOrder.address.id` exists — it is provenance —
 * and joining it against `useAddresses` to show the current label would be one
 * line and would be wrong: an order placed to an address she has since renamed
 * and moved would display today's name over yesterday's street. The snapshot is
 * what she typed WHEN SHE ORDERED, deliberately, so a delivered order stays
 * answerable, and `orderAddressFixed` says so on the row in her own language.
 *
 * A PICKUP ORDER SHOWS NO ADDRESS AND NO BRANCH. `ShopOrder.address` is null for
 * pickup, and `POST /orders` never took a pickup branch — so the row says
 * "Collect at the salon" and claims no location. See `domain/fulfilment.ts` §
 * THE PICKUP BRANCH; showing a branch here would be inventing the answer to the
 * question that slice reported.
 *
 * NO CANCEL, NO UNDO, NO "MARK COLLECTED". Advancing a status is the MERCHANT's
 * transition, behind `perms.shop` on the fulfilment board, and there is no
 * customer endpoint for it. `OrderResult.voidable` is a literal `false` and
 * `performVoid` refuses anything that is not a charge. So this sheet reads.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FOUR STATES.
 *
 *   loading   three skeleton rows in the shape of the real ones.
 *   empty     nothing ordered yet. Not a failure and nothing to fix, so no
 *             retry — and different words from a failed read.
 *   error     the chip plus a retry. Cold; there is nothing to keep.
 *   offline   `offlineColdBody` on a cold read, `offlineBanner` over a list
 *             already on screen — a failed refresh keeps the orders and says so
 *             rather than blanking them (interaction-spec.md §4).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ShopOrder } from '@avo/types';
import { useLanguage } from '../i18n/language';
import { addressLines } from '../domain/address';
import {
  ORDER_STATUS_COUNT,
  orderIsOpen,
  orderStatusLabel,
  orderStatusStep,
} from '../domain/shopOrders';
import type { OrdersController } from '../state/useOrders';
import { Sheet } from './Sheet';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { focusable } from '../theme/focus';

export function OrdersSheet({
  open,
  orders,
  onClose,
}: {
  open: boolean;
  orders: OrdersController;
  onClose: () => void;
}) {
  const { lang, copy } = useLanguage();
  const list = orders.orders;

  return (
    <Sheet open={open} dismissible onDismiss={onClose} label={copy.ordersTitle} testID="orders-sheet">
      <View style={styles.head}>
        <Text style={[text('displayS', lang), styles.title]}>{copy.ordersTitle}</Text>
      </View>

      {/* A failed refresh over a list already on screen keeps the list. */}
      {list !== null && orders.status === 'offline' ? (
        <Chip text={copy.offlineBanner} testID="orders-offline" />
      ) : null}
      {list !== null && orders.status === 'stale' ? (
        <Chip text={copy.ordersLoadFailed} onRetry={orders.retry} testID="orders-stale" />
      ) : null}

      {orders.status === 'loading' ? (
        <View style={styles.list} testID="orders-skeleton">
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.row}>
              <View style={[styles.skeletonBar, { width: '46%' }]} />
              <View style={[styles.skeletonBar, { width: '72%', marginTop: 8 }]} />
            </View>
          ))}
        </View>
      ) : list === null ? (
        // Cold. `offlineColdBody` rather than `offlineBanner` — there is no last
        // update to be showing, which is the copy layer's own argument.
        <Chip
          text={orders.status === 'offline' ? copy.offlineColdBody : copy.ordersLoadFailed}
          onRetry={orders.retry}
          testID="orders-failed"
        />
      ) : list.length === 0 ? (
        /*
          NOTHING ORDERED YET. Not a failure, and — unlike the empty address book
          — nothing for her to do here either: the action is in the shop behind
          this sheet, so the sentence describes rather than instructs, and there
          is no retry on a state that is not a problem.
        */
        <View style={styles.empty} testID="orders-empty">
          <Text style={[text('displayS', lang), styles.emptyTitle]}>{copy.ordersEmptyTitle}</Text>
          <Text style={[text('bodyS', lang), styles.emptyBody]}>{copy.ordersEmptyBody}</Text>
        </View>
      ) : (
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          {list.map((order) => (
            <OrderRow key={order.transactionId} order={order} />
          ))}
          {/*
            The server capped the page and SAID SO. Rendered rather than dropped,
            for the reason the schema declares the field: a list that silently
            ends at its cap claims to be complete.
          */}
          {orders.truncated ? (
            <Text style={[text('bodyS', lang), styles.truncated]} testID="orders-truncated">
              {copy.orderTruncated}
            </Text>
          ) : null}
        </ScrollView>
      )}
    </Sheet>
  );
}

function OrderRow({ order }: { order: ShopOrder }) {
  const { lang, copy } = useLanguage();
  const open = orderIsOpen(order);
  const snapshot = order.address;

  return (
    <View style={styles.row} testID={`order-row-${order.transactionId}`}>
      <View style={styles.rowHead}>
        {/*
          The status, as a chip. Brand-tinted while the order is live and quiet
          once it is closed — `brandTint` with `brandDeeper` text, a light surface
          with brand-coloured text, which is #9's rule.
        */}
        <View style={[styles.status, open ? styles.statusOpen : styles.statusDone]}>
          <View style={[styles.statusDot, open ? styles.statusDotOpen : styles.statusDotDone]} />
          <Text
            style={[text('bodyS', lang), open ? styles.statusTextOpen : styles.statusTextDone]}
            testID={`order-status-${order.transactionId}`}
          >
            {orderStatusLabel(order, copy)}
          </Text>
        </View>
        {/* A COUNT, so Eastern in Arabic — the copy layer decides that. */}
        <Text style={[text('bodyS', lang), styles.step]}>
          {copy.orderStep(orderStatusStep(order.status), ORDER_STATUS_COUNT)}
        </Text>
      </View>

      {snapshot === null ? (
        /* Pickup. The salon, and no branch — see the header. */
        <Text style={[text('bodyS', lang), styles.body]} testID={`order-pickup-${order.transactionId}`}>
          {copy.orderCollectAt}
        </Text>
      ) : (
        <View testID={`order-address-${order.transactionId}`}>
          <Text style={[text('label', lang), styles.snapshotLabel]}>{copy.orderDeliveringTo}</Text>
          {/*
            TEXT, NOT A CONTROL. No Pressable, no edit, no navigation, and the
            label rendered is the SNAPSHOT's own — never looked up in the live
            address book. See the header.
          */}
          <Text style={[text('bodyL', lang), styles.snapshotName]} numberOfLines={1}>
            {snapshot.label}
          </Text>
          {addressLines(snapshot, {
            block: copy.addrBlock,
            street: copy.addrStreet,
            building: copy.addrBuilding,
            floor: copy.addrFloor,
            apartment: copy.addrApartment,
          }).map((line) => (
            <Text key={line} style={[text('bodyS', lang), styles.body]}>
              {line}
            </Text>
          ))}
          {/* Her note to the driver, on the order only — not on a chooser row. */}
          {snapshot.instructions === null ? null : (
            <Text style={[text('bodyS', lang), styles.body]}>{snapshot.instructions}</Text>
          )}
          {/*
            The sentence that stops a snapshot being read as live. It is the whole
            reason there is no edit control above.
          */}
          <Text style={[text('bodyS', lang), styles.fixed]} testID={`order-fixed-${order.transactionId}`}>
            {copy.orderAddressFixed}
          </Text>
        </View>
      )}
    </View>
  );
}

/** The cart's own danger chip, with an optional retry. */
function Chip({
  text: body,
  onRetry,
  testID,
}: {
  text: string;
  onRetry?: () => void;
  testID: string;
}) {
  const { lang, copy } = useLanguage();
  return (
    <View
      style={styles.chip}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      <View style={styles.chipDot} />
      <Text style={[text('bodyS', lang), styles.chipText]}>{body}</Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={copy.tryAgain}
          dataSet={focusable}
          testID={`${testID}-retry`}
          style={styles.chipRetry}
        >
          <Text style={[text('bodyS', lang), styles.chipRetryText]}>{copy.tryAgain}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: color.ink },
  list: { marginTop: 12, maxHeight: 440 },
  row: { paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: color.hairline },
  rowHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: radius.chip,
    paddingVertical: 6,
    paddingHorizontal: 11,
  },
  statusOpen: { backgroundColor: color.brandTint },
  statusDone: { backgroundColor: color.disabledBg },
  statusDot: { width: 7, height: 7, borderRadius: 4, flexShrink: 0 },
  statusDotOpen: { backgroundColor: color.brand },
  statusDotDone: { backgroundColor: color.textMutedSoft },
  // Brand text on a light surface is brandDeeper, never brand (#9).
  statusTextOpen: { color: color.brandDeeper, fontWeight: '600' },
  statusTextDone: { color: color.textMuted, fontWeight: '600' },
  step: { color: color.textMutedSoft, flexShrink: 0 },
  snapshotLabel: { color: color.textMutedLabel, marginTop: 12, marginBottom: 4 },
  snapshotName: { color: color.ink, fontWeight: '600' },
  body: { color: color.textMuted, marginTop: 2 },
  fixed: { color: color.textMutedSoft, marginTop: 7 },
  empty: { alignItems: 'center', paddingTop: 40, paddingBottom: 30, paddingHorizontal: 10 },
  emptyTitle: { color: color.textMuted, textAlign: 'center' },
  emptyBody: { color: color.textMutedSoft, marginTop: 6, textAlign: 'center' },
  truncated: { color: color.textMutedSoft, paddingVertical: 14, textAlign: 'center' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.dangerDot, flexShrink: 0 },
  chipText: { color: color.dangerText, flex: 1 },
  chipRetry: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', flexShrink: 0 },
  chipRetryText: { color: color.dangerText, fontWeight: '700', textDecorationLine: 'underline' },
  skeletonBar: { height: 12, borderRadius: 4, backgroundColor: color.disabledBg },
});
