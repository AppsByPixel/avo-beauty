// @vitest-environment jsdom

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → APPOINTMENTS → "Add appointment", RENDERED AND DRIVEN.
 * ═══════════════════════════════════════════════════════════════════════════
 * `bookingWrites.test.tsx` proves the hook sends the right body for the input it
 * is given. This proves the FORM produces that input — which is a different
 * claim and the one a merchant's fingers actually test.
 *
 * THE FOUR GUARANTEES WORTH THE FILE:
 *
 *   1. THE TWO IDENTITIES REACH THE WIRE AS THE SERVER EXPECTS THEM.
 *      `POST /salons/{id}/bookings` reads `hasMember`/`hasGuest` off key
 *      PRESENCE and refuses both-or-neither by name. The member branch must
 *      therefore carry no guest keys at all, and that is a property of an object
 *      the type system cannot see.
 *
 *   2. THE IDEMPOTENCY KEY IS HELD ACROSS A RETRY OF THE SAME SUBMISSION AND
 *      RE-MINTED FOR A DIFFERENT ONE. #4, and the one most worth writing:
 *      neither half is visible in source text. Minting per attempt loses the
 *      replay the header exists for; holding one key across an EDITED body
 *      earns 422 `idempotency_key_reused`, which is the defect lane B found on
 *      the scanner's void sheet. Only driving two clicks and reading what
 *      `mutate` was called with tells a held key from a re-minted one.
 *
 *   3. THE FORM SAYS NO DEPOSIT IS TAKEN. The single most load-bearing sentence
 *      on the screen: a merchant who believes she has taken a deposit will act
 *      on that belief at the counter, and neither the customer nor anyone else
 *      finds out until after.
 *
 *   4. `slot_taken` IS A REFUSAL SHE CAN ACT ON. The exclusion constraint spans
 *      hand-written and app bookings on purpose, so a customer taking that hour
 *      from her phone mid-typing is the ordinary case — and the way out is one
 *      changed field, not a lost form.
 *
 * Cleanup is manual: no `globals: true` in this project.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';

/* ------------------------------------------------------------- the mocks -- */

const mutate = vi.fn();
const reset = vi.fn();
const createState = { isPending: false, isError: false, error: null as unknown };

const ARTISTS = {
  data: {
    items: [
      { id: 'AR-1a2b3c4d5e', salonId: 'SAL-AMARA', name: 'Noura Al-Rashid', nameAr: null, availabilitySource: 'manual' },
      { id: 'AR-9f8e7d6c5b', salonId: 'SAL-AMARA', name: 'Shaikha Al-Otaibi', nameAr: null, availabilitySource: 'manual' },
    ],
    nextCursor: null,
  },
  isPending: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
};

const SERVICES = {
  data: {
    items: [
      { id: 'SV-1a2b3c4d5e', salonId: 'SAL-AMARA', name: 'Balayage', nameAr: null, priceFils: 25000, active: true, image: null },
    ],
    nextCursor: null,
  },
  isPending: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: vi.fn(),
};

const bookState = {
  data: {
    pages: [
      {
        items: [
          {
            id: 'MB-1a2b3c4d5e',
            name: 'Dana Al-Sabah',
            memberErased: false,
            memberPhone: '+96599124408',
            tier: 'gold',
            balanceFils: 24500,
            visits: 7,
            joinedAt: '2026-01-04T08:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [null],
  } as unknown,
  isPending: false,
  isError: false,
  isFetching: false,
  error: null as unknown,
  refetch: vi.fn(),
};

vi.mock('../api/artists.js', () => ({ useBookableArtists: () => ARTISTS }));
vi.mock('../api/services.js', () => ({ useSalonServices: () => SERVICES }));
vi.mock('../api/customers.js', () => ({ useCustomerBook: () => bookState }));
vi.mock('../api/bookings.js', async () => {
  const real = await vi.importActual<typeof import('../api/bookings.js')>('../api/bookings.js');
  return {
    /*
     * THE BODY BUILDER AND THE PREDICATE ARE THE REAL ONES. `createBookingBody`
     * is what decides which identity keys exist, and a stub of it would make
     * this file's central assertion a statement about the stub. `isSlotTaken` is
     * a pure predicate; stubbing it would make the recoverable branch
     * unreachable here without anything saying so.
     */
    createBookingBody: real.createBookingBody,
    isSlotTaken: real.isSlotTaken,
    useCreateBooking: () => ({ mutate, reset, ...createState }),
  };
});

const { AppointmentForm, NO_DEPOSIT_NOTE, submissionKey } = await import('./AppointmentForm.js');
/** The REAL body builder, passed through by the mock factory above. */
const { createBookingBody } = await import('../api/bookings.js');

/**
 * `crypto.randomUUID` MADE COUNTABLE.
 *
 * The key rule is "one per submission, held across its retries" — so what is
 * being asserted is HOW MANY distinct values were minted and WHICH call got
 * which. A real UUID is unpredictable by design and makes that assertion
 * impossible to write; a counter makes it exact. Its own realm, restored after
 * every test.
 */
let minted = 0;
beforeEach(() => {
  minted = 0;
  /*
   * TIMERS ONLY. `toFake: ['setTimeout', 'clearTimeout']` and nothing else:
   * faking the clock wholesale takes React's scheduler with it, which is
   * `noShowMarkRender.test.tsx`'s note about `toFake: ['Date']` pointed the
   * other way.
   */
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () => `KEY-${++minted}` as `${string}-${string}-${string}-${string}-${string}`,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  createState.isPending = false;
  createState.isError = false;
  createState.error = null;
  bookState.isError = false;
  bookState.error = null;
  ARTISTS.isError = false;
  SERVICES.isError = false;
});

/* ------------------------------------------------------------- the driver -- */

function open(over: { canSearchDirectory?: boolean } = {}) {
  return render(
    <AppointmentForm
      timezone="Asia/Kuwait"
      canSearchDirectory={over.canSearchDirectory ?? true}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
}

/** Artist, service, date and time — everything but the identity. */
function fillTheSlot(time = '16:45') {
  fireEvent.change(screen.getByLabelText('Artist'), { target: { value: 'AR-1a2b3c4d5e' } });
  fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'SV-1a2b3c4d5e' } });
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-20' } });
  fireEvent.change(screen.getByLabelText('Time (Asia/Kuwait)'), { target: { value: time } });
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Add appointment' }));

/** The variables the last `mutate` was called with. */
function lastInput(): Record<string, unknown> {
  expect(mutate).toHaveBeenCalled();
  return mutate.mock.calls[mutate.mock.calls.length - 1]![0] as Record<string, unknown>;
}

/* ============================================ 1 · the two identities ======= */

describe('the form sends exactly one identity', () => {
  it('creates a booking for an existing member, with no guest fields', () => {
    open();
    fireEvent.change(screen.getByLabelText('Find the customer'), { target: { value: 'Dana' } });
    /*
     * THE 300ms DEBOUNCE IS `Customers.tsx`'s, so the two search boxes in this
     * app behave alike — and it is REAL here rather than mocked away, because
     * the result list is gated on the DEBOUNCED query and a test that skipped it
     * would assert against a branch the merchant never sees first.
     */
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.click(screen.getByRole('option', { name: /Dana Al-Sabah/ }));
    fillTheSlot();
    submit();

    const input = lastInput();
    expect(input.memberId).toBe('MB-1a2b3c4d5e');
    expect(input.guestName).toBeNull();
    expect(input.guestPhone).toBeNull();
    /*
     * AND THE KEYS THAT REACH THE WIRE. The hook's input carries `guestName:
     * null` because the type is total; `createBookingBody` is what decides that
     * the null does not become a KEY, and the route reads presence.
     */
    const body = createBookingBody({
      ...(input as unknown as Parameters<typeof createBookingBody>[0]),
      idempotencyKey: 'x',
    });
    expect('guestName' in body).toBe(false);
    expect('guestPhone' in body).toBe(false);
  });

  it('creates a booking for a walk-in, with a name and no memberId', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mariam Al-Ajmi' } });
    fireEvent.change(screen.getByLabelText('Phone (optional)'), {
      target: { value: '+96590011223' },
    });
    fillTheSlot();
    submit();

    const input = lastInput();
    expect(input.memberId).toBeNull();
    expect(input.guestName).toBe('Mariam Al-Ajmi');
    expect(input.guestPhone).toBe('+96590011223');
  });

  /**
   * THE WALL CLOCK BECOMES AN INSTANT IN THE SALON'S ZONE, NOT THE BROWSER'S.
   * 16:45 in Asia/Kuwait (UTC+3, no DST) is 13:45Z. A form that used
   * `new Date('2026-09-20T16:45')` would book a real appointment three hours
   * from the hour that was typed, silently, for anyone not sitting in Kuwait.
   */
  it('converts the typed time in the salon zone', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mariam' } });
    fillTheSlot();
    submit();
    expect(lastInput().startsAt).toBe('2026-09-20T13:45:00.000Z');
  });

  /** A name is required for a walk-in; nothing is sent without one. */
  it('refuses a nameless walk-in before it reaches the wire', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    fillTheSlot();
    submit();
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('Give the walk-in a name');
  });
});

/* ====================================== 2 · the key, held and re-minted ==== */

describe('the idempotency key names one submission', () => {
  /** The rule, as a function, at the boundary it is about. */
  it('holds a key while the body is unchanged and mints a new one when it is not', () => {
    let n = 0;
    const mint = vi.fn(() => `K${n++}`);
    const body = { artistId: 'A', serviceId: 'S', startsAt: 'T', guestName: 'M' };

    const first = submissionKey(null, body, mint);
    expect(first.key).toBe('K0');

    // A retry of the same submission: same body, same key, nothing minted.
    expect(submissionKey(first, { ...body }, mint).key).toBe('K0');
    expect(mint).toHaveBeenCalledTimes(1);

    // A changed field is a DIFFERENT request, and reusing the key would be 422.
    const second = submissionKey(first, { ...body, startsAt: 'T2' }, mint);
    expect(second.key).toBe('K1');
    expect(second.key).not.toBe(first.key);
  });

  /**
   * AND THE FORM ACTUALLY USES IT. The rule above is only worth having if the
   * component consults it, and a pure function nobody calls is a true sentence
   * with no effect.
   */
  it('sends the same key when the merchant retries an unchanged submission', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mariam' } });
    fillTheSlot();

    submit();
    const first = lastInput().idempotencyKey;

    // The write failed; nothing about the form has changed; she presses again.
    createState.isError = true;
    createState.error = new ApiError('We could not reach the workspace.', {
      status: 0,
      code: 'network_error',
    });
    submit();

    expect(lastInput().idempotencyKey).toBe(first);
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(minted).toBe(1);
  });

  it('mints a new key once the submission is a different one', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mariam' } });
    fillTheSlot('16:45');
    submit();
    const first = lastInput().idempotencyKey;

    // `slot_taken` — she moves it fifteen minutes and submits again. Different
    // body, therefore a different claim, therefore a different key.
    fireEvent.change(screen.getByLabelText('Time (Asia/Kuwait)'), { target: { value: '17:00' } });
    submit();

    const second = lastInput().idempotencyKey;
    expect(second).not.toBe(first);
    expect(minted).toBe(2);
  });

  /** Changing the CUSTOMER is a different submission too, not just the slot. */
  it('mints a new key when the identity changes', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mariam' } });
    fillTheSlot();
    submit();
    const first = lastInput().idempotencyKey;

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Hessa' } });
    submit();
    expect(lastInput().idempotencyKey).not.toBe(first);
  });
});

/* =========================================== 3 · the sentence that carries = */

describe('the form says no deposit is taken', () => {
  it('states it in the form, in the muted-label register', () => {
    open();
    const note = document.querySelector('.new-appt__note');
    expect(note?.textContent).toBe(NO_DEPOSIT_NOTE);
    expect(note?.textContent).toContain('No deposit is taken');
  });

  /**
   * IT SURVIVES THE WALK-IN BRANCH. The tab switch replaces the identity fields
   * and not the note — which is worth pinning, because the walk-in is the case
   * where a merchant is most likely to expect to take money at the desk.
   */
  it('is still there on the walk-in branch', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    expect(document.querySelector('.new-appt__note')?.textContent).toBe(NO_DEPOSIT_NOTE);
  });

  /** And the form never asks for an amount. The endpoint refuses one by name. */
  it('offers no deposit field', () => {
    open();
    expect(screen.queryByLabelText(/deposit/i)).toBeNull();
  });
});

/* ================================================= 4 · the recoverable 409 = */

describe('slot_taken is a refusal the merchant can act on', () => {
  beforeEach(() => {
    createState.isError = true;
    createState.error = new ApiError('That artist already has an appointment then.', {
      status: 409,
      code: 'slot_taken',
    });
  });

  it('names what to do next, and says nothing was written down', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('That artist already has an appointment then.');
    expect(alert.textContent).toContain('Pick another time, or another artist');
    expect(alert.textContent).toContain('nothing was written down');
  });

  /**
   * AND IT IS NOT THE GENERIC WRITE ERROR. `WriteError`'s reassurance is the
   * marker: a 409 that took the ordinary branch would read "No appointment was
   * created." — true, and silent about the fact that one more tap fixes it.
   */
  it('does not take the generic write-error branch', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    expect(screen.getByRole('alert').textContent).not.toContain('No appointment was created.');
  });

  /** The form keeps what she typed, so the retry is a correction. */
  it('keeps the fields she filled in', () => {
    open();
    fireEvent.click(screen.getByRole('radio', { name: 'Walk-in' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mariam' } });
    fillTheSlot();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Mariam');
    expect((screen.getByLabelText('Time (Asia/Kuwait)') as HTMLInputElement).value).toBe('16:45');
  });
});

/* ======================================================= 5 · the states ==== */

describe('the form owns its loading, empty, error and offline answers', () => {
  it('skeletons the fields it cannot draw yet', () => {
    ARTISTS.isPending = true;
    open();
    expect(document.querySelectorAll('.avo-skeleton').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Artist')).toBeNull();
    ARTISTS.isPending = false;
  });

  it('explains a failed roster read rather than drawing an empty dropdown', () => {
    ARTISTS.isError = true;
    /*
     * `status: 0` IS THE DEAD-NETWORK SHAPE, not 503. A SERVED 503 carries a
     * sentence the deployment wrote and `SectionError` renders that instead —
     * `sectionState.tsx § namedStateAnswer` exists precisely so a workspace that
     * ANSWERED is not reported as one that could not be reached.
     */
    (ARTISTS as { error: unknown }).error = new ApiError('The network is gone.', {
      status: 0,
      code: 'network_error',
    });
    open();
    expect(screen.getByRole('alert').textContent).toContain('No connection');
    expect(screen.queryByLabelText('Artist')).toBeNull();
  });

  it('names the empty roster and the screen that fills it', () => {
    const items = ARTISTS.data.items;
    ARTISTS.data.items = [];
    open();
    expect(
      [...(screen.getByLabelText('Artist') as HTMLSelectElement).options].map((o) => o.textContent),
    ).toContain('No artists yet — add one in Team');
    ARTISTS.data.items = items;
  });

  /**
   * A REFUSED READ OF THE CUSTOMER BOOK IS NOT MERELY A 403 — `requireCustomerDirectory`
   * writes a `risk` audit row against the account that asked. A form that
   * searched anyway would stamp one every 300ms while a receptionist typed, and
   * the salon's security log would fill with its own front desk doing its job.
   *
   * SO THE TAB IS DISABLED, THE REASON IS ON SCREEN, AND THE WALK-IN BRANCH IS
   * WHERE SHE LANDS. #7 is intact — the server still refuses — and this is the
   * courtesy that happens also to protect the audit log.
   */
  it('tells a front desk without Team authority to use the walk-in branch', () => {
    open({ canSearchDirectory: false });
    expect(document.body.textContent).toContain('needs the Team permission');
    expect(screen.queryByLabelText('Find the customer')).toBeNull();
    /*
     * `@avo/ui`'s `Segmented` renders the native `disabled` attribute, not
     * `aria-disabled` — worth pinning by the property it actually sets, because
     * that component's own note says "a disabled segment still receives focus,
     * so the reason can be announced" and `disabled` takes it out of the focus
     * order. Reported; the reason is rendered beside the tab rather than only on
     * it, so it is readable either way.
     */
    expect((screen.getByRole('radio', { name: 'Existing customer' }) as HTMLButtonElement).disabled)
      .toBe(true);
    // She is already on the branch she can use, rather than on a dead tab.
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });
});
