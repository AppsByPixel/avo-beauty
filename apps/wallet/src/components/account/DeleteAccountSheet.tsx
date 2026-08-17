/**
 * Request account deletion — an App Store requirement, not a nicety.
 *
 * The screen's job is to make sure the customer sees the one consequence she
 * cannot undo before she asks: THE REMAINING BALANCE. Refunds are wallet credit
 * (non-negotiable #5), so a wallet with credit in it that closes is credit that
 * is simply gone — hence the balance in a warning-toned card and the fine print
 * telling her to spend it or settle it with the salon first.
 *
 * The balance goes through `Money`, so it is `formatMoney`'s output: 3 decimals,
 * Western digits in both languages, with the unit the language supplies.
 * Non-negotiables #1 and #12 — a hand-formatted "24.500 KD" here would render
 * the Latin unit inside the Arabic build.
 *
 * WHAT HAPPENS ON CONFIRM: nothing reaches a server, because there is no
 * endpoint — see src/api/account.ts § requestAccountDeletion for what is owed
 * and why it was not invented. This sheet therefore does exactly what the design
 * does (design:902-903, where both buttons call `closeDelete`) and shows no
 * success message. A confirmation the app cannot back would be worse than none.
 */

import { StyleSheet, Text, View } from 'react-native';
import { fils } from '@avo/types';
import { color, radius, text, WHITE } from '../../theme';
import { useLanguage } from '../../i18n/language';
import { requestAccountDeletion } from '../../api/account';
import { Sheet } from '../Sheet';
import { TappableRow } from '../Buttons';
import { Money } from '../Money';

interface Props {
  open: boolean;
  balanceFils: number;
  onClose: () => void;
}

export function DeleteAccountSheet({ open, balanceFils, onClose }: Props) {
  const { lang, copy } = useLanguage();

  return (
    <Sheet open={open} dismissible onDismiss={onClose} label={copy.deleteTitle} testID="delete-sheet">
      <Text style={[text('displayS', lang), styles.title]}>{copy.deleteTitle}</Text>
      <Text style={[text('body', lang), styles.body]}>{copy.deleteBody}</Text>

      <View style={styles.balanceCard} testID="delete-balance">
        <Text style={[text('body', lang), styles.balanceLabel]}>{copy.deleteBalance}</Text>
        <Money
          amount={fils(balanceFils)}
          color={color.dangerText}
          figureStyle={styles.balanceFigure}
          unitStyle={styles.balanceUnit}
        />
      </View>

      <View style={styles.actions}>
        <TappableRow
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={copy.deleteKeep}
          testID="delete-keep"
          style={[styles.action, styles.keep]}
        >
          <Text style={[text('bodyL', lang), styles.keepText]}>{copy.deleteKeep}</Text>
        </TappableRow>
        <TappableRow
          onPress={() => {
            requestAccountDeletion();
            onClose();
          }}
          accessibilityRole="button"
          accessibilityLabel={copy.deleteGo}
          testID="delete-confirm"
          style={[styles.action, styles.confirm]}
        >
          {/*
            White on `dangerText`, the design's own destructive fill
            (design:903). Not on `brand` — #9 is about the brand ramp, and this
            control is deliberately not brand-coloured.
          */}
          <Text style={[text('bodyL', lang), styles.confirmText]}>{copy.deleteGo}</Text>
        </TappableRow>
      </View>

      <Text style={[text('bodyS', lang), styles.fine]}>{copy.deleteFine}</Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: { color: color.ink },
  body: { color: color.textMutedLabel, marginTop: 8, lineHeight: 21 },
  balanceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: color.dangerBg,
    borderRadius: radius.button,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginTop: 16,
  },
  balanceLabel: { color: color.dangerText },
  balanceFigure: { fontSize: 17, fontWeight: '600' },
  balanceUnit: { fontSize: 12, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 20 },
  action: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 15,
    borderRadius: radius.button,
  },
  keep: { backgroundColor: color.surfaceAlt2 },
  keepText: { color: color.ink, fontWeight: '600' },
  confirm: { backgroundColor: color.dangerText },
  confirmText: { color: WHITE, fontWeight: '600' },
  fine: {
    color: color.textMutedSoft,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 18,
  },
});
