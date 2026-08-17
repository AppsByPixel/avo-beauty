/**
 * Contact us — the topic picker, the message, the receipt reference, the reply
 * channel, and the confirmation carrying the ticket reference.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NON-NEGOTIABLE #11. "Support ticket routing is resolved server-side from
 * `topicId`. A client-supplied route can land a wallet dispute in a salon's
 * inbox."
 *
 * The route appears TWICE on this screen and neither one is sent:
 *
 *   before   each topic shows a "Salon" or "AVO" chip, so the customer knows
 *            who answers before she picks. Read off `SupportTopic.route`, which
 *            the API published. Display only.
 *   after    the confirmation says either "Amara has your message and will reply
 *            on WhatsApp" or "AVO support has your message" — chosen from the
 *            route on the SERVER'S RESPONSE, not from the chip that was on
 *            screen a second earlier. If the two ever disagree, the server is
 *            right and the customer is told the truth.
 *
 * What goes on the wire is `{ topicId, message, ref, via }`. See
 * src/api/account.ts § TicketDraft, where the absence of `route` is enforced by
 * the type rather than by remembering.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The sheet is also the target of "Report a problem with this payment" on a
 * receipt: it opens with `prefillRef` already in the reference field. It does
 * NOT preselect a topic — a payment problem is not automatically a wallet
 * dispute, and choosing the topic is choosing the queue.
 */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { SupportConfig, SupportTicket } from '@avo/types';
import { color, MIN_TAP_TARGET, radius, text, WHITE } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { submitTicket } from '../../api/account';
import { ApiError } from '../../api/client';
import { Sheet } from '../Sheet';
import { PrimaryButton, SecondaryButton, TappableRow } from '../Buttons';
import { Field, FieldLabel, InlineError } from './Fields';

interface Props {
  open: boolean;
  config: SupportConfig | null;
  /** The member's email, for the "reply on Email" value line. */
  memberEmail: string | null;
  memberPhone: string;
  /** Set when the sheet was opened from a receipt. */
  prefillRef: string;
  onClose: () => void;
}

type Via = 'wa' | 'email';

export function ContactSheet({
  open,
  config,
  memberEmail,
  memberPhone,
  prefillRef,
  onClose,
}: Props) {
  const { lang, copy } = useLanguage();

  const [topicId, setTopicId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [reference, setReference] = useState(prefillRef);
  const [via, setVia] = useState<Via>('wa');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<SupportTicket | null>(null);

  // The prefill arrives with the open, so it seeds the field on the transition
  // rather than through an effect that would fight the customer's own typing.
  const [seededFor, setSeededFor] = useState(prefillRef);
  if (open && seededFor !== prefillRef) {
    setSeededFor(prefillRef);
    setReference(prefillRef);
  }

  const close = () => {
    setTopicId(null);
    setMessage('');
    setReference('');
    setError(null);
    setSent(null);
    setSending(false);
    onClose();
  };

  const send = async () => {
    // design:1859 — a topic and at least a few words. The same check the server
    // will make; this one just saves a round trip.
    if (!topicId || message.trim().length < 4) {
      setError(copy.cErr);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const ticket = await submitTicket({
        topicId,
        message: message.trim(),
        // Trimmed and optional. An empty reference is absent, not "".
        ...(reference.trim() ? { ref: reference.trim() } : {}),
        via,
      });
      setSent(ticket);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : copy.errorBody);
    } finally {
      setSending(false);
    }
  };

  const topics = config?.topics ?? [];
  const replyPromise = config
    ? lang === 'ar'
      ? config.channels.replyAr
      : config.channels.replyEn
    : '';
  const viaValue = via === 'wa' ? memberPhone : (memberEmail ?? config?.channels.email ?? '');

  return (
    <Sheet
      open={open}
      dismissible
      onDismiss={close}
      label={sent ? copy.cSentTitle : copy.contactTitle}
      testID="contact-sheet"
    >
      {sent ? (
        <View testID="contact-sent">
          <View style={styles.sentHead}>
            <View style={styles.sentCheck}>
              <Svg width={26} height={26} viewBox="0 0 24 24" fill="none">
                <Path
                  d="M5 12.5l4.2 4.2L19 7"
                  stroke={color.brandDeep}
                  strokeWidth={2.1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </View>
            <Text style={[text('displayS', lang), styles.sentTitle]}>{copy.cSentTitle}</Text>
            {/*
              THE ROUTE ON THE RESPONSE, NOT THE ONE THE CHIP SHOWED. See the
              header — this is the half of #11 that is easy to get wrong while
              still not sending a route.
            */}
            <Text style={[text('body', lang), styles.sentLine]}>
              {sent.route === 'salon' ? copy.cSentSalon : copy.cSentAvo}
            </Text>
          </View>

          <View style={styles.refCard}>
            <Text style={[text('bodyS', lang), styles.refLabel]}>{copy.cSentRef}</Text>
            {/* "SUP-48263" — shown verbatim, LTR, in the display face. */}
            <Text style={styles.refValue} testID="ticket-reference">
              {sent.id}
            </Text>
          </View>

          {replyPromise ? (
            <Text style={[text('bodyS', lang), styles.replyPromise]}>{replyPromise}</Text>
          ) : null}

          <PrimaryButton label={copy.cSentDone} onPress={close} style={styles.doneBtn} testID="contact-done" />
        </View>
      ) : (
        <>
          <View>
            <Text style={[text('displayS', lang), styles.title]}>{copy.contactTitle}</Text>
            <Text style={[text('body', lang), styles.sub]}>{copy.contactSub}</Text>
          </View>

          <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
            <FieldLabel>{copy.cTopicLabel}</FieldLabel>
            <View style={styles.card} testID="contact-topics">
              {topics.map((topic, index) => {
                const selected = topicId === topic.id;
                return (
                  <TappableRow
                    key={topic.id}
                    onPress={() => {
                      setTopicId(topic.id);
                      setError(null);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${lang === 'ar' ? topic.ar : topic.en}, ${
                      topic.route === 'salon' ? copy.cRouteSalon : copy.cRouteAvo
                    }`}
                    testID={`topic-${topic.id}`}
                    style={[styles.topicRow, index === topics.length - 1 && styles.rowLast]}
                  >
                    <View style={[styles.radio, selected && styles.radioOn]} />
                    <Text style={[text('body', lang), styles.topicLabel]}>
                      {lang === 'ar' ? topic.ar : topic.en}
                    </Text>
                    {/* Display only. Never posted. */}
                    <View style={styles.routeChip}>
                      <Text style={[text('bodyS', lang), styles.routeChipText]}>
                        {topic.route === 'salon' ? copy.cRouteSalon : copy.cRouteAvo}
                      </Text>
                    </View>
                  </TappableRow>
                );
              })}
            </View>

            <FieldLabel>{copy.cMsgLabel}</FieldLabel>
            <Field
              value={message}
              onChangeText={(next) => {
                setMessage(next);
                setError(null);
              }}
              placeholder={copy.cMsgPh}
              multiline
              accessibilityLabel={copy.cMsgLabel}
              testID="contact-message"
            />

            <FieldLabel hint={copy.cOptional}>{copy.cRefLabel}</FieldLabel>
            <Field
              value={reference}
              onChangeText={setReference}
              placeholder="AVO-77219"
              ltr
              accessibilityLabel={copy.cRefLabel}
              testID="contact-reference"
            />

            <FieldLabel>{copy.cViaLabel}</FieldLabel>
            <View style={styles.segments}>
              <Segment label={copy.cViaWa} on={via === 'wa'} onPress={() => setVia('wa')} testID="via-wa" />
              <Segment
                label={copy.cViaEmail}
                on={via === 'email'}
                onPress={() => setVia('email')}
                testID="via-email"
              />
            </View>
            {viaValue ? (
              <Text style={[text('bodyS', lang), styles.viaValue]} testID="contact-via-value">
                {viaValue}
              </Text>
            ) : null}

            {error ? <InlineError message={error} testID="contact-error" /> : null}
          </ScrollView>

          <View style={styles.footer}>
            <PrimaryButton
              label={copy.cSend}
              onPress={() => void send()}
              disabled={sending}
              testID="contact-send"
            />
            <SecondaryButton
              label={copy.txClose}
              onPress={close}
              style={styles.cancel}
              testID="contact-cancel"
            />
          </View>
        </>
      )}
    </Sheet>
  );
}

/** design:1626 — the two-up segmented control for the reply channel. */
function Segment({
  label,
  on,
  onPress,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  testID: string;
}) {
  const { lang } = useLanguage();
  return (
    <TappableRow
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      testID={testID}
      style={[styles.segment, on && styles.segmentOn]}
    >
      {/* White on brandDeep when selected — #9. */}
      <Text style={[text('body', lang), on ? styles.segmentTextOn : styles.segmentText]}>
        {label}
      </Text>
    </TappableRow>
  );
}

const styles = StyleSheet.create({
  title: { color: color.ink },
  sub: { color: color.textMuted, marginTop: 4, lineHeight: 20 },
  scroll: { marginTop: 2, flexShrink: 1 },
  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    paddingHorizontal: 16,
  },
  topicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: color.hairlineInner,
  },
  rowLast: { borderBottomWidth: 0 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: color.borderControl,
    backgroundColor: color.surface,
  },
  radioOn: {
    backgroundColor: color.brandDeep,
    borderColor: color.brandDeep,
    borderWidth: 3,
  },
  topicLabel: { flex: 1, minWidth: 0, color: color.ink },
  routeChip: {
    backgroundColor: color.surfaceAlt2,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
  routeChipText: { color: color.textMuted, fontWeight: '600', fontSize: 10.5 },
  segments: { flexDirection: 'row', gap: 9 },
  segment: {
    flex: 1,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 13,
    borderRadius: radius.input,
    borderWidth: 1.5,
    borderColor: color.borderControl,
    backgroundColor: color.surface,
  },
  segmentOn: { backgroundColor: color.brandDeep, borderColor: color.brandDeep },
  segmentText: { color: color.textMutedLabel, fontWeight: '600' },
  segmentTextOn: { color: WHITE, fontWeight: '600' },
  viaValue: {
    color: color.textMutedSoft,
    marginTop: 9,
    marginHorizontal: 4,
    writingDirection: 'ltr',
  },
  footer: { paddingTop: 14 },
  cancel: { marginTop: 8, borderColor: 'transparent' },

  sentHead: { alignItems: 'center', paddingTop: 6 },
  sentCheck: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: color.brandTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sentTitle: { color: color.ink, marginTop: 14 },
  sentLine: { color: color.textMutedLabel, marginTop: 7, textAlign: 'center', lineHeight: 21 },
  refCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
    paddingVertical: 15,
    paddingHorizontal: 18,
    marginTop: 18,
  },
  refLabel: { color: color.textMuted },
  refValue: {
    fontFamily: 'Fraunces_600SemiBold',
    fontWeight: '600',
    fontSize: 15,
    letterSpacing: 0.45,
    color: color.ink,
    writingDirection: 'ltr',
  },
  replyPromise: {
    color: color.textMutedSoft,
    marginTop: 12,
    marginHorizontal: 4,
    lineHeight: 18,
  },
  doneBtn: { marginTop: 18 },
});
