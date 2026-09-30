// @vitest-environment jsdom

/**
 * ONE WALLET APP — the sign-in half. The signed-in account decides the
 * workspace, not the build (Aftab, 2026-09-29).
 *
 * Driven through the real `SignInScreen`, the real `api/auth.ts` and the real
 * client, with `fetch` stubbed at the wire, so every claim here is about the
 * bytes that leave the phone:
 *
 *   1. the first post carries phone and password and NO `salonId`;
 *   2. one match lands in the workspace the server named — the session, the
 *      palette and the remembered workspace are all its;
 *   3. `409 choose_workspace` shows a picker, and the re-post carries the
 *      `salonId` she picked;
 *   4. a refusal on the re-post is the server's sentence, verbatim;
 *   5. the sign-in screen is titled for the LAST workspace, or the default;
 *   6. a reset request carries the last workspace, or no `salonId` at all;
 *   7. Arabic: the picker reads right to left, in the salon's Arabic name,
 *      with the feminine imperative.
 */

import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brandPresets, deriveBrandSet } from '@avo/tokens';
import { theme } from '@avo/tokens/native';
import { MemberSchema, type Language, type Salon } from '@avo/types';
import { tapAndSettle } from '../testing/tapAndSettle';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
    multiRemove: async (ks: string[]) => void ks.forEach((k) => store.delete(k)),
  },
}));
vi.mock('react-native-svg', () => {
  const nothing = () => null;
  return { default: nothing, Svg: nothing, Path: nothing, Circle: nothing, Rect: nothing, G: nothing };
});

/** `GET /salons/{id}` — the one read `enterWorkspace` makes on a change. */
const { getSalon } = vi.hoisted(() => ({ getSalon: vi.fn() }));
vi.mock('../api/wallet', () => ({
  getSalon,
  getMember: vi.fn(),
  getTransactions: vi.fn(),
  getPromotions: vi.fn(),
}));

/* eslint-disable import/first */
import { SignInScreen } from './SignInScreen';
import { ForgotPasswordScreen } from './ForgotPasswordScreen';
import { LanguageProvider } from '../i18n/language';
import { en } from '../copy/en';
import { ar } from '../copy/ar';
import { __resetSessionForTest, sessionOwner } from '../api/session';
import { requestPasswordReset } from '../api/auth';
import { __resetLastWorkspaceForTest, lastWorkspace, rememberWorkspace } from '../state/lastWorkspace';
import { applyBrandColor } from '../theme/brand';

// ------------------------------------------------------------------ fixtures --

const AMARA_HEX = brandPresets.amaraSage.brand;
const FOREST_HEX = brandPresets.forest.brand;
const derived = (hex: string) => {
  const r = deriveBrandSet(hex);
  if (!r.ok) throw new Error(`${hex} refused: ${r.reason}`);
  return r.set;
};

const AMARA_ROW = { salonId: 'SAL-AMARA', name: 'Amara', nameAr: 'أمارا', brandColor: AMARA_HEX };
/** No Arabic name — the row must fall back to the Latin one, not render blank. */
const FOREST_ROW = { salonId: 'SAL-FOREST', name: 'Forest', nameAr: null, brandColor: FOREST_HEX };

const member = (salonId: string, id: string) =>
  MemberSchema.parse({
    id,
    salonId,
    name: 'Dana Al-Sabah',
    phone: '+96599124408',
    email: 'dana@example.com',
    emailVerified: true,
    balanceFils: 24500,
    visits: 5,
    tier: 'gold',
    stamps: null,
    policyVersion: 3,
    joinedAt: '2026-02-11T18:20:00+03:00',
  });

const session = (salonId: string, id: string) => ({
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: '2026-10-01T00:00:00Z',
  member: member(salonId, id),
});

interface Posted {
  path: string;
  body: Record<string, unknown>;
}

/** Answers each POST with the next scripted reply, and records every body. */
function stubApi(replies: Array<{ status: number; body: unknown }>): Posted[] {
  const posted: Posted[] = [];
  let i = 0;
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    posted.push({ path: u.pathname, body: JSON.parse(String(init.body ?? '{}')) });
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }));
  });
  return posted;
}

const salon = (id: string, name: string, hex: string, walletCard: 'tier' | 'brand') =>
  ({ id, name, nameAr: null, brandColor: hex, walletCard }) as unknown as Salon;

function draw(lang: Language = 'en', onSignedIn = vi.fn()) {
  render(
    <LanguageProvider initial={lang}>
      <SignInScreen onSignedIn={onSignedIn} onCreateAccount={vi.fn()} onForgotPassword={vi.fn()} />
    </LanguageProvider>,
  );
  return onSignedIn;
}

async function typeAndSubmit() {
  fireEvent.change(screen.getByTestId('signin-phone'), { target: { value: ' +96599124408 ' } });
  fireEvent.change(screen.getByTestId('signin-password'), { target: { value: 'hunter22' } });
  await tapAndSettle(screen.getByTestId('signin-submit'));
}

const CHOOSE = {
  status: 409,
  body: {
    error: 'choose_workspace',
    message: 'This number has a wallet at more than one salon.',
    // `ApiError.toJSON` on the API spreads details at the top level.
    workspaces: [AMARA_ROW, FOREST_ROW],
  },
};

beforeEach(() => {
  store.clear();
  getSalon.mockReset();
  __resetSessionForTest();
  __resetLastWorkspaceForTest();
  applyBrandColor(AMARA_HEX);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ═══════════════════════════════════════════════════════ 1 · no salonId ══

describe('1. sign-in sends phone and password, and no salonId', () => {
  it('the first post has exactly two keys', async () => {
    const posted = stubApi([{ status: 200, body: session('SAL-AMARA', '8842') }]);
    getSalon.mockResolvedValue(salon('SAL-AMARA', 'Amara', AMARA_HEX, 'tier'));
    draw();
    await typeAndSubmit();
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.path).toBe('/auth/member/session');
    expect(Object.keys(posted[0]!.body).sort()).toEqual(['password', 'phone']);
    expect(posted[0]!.body).not.toHaveProperty('salonId');
    expect(posted[0]!.body['phone']).toBe('+96599124408');
  });
});

// ═════════════════════════════════════════════════ 2 · one match ══

describe('2. one match lands in the workspace the server named', () => {
  it('a Forest answer is a Forest session, a Forest palette and a remembered Forest — before onSignedIn', async () => {
    stubApi([{ status: 200, body: session('SAL-FOREST', 'F-77') }]);
    getSalon.mockResolvedValue(salon('SAL-FOREST', 'Forest', FOREST_HEX, 'brand'));
    let paletteAtSwap: string | null = null;
    const onSignedIn = draw('en', vi.fn(() => void (paletteAtSwap = theme.color.brand)));
    await typeAndSubmit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));

    expect(sessionOwner()).toEqual({ salonId: 'SAL-FOREST', memberId: 'F-77' });
    expect(getSalon).toHaveBeenCalledWith('SAL-FOREST', undefined);
    expect(getSalon.mock.calls.every(([id]) => id === 'SAL-FOREST')).toBe(true);
    // The wallet mounts on `onSignedIn` — and by then it is already Forest green.
    expect(paletteAtSwap).toBe(derived(FOREST_HEX).brand);
    expect(theme.card.from).toBe(derived(FOREST_HEX).cardFrom);
    expect(lastWorkspace()?.salonId).toBe('SAL-FOREST');
  });

  it('the same workspace as last time makes no extra read', async () => {
    await rememberWorkspace(AMARA_ROW);
    stubApi([{ status: 200, body: session('SAL-AMARA', '8842') }]);
    const onSignedIn = draw();
    await typeAndSubmit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(getSalon).not.toHaveBeenCalled();
  });

  it('a salon read that fails leaves the DEFAULT palette, not the workspace she left', async () => {
    applyBrandColor(brandPresets.noorRose.brand);
    await rememberWorkspace({ ...AMARA_ROW, salonId: 'SAL-NOOR', brandColor: brandPresets.noorRose.brand });
    stubApi([{ status: 200, body: session('SAL-FOREST', 'F-77') }]);
    getSalon.mockRejectedValue(new Error('offline'));
    const onSignedIn = draw();
    await typeAndSubmit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(theme.color.brand).not.toBe(derived(brandPresets.noorRose.brand).brand);
  });
});

// ═════════════════════════════════════════════ 3 · choose_workspace ══

describe('3. choose_workspace shows the picker and re-posts with the choice', () => {
  it('two rows, each with its own dot; tapping Forest re-posts WITH SAL-FOREST', async () => {
    const posted = stubApi([CHOOSE, { status: 200, body: session('SAL-FOREST', 'F-77') }]);
    const onSignedIn = draw();
    await typeAndSubmit();

    await waitFor(() => expect(screen.getByTestId('signin-workspaces')).toBeTruthy());
    expect(screen.getByText(en.workspacePickerTitle)).toBeTruthy();
    expect(en.workspacePickerTitle).toBe('Choose your salon');
    expect(screen.getByText(en.workspacePickerSub)).toBeTruthy();
    expect(screen.getByTestId('signin-workspace-SAL-AMARA').textContent).toBe('Amara');
    expect(screen.getByTestId('signin-workspace-SAL-FOREST').textContent).toBe('Forest');
    const dot = (id: string) => getComputedStyle(screen.getByTestId(`signin-workspace-dot-${id}`)).backgroundColor;
    expect(dot('SAL-AMARA')).toBe(rgb(AMARA_HEX));
    expect(dot('SAL-FOREST')).toBe(rgb(FOREST_HEX));
    // The picker stands in for the button; nothing has signed her in yet.
    expect(screen.queryByTestId('signin-submit')).toBeNull();
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(sessionOwner()).toBeNull();

    await tapAndSettle(screen.getByTestId('signin-workspace-SAL-FOREST'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));

    expect(posted.map((p) => p.path)).toEqual(['/auth/member/session', '/auth/member/session']);
    expect(posted[0]!.body).not.toHaveProperty('salonId');
    expect(posted[1]!.body).toEqual({ salonId: 'SAL-FOREST', phone: '+96599124408', password: 'hunter22' });
    expect(sessionOwner()?.salonId).toBe('SAL-FOREST');
    // The picked row carried the hex, so no round trip was needed for it.
    expect(getSalon).not.toHaveBeenCalled();
    expect(theme.color.brand).toBe(derived(FOREST_HEX).brand);
    expect(lastWorkspace()).toEqual(FOREST_ROW);
  });

  it('a keystroke drops the picker — the choice was for THOSE credentials', async () => {
    stubApi([CHOOSE]);
    draw();
    await typeAndSubmit();
    await waitFor(() => expect(screen.getByTestId('signin-workspaces')).toBeTruthy());
    fireEvent.change(screen.getByTestId('signin-password'), { target: { value: 'hunter2' } });
    expect(screen.queryByTestId('signin-workspaces')).toBeNull();
    expect(screen.getByTestId('signin-submit')).toBeTruthy();
  });

  it('a refusal on the re-post is the server sentence, verbatim, and the form comes back', async () => {
    stubApi([
      CHOOSE,
      { status: 401, body: { error: 'invalid_credentials', message: 'Those details do not match. Try again.' } },
    ]);
    const onSignedIn = draw();
    await typeAndSubmit();
    await waitFor(() => expect(screen.getByTestId('signin-workspaces')).toBeTruthy());
    await tapAndSettle(screen.getByTestId('signin-workspace-SAL-AMARA'));
    await waitFor(() =>
      expect(screen.getByTestId('signin-refusal').textContent).toBe('Those details do not match. Try again.'),
    );
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(screen.getByTestId('signin-submit')).toBeTruthy();
    // #6 — the password went with the call that resolved.
    expect((screen.getByTestId('signin-password') as HTMLInputElement).value).toBe('');
  });

  it('a malformed list is not a picker — the server sentence shows instead', async () => {
    stubApi([{ status: 409, body: { ...CHOOSE.body, workspaces: [{ salonId: 'SAL-X' }] } }]);
    draw();
    await typeAndSubmit();
    await waitFor(() => expect(screen.getByTestId('signin-refusal').textContent).toBe(CHOOSE.body.message));
    expect(screen.queryByTestId('signin-workspaces')).toBeNull();
  });
});

// ═══════════════════════════════════════════════ 5 · whose screen ══

describe('5. the sign-in screen is the last workspace’s, or the default', () => {
  it('nothing remembered → the default name', () => {
    draw();
    expect(screen.getByTestId('signin-salon').textContent).toBe(en.salonName);
    expect(screen.getByText(en.signInSub(en.salonName))).toBeTruthy();
    // The design's own words, for the design's own salon.
    expect(en.signInSub('Amara')).toBe('Log in to your Amara wallet');
    expect(ar.signInSub('أمارا')).toBe('سجّلي الدخول إلى محفظة أمارا');
  });

  it('Forest remembered → a Forest sign-in screen, in both languages', async () => {
    await rememberWorkspace(FOREST_ROW);
    draw();
    expect(screen.getByTestId('signin-salon').textContent).toBe('Forest');
    expect(screen.getByText('Log in to your Forest wallet')).toBeTruthy();
    cleanup();
    await rememberWorkspace({ ...FOREST_ROW, nameAr: 'فورست' });
    draw('ar');
    expect(screen.getByTestId('signin-salon').textContent).toBe('فورست');
  });
});

// ═══════════════════════════════════════════════ 6 · reset request ══

describe('6. a reset request carries the last workspace, or no salonId', () => {
  it('none known → { phone } alone', async () => {
    const posted = stubApi([{ status: 202, body: { accepted: true } }]);
    await requestPasswordReset('+96599124408', null);
    expect(posted[0]!.body).toEqual({ phone: '+96599124408' });
  });

  it('the screen sends what the device remembers', async () => {
    await rememberWorkspace(FOREST_ROW);
    const posted = stubApi([{ status: 202, body: { accepted: true } }]);
    render(
      <LanguageProvider initial="en">
        <ForgotPasswordScreen onBack={vi.fn()} />
      </LanguageProvider>,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '+96599124408' } });
    await tapAndSettle(screen.getByText(en.resetBtn));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.path).toBe('/auth/member/password-reset/request');
    expect(posted[0]!.body).toEqual({ salonId: 'SAL-FOREST', phone: '+96599124408' });
  });
});

// ═══════════════════════════════════════════════ 7 · Arabic, RTL ══

describe('7. the picker in Arabic — non-negotiable #12', () => {
  it('reads right to left, names each salon in Arabic, and addresses her in the feminine', async () => {
    stubApi([CHOOSE]);
    draw('ar');
    await typeAndSubmit();
    await waitFor(() => expect(screen.getByTestId('signin-workspaces')).toBeTruthy());
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByText(ar.workspacePickerTitle)).toBeTruthy();
    // اختاري — the feminine imperative, never اختر.
    expect(ar.workspacePickerTitle).toBe('اختاري صالونك');
    expect(ar.workspacePickerSub).toBe('لرقم هاتفك محفظة في أكثر من صالون.');
    expect(screen.getByText(ar.workspacePickerSub)).toBeTruthy();
    expect(screen.getByTestId('signin-workspace-SAL-AMARA').textContent).toBe('أمارا');
    // No Arabic name on file → the Latin one, not a blank row.
    expect(screen.getByTestId('signin-workspace-SAL-FOREST').textContent).toBe('Forest');
    expect(screen.getByTestId('signin-workspace-SAL-FOREST').getAttribute('aria-label')).toBe('Forest');
  });

  /** SOURCE ASSERTION: the row is a logical row, so RTL mirrors it with no conditional. */
  it('the picker row is a logical row with no physical left/right', () => {
    const src = fs.readFileSync(path.join(__dirname, 'SignInScreen.tsx'), 'utf8');
    const row = src.slice(src.indexOf('  pickerRow: {'), src.indexOf('  pickerDot:'));
    expect(row).toMatch(/flexDirection: 'row'/);
    expect(row).not.toMatch(/row-reverse|\b(left|right|marginLeft|marginRight|paddingLeft|paddingRight):/);
  });
});

function rgb(hex: string): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
