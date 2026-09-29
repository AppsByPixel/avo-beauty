// @vitest-environment jsdom

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * SHE READS THE SALON'S BOOKING POLICY BEFORE SHE CONFIRMS (migration 0066)
 * ═════════════════════════════════════════════════════════════════════════════
 * DECISIONS.md § "The fourth list, 2026-09-29": "The policy text the salon
 * writes is shown to her before she confirms a booking that takes a deposit".
 * And the booking stamps the version, so the wallet sends the version it
 * showed: a publish that lands between the confirm step and the tap is refused
 * `409 policy_changed`, and she is shown the new one — never booked silently
 * under a policy she did not see.
 *
 * Driven through the real BookScreen with only the network mocked, so the
 * review step, the Confirm button's gate and the body sent are all under test.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { tapAndSettle } from '../testing/tapAndSettle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookableArtist, BookingPolicy, Language, Member, Salon } from '@avo/types';

vi.mock('react-native-svg', () => {
  const nothing = () => null;
  return { default: nothing, Svg: nothing, Path: nothing, Circle: nothing, Rect: nothing, G: nothing };
});

const { getServices, getArtists, getAvailability, createBooking, getBookingPolicy } = vi.hoisted(() => ({
  getServices: vi.fn(),
  getArtists: vi.fn(),
  getAvailability: vi.fn(),
  createBooking: vi.fn(),
  getBookingPolicy: vi.fn(),
}));

vi.mock('../api/booking', () => ({
  getServices,
  getArtists,
  getAvailability,
  createBooking,
  getBookingPolicy,
  rescheduleBooking: vi.fn(),
  getBookings: vi.fn(),
  cancelBooking: vi.fn(),
}));
vi.mock('../api/topups', () => ({ createTopUp: vi.fn(), getTopUp: vi.fn() }));
vi.mock('../platform/gateway', () => ({ openGateway: vi.fn() }));

/* eslint-disable import/first */
import { BookScreen } from './BookScreen';
import { LanguageProvider } from '../i18n/language';
import { ApiError } from '../api/client';
import { en } from '../copy/en';
import { ar } from '../copy/ar';

// --------------------------------------------------------------- fixtures --

const salonWith = (depositFils = 5000): Salon =>
  ({
    id: 'SAL-AMARA',
    timezone: 'Asia/Kuwait',
    depositFils,
    branches: [{ id: 'BR-KWC', name: 'Kuwait City', nameAr: 'مدينة الكويت' }],
    modules: { booking: true },
  }) as unknown as Salon;

const MEMBER = { balanceFils: 25000, tier: 'silver' } as unknown as Member;

const artist = (id: string): BookableArtist =>
  ({ id, salonId: 'SAL-AMARA', name: id, nameAr: null, availabilityLive: false }) as BookableArtist;

const SERVICE = {
  id: 'SV-CUT',
  salonId: 'SAL-AMARA',
  name: 'Cut & style',
  nameAr: 'قص وتصفيف',
  priceFils: 12000,
  active: true,
  image: null,
  artistIds: ['AR-1'],
};

const SLOT = { startsAt: '2026-09-14T13:00:00Z', endsAt: '2026-09-14T13:45:00Z', local: '16:00', available: true };

/** The salon's words, as the API serves them — the app writes none of this. */
const V3: BookingPolicy = {
  id: 'BP-3',
  salonId: 'SAL-AMARA',
  version: 3,
  noShow: 'keep',
  cancellation: [
    { hoursBefore: 24, returnPercent: 100 },
    { hoursBefore: 2, returnPercent: 50 },
  ],
  text: { en: 'Please give us a day’s notice so we can offer your slot to someone else.', ar: 'نرجو إبلاغنا قبل يوم لنمنح موعدكِ لغيركِ.' },
  publishedAt: '2026-09-28T10:00:00.000Z',
};

/** Published between the confirm step and her tap. */
const V4: BookingPolicy = {
  ...V3,
  id: 'BP-4',
  version: 4,
  noShow: 'return',
  cancellation: [{ hoursBefore: 48, returnPercent: 100 }],
  text: { en: 'New terms from October.', ar: '' },
  publishedAt: '2026-09-29T09:00:00.000Z',
};

const CREATED = {
  booking: {
    id: 'BK-1',
    depositFils: 5000,
    startsAt: SLOT.startsAt,
    policy: { id: 'BP-3', version: 3, noShow: 'keep', cancellation: V3.cancellation, text: V3.text },
    settlement: null,
    returnCapPercent: null,
  },
  balanceAfterFils: 20000,
};

const POLICY_CHANGED = (version: number | null) =>
  new ApiError(
    'server',
    'The salon has just updated its booking policy. Read the new one before you book.',
    'WLT-0000-0000',
    409,
    'policy_changed',
    { policyVersion: version },
  );

function draw(lang: Language = 'en', depositFils = 5000) {
  return render(
    <LanguageProvider initial={lang}>
      <BookScreen salon={salonWith(depositFils)} member={MEMBER} memberFetchedAt={null} onHome={vi.fn()} onBooked={vi.fn()} onToast={vi.fn()} />
    </LanguageProvider>,
  );
}

async function walkToReview() {
  await waitFor(() => expect(screen.getByTestId('book-service-SV-CUT')).toBeTruthy());
  fireEvent.click(screen.getByTestId('book-service-SV-CUT'));
  fireEvent.click(screen.getByTestId('book-next'));
  await waitFor(() => expect(screen.getByTestId('book-artist-AR-1')).toBeTruthy());
  fireEvent.click(screen.getByTestId('book-artist-AR-1'));
  fireEvent.click(screen.getByTestId('book-next'));
  await waitFor(() => expect(screen.getByTestId('book-slot-16:00')).toBeTruthy());
  fireEvent.click(screen.getByTestId('book-slot-16:00'));
  // Into review, where the policy read starts and Confirm waits on it: that
  // read answers inside act, so Confirm's responder is armed when a spec taps
  // it (src/testing/tapAndSettle.ts). A held read stays held.
  await tapAndSettle(screen.getByTestId('book-next'));
  await waitFor(() => expect(screen.getByTestId('book-confirm')).toBeTruthy());
}

const isDisabled = (id: string) => {
  const el = screen.getByTestId(id);
  return el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
};
const textOf = (id: string) => screen.getByTestId(id).textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  getServices.mockResolvedValue([SERVICE]);
  getArtists.mockResolvedValue([artist('AR-1')]);
  getAvailability.mockResolvedValue({ date: '2026-09-14', open: true, hoursSource: 'artist', slots: [SLOT] });
  createBooking.mockResolvedValue(CREATED);
});

afterEach(cleanup);

// ══════════════════════════════════════ 1. shown before confirm, version sent ══

describe('the policy is on the review step before she can confirm', () => {
  it('Confirm is off while the policy is read, and on once it is on screen', async () => {
    let release: (p: BookingPolicy | null) => void = () => {};
    getBookingPolicy.mockReturnValue(new Promise((r) => (release = r)));
    draw();
    await walkToReview();

    expect(screen.getByTestId('book-policy-loading')).toBeTruthy();
    expect(isDisabled('book-confirm')).toBe(true);
    // A tap on a disabled button — and the controller's own guard — sends nothing.
    fireEvent.click(screen.getByTestId('book-confirm'));
    expect(createBooking).not.toHaveBeenCalled();

    await act(async () => release(V3));
    expect(isDisabled('book-confirm')).toBe(false);
    expect(getBookingPolicy).toHaveBeenCalledWith('SAL-AMARA', expect.anything());
  });

  it('draws the salon’s text and a plain summary of the rules', async () => {
    getBookingPolicy.mockResolvedValue(V3);
    draw();
    await walkToReview();
    await screen.findByTestId('book-review-policy');

    expect(textOf('book-review-policy-noshow')).toBe('No-show: the salon keeps your deposit.');
    expect(textOf('book-review-policy-cancel')).toBe(
      'Cancel 24 hours before: 100% back · 2 hours before: 50% back · later: nothing back',
    );
    // The salon's words, verbatim — non-negotiable #10.
    expect(textOf('book-review-policy-text')).toBe(V3.text.en);
  });

  it('sends the version it showed with POST /bookings', async () => {
    getBookingPolicy.mockResolvedValue(V3);
    draw();
    await walkToReview();
    await screen.findByTestId('book-review-policy');
    fireEvent.click(screen.getByTestId('book-confirm'));
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(1));
    expect(createBooking.mock.calls[0]![0]).toEqual({
      artistId: 'AR-1',
      serviceId: 'SV-CUT',
      startsAt: SLOT.startsAt,
      policyVersion: 3,
    });
  });

  it('a failed read keeps Confirm off and offers a retry — it never books without one', async () => {
    getBookingPolicy
      .mockRejectedValueOnce(new ApiError('offline', 'offline', 'WLT-1', null))
      .mockResolvedValueOnce(V3);
    draw();
    await walkToReview();
    await screen.findByTestId('book-policy-failed');
    expect(textOf('book-policy-failed')).toContain(en.policyLoadFailed);
    expect(isDisabled('book-confirm')).toBe(true);

    fireEvent.click(screen.getByTestId('book-policy-retry'));
    await screen.findByTestId('book-review-policy');
    expect(isDisabled('book-confirm')).toBe(false);
  });
});

// ═════════════════════════════════════════════════ 2. 409 policy_changed ══

describe('409 policy_changed — the new policy is shown and she confirms again', () => {
  it('re-reads, draws the new one with a notice, and the next Confirm sends the new version under a new key', async () => {
    getBookingPolicy.mockResolvedValueOnce(V3).mockResolvedValueOnce(V4);
    createBooking.mockRejectedValueOnce(POLICY_CHANGED(4)).mockResolvedValueOnce(CREATED);
    draw();
    await walkToReview();
    await screen.findByTestId('book-review-policy');
    await tapAndSettle(screen.getByTestId('book-confirm'));

    await screen.findByTestId('book-policy-changed');
    expect(textOf('book-policy-changed')).toBe(en.policyChanged);
    await waitFor(() => expect(textOf('book-review-policy-text')).toBe(V4.text.en));
    expect(textOf('book-review-policy-noshow')).toBe('No-show: your deposit comes back to your wallet.');
    expect(textOf('book-review-policy-cancel')).toBe('Cancel 48 hours before: 100% back · later: nothing back');
    // She is still on the review step, and nothing was booked.
    expect(screen.queryByTestId('book-confirmed')).toBeNull();
    expect(screen.queryByTestId('book-confirm-failure')).toBeNull();
    expect(getBookingPolicy).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId('book-confirm'));
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(2));
    const [first, second] = createBooking.mock.calls;
    expect((first![0] as { policyVersion: number }).policyVersion).toBe(3);
    expect((second![0] as { policyVersion: number }).policyVersion).toBe(4);
    expect(second![1]).not.toBe(first![1]);
    await screen.findByTestId('book-confirmed');
  });

  /*
    Unreachable today — `booking_policy` is append-only, so a salon that has
    published can never read `null` again — and pinned anyway, because the
    client's rule is "send what you showed", and what it showed was nothing.
  */
  it('a re-read that answers no policy: no block, and `null` sent next', async () => {
    getBookingPolicy.mockResolvedValueOnce(V3).mockResolvedValueOnce(null);
    createBooking.mockRejectedValueOnce(POLICY_CHANGED(null)).mockResolvedValueOnce(CREATED);
    draw();
    await walkToReview();
    await screen.findByTestId('book-review-policy');
    await tapAndSettle(screen.getByTestId('book-confirm'));
    await waitFor(() => expect(screen.queryByTestId('book-review-policy')).toBeNull());
    await waitFor(() => expect(isDisabled('book-confirm')).toBe(false));
    fireEvent.click(screen.getByTestId('book-confirm'));
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(2));
    expect((createBooking.mock.calls[1]![0] as { policyVersion: unknown }).policyVersion).toBeNull();
  });
});

// ════════════════════════════════════════════════════ 3. no policy, no change ══

describe('a salon with no policy — nothing new is shown', () => {
  it('draws no block, no notice, and sends `policyVersion: null`', async () => {
    getBookingPolicy.mockResolvedValue(null);
    draw();
    await walkToReview();
    await waitFor(() => expect(screen.queryByTestId('book-policy-loading')).toBeNull());
    expect(screen.queryByTestId('book-review-policy')).toBeNull();
    expect(screen.queryByTestId('book-policy-changed')).toBeNull();
    expect(screen.queryByText(en.policyTitle)).toBeNull();

    fireEvent.click(screen.getByTestId('book-confirm'));
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(1));
    expect((createBooking.mock.calls[0]![0] as { policyVersion: unknown }).policyVersion).toBeNull();
  });

  it('the confirmed screen of a legacy booking keeps the design’s two lines', async () => {
    getBookingPolicy.mockResolvedValue(null);
    createBooking.mockResolvedValue({ ...CREATED, booking: { ...CREATED.booking, policy: null } });
    draw();
    await walkToReview();
    await waitFor(() => expect(isDisabled('book-confirm')).toBe(false));
    fireEvent.click(screen.getByTestId('book-confirm'));
    await screen.findByTestId('book-confirmed');
    expect(textOf('book-policy')).toBe(en.cancelPolicy);
    expect(textOf('book-resched-note')).toBe(en.reschedNote);
    expect(screen.queryByTestId('book-stamped-policy')).toBeNull();
  });

  it('a salon that takes no deposit is never asked for its policy', async () => {
    draw('en', 0);
    await walkToReview();
    expect(getBookingPolicy).not.toHaveBeenCalled();
    expect(isDisabled('book-confirm')).toBe(false);
    fireEvent.click(screen.getByTestId('book-confirm'));
    await waitFor(() => expect(createBooking).toHaveBeenCalledTimes(1));
    expect(createBooking.mock.calls[0]![0]).not.toHaveProperty('policyVersion');
  });
});

// ═════════════════════════════════════ 4. the stamped policy, once booked ══

describe('the confirmed screen shows the policy the booking was STAMPED with', () => {
  it('replaces the legacy 24h / one-hour lines with the stamp', async () => {
    getBookingPolicy.mockResolvedValue(V3);
    draw();
    await walkToReview();
    await screen.findByTestId('book-review-policy');
    fireEvent.click(screen.getByTestId('book-confirm'));
    await screen.findByTestId('book-confirmed');

    expect(screen.getByTestId('book-stamped-policy')).toBeTruthy();
    expect(textOf('book-stamped-policy-text')).toBe(V3.text.en);
    expect(screen.queryByTestId('book-policy')).toBeNull();
    expect(textOf('book-resched-note')).toBe(en.reschedNotePolicy);
    expect(screen.getByTestId('book-confirmed').textContent).not.toContain(en.cancelPolicy);
  });
});

// ═════════════════════════════════════════════════════ 5. Arabic, RTL ══

describe('the policy in Arabic — non-negotiable #12', () => {
  it('lays out right-to-left, reads the salon’s Arabic, and states the rules in Eastern digits', async () => {
    getBookingPolicy.mockResolvedValue(V3);
    draw('ar');
    await walkToReview();
    await screen.findByTestId('book-review-policy');

    expect(document.documentElement.dir).toBe('rtl');
    expect(screen.getByText(ar.policyTitle)).toBeTruthy();
    expect(textOf('book-review-policy-noshow')).toBe('إذا لم تحضري: يحتفظ الصالون بعربونكِ.');
    expect(textOf('book-review-policy-cancel')).toBe(
      'الإلغاء قبل ٢٤ ساعة: يُعاد ١٠٠٪ · قبل ساعتين: يُعاد ٥٠٪ · بعد ذلك: لا يُعاد شيء',
    );
    expect(textOf('book-review-policy-text')).toBe(V3.text.ar);
  });

  it('a salon that wrote English only is shown its English, in the Latin face', async () => {
    getBookingPolicy.mockResolvedValue(V4);
    draw('ar');
    await walkToReview();
    await screen.findByTestId('book-review-policy');
    const para = screen.getByTestId('book-review-policy-text');
    expect(para.textContent).toBe(V4.text.en);
    // The frame around it stays Arabic, in the Arabic face.
    expect(textOf('book-review-policy-noshow')).toBe('إذا لم تحضري: يعود عربونكِ إلى محفظتكِ.');
    const face = (el: Element) => getComputedStyle(el).fontFamily;
    expect(face(para)).not.toBe(face(screen.getByTestId('book-review-policy-noshow')));
  });

  it('the 409 notice is in her language', async () => {
    getBookingPolicy.mockResolvedValueOnce(V3).mockResolvedValueOnce(V4);
    createBooking.mockRejectedValueOnce(POLICY_CHANGED(4));
    draw('ar');
    await walkToReview();
    await screen.findByTestId('book-review-policy');
    fireEvent.click(screen.getByTestId('book-confirm'));
    await screen.findByTestId('book-policy-changed');
    expect(textOf('book-policy-changed')).toBe(ar.policyChanged);
  });
});
