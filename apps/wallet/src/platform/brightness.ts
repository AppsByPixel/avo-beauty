/**
 * Raising the screen while the enlarged payment code is up, and putting it back.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS AT ALL: THE COPY ALREADY PROMISED IT.
 *
 * `qrBigSub` is "Screen brightened for scanning" / "تم رفع الإضاءة لتسهيل المسح",
 * design:1172 and :1279, frozen in both languages. It shipped as a sentence with
 * nothing behind it. On a handset that is an ordinary promise and it was
 * visibly false — a dim phone held up to a scanner is the exact moment the
 * sentence is describing.
 *
 * WHY IT IS A PLAIN OBJECT AND NOT A HOOK, AND WHY THIS FILE IMPORTS NOTHING.
 *
 * The interesting part is not "call setBrightnessAsync". It is putting the level
 * back, and the way that goes wrong is a battery complaint rather than a visible
 * bug: raise twice without an intervening restore and the second capture records
 * the ALREADY-RAISED level, so restore leaves the phone at full brightness
 * having reported success. That is a rule, it is testable, and this workspace
 * has no renderer — so it lives here with a spec, with no React and no native
 * module anywhere near it. `screenBoost.native.ts` binds it to the platform and
 * `screenBoost.ts` is the web no-op; neither is loaded by these tests.
 *
 * OPERATIONS SERIALISE, AND THAT IS LOAD-BEARING. The overlay does not always
 * close: when the wallet goes offline or the next token mint fails, `HomeScreen`
 * stops rendering `QrOverlay` and the component UNMOUNTS. A restore that arrives
 * while a raise is still awaiting its read must not be lost, or the screen stays
 * bright with nothing on it.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/** The two calls this needs from the platform. Injected so it can be tested. */
export interface BrightnessDriver {
  get(): Promise<number>;
  set(value: number): Promise<void>;
}

export interface BrightnessBoost {
  raise(): Promise<void>;
  restore(): Promise<void>;
  /** The level captured before the raise, or null when nothing is raised. */
  captured(): number | null;
}

/** Full. The design's phrase is "brightened", and a scanner wants the maximum. */
const BOOSTED = 1;

/**
 * @param driver null on web, where there is no screen brightness to set and
 *        pulling a native module into the bundle is the thing `i18n/language.tsx`
 *        was right to worry about. Every operation is then a no-op.
 */
export function createBrightnessBoost(
  driver: BrightnessDriver | null,
  boostedLevel: number = BOOSTED,
): BrightnessBoost {
  let previous: number | null = null;
  // Every operation appends to this, so raise and restore can never interleave.
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (op: () => Promise<void>): Promise<void> => {
    // A rejection must not poison the chain for every later operation.
    queue = queue.then(op, op);
    return queue;
  };

  return {
    raise: () =>
      enqueue(async () => {
        if (!driver) return;
        // Already raised. Re-capturing here is THE bug — see the header.
        if (previous !== null) return;
        let level: number;
        try {
          level = await driver.get();
        } catch {
          // Unreadable, so nothing is changed and nothing is remembered: a
          // capture we never measured would be restored as an invented level.
          return;
        }
        try {
          await driver.set(boostedLevel);
        } catch {
          // The screen never changed, so there is nothing to undo. Keeping the
          // capture would make `restore` claim to have reversed something.
          return;
        }
        previous = level;
      }),

    restore: () =>
      enqueue(async () => {
        if (!driver) return;
        if (previous === null) return;
        const level = previous;
        // Cleared FIRST, so a failed write cannot leave a stale capture that a
        // later raise would refuse to replace.
        previous = null;
        try {
          await driver.set(level);
        } catch {
          /* the OS refused; there is nothing further this can do about it */
        }
      }),

    captured: () => previous,
  };
}
