/**
 * The bell's panel — client ask W4: "see the notifications and manage them".
 *
 * A SHEET, because that is how this app puts a list over Home (Top up, the
 * transaction detail, the cart), and the rows are drawn as the activity feed's
 * rows are — the same card, the same hairlines, the same figure column — so a
 * top-up reads the same in both lists. `domain/bell.ts` builds every row; this
 * file only lays them out and says which ones it drew.
 *
 * "MANAGE THEM" IS THREE THINGS, AND ONLY ONE IS NEW HERE:
 *   1. read — opening the panel marks the rows it DREW (`{ ids }`), never all;
 *   2. "Mark all as read" — the one explicit `{ all: true }`, shown only while
 *      the server still counts something unread;
 *   3. what arrives — the EXISTING switches under Account → Notifications
 *      (`GET/PATCH /members/me/notifications`). Not rebuilt: when `campaign` is
 *      missing from `visibleKinds` the panel says offers are off and links
 *      there, and that is all.
 *
 * DISMISSIBLE ALWAYS. Nothing here is in flight that closing could strand.
 */

import { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ShopOrder, Transaction } from '@avo/types';
import { useLanguage } from '../i18n/language';
import { Sheet } from './Sheet';
import { OfflineBanner } from './Banners';
import { alignEnd } from '../i18n/rtl';
import { BRAND_BORDER, color, MIN_TAP_TARGET, radius, text } from '../theme';
import { focusable } from '../theme/focus';
import { bellRows, campaignsHidden, idsToMark, type BellRow } from '../domain/bell';
import type { BellController } from '../state/useBell';

const NO_ORDERS: readonly ShopOrder[] = [];

interface Props {
  bell: BellController;
  /** The salon's name in the reading language, for the template titles. */
  salon: string;
  /** `salon.timezone` — every stamp on the panel is the salon's clock. */
  timeZone: string;
  /** Home's transaction page — how a voided charge is recognised. */
  transactions: readonly Pick<Transaction, 'id' | 'voidedAt'>[];
  /**
   * Her orders, for where a pickup is collected — the shop item carries no
   * branch (`domain/bell.ts` § limit 3). Optional; without it a pickup row
   * says "Pickup" and nothing about where.
   */
  orders?: readonly ShopOrder[];
  /** Account → Notifications, where the existing switches are. */
  onOpenSettings: () => void;
  /**
   * The `booking_policy` row's action: open the salon's current policy. The one
   * row in the bell that is a control, because it is the one whose content is
   * not on the row — the notice is a pointer, and the policy is read fresh.
   */
  onOpenBookingPolicy?: () => void;
}

export function BellSheet({
  bell,
  salon,
  timeZone,
  transactions,
  orders = NO_ORDERS,
  onOpenSettings,
  onOpenBookingPolicy,
}: Props) {
  const { lang, copy } = useLanguage();

  const rows = useMemo(
    () =>
      bell.items
        ? bellRows(bell.items, { lang, copy, salon, timeZone, transactions, orders })
        : null,
    [bell.items, lang, copy, salon, timeZone, transactions, orders],
  );

  /*
    MARK WHAT WAS DRAWN. After the rows are on screen, and only from a read that
    landed (`ready`) — a panel showing kept rows over a failed or offline read
    is still showing them, but a POST from a dead connection would only fail.
    `idsToMark` is unread + markable + drawn. See `state/useBell.ts`.
  */
  const toMark = rows ? idsToMark(rows).join('|') : '';
  const { open, status, markDrawn } = bell;
  useEffect(() => {
    if (!open || status !== 'ready' || toMark === '') return;
    markDrawn(toMark.split('|'));
  }, [open, status, toMark, markDrawn]);

  const hasRows = rows !== null && rows.length > 0;
  const offersOff = bell.items !== null && campaignsHidden(bell.visibleKinds);

  return (
    <Sheet
      open={bell.open}
      dismissible
      onDismiss={bell.close}
      label={copy.acctNotifs}
      testID="bell-sheet"
    >
      <View style={styles.head}>
        <Text style={[text('displayS', lang), styles.title]}>{copy.acctNotifs}</Text>
        {hasRows && (bell.unreadCount ?? 0) > 0 ? (
          <Pressable
            onPress={bell.markAll}
            accessibilityRole="button"
            accessibilityLabel={copy.bellMarkAll}
            dataSet={focusable}
            testID="bell-mark-all"
            style={styles.headAction}
          >
            <Text style={[text('bodyS', lang, '600'), styles.headActionText]}>{copy.bellMarkAll}</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Kept rows over a dead connection: the rows stay, the banner says so. */}
      {bell.status === 'offline' && hasRows ? <OfflineBanner /> : null}

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} testID="bell-scroll">
        {offersOff ? (
          <View style={styles.note} testID="bell-offers-off">
            <View style={styles.noteDot} />
            <View style={styles.noteBody}>
              <Text style={[text('bodyS', lang), styles.noteText]}>{copy.bellOffersOff}</Text>
              <Pressable
                onPress={onOpenSettings}
                accessibilityRole="button"
                accessibilityLabel={copy.bellOffersOffCta}
                dataSet={focusable}
                testID="bell-open-settings"
                style={styles.noteAction}
              >
                <Text style={[text('bodyS', lang, '600'), styles.noteActionText]}>
                  {copy.bellOffersOffCta}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {rows === null ? (
          bell.status === 'failed' ? (
            <Failed onRetry={bell.retry} reference={bell.failure?.reference ?? '—'} />
          ) : bell.status === 'offline' ? (
            <View style={styles.state} testID="bell-offline">
              <Text style={[text('displayS', lang), styles.stateTitle]}>{copy.offlineColdTitle}</Text>
              <Text style={[text('body', lang), styles.stateBody]}>{copy.offlineColdBody}</Text>
            </View>
          ) : (
            <Skeleton />
          )
        ) : rows.length === 0 ? (
          /* EMPTY IS A GOOD OUTCOME — its own words, not a missing-data screen. */
          <View style={styles.state} testID="bell-empty">
            <Text style={[text('displayS', lang), styles.stateTitle]}>{copy.bellEmptyTitle}</Text>
            <Text style={[text('body', lang), styles.stateBody]}>{copy.bellEmptyBody}</Text>
          </View>
        ) : (
          <>
            {/* A failed refresh over kept rows keeps them and says so. */}
            {bell.status === 'failed' ? (
              <Failed onRetry={bell.retry} reference={bell.failure?.reference ?? '—'} inline />
            ) : null}
            <View style={styles.card} testID="bell-rows">
              {rows.map((row, index) => (
                <Row
                  key={row.key}
                  row={row}
                  last={index === rows.length - 1}
                  {...(row.kind === 'booking_policy' && onOpenBookingPolicy
                    ? { onPress: onOpenBookingPolicy }
                    : {})}
                />
              ))}
            </View>
            {bell.nextCursor !== null ? (
              <Pressable
                onPress={bell.loadMore}
                disabled={bell.loadingMore}
                accessibilityRole="button"
                accessibilityLabel={copy.activityShowMore}
                dataSet={focusable}
                testID="bell-more"
                style={styles.more}
              >
                <Text style={[text('body', lang, '600'), styles.moreText]}>{copy.activityShowMore}</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

function Row({ row, last, onPress }: { row: BellRow; last: boolean; onPress?: () => void }) {
  const { lang, copy } = useLanguage();
  const spoken = [row.unread ? copy.bellUnread : null, row.title, ...row.lines, row.when, row.amount?.label]
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join(', ');
  const content = (
    <>
      <View style={styles.icon}>
        {/* The unread dot is `brand` — a SURFACE use, which #9 allows. */}
        <View style={[styles.dot, row.unread ? styles.dotUnread : styles.dotRead]} />
      </View>
      <View style={styles.rowText}>
        <Text style={[text('bodyL', lang, '500'), styles.rowTitle]} testID={`bell-title-${row.key}`}>
          {row.title}
        </Text>
        {row.lines.map((line, i) => (
          <Text key={i} style={[text('bodyS', lang), styles.rowLine]}>
            {line}
          </Text>
        ))}
        <Text style={[text('bodyS', lang), styles.rowWhen]}>{row.when}</Text>
      </View>
      {row.amount ? (
        <Text
          accessibilityLabel={row.amount.label}
          testID={`bell-amount-${row.key}`}
          style={[
            text('bodyL', lang, '600'),
            styles.amount,
            { textAlign: alignEnd(lang) },
            row.amount.tone === 'in'
              ? styles.amountIn
              : row.amount.tone === 'neutral'
                ? styles.amountNeutral
                : styles.amountOut,
          ]}
        >
          {row.amount.display}
        </Text>
      ) : null}
    </>
  );
  const shared = {
    style: [styles.row, last && styles.rowLast],
    accessibilityLabel: spoken,
    testID: `bell-row-${row.key}`,
    dataSet: { kind: row.kind, unread: row.unread ? 'yes' : 'no' },
  };
  /*
    A ROW WITH AN ACTION IS A BUTTON, and only then. Every other row is a
    record, read in place; making them all pressable would promise a detail
    none of them has.
  */
  return onPress ? (
    <Pressable {...shared} onPress={onPress} accessibilityRole="button" dataSet={{ ...shared.dataSet, ...focusable }}>
      {content}
    </Pressable>
  ) : (
    <View {...shared} accessible>
      {content}
    </View>
  );
}

function Failed({
  onRetry,
  reference,
  inline = false,
}: {
  onRetry: () => void;
  reference: string;
  inline?: boolean;
}) {
  const { lang, copy } = useLanguage();
  return (
    <View style={inline ? styles.failedInline : styles.state} testID="bell-failed">
      <Text style={[text(inline ? 'bodyS' : 'body', lang), styles.failedText]}>{copy.bellLoadFailed}</Text>
      <Text style={[text('bodyS', lang), styles.reference]}>
        {copy.referencePrefix}
        {reference}
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={copy.tryAgain}
        dataSet={focusable}
        testID="bell-retry"
        style={styles.retry}
      >
        <Text style={[text('bodyS', lang, '600'), styles.retryText]}>{copy.tryAgain}</Text>
      </Pressable>
    </View>
  );
}

/** Rows in the shape of the real ones. No figure placeholder — bars, never 0.000. */
function Skeleton() {
  return (
    <View style={styles.card} testID="bell-skeleton">
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.row, i === 2 && styles.rowLast]}>
          <View style={styles.icon} />
          <View style={styles.rowText}>
            <View style={[styles.bar, { width: '58%' }]} />
            <View style={[styles.bar, styles.barShort]} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 12,
  },
  title: { color: color.ink, flexShrink: 1 },
  headAction: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', paddingHorizontal: 4 },
  // Brand text on a light surface is brandDeep, never brand (#9).
  headActionText: { color: color.brandDeep },
  // The CartSheet lesson: flexShrink, not flex:1, inside an auto-height sheet.
  scroll: { flexShrink: 1 },

  note: {
    flexDirection: 'row',
    gap: 10,
    padding: 13,
    borderRadius: radius.input,
    backgroundColor: color.brandTint2,
    borderWidth: 1,
    borderColor: BRAND_BORDER,
    marginBottom: 12,
  },
  noteDot: { width: 7, height: 7, borderRadius: radius.pill, backgroundColor: color.brand, marginTop: 6 },
  noteBody: { flex: 1 },
  noteText: { color: color.brandDeeper, lineHeight: 18 },
  noteAction: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', alignSelf: 'flex-start' },
  noteActionText: { color: color.brandDeep },

  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
    minHeight: MIN_TAP_TARGET,
  },
  rowLast: { borderBottomWidth: 0 },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: color.surfaceAlt2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  dotUnread: { backgroundColor: color.brand },
  dotRead: { backgroundColor: color.hairline },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: color.ink },
  rowLine: { color: color.textMutedStrong, marginTop: 1 },
  rowWhen: { color: color.textMuted, marginTop: 2 },
  amount: { flexShrink: 0 },
  amountIn: { color: color.positive },
  amountOut: { color: color.ink },
  amountNeutral: { color: color.textMuted },

  more: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', alignItems: 'center', marginTop: 10 },
  moreText: { color: color.ink },

  state: { alignItems: 'center', paddingVertical: 36, paddingHorizontal: 16 },
  stateTitle: { color: color.ink, textAlign: 'center' },
  stateBody: { color: color.textMuted, marginTop: 6, textAlign: 'center', lineHeight: 20 },
  failedInline: { paddingVertical: 10, marginBottom: 10 },
  failedText: { color: color.dangerText, textAlign: 'center' },
  reference: { color: color.textMutedLabel, marginTop: 6, textAlign: 'center', letterSpacing: 0.3 },
  retry: { minHeight: MIN_TAP_TARGET, justifyContent: 'center', alignSelf: 'center', marginTop: 4 },
  retryText: { color: color.brandDeep },

  bar: { height: 10, borderRadius: 5, backgroundColor: color.surfaceAlt2, marginVertical: 3 },
  barShort: { width: '34%' },
});
