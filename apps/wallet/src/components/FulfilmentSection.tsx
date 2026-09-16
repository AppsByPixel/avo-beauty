/**
 * Collect it or have it delivered — the choice, inside the cart.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NOT IN THE DESIGN BUNDLE, so the vocabulary is borrowed rather than invented.
 *
 * The two options are the same TILE the top-up sheet draws for a payment method
 * — a bordered row that takes the whole width, brand-tinted when selected — and
 * the saved addresses under Delivery are the same shape one step smaller. No new
 * radius, no new border weight, no new colour: `CLAUDE.md` forbids restyling and
 * inventing a second visual language for a new screen is the same thing in
 * reverse.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY NOT DRAWN HERE, AND ALL FOUR ARE RULES RATHER THAN GAPS.
 *
 *   NO FEE LINE. Not a fee row, not a subtotal split, not a "Delivery: free"
 *   row. There is no delivery fee anywhere in this feature — asserted
 *   server-side rather than merely absent: `shop_order` has no amount column and
 *   an order touches only `member_wallet` and `salon_revenue`, so a fee would
 *   have to invent a third account. A "free" row TELLS THE CUSTOMER A FEE EXISTS
 *   and is waived today, which is a promise about pricing nobody has made, and
 *   it is the row somebody later "fixes" by putting a number in it. The cart's
 *   totals block is untouched by this component.
 *
 *   NO PICKUP BRANCH PICKER. `POST /orders` takes no pickup branch, resolves the
 *   branch server-side and refuses a client-supplied `branchId` by name. So the
 *   pickup tile says "the salon" and claims no location. The three ways to fake
 *   one — reuse the booking screen's `branchChoice` filter, send it anyway, or
 *   show a picker and drop the value — are all rejected in
 *   `domain/fulfilment.ts` § THE PICKUP BRANCH, and the third is the dangerous
 *   one: she would believe she chose Salmiya and nothing on screen would ever
 *   say the location was not settled. REPORTED as a gap.
 *
 *   NO DEFAULT INTO DELIVERY. A customer with one saved address is not thereby
 *   choosing delivery. Pickup is the default because it is what this app did
 *   yesterday, and because auto-selecting delivery would decide the thing this
 *   control exists to ask.
 *
 *   NO MAP, NO COORDINATES, NO "USE MY LOCATION". See `AddressSheet`'s header —
 *   the Places omission is reported, not worked around locally.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FOUR STATES ON THE ADDRESS LIST, AND THE EMPTY ONE IS THE COMMON CASE.
 *
 *   loading   two skeleton rows in the shape of the real ones. Not a spinner —
 *             interaction-spec.md §4 asks for the layout's shape.
 *   empty     NO SAVED ADDRESSES. The first-run case and the one a real customer
 *             hits, and the only one of the four where there is something for
 *             her to do — so it is the one that names an action.
 *   error     one line plus a retry. The list is cold; there is nothing to keep.
 *   offline   its own sentence, and it KEEPS the retry. `offlineColdBody` —
 *             "Reconnect and try again. Nothing is lost." — is the string the
 *             copy layer invented for a cold offline read, precisely because
 *             `offlineBanner` promises a last update that does not exist here.
 *             Reconnecting is something she can do, which is what separates this
 *             from `blockedTitle`.
 *
 * `stale` and `offline` over a list ALREADY ON SCREEN keep the list and add the
 * line above it, rather than blanking — `addressStatusForFailure` decides that,
 * and it is the rule interaction-spec.md §4 names outright.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { MemberAddress } from '@avo/types';
import { useLanguage } from '../i18n/language';
import { addressLines } from '../domain/address';
import type { Fulfilment, FulfilmentChoice } from '../domain/fulfilment';
import type { AddressBookController } from '../state/useAddresses';
import { color, MIN_TAP_TARGET, radius, text } from '../theme';
import { focusable } from '../theme/focus';

interface Props {
  choice: FulfilmentChoice;
  book: AddressBookController;
  onMode: (mode: Fulfilment) => void;
  onChoose: (addressId: string) => void;
  onAdd: () => void;
  onEdit: (address: MemberAddress) => void;
  onDelete: (address: MemberAddress) => void;
}

export function FulfilmentSection({
  choice,
  book,
  onMode,
  onChoose,
  onAdd,
  onEdit,
  onDelete,
}: Props) {
  const { lang, copy } = useLanguage();
  const delivering = choice.mode === 'delivery';

  return (
    <View style={styles.section} testID="fulfilment-section">
      <Text style={[text('label', lang), styles.heading]}>{copy.fulfilTitle}</Text>

      {/* --------------------------------------------------- the two options -- */}
      <Option
        title={copy.fulfilPickup}
        body={copy.fulfilPickupBody}
        selected={!delivering}
        onPress={() => onMode('pickup')}
        testID="fulfil-pickup"
      />
      <Option
        title={copy.fulfilDelivery}
        body={copy.fulfilDeliveryBody}
        selected={delivering}
        onPress={() => onMode('delivery')}
        testID="fulfil-delivery"
      />

      {/* The address list exists only under Delivery. A chooser above a pickup
          order would be offering a decision that cannot reach the server. */}
      {delivering ? (
        <View style={styles.addresses} testID="fulfil-addresses">
          <Text style={[text('label', lang), styles.heading]}>{copy.addressChooseTitle}</Text>

          {/*
            A failed refresh over a list ALREADY ON SCREEN says so and keeps the
            list — the line goes above, and the rows below stay tappable, because
            an address that was hers thirty seconds ago is still hers.
          */}
          {book.status === 'offline' && book.addresses !== null ? (
            <Line text={copy.offlineBanner} testID="fulfil-addresses-offline" />
          ) : null}
          {book.status === 'stale' && book.addresses !== null ? (
            <Line text={copy.addressLoadFailed} onRetry={book.retry} testID="fulfil-addresses-stale" />
          ) : null}

          {book.status === 'loading' ? (
            <View testID="fulfil-addresses-skeleton">
              {[0, 1].map((i) => (
                <View key={i} style={[styles.row, styles.rowIdle]}>
                  <View style={styles.rowText}>
                    <View style={[styles.skeletonBar, { width: '38%' }]} />
                    <View style={[styles.skeletonBar, { width: '76%', marginTop: 7 }]} />
                  </View>
                </View>
              ))}
            </View>
          ) : book.addresses === null ? (
            /*
              COLD FAILURE. There is nothing to keep, so this is the whole state
              rather than a banner over rows.
            */
            <Line
              /*
                `offlineBanner` is the WRONG SENTENCE on a cold read and the copy
                layer says so at length: it promises "showing your last update"
                and there is no last update. `offlineColdBody` is the string
                invented for exactly this case, and it KEEPS its retry —
                reconnecting is something she can actually do.
              */
              text={book.status === 'offline' ? copy.offlineColdBody : copy.addressLoadFailed}
              onRetry={book.retry}
              testID="fulfil-addresses-failed"
            />
          ) : book.addresses.length === 0 ? (
            /*
              THE FIRST-RUN CASE. Different words from a failed read, because it
              is a different fact told to a different person — and the only one
              of the four states where there IS something for her to do.
            */
            <View style={styles.empty} testID="fulfil-addresses-empty">
              <Text style={[text('bodyL', lang, '600'), styles.emptyTitle]}>
                {copy.addressEmptyTitle}
              </Text>
              <Text style={[text('bodyS', lang), styles.emptyBody]}>{copy.addressEmptyBody}</Text>
            </View>
          ) : (
            book.addresses.map((address) => (
              <AddressRow
                key={address.id}
                address={address}
                selected={choice.addressId === address.id}
                busy={book.busy}
                onPress={() => onChoose(address.id)}
                onEdit={() => onEdit(address)}
                onDelete={() => onDelete(address)}
              />
            ))
          )}

          {/*
            Add is available in EVERY state including the failed ones: a customer
            who cannot read her book can still tell us where to send a bottle,
            and the POST does not depend on the GET having worked.
          */}
          <Pressable
            onPress={onAdd}
            accessibilityRole="button"
            accessibilityLabel={copy.addressAddCta}
            dataSet={focusable}
            testID="address-add"
            style={styles.addRow}
          >
            <Text style={[text('bodyS', lang, '600'), styles.addText]}>+ {copy.addressAddCta}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * One of the two fulfilment tiles.
 *
 * The selected treatment is `brandTint` with `brandDeep` text — a light surface
 * with brand-coloured text, which is #9's rule and the same pairing the Shop
 * row's Add button uses. `brand` itself is never behind text.
 */
function Option({
  title,
  body,
  selected,
  onPress,
  testID,
}: {
  title: string;
  body: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { lang } = useLanguage();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title} · ${body}`}
      dataSet={focusable}
      testID={testID}
      style={[styles.row, selected ? styles.rowOn : styles.rowIdle]}
    >
      {/* The dot is the same 8pt one the cart's chips and the shop's note use. */}
      <View style={[styles.dot, selected ? styles.dotOn : styles.dotOff]} />
      <View style={styles.rowText}>
        <Text style={[text('bodyL', lang, '600'), selected ? styles.titleOn : styles.titleOff]}>
          {title}
        </Text>
        <Text style={[text('bodyS', lang), styles.body]}>{body}</Text>
      </View>
    </Pressable>
  );
}

/**
 * One saved address: her label, then the address itself.
 *
 * THE LABEL IS THE TITLE AND IS NOT PART OF THE ADDRESS. "Home" is her name for
 * it, not a component, and `addressLines` deliberately leaves it out — merging
 * the two would put "Home" into what a driver reads.
 *
 * `instructions` is not on this row either. It is a note to a human and would
 * turn a chooser row into a paragraph; the order's own snapshot renders it.
 *
 * EDIT AND DELETE ARE SEPARATE CONTROLS INSIDE THE ROW, and the row itself
 * selects. Three targets in one row is a lot, so each clears the 44pt minimum
 * and each is announced with the address's label — "Home, edit" rather than
 * "edit", which is the defect driving the cart's stepper found: a screen reader
 * given three identically-named buttons cannot tell which row it is changing.
 */
function AddressRow({
  address,
  selected,
  busy,
  onPress,
  onEdit,
  onDelete,
}: {
  address: MemberAddress;
  selected: boolean;
  busy: boolean;
  onPress: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { lang, copy } = useLanguage();
  const lines = addressLines(address, {
    block: copy.addrBlock,
    street: copy.addrStreet,
    building: copy.addrBuilding,
    floor: copy.addrFloor,
    apartment: copy.addrApartment,
  });

  return (
    <View style={[styles.row, selected ? styles.rowOn : styles.rowIdle]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={`${address.label} · ${lines.join(' · ')}`}
        dataSet={focusable}
        testID={`address-row-${address.id}`}
        style={styles.rowMain}
      >
        <View style={[styles.dot, selected ? styles.dotOn : styles.dotOff]} />
        <View style={styles.rowText}>
          <Text
            style={[text('bodyL', lang, '600'), selected ? styles.titleOn : styles.titleOff]}
            numberOfLines={1}
          >
            {address.label}
          </Text>
          {lines.map((line) => (
            <Text key={line} style={[text('bodyS', lang), styles.body]}>
              {line}
            </Text>
          ))}
        </View>
      </Pressable>
      <View style={styles.rowActions}>
        <Pressable
          onPress={onEdit}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`${address.label} · ${copy.addressEdit}`}
          dataSet={focusable}
          testID={`address-edit-${address.id}`}
          style={styles.action}
        >
          <Text style={[text('bodyS', lang, '600'), styles.actionText]}>{copy.addressEdit}</Text>
        </Pressable>
        <Pressable
          onPress={onDelete}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`${address.label} · ${copy.addressDelete}`}
          dataSet={focusable}
          testID={`address-delete-${address.id}`}
          style={styles.action}
        >
          <Text style={[text('bodyS', lang, '600'), styles.actionDanger]}>{copy.addressDelete}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * A one-line state, with an optional retry — the same danger-chip shape the cart
 * already uses for a shortfall and a stale product, so a failed address read
 * looks like every other refusal in this sheet rather than like a new kind of
 * problem.
 *
 * `accessibilityLiveRegion` so it is announced when it appears rather than
 * arriving silently below the fold.
 */
function Line({
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

const styles = StyleSheet.create({
  section: { marginTop: 18, borderTopWidth: 1, borderTopColor: color.hairline, paddingTop: 16 },
  heading: { color: color.textMutedLabel, marginBottom: 10, marginHorizontal: 2 },
  addresses: { marginTop: 14 },
  // The top-up sheet's method tile, one step smaller. Same radius, same border.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1.5,
    borderRadius: radius.button,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 9,
    minHeight: MIN_TAP_TARGET,
  },
  rowIdle: { borderColor: color.borderControl, backgroundColor: color.surface },
  // Selected: a light surface with brand text (#9). `brand` is never behind text.
  rowOn: { borderColor: color.brandDeep, backgroundColor: color.brandTint },
  rowMain: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 },
  rowText: { flex: 1, minWidth: 0 },
  rowActions: { flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 },
  action: {
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  actionText: { color: color.brandDeep },
  actionDanger: { color: color.dangerText },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  dotOn: { backgroundColor: color.brand },
  dotOff: { backgroundColor: color.borderControl },
  titleOn: { color: color.brandDeeper },
  titleOff: { color: color.ink },
  body: { color: color.textMuted, marginTop: 2 },
  empty: { paddingVertical: 18, paddingHorizontal: 4 },
  emptyTitle: { color: color.ink },
  emptyBody: { color: color.textMuted, marginTop: 4 },
  addRow: {
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  addText: { color: color.brandDeep },
  // The cart's own chip, so a failed read looks like every other refusal here.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.dangerBg,
    borderRadius: radius.chip,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: color.dangerDot, flexShrink: 0 },
  chipText: { color: color.dangerText, flex: 1 },
  chipRetry: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', flexShrink: 0 },
  // design/AVO States.dc.html:103, :137, :224 — every "Try again"/"Retry" in the
  // bundle is font-weight:600, and the design has no 700 for a text action at
  // all. The weight now rides on `text()`, which is the only place that can
  // resolve it to a face in both languages.
  chipRetryText: { color: color.dangerText, textDecorationLine: 'underline' },
  // A skeleton is a BAR. Never a placeholder value.
  skeletonBar: { height: 11, borderRadius: 4, backgroundColor: color.disabledBg },
});
