/**
 * `POST /staff/pair` on the wire, from the scanner's side.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10"; contract in packages/types § staff pairing.
 *
 * NOT A RECORDING. Lane A is building the route in parallel, so the 200 below is
 * built from `StaffPairResponseSchema`'s fields and the existing staff shape, not
 * transcribed from a live response. The live run against the real API is phase 2
 * of this slice, after lane A merges; until then this proves the scanner sends
 * what the contract says and reads what the contract says, and nothing more.
 *
 * `fetch` is stubbed with `vi.stubGlobal` in this worker only and restored after
 * each test — the pattern `customAmountWire.test.ts` already uses.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaffPairResponseSchema } from '@avo/types';
import { API_BASE_URL, ApiError } from './client';
import { pairPhone } from './staff';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stub(respond: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>),
    });
    return Promise.resolve(respond());
  });
  return calls;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOKEN = 'pX3v9Qk2LmN8rT5wYz1aB4cD6eF7gH0iJ-kL_mNoPqR';

/** The contract's response, field for field. */
const PAIRED = {
  salonId: 'SAL-AMARA',
  deviceId: 'DEV-7Q2M9K',
  accessToken: 'at_live',
  refreshToken: 'rt_live',
  expiresAt: '2026-11-10T20:00:00.000Z',
  staff: {
    id: 'STF-HESSA',
    salonId: 'SAL-AMARA',
    name: 'Hessa M.',
    handle: 'hessa',
    phone: '+96599124408',
    role: 'artist',
    branchAccess: 'all',
    pinSet: true,
    passwordSet: false,
    active: true,
    deactivatedAt: null,
    perms: {
      dashboard: false,
      appointments: true,
      shop: false,
      loyalty: false,
      team: false,
      scanner: true,
      charges: false,
      void: false,
      marketing: false,
    },
  },
};

describe('redeeming a pairing code', () => {
  it('the fixture is the contract, so these tests are about the scanner and not the fixture', () => {
    expect(StaffPairResponseSchema.safeParse(PAIRED).success).toBe(true);
  });

  it('posts the QR form unauthenticated, to the fixed route', async () => {
    const calls = stub(() => json(PAIRED));
    await pairPhone({ token: TOKEN, pin: '4826' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${API_BASE_URL}/staff/pair`);
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ token: TOKEN, pin: '4826' });
    // It is what mints the first token; there is nothing to send yet.
    expect(Object.keys(call?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain('authorization');
  });

  it('posts the typed form as phone, code and PIN', async () => {
    const calls = stub(() => json(PAIRED));
    await pairPhone({ phone: '+96599124408', code: '048213', pin: '4826' });
    expect(calls[0]?.body).toEqual({ phone: '+96599124408', code: '048213', pin: '4826' });
  });

  /**
   * The binding is the server's: the device id it ISSUED (the PIN only works
   * from that id), and the handle off the staff row — never anything the phone
   * made up. The session is in `signIn`'s shape, so the signed-in shell cannot
   * tell which door she came through.
   */
  it('returns the server-issued binding and a session in the sign-in shape', async () => {
    stub(() => json(PAIRED));
    const paired = await pairPhone({ token: TOKEN, pin: '4826' });
    expect(paired.binding).toEqual({ salonId: 'SAL-AMARA', deviceId: 'DEV-7Q2M9K', handle: 'hessa' });
    expect(paired.session).toEqual({
      accessToken: 'at_live',
      refreshToken: 'rt_live',
      expiresAt: '2026-11-10T20:00:00.000Z',
      staff: PAIRED.staff,
    });
  });

  it('refuses to send a body the contract would refuse, before the network', async () => {
    const calls = stub(() => json(PAIRED));
    await expect(pairPhone({ token: TOKEN, pin: '482' })).rejects.toThrow();
    await expect(pairPhone({ token: 'short', pin: '4826' })).rejects.toThrow();
    await expect(pairPhone({ phone: '99124408', code: '048213', pin: '4826' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('keeps the refusal code, so the screen can say the one sentence', async () => {
    stub(() =>
      json(
        { error: 'pairing_refused', message: 'That code did not work. Ask a manager for a new one.' },
        400,
      ),
    );
    const err = await pairPhone({ token: TOKEN, pin: '4826' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('pairing_refused');
    expect((err as ApiError).status).toBe(400);
  });

  it('keeps the 429', async () => {
    stub(() => json({ error: 'too_many_attempts', message: 'Too many attempts.' }, 429));
    const err = (await pairPhone({ token: TOKEN, pin: '4826' }).catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(429);
    expect(err.code).toBe('too_many_attempts');
  });

  /**
   * A 200 the contract does not describe is not a pairing. In particular, a
   * response without the server-issued device id must not become a binding
   * with an empty one — the PIN would never work from it.
   */
  it('rejects a 200 that is not the contract', async () => {
    const { deviceId: _dropped, ...withoutDevice } = PAIRED;
    stub(() => json(withoutDevice));
    const err = (await pairPhone({ token: TOKEN, pin: '4826' }).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.kind).toBe('server');
  });
});
