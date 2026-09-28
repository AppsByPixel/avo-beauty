// @vitest-environment jsdom

/**
 * "Attach a reward" takes a reward the merchant writes herself.
 *
 * Aftab: "the merchant should be able to add a custom option in the dropdown."
 * 6513a6f exposed the three presets the select was missing, which was not what
 * he asked for. This file drives the real composer — and the owner console's
 * approval card, which is where AVO reads a salon's free text before releasing
 * it — against a scripted `authedRequest` that answers the way
 * `packages/mock/src/server.ts` and `api/src/routes/campaignRewards.ts` do.
 *
 * WHAT IS PINNED, and the one thing each test would catch going wrong:
 *   - the select's order (presets, then hers, then the add option LAST)
 *   - Save selects the row the SERVER returned, not what she typed
 *   - a refusal is the server's sentence verbatim
 *   - Cancel puts the select back where it was
 *   - Remove falls back to "No reward"
 *   - the campaign body carries `customRewardId` and NO words (#11's principle:
 *     the client names an id, the server resolves it)
 *   - the queue and the approval card show `customReward` verbatim
 *   - a failed list load leaves every preset usable
 */

import type { Campaign, CampaignReward } from '@avo/types';
import { CampaignSchema, RewardKeySchema } from '@avo/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import {
  CAMPAIGN_ADD_CUSTOM_LABEL,
  CAMPAIGN_NO_REWARD,
  CAMPAIGN_REWARDS,
} from '../../api/promotions.js';

vi.mock('../../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

interface Call {
  path: string;
  method: string;
  body: unknown;
}

const WORDS = 'Free hair mask with any blow-dry';

/** Server state, per test. */
let saved: CampaignReward[] = [];
let queue: Campaign[] = [];
let listFailure: ApiError | null = null;
let listNeverAnswers = false;
let postRefusal: ApiError | null = null;
let seq = 0;
const calls: Call[] = [];

function reward(label: string): CampaignReward {
  seq += 1;
  return {
    id: `CRW-${10000000 + seq}`,
    salonId: 'SAL-AMARA',
    label,
    createdAt: '2026-09-28T19:00:00.000Z',
  };
}

function campaign(over: Partial<Campaign> = {}): Campaign {
  // Parsed, so the fixture cannot drift from the contract it stands in for.
  return CampaignSchema.parse({
    id: 'CMP-501',
    salonId: 'SAL-AMARA',
    salon: 'Amara',
    title: 'Blow-dry week',
    body: 'Book a blow-dry this week.',
    channel: 'push',
    audience: 'all',
    branchId: 'all',
    reward: 'custom',
    customReward: WORDS,
    reach: 412,
    when: 'now',
    scheduledAt: '',
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

    if (path === '/v1/salons/SAL-AMARA/campaign-rewards' && method === 'GET') {
      if (listNeverAnswers) return new Promise(() => {});
      if (listFailure) throw listFailure;
      return { items: saved };
    }
    if (path === '/v1/salons/SAL-AMARA/campaign-rewards' && method === 'POST') {
      if (postRefusal) throw postRefusal;
      const row = reward(String((opts.body as { label: string }).label));
      saved = [...saved, row];
      return row;
    }
    if (path.startsWith('/v1/salons/SAL-AMARA/campaign-rewards/') && method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop() ?? '');
      saved = saved.filter((r) => r.id !== id);
      return undefined;
    }
    if (path === '/v1/salons/SAL-AMARA/campaigns' && method === 'GET') return { items: queue };
    if (path === '/v1/salons/SAL-AMARA/campaigns' && method === 'POST') return campaign();
    if (path.startsWith('/v1/platform/campaigns')) return { items: queue, nextCursor: null };
    if (path === '/v1/platform/messaging-policy') {
      return {
        requireApproval: true,
        weeklyCapPerCustomer: 2,
        monthlyCapPerSalon: 8,
        quietFrom: '22:00',
        quietTo: '09:00',
      };
    }
    throw new Error(`unscripted ${method} ${path}`);
  },
);
vi.mock('../../auth/authedRequest.js', () => ({
  authedRequest: (...args: Parameters<typeof authedRequest>) => authedRequest(...args),
}));

const { Campaigns } = await import('./Campaigns.js');
const { Approvals } = await import('../console/Approvals.js');

beforeEach(() => {
  saved = [];
  queue = [];
  listFailure = null;
  listNeverAnswers = false;
  postRefusal = null;
  seq = 0;
  calls.length = 0;
});
afterEach(cleanup);

function renderWith(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const renderComposer = () => renderWith(<Campaigns branches={[]} loading={false} />);
const rewardSelect = () => screen.getByLabelText<HTMLSelectElement>(/Attach a reward/);
const optionTexts = () => [...rewardSelect().options].map((o) => o.textContent);

async function openAdd() {
  fireEvent.change(rewardSelect(), { target: { value: '__add_custom' } });
  return screen.findByLabelText<HTMLInputElement>('Your reward');
}

describe('the reward select', () => {
  it('lists no reward, the presets, her rewards in a “Your rewards” group, then the add option last', async () => {
    saved = [reward('Free fringe trim'), reward(WORDS)];
    renderComposer();
    await screen.findByRole('group', { name: 'Your rewards' });

    expect(optionTexts()).toEqual([
      CAMPAIGN_NO_REWARD.label,
      ...CAMPAIGN_REWARDS.slice(1).map((r) => r.label),
      'Free fringe trim',
      WORDS,
      CAMPAIGN_ADD_CUSTOM_LABEL,
    ]);
    const group = screen.getByRole('group', { name: 'Your rewards' });
    expect([...group.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'Free fringe trim',
      WORDS,
    ]);
    expect(CAMPAIGN_ADD_CUSTOM_LABEL).toBe('+ Add a custom reward…');
  });

  it('draws no “Your rewards” group when she has saved none', async () => {
    renderComposer();
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/campaign-rewards'))).toBe(true));
    expect(screen.queryByRole('group', { name: 'Your rewards' })).toBeNull();
    expect(optionTexts().at(-1)).toBe(CAMPAIGN_ADD_CUSTOM_LABEL);
  });
});

describe('adding a custom reward', () => {
  it('reveals the field, saves it, adds it to the list and selects it', async () => {
    renderComposer();
    const field = await openAdd();
    expect(field.placeholder).toBe('e.g. Free hair mask with any blow-dry');
    expect(field.maxLength).toBe(60);

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(field, { target: { value: '   ' } });
    expect(save).toHaveProperty('disabled', true);

    fireEvent.change(field, { target: { value: `  ${WORDS} ` } });
    expect(screen.getByText(`${WORDS.length + 3} / 60`)).toBeTruthy();
    expect(save).toHaveProperty('disabled', false);
    fireEvent.click(save);

    await waitFor(() => expect(screen.queryByLabelText('Your reward')).toBeNull());
    const post = calls.find((c) => c.method === 'POST' && c.path.endsWith('/campaign-rewards'));
    expect(post?.body).toEqual({ label: WORDS });

    const select = rewardSelect();
    expect(select.value).toBe(`saved:${saved[0]?.id}`);
    expect(select.selectedOptions[0]?.textContent).toBe(WORDS);
    expect(screen.getByRole('button', { name: 'Remove from your list' })).toBeTruthy();
  });

  it('disables Save while the request is in flight', async () => {
    let release: (row: CampaignReward) => void = () => {};
    renderComposer();
    const field = await openAdd();
    authedRequest.mockImplementationOnce(
      (_s, _p, _o) => new Promise((resolve) => (release = resolve as typeof release)),
    );
    fireEvent.change(field, { target: { value: WORDS } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true),
    );
    release(reward(WORDS));
    await waitFor(() => expect(screen.queryByLabelText('Your reward')).toBeNull());
  });

  it('shows the server’s refusal verbatim and keeps what she typed', async () => {
    postRefusal = new ApiError('You already have a reward with that name.', {
      status: 409,
      code: 'duplicate_reward',
    });
    renderComposer();
    const field = await openAdd();
    fireEvent.change(field, { target: { value: WORDS } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('You already have a reward with that name.');
    expect(alert.textContent).toContain('No reward was added.');
    expect(screen.getByLabelText<HTMLInputElement>('Your reward').value).toBe(WORDS);
  });

  it('Cancel closes the field and puts the select back on what it held before', async () => {
    renderComposer();
    const x3 = CAMPAIGN_REWARDS[2]!.value;
    fireEvent.change(rewardSelect(), { target: { value: x3 } });
    const field = await openAdd();
    expect(rewardSelect().value).toBe('__add_custom');
    fireEvent.change(field, { target: { value: 'Half-price toner' } });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Your reward')).toBeNull();
    expect(rewardSelect().value).toBe(x3);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('removing a saved reward', () => {
  it('DELETEs it and sets the select back to “No reward”', async () => {
    saved = [reward(WORDS)];
    const id = saved[0]!.id;
    renderComposer();
    await screen.findByRole('group', { name: 'Your rewards' });
    fireEvent.change(rewardSelect(), { target: { value: `saved:${id}` } });

    fireEvent.click(screen.getByRole('button', { name: 'Remove from your list' }));

    await waitFor(() => expect(rewardSelect().value).toBe(CAMPAIGN_NO_REWARD.value));
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(
      `/v1/salons/SAL-AMARA/campaign-rewards/${id}`,
    );
    expect(screen.queryByRole('group', { name: 'Your rewards' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove from your list' })).toBeNull();
  });

  it('offers Remove only for one of her rewards, never for a preset', () => {
    renderComposer();
    fireEvent.change(rewardSelect(), { target: { value: CAMPAIGN_REWARDS[1]!.value } });
    expect(screen.queryByRole('button', { name: 'Remove from your list' })).toBeNull();
  });
});

describe('submitting', () => {
  function fillAndSubmit() {
    fireEvent.change(screen.getByLabelText('Headline'), { target: { value: 'Blow-dry week' } });
    fireEvent.change(screen.getByLabelText(/^Message/), {
      target: { value: 'Book a blow-dry this week.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit to AVO' }));
  }
  const submitted = () =>
    calls.find((c) => c.method === 'POST' && c.path === '/v1/salons/SAL-AMARA/campaigns')
      ?.body as Record<string, unknown> | undefined;

  it('sends reward “custom” and the saved id — and none of her words', async () => {
    saved = [reward(WORDS)];
    const id = saved[0]!.id;
    renderComposer();
    await screen.findByRole('group', { name: 'Your rewards' });
    fireEvent.change(rewardSelect(), { target: { value: `saved:${id}` } });
    fillAndSubmit();

    await waitFor(() => expect(submitted()).toBeDefined());
    const body = submitted()!;
    expect(body.reward).toBe('custom');
    expect(body.customRewardId).toBe(id);
    // No label, under any name: the server resolves the words from the id.
    expect(JSON.stringify(body)).not.toContain(WORDS);
    expect(Object.keys(body).filter((k) => /label|customReward$/i.test(k))).toEqual([]);
  });

  it('sends a preset as its key, with no customRewardId at all', async () => {
    renderComposer();
    const key = RewardKeySchema.options[0];
    fireEvent.change(rewardSelect(), { target: { value: key } });
    fillAndSubmit();
    await waitFor(() => expect(submitted()).toBeDefined());
    expect(submitted()!.reward).toBe(key);
    expect('customRewardId' in submitted()!).toBe(false);
  });
});

describe('when her list does not load', () => {
  it('keeps every preset usable and offers a quiet retry', async () => {
    listFailure = new ApiError('boom', { status: 500, code: 'http_error' });
    renderComposer();

    const note = await screen.findByText(/Couldn’t load your saved rewards\./);
    expect(within(note).getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(optionTexts()).toEqual([
      ...CAMPAIGN_REWARDS.map((r) => r.label),
      CAMPAIGN_ADD_CUSTOM_LABEL,
    ]);

    const key = RewardKeySchema.options[3]!;
    fireEvent.change(rewardSelect(), { target: { value: key } });
    expect(rewardSelect().value).toBe(key);

    listFailure = null;
    saved = [reward(WORDS)];
    fireEvent.click(within(note).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('group', { name: 'Your rewards' });
    expect(screen.queryByText(/Couldn’t load your saved rewards\./)).toBeNull();
  });

  it('still lists the presets while the list is loading', () => {
    listNeverAnswers = true;
    renderComposer();
    expect(optionTexts()).toEqual([
      ...CAMPAIGN_REWARDS.map((r) => r.label),
      CAMPAIGN_ADD_CUSTOM_LABEL,
    ]);
    expect(rewardSelect().disabled).toBe(false);
    const key = RewardKeySchema.options[1]!;
    fireEvent.change(rewardSelect(), { target: { value: key } });
    expect(rewardSelect().value).toBe(key);
  });
});

describe('a custom reward is shown as her words, verbatim', () => {
  it('in the queue row', async () => {
    queue = [campaign()];
    renderComposer();
    const row = (await screen.findByText('Blow-dry week', { selector: '.mk__queuetitle' }))
      .closest('.mk__queuerow') as HTMLElement;
    expect(row.querySelector('.mk__queuemeta')?.textContent).toContain(WORDS);
  });

  it('in the queue row, for a preset, as the select named it', async () => {
    queue = [campaign({ reward: 'x3stamp', customReward: null })];
    renderComposer();
    const row = (await screen.findByText('Blow-dry week', { selector: '.mk__queuetitle' }))
      .closest('.mk__queuerow') as HTMLElement;
    const label = CAMPAIGN_REWARDS.find((r) => r.value === 'x3stamp')!.label;
    expect(row.querySelector('.mk__queuemeta')?.textContent).toContain(label);
  });

  it('on the owner console’s approval card, where AVO reads it before release', async () => {
    queue = [campaign()];
    renderWith(<Approvals />);
    const title = await screen.findByText('Blow-dry week');
    const card = title.closest('.approvals__card') as HTMLElement;
    const facts = [...card.querySelectorAll('.approvals__facts > span')].map((s) => s.textContent);
    expect(facts).toContain(WORDS);
  });
});
