// @vitest-environment jsdom

/**
 * MERCHANT → ACCOUNTS → "PAIR A PHONE" (DECISIONS.md § Staff phone pairing,
 * 2026-11-10). The dialog that shows one single-use pairing code three ways — a QR,
 * six digits, and how long both have left — and the gates in front of it.
 *
 * The real `Accounts` screen is mounted with its real hooks and the real dialog;
 * `authedRequest` is the only stand-in, so every assertion about a request is about
 * the request the screen actually builds.
 *
 * THE PROPERTY WORTH MORE THAN THE REST: the pairing token is a bearer credential
 * for one staff member's scanner identity until it expires. It may exist in the
 * dialog's state and in the QR drawn from it, and nowhere else — so after a close
 * the storage, the URL, the history entry, the query client's caches and the
 * console are all searched for it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** This jsdom ships no working Storage (see signInWorkspaceField.test.tsx). */
function installStorage(name: 'localStorage' | 'sessionStorage') {
  const existing = window[name] as unknown;
  if (existing && typeof (existing as Storage).setItem === 'function') return;
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  };
  Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
}
installStorage('localStorage');
installStorage('sessionStorage');

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));

/** Mutable per test: the gates under test are these two booleans. */
const session = {
  staffId: 'ST-001',
  salonId: 'SAL-AMARA',
  perms: { team: true, dashboard: true } as Record<string, boolean>,
};
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => session,
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const ONE_BRANCH = [{ id: 'BR-SAL', name: 'Salmiya' }];
const TWO_BRANCHES = [
  { id: 'BR-SAL', name: 'Salmiya' },
  { id: 'BR-KWT', name: 'Kuwait City' },
];
let branches = ONE_BRANCH;
vi.mock('../api/salon.js', () => ({
  useSalon: () => ({
    data: { id: 'SAL-AMARA', timezone: 'Asia/Kuwait', branches },
    isError: false,
  }),
}));

const { Accounts } = await import('./Accounts.js');
const { formatCountdown, groupDigits, pairingDeadline, pairingPayload, qrPath } = await import(
  './PairPhoneDialog.js'
);
const { ApiError } = await import('../api/client.js');
const { STAFF_PAIRING_URL } = await import('@avo/types');
const { create: createQr } = await import('qrcode');

/* ------------------------------------------------------------- the roster -- */

const PERMS = {
  dashboard: false,
  appointments: true,
  shop: false,
  loyalty: false,
  team: false,
  scanner: true,
  charges: false,
  void: false,
  marketing: false,
};
const staff = (id: string, name: string, handle: string, over: Record<string, unknown> = {}) => ({
  id,
  salonId: 'SAL-AMARA',
  name,
  handle,
  phone: null,
  role: 'frontdesk',
  branchAccess: 'all',
  pinSet: false,
  passwordSet: true,
  active: true,
  deactivatedAt: null,
  perms: PERMS,
  ...over,
});
const STAFF = [
  staff('ST-001', 'Noura Al-Sabah', 'noura', { role: 'owner', perms: { ...PERMS, team: true } }),
  staff('ST-002', 'Hessa Al-Mutairi', 'hessa', { phone: '+96599112233' }),
  staff('ST-003', 'Dana Yousef', 'dana', { role: 'artist', branchAccess: ['BR-KWT'] }),
  staff('ST-004', 'Mona Karim', 'mona', {
    active: false,
    deactivatedAt: '2026-08-01T00:00:00.000Z',
  }),
];

/* ------------------------------------------------------------ the codes -- */

/** At least 32 characters, as `StaffPairingCodeSchema.token` requires. */
const TOKEN = 'pt_9f2c41d0b7e8a3c5f6d2e1b0a9c8d7e6f5a4b3c2';
const TOKEN_2 = 'pt_00aa11bb22cc33dd44ee55ff66778899aabbccdd';
const NOW = new Date('2026-11-10T12:00:00.000Z').getTime();

function codeBody(over: Record<string, unknown> = {}) {
  return {
    staffId: 'ST-002',
    token: TOKEN,
    code: '123456',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    branchId: 'BR-SAL',
    ...over,
  };
}

/** Responses for the pairing route, in order. A function is called with the body. */
let pairingAnswers: Array<(body: unknown) => unknown> = [];

/** What `GET /staff` answers. Mutable per test, so a refetch can carry a change. */
let roster: ReadonlyArray<ReturnType<typeof staff>> = STAFF;

beforeEach(() => {
  branches = ONE_BRANCH;
  session.perms = { team: true, dashboard: true };
  pairingAnswers = [];
  roster = STAFF;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/accounts');
  authedRequest.mockImplementation((_scope: string, path: string, options?: { body?: unknown }) => {
    if (path === '/staff') return Promise.resolve({ items: roster, nextCursor: null });
    if (/^\/staff\/[^/]+\/pairing-code$/.test(path)) {
      const next = pairingAnswers.shift();
      if (!next) throw new Error(`no pairing answer queued for ${path}`);
      try {
        return Promise.resolve(next(options?.body));
      } catch (cause) {
        return Promise.reject(cause);
      }
    }
    throw new Error(`unrouted ${path}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Accounts />
    </QueryClientProvider>,
  );
  return { client, ...view };
}

const pairingCalls = () =>
  authedRequest.mock.calls.filter(([, path]) => /pairing-code$/.test(String(path)));

/**
 * The countdown is written twice: once for the eye (every tick, `aria-hidden`) and
 * once in a polite live region that only moves every 15 seconds (§2). Read apart.
 */
const shownExpiry = (dialog: HTMLElement) =>
  dialog.querySelector('.pair__expiry > [aria-hidden="true"]')?.textContent ?? null;
const announcedExpiry = (dialog: HTMLElement) =>
  dialog.querySelector('.pair__expiry > [aria-live="polite"]')?.textContent ?? null;

async function openFor(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Pair a phone — ${name}` }));
  return screen.findByRole('dialog', { name: 'Pair a phone' });
}

/**
 * NO INVENTED SENTENCE GUESSES A PRONOUN. Every word in this dialog is invented
 * (no design file draws it), and nobody's pronouns are recorded — so trunk's rule
 * for invented copy applies: name the account, as the Scan & charge warning does.
 * Design-sourced copy is verbatim by rule and is not this test's business; none
 * of it appears in this dialog.
 */
const PRONOUN = /\b(she|her|hers|he|him|his|they|them)\b/i;

/** The instructions under the digits, exactly — one sentence per route. */
const instructionsFor = (name: string, phone: string | null) =>
  `Open the AVO Staff app on ${name}'s phone and scan this code. ${name} then chooses a PIN on the phone — you never see it. ` +
  (phone === null
    ? `To pair without the camera, add a mobile number to ${name}'s account first.`
    : `No camera? ${name} can enter this account's mobile number, ${phone}, and the six digits instead.`);

/* ================================================================ helpers == */

describe('the pure parts', () => {
  it('the QR payload is the contract’s, byte for byte', () => {
    expect(pairingPayload(TOKEN)).toBe(`${STAFF_PAIRING_URL}?t=${TOKEN}`);
    expect(pairingPayload(TOKEN)).toBe(`avostaff://pair?t=${TOKEN}`);
  });

  it('the QR path draws every dark module and only those', () => {
    const payload = pairingPayload(TOKEN);
    const { size, d } = qrPath(payload);
    // Expand the merged runs back into cells…
    const drawn = new Set<string>();
    for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, run] = [Number(m[1]), Number(m[2]), Number(m[3])];
      for (let k = 0; k < run; k++) drawn.add(`${x + k},${y}`);
    }
    // …and compare with the encoder's own matrix for the same payload.
    const { modules } = createQr(payload, { errorCorrectionLevel: 'M' });
    expect(size).toBe(modules.size);
    const dark = new Set<string>();
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) if (modules.get(row, col)) dark.add(`${col},${row}`);
    }
    expect(dark.size).toBeGreaterThan(0);
    expect([...drawn].sort()).toEqual([...dark].sort());
    // A different payload draws a different code.
    expect(qrPath(pairingPayload(TOKEN_2)).d).not.toBe(d);
  });

  it('groups the six digits in threes', () => {
    expect(groupDigits('123456')).toBe('123 456');
  });

  it('counts down in m:ss, rounding up, never below zero', () => {
    expect(formatCountdown(600_000)).toBe('10:00');
    expect(formatCountdown(599_001)).toBe('10:00');
    expect(formatCountdown(599_000)).toBe('9:59');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(1)).toBe('0:01');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5_000)).toBe('0:00');
  });

  it('ends the countdown at the earlier of the server’s expiry and the TTL — a slow clock never overstates', () => {
    // Server says 10 minutes from a clock 5 minutes behind ours: we would show 5.
    expect(pairingDeadline(new Date(NOW + 5 * 60_000).toISOString(), NOW)).toBe(NOW + 5 * 60_000);
    // Server says 15 minutes (our clock is slow): capped at the 10-minute TTL.
    expect(pairingDeadline(new Date(NOW + 15 * 60_000).toISOString(), NOW)).toBe(NOW + 10 * 60_000);
    expect(pairingDeadline('not a date', NOW)).toBe(NOW + 10 * 60_000);
  });
});

/* ================================================================ dialog == */

describe('Pair a phone — the code', () => {
  it('requests a code for that staff member and shows the QR, the digits, her name and the countdown', async () => {
    pairingAnswers.push(() => codeBody());
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');

    expect(await within(dialog).findByText('123 456')).toBeTruthy();
    expect(pairingCalls()).toHaveLength(1);
    const [scope, path, options] = pairingCalls()[0]!;
    expect(scope).toBe('merchant');
    expect(path).toBe('/staff/ST-002/pairing-code');
    expect(options).toMatchObject({ method: 'POST', body: { branchId: 'BR-SAL' } });
    expect((options as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);

    expect(within(dialog).getByText('Hessa Al-Mutairi')).toBeTruthy();
    expect(shownExpiry(dialog)).toMatch(/^Expires in (10:00|9:5\d)$/);

    // The QR on screen is the contract's payload for THIS token.
    const qr = within(dialog).getByRole('img', { name: 'Pairing QR code for Hessa Al-Mutairi' });
    expect(qr.querySelector('path')?.getAttribute('d')).toBe(qrPath(pairingPayload(TOKEN)).d);

    // The account has a number, so the no-camera route gives it — and the
    // sentence names the account rather than guessing a pronoun.
    const steps = within(dialog).getByText(instructionsFor('Hessa Al-Mutairi', '+965 9911 2233'));
    expect(steps.textContent).toBe(instructionsFor('Hessa Al-Mutairi', '+965 9911 2233'));
    expect(steps.textContent).not.toMatch(PRONOUN);
  });

  it('says the typed route needs a number when the account has none', async () => {
    pairingAnswers.push(() => codeBody({ staffId: 'ST-003' }));
    mount();
    const dialog = await openFor('Dana Yousef');
    await within(dialog).findByText('123 456');
    const steps = within(dialog).getByText(instructionsFor('Dana Yousef', null));
    expect(steps.textContent).toBe(instructionsFor('Dana Yousef', null));
    expect(steps.textContent).not.toMatch(PRONOUN);
  });

  it('counts down, then replaces the QR and digits with an expired notice and a New code button', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
    pairingAnswers.push(() => codeBody());
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');
    expect(shownExpiry(dialog)).toBe('Expires in 10:00');
    expect(announcedExpiry(dialog)).toBe('Expires in 10:00');

    act(() => vi.advanceTimersByTime(1_000));
    expect(shownExpiry(dialog)).toBe('Expires in 9:59');
    // The live region steps in fifteens, not every tick.
    expect(announcedExpiry(dialog)).toBe('Expires in 10:00');
    act(() => vi.advanceTimersByTime(14_000));
    expect(shownExpiry(dialog)).toBe('Expires in 9:45');
    expect(announcedExpiry(dialog)).toBe('Expires in 9:45');
    act(() => vi.advanceTimersByTime(1_000));
    expect(announcedExpiry(dialog)).toBe('Expires in 9:45');

    act(() => vi.advanceTimersByTime(7 * 60_000 + 45_000));
    expect(shownExpiry(dialog)).toBe('Expires in 1:59');

    act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(within(dialog).queryByText('123 456')).toBeNull();
    expect(within(dialog).queryByRole('img', { name: /Pairing QR code/ })).toBeNull();
    expect(within(dialog).queryByText(/Expires in/)).toBeNull();
    expect(within(dialog).getByText('This code has expired.')).toBeTruthy();
    expect(within(dialog).getByText("Get a new code to pair Hessa Al-Mutairi's phone.")).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'New code' })).toBeTruthy();
    // Nothing of the dead code is left in the dialog.
    expect(dialog.innerHTML).not.toContain('123456');
  });

  it('New code at expiry asks again, for the same branch', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
    pairingAnswers.push(() => codeBody());
    pairingAnswers.push(() => codeBody({ token: TOKEN_2, code: '654321' }));
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');
    act(() => vi.advanceTimersByTime(10 * 60_000));
    fireEvent.click(within(dialog).getByRole('button', { name: 'New code' }));

    expect(await within(dialog).findByText('654 321')).toBeTruthy();
    expect(shownExpiry(dialog)).toBe('Expires in 10:00');
    expect(pairingCalls()).toHaveLength(2);
    expect(pairingCalls()[1]![2]).toMatchObject({ body: { branchId: 'BR-SAL' } });
    const qr = within(dialog).getByRole('img', { name: /Pairing QR code/ });
    expect(qr.querySelector('path')?.getAttribute('d')).toBe(qrPath(pairingPayload(TOKEN_2)).d);
  });

  it('New code before expiry takes the old digits off the screen at the click, then shows the new ones', async () => {
    pairingAnswers.push(() => codeBody());
    let release: (value: unknown) => void = () => undefined;
    pairingAnswers.push(
      () =>
        new Promise((resolve) => {
          release = () => resolve(codeBody({ token: TOKEN_2, code: '654321' }));
        }),
    );
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');
    expect(within(dialog).getByText('A new code replaces this one — this one stops working.')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'New code' }));
    // The server voids the old code when it issues the new one: it must not linger.
    expect(within(dialog).queryByText('123 456')).toBeNull();
    expect(within(dialog).getByText('Getting a code…')).toBeTruthy();

    await act(async () => release(undefined));
    expect(await within(dialog).findByText('654 321')).toBeTruthy();
    expect(pairingCalls()).toHaveLength(2);
  });
});

/* ============================================= the Scan & charge warning == */

/**
 * RULING (Aftab, in chat, 2026-11-10 — "yes add the scan and charge warning too").
 * Pairing an account whose Scan & charge is off succeeds and the phone signs in —
 * and then cannot take a charge, with nothing in this dialog having said so. The
 * dialog now says so. A WARNING, NOT A BLOCK: a paired phone is also how a staff
 * member reads My bookings and My schedule, which need no Scan & charge, so the
 * code is still requested and still shown either way.
 *
 * The copy is exact, and names the account twice rather than using a pronoun —
 * nobody's pronouns are recorded.
 */
describe('the Scan & charge warning', () => {
  const warningFor = (name: string) =>
    `${name} can sign in on this phone but can't take payments yet: Scan & charge is off for this account. Turn it on from the card to let ${name} charge.`;

  /** The roster with one account's `perms.scanner` set. */
  const withScanner = (id: string, scanner: boolean) =>
    STAFF.map((s) => (s.id === id ? { ...s, perms: { ...s.perms, scanner } } : s));

  /** Every request the screen made was the roster read or the one pairing POST. */
  const onlyRosterAndPairing = () =>
    authedRequest.mock.calls.every(
      ([, path]) => path === '/staff' || /^\/staff\/[^/]+\/pairing-code$/.test(String(path)),
    );

  it('perms.scanner off: the warning, in exact words, above the QR and digits — and the code is still issued and shown', async () => {
    roster = withScanner('ST-002', false);
    pairingAnswers.push(() => codeBody());
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    const digits = await within(dialog).findByText('123 456');

    const notice = within(dialog).getByText(warningFor('Hessa Al-Mutairi'));
    expect(notice.textContent).toBe(warningFor('Hessa Al-Mutairi'));
    // The name, substituted both times.
    expect(notice.textContent?.split('Hessa Al-Mutairi')).toHaveLength(3);
    expect(notice.textContent).not.toMatch(/\{name\}|\b(she|her|he|him|his|they|them)\b/i);
    // The chip's own label, so a manager can find it on the card.
    expect(notice.textContent).toContain('Scan & charge');

    // Above the QR and the digits.
    const qr = within(dialog).getByRole('img', { name: 'Pairing QR code for Hessa Al-Mutairi' });
    expect(notice.compareDocumentPosition(qr) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(digits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The dialog's description, so it is read when focus enters the dialog.
    expect(notice.id).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBe(notice.id);

    // A warning, not a block.
    expect(pairingCalls()).toHaveLength(1);
    expect(pairingCalls()[0]![1]).toBe('/staff/ST-002/pairing-code');
    expect(qr.querySelector('path')?.getAttribute('d')).toBe(qrPath(pairingPayload(TOKEN)).d);
    expect(onlyRosterAndPairing()).toBe(true);
  });

  it('perms.scanner on: no warning — and the same code is issued and shown', async () => {
    roster = withScanner('ST-002', true);
    pairingAnswers.push(() => codeBody());
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');

    expect(within(dialog).queryByText(/can't take payments/)).toBeNull();
    expect(dialog.textContent).not.toContain('Scan & charge is off');
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);

    expect(pairingCalls()).toHaveLength(1);
    const qr = within(dialog).getByRole('img', { name: 'Pairing QR code for Hessa Al-Mutairi' });
    expect(qr.querySelector('path')?.getAttribute('d')).toBe(qrPath(pairingPayload(TOKEN)).d);
  });

  it('names whichever account the dialog is for', async () => {
    roster = withScanner('ST-003', false);
    pairingAnswers.push(() => codeBody({ staffId: 'ST-003' }));
    mount();
    const dialog = await openFor('Dana Yousef');
    await within(dialog).findByText('123 456');
    expect(within(dialog).getByText(warningFor('Dana Yousef'))).toBeTruthy();
  });

  it('is not shown over a refusal — "can sign in on this phone" beside "Nothing was paired." would contradict it', async () => {
    roster = withScanner('ST-002', false);
    pairingAnswers.push(() => {
      throw new ApiError('That account has been removed from the team.', {
        status: 409,
        code: 'staff_deactivated',
      });
    });
    pairingAnswers.push(() => codeBody());
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByRole('alert');
    expect(within(dialog).queryByText(/can't take payments/)).toBeNull();
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);

    // Try again lands a code, and the warning is back above it.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await within(dialog).findByText('123 456');
    expect(within(dialog).getByText(warningFor('Hessa Al-Mutairi'))).toBeTruthy();
  });

  it('goes away when the roster refetches with Scan & charge on — the card’s own data, no request of its own', async () => {
    roster = withScanner('ST-002', false);
    pairingAnswers.push(() => codeBody());
    const { client } = mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');
    expect(within(dialog).getByText(warningFor('Hessa Al-Mutairi'))).toBeTruthy();

    // Granted elsewhere — another tab, another manager — and the roster is re-read.
    roster = withScanner('ST-002', true);
    await act(async () => client.invalidateQueries());

    await waitFor(() => expect(within(dialog).queryByText(/can't take payments/)).toBeNull());
    expect(dialog.hasAttribute('aria-describedby')).toBe(false);
    // The same dialog and the same code: the refetch neither closed it nor re-issued.
    expect(screen.getByRole('dialog', { name: 'Pair a phone' })).toBe(dialog);
    expect(within(dialog).getByText('123 456')).toBeTruthy();
    expect(pairingCalls()).toHaveLength(1);
    expect(onlyRosterAndPairing()).toBe(true);
  });
});

/* ======================================================== the token stays put */

describe('the token lives in the dialog and nowhere else', () => {
  it('after close it is not in storage, the URL, history, the query caches or the console', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const setLocal = vi.spyOn(window.localStorage, 'setItem');
    const setSession = vi.spyOn(window.sessionStorage, 'setItem');
    pairingAnswers.push(() => codeBody());
    const { client } = mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');

    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const secrets = [TOKEN, '123456'];
    const storage = (s: Storage) =>
      Array.from({ length: s.length }, (_, i) => `${s.key(i)}=${s.getItem(s.key(i) ?? '')}`).join('\n');
    for (const secret of secrets) {
      expect(storage(window.localStorage)).not.toContain(secret);
      expect(storage(window.sessionStorage)).not.toContain(secret);
      expect(window.location.href).not.toContain(secret);
      expect(JSON.stringify(window.history.state ?? null)).not.toContain(secret);
      expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain(secret);
      expect(JSON.stringify(client.getMutationCache().getAll().map((m) => m.state.data))).not.toContain(
        secret,
      );
      expect(document.body.innerHTML).not.toContain(secret);
    }
    for (const write of [...setLocal.mock.calls, ...setSession.mock.calls]) {
      expect(String(write[1])).not.toContain(TOKEN);
    }
    for (const spy of consoleSpies) {
      for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toContain(TOKEN);
    }
  });

  it('closing mid-request aborts it, and a late answer lands nowhere', async () => {
    let seen: AbortSignal | undefined;
    let release: () => void = () => undefined;
    authedRequest.mockImplementation((_s: string, path: string, options?: { signal?: AbortSignal }) => {
      if (path === '/staff') return Promise.resolve({ items: STAFF, nextCursor: null });
      seen = options?.signal;
      return new Promise((resolve) => {
        release = () => resolve(codeBody());
      });
    });
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await waitFor(() => expect(seen).toBeDefined());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(seen?.aborted).toBe(true);
    await act(async () => release());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });
});

/* =========================================================== the branch == */

describe('which branch the code names', () => {
  it('one branch and perms.dashboard: sends it without asking', async () => {
    pairingAnswers.push((body) => {
      expect(body).toEqual({ branchId: 'BR-SAL' });
      return codeBody();
    });
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');
    expect(within(dialog).queryByLabelText('Till branch')).toBeNull();
  });

  it('two branches and perms.dashboard: asks first, and only then requests', async () => {
    branches = TWO_BRANCHES;
    pairingAnswers.push(() => codeBody({ branchId: 'BR-KWT' }));
    mount();
    // Noura has branchAccess "all", so nothing is preselected.
    const dialog = await openFor('Noura Al-Sabah');
    const select = within(dialog).getByLabelText('Till branch') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(
      within(dialog).getByText(
        "Noura Al-Sabah's phone is also set up as a till at this branch, so the charges taken on it count there.",
      ),
    ).toBeTruthy();
    const show = within(dialog).getByRole('button', { name: 'Show code' }) as HTMLButtonElement;
    expect(show.disabled).toBe(true);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(pairingCalls()).toHaveLength(0);

    fireEvent.change(select, { target: { value: 'BR-KWT' } });
    expect(show.disabled).toBe(false);
    fireEvent.click(show);
    await within(dialog).findByText('123 456');
    expect(pairingCalls()).toHaveLength(1);
    expect(pairingCalls()[0]![2]).toMatchObject({ body: { branchId: 'BR-KWT' } });
  });

  it('two branches: starts on hers when she works at exactly one', async () => {
    branches = TWO_BRANCHES;
    mount();
    const dialog = await openFor('Dana Yousef');
    expect((within(dialog).getByLabelText('Till branch') as HTMLSelectElement).value).toBe('BR-KWT');
  });

  it('without perms.dashboard: no branch select, and no branchId sent — even at a two-branch salon', async () => {
    branches = TWO_BRANCHES;
    session.perms = { team: true, dashboard: false };
    pairingAnswers.push((body) => {
      expect(body).toEqual({});
      return codeBody({ branchId: null });
    });
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');
    expect(within(dialog).queryByLabelText('Till branch')).toBeNull();
    expect(pairingCalls()[0]![2]).toMatchObject({ body: {} });
  });
});

/* ============================================== the copy names the account == */

describe('the invented copy names the account — never a pronoun nobody recorded', () => {
  it('choose, requesting, shown and expired each read without she, her, he, him or his', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: NOW });
    branches = TWO_BRANCHES;
    let release: (value: unknown) => void = () => undefined;
    pairingAnswers.push(
      () =>
        new Promise((resolve) => {
          release = () => resolve(codeBody({ staffId: 'ST-003', branchId: 'BR-KWT' }));
        }),
    );
    mount();
    // Dana: no mobile number, one branch of two — so the select, the
    // no-number route and the expiry all render, one after another.
    const dialog = await openFor('Dana Yousef');

    expect(within(dialog).getByLabelText('Till branch')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(PRONOUN);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Show code' }));
    expect(within(dialog).getByText('Getting a code…')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(PRONOUN);

    await act(async () => release(undefined));
    await within(dialog).findByText('123 456');
    expect(within(dialog).getByText(instructionsFor('Dana Yousef', null))).toBeTruthy();
    expect(dialog.textContent).not.toMatch(PRONOUN);

    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(within(dialog).getByText('This code has expired.')).toBeTruthy();
    expect(dialog.textContent).not.toMatch(PRONOUN);
  });
});

/* ========================================================== the refusals == */

describe('a refused code', () => {
  it('a deactivated target: the server’s sentence, nothing paired, Try again — and the roster is re-read', async () => {
    pairingAnswers.push(() => {
      throw new ApiError('That account has been removed from the team.', {
        status: 409,
        code: 'staff_deactivated',
      });
    });
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('That account has been removed from the team.');
    expect(alert.textContent).toContain('Nothing was paired.');
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeTruthy();
    await waitFor(() =>
      expect(authedRequest.mock.calls.filter(([, p]) => p === '/staff').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('a 403 renders the server’s refusal, not a generic failure', async () => {
    pairingAnswers.push(() => {
      throw new ApiError('You need the Team & accounts permission.', { status: 403, code: 'forbidden' });
    });
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'You need the Team & accounts permission.',
    );
  });
});

/* ======================================================= keyboard & focus == */

describe('keyboard and focus (interaction-spec.md §2)', () => {
  it('focus moves into the dialog on open, and not onto a way out', async () => {
    pairingAnswers.push(() => codeBody());
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');
    expect(dialog.contains(document.activeElement)).toBe(true);
    // The panel itself, or a control that is not a way out — never Close or Done.
    const active = document.activeElement as HTMLElement;
    expect(active === dialog || !active.hasAttribute('data-pair-close')).toBe(true);
    expect(active.getAttribute('aria-label')).not.toBe('Close');
  });

  it('Tab is trapped: past the last control it wraps to the first, and Shift+Tab back', async () => {
    pairingAnswers.push(() => codeBody());
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    await within(dialog).findByText('123 456');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const done = within(dialog).getByRole('button', { name: 'Done' });

    done.focus();
    fireEvent.keyDown(done, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(done);
  });

  it('Escape closes and focus returns to the Pair a phone button that opened it', async () => {
    pairingAnswers.push(() => codeBody());
    mount();
    const trigger = await screen.findByRole('button', { name: 'Pair a phone — Hessa Al-Mutairi' });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Pair a phone' });
    await within(dialog).findByText('123 456');

    fireEvent.keyDown(document.activeElement ?? window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('is a labelled modal dialog', async () => {
    pairingAnswers.push(() => codeBody());
    mount();
    const dialog = await openFor('Hessa Al-Mutairi');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  });
});

/* ======================================================= the courtesy gate */

describe('who is offered Pair a phone', () => {
  it('nobody, without perms.team', async () => {
    session.perms = { team: false, dashboard: true };
    mount();
    await screen.findByText('Hessa Al-Mutairi');
    expect(screen.queryByRole('button', { name: /^Pair a phone/ })).toBeNull();
  });

  it('every active account with perms.team — and never a leaver', async () => {
    mount();
    await screen.findByText('Hessa Al-Mutairi');
    for (const name of ['Noura Al-Sabah', 'Hessa Al-Mutairi', 'Dana Yousef']) {
      expect(screen.getByRole('button', { name: `Pair a phone — ${name}` })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'Pair a phone — Mona Karim' })).toBeNull();
  });

  it('issues nothing until the button is pressed', async () => {
    mount();
    await screen.findByText('Hessa Al-Mutairi');
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(pairingCalls()).toHaveLength(0);
  });
});
