/**
 * The React shell over `createBrightnessBoost`, shared by both platform files.
 *
 * Deliberately tiny, and deliberately not where any rule lives: everything that
 * can be got wrong about raising and restoring the screen is in `brightness.ts`,
 * which has a spec. What is here is the one thing a spec cannot express — that
 * the restore happens in an effect CLEANUP.
 *
 * That matters because the overlay does not always close. When the wallet drops
 * offline or the next token mint fails, `HomeScreen` stops rendering
 * `QrOverlay` altogether and the component UNMOUNTS without `open` ever going
 * false. A restore hung off an `open === false` transition would never run, and
 * the phone would sit at full brightness after the code disappeared.
 */

import { useEffect, useRef } from 'react';
import { createBrightnessBoost, type BrightnessBoost, type BrightnessDriver } from './brightness';

export function useScreenBoostWith(active: boolean, driver: BrightnessDriver | null): void {
  const boostRef = useRef<BrightnessBoost | null>(null);
  if (boostRef.current === null) boostRef.current = createBrightnessBoost(driver);
  const boost = boostRef.current;

  useEffect(() => {
    if (!active) return;
    void boost.raise();
    // Runs when `active` goes false AND on unmount. The queue inside the boost
    // is what makes the unmount case safe when the raise has not settled yet.
    return () => {
      void boost.restore();
    };
  }, [active, boost]);
}
