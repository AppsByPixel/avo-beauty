// @vitest-environment jsdom

/**
 * THE FIVE STATES OF A PRODUCT TILE, RENDERED.
 *
 * `authedImage.test.tsx` proves the fetch and the 401 retry as hook contracts.
 * What no hook test can reach is the claim `ProductImage`'s header actually
 * makes, which is a claim about PIXELS: that a product with no photograph, a
 * photograph still loading, a photograph that failed, and a device with no
 * connection all render THE SAME THING — the design's swatch and letter — and
 * that only a loaded photograph looks different.
 *
 * That property is the entire offline treatment for the Shop list. If it ever
 * stops holding, the failure is not a missing picture: it is forty rows that
 * look broken above a banner explaining that the connection is fine
 * (`interaction-spec.md` §4). So it is asserted here rather than inferred from
 * the fact that the swatch is painted unconditionally in the source.
 *
 * THE WEB HALF OF THE SPLIT IS WHAT RENDERS HERE, because vitest resolves
 * `./authedImage` the way a bundler without a platform extension does. That is
 * stated rather than hidden: the native half's logic is driven directly in
 * `authedImage.test.tsx`, and its rendering was driven on a simulator.
 */

import type { ImageRef } from '@avo/types';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductImage } from './ProductImage';
import { LanguageProvider } from '../i18n/language';

const { getAccessToken, refreshSession } = vi.hoisted(() => ({
  getAccessToken: vi.fn<() => string | null>(),
  refreshSession: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../api/session', () => ({ getAccessToken }));
vi.mock('../api/client', () => ({ refreshSession }));

const IMAGE: ImageRef = {
  id: 'IM-XFD4ATS22Z',
  url: 'http://localhost:4600/v1/images/IM-XFD4ATS22Z',
  contentType: 'image/png',
  width: 600,
  height: 600,
  byteSize: 10119,
};

/** PR-01 out of avo_lane_b, which is the row this slice was driven against. */
function tile(image: ImageRef | null, lang: 'en' | 'ar' = 'en') {
  return render(
    <LanguageProvider initial={lang}>
      <ProductImage
        productId="PR-01"
        name="Argan hair oil 100ml"
        image={image}
        size={52}
        radius={14}
        letterSize={20}
        testID="shop-swatch-PR-01"
      />
    </LanguageProvider>,
  );
}

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const photo = () => screen.queryByTestId('shop-swatch-PR-01-photo');

beforeEach(() => {
  getAccessToken.mockReturnValue('ACCESS-0');
  refreshSession.mockResolvedValue(true);
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:avo/0') as unknown as typeof URL.createObjectURL;
  globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a product with no photograph — the common case, and it must look deliberate', () => {
  it('draws the design’s swatch and letter, and asks for nothing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    tile(null);
    await settle();

    expect(screen.getByTestId('shop-swatch-PR-01')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    // No overlay is mounted at all — nothing to fade in, nothing to fail.
    expect(photo()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a product with a photograph', () => {
  it('keeps the swatch under it, so the square is never empty while it loads', async () => {
    // A fetch that never settles: the tile is mid-load for the whole assertion.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    tile(IMAGE);
    await settle();

    expect(screen.getByText('A')).toBeTruthy();
    expect(photo()).toBeNull();
  });

  it('fades one in once the bytes arrive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob([new Uint8Array([1])]))));

    tile(IMAGE);
    await settle();

    const el = photo();
    expect(el).not.toBeNull();
    /*
      THE SWATCH IS STILL THERE, UNDERNEATH. The overlay covers it rather than
      replacing it — which is what makes a later failure a no-op rather than a
      hole in the row.
    */
    expect(screen.getByText('A')).toBeTruthy();
  });
});

describe('the ways a photograph does not arrive', () => {
  /*
    THE POINT OF THIS BLOCK IS THAT ALL THREE ASSERTIONS ARE THE SAME ASSERTION.
    Each is a different cause; the rendered result must not distinguish them,
    because none of them is something the customer can act on and a row that
    announced one would be a row that looks broken.
  */
  it('OFFLINE: a rejected fetch leaves the row looking like every other row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    tile(IMAGE);
    await settle();

    expect(screen.getByTestId('shop-swatch-PR-01')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(photo()).toBeNull();
  });

  it('SERVER: a 500 does the same', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    tile(IMAGE);
    await settle();

    expect(screen.getByText('A')).toBeTruthy();
    expect(photo()).toBeNull();
  });

  it('AUTH: a 401 the refresh cannot fix does the same, and does not retry for ever', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    tile(IMAGE);
    await settle();

    expect(screen.getByText('A')).toBeTruthy();
    expect(photo()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Arabic', () => {
  /*
    NON-NEGOTIABLE #12. `Product` has no `nameAr` (decision 46), so the letter is
    the Latin initial of a Latin name in both languages — that gap is not this
    slice's to close and nothing here may assume otherwise. What this DOES assert
    is that the tile renders identically under an Arabic layout: the overlay is
    `StyleSheet.absoluteFill`, which has no start and no end, so there is nothing
    for `I18nManager.forceRTL` to put on the wrong side of the row.
  */
  it('renders the same square, and does not invent an Arabic product name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob([new Uint8Array([1])]))));

    tile(IMAGE, 'ar');
    await settle();

    expect(screen.getByTestId('shop-swatch-PR-01')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(photo()).not.toBeNull();
  });
});
