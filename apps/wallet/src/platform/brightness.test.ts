/**
 * Raising the screen for the enlarged payment code — and putting it back.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BUG THIS FILE EXISTS TO PREVENT IS A BATTERY COMPLAINT, NOT A BLANK SCREEN.
 *
 * `qrBigSub` reads "Screen brightened for scanning" in both languages. Making
 * that true is one line. Making it *reversible* is the part that goes wrong, and
 * it goes wrong in a specific way: raise twice without restoring in between, and
 * the second capture records the ALREADY-RAISED level. Restore then puts the
 * screen back to 1.0 and the phone sits at full brightness for the rest of the
 * day, having been told it was restored.
 *
 * The overlay can be opened and closed quickly, and it can also vanish without a
 * close: when the wallet drops offline or the next token mint fails,
 * `HomeScreen` stops rendering `QrOverlay` entirely and the component UNMOUNTS.
 * So restore has to survive an unmount that lands mid-raise, which is why these
 * operations serialise rather than racing.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it, vi } from 'vitest';
import { createBrightnessBoost, type BrightnessDriver } from './brightness';

/** A driver that records every set, and can be made to fail on demand. */
function fakeDriver(initial = 0.4) {
  const sets: number[] = [];
  let current = initial;
  let failGet = false;
  let failSet = false;
  const driver: BrightnessDriver = {
    get: async () => {
      if (failGet) throw new Error('no brightness permission');
      return current;
    },
    set: async (v) => {
      if (failSet) throw new Error('set refused');
      current = v;
      sets.push(v);
    },
  };
  return {
    driver,
    sets,
    now: () => current,
    breakGet: () => {
      failGet = true;
    },
    breakSet: () => {
      failSet = true;
    },
  };
}

describe('raise and restore', () => {
  it('captures the level, raises to full, and puts back exactly what it found', async () => {
    const f = fakeDriver(0.35);
    const boost = createBrightnessBoost(f.driver);

    await boost.raise();
    expect(f.now()).toBe(1);
    expect(boost.captured()).toBe(0.35);

    await boost.restore();
    expect(f.now()).toBe(0.35);
    expect(boost.captured()).toBeNull();
  });

  /**
   * THE BATTERY BUG. Two raises, one restore.
   *
   * Without the guard the second `raise()` captures 1 — the level the first one
   * set — and `restore()` then "restores" the screen to full.
   */
  it('does not re-capture while already raised', async () => {
    const f = fakeDriver(0.3);
    const boost = createBrightnessBoost(f.driver);

    await boost.raise();
    await boost.raise();
    expect(boost.captured()).toBe(0.3);

    await boost.restore();
    expect(f.now()).toBe(0.3);
  });

  it('re-captures on a LATER raise, so a second showing restores correctly too', async () => {
    const f = fakeDriver(0.3);
    const boost = createBrightnessBoost(f.driver);

    await boost.raise();
    await boost.restore();
    // She dims the phone between the two showings.
    await f.driver.set(0.1);
    await boost.raise();
    expect(boost.captured()).toBe(0.1);
    await boost.restore();
    expect(f.now()).toBe(0.1);
  });

  it('is a no-op to restore something that was never raised', async () => {
    const f = fakeDriver(0.5);
    const boost = createBrightnessBoost(f.driver);

    await boost.restore();
    expect(f.sets).toEqual([]);
    expect(f.now()).toBe(0.5);
  });
});

describe('when the platform refuses', () => {
  it('touches nothing at all on web, where there is no driver', async () => {
    const boost = createBrightnessBoost(null);
    await boost.raise();
    await boost.restore();
    expect(boost.captured()).toBeNull();
  });

  /**
   * A failed READ must not leave a capture behind. If it did, `restore()` would
   * later write a level nobody ever measured.
   */
  it('does not raise, and has nothing to restore, when the level cannot be read', async () => {
    const f = fakeDriver(0.4);
    f.breakGet();
    const boost = createBrightnessBoost(f.driver);

    await boost.raise();
    expect(f.sets).toEqual([]);
    expect(boost.captured()).toBeNull();

    await boost.restore();
    expect(f.sets).toEqual([]);
  });

  /**
   * A failed WRITE means the screen never changed, so there is nothing to undo.
   * Keeping the capture would make `restore()` set a level the screen is already
   * at — harmless today, and a lie about what this object did.
   */
  it('drops the capture when the raise itself fails', async () => {
    const f = fakeDriver(0.4);
    const boost = createBrightnessBoost(f.driver);
    f.breakSet();

    await boost.raise();
    expect(boost.captured()).toBeNull();
  });
});

describe('an unmount that lands mid-raise', () => {
  /**
   * The overlay does not always close — when the token mint fails it is removed
   * from the tree. If `restore()` ran while `raise()` was still awaiting its
   * read, an unserialised implementation would restore nothing and then finish
   * raising, leaving the screen at full brightness on a screen that is gone.
   */
  it('still restores when restore is called before raise has settled', async () => {
    let releaseGet: (v: number) => void = () => {};
    let sawGet: () => void = () => {};
    // Resolved when the driver's read is actually IN FLIGHT. Without this the
    // test released a promise that did not exist yet: `enqueue` defers the
    // operation to a microtask, so a synchronous `releaseGet` runs before `get`
    // has been called and the raise hangs forever. That was a bug in this test,
    // not in the queue — worth the four extra lines, because the version without
    // them fails in a way that reads exactly like a deadlock in the subject.
    const getCalled = new Promise<void>((resolve) => {
      sawGet = resolve;
    });
    const sets: number[] = [];
    const driver: BrightnessDriver = {
      get: () => {
        sawGet();
        return new Promise<number>((resolve) => {
          releaseGet = resolve;
        });
      },
      set: async (v) => void sets.push(v),
    };
    const boost = createBrightnessBoost(driver);

    const raising = boost.raise();
    await getCalled; // the raise is now suspended inside `get`
    const restoring = boost.restore(); // queued behind it, must not be lost
    releaseGet(0.25);
    await Promise.all([raising, restoring]);

    expect(sets).toEqual([1, 0.25]);
    expect(boost.captured()).toBeNull();
  });

  it('serialises a rapid open/close/open so the last word is the raise', async () => {
    const f = fakeDriver(0.2);
    const boost = createBrightnessBoost(f.driver);

    await Promise.all([boost.raise(), boost.restore(), boost.raise()]);
    expect(f.now()).toBe(1);
    expect(boost.captured()).toBe(0.2);

    await boost.restore();
    expect(f.now()).toBe(0.2);
  });
});
