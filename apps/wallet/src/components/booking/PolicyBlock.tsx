/**
 * The salon's booking policy, drawn (migration 0066), and where a settled
 * deposit went.
 *
 * One block for the three places she reads it — the confirm step (the salon's
 * CURRENT policy, before she agrees to it), her booking afterwards (the policy
 * STAMPED on it, which a later publish never changes) and the bell (current
 * again). The same drawing in all three, so the version she agreed to and the
 * version she is later shown cannot look like different documents.
 *
 * NON-NEGOTIABLE #10. The paragraph is the salon's own text from the API,
 * verbatim; the app writes only the title and the rule summary, which it derives
 * from data (`noShow`, `cancellation`). No policy wording lives in this app.
 *
 * NO DESIGN SOURCE — the bundle predates the ruling. It reuses the review
 * step's own card geometry (a hairline card, a bodyL title, bodyS lines) rather
 * than inventing a treatment, and wears no brand tint: the brand tint on this
 * screen points at money (the deposit card), and a policy is terms, not an
 * amount.
 */

import { StyleSheet, Text, View } from 'react-native';
import { formatMoney, fils } from '@avo/types';
import { color, radius, text } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { policySummary, policyText, type PolicyTerms } from '../../domain/bookingPolicy';

export function PolicyBlock({
  terms,
  testID = 'policy-block',
}: {
  terms: PolicyTerms;
  testID?: string;
}) {
  const { lang, copy } = useLanguage();
  const summary = policySummary(terms, copy);
  /*
    THE PARAGRAPH'S FACE FOLLOWS THE PARAGRAPH'S LANGUAGE. A salon that wrote
    English only is shown English inside an Arabic build, set in the Latin face
    rather than forced through the Arabic one — `PolicySheet`'s rule for the
    legal set, for the same reason.
  */
  const body = policyText(terms.text, lang);
  return (
    <View style={styles.card} testID={testID}>
      <Text style={[text('bodyL', lang, '600'), styles.title]}>{copy.policyTitle}</Text>
      <Text style={[text('bodyS', lang), styles.rule]} testID={`${testID}-noshow`}>
        {summary.noShow}
      </Text>
      <Text style={[text('bodyS', lang), styles.rule]} testID={`${testID}-cancel`}>
        {summary.cancel}
      </Text>
      <Text style={[text('body', body.lang), styles.body]} testID={`${testID}-text`}>
        {body.body}
      </Text>
    </View>
  );
}

/**
 * Where the deposit went, in the SERVER's figures: `booking.settlement`, or the
 * cancel result's `refundedFils` / `keptFils`. Never computed here.
 *
 * A zero on either side is not drawn: "0.000 KD kept by the salon" on a full
 * return is a sentence about money that did not move. Both zero is a booking
 * that held nothing, and draws nothing.
 */
export function SettlementLines({
  returnedFils,
  keptFils,
  testID = 'settlement',
}: {
  returnedFils: number;
  keptFils: number;
  testID?: string;
}) {
  const { lang, copy } = useLanguage();
  if (returnedFils <= 0 && keptFils <= 0) return null;
  return (
    <View style={styles.settlement} testID={testID}>
      {returnedFils > 0 ? (
        <Text style={[text('body', lang, '600'), styles.back]} testID={`${testID}-back`}>
          {copy.settledBack(formatMoney(fils(returnedFils), lang))}
        </Text>
      ) : null}
      {keptFils > 0 ? (
        <Text style={[text('body', lang), styles.kept]} testID={`${testID}-kept`}>
          {copy.settledKept(formatMoney(fils(keptFils), lang))}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 14,
    padding: 16,
    borderRadius: radius.card,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.hairline,
  },
  title: { color: color.ink },
  rule: { color: color.textMutedStrong, marginTop: 6, lineHeight: 18 },
  body: { color: color.textMuted, marginTop: 10, lineHeight: 20 },
  settlement: { marginTop: 10, gap: 3 },
  back: { color: color.ink },
  kept: { color: color.textMutedStrong },
});
