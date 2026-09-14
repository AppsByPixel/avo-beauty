// @vitest-environment jsdom

/**
 * THE ACTIVITY FEED, RENDERED — the disclosure half of a rule
 * `domain/activityDisclosure.test.ts` proves on its own.
 *
 * That file proves what `discloseActivity` returns. It cannot reach the thing
 * that breaks in front of a customer: whether the COMPONENT asks, whether the
 * control it draws actually reveals the rest, and whether a three-row account
 * is shown a button with nothing under it. That gap — a rule tested and its
 * call site not — is the one DECISIONS #38 records in the Pay tab and the one
 * `topUpCardRender.test.tsx` was written for.
 *
 * EVERY TEST HERE FAILS BEFORE THIS SLICE: `ActivityFeed` rendered `rows.map`,
 * so twelve rows produced twelve rows and there was no control in the output to
 * assert on, in either direction.
 *
 * BOTH LANGUAGES, because the control's label is `activityShowMore` and that key
 * is an AR GAP — it renders English in Arabic today, deliberately, and the
 * Arabic build must still draw the control rather than nothing.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language } from '@avo/types';

import { ActivityFeed } from './ActivityFeed';
import { LanguageProvider } from '../i18n/language';
import type { ActivityRow } from '../domain/activity';

afterEach(cleanup);

const row = (i: number): ActivityRow => ({
  id: `TX-${i}`,
  title: `Row ${i}`,
  when: 'Sat 12 July',
  amount: '+27.500',
  amountLabel: '27.500 dinars',
  positive: true,
  pending: false,
  failed: false,
});

const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i));

const draw = (n: number, lang: Language = 'en') =>
  render(
    <LanguageProvider initial={lang}>
      <ActivityFeed rows={rows(n)} onTopUp={vi.fn()} onOpen={vi.fn()} />
    </LanguageProvider>,
  );

const visibleRows = () => screen.queryAllByTestId(/^activity-row-/);
const control = () => screen.queryByTestId('activity-show-more');

describe('ActivityFeed — four, then the rest', () => {
  it('renders four of twelve and a control beneath', () => {
    draw(12);
    expect(visibleRows()).toHaveLength(4);
    expect(control()).not.toBeNull();
  });

  it('reveals the rest when the control is pressed, and then withdraws it', () => {
    draw(12);
    fireEvent.click(control()!);
    expect(visibleRows()).toHaveLength(12);
    expect(control()).toBeNull();
  });

  it('draws the control in Arabic too — the label is an AR GAP, not an absence', () => {
    draw(12, 'ar');
    expect(visibleRows()).toHaveLength(4);
    expect(control()).not.toBeNull();
  });
});

describe('ActivityFeed — the near-empty cases', () => {
  it('shows three rows and no control: there is nothing beneath to disclose', () => {
    draw(3);
    expect(visibleRows()).toHaveLength(3);
    expect(control()).toBeNull();
  });

  it('shows exactly four and no control', () => {
    draw(4);
    expect(visibleRows()).toHaveLength(4);
    expect(control()).toBeNull();
  });

  it('shows five rows as four and a control — the first row that can be hidden', () => {
    draw(5);
    expect(visibleRows()).toHaveLength(4);
    expect(control()).not.toBeNull();
  });

  it('leaves the empty state exactly as it was — no control over nothing', () => {
    render(
      <LanguageProvider initial="en">
        <ActivityFeed rows={[]} onTopUp={vi.fn()} onOpen={vi.fn()} />
      </LanguageProvider>,
    );
    expect(visibleRows()).toHaveLength(0);
    expect(control()).toBeNull();
    expect(screen.queryByText('Nothing here yet')).not.toBeNull();
  });
});
