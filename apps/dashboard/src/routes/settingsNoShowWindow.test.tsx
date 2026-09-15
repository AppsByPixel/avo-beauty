// @vitest-environment jsdom

/**
 * Merchant → Settings → Booking deposit → the no-show return window.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Aftab's item 6: "what if they dont have enough payment (sometimes they dont
 * have money but lock the booking and they dont come) deposit health option for
 * merchants". The merchant's complaint is a customer who locks a slot with a
 * deposit and never arrives. One third of that is this control.
 *
 * `noShowReturnMinutes` has been merchant-editable on the server since the route
 * was written — `MERCHANT_EDITABLE` carries it, `parseNoShowReturnMinutes`
 * validates it, `salon_no_show_return_positive` CHECKs it — and this dashboard
 * READ it and only displayed it: `DepositPanel`'s foot sentence rendered
 * `returnLabel` and nothing on the surface could change the number. So the panel
 * told a merchant a rule about her own money and gave her no way to set it,
 * directly beneath a stepper that sets the deposit immediately.
 *
 * NEW WORK. The design bundle draws NO control here. `AVO Merchant Dashboard
 * .dc.html:1059` is a static strip — `No-show: deposit returns to the wallet
 * <b>1 hour</b> after a missed slot.` — with the hour hard-coded in the markup
 * and no affordance beside it. So the SENTENCE is the designer's, verbatim and
 * unchanged, and the CONTROL is invented. Said plainly rather than implied, so a
 * later reader does not go looking for a dropdown in the bundle.
 *
 * WHAT THIS FILE IS NOT ABOUT — FORFEITURE
 * ----------------------------------------
 * The bundle's own notification copy at `AVO Merchant Dashboard.dc.html:1136`
 * reads "Deposit is yours to keep or release." That is a THIRD thing — the
 * merchant keeping the money — and it is not built, deliberately, and it is
 * escalated. It contradicts the product description in so many words:
 * `design/AVO-Beauty-Product-Description-v2.md:45` says the deposit
 * "automatically returns to their wallet. (Money never leaves the ecosystem; the
 * deposit creates commitment, not punishment.)" and `api-contract.md:365` repeats
 * it. Nothing in this file's copy may imply forfeiture, and nothing in it does:
 * every string here says the money RETURNS.
 *
 * THE CONTROL'S SHAPE, AND WHY IT IS A LIST AND NOT A STEPPER
 * ----------------------------------------------------------
 * The deposit above it is a `Stepper` with a hard 1–10 KD range that the database
 * states (`salon_deposit_range`) and the route re-states (`parseDepositFils`).
 * The window has NO upper bound anywhere: `parseNoShowReturnMinutes` asks for "a
 * whole number of minutes greater than zero" and the CHECK is `> 0`. A stepper
 * needs `min`, `max` and `step`, so all three numbers would be invented — and
 * `Stepper` CLAMPS (`Math.min(max, Math.max(min, next))`), which means a salon
 * holding a value outside an invented range would have it silently rewritten by a
 * client the moment anyone touched the control. `e2e/tenancy.test.ts:709` already
 * sends `noShowReturnMinutes: 999` and calls it valid, so such salons are
 * reachable today.
 *
 * A fixed option list invents a CHOICE rather than a BOUND, does not clamp, and
 * has one property a stepper cannot have: every value the control can produce is
 * enumerable, so the design's sentence can be checked at all of them rather than
 * argued about. That check is `the sentence and the option agree` below.
 *
 * WHERE THE BOUND BELONGS, PINNED RATHER THAN PAPERED OVER
 * -------------------------------------------------------
 * On the server, and it is `api/`'s job — not this lane's. A client bound is a
 * validation the next client will not have, which is non-negotiable #7's
 * reasoning applied to a range instead of a permission, and the console's
 * `PATCH /v1/platform/salons/{id}` is already a second door onto the same column.
 * The last `it()` in the server section is a tripwire that goes red the day a
 * ceiling lands, and its message says what to do about it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fils, type Salon } from '@avo/types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SalonPatch } from '../api/settings.js';
import { stripComments } from '../testing/stripComments.js';
import { DepositPanel } from './Settings.js';

/* `shopRender.test.tsx`'s reason: vitest does not run with `globals`, so nothing
 * registers @testing-library/react's own cleanup and every render would
 * accumulate in one document. */
afterEach(cleanup);

/** `apps/dashboard/src/routes` → repo root. */
const REPO = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => stripComments(readFileSync(join(REPO, rel), 'utf8'));

const SALONS_ROUTE = 'api/src/routes/salons.ts';
const SALON_SCHEMA = 'api/src/db/schema/salon.ts';
const BOOKING_SERVICE = 'api/src/services/booking.ts';

/* ------------------------------------------------------------------- server */

/**
 * The body of `const MERCHANT_EDITABLE = new Set([ … ])`, as string literals.
 *
 * Sliced to the Set rather than grepped file-wide, for
 * `settingsReceiptChannels.test.tsx`' reason: `salons.ts` also declares
 * `PLATFORM_ONLY_EDITABLE` and `PLATFORM_EDITABLE`, and a file-wide search
 * answers for whichever it lands in.
 */
function merchantEditable(): string[] {
  const src = read(SALONS_ROUTE);
  const open = src.indexOf('const MERCHANT_EDITABLE = new Set([');
  expect(open, `MERCHANT_EDITABLE not found in ${SALONS_ROUTE}`).toBeGreaterThan(-1);
  const close = src.indexOf('])', open);
  expect(close).toBeGreaterThan(open);
  return [...src.slice(open, close).matchAll(/'([^']+)'/g)].flatMap((m) => m[1] ?? []);
}

/** The body of `function parseNoShowReturnMinutes(`, to its column-0 brace. */
function validatorBody(): string {
  const src = read(SALONS_ROUTE);
  const open = src.indexOf('function parseNoShowReturnMinutes(');
  expect(open, `parseNoShowReturnMinutes not found in ${SALONS_ROUTE}`).toBeGreaterThan(-1);
  const close = src.indexOf('\n}', open);
  expect(close).toBeGreaterThan(open);
  return src.slice(open, close);
}

describe('the server half — what a merchant may set, and what nothing stops her setting', () => {
  /**
   * The day this leaves the set, every change made through the control below
   * comes back as a `not_editable` 400 and the select goes on rendering as if it
   * worked. `settingsModules.test.ts`' lesson, one field over.
   */
  it('lets a merchant edit the window at all', () => {
    expect(merchantEditable()).toContain('noShowReturnMinutes');
  });

  /** It has to come BACK, or the select has nothing to reflect after a write. */
  it('serves the value the control reflects', () => {
    expect(read(SALONS_ROUTE)).toContain('noShowReturnMinutes: s.noShowReturnMinutes');
  });

  /** The floor. Zero and negatives are the server's refusal, not the client's. */
  it('states a floor, in the route and in the database', () => {
    expect(validatorBody()).toContain('value <= 0');
    expect(read(SALON_SCHEMA)).toContain('salon_no_show_return_positive');
  });

  /**
   * THE NUMBER IS TWO WINDOWS, NOT ONE — and this is the whole argument for a
   * ceiling, so it is pinned rather than left in prose.
   *
   * `findApplicableHold` reuses it as the EARLY-ARRIVAL GRACE at the till:
   * `starts_at <= now + noShowReturnMinutes` decides which held deposit a charge
   * may consume. Its own header spells out the failure that predicate exists to
   * prevent — "A customer with an appointment next Tuesday who walks in today for
   * a blow-dry must not have Tuesday's deposit spent on it". A large enough
   * window re-opens exactly that, by configuration rather than by code.
   */
  it('reuses the same number as the early-arrival grace at the till', () => {
    const src = read(BOOKING_SERVICE);
    expect(src).toContain('params.noShowReturnMinutes * 60_000');
    expect(src).toContain('lte(booking.startsAt, graceEnd)');
  });

  /**
   * A TRIPWIRE, NOT AN ALARM. Read the message before treating a red here as a
   * regression.
   */
  it('has no ceiling — which is the reported gap, and is why the list below stops short', () => {
    const body = validatorBody();
    const hasCeiling = /value\s*>\s*\d/.test(body) || /MAX/.test(body);
    expect(
      hasCeiling,
      'A ceiling has landed on parseNoShowReturnMinutes. That is the reported api/ gap being ' +
        'closed, and it is good news. Now revisit RETURN_WINDOW_PRESETS in Settings.tsx: its ' +
        'top option was chosen against an unbounded server and must sit inside the server’s ' +
        'range, and its bottom must sit above the floor. Then delete this assertion.',
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------- client */

const SALON: Salon = {
  id: 'SAL-AMARA',
  name: 'Amara Salon',
  nameAr: 'صالون أمارة',
  plan: 'growth',
  city: 'Kuwait City',
  brandColor: '#6E7F6C',
  modules: { booking: true, shop: false },
  loyaltyMode: 'tiers',
  tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
  depositFils: fils(5000),
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  branches: [{ id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية' }],
  social: [],
  whatsappEnabled: true,
  emailEnabled: false,
};

const salonWith = (over: Partial<Salon>): Salon => ({ ...SALON, ...over });

type Updater = Parameters<typeof DepositPanel>[0]['update'];

/**
 * The real `useUpdateSalon` result is a react-query object; the panel reaches for
 * three of its fields. A stub carrying exactly those three keeps the assertions
 * below on the RENDERED DOM rather than on a mock's call log alone — the calls
 * are checked too, but never instead.
 */
function stubUpdate(over: { isPending?: boolean; variables?: SalonPatch } = {}) {
  const calls: SalonPatch[] = [];
  const update = {
    isPending: over.isPending ?? false,
    variables: over.variables,
    mutate: (patch: SalonPatch) => void calls.push(patch),
  } as unknown as Updater;
  return { update, calls };
}

/** The select, by its accessible name. */
const windowSelect = () =>
  screen.getByRole('combobox', { name: 'No-show return window' }) as HTMLSelectElement;

/** The design's foot sentence, and the emphasised phrase inside it. */
const footEmphasis = (container: HTMLElement) =>
  container.querySelector('.settings__foot b') as HTMLElement | null;

/**
 * THE OPTIONS, WRITTEN OUT RATHER THAN IMPORTED.
 *
 * `MERCHANT_EDITABLE`'s lesson, from `salons.ts`' own comment: "A test that
 * derives its expectation from the thing it is testing cannot fail when the thing
 * changes." Importing `RETURN_WINDOW_PRESETS` and asserting the select offers
 * `RETURN_WINDOW_PRESETS` would pass against any list at all, including an empty
 * one. These five minute counts and these five words are the expectation.
 *
 * FIFTEEN MINUTES AT THE BOTTOM, FOUR HOURS AT THE TOP, and both ends are about
 * the till rather than about taste — see the module header and
 * `Settings.tsx § RETURN_WINDOW_PRESETS` for the argument.
 */
const PRESETS: ReadonlyArray<[number, string]> = [
  [15, '15 minutes'],
  [30, '30 minutes'],
  [60, '1 hour'],
  [120, '2 hours'],
  [240, '4 hours'],
];

describe('the control the design does not draw', () => {
  it('draws a select the merchant can actually reach', () => {
    const { update } = stubUpdate();
    render(<DepositPanel salon={SALON} update={update} />);
    expect(windowSelect()).toBeTruthy();
  });

  it('offers the five presets, in order, and nothing else', () => {
    const { update } = stubUpdate();
    render(<DepositPanel salon={SALON} update={update} />);
    const labels = [...windowSelect().options].map((o) => o.textContent);
    expect(labels).toEqual(PRESETS.map(([, label]) => label));
  });

  it('shows the window the server holds, not the default', () => {
    const { update } = stubUpdate();
    render(<DepositPanel salon={salonWith({ noShowReturnMinutes: 120 })} update={update} />);
    expect(windowSelect().value).toBe('120');
    expect(windowSelect().selectedOptions[0]?.textContent).toBe('2 hours');
  });

  /**
   * THE PROPERTY THE LIST EXISTS FOR, AND THE BRIEF'S QUESTION ANSWERED AT EVERY
   * VALUE RATHER THAN ARGUED.
   *
   * The design's sentence carries the window inside it — "returns to the wallet
   * <b>1 hour</b> after a missed slot" — so a control that can produce a value
   * the sentence renders badly breaks settled copy. Every reachable value is
   * driven through a real render and the two words are compared to each other,
   * not to a constant.
   */
  it.each(PRESETS)('the sentence and the option agree at %i minutes', (minutes, label) => {
    const { update } = stubUpdate();
    const { container } = render(
      <DepositPanel salon={salonWith({ noShowReturnMinutes: minutes })} update={update} />,
    );
    expect(footEmphasis(container)?.textContent).toBe(label);
    expect(windowSelect().selectedOptions[0]?.textContent).toBe(label);
  });

  /**
   * "1 minutes" — the singular the foot sentence got wrong, and it was reachable
   * from the server the whole time: the CHECK is `> 0`, so 1 is storable.
   */
  it('says "1 minute", not "1 minutes"', () => {
    const { update } = stubUpdate();
    const { container } = render(
      <DepositPanel salon={salonWith({ noShowReturnMinutes: 1 })} update={update} />,
    );
    expect(footEmphasis(container)?.textContent).toBe('1 minute');
  });

  /**
   * THE CASE THAT DECIDES WHETHER THE CONTROL IS HONEST, and the one a `Stepper`
   * could not have passed: it clamps, so 999 would have been silently pulled to
   * the top of an invented range the first time anyone opened the panel.
   *
   * 999 is not hypothetical — `e2e/tenancy.test.ts:709` sends it.
   */
  it('carries a value it does not offer rather than rewriting it', () => {
    const { update, calls } = stubUpdate();
    const { container } = render(
      <DepositPanel salon={salonWith({ noShowReturnMinutes: 999 })} update={update} />,
    );
    expect(windowSelect().value).toBe('999');
    expect(windowSelect().selectedOptions[0]?.textContent).toBe('999 minutes');
    expect(footEmphasis(container)?.textContent).toBe('999 minutes');
    // Rendering is not writing. Nothing was sent to correct her salon.
    expect(calls).toEqual([]);
  });

  it('sorts a carried value into the list rather than appending it', () => {
    const { update } = stubUpdate();
    render(<DepositPanel salon={salonWith({ noShowReturnMinutes: 45 })} update={update} />);
    expect([...windowSelect().options].map((o) => o.value)).toEqual([
      '15',
      '30',
      '45',
      '60',
      '120',
      '240',
    ]);
  });
});

describe('the write path — the screen’s one mutation, and its refusal', () => {
  it('sends the chosen window and nothing else', () => {
    const { update, calls } = stubUpdate();
    render(<DepositPanel salon={SALON} update={update} />);
    fireEvent.change(windowSelect(), { target: { value: '120' } });
    expect(calls).toEqual([{ noShowReturnMinutes: 120 }]);
  });

  /**
   * ONE KEY, for `applyModules`' reason one panel up: the server only touches a
   * column whose key is present, so a write built from a stale render cannot take
   * the deposit with it.
   */
  it('never sends the deposit alongside it', () => {
    const { update, calls } = stubUpdate();
    render(<DepositPanel salon={SALON} update={update} />);
    fireEvent.change(windowSelect(), { target: { value: '15' } });
    expect(Object.keys(calls[0] ?? {})).toEqual(['noShowReturnMinutes']);
  });

  it('sends nothing when the merchant re-picks the window she already has', () => {
    const { update, calls } = stubUpdate();
    render(<DepositPanel salon={SALON} update={update} />);
    fireEvent.change(windowSelect(), { target: { value: '60' } });
    expect(calls).toEqual([]);
  });

  /**
   * IN FLIGHT: THE CONTROL SHOWS HER CHOICE, THE SENTENCE SHOWS THE SALON'S RULE.
   *
   * Not an inconsistency — the two say different things. The select is the
   * merchant's intent and must not snap back under her hand; the sentence is a
   * claim about what happens to a CUSTOMER'S money and must never run ahead of
   * the server. `useUpdateSalon` writes nothing optimistically for the same
   * reason ("a stepper showing 7 KD while the server still holds 5"). They
   * re-agree the moment the write settles, either way it settles.
   */
  it('shows the in-flight choice on the control and the held rule in the sentence', () => {
    const { update } = stubUpdate({ isPending: true, variables: { noShowReturnMinutes: 240 } });
    const { container } = render(<DepositPanel salon={SALON} update={update} />);
    expect(windowSelect().value).toBe('240');
    expect(footEmphasis(container)?.textContent).toBe('1 hour');
  });

  it('locks the control while a write is in flight', () => {
    const { update } = stubUpdate({ isPending: true, variables: { noShowReturnMinutes: 240 } });
    render(<DepositPanel salon={SALON} update={update} />);
    expect(windowSelect().disabled).toBe(true);
  });

  /**
   * A PENDING WRITE THAT IS NOT THIS ONE MUST NOT MOVE THIS CONTROL. `update` is
   * ONE mutation shared by every panel on the screen — the modules, the deposit,
   * both receipt switches — so `isPending` alone would show a WhatsApp flip as a
   * changed return window. `variables` is what separates them.
   */
  it('ignores another panel’s write', () => {
    const { update } = stubUpdate({ isPending: true, variables: { whatsappEnabled: false } });
    render(<DepositPanel salon={SALON} update={update} />);
    expect(windowSelect().value).toBe('60');
  });

  /**
   * THE REFUSAL PATH IS THE SCREEN'S, NOT A SECOND ONE. When the PATCH fails,
   * `useUpdateSalon` does not invalidate, the salon prop is unchanged, and
   * `isPending` is false — so the select renders the server's value again with no
   * reset logic of its own. `Settings` puts `WriteError` under the panels.
   */
  it('returns to the held value when the write settles without changing it', () => {
    const { update } = stubUpdate({ isPending: false, variables: { noShowReturnMinutes: 240 } });
    const { container } = render(<DepositPanel salon={SALON} update={update} />);
    expect(windowSelect().value).toBe('60');
    expect(footEmphasis(container)?.textContent).toBe('1 hour');
  });

  /** Loading is the panel's existing skeleton; a control with no salon is a lie. */
  it('draws no control until the salon has loaded', () => {
    const { update } = stubUpdate();
    render(<DepositPanel salon={undefined} update={update} />);
    expect(screen.queryByRole('combobox', { name: 'No-show return window' })).toBeNull();
  });
});

/* --------------------------------------------------------------- the weight */

/**
 * The foot sentence's `<b>` under the real cascade, for `emphasisWeight.test.tsx`'
 * reason: `<b>` with no author rule is not unstyled, it is the UA sheet's
 * `font-weight: bolder`, which against 400 copy resolves to 700 — and the design
 * pins this exact phrase at 600 inline. The global `b, strong` rule now covers
 * it; this pins the covered instance rather than the rule, because a scoped rule
 * added to `.settings__foot` later could beat it silently.
 */
describe('the emphasised window carries the design weight', () => {
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

  it('renders the window at 600, never the browser’s 700', () => {
    const { update } = stubUpdate();
    const { container } = render(<DepositPanel salon={SALON} update={update} />);
    const emphasis = footEmphasis(container);
    expect(emphasis?.textContent).toBe('1 hour');
    expect(getComputedStyle(emphasis!).fontWeight).toBe('600');
  });
});
