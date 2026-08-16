/**
 * My bookings and My schedule — designed (:130-179, :397-470), NOT BUILT.
 *
 * They are on the home hub because the hub is designed with four tiles and
 * removing two would be redesigning it. They are not implemented because
 * neither has a server behind it:
 *
 *   My bookings   needs a staff-scoped bookings list. Bookings are deferred out
 *                 of the 30 days entirely (ADR-0001 § Context, design/README.md
 *                 § Known gaps), so there is no entity to read.
 *   My schedule   needs `PUT /artists/{id}/availability`, which LANES.md § Order
 *                 of work names explicitly as one of the four endpoints that do
 *                 not exist yet.
 *
 * Building either against invented data would produce a screen that demos and
 * then has to be rewritten — the exact failure LANES.md records for the
 * dashboard's throwaway sign-in. So the tiles lead here and say so plainly.
 */

import { StyleSheet, Text, View } from 'react-native';
import { color, display, ui } from '../theme';
import { copy } from '../copy/en';
import { LinkButton } from '../components/Buttons';

export function NotBuiltScreen({
  title,
  body,
  onHome,
}: {
  title: string;
  body: string;
  onHome: () => void;
}) {
  return (
    <View style={styles.screen}>
      <LinkButton label={copy.home} onPress={onHome} testID="notbuilt-home" />
      <View style={styles.centre}>
        <Text style={display(22)}>{title}</Text>
        <Text style={[ui(13.5), styles.body]}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.surface,
    paddingTop: 66,
    paddingHorizontal: 22,
    paddingBottom: 26,
  },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 60 },
  body: {
    color: color.textMuted,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
});
