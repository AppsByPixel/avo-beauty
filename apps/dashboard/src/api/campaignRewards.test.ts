// @vitest-environment jsdom

/**
 * The three campaign-reward hooks, below the screen.
 *
 * What the composer tests cannot see from the DOM: the list is PARSED against
 * `CampaignRewardSchema` rather than trusted, the cache is keyed per salon and
 * written from the server's row, and a remove that races a colleague's (404
 * `unknown_reward`) settles as the success it is.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';

vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const authedRequest = vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined);
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));

const {
  promotionKeys,
  useAddCampaignReward,
  useCampaignRewards,
  useRemoveCampaignReward,
  campaignRewardLabel,
} = await import('./promotions.js');

afterEach(() => {
  cleanup();
  authedRequest.mockReset();
});

const ROW = {
  id: 'CRW-10000001',
  salonId: 'SAL-AMARA',
  label: 'Free hair mask with any blow-dry',
  createdAt: '2026-09-28T19:00:00.000Z',
};

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return { client, wrapper };
}

describe('useCampaignRewards', () => {
  it('reads the salon’s list and caches it under a salon-scoped key', async () => {
    authedRequest.mockResolvedValueOnce({ items: [ROW] });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useCampaignRewards(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(authedRequest.mock.calls[0]?.[1]).toBe('/v1/salons/SAL-AMARA/campaign-rewards');
    expect(client.getQueryData(promotionKeys.campaignRewards('SAL-AMARA'))).toEqual([ROW]);
    expect(promotionKeys.campaignRewards('SAL-OTHER')).not.toEqual(
      promotionKeys.campaignRewards('SAL-AMARA'),
    );
  });

  it('refuses a row that does not match the contract rather than rendering it', async () => {
    authedRequest.mockResolvedValueOnce({ items: [{ ...ROW, label: undefined }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useCampaignRewards(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useAddCampaignReward', () => {
  it('POSTs the trimmed label and appends the server’s row to the cache', async () => {
    const { client, wrapper } = setup();
    client.setQueryData(promotionKeys.campaignRewards('SAL-AMARA'), []);
    authedRequest.mockResolvedValueOnce(ROW).mockResolvedValue({ items: [ROW] });
    const { result } = renderHook(() => useAddCampaignReward(), { wrapper });
    const row = await result.current.mutateAsync(`  ${ROW.label}  `);
    expect(row).toEqual(ROW);
    expect(authedRequest.mock.calls[0]?.[2]).toEqual({
      method: 'POST',
      body: { label: ROW.label },
    });
    expect(client.getQueryData(promotionKeys.campaignRewards('SAL-AMARA'))).toEqual([ROW]);
  });
});

describe('useRemoveCampaignReward', () => {
  it('DELETEs by id and drops the row from the cache', async () => {
    const { client, wrapper } = setup();
    client.setQueryData(promotionKeys.campaignRewards('SAL-AMARA'), [ROW]);
    authedRequest.mockResolvedValueOnce(undefined).mockResolvedValue({ items: [] });
    const { result } = renderHook(() => useRemoveCampaignReward(), { wrapper });
    await result.current.mutateAsync(ROW.id);
    expect(authedRequest.mock.calls[0]?.[1]).toBe(
      `/v1/salons/SAL-AMARA/campaign-rewards/${ROW.id}`,
    );
    expect(authedRequest.mock.calls[0]?.[2]).toEqual({ method: 'DELETE' });
    expect(client.getQueryData(promotionKeys.campaignRewards('SAL-AMARA'))).toEqual([]);
  });

  it('settles a 404 unknown_reward as success: it is already gone', async () => {
    const { client, wrapper } = setup();
    client.setQueryData(promotionKeys.campaignRewards('SAL-AMARA'), [ROW]);
    authedRequest
      .mockRejectedValueOnce(new ApiError('No such reward.', { status: 404, code: 'unknown_reward' }))
      .mockResolvedValue({ items: [] });
    const { result } = renderHook(() => useRemoveCampaignReward(), { wrapper });
    await expect(result.current.mutateAsync(ROW.id)).resolves.toBeUndefined();
    expect(client.getQueryData(promotionKeys.campaignRewards('SAL-AMARA'))).toEqual([]);
  });

  it('still fails on any other refusal', async () => {
    const { wrapper } = setup();
    authedRequest.mockRejectedValueOnce(
      new ApiError('Something else.', { status: 404, code: 'http_error' }),
    );
    const { result } = renderHook(() => useRemoveCampaignReward(), { wrapper });
    await expect(result.current.mutateAsync(ROW.id)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('campaignRewardLabel', () => {
  it('is the snapshot verbatim for a custom reward, and nothing for none', () => {
    expect(campaignRewardLabel({ reward: 'custom', customReward: ROW.label })).toBe(ROW.label);
    expect(campaignRewardLabel({ reward: 'none', customReward: null })).toBeNull();
    expect(campaignRewardLabel({ reward: 'custom', customReward: null })).toBeNull();
    expect(campaignRewardLabel({ reward: 'x2stamp', customReward: null })).toBe(
      'Double stamps on the next visit',
    );
  });
});
