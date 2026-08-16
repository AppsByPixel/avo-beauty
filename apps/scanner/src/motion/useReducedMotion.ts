/**
 * Reduced motion, read from the OS.
 *
 * interaction-spec.md §3, and the reason this is a hook rather than a constant:
 * the setting can change while the app is open, and a scanner left running on a
 * salon counter all day will not be relaunched to pick it up.
 *
 * On iOS this mirrors `UIAccessibility.isReduceMotionEnabled`; React Native's
 * AccessibilityInfo maps to it directly, and to
 * `ANIMATOR_DURATION_SCALE == 0` on Android — both named in the spec.
 *
 * WHAT THE FLAG MEANS ON THIS SURFACE
 * -----------------------------------
 * Not "run the animation faster". The spec is explicit for the one animation
 * this app owns:
 *
 *   "Scanner line: **remove entirely** — replace with a static frame and the
 *    text 'Point at the customer's code'. A looping line is the exact motion
 *    that triggers people."
 *
 * So `ScanScreen` does not render the line at all under this flag, and
 * `ResultScreen` renders its success mark and its receipt dot without the pop
 * and the pulse. The state change is never removed — only the animation
 * carrying it ("Never remove a state change — only the animation carrying it").
 */

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let alive = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReduced(value);
      })
      .catch(() => {
        // A platform that cannot answer is not a reason to start animating at
        // someone. Staying with the default (false) matches the OS default;
        // the subscription below still corrects it if the platform speaks up.
      });

    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setReduced(value);
    });

    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  return reduced;
}
