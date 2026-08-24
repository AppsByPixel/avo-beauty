/**
 * Reloading the app so `I18nManager.forceRTL` takes effect — iOS and Android.
 *
 * Metro resolves this file over `appReload.ts` on native. See that file's header
 * for the split and for why the dependency is `expo-updates` rather than
 * `react-native-restart`.
 *
 * `Updates.reloadAsync()` tears down and restarts the React root, which is what
 * makes Yoga re-read the RTL flag `forceRTL` wrote — the flag is read at bridge
 * start and never again, so nothing short of a reload turns the layout around.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `reloadAsync()` DOES NOT WORK IN EXPO GO OR IN DEV MODE, AND THAT IS DOCUMENTED
 * — expo-updates' own docstring says so: "This method cannot be used in Expo Go
 * or development mode, and the returned promise will be rejected if you try to
 * do so."
 *
 * Driven, before this fallback existed: tapping the control under Expo Go logged
 *
 *   ERROR [Error: Uncaught (in promise, id: 0): "Error: InvalidArgsNumberException:
 *   Received 1 arguments, but 0 was expected (at ExpoModulesCore/JavaScriptUtils.swift:17)"]
 *
 * — `ExpoUpdates.reload(null)` meeting a stub that takes none — and the screen
 * did not move. A button that appears to do nothing is the precise failure
 * `i18n/language.tsx` says is not acceptable, and shipping the control without
 * this would have reintroduced it for every developer and every driven run.
 *
 * `DevSettings.reload()` WAS TRIED AS THE DEV FALLBACK AND IS WORSE THAN NOTHING.
 * It reloads the RN bridge without reinitialising Expo Go's module registry, and
 * the app comes back broken rather than mirrored — driven:
 *
 *   ERROR [runtime not ready]: Error: Cannot find native module 'ExpoAsset'
 *   ERROR [runtime not ready]: Invariant Violation: "main" has not been registered.
 *
 * A fallback that turns a working app into a white screen, in the one environment
 * where it fires, is not a fallback. So dev gets a WARNING instead: the reload is
 * genuinely unavailable there, and saying so is better than pretending either way.
 *
 * AND IT COULD NOT DEMONSTRATE ANYTHING EVEN IF IT WORKED. Expo Go rewrites
 * `RCTI18nUtil_allowRTL` and `RCTI18nUtil_forceRTL` to false at every process
 * launch. Measured on an iPhone 17 simulator, reading Expo Go's own plist:
 *
 *   after the switch, app terminated →  allowRTL: true,  forceRTL: true
 *   after the next launch            →  allowRTL: false, forceRTL: false
 *
 * So the app writes the flag correctly and the host clears it. Mirroring can only
 * be seen end to end in a dev-client or a standalone build, where nothing resets
 * it. That is the environment, not this code.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * SHE TAPS IT. IT NEVER FIRES ON ITS OWN, and that constraint outranks the
 * convenience of an automatic reload: `i18n/language.tsx` argued that restarting
 * under her loses whatever she was doing, and in this app "whatever she was
 * doing" can be a live payment sitting at the bank. That argument did not expire
 * when the native build landed — it is exactly why `LanguageToggle` turns the
 * notice into a control rather than a timer.
 */

import * as Updates from 'expo-updates';

export async function reloadApp(): Promise<void> {
  try {
    await Updates.reloadAsync();
  } catch (err) {
    if (__DEV__) {
      // Expected here, and named rather than swallowed: a developer who taps the
      // control and sees nothing move deserves the reason on the console.
      console.warn(
        '[avo] Updates.reloadAsync() is unavailable in Expo Go and in development. ' +
          'The RTL flag has been written; relaunch the app to see the layout mirror. ' +
          'Note Expo Go also clears the flag at launch — use a dev-client or a ' +
          'standalone build to see it take effect. See platform/appReload.native.ts.',
        err,
      );
      return;
    }
    throw err;
  }
}
