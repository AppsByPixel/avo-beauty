// @vitest-environment jsdom

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * HER BOOKING, AFTER IT WAS MADE UNDER THE SALON'S POLICY (migration 0066)
 * ═════════════════════════════════════════════════════════════════════════════
 * Three things the Upcoming card now says, and one it must keep saying:
 *
 *   1. the policy the booking was STAMPED with — not the salon's current one;
 *   2. before she cancels, what comes back AT THIS MOMENT under that rule,
 *      computed in integer fils and rounded down exactly as the server does;
 *   3. afterwards, the SERVER's answer — which wins when it differs;
 *   4. and a legacy booking is exactly what it was, one-tap cancel included.
 *
 * The idempotency key is sent on every cancel, and a retry of the same cancel
 * sends the same key, so a replay returns the first answer.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Language, Salon } from '@avo/types';

const { getBookings, cancelBooking } = vi.hoisted(() => ({
  getBookings: vi.fn(),
  cancelBooking: vi.fn(),
}));
vi.mock('../api/booking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/booking')>()),
  getBookings,
  cancelBooking,
}));

/* eslint-disable import/first */
import { CancelledCard, UpcomingCard } from './UpcomingCard';
import { LanguageProvider } from '../i18n/language';
import { BookingViewSchema, type BookingView, type CancelBookingResult } from '../api/booking';
import { useUpcoming } from '../state/useBooking';
import { ApiError } from '../api/client';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

const SALON = { timezone: 'Asia/Kuwait' } as unknown as Salon;
const STARTS = '2026-10-01T13:00:00.000Z';
const HOUR = 3_600_000;
const hoursBefore = (h: number) => new Date(Date.parse(STARTS) - h * HOUR);

const STAMP = {
  id: 'BP-3',
  version: 3,
  noShow: 'keep' as const,
  cancellation: [
    { hoursBefore: 24, returnPercent: 100 },
    { hoursBefore: 2, returnPercent: 50 },
  ],
  text: { en: 'Please give us a day’s notice.', ar: 'نرجو إبلاغنا قبل يوم.' },
};

function booking(over: Record<string, unknown> = {}): BookingView {
  return BookingViewSchema.parse({
    id: 'BK-1',
    memberId: 'M-1',
    artistId: 'AR-001',
    branchId: 'BR-1',
    serviceId: 'SV-1',
    startsAt: STARTS,
    endsAt: '2026-10-01T14:00:00.000Z',
    durationMin: 60,
    depositFils: 5000,
    status: 'deposit_held',
    source: 'app',
    changeableUntil: '2026-10-01T12:00:00.000Z',
    noShowReturnDueAt: '2026-10-01T14:00:00.000Z',
    rescheduledCount: 0,
    calendarSyncState: 'not_applicable',
    policy: STAMP,
    settlement: null,
    returnCapPercent: null,
    ...over,
  });
}

function draw(
  b: BookingView,
  opts: { lang?: Language; onCancel?: () => void; failure?: { code: string | null; message: string } | null } = {},
) {
  return render(
    <LanguageProvider initial={opts.lang ?? 'en'}>
      <UpcomingCard
        booking={b}
        salon={SALON}
        artistLabel="Rana"
        serviceLabel="Balayage"
        onReschedule={() => {}}
        onCancel={opts.onCancel ?? (() => {})}
        busy={false}
        failure={opts.failure ?? null}
      />
    </LanguageProvider>,
  );
}

const textOf = (id: string) => screen.getByTestId(id).textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ══════════════════════════════════════════════ 1. the stamped policy ══

describe('the card shows the policy the booking was stamped with', () => {
  it('its summary and the salon’s text, and the reschedule note without the legacy cancel clause', () => {
    draw(booking());
    expect(textOf('upcoming-policy-noshow')).toBe('No-show: the salon keeps your deposit.');
    expect(textOf('upcoming-policy-cancel')).toBe(
      'Cancel 24 hours before: 100% back · 2 hours before: 50% back · later: nothing back',
    );
    expect(textOf('upcoming-policy-text')).toBe(STAMP.text.en);
    expect(textOf('upcoming-note')).toBe(en.reschedNotePolicy);
    expect(screen.getByTestId('upcoming-card').textContent).not.toContain(en.reschedNote);
  });

  it('a legacy booking is unchanged: no policy, the design’s note, a one-tap cancel', () => {
    const onCancel = vi.fn();
    draw(booking({ policy: null }), { onCancel });
    expect(screen.queryByTestId('upcoming-policy')).toBeNull();
    expect(textOf('upcoming-note')).toBe(en.reschedNote);
    fireEvent.click(screen.getByTestId('upcoming-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('upcoming-cancel-preview')).toBeNull();
  });

  it('Arabic: right-to-left, the salon’s Arabic, the rules in Eastern digits', () => {
    draw(booking(), { lang: 'ar' });
    expect(document.documentElement.dir).toBe('rtl');
    expect(textOf('upcoming-policy-cancel')).toBe(
      'الإلغاء قبل ٢٤ ساعة: يُعاد ١٠٠٪ · قبل ساعتين: يُعاد ٥٠٪ · بعد ذلك: لا يُعاد شيء',
    );
    expect(textOf('upcoming-policy-text')).toBe(STAMP.text.ar);
    expect(textOf('upcoming-note')).toBe(ar.reschedNotePolicy);
  });
});

// ═════════════════════════════════════════════════ 2. the settlement ══

describe('once settled, where the deposit went — the server’s figures', () => {
  it('returned and kept, each through formatMoney', () => {
    draw(booking({ status: 'cancelled', settlement: { returnedFils: 2502, keptFils: 2503 } }));
    expect(textOf('upcoming-settlement-back')).toBe('2.502 KD back to your wallet');
    expect(textOf('upcoming-settlement-kept')).toBe('2.503 KD kept by the salon');
  });

  it('a full return says nothing about the salon keeping 0.000', () => {
    draw(booking({ status: 'cancelled', settlement: { returnedFils: 5000, keptFils: 0 } }));
    expect(textOf('upcoming-settlement-back')).toBe('5.000 KD back to your wallet');
    expect(screen.queryByTestId('upcoming-settlement-kept')).toBeNull();
  });

  it('Arabic: money in Western digits inside Arabic sentences', () => {
    draw(booking({ status: 'cancelled', settlement: { returnedFils: 0, keptFils: 5000 } }), { lang: 'ar' });
    expect(screen.queryByTestId('upcoming-settlement-back')).toBeNull();
    expect(textOf('upcoming-settlement-kept')).toBe('احتفظ الصالون بـ 5.000 د.ك');
  });

  it('nothing settled yet, nothing drawn', () => {
    draw(booking());
    expect(screen.queryByTestId('upcoming-settlement')).toBeNull();
  });
});

// ═════════════════════════════════════════════ 3. the preview at each cut-off ══

describe('before she cancels: what the stamped rule returns at this moment', () => {
  const previewAt = (h: number, deposit = 5000, lang: Language = 'en', returnCapPercent: number | null = null) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(hoursBefore(h));
    const onCancel = vi.fn();
    draw(booking({ depositFils: deposit, returnCapPercent }), { onCancel, lang });
    fireEvent.click(screen.getByTestId('upcoming-cancel'));
    return onCancel;
  };

  it('the first tap previews and does not cancel', () => {
    const onCancel = previewAt(30);
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('upcoming-cancel-preview')).toBeTruthy();
  });

  it('30h before — everything back, nothing kept', () => {
    previewAt(30);
    expect(textOf('upcoming-preview-back')).toBe('If you cancel now, 5.000 KD comes back to your wallet.');
    expect(screen.queryByTestId('upcoming-preview-kept')).toBeNull();
  });

  it('exactly 24h before — the threshold is met', () => {
    previewAt(24);
    expect(textOf('upcoming-preview-back')).toContain('5.000 KD');
  });

  it('5h before — half back, half kept', () => {
    previewAt(5);
    expect(textOf('upcoming-preview-back')).toBe('If you cancel now, 2.500 KD comes back to your wallet.');
    expect(textOf('upcoming-preview-kept')).toBe('The salon keeps 2.500 KD.');
  });

  it('5h before on 5.005 KD — the remainder fil goes to the salon, as the server floors it', () => {
    previewAt(5, 5005);
    expect(textOf('upcoming-preview-back')).toContain('2.502 KD');
    expect(textOf('upcoming-preview-kept')).toBe('The salon keeps 2.503 KD.');
  });

  it('1h before — later than every cut-off, nothing back', () => {
    previewAt(1);
    expect(textOf('upcoming-preview-back')).toBe(en.cancelPreviewNothing);
    expect(textOf('upcoming-preview-kept')).toBe('The salon keeps 5.000 KD.');
  });

  it('after a late move: 30h before, capped at 50% — the card says what the server pays, not 100%', () => {
    // She moved it 5h before the old slot (50%) to this one. The server returns
    // min(cap, rule for the new slot) = 50%; the preview must say the same.
    previewAt(30, 5005, 'en', 50);
    expect(textOf('upcoming-preview-back')).toBe('If you cancel now, 2.502 KD comes back to your wallet.');
    expect(textOf('upcoming-preview-kept')).toBe('The salon keeps 2.503 KD.');
  });

  it('Arabic, 5h before', () => {
    previewAt(5, 5000, 'ar');
    expect(textOf('upcoming-preview-back')).toBe('إذا ألغيتِ الآن، يعود 2.500 د.ك إلى محفظتكِ.');
    expect(textOf('upcoming-preview-kept')).toBe('يحتفظ الصالون بـ 2.500 د.ك.');
  });

  it('Keep it closes the preview; Cancel appointment sends the cancel', () => {
    const onCancel = previewAt(5);
    fireEvent.click(screen.getByTestId('upcoming-cancel-keep'));
    expect(screen.queryByTestId('upcoming-cancel-preview')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('upcoming-cancel'));
    fireEvent.click(screen.getByTestId('upcoming-cancel-confirm'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════ 4. refusals the route defines ══

describe('409 appointment_started', () => {
  it.each([
    ['en', en],
    ['ar', ar],
  ] as const)('%s — said in her words, not the server’s English', (lang, copy) => {
    draw(booking(), {
      lang,
      failure: { code: 'appointment_started', message: 'That appointment has already started, so it can no longer be cancelled.' },
    });
    expect(textOf('upcoming-refusal')).toBe(`${copy.cancelStartedTitle}${copy.cancelStartedBody}`);
  });
});

// ═══════════════════════════ 5. the server's answer, and the key it is sent under ══

/**
 * Home's wiring, minus the parts of Home that cannot load under jsdom
 * (`PaymentCode` pulls `react-native-qrcode-svg`, see vitest.config.ts). The
 * source assertion below pins that Home does exactly this.
 */
function Harness() {
  const upcoming = useUpcoming({ enabled: true, onChanged: () => {} });
  const [cancelled, setCancelled] = useState<CancelBookingResult | null>(null);
  const b = upcoming.bookings[0];
  if (cancelled) {
    return <CancelledCard result={cancelled} salon={SALON} serviceLabel="Balayage" onDone={() => setCancelled(null)} />;
  }
  if (!b) return null;
  return (
    <UpcomingCard
      booking={b}
      salon={SALON}
      artistLabel="Rana"
      serviceLabel="Balayage"
      onReschedule={() => {}}
      onCancel={() => {
        void upcoming.cancel(b.id).then((r) => {
          if (r && r.booking.policy !== null) setCancelled(r);
        });
      }}
      busy={upcoming.busy}
      failure={upcoming.actionFailure}
    />
  );
}

const result = (refundedFils: number, keptFils: number): CancelBookingResult => ({
  booking: booking({ status: 'cancelled', settlement: { returnedFils: refundedFils, keptFils } }),
  refundedFils,
  keptFils,
  returnPercent: 0,
  rule: null,
  balanceAfterFils: 20000,
  transactionId: refundedFils > 0 ? 'TX-9' : null,
  forfeitTransactionId: keptFils > 0 ? 'TX-10' : null,
});

describe('the cancelled card shows the SERVER’s answer, not the preview', () => {
  it('previewed 2.500 back; the server answered nothing back — the card says nothing back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(hoursBefore(2)); // exactly on the 50% cut-off
    getBookings.mockResolvedValue([booking()]);
    // She crossed the 2h line between reading and tapping: the server's clock.
    cancelBooking.mockResolvedValue(result(0, 5000));
    render(
      <LanguageProvider initial="en">
        <Harness />
      </LanguageProvider>,
    );
    await screen.findByTestId('upcoming-card');
    fireEvent.click(screen.getByTestId('upcoming-cancel'));
    expect(textOf('upcoming-preview-back')).toContain('2.500 KD');

    await act(async () => {
      fireEvent.click(screen.getByTestId('upcoming-cancel-confirm'));
    });
    await screen.findByTestId('upcoming-cancelled');
    expect(screen.queryByTestId('cancelled-settlement-back')).toBeNull();
    expect(textOf('cancelled-settlement-kept')).toBe('5.000 KD kept by the salon');
    expect(screen.getByTestId('upcoming-cancelled').textContent).not.toContain('2.500');
  });

  it('and a split the server made is drawn as it made it', async () => {
    getBookings.mockResolvedValue([booking({ depositFils: 5005 })]);
    cancelBooking.mockResolvedValue(result(2502, 2503));
    render(
      <LanguageProvider initial="ar">
        <Harness />
      </LanguageProvider>,
    );
    await screen.findByTestId('upcoming-card');
    fireEvent.click(screen.getByTestId('upcoming-cancel'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('upcoming-cancel-confirm'));
    });
    await screen.findByTestId('upcoming-cancelled');
    expect(textOf('cancelled-settlement-back')).toBe('عاد 2.502 د.ك إلى محفظتكِ');
    expect(textOf('cancelled-settlement-kept')).toBe('احتفظ الصالون بـ 2.503 د.ك');
  });
});

describe('the Idempotency-Key on DELETE /bookings/:id', () => {
  it('is sent on every cancel, and a retry of the same cancel reuses it', async () => {
    getBookings.mockResolvedValue([booking({ policy: null })]);
    cancelBooking
      .mockRejectedValueOnce(new ApiError('offline', 'offline', 'WLT-1', null))
      .mockResolvedValueOnce(result(5000, 0));
    render(
      <LanguageProvider initial="en">
        <Harness />
      </LanguageProvider>,
    );
    await screen.findByTestId('upcoming-card');
    await act(async () => {
      fireEvent.click(screen.getByTestId('upcoming-cancel'));
    });
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(screen.getByTestId('upcoming-cancel'));
    });
    await waitFor(() => expect(cancelBooking).toHaveBeenCalledTimes(2));

    const [first, second] = cancelBooking.mock.calls;
    expect(first![0]).toBe('BK-1');
    expect(typeof first![1]).toBe('string');
    expect((first![1] as string).length).toBeGreaterThan(0);
    // Legacy booking, and the key is still sent — the client does not guess.
    expect(second![1]).toBe(first![1]);
  });
});

describe('Home routes a policy cancel to the card and a legacy one to the toast', () => {
  const CODE = readFileSync(join(__dirname, '../screens/HomeScreen.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('decides on the stamp of the booking the server returned', () => {
    expect(CODE).toMatch(/if \(outcome\.booking\.policy !== null\) \{\s*setCancelled\(outcome\);\s*return;/);
    expect(CODE).toContain('<CancelledCard');
    expect(CODE).toContain('result={cancelled}');
  });
});
