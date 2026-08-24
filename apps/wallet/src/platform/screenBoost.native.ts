/**
 * Raising the screen for the enlarged payment code — iOS and Android.
 *
 * Metro resolves this file over `screenBoost.ts` on native. See that file's
 * header for why the split is a platform-suffixed module rather than a
 * `Platform.OS` branch.
 *
 * `getBrightnessAsync` / `setBrightnessAsync` are the APP's brightness and need
 * no permission on either platform. The `*SystemBrightness*` family is Android
 * only, needs `WRITE_SETTINGS`, and is deliberately NOT used: a wallet that
 * permanently changes the phone's system brightness is not what
 * "Screen brightened for scanning" promises, and asking for a settings-write
 * permission to show a QR code would be worse than the dim screen it fixes.
 *
 * On iOS the OS restores the level itself when the app backgrounds, which is a
 * safety net under the explicit restore rather than a substitute for it — the
 * overlay closes far more often than the app backgrounds.
 */

import * as Brightness from 'expo-brightness';
import type { BrightnessDriver } from './brightness';
import { useScreenBoostWith } from './useScreenBoostWith';

const driver: BrightnessDriver = {
  get: () => Brightness.getBrightnessAsync(),
  set: (value) => Brightness.setBrightnessAsync(value),
};

export function useScreenBoost(active: boolean): void {
  useScreenBoostWith(active, driver);
}
