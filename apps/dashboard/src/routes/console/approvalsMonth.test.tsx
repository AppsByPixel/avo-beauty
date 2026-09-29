// @vitest-environment jsdom

/**
 * CONSOLE → APPROVALS → "THIS MONTH" COUNTS THIS MONTH, AND SAYS WHEN IT CANNOT.
 *
 * The card counted the whole unfiltered read — `LIMIT 200` newest-first, with no
 * date parameter — under a "This month" heading, so a campaign from May counted
 * and the 201st did not. The API still has no monthly read (`?status=` is its
 * only parameter), so `approvalsMonth.ts` filters the newest-first 200 to this
 * month, which is exact until the 200 are all this month's, and says so then.
 */
import { CampaignSchema, type Campaign } from '@avo/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../../auth/AuthProvider.js', () => ({
  useSession: () => ({ adminId: 'AD-1', perms: {} }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const { PLATFORM_CAMPAIGNS_CAP, thisMonthCohort } = await import('./approvalsMonth.js');
const { Approvals } = await import('./Approvals.js');

const NOW = new Date('2026-09-29T09:00:00.000Z');

let n = 0;
function campaign(submittedAt: string, over: Partial<Campaign> = {}): Campaign {
  n += 1;
  return CampaignSchema.parse({
    id: `CMP-${String(n).padStart(4, '0')}`,
    salonId: 'SAL-AMARA',
    salon: 'Amara',
    title: `Campaign ${n}`,
    body: 'Body.',
    channel: 'push',
    audience: 'all',
    branchId: 'all',
    reward: 'none',
    customReward: null,
    reach: 10,
    when: 'now',
    scheduledAt: '',
    status: 'sent',
    heldReason: null,
    heldAt: null,
    submittedBy: 'Noura',
    submittedAt,
    decidedBy: 'AVO',
    decidedAt: submittedAt,
    note: null,
    result: null,
    ...over,
  });
}

describe('thisMonthCohort', () => {
  it('keeps only campaigns submitted this calendar month, in the given zone', () => {
    const items = [
      campaign('2026-09-28T10:00:00.000Z'),
      campaign('2026-09-01T00:30:00.000Z'),
      // 31 Aug 22:30Z is already 1 Sep in Kuwait — this month there, last month in UTC.
      campaign('2026-08-31T22:30:00.000Z'),
      campaign('2026-08-15T10:00:00.000Z'),
    ];
    expect(thisMonthCohort(items, NOW, 'Asia/Kuwait').items).toHaveLength(3);
    expect(thisMonthCohort(items, NOW, 'UTC').items).toHaveLength(2);
    expect(thisMonthCohort(items, NOW, 'Asia/Kuwait').truncated).toBe(false);
  });

  it('is exact when the capped read reaches back past the month’s start', () => {
    const items = [
      ...Array.from({ length: PLATFORM_CAMPAIGNS_CAP - 1 }, () => campaign('2026-09-20T10:00:00.000Z')),
      campaign('2026-08-30T10:00:00.000Z'),
    ];
    const cohort = thisMonthCohort(items, NOW, 'UTC');
    expect(cohort.items).toHaveLength(PLATFORM_CAMPAIGNS_CAP - 1);
    expect(cohort.truncated).toBe(false);
  });

  it('is a floor, and says so, when all 200 are this month’s', () => {
    const items = Array.from({ length: PLATFORM_CAMPAIGNS_CAP }, () =>
      campaign('2026-09-20T10:00:00.000Z'),
    );
    expect(thisMonthCohort(items, NOW, 'UTC').truncated).toBe(true);
  });
});

describe('Approvals → This month, rendered', () => {
  let unfiltered: Campaign[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    authedRequest.mockImplementation((_s: string, path: string) => {
      if (path === '/v1/platform/messaging-policy') {
        return Promise.resolve({
          requireApproval: true,
          weeklyCapPerCustomer: 2,
          monthlyCapPerSalon: 8,
          quietFrom: '22:00',
          quietTo: '08:00',
        });
      }
      if (path === '/v1/platform/campaigns?status=pending') return Promise.resolve({ items: [] });
      if (path === '/v1/platform/campaigns') return Promise.resolve({ items: unfiltered });
      return Promise.reject(new Error(`unrouted ${path}`));
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function mount(node: ReactNode) {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  }

  const stat = (label: string) => {
    const card = document.querySelector('.approvals__stats') as HTMLElement;
    const row = within(card).getByText(label).closest('.approvals__stat') as HTMLElement;
    return row.querySelector('.approvals__statvalue')?.textContent;
  };

  it('counts this month’s campaigns and not May’s', async () => {
    unfiltered = [
      campaign('2026-09-28T10:00:00.000Z', { status: 'sent' }),
      campaign('2026-09-10T10:00:00.000Z', { status: 'rejected', note: 'No.' }),
      campaign('2026-05-10T10:00:00.000Z', { status: 'sent' }),
      campaign('2026-05-09T10:00:00.000Z', { status: 'rejected', note: 'No.' }),
    ];
    mount(<Approvals />);
    await screen.findByText('This month');
    await vi.waitFor(() => expect(stat('Submitted')).toBe('2'));
    expect(stat('Sent')).toBe('1');
    expect(stat('Rejected')).toBe('1');
    expect(screen.queryByText(/read these as at least/)).toBeNull();
  });

  it('says the counts are floors when the capped read is all this month', async () => {
    unfiltered = Array.from({ length: PLATFORM_CAMPAIGNS_CAP }, () =>
      campaign('2026-09-20T10:00:00.000Z'),
    );
    mount(<Approvals />);
    await screen.findByText(/read these as at least/);
    expect(stat('Submitted')).toBe(String(PLATFORM_CAMPAIGNS_CAP));
  });
});
