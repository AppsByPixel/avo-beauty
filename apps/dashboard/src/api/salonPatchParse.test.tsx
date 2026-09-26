// @vitest-environment jsdom

/**
 * `PATCH /salons/{id}` — the body, checked before it reaches the cache the shell
 * reads.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `useUpdateSalon` spent this whole project paying a round trip to avoid a cast.
 * Its own comment said why, and named the exit: nothing parsed the body, "a cast
 * is not a check", and "adding [a parser] is the slice that would also let this
 * hook `setQueryData`". The crash it was defending against is on the record — a
 * raw Drizzle row went into `salonKeys.detail`, `salon.branches[0]` threw, and
 * the whole dashboard went to its error boundary on every settings change.
 *
 * So the defence is now a parse, and the round trip is gone. These are the
 * properties that makes safe.
 *
 * THE RULE WORTH MORE THAN THE REST
 * ---------------------------------
 * `SalonSchema.parse` ALONE WOULD HAVE BROKEN EVERY SETTINGS CHANGE, and the
 * fixture below is built to prove it rather than to agree with the schema.
 * `serialiseSalon` emits the dormant loyalty mode's fields as JSON null against
 * an `.optional()` schema, so a tiers salon's `stampTarget` arrives null and a
 * bare `.parse` refuses it. `platformSalons.ts` found that first and reported it
 * to trunk; `parseSalon` declares the divergence narrowly and folds null back to
 * undefined. A test written from the schema instead of from the wire would have
 * passed and shipped a hook that throws on contact with the API.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const { parseSalon, salonKeys, useSalon } = await import('./salon.js');
const { useUpdateSalon } = await import('./settings.js');
type Salon = import('@avo/types').Salon;

afterEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------- the bodies -- */

/**
 * `serialiseSalon`'s twenty keys, field for field — a PLAIN OBJECT, because the
 * subject here is what arrives before anything has proved it is a Salon.
 *
 * A TIERS SALON WITH NULL STAMP FIELDS, which is what the API actually sends and
 * what `SalonSchema` alone refuses. `packages/mock`'s fixture carries both modes
 * populated and would not have exercised this.
 */
const SALON_BODY: Record<string, unknown> = {
  id: 'SAL-AMARA',
  name: 'Amara',
  nameAr: 'أمارا',
  plan: 'growth',
  city: 'Kuwait City',
  brandColor: '#6E7F6C',
  modules: { booking: false, shop: false },
  loyaltyMode: 'tiers',
  tiers: [
    { name: 'bronze', minVisits: 0, bonusPercent: 0 },
    { name: 'silver', minVisits: 4, bonusPercent: 10 },
  ],
  stampTarget: null,
  stampReward: null,
  stampRewardAr: null,
  depositFils: 5000,
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  branches: [{ id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية' }],
  social: [{ id: 'instagram', label: 'Instagram', handle: '@amara.kw', on: true }],
  whatsappEnabled: true,
  emailEnabled: true,
};

/** The other mode, mirrored: a stamps salon whose tier ladder is null. */
const STAMPS_BODY: Record<string, unknown> = {
  ...SALON_BODY,
  loyaltyMode: 'stamps',
  tiers: null,
  stampTarget: 8,
  stampReward: 'Free blow-dry',
  stampRewardAr: 'تصفيف شعر مجاني',
};

function without(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...body };
  delete copy[key];
  return copy;
}

/* ========================================================================== */
describe('the wire’s salon, not the schema’s', () => {
  /**
   * THE CASE THAT WOULD HAVE SHIPPED A BROKEN HOOK. Driven from `serialiseSalon`
   * rather than from `SalonSchema`, because the two disagree and the wire wins.
   */
  it('accepts a tiers salon whose stamp fields are null, as the API sends it', () => {
    const salon = parseSalon(SALON_BODY);
    expect(salon.loyaltyMode).toBe('tiers');
    expect(salon.tiers).toHaveLength(2);
    // Folded to undefined: `Salon` spells "not in that mode" that way, the wire
    // spells it null, and the fold happens once rather than at every reader.
    expect(salon.stampTarget).toBeUndefined();
    expect(salon.stampReward).toBeUndefined();
    expect('stampTarget' in salon).toBe(true);
  });

  it('accepts a stamps salon whose tier ladder is null, the mirror case', () => {
    const salon = parseSalon(STAMPS_BODY);
    expect(salon.tiers).toBeUndefined();
    expect(salon.stampTarget).toBe(8);
  });

  /** The dormant side is kept, not dropped — the server preserves it across a switch. */
  it('keeps a populated dormant side rather than nulling it out', () => {
    const salon = parseSalon({ ...SALON_BODY, stampTarget: 8, stampReward: 'Free blow-dry' });
    expect(salon.stampTarget).toBe(8);
    expect(salon.tiers).toHaveLength(2);
  });
});

/* ========================================================================== */
/**
 * TABLE-DRIVEN OFF THE BODY, so a twenty-first key added to `serialiseSalon` is
 * covered the day this fixture learns about it.
 */
describe('a body missing any required key is a failed write', () => {
  /*
   * FIVE KEYS MAY BE ABSENT, FOR THREE DIFFERENT REASONS, AND THE LIST IS
   * WRITTEN DOWN RATHER THAN DISCOVERED. Removing a field from this set is then a
   * visible edit in a diff, instead of a case that quietly stopped being covered.
   *
   *   tiers, stampTarget, stampReward   the DORMANT loyalty mode. Absent and null
   *                                     both mean "this salon is not in that
   *                                     mode", which is the whole reason
   *                                     `parseSalon` folds one into the other.
   *   stampRewardAr                     `.optional()` in the shared schema: a
   *                                     reward with no Arabic copy is a real
   *                                     salon, not a broken response.
   *   timezone                          `.default('Asia/Kuwait')` in the shared
   *                                     schema, so an omitted key is DEFAULTED
   *                                     and not refused. Trunk's decision, left
   *                                     alone — overriding it here would be this
   *                                     surface disagreeing with the contract.
   *                                     Named so nobody mistakes the default for
   *                                     a check.
   */
  const ABSENCE_IS_LEGAL = new Set([
    'tiers',
    'stampTarget',
    'stampReward',
    'stampRewardAr',
    'timezone',
  ]);

  for (const key of Object.keys(SALON_BODY).filter((k) => !ABSENCE_IS_LEGAL.has(k))) {
    it(`refuses a salon with no ${key}`, () => {
      expect(() => parseSalon(without(SALON_BODY, key))).toThrow();
    });
  }

  for (const key of [...ABSENCE_IS_LEGAL]) {
    it(`admits a salon with no ${key}, which the contract allows`, () => {
      expect(() => parseSalon(without(SALON_BODY, key))).not.toThrow();
    });
  }

  /**
   * THE ACTIVE SIDE IS STILL REQUIRED. "Absent is legal" above is about the
   * DORMANT mode; a tiers salon that came back with no ladder at all is a broken
   * response, and `platformSalons.ts` says what it costs — an editor rendering
   * four rungs of `undefined` with working steppers, inviting somebody to publish
   * a ladder built from nothing.
   *
   * REPORTED, NOT ENFORCED HERE. `SalonSchema` does not express the cross-field
   * rule and `packages/types` is trunk-owned, so `parseSalon` does not invent it
   * either — this pins today's behaviour so the day trunk adds the rule, this
   * line is what says so.
   */
  it('does not yet refuse a tiers salon with no ladder — reported, not enforced', () => {
    expect(() => parseSalon({ ...SALON_BODY, loyaltyMode: 'tiers', tiers: null })).not.toThrow();
  });

  it('refuses a raw Drizzle row — the shape that caused the original crash', () => {
    // No `branches`, no `modules`; the column spellings instead. `salon.branches[0]`
    // on this is what took the whole dashboard to its error boundary.
    const { branches: _b, modules: _m, ...rest } = SALON_BODY;
    expect(() =>
      parseSalon({ ...rest, moduleBooking: false, moduleShop: false, createdAt: 'x' }),
    ).toThrow();
  });

  /** #1. The deposit is money and the shared schema's bound is not relaxed here. */
  it('refuses a deposit that is not integer fils inside the contract’s bound', () => {
    expect(() => parseSalon({ ...SALON_BODY, depositFils: 5000.5 })).toThrow();
    expect(() => parseSalon({ ...SALON_BODY, depositFils: 999 })).toThrow();
  });
});

/* ========================================================================== */
/**
 * `useSalon` IS MOUNTED BESIDE THE MUTATION, AND IT IS NOT DECORATION.
 *
 * An `invalidateQueries` against a key nothing is observing refetches nothing, so
 * a rig holding only the mutation cannot tell "wrote the response into the cache"
 * apart from "invalidated and hoped" — measured: adding the forbidden
 * `onError: () => invalidateQueries(...)` left every assertion here green. With a
 * live observer the invalidate becomes a REQUEST, and the call count is what
 * catches it. The screen has that observer; the test now has it too.
 */
function rig() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => ({ update: useUpdateSalon(), salon: useSalon() }), {
    wrapper,
  });
  const cached = () => client.getQueryData<Salon>(salonKeys.detail('SAL-AMARA'));
  const gets = () =>
    authedRequest.mock.calls.filter((c) => (c[2] as { method?: string } | undefined)?.method === undefined)
      .length;
  return { client, result, cached, gets };
}

describe('the saved salon goes into the cache, and an unreadable one does not', () => {
  /**
   * THE ROUND TRIP IS GONE. The old hook invalidated and refetched on every
   * settings change; this asserts the response itself lands, which is the whole
   * point of the parser existing.
   */
  it('writes the parsed response straight into the cache, with no second request', async () => {
    authedRequest.mockResolvedValue(SALON_BODY);
    const { result, cached, gets } = rig();
    await waitFor(() => expect(result.current.salon.isSuccess).toBe(true));
    const getsBefore = gets();

    await act(async () => {
      await result.current.update.mutateAsync({ name: 'Amara' });
    });

    expect(cached()?.name).toBe('Amara');
    expect(cached()?.branches).toHaveLength(1);
    // The round trip is GONE. A refetch would be one more GET than the mount's.
    expect(gets()).toBe(getsBefore);
  });

  /**
   * AN UNREADABLE BODY IS A FAILED WRITE, AND IS NOT CAUGHT. There is deliberately
   * no fall-back to `invalidateQueries`: that would restore the old round trip
   * while claiming the parser replaced it, and would report a write whose result
   * cannot be read as one that succeeded.
   */
  it('a body that is not a salon fails the mutation and does not refetch to hide it', async () => {
    authedRequest.mockResolvedValue(SALON_BODY);
    const { client, result, cached, gets } = rig();
    await waitFor(() => expect(result.current.salon.isSuccess).toBe(true));
    const previous = parseSalon(SALON_BODY);
    client.setQueryData(salonKeys.detail('SAL-AMARA'), previous);
    const getsBefore = gets();

    authedRequest.mockResolvedValue(without(SALON_BODY, 'branches'));
    await act(async () => {
      await result.current.update.mutateAsync({ name: 'Amara' }).catch(() => {});
    });

    await waitFor(() => expect(result.current.update.isError).toBe(true));
    // The salon the shell is rendering is untouched — not blanked, not replaced.
    expect(cached()).toEqual(previous);
    /*
     * AND NOTHING WENT BACK TO ASK AGAIN. An `onError` that invalidated would
     * restore the old round trip while claiming the parser had replaced it, and
     * would turn a write whose result is unreadable into one that looks fine.
     */
    expect(gets()).toBe(getsBefore);
  });
});
