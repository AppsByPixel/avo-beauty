// @vitest-environment jsdom

/**
 * A SCHEDULED CAMPAIGN'S TIME IS THE SALON'S CLOCK — BOTH WAYS ROUND.
 *
 * The composer's "Scheduled for" is a `datetime-local`, whose value is a wall
 * clock with no zone ("2026-09-30T10:00"). It was posted AS IS, and the API does
 * `new Date(raw)` on it — which reads a zone-less string in the API PROCESS's
 * zone, whatever the host runs. On a UTC host a Kuwait merchant who typed 10:00
 * scheduled 13:00 Kuwait time, and the queue row printed
 * `scheduledAt.slice(0, 16)` of the ISO instant — the UTC wall clock — so it
 * read "10:00" back to her and the error was invisible from both ends.
 *
 * `AppointmentForm` already solved the form half with
 * `instantFromSalonLocal(date, time, salon.timezone)`; this is the same bridge.
 * The process is pinned to Karachi so neither half can pass by the browser's
 * zone happening to be the salon's.
 */
import type { Campaign } from '@avo/types';
import { CampaignSchema } from '@avo/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

interface Call {
  path: string;
  method: string;
  body: unknown;
}
const calls: Call[] = [];
let queue: Campaign[] = [];

function campaign(over: Partial<Campaign> = {}): Campaign {
  return CampaignSchema.parse({
    id: 'CMP-601',
    salonId: 'SAL-AMARA',
    salon: 'Amara',
    title: 'Blow-dry week',
    body: 'Book a blow-dry this week.',
    channel: 'push',
    audience: 'all',
    branchId: 'all',
    reward: 'none',
    customReward: null,
    reach: 412,
    when: 'later',
    scheduledAt: '2026-09-30T07:00:00.000Z',
    status: 'pending',
    heldReason: null,
    heldAt: null,
    submittedBy: 'Noura',
    submittedAt: '2026-09-28T19:05:00.000Z',
    decidedBy: null,
    decidedAt: null,
    note: null,
    result: null,
    ...over,
  });
}

const authedRequest = vi.fn(
  async (_scope: string, path: string, opts: { method?: string; body?: unknown } = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    if (path === '/v1/salons/SAL-AMARA/campaign-rewards') return { items: [] };
    if (path === '/v1/salons/SAL-AMARA/campaigns' && method === 'GET') return { items: queue };
    if (path === '/v1/salons/SAL-AMARA/campaigns' && method === 'POST') return campaign();
    throw new Error(`unscripted ${method} ${path}`);
  },
);
vi.mock('../../auth/authedRequest.js', () => ({
  authedRequest: (...args: Parameters<typeof authedRequest>) => authedRequest(...args),
}));

const { Campaigns } = await import('./Campaigns.js');

const saved = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Asia/Karachi';
});
afterAll(() => {
  if (saved === undefined) delete process.env.TZ;
  else process.env.TZ = saved;
});
beforeEach(() => {
  calls.length = 0;
  queue = [];
});
afterEach(cleanup);

function renderComposer() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return render(<Campaigns branches={[]} loading={false} timezone="Asia/Kuwait" />, {
    wrapper: Wrapper,
  });
}

describe('scheduling in the salon’s clock', () => {
  it('the pin holds: this process is in Karachi', () => {
    expect(new Date('2026-09-30T07:00:00Z').getHours()).toBe(12);
  });

  it('10:00 typed for a Kuwait salon is sent as 07:00Z — not as a zone-less wall clock', async () => {
    renderComposer();
    fireEvent.change(screen.getByLabelText('Headline'), { target: { value: 'Blow-dry week' } });
    fireEvent.change(screen.getByLabelText(/^Message/), {
      target: { value: 'Book a blow-dry this week.' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Schedule' }));
    fireEvent.change(screen.getByLabelText('Scheduled for'), {
      target: { value: '2026-09-30T10:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit to AVO' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/campaigns'))).toBe(true),
    );
    const body = calls.find((c) => c.method === 'POST' && c.path.endsWith('/campaigns'))
      ?.body as Record<string, unknown>;
    expect(body.when).toBe('later');
    expect(body.scheduledAt).toBe('2026-09-30T07:00:00.000Z');
  });

  it('the queue row reads the instant back in the salon’s clock', async () => {
    queue = [campaign()];
    const { container } = renderComposer();
    await screen.findByText('Blow-dry week');
    const meta = container.querySelector('.mk__queuemeta')?.textContent ?? '';
    expect(meta.startsWith('2026-09-30 10:00 · ')).toBe(true);
  });
});
