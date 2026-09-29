// @vitest-environment jsdom

/**
 * MARKETING → BRANCH BOOSTS: NO TOP-UP BONUS, A DURATION, A STATE, AND A STOP.
 *
 * Aftab, 2026-09-29: "Duration and stop option in the branch boost in the
 * marketing on dashboard", and the same day's ruling that branch boosts lose the
 * top-up bonus the server never paid. Lane A's 6d102c5 is the API.
 *
 *   1. NO TOP-UP STEPPER, and every branch goes out with `topup: 0`.
 *   2. THE WINDOW IS SENT AS ZONED INSTANTS, typed in the SALON's clock. The
 *      process is pinned to Karachi (+05:00) and the salon is Kuwait (+03:00), so
 *      nothing here can pass by the browser's zone happening to be the salon's.
 *   3. EACH STATE RENDERS — Live, Scheduled, Ended, Stopped, Off — resolved with
 *      `isBoostLive` against a frozen now.
 *   4. STOP CONFIRMS FIRST, and each of its three 409s lands on the row.
 *   5. A STOP RESEEDS THE ROW FROM ITS RESPONSE, although it does not bump
 *      `boostsPublishedAt`.
 *   6. A PUBLISH REFUSAL THAT NAMES A BRANCH LANDS ON THAT BRANCH, verbatim.
 *
 * `Boosts` is driven through a host that reads `usePromotions`, as
 * `Marketing.tsx` does, so a stop's cache write and a 409's re-read reach the
 * screen the way they do in the app.
 */
import { BoostSchema, type Boost, type Branch, type PromotionSet } from '@avo/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

vi.mock('../../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

interface Call {
  path: string;
  method: string;
  body: unknown;
}
const calls: Call[] = [];
let served: PromotionSet;
let onPut: (body: unknown) => PromotionSet = () => served;
let onStop: (branchId: string) => PromotionSet = () => served;

const authedRequest = vi.fn(
  async (_scope: string, path: string, opts: { method?: string; body?: unknown } = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    if (path === '/v1/salons/SAL-AMARA/promotions' && method === 'GET') return served;
    if (path === '/v1/salons/SAL-AMARA/promotions/boosts' && method === 'PUT') return onPut(opts.body);
    const stop = /^\/v1\/salons\/SAL-AMARA\/promotions\/boosts\/([^/]+)\/stop$/.exec(path);
    if (stop && method === 'POST') return onStop(decodeURIComponent(stop[1]!));
    throw new Error(`unscripted ${method} ${path}`);
  },
);
vi.mock('../../auth/authedRequest.js', () => ({
  authedRequest: (...args: Parameters<typeof authedRequest>) => authedRequest(...args),
}));

const { Boosts } = await import('./Boosts.js');
const { usePromotions } = await import('../../api/promotions.js');

/* ------------------------------------------------------------- fixtures -- */

/** 12:00 in Kuwait, 14:00 in Karachi, on 29 Sep 2026. */
const NOW = Date.parse('2026-09-29T09:00:00.000Z');

const branch = (id: string, name: string) => ({ id, name }) as Branch;
const BRANCHES: Branch[] = [
  branch('BR-SAL', 'Salmiya'),
  branch('BR-KWC', 'Kuwait City'),
  branch('BR-AVE', 'The Avenues'),
  branch('BR-JAB', 'Jabriya'),
  branch('BR-FAH', 'Fahaheel'),
  branch('BR-HAW', 'Hawalli'),
];

const boost = (over: Partial<Boost> = {}): Boost =>
  BoostSchema.parse({
    visit: 1,
    topup: 0,
    stamp: 1,
    startsAt: null,
    endsAt: null,
    stoppedAt: null,
    stoppedBy: null,
    ...over,
  });

function initialSet(): PromotionSet {
  return {
    boosts: {
      // Live, ends at midnight on 2 Oct, Kuwait.
      'BR-SAL': boost({ visit: 2, endsAt: '2026-10-01T21:00:00.000Z' }),
      // Scheduled for 09:00 tomorrow, Kuwait.
      'BR-KWC': boost({ visit: 2, startsAt: '2026-09-30T06:00:00.000Z' }),
      // Ended at midnight today, Kuwait.
      'BR-AVE': boost({
        stamp: 2,
        startsAt: '2026-09-20T21:00:00.000Z',
        endsAt: '2026-09-28T21:00:00.000Z',
      }),
      // Stopped by Noura at 11:05 today, Kuwait — neutral, as the server writes it.
      'BR-JAB': boost({ stoppedAt: '2026-09-29T08:05:00.000Z', stoppedBy: 'Noura' }),
      // BR-FAH has no row: Off.
      // Live with no end.
      'BR-HAW': boost({ visit: 3 }),
    },
    boostsPublishedAt: '2026-09-28T10:00:00.000Z',
    boostsPublishedBy: 'Noura',
    happy: [],
  };
}

const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Karachi';
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});
beforeEach(() => {
  // Date only: faking timers wholesale would take React's scheduler with it.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  calls.length = 0;
  served = initialSet();
  onPut = () => served;
  onStop = () => served;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Host() {
  const promotions = usePromotions();
  return (
    <Boosts
      branches={BRANCHES}
      promotions={promotions.data}
      loading={promotions.isPending}
      timezone="Asia/Kuwait"
    />
  );
}

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const view = render(<Host />, { wrapper: Wrapper });
  await screen.findByText('Salmiya');
  return view;
}

const rowOf = (id: string) => {
  const el = document.querySelector(`[data-branch="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return within(el as HTMLElement);
};

const puts = () => calls.filter((c) => c.method === 'PUT');
const putBody = () => (puts().at(-1)?.body as { boosts: Record<string, Record<string, unknown>> }).boosts;
const publish = () => fireEvent.click(screen.getByRole('button', { name: 'Publish changes' }));

/* ================================================== 1 · no top-up bonus == */

describe('branch boosts lose the top-up bonus', () => {
  it('draws no top-up stepper and says nothing about top-ups', async () => {
    const { container } = await mount();
    expect(screen.queryByText('Top-up bonus')).toBeNull();
    expect(screen.queryByRole('spinbutton', { name: /top-up/i })).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/top-up/i);
  });

  it('sends topup: 0 for every branch the salon has', async () => {
    await mount();
    fireEvent.click(rowOf('BR-FAH').getByRole('button', { name: 'Increase Visit value at Fahaheel' }));
    publish();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = putBody();
    expect(Object.keys(body).sort()).toEqual(BRANCHES.map((b) => b.id).sort());
    for (const row of Object.values(body)) expect(row.topup).toBe(0);
  });
});

/* ================================================= 2 · the window, zoned == */

describe('the duration is typed in the salon’s clock and sent as instants', () => {
  it('the pin holds: this process is in Karachi', () => {
    expect(new Date(NOW).getHours()).toBe(14);
  });

  it('a custom window goes as …Z instants, converted from Kuwait — not Karachi, not zone-less', async () => {
    await mount();
    const fah = rowOf('BR-FAH');
    fireEvent.click(fah.getByRole('button', { name: 'Increase Visit value at Fahaheel' }));
    fireEvent.click(fah.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(fah.getByLabelText('Start date'), { target: { value: '2026-10-01' } });
    fireEvent.change(fah.getByLabelText('Start time (Asia/Kuwait)'), { target: { value: '10:00' } });
    fireEvent.change(fah.getByLabelText('End date'), { target: { value: '2026-10-03' } });
    fireEvent.change(fah.getByLabelText('End time (Asia/Kuwait)'), { target: { value: '22:00' } });
    publish();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody()['BR-FAH']).toEqual({
      visit: 2,
      topup: 0,
      stamp: 1,
      startsAt: '2026-10-01T07:00:00.000Z',
      endsAt: '2026-10-03T19:00:00.000Z',
    });
  });

  it.each([
    ['Today only', '2026-09-29T21:00:00.000Z'],
    ['7 days', '2026-10-05T21:00:00.000Z'],
    ['30 days', '2026-10-28T21:00:00.000Z'],
  ])('%s ends at the salon’s midnight and starts on publish', async (preset, endsAt) => {
    await mount();
    const fah = rowOf('BR-FAH');
    fireEvent.click(fah.getByRole('button', { name: 'Increase Stamps per visit at Fahaheel' }));
    fireEvent.click(fah.getByRole('radio', { name: preset }));
    publish();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(putBody()['BR-FAH']).toMatchObject({ stamp: 2, startsAt: null, endsAt });
  });

  it('every other branch goes back with its own window, untouched — an ended one included', async () => {
    await mount();
    fireEvent.click(rowOf('BR-FAH').getByRole('button', { name: 'Increase Visit value at Fahaheel' }));
    publish();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = putBody();
    expect(body['BR-SAL']).toMatchObject({ visit: 2, startsAt: null, endsAt: '2026-10-01T21:00:00.000Z' });
    expect(body['BR-KWC']).toMatchObject({ startsAt: '2026-09-30T06:00:00.000Z', endsAt: null });
    expect(body['BR-AVE']).toMatchObject({
      stamp: 2,
      startsAt: '2026-09-20T21:00:00.000Z',
      endsAt: '2026-09-28T21:00:00.000Z',
    });
    expect(body['BR-JAB']).toEqual({ visit: 1, topup: 0, stamp: 1, startsAt: null, endsAt: null });
  });

  it('an end before the start is refused on the row, and nothing can be published', async () => {
    await mount();
    const fah = rowOf('BR-FAH');
    fireEvent.click(fah.getByRole('button', { name: 'Increase Visit value at Fahaheel' }));
    fireEvent.click(fah.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(fah.getByLabelText('Start date'), { target: { value: '2026-10-03' } });
    fireEvent.change(fah.getByLabelText('Start time (Asia/Kuwait)'), { target: { value: '10:00' } });
    fireEvent.change(fah.getByLabelText('End date'), { target: { value: '2026-10-01' } });
    fireEvent.change(fah.getByLabelText('End time (Asia/Kuwait)'), { target: { value: '10:00' } });
    expect(fah.getByRole('alert').textContent).toBe('A boost has to end after it starts.');
    expect((screen.getByRole('button', { name: 'Publish changes' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/* ====================================================== 3 · each state == */

describe('each branch says which state its published boost is in', () => {
  it.each([
    ['BR-SAL', 'Live · ends 2 Oct, 00:00'],
    ['BR-KWC', 'Scheduled · starts tomorrow, 09:00'],
    ['BR-AVE', 'Ended today, 00:00'],
    ['BR-JAB', 'Stopped by Noura today, 11:05'],
    ['BR-FAH', 'Off'],
    ['BR-HAW', 'Live · runs until stopped'],
  ])('%s — %s', async (id, label) => {
    await mount();
    expect(rowOf(id).getByText(label)).toBeTruthy();
  });

  it('offers Stop only where a boost is live or scheduled', async () => {
    await mount();
    for (const id of ['BR-SAL', 'BR-KWC', 'BR-HAW']) {
      expect(rowOf(id).queryByRole('button', { name: 'Stop' })).toBeTruthy();
    }
    for (const id of ['BR-AVE', 'BR-JAB', 'BR-FAH']) {
      expect(rowOf(id).queryByRole('button', { name: 'Stop' })).toBeNull();
    }
  });

  it('the state follows the clock — a scheduled boost reads Live once it starts', async () => {
    vi.setSystemTime(Date.parse('2026-09-30T06:00:00.000Z'));
    await mount();
    expect(rowOf('BR-KWC').getByText('Live · runs until stopped')).toBeTruthy();
  });
});

/* ============================================================ 4 · Stop == */

describe('Stop asks first, and lands its refusals on the row', () => {
  it('confirms before sending, and "Keep it" sends nothing', async () => {
    await mount();
    const sal = rowOf('BR-SAL');
    fireEvent.click(sal.getByRole('button', { name: 'Stop' }));
    expect(sal.getByText(/Stop the boost at Salmiya now\?/)).toBeTruthy();
    fireEvent.click(sal.getByRole('button', { name: 'Keep it' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect(sal.queryByText(/Stop the boost at Salmiya now\?/)).toBeNull();
  });

  it('"Yes, stop it" posts to that branch’s stop endpoint', async () => {
    await mount();
    const sal = rowOf('BR-SAL');
    fireEvent.click(sal.getByRole('button', { name: 'Stop' }));
    fireEvent.click(sal.getByRole('button', { name: 'Yes, stop it' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.path).toBe(
      '/v1/salons/SAL-AMARA/promotions/boosts/BR-SAL/stop',
    );
  });

  it.each([
    [
      new ApiError('This branch has no boost to stop.', {
        status: 409,
        code: 'no_boost_running',
        details: { branchId: 'BR-SAL' },
      }),
      'This branch has no boost to stop.',
    ],
    [
      new ApiError('This boost was already stopped by Hessa at 2026-09-29T08:30:00.000Z.', {
        status: 409,
        code: 'boost_already_stopped',
        details: { branchId: 'BR-SAL', stoppedAt: '2026-09-29T08:30:00.000Z', stoppedBy: 'Hessa' },
      }),
      // The server's sentence, its instant read in Kuwait.
      'This boost was already stopped by Hessa today, 11:30.',
    ],
    [
      new ApiError('This boost has already ended.', {
        status: 409,
        code: 'boost_already_ended',
        details: { branchId: 'BR-SAL', endsAt: '2026-09-29T08:59:00.000Z' },
      }),
      'This boost has already ended.',
    ],
  ])('409 %#: said on the Salmiya row, and the set is read again', async (error, text) => {
    onStop = () => {
      throw error;
    };
    await mount();
    const getsBefore = calls.filter((c) => c.method === 'GET').length;
    const sal = rowOf('BR-SAL');
    fireEvent.click(sal.getByRole('button', { name: 'Stop' }));
    fireEvent.click(sal.getByRole('button', { name: 'Yes, stop it' }));
    const alert = await sal.findByRole('alert');
    expect(alert.textContent).toContain(text);
    // Not on anyone else's row.
    expect(rowOf('BR-HAW').queryByRole('alert')).toBeNull();
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(getsBefore),
    );
  });

  it('a failure that is not a 409 keeps the question open for a retry', async () => {
    onStop = () => {
      throw new ApiError('Something broke.', { status: 500, code: 'internal' });
    };
    await mount();
    const sal = rowOf('BR-SAL');
    fireEvent.click(sal.getByRole('button', { name: 'Stop' }));
    fireEvent.click(sal.getByRole('button', { name: 'Yes, stop it' }));
    const alert = await sal.findByRole('alert');
    expect(alert.textContent).toContain('The boost is still running.');
    expect(sal.getByRole('button', { name: 'Yes, stop it' })).toBeTruthy();
  });
});

/* ================================================ 5 · reseed after stop == */

describe('a stop reseeds the row from its response', () => {
  /**
   * THE STOP DOES NOT BUMP `boostsPublishedAt`. A draft that reseeded on that
   * alone kept Salmiya at 2× after the stop — and the grid then read "Publish
   * changes", one click from restarting the boost she had just stopped.
   */
  it('the stopped branch reads neutral, Stopped by her, and the grid is not dirty', async () => {
    onStop = (branchId) => {
      served = {
        ...served,
        boosts: {
          ...served.boosts,
          [branchId]: boost({ stoppedAt: new Date(NOW).toISOString(), stoppedBy: 'Noura' }),
        },
      };
      return served;
    };
    await mount();
    const sal = rowOf('BR-SAL');
    expect(sal.getByRole('spinbutton', { name: 'Visit value at Salmiya' }).textContent).toContain('2×');
    fireEvent.click(sal.getByRole('button', { name: 'Stop' }));
    fireEvent.click(sal.getByRole('button', { name: 'Yes, stop it' }));
    await sal.findByText('Stopped by Noura today, 12:00');
    expect(sal.getByRole('spinbutton', { name: 'Visit value at Salmiya' }).textContent).toContain('1×');
    expect(sal.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Published' })).toBeTruthy();
  });

  it('keeps an unpublished edit on another branch through the stop', async () => {
    onStop = (branchId) => {
      served = {
        ...served,
        boosts: { ...served.boosts, [branchId]: boost({ stoppedAt: new Date(NOW).toISOString(), stoppedBy: 'Noura' }) },
      };
      return served;
    };
    await mount();
    fireEvent.click(rowOf('BR-FAH').getByRole('button', { name: 'Increase Visit value at Fahaheel' }));
    const sal = rowOf('BR-SAL');
    fireEvent.click(sal.getByRole('button', { name: 'Stop' }));
    fireEvent.click(sal.getByRole('button', { name: 'Yes, stop it' }));
    await sal.findByText('Stopped by Noura today, 12:00');
    expect(
      rowOf('BR-FAH').getByRole('spinbutton', { name: 'Visit value at Fahaheel' }).textContent,
    ).toContain('2×');
    expect(screen.getByRole('button', { name: 'Publish changes' })).toBeTruthy();
  });
});

/* ============================================ 6 · a refusal on its row == */

describe('a publish refusal that names a branch lands on that branch, verbatim', () => {
  it.each([
    [
      'by details.branchId',
      new ApiError(
        'BR-KWC: endsAt 2026-09-29T08:00:00.000Z has already passed, so this boost would never apply. Pick a later end, or none.',
        { status: 400, code: 'boost_already_ended', details: { branchId: 'BR-KWC' } },
      ),
      'BR-KWC',
    ],
    [
      // Lane A's non-zero-topup refusal: whatever its code, the sentence goes to the row.
      'by the sentence’s own branch prefix',
      new ApiError('BR-SAL: a branch boost has no top-up bonus.', {
        status: 400,
        code: 'any_future_code',
      }),
      'BR-SAL',
    ],
  ])('%s', async (_how, error, id) => {
    onPut = () => {
      throw error;
    };
    await mount();
    fireEvent.click(rowOf('BR-FAH').getByRole('button', { name: 'Increase Visit value at Fahaheel' }));
    publish();
    const alert = await rowOf(id).findByRole('alert');
    expect(alert.textContent).toContain(error.message);
    expect(rowOf('BR-FAH').queryByRole('alert')).toBeNull();
  });
});
