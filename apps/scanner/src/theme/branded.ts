/**
 * `StyleSheet.create`, re-evaluable — the sheet half of `./live`.
 *
 * `brandedStyles(() => ({ ... }))` builds the sheet now and remembers how, so a
 * repaint can rebuild it from the new palette and refill the SAME object in
 * place: `styles.btn` keeps working everywhere, and reads the new entry at the
 * next render. Every stylesheet that reads a white-labelled token must take this
 * form, or it keeps the colour it was born with — `./brandedSheets.test.ts`
 * scans the app for one that does not.
 */

import { StyleSheet } from 'react-native';
import { onRepaintSheet } from './live';

export function brandedStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  build: () => T & StyleSheet.NamedStyles<any>,
): T {
  // Our own object: RN freezes each entry in dev, so the stable handle is ours.
  const target = { ...StyleSheet.create(build()) } as T;
  onRepaintSheet(() => {
    Object.assign(target as object, StyleSheet.create(build() as StyleSheet.NamedStyles<any>));
  });
  return target;
}
