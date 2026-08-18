/**
 * The notification hook's guards, driven for real.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE SUBSTITUTES REACT'S HOOKS INSTEAD OF RENDERING A COMPONENT
 *
 * There is no renderer in this workspace: no jsdom, no @testing-library, and
 * react-test-renderer is gone in React 19. Adding one is not a lane B decision —
 * a devDependency here rewrites the root `pnpm-lock.yaml`, which is trunk-owned
 * and consumed by four surfaces, so it is a trunk operation and not something a
 * test file should trigger. (CLAUDE.md § Lanes.)
 *
 * So the four hooks this module uses are replaced with a ~90-line runtime that
 * models the semantics the guards actually depend on:
 *
 *   useState     value + setter, updater form supported, re-render scheduled
 *   useRef       one stable object across renders
 *   useCallback  dependency-compared, because the read effect takes `applyPrefs`
 *                as a dependency and a fresh identity each render would re-fire
 *                it forever
 *   useEffect    runs after commit, dependency-compared, cleanup honoured
 *
 * IT MODELS ONE MORE THING ON PURPOSE: `strictUpdaters`. React may invoke a
 * state updater twice and StrictMode does exactly that in development. That is
 * not a detail — it is the shape of one of the two defects this hook was fixed
 * for. The PATCH used to be fired INSIDE a `setPrefs` updater, so one tap on
 * `offers` sent TWO consent writes. A renderer-based test would only catch that
 * under StrictMode; here it is a switch this file can turn on and assert
 * against, which is why this runtime is a better instrument for these two bugs
 * than a DOM would be.
 *
 * WHAT IT DELIBERATELY DOES NOT MODEL: concurrent rendering, batching windows,
 * suspense, or anything about the view. Those belong to a renderer, and the
 * assertions below do not depend on them.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ------------------------------------------------------------- hook runtime --

type Cell =
  | { kind: 'state'; value: unknown }
  | { kind: 'ref'; ref: { current: unknown } }
  | { kind: 'cb'; deps: unknown[]; fn: unknown }
  | { kind: 'effect'; deps: unknown[] | undefined; cleanup: (() => void) | undefined };

class Host {
  cells: Cell[] = [];
  index = 0;
  /** Effects queued by the render that just finished. */
  queue: Array<() => void> = [];
  renders = 0;
  body: (() => unknown) | null = null;
  last: unknown;
  /** Emulate React invoking a state updater twice. See the header. */
  strictUpdaters = false;

  render(): unknown {
    this.index = 0;
    this.renders++;
    this.last = this.body!();
    // Effects run after the commit, in order.
    const queued = this.queue;
    this.queue = [];
    for (const run of queued) run();
    return this.last;
  }

  /** Re-render until the tree settles, then let pending promises land. */
  async settle(): Promise<void> {
    for (let i = 0; i < 50 && this.dirty; i++) {
      this.dirty = false;
      this.render();
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    if (this.dirty) await this.settle();
  }

  dirty = false;
}

let host: Host;

function cell<T extends Cell>(make: () => T): T {
  const existing = host.cells[host.index];
  if (existing) {
    host.index++;
    return existing as T;
  }
  const created = make();
  host.cells[host.index] = created;
  host.index++;
  return created;
}

function depsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (!a || !b) return false;
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

vi.mock('react', () => ({
  useState<T>(initial: T) {
    const slot = cell<Extract<Cell, { kind: 'state' }>>(() => ({ kind: 'state', value: initial }));
    const set = (next: T | ((prev: T) => T)) => {
      if (typeof next === 'function') {
        const updater = next as (prev: T) => T;
        // React is free to call this twice; StrictMode does. If the hook put a
        // side effect in here, this is where it doubles.
        if (host.strictUpdaters) updater(slot.value as T);
        slot.value = updater(slot.value as T);
      } else {
        slot.value = next;
      }
      host.dirty = true;
    };
    return [slot.value as T, set];
  },
  useRef<T>(initial: T) {
    return cell<Extract<Cell, { kind: 'ref' }>>(() => ({ kind: 'ref', ref: { current: initial } }))
      .ref as { current: T };
  },
  useCallback<T>(fn: T, deps: unknown[]) {
    const slot = cell<Extract<Cell, { kind: 'cb' }>>(() => ({ kind: 'cb', deps, fn }));
    if (!depsEqual(slot.deps, deps)) {
      slot.deps = deps;
      slot.fn = fn;
    }
    return slot.fn as T;
  },
  useEffect(fn: () => void | (() => void), deps?: unknown[]) {
    const slot = cell<Extract<Cell, { kind: 'effect' }>>(() => ({
      kind: 'effect',
      deps: undefined,
      cleanup: undefined,
    }));
    const first = slot.deps === undefined;
    if (first || !depsEqual(slot.deps, deps)) {
      slot.deps = deps;
      host.queue.push(() => {
        slot.cleanup?.();
        const cleanup = fn();
        slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
      });
    }
  },
}));

// ------------------------------------------------------------------- the API --

const getNotifications = vi.fn();
const patchNotifications = vi.fn();

vi.mock('../api/account', () => ({
  get getNotifications() {
    return getNotifications;
  },
  get patchNotifications() {
    return patchNotifications;
  },
}));

const { useNotificationPreferences, DEFAULT_PREFERENCES } = await import('./notifications');
const { ApiError } = await import('../api/client');

/** The server's shape, with every switch the opposite of DEFAULT_PREFERENCES. */
function serverResponse(over: Partial<Record<string, boolean>> = {}) {
  return {
    push: false,
    wa: false,
    remind: false,
    receipt: false,
    offers: true,
    offersConsent: {
      granted: true,
      at: '2026-08-18T07:56:19.015Z',
      source: 'wallet_account',
      policyVersion: 3,
    },
    ...over,
  };
}

type State = ReturnType<typeof useNotificationPreferences>;

async function mount(): Promise<{ current: () => State; host: Host }> {
  host = new Host();
  host.body = () => useNotificationPreferences(true);
  host.render();
  await host.settle();
  return { current: () => host.last as State, host };
}

beforeEach(() => {
  getNotifications.mockReset();
  patchNotifications.mockReset();
});

// --------------------------------------------------------------------- read --

describe('the read', () => {
  it('takes the five switches from the server, not from DEFAULT_PREFERENCES', async () => {
    getNotifications.mockResolvedValue(serverResponse());
    const { current } = await mount();

    expect(current().loadFailed).toBe(false);
    expect(current().prefs).toEqual({
      push: false,
      wa: false,
      remind: false,
      receipt: false,
      offers: true,
    });
    // Every value above differs from the constant, so a hook that quietly kept
    // its defaults could not produce this.
    expect(current().prefs).not.toEqual(DEFAULT_PREFERENCES);
  });

  it('draws NO switches when the read fails — five defaults are not her settings', async () => {
    getNotifications.mockRejectedValue(
      new ApiError('server', 'nope', 'WLT-0000-0000', 500, 'internal', {}),
    );
    const { current } = await mount();

    expect(current().loadFailed).toBe(true);
    // `offers` is marketing consent. A screen that renders it from a constant is
    // stating an answer the customer never gave, which is why the section shows
    // a retry instead of switches — asserted here at the state, and in the
    // Account screen by `loadFailed` gating the whole card.
    expect(current().offersConsent).toBeNull();
  });

  it('recovers on reload()', async () => {
    getNotifications.mockRejectedValueOnce(
      new ApiError('server', 'nope', 'WLT-0000-0000', 500, 'internal', {}),
    );
    const { current, host: h } = await mount();
    expect(current().loadFailed).toBe(true);

    getNotifications.mockResolvedValue(serverResponse());
    current().reload();
    await h.settle();

    expect(current().loadFailed).toBe(false);
    expect(current().prefs.offers).toBe(true);
  });
});

// ------------------------------------------------------------ the write path --

describe('toggle', () => {
  it('PATCHes ONE key, not all five', async () => {
    getNotifications.mockResolvedValue(serverResponse());
    patchNotifications.mockResolvedValue(serverResponse({ receipt: true }));
    const { current, host: h } = await mount();

    current().toggle('receipt');
    await h.settle();

    expect(patchNotifications).toHaveBeenCalledTimes(1);
    expect(patchNotifications).toHaveBeenCalledWith({ receipt: true });
  });

  it('a double tap sends ONE PATCH — two consent writes is two answers to one question', async () => {
    getNotifications.mockResolvedValue(serverResponse({ offers: false }));
    let release!: (v: unknown) => void;
    patchNotifications.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    const { current, host: h } = await mount();

    // Both taps land before any re-render, which is exactly what a fast finger
    // does. `saving` state lags a render, so only the synchronous ref can stop
    // the second one.
    current().toggle('offers');
    current().toggle('offers');
    await h.settle();

    expect(patchNotifications).toHaveBeenCalledTimes(1);
    expect(patchNotifications).toHaveBeenCalledWith({ offers: true });

    release(serverResponse({ offers: true }));
    await h.settle();
    expect(current().prefs.offers).toBe(true);
  });

  it('still sends ONE PATCH when React invokes state updaters twice (StrictMode)', async () => {
    getNotifications.mockResolvedValue(serverResponse({ offers: false }));
    patchNotifications.mockResolvedValue(serverResponse({ offers: true }));
    const { current, host: h } = await mount();

    h.strictUpdaters = true;
    current().toggle('offers');
    await h.settle();

    // The PATCH must be fired in the handler, not inside a `setPrefs` updater.
    // If it moves back inside one, this is 2.
    expect(patchNotifications).toHaveBeenCalledTimes(1);
  });

  it('marks only the tapped row as saving, so the other four stay live', async () => {
    getNotifications.mockResolvedValue(serverResponse());
    let release!: (v: unknown) => void;
    patchNotifications.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    const { current, host: h } = await mount();

    current().toggle('push');
    await h.settle();

    expect(current().saving).toEqual(['push']);

    release(serverResponse({ push: true }));
    await h.settle();
    expect(current().saving).toEqual([]);
  });

  it('moves the switch optimistically, then follows the server', async () => {
    getNotifications.mockResolvedValue(serverResponse({ wa: false }));
    let release!: (v: unknown) => void;
    patchNotifications.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    const { current, host: h } = await mount();

    current().toggle('wa');
    await h.settle();
    expect(current().prefs.wa).toBe(true); // optimistic

    // The server is allowed to disagree, and when it does the screen follows it.
    release(serverResponse({ wa: false }));
    await h.settle();
    expect(current().prefs.wa).toBe(false);
  });

  it('puts the switch BACK when the write fails, and says which one', async () => {
    getNotifications.mockResolvedValue(serverResponse({ wa: false }));
    patchNotifications.mockRejectedValue(
      new ApiError('server', 'nope', 'WLT-0000-0000', 500, 'internal', {}),
    );
    const { current, host: h } = await mount();

    current().toggle('wa');
    await h.settle();

    expect(current().prefs.wa).toBe(false);
    expect(current().writeFailed).toBe('wa');
    // A failed write must not strand the row as permanently inert.
    expect(current().saving).toEqual([]);
  });

  it('clears a previous failure when she tries again', async () => {
    getNotifications.mockResolvedValue(serverResponse({ wa: false }));
    patchNotifications.mockRejectedValueOnce(
      new ApiError('server', 'nope', 'WLT-0000-0000', 500, 'internal', {}),
    );
    const { current, host: h } = await mount();

    current().toggle('wa');
    await h.settle();
    expect(current().writeFailed).toBe('wa');

    patchNotifications.mockResolvedValue(serverResponse({ wa: true }));
    current().toggle('wa');
    await h.settle();

    expect(current().writeFailed).toBeNull();
    expect(current().prefs.wa).toBe(true);
  });
});
