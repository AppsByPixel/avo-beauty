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
 * A PICKUP ORDER SHOWS ITS BRANCH — W7. This paragraph used to say "NO
 * BRANCH", because `POST /orders` took none and the row said "Collect at the
 * salon". Since migration 0060 every order read carries `pickupBranch`, served
 * INLINE with its name, and `domain/shopOrders.ts § pickupLocation` decides the
 * four answers: the branch; the branch CLOSED while she is still waiting
 * (said plainly, with what to do — never drawn as a normal pickup); a legacy
 * pickup that was never asked (NOT "the salon" and NOT a branch — "not
 * recorded"); and a delivery, which has none. The branch is never looked up in
 * `salon.branches`: that list is open-only, so a closed branch would vanish.
 *
 * THE ROW NOW SWITCHES ON `fulfilment`, NOT ON `address === null`. The old
 * test read a null address as pickup, which `ShopOrderSchema.address` warns
 * against by name — an ERASED delivery is null too. That case draws no
 * location line at all rather than "Collect at the salon".
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

import { Pressable, ScrollView, Text, View } from 'react-native';
import type { ShopOrder } from '@avo/types';
import { useLanguage } from '../i18n/language';
import { addressLines } from '../domain/address';
import {
  ORDER_STATUS_COUNT,
  orderIsOpen,
  orderStatusLabel,
  orderStatusStep,
  pickupLocation,
} from '../domain/shopOrders';
import { branchName } from '../domain/names';
import type { OrdersController } from '../state/useOrders';
import { Sheet } from './Sheet';
import { PickupHoursNote } from './PickupHoursNote';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { focusable } from '../theme/focus';
import { brandedStyles } from '../theme/live';

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
            style={[text('bodyS', lang, '600'), open ? styles.statusTextOpen : styles.statusTextDone]}
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

      {order.fulfilment === 'pickup' ? (
        <PickupLine order={order} />
      ) : snapshot === null ? (
        /* An ERASED delivery — no address is held. Nothing to say about where. */
        null
      ) : (
        <View testID={`order-address-${order.transactionId}`}>
          <Text style={[text('label', lang), styles.snapshotLabel]}>{copy.orderDeliveringTo}</Text>
          {/*
            TEXT, NOT A CONTROL. No Pressable, no edit, no navigation, and the
            label rendered is the SNAPSHOT's own — never looked up in the live
            address book. See the header.
          */}
          <Text style={[text('bodyL', lang, '600'), styles.snapshotName]} numberOfLines={1}>
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

/**
 * Where a pickup order is collected — `pickupLocation`'s four answers, drawn.
 * The same label-then-value shape as the delivery snapshot ("Going to · Home"),
 * so a pickup and a delivery row read alike.
 */
function PickupLine({ order }: { order: ShopOrder }) {
  const { lang, copy } = useLanguage();
  const where = pickupLocation(order);
  const id = order.transactionId;
  if (where === null) return null;

  if (where.kind === 'notRecorded') {
    return (
      <View testID={`order-pickup-${id}`}>
        <Text style={[text('bodyS', lang), styles.body]} testID={`order-branch-unrecorded-${id}`}>
          {copy.orderBranchNotRecorded}
        </Text>
      </View>
    );
  }

  const name = branchName(where.branch, lang);
  return (
    <View testID={`order-pickup-${id}`}>
      <Text style={[text('label', lang), styles.snapshotLabel]}>{copy.pickupFrom}</Text>
      <Text
        style={[text('bodyL', lang, '600'), styles.snapshotName]}
        numberOfLines={1}
        testID={`order-branch-${id}`}
      >
        {where.branch.closed ? copy.pickupClosedName(name) : name}
      </Text>
      {/*
        W8 — WHEN SHE CAN COLLECT, while there is still something to collect.
        A collected order is history and a closed branch has no hours to keep,
        so both draw none. The zone is the order's own (`pickupBranch.timezone`),
        because this sheet does not otherwise hold the salon.
      */}
      {where.kind === 'branch' && orderIsOpen(order) && !where.branch.closed ? (
        <PickupHoursNote
          hours={where.branch.businessHours}
          timezone={where.branch.timezone}
          testID={`order-pickup-hours-${id}`}
        />
      ) : null}
      {where.kind === 'closedWaiting' ? (
        /*
          CLOSED WHILE SHE WAITS. The danger chip rather than a muted line: she
          may be about to travel to a shut counter, and this is the sentence
          that stops her.
        */
        <View
          style={styles.chip}
          accessibilityRole="alert"
          testID={`order-branch-closed-${id}`}
        >
          <View style={styles.chipDot} />
          <Text style={[text('bodyS', lang), styles.chipText]}>{copy.orderBranchClosed}</Text>
        </View>
      ) : null}
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
          <Text style={[text('bodyS', lang, '600'), styles.chipRetryText]}>{copy.tryAgain}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = brandedStyles(() => ({
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
  statusTextOpen: { color: color.brandDeeper },
  statusTextDone: { color: color.textMuted },
  step: { color: color.textMutedSoft, flexShrink: 0 },
  snapshotLabel: { color: color.textMutedLabel, marginTop: 12, marginBottom: 4 },
  snapshotName: { color: color.ink },
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
  // design/AVO States.dc.html:103, :137, :224 — every "Try again"/"Retry" in the
  // bundle is font-weight:600, and the design has no 700 for a text action at
  // all. The weight now rides on `text()`, which is the only place that can
  // resolve it to a face in both languages.
  chipRetryText: { color: color.dangerText, textDecorationLine: 'underline' },
  skeletonBar: { height: 12, borderRadius: 4, backgroundColor: color.disabledBg },
}));
