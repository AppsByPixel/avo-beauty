// @vitest-environment jsdom

/**
 * A STAFF MEMBER'S MOBILE NUMBER (DECISIONS.md § Staff phone pairing, 2026-11-10).
 *
 * Optional on New team account and editable on each card; a sign-in name beside
 * the username on the scanner and the dashboard. Eight digits are read as Kuwait,
 * anything else must already be E.164, and the server — not this field — decides
 * whether the number is free: `409 phone_taken` lands on the field, with the box
 * still open, and not in the screen's banner.
 *
 * The real `Accounts` screen is mounted; `authedRequest` is the only stand-in.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const authedRequest = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
}));
vi.mock('../auth/AuthProvider.js', () => ({
  useSalonId: () => 'SAL-AMARA',
  useSession: () => ({ staffId: 'ST-001', salonId: 'SAL-AMARA', perms: { team: true, dashboard: true } }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../api/salon.js', () => ({
  useSalon: () => ({
    data: { id: 'SAL-AMARA', timezone: 'Asia/Kuwait', branches: [{ id: 'BR-SAL', name: 'Salmiya' }] },
    isError: false,
  }),
}));

const { Accounts } = await import('./Accounts.js');
const { readStaffPhone, formatStaffPhone, STAFF_PHONE_FORMAT_HINT } = await import('../api/staff.js');
const { ApiError } = await import('../api/client.js');

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
  pinSet: true,
  passwordSet: true,
  active: true,
  deactivatedAt: null,
  perms: PERMS,
  ...over,
});
const STAFF = [
  staff('ST-001', 'Noura Al-Sabah', 'noura', { role: 'owner', perms: { ...PERMS, team: true } }),
  staff('ST-002', 'Hessa Al-Mutairi', 'hessa', { phone: '+96599112233' }),
  /** A roster row from a serialiser that does not emit `phone` yet — still parses. */
  (() => {
    const { phone: _omitted, ...row } = staff('ST-003', 'Dana Yousef', 'dana', { role: 'artist' });
    return row;
  })(),
  staff('ST-004', 'Mona Karim', 'mona', {
    phone: '+96550001111',
    active: false,
    deactivatedAt: '2026-08-01T00:00:00.000Z',
  }),
];

const PHONE_TAKEN = () =>
  new ApiError('Another active account in this salon already uses that number.', {
    status: 409,
    code: 'phone_taken',
  });

/** `(path, method, body) → response` — set per test; falls through to the roster. */
let write: (path: string, method: string, body: unknown) => unknown = () => {
  throw new Error('no write expected');
};

beforeEach(() => {
  window.history.replaceState(null, '', '/accounts');
  write = () => {
    throw new Error('no write expected');
  };
  authedRequest.mockImplementation(
    (_s: string, path: string, options?: { method?: string; body?: unknown }) => {
      const method = options?.method ?? 'GET';
      if (method === 'GET' && path === '/staff') {
        return Promise.resolve({ items: STAFF, nextCursor: null });
      }
      try {
        return Promise.resolve(write(path, method, options?.body));
      } catch (cause) {
        return Promise.reject(cause);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Accounts />
    </QueryClientProvider>,
  );
}

const writes = () => authedRequest.mock.calls.filter(([, , o]) => (o as { method?: string } | undefined)?.method);

/* ============================================================ reading it == */

describe('reading the number', () => {
  it.each([
    ['99123456', '+96599123456'],
    ['9912 3456', '+96599123456'],
    ['9912-3456', '+96599123456'],
    ['  55001122  ', '+96555001122'],
    ['+96599123456', '+96599123456'],
    ['+965 9912 3456', '+96599123456'],
    ['+447700900123', '+447700900123'],
  ])('%j → %s', (typed, sent) => {
    expect(readStaffPhone(typed)).toEqual({ ok: true, phone: sent });
  });

  it.each(['', '   '])('%j is no number at all — the field is optional', (typed) => {
    expect(readStaffPhone(typed)).toEqual({ ok: true, phone: null });
  });

  it.each(['1234567', '991234567', '+0123456789', 'abc', '+965', '965 9912 3456x'])(
    '%j is refused before any request',
    (typed) => {
      expect(readStaffPhone(typed)).toEqual({ ok: false, message: STAFF_PHONE_FORMAT_HINT });
    },
  );

  it('formats a Kuwait number in two fours and leaves any other as stored', () => {
    expect(formatStaffPhone('+96599123456')).toBe('+965 9912 3456');
    expect(formatStaffPhone('+447700900123')).toBe('+447700900123');
  });
});

/* ======================================================= New team account == */

async function openNewAccount() {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '+ Add teammate' }));
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Fatima R.' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'fatima.r' } });
}

describe('New team account — Mobile number', () => {
  it('sends an 8-digit number as +965 on POST /staff', async () => {
    write = (path, method, body) => {
      expect([path, method]).toEqual(['/staff', 'POST']);
      return staff('ST-009', 'Fatima R.', 'fatima.r', { phone: (body as { phone: string }).phone });
    };
    await openNewAccount();
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9912 3456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toMatchObject({
      method: 'POST',
      body: { name: 'Fatima R.', handle: 'fatima.r', phone: '+96599123456' },
    });
    // The new card shows it.
    expect(await screen.findByText('+965 9912 3456')).toBeTruthy();
  });

  it('sends no phone key at all when the field is left empty', async () => {
    write = () => staff('ST-009', 'Fatima R.', 'fatima.r');
    await openNewAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(Object.keys((writes()[0]![2] as { body: object }).body)).not.toContain('phone');
  });

  it('refuses a number it cannot read, on the field, without a request', async () => {
    await openNewAccount();
    const field = screen.getByLabelText('Mobile number');
    fireEvent.change(field, { target: { value: '12345' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByRole('alert').textContent).toContain(STAFF_PHONE_FORMAT_HINT);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id);
    expect(writes()).toHaveLength(0);
  });

  it('409 phone_taken lands on the field, not in the banner — and typing a new number clears it', async () => {
    write = () => {
      throw PHONE_TAKEN();
    };
    await openNewAccount();
    const field = screen.getByLabelText('Mobile number');
    fireEvent.change(field, { target: { value: '99112233' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Another active account in this salon already uses that number.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.queryByText('No account was created.')).toBeNull();
    // The form stays open with what she typed.
    expect((field as HTMLInputElement).value).toBe('99112233');

    fireEvent.change(field, { target: { value: '99112234' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(field.getAttribute('aria-invalid')).toBeNull();
  });

  it('any other refusal still uses the banner', async () => {
    write = () => {
      throw new ApiError('That username is already taken in this salon.', {
        status: 409,
        code: 'handle_taken',
      });
    };
    await openNewAccount();
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('That username is already taken in this salon.');
    expect(alert.textContent).toContain('No account was created.');
  });
});

/* ================================================================ the card == */

describe('the card — showing and editing the number', () => {
  it('shows the number formatted, or says there is none', async () => {
    mount();
    const hessa = (await screen.findByText('Hessa Al-Mutairi')).closest('.account') as HTMLElement;
    expect(within(hessa).getByText('+965 9911 2233')).toBeTruthy();
    const dana = screen.getByText('Dana Yousef').closest('.account') as HTMLElement;
    expect(within(dana).getByText('No mobile number')).toBeTruthy();
  });

  it('a leaver’s number is shown but not editable', async () => {
    mount();
    const mona = (await screen.findByText('Mona Karim')).closest('.account') as HTMLElement;
    expect(within(mona).getByText('+965 5000 1111')).toBeTruthy();
    expect(within(mona).queryByRole('button', { name: /mobile number/ })).toBeNull();
  });

  it('adds a number with PATCH /staff/{id} { phone }, and shows what the server stored', async () => {
    write = (path, method, body) => {
      expect([path, method]).toEqual(['/staff/ST-003', 'PATCH']);
      return staff('ST-003', 'Dana Yousef', 'dana', {
        role: 'artist',
        phone: (body as { phone: string }).phone,
      });
    };
    mount();
    const add = await screen.findByRole('button', { name: 'Add mobile number — Dana Yousef' });
    fireEvent.click(add);
    const field = screen.getByLabelText('Mobile number');
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: '5500 1122' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save number' }));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toMatchObject({ method: 'PATCH', body: { phone: '+96555001122' } });
    // Only the number moved — the audit row should say so and nothing else.
    expect(Object.keys((writes()[0]![2] as { body: object }).body)).toEqual(['phone']);
    const dana = (await screen.findByText('+965 5500 1122')).closest('.account') as HTMLElement;
    expect(within(dana).queryByLabelText('Mobile number')).toBeNull();
    // Focus returns to the control that opened the editor.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dana).getByRole('button', { name: 'Change mobile number — Dana Yousef' }),
      ),
    );
  });

  it('emptying the field removes the number: phone null', async () => {
    write = () => staff('ST-002', 'Hessa Al-Mutairi', 'hessa', { phone: null });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Change mobile number — Hessa Al-Mutairi' }));
    const field = screen.getByLabelText('Mobile number') as HTMLInputElement;
    expect(field.value).toBe('+965 9911 2233');
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save number' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![2]).toMatchObject({ method: 'PATCH', body: { phone: null } });
  });

  it('saving the number it already has sends nothing', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Change mobile number — Hessa Al-Mutairi' }));
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '99112233' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save number' }));
    expect(screen.queryByLabelText('Mobile number')).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('409 phone_taken lands on the field with the editor still open, not in the screen banner', async () => {
    write = () => {
      throw PHONE_TAKEN();
    };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add mobile number — Dana Yousef' }));
    const field = screen.getByLabelText('Mobile number');
    fireEvent.change(field, { target: { value: '99112233' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save number' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Another active account in this salon already uses that number.');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByLabelText('Mobile number')).toBe(field);
    expect(screen.queryByText('That account is unchanged.')).toBeNull();
  });

  it('a malformed number is refused on the field without a request', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Add mobile number — Dana Yousef' }));
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save number' }));
    expect(screen.getByRole('alert').textContent).toContain(STAFF_PHONE_FORMAT_HINT);
    expect(writes()).toHaveLength(0);
  });
});

/* ===================================================== the number's line == */

/**
 * A NUMBER IS NEVER BROKEN ACROSS TWO LINES. Measured live on 2026-11-10 at
 * 1280 wide: a new account's head carries "No PIN" and "Invite pending", which
 * squeezed `.account__ident` to 129px, and "+965 9988 7766" rendered as
 * "+965 9988" over "7766" (30px tall where the other cards' line was 15px).
 * jsdom has no layout, so what is pinned is the cascade that prevents it, read
 * off the real card: the number (or "No mobile number") does not wrap inside,
 * and the row it sits in DOES wrap, so "Change" / "Add" moves under it instead
 * of pushing it to break.
 */
describe('the card — the number stays on one line', () => {
  const sheets: HTMLStyleElement[] = [];
  beforeAll(() => {
    for (const relative of ['../../../../packages/ui/src/ui.css', '../app.css']) {
      const style = document.createElement('style');
      style.textContent = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      document.head.appendChild(style);
      sheets.push(style);
    }
  });
  afterAll(() => {
    for (const style of sheets) style.remove();
  });

  it('a number and "No mobile number" are each one unbreakable unit; the row wraps around them', async () => {
    mount();
    const hessa = (await screen.findByText('Hessa Al-Mutairi')).closest('.account') as HTMLElement;
    const number = within(hessa).getByText('+965 9911 2233');
    const dana = screen.getByText('Dana Yousef').closest('.account') as HTMLElement;
    const none = within(dana).getByText('No mobile number');
    for (const text of [number, none]) {
      expect(getComputedStyle(text).whiteSpace).toBe('nowrap');
      const row = text.parentElement as HTMLElement;
      expect(row.classList.contains('account__phone')).toBe(true);
      expect(getComputedStyle(row).flexWrap).toBe('wrap');
    }
  });
});
