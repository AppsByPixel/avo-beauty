/**
 * A published legal document, rendered.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NON-NEGOTIABLE #10 LIVES IN THIS FILE, SO READ IT BEFORE EDITING IT.
 *
 * "The customer app holds no legal copy. It renders the published policy set
 *  from the API and stamps the version."
 *
 * Every character of the title and the body below comes from the `doc` prop,
 * which comes from `GET /v1/platform/policies`. There is no default document, no
 * fallback clause, no "loading the terms…" placeholder made of legal-sounding
 * words, and no `<Text>Terms and conditions apply</Text>` anywhere in the tree.
 *
 * The ONE string the wallet contributes is the header stamp — "Last updated
 * 1 July 2026 · v3" — and it is composed from `effectiveFrom` and `version`,
 * both of which are also the API's. It is a citation, not a clause.
 *
 * THE TEST THAT MAKES THIS TRUE RATHER THAN STATED: account.test.ts renders the
 * policy list against `docs: []` and asserts the section is empty. If anyone
 * ever adds a bundled document as a "sensible default", that test fails.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { LegalDoc } from '@avo/types';
import { color, text } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { localiseDoc } from '../../api/account';
import { Sheet } from '../Sheet';
import { SecondaryButton } from '../Buttons';

interface Props {
  doc: LegalDoc | null;
  /** "YYYY-MM-DD" and the version, straight off `published`. */
  effectiveFrom: string | null;
  version: number | null;
  onClose: () => void;
}

export function PolicySheet({ doc, effectiveFrom, version, onClose }: Props) {
  const { lang, copy } = useLanguage();
  const localised = doc ? localiseDoc(doc, lang) : null;

  return (
    <Sheet
      open={localised !== null}
      dismissible
      onDismiss={onClose}
      label={localised?.title ?? ''}
      testID="policy-sheet"
    >
      {localised ? (
        <>
          <Text style={[text('displayS', lang), styles.title]}>{localised.title}</Text>
          {/*
            The stamp is conditional on the API having sent both halves. A
            document with no version is shown WITHOUT a stamp rather than with a
            guessed one — api-contract.md wants the version visible "so support
            can tell which wording a customer actually agreed to", and a wrong
            version is worse for that than none.
          */}
          {effectiveFrom !== null && version !== null ? (
            <Text style={[text('bodyS', lang), styles.stamp]} testID="policy-stamp">
              {copy.legalUpdated(effectiveFrom, version)}
            </Text>
          ) : null}

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            {/*
              One clause per string, in array order — api-contract.md: "one
              string per clause, rendered in order". The order is the document's
              structure (numbered clauses), so it is never sorted or filtered.

              The language of the CLAUSE, not of the app, chooses the face: an
              untranslated document renders its English body inside an Arabic
              build, and setting that in the Arabic face would be a silent
              substitution of exactly the kind theme/index.ts warns about.
            */}
            {localised.body.map((clause, index) => (
              <Text
                key={`${localised.id}-${String(index)}`}
                style={[text('body', localised.translated ? lang : 'en'), styles.clause]}
              >
                {clause}
              </Text>
            ))}
          </ScrollView>

          <View style={styles.footer}>
            <SecondaryButton label={copy.txClose} onPress={onClose} testID="policy-close" />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { color: color.ink },
  stamp: { color: color.textMutedSoft, marginTop: 4 },
  body: { marginTop: 14, flexShrink: 1 },
  clause: { color: color.textMutedStrong, lineHeight: 22, marginBottom: 13 },
  footer: { paddingTop: 14 },
});
