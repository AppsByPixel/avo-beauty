// @vitest-environment jsdom

/**
 * THE BELL'S `booking_policy` ROW (migration 0066) — "<Salon> updated its
 * booking policy", and a tap opens the salon's current policy.
 *
 * It rendered as the neutral `unknown` row ("New notification · Update the app
 * to read this one") until this build knew the kind. Known now: its own words,
 * markable like any receipt, and the one row in the bell that is a button.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Language } from '@avo/types';

vi.mock('react-native-svg', () => {
  const nothing = () => null;
  return { default: nothing, Svg: nothing, Path: nothing, Circle: nothing, Rect: nothing, G: nothing };
});

/* eslint-disable import/first */
import { LanguageProvider } from '../i18n/language';
import { useBell } from '../state/useBell';
import { BellButton } from './BellButton';
import { BellSheet } from './BellSheet';
import { BookingPolicySheet } from './BookingPolicySheet';
import { BellFeedSchema } from '../api/bell';
import { bellRow } from '../domain/bell';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const AT = '2026-09-29T08:00:00.000Z';

const NOTICE = {
  id: 'PN-1',
  kind: 'booking_policy',
  salonId: 'SAL-AMARA',
  policyId: 'BP-4',
  policyVersion: 4,
  createdAt: AT,
  readAt: null,
};

const POLICY = {
  id: 'BP-4',
  salonId: 'SAL-AMARA',
  version: 4,
  noShow: 'return',
  cancellation: [{ hoursBefore: 48, returnPercent: 100 }],
  text: { en: 'New terms from October.', ar: 'شروط جديدة من أكتوبر.' },
  publishedAt: AT,
};

const FEED = {
  items: [NOTICE],
  nextCursor: null,
  unreadCount: 1,
  visibleKinds: ['topup', 'charge', 'shop', 'deposit_hold', 'deposit_return', 'booking_policy'],
};

function stubApi(policy: unknown = { policy: POLICY }) {
  const posted: unknown[] = [];
  const policyReads: string[] = [];
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if ((init.method ?? 'GET') === 'POST') {
      posted.push(JSON.parse(String(init.body)));
      return Promise.resolve(new Response(JSON.stringify({ marked: 1, unreadCount: 0 }), { status: 200 }));
    }
    if (u.pathname === '/members/me/notifications/feed') {
      return Promise.resolve(new Response(JSON.stringify(FEED), { status: 200 }));
    }
    if (u.pathname === '/salons/SAL-AMARA/booking-policy') {
      policyReads.push(u.pathname);
      return Promise.resolve(new Response(JSON.stringify(policy), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  return { posted, policyReads };
}

/** Home's wiring: the row closes the bell and opens the policy sheet. */
function Harness() {
  const bell = useBell({ enabled: true });
  const [open, setOpen] = useState(false);
  return (
    <>
      <BellButton unreadCount={bell.unreadCount} onPress={bell.openPanel} />
      <BellSheet
        bell={bell}
        salon="Amara"
        timeZone="Asia/Kuwait"
        transactions={[]}
        onOpenSettings={() => {}}
        onOpenBookingPolicy={() => {
          bell.close();
          setOpen(true);
        }}
      />
      <BookingPolicySheet salonId={open ? 'SAL-AMARA' : null} onClose={() => setOpen(false)} />
    </>
  );
}

function draw(lang: Language = 'en') {
  return render(
    <LanguageProvider initial={lang}>
      <Harness />
    </LanguageProvider>,
  );
}

async function openBell() {
  await waitFor(() => expect(screen.getByTestId('bell-badge')).toBeTruthy());
  await act(async () => {
    fireEvent.click(screen.getByTestId('bell-open'));
  });
  await screen.findByTestId('bell-row-PN-1');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the parse: a known kind now, not `unknown`', () => {
  it('keeps its fields, and visibleKinds keeps the kind', () => {
    const feed = BellFeedSchema.parse(FEED);
    expect(feed.items[0]).toEqual(NOTICE);
    expect(feed.visibleKinds).toContain('booking_policy');
  });
});

describe('the row', () => {
  it.each([
    ['en', en, 'Amara updated its booking policy', 'Tap to read it.'],
    ['ar', ar, 'حدّث أمارا سياسة الحجز', 'اضغطي لقراءتها.'],
  ] as const)('%s — its own words, no figure, markable', (lang, copy, title, line) => {
    const item = BellFeedSchema.parse(FEED).items[0]!;
    const row = bellRow(item, {
      lang,
      copy,
      salon: lang === 'ar' ? 'أمارا' : 'Amara',
      timeZone: 'Asia/Kuwait',
      transactions: [],
      now: new Date(AT),
    });
    expect(row.kind).toBe('booking_policy');
    expect(row.title).toBe(title);
    expect(row.lines).toEqual([line]);
    expect(row.amount).toBeNull();
    expect(row.markable).toBe(true);
  });

  it('is drawn as a button, and is marked read like any receipt', async () => {
    const { posted } = stubApi();
    draw();
    await openBell();
    const row = screen.getByTestId('bell-row-PN-1');
    expect(row.getAttribute('role')).toBe('button');
    expect(screen.getByTestId('bell-title-PN-1').textContent).toBe('Amara updated its booking policy');
    expect(row.textContent).not.toContain(en.bellUnknownTitle);
    await waitFor(() => expect(posted).toEqual([{ ids: ['PN-1'] }]));
  });
});

describe('a tap opens the salon’s current policy', () => {
  it('closes the bell, reads the policy fresh, and draws it', async () => {
    const { policyReads } = stubApi();
    draw();
    await openBell();
    await act(async () => {
      fireEvent.click(screen.getByTestId('bell-row-PN-1'));
    });
    expect(screen.queryByTestId('bell-sheet')).toBeNull();
    await screen.findByTestId('bell-policy');
    expect(policyReads).toEqual(['/salons/SAL-AMARA/booking-policy']);
    expect(screen.getByTestId('bell-policy-noshow').textContent).toBe(
      'No-show: your deposit comes back to your wallet.',
    );
    expect(screen.getByTestId('bell-policy-text').textContent).toBe(POLICY.text.en);

    fireEvent.click(screen.getByTestId('booking-policy-close'));
    expect(screen.queryByTestId('booking-policy-sheet')).toBeNull();
  });

  it('in Arabic: right-to-left, the salon’s Arabic, Eastern digits in the rules', async () => {
    stubApi();
    draw('ar');
    await openBell();
    await act(async () => {
      fireEvent.click(screen.getByTestId('bell-row-PN-1'));
    });
    await screen.findByTestId('bell-policy');
    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByTestId('bell-policy-cancel').textContent).toBe(
      'الإلغاء قبل ٤٨ ساعة: يُعاد ١٠٠٪ · بعد ذلك: لا يُعاد شيء',
    );
    expect(screen.getByTestId('bell-policy-text').textContent).toBe(POLICY.text.ar);
  });

  it('a salon with no policy says so in words', async () => {
    stubApi({ policy: null });
    draw();
    await openBell();
    await act(async () => {
      fireEvent.click(screen.getByTestId('bell-row-PN-1'));
    });
    expect((await screen.findByTestId('booking-policy-none')).textContent).toBe(en.policyNone);
  });
});
