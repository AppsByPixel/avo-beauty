// @vitest-environment jsdom

/**
 * Merchant → Settings → Booking deposit → the no-show return window, WHICH IS
 * NOT EDITABLE HERE ANY MORE.
 *
 * WHAT THIS FILE USED TO PIN, AND WHY IT NOW PINS THE OPPOSITE
 * ------------------------------------------------------------
 * It pinned a "Return window" select on the deposit card (15 minutes … 4 hours)
 * writing `noShowReturnMinutes` through `PATCH /salons/{id}`, and its first spec
 * — "lets a merchant edit the window at all" — asserted the field was in
 * `MERCHANT_EDITABLE`. Lane A's be36b9a moved it to `PLATFORM_ONLY_EDITABLE`
 * (migration 0066): the salon's own booking policy decides what a no-show does,
 * and a merchant PATCH that sends the window answers `400 not_editable`. That
 * spec went red on dev, correctly.
 *
 * So the truth is now: the server refuses it from a merchant, the Settings card
 * draws no control for it, no merchant write type admits it, and the card's foot
 * sentence states the salon's POLICY — falling back to the design's window
 * sentence only for a salon that has never published one, which is the salon
 * whose bookings still settle by that window.
 *
 * `bookingPolicyPanel.test.tsx` covers the panel that replaced the control.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fils, type BookingPolicy, type Salon } from '@avo/types';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SalonPatch } from '../api/settings.js';
import { stripComments } from '../testing/stripComments.js';
import { DepositPanel } from './Settings.js';

afterEach(cleanup);

/** `apps/dashboard/src/routes` → repo root. */
const REPO = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => stripComments(readFileSync(join(REPO, rel), 'utf8'));

const SALONS_ROUTE = 'api/src/routes/salons.ts';
const SETTINGS_ROUTE = 'apps/dashboard/src/routes/Settings.tsx';

/** The literals inside `const <name> = new Set([ … ])` in `salons.ts`. */
function setMembers(name: string): string[] {
  const src = read(SALONS_ROUTE);
  const open = src.indexOf(`const ${name} = new Set([`);
  expect(open, `${name} not found in ${SALONS_ROUTE}`).toBeGreaterThan(-1);
  const close = src.indexOf('])', open);
  expect(close).toBeGreaterThan(open);
  return [...src.slice(open, close).matchAll(/'([^']+)'/g)].flatMap((m) => m[1] ?? []);
}

/* ------------------------------------------------------------------- server */

describe('the server refuses the window from a merchant', () => {
  /**
   * THE ONE SERVER ASSERTION KEPT, INVERTED. A merchant PATCH carrying the field
   * is refused `not_editable` — so a control on this screen could only ever
   * produce a 400. The console still writes it, for legacy bookings.
   */
  it('keeps noShowReturnMinutes out of MERCHANT_EDITABLE and in the console-only set', () => {
    expect(setMembers('MERCHANT_EDITABLE')).not.toContain('noShowReturnMinutes');
    expect(setMembers('PLATFORM_ONLY_EDITABLE')).toContain('noShowReturnMinutes');
    expect(read(SALONS_ROUTE)).toContain("badRequest('not_editable'");
  });
});

/* ------------------------------------------------------------------- client */

const SALON: Salon = {
  id: 'SAL-AMARA',
  name: 'Amara Salon',
  nameAr: 'صالون أمارة',
  plan: 'growth',
  city: 'Kuwait City',
  // A tenant's own hex, SAL-LUMIERE's — see `settingsSocialLinks.test.tsx`.
  brandColor: '#7A5C8E',
  walletCard: 'tier',
  modules: { booking: true, shop: false },
  loyaltyMode: 'tiers',
  tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
  depositFils: fils(5000),
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  branches: [{ id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية', businessHours: { morning: ['10:00', '13:00'] as [string, string], evening: ['16:00', '21:00'] as [string, string] }, businessHoursSource: 'salon' as const }],
  social: [],
  whatsappEnabled: true,
  emailEnabled: false,
};

const salonWith = (over: Partial<Salon>): Salon => ({ ...SALON, ...over });

const POLICY: BookingPolicy = {
  id: 'BP-1',
  salonId: 'SAL-AMARA',
  version: 1,
  noShow: 'keep',
  cancellation: [{ hoursBefore: 24, returnPercent: 100 }],
  text: { en: 'Cancel a day ahead for a full return.', ar: '' },
  publishedAt: '2026-09-29T09:00:00.000Z',
};

type Updater = Parameters<typeof DepositPanel>[0]['update'];

function stubUpdate(over: { isPending?: boolean } = {}) {
  const calls: SalonPatch[] = [];
  const update = {
    isPending: over.isPending ?? false,
    variables: undefined,
    mutate: (patch: SalonPatch) => void calls.push(patch),
  } as unknown as Updater;
  return { update, calls };
}

const foot = (container: HTMLElement) => container.querySelector('.settings__foot');

describe('the window is not editable here', () => {
  it('draws no window control on the deposit card', () => {
    const { update } = stubUpdate();
    render(<DepositPanel salon={SALON} update={update} policy={null} />);
    expect(screen.queryByRole('combobox', { name: 'No-show return window' })).toBeNull();
    expect(screen.queryByText('Return window')).toBeNull();
    // The deposit stepper is still the card's one control.
    expect(screen.getByRole('button', { name: 'Increase Booking deposit' })).toBeTruthy();
  });

  it('carries no preset list and no write of the field in the screen source', () => {
    const src = read(SETTINGS_ROUTE);
    expect(src).not.toContain('RETURN_WINDOW_PRESETS');
    expect(src).not.toMatch(/noShowReturnMinutes\s*:/);
  });

  it('does not admit the field in the merchant write type', () => {
    // @ts-expect-error — `SalonPatch` no longer carries `noShowReturnMinutes`.
    const stale: SalonPatch = { noShowReturnMinutes: 60 };
    expect(stale).toBeTruthy();
  });

  it('writes only the deposit when the stepper moves', () => {
    vi.useFakeTimers();
    try {
      const { update, calls } = stubUpdate();
      render(<DepositPanel salon={SALON} update={update} policy={POLICY} />);
      fireEvent.click(screen.getByRole('button', { name: 'Increase Booking deposit' }));
      act(() => void vi.advanceTimersByTime(600));
      expect(calls).toEqual([{ depositFils: 6000 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the foot sentence states the salon’s policy, or the legacy window without one', () => {
  it('states "keep" from a keep policy', () => {
    const { update } = stubUpdate();
    const { container } = render(<DepositPanel salon={SALON} update={update} policy={POLICY} />);
    expect(foot(container)?.textContent).toBe(
      'No-shows: you keep the deposit. It settles 1 hour after the slot ends, or when you mark it.',
    );
    expect(foot(container)?.textContent).not.toMatch(/returns to the wallet/);
  });

  it('states "return" from a return policy', () => {
    const { update } = stubUpdate();
    const { container } = render(
      <DepositPanel salon={SALON} update={update} policy={{ ...POLICY, noShow: 'return' }} />,
    );
    expect(foot(container)?.textContent).toBe(
      'No-shows: the deposit returns to her wallet. It settles 1 hour after the slot ends, or when you mark it.',
    );
  });

  it('keeps the design’s window sentence for a salon with no policy, at its own window', () => {
    const { update } = stubUpdate();
    const { container } = render(
      <DepositPanel salon={salonWith({ noShowReturnMinutes: 240 })} update={update} policy={null} />,
    );
    expect(foot(container)?.textContent).toBe(
      'No-show: deposit returns to the wallet 4 hours after a missed slot.',
    );
  });

  it('claims nothing while either read is still out — skeleton, no text', () => {
    const { update } = stubUpdate();
    for (const [salon, policy] of [
      [undefined, null],
      [SALON, undefined],
    ] as const) {
      const { container, unmount } = render(
        <DepositPanel salon={salon} update={update} policy={policy} />,
      );
      expect(foot(container)!.querySelector('.avo-skeleton')).not.toBeNull();
      expect(foot(container)!.textContent).toBe('');
      unmount();
    }
  });
});

/* --------------------------------------------------------------- the weight */

describe('the emphasised phrase carries the design weight', () => {
  beforeAll(() => {
    for (const relative of [
      '../../../../packages/tokens/dist/avo-tokens.css',
      '../../../../packages/ui/src/ui.css',
      '../app.css',
    ]) {
      const style = document.createElement('style');
      style.textContent = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      document.head.appendChild(style);
    }
  });

  it('renders the emphasis at 600, never the browser’s 700', () => {
    const { update } = stubUpdate();
    const { container } = render(<DepositPanel salon={SALON} update={update} policy={null} />);
    const emphasis = container.querySelector('.settings__foot b') as HTMLElement | null;
    expect(emphasis?.textContent).toBe('1 hour');
    expect(getComputedStyle(emphasis!).fontWeight).toBe('600');
  });
});
