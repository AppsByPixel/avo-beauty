// @vitest-environment jsdom

/**
 * "Attach a reward" offers every reward the contract defines, and cannot quietly
 * stop doing so.
 *
 * =========================================================================
 * THE DEFECT THIS EXISTS TO STOP REPEATING
 * =========================================================================
 * `api/promotions.ts` held `CAMPAIGN_REWARDS` as four hand-written literals —
 * `none`, `x2stamp`, `topup10`, `credit3` — copied out of the four `<option>`
 * tags in `design/AVO Merchant Dashboard.dc.html:768`. `RewardKeySchema` defines
 * SIX keys, `rewardEffect()` implements all six with real effects, and
 * `api/src/routes/campaigns.ts:182` validates against the full enum. So
 * `x3stamp`, `x2visit` and `topup20` were built end to end and unreachable from
 * the only screen that offers a reward.
 *
 * NOTHING WENT RED, AND THAT IS THE POINT — the sixth time this week a
 * hand-written list went stale beside its source while every spec that touched
 * it stayed green (`BRAND_SWATCHES`' retired sage, `PRESET_HEXES`' retired hex,
 * the onboarding swatch fixture). A spec that only ever consults the list cannot
 * notice the list disagreeing with its source.
 *
 * =========================================================================
 * WHY THESE FOUR AND NOT A SNAPSHOT
 * =========================================================================
 * No assertion below writes out the six keys. A guard shaped
 * `expect(values).toEqual(['none', 'x2stamp', ...])` would be the same defect
 * with three more literals in it — green today, wrong the next time the contract
 * grows a reward, and red for the wrong reason in between. What is pinned is the
 * RELATIONSHIP: the offered values ARE the contract's keys plus the absence.
 *
 * AND ONE RENDER SPEC, because the type-level guard cannot reach the bug that
 * was actually shipped. The control existed, it was focusable, it submitted, and
 * it silently offered a subset — every property a render spec normally checks
 * was true of the broken version. So the last test drives the real screen and
 * counts what a merchant can actually pick.
 */

import { RewardKeySchema } from '@avo/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from '../../testing/stripComments.js';
import {
  CAMPAIGN_NO_REWARD,
  CAMPAIGN_REWARDS,
  HAPPY_REWARDS,
  REWARD_LABEL,
} from '../../api/promotions.js';

/** The salon comes from the session, and there is no session in a jsdom realm. */
vi.mock('../../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

/** The composer renders above the queue; the queue's request is not the subject. */
const authedRequest = vi.fn(async (..._args: unknown[]) => ({ items: [] }));
vi.mock('../../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));

const { Campaigns } = await import('./Campaigns.js');

/** `promotions.ts` as the compiler sees it — comments blanked, line numbers intact. */
const PROMOTIONS_SRC = stripComments(
  readFileSync(join(__dirname, '..', '..', 'api', 'promotions.ts'), 'utf8'),
);

/*
 * NOT AUTOMATIC — this project does not run vitest with `globals`, so
 * `@testing-library/react` never registers its own `afterEach(cleanup)`.
 */
afterEach(cleanup);

describe('the campaign reward select is the contract’s enum, not a copy of it', () => {
  /**
   * THE ASSERTION THE OLD LIST WOULD HAVE FAILED, naming the three it omitted.
   *
   * Tautological only while the source is derived — which is the entire
   * guarantee. Restore a literal list in `promotions.ts` and this goes red on
   * the first key the two disagree about.
   */
  it('offers exactly the contract’s reward keys, in the enum’s order, after the absence', () => {
    expect(CAMPAIGN_REWARDS.map((r) => r.value)).toEqual([
      CAMPAIGN_NO_REWARD.value,
      ...RewardKeySchema.options,
    ]);
  });

  /**
   * THE ABSENCE, ASSERTED SEPARATELY FROM THE LIST.
   *
   * `none` is not a `RewardKey`; it is the absence of one, and the contract says
   * so — `CampaignSchema.reward` is `z.union([RewardKeySchema, z.literal('none')])`.
   * Keeping it a separate export is what stops it drifting into every `RewardKey`
   * iteration in `promotions.ts` and reaching `rewardEffect()`, which has no case
   * for it. Same separation as `BRAND_DEFAULT` from `BRAND_SWATCHES`.
   *
   * Pinned as two claims: the enum must refuse it, and the list must lead with it.
   */
  it('keeps `none` outside the enum and first in the list', () => {
    expect(RewardKeySchema.safeParse(CAMPAIGN_NO_REWARD.value).success).toBe(false);
    expect(CAMPAIGN_REWARDS[0]).toBe(CAMPAIGN_NO_REWARD);
    expect(CAMPAIGN_REWARDS.slice(1).map((r) => r.value)).not.toContain(
      CAMPAIGN_NO_REWARD.value,
    );
  });

  /**
   * EVERY OPTION CARRIES COPY, AND NO TWO CARRY THE SAME COPY.
   *
   * The `Record<RewardKey, string>` behind the list makes a MISSING label a
   * compile error, which is the guard that matters. It does not make an EMPTY
   * one, or a label pasted twice while adding a key — `topup20` beside
   * `topup10` is exactly the pair a copy-paste would collapse, and two identical
   * `<option>` texts is a select a merchant cannot use.
   */
  it('gives every option a distinct, non-empty line of copy', () => {
    const labels = CAMPAIGN_REWARDS.map((r) => r.label);
    expect(labels.filter((l) => l.trim() === '')).toEqual([]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  /**
   * THE BACKSTOP, because the assertions above all read the module's own export
   * and a literal could be re-introduced beside it — a second list, a fallback,
   * a default.
   *
   * COMMENTS ARE BLANKED FIRST: the block above `CAMPAIGN_REWARD_LABEL` now
   * DISCUSSES the four transcribed keys at length, deliberately, so a naive
   * `includes()` would find the corrected history and report it as the
   * uncorrected code — failing in the direction that reads as a real defect.
   *
   * SCOPED TO QUOTED KEYS, not to the identifiers. `x2stamp:` as a property name
   * in the label record is the derivation working; `'x2stamp'` as a string is a
   * key being re-typed somewhere the compiler cannot check it. `HAPPY_REWARDS`
   * is the one live exception and is pinned on its own below.
   */
  it('carries no transcribed reward key outside the happy-hour list', () => {
    const from = PROMOTIONS_SRC.indexOf('export const HAPPY_REWARDS');
    const to = PROMOTIONS_SRC.indexOf('];', from) + 2;
    const rest = PROMOTIONS_SRC.slice(0, from) + PROMOTIONS_SRC.slice(to);
    const found = RewardKeySchema.options.filter(
      (key) => rest.includes(`'${key}'`) || rest.includes(`"${key}"`),
    );
    expect(found).toEqual([]);
  });

  /**
   * HAPPY HOURS ARE NOT THE SAME LIST, AND THE DIFFERENCE IS DELIBERATE.
   *
   * `HAPPY_REWARDS` offers five of the six and omits `credit3`, which is
   * faithful to `design/AVO Merchant Dashboard.dc.html:938` — a window that
   * grants flat wallet credit on every visit for three hours is an uncapped
   * liability, unlike a multiplier. That is a product decision, not the drift
   * this file exists to catch, so it is PINNED rather than corrected: the list
   * stays inside the contract, and its single omission is named here.
   *
   * If a seventh reward ships and belongs in a window, this goes red and the
   * omission has to be restated — which is the point. It is the campaign list's
   * derivation that stops drift; this is the happy-hour list's receipt.
   */
  it('pins the happy-hour list as the contract minus one documented omission', () => {
    const keys = new Set<string>(RewardKeySchema.options);
    expect(HAPPY_REWARDS.filter((r) => !keys.has(r))).toEqual([]);
    expect(RewardKeySchema.options.filter((k) => !HAPPY_REWARDS.includes(k))).toEqual([
      'credit3',
    ]);
    // Every key it does offer is nameable, or the chip above the window is blank.
    expect(HAPPY_REWARDS.filter((r) => !REWARD_LABEL[r])).toEqual([]);
  });
});

function renderComposer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<Campaigns branches={[]} loading={false} />, { wrapper: Wrapper });
}

describe('the rendered select draws every option it is given', () => {
  /**
   * THE BUG THE TYPE-LEVEL GUARD CANNOT REACH.
   *
   * What shipped was a control that existed, was labelled, was focusable and
   * submitted — and offered four of seven choices. Nothing above this line would
   * have caught a `.slice(0, 4)` in the `.map`, a `filter` on the select, or a
   * second hardcoded `<option>` block in the JSX. This drives the real screen
   * and compares what is in the DOM against what the module offers.
   */
  it('renders one option per offered reward, with its copy', () => {
    renderComposer();
    const select = screen.getByLabelText<HTMLSelectElement>(/Attach a reward/);
    expect([...select.options].map((o) => o.value)).toEqual(
      CAMPAIGN_REWARDS.map((r) => r.value),
    );
    expect([...select.options].map((o) => o.textContent)).toEqual(
      CAMPAIGN_REWARDS.map((r) => r.label),
    );
  });

  /**
   * THE DEFAULT IS THE ABSENCE. Non-negotiable #8's neighbour: a composer that
   * opened on a reward would attach one to every campaign a merchant wrote
   * without looking, and the reward is the part with a cost attached.
   */
  it('opens on “no reward”', () => {
    renderComposer();
    const select = screen.getByLabelText<HTMLSelectElement>(/Attach a reward/);
    expect(select.value).toBe(CAMPAIGN_NO_REWARD.value);
  });
});
