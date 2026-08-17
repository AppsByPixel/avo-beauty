/**
 * `dataSet` — react-native-web's documented escape hatch for emitting a
 * `data-*` attribute, which React Native's own typings do not know about
 * because on native there is nothing to emit it to.
 *
 * It is declared here rather than cast away at each call site because the app
 * needs exactly one thing from it and needs it to be type-checked: the focus
 * ring's opt-in marker (`data-avo-focus="ring"`). A pseudo-class cannot live in
 * a React Native style object, so the ring is real CSS keyed off this attribute
 * — see src/theme/focus.ts.
 *
 * On native the prop is passed through and ignored, which is why it is optional
 * rather than platform-gated.
 */

import 'react-native';

declare module 'react-native' {
  interface PressableProps {
    dataSet?: Record<string, string>;
  }
  interface ViewProps {
    dataSet?: Record<string, string>;
  }
}

/*
 * `SwitchProps` was augmented here too, for react-native-web's `activeThumbColor`
 * / `activeTrackColor` — its Switch paints its own stock teal thumb (#009688)
 * unless the ON pair is named separately. That augmentation is gone because the
 * component is: the same Switch mispositions its thumb outside the track under
 * `dir="rtl"`, so the app draws its own. See components/account/Rows.tsx §Toggle.
 */
