// @vitest-environment jsdom

/**
 * AUTHENTICATED IMAGE LOADING, BOTH HALVES OF THE PLATFORM SPLIT.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PROPERTY UNDER TEST IS NOT "AN IMAGE APPEARS". It is that an EXPIRED
 * ACCESS TOKEN produces a picture rather than a blank square, and that a
 * REFUSED one produces a blank square rather than an infinite retry.
 *
 * `<Image>` does not go through `api/client.ts`, so none of the
 * refresh-and-retry-once machinery that keeps every JSON call alive across a
 * token expiry applies to it — `authedImage.native.ts` § WHY THE 401 RETRY IS
 * HERE. That makes this the one place in the wallet where an expiry is handled
 * by hand, and hand-written expiry handling is exactly what a test is for.
 *
 * BOTH FILES ARE IMPORTED EXPLICITLY, by their real names, because a test that
 * imported `./authedImage` would exercise whichever one the resolver picked and
 * report a green suite for a platform it never touched. That is the specific way
 * a `.native.ts` pair rots: the web half is tested, the native half is the one
 * that ships to a phone, and nothing ever compares them.
 *
 * WHAT THIS CANNOT REACH, said plainly rather than left as a gap in coverage:
 * whether iOS actually puts `headers` on the request, and whether it actually
 * reports `responseCode`. Neither is observable from a hook — the first happens
 * inside `RCTConvert.mm` and the second inside `RCTImageComponentView.mm`. Both
 * were driven on a booted simulator against a real API, and the evidence is in
 * `ProductImage.tsx`'s header and in the slice report. A test here that mocked
 * either would be asserting my own belief back at me.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import type { ImageRef } from '@avo/types';
import { act, cleanup, render } from '@testing-library/react';
import { Image as RNImage } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { httpStatusOfImageError, type AuthedImage } from './authedImageShared';
import { useAuthedImage as useNative } from './authedImage.native';
import { useAuthedImage as useWeb } from './authedImage';

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

/**
 * A hook has no DOM of its own, so it is rendered into one and the latest value
 * is read out of a box. Simpler than a fake component tree and it keeps every
 * assertion about the hook's own contract.
 */
function drive(hook: (image: ImageRef | null) => AuthedImage, initial: ImageRef | null) {
  let image = initial;
  const box: { current: AuthedImage | null } = { current: null };
  function Probe() {
    box.current = hook(image);
    return null;
  }
  const view = render(<Probe />);
  return Object.assign(box as { current: AuthedImage }, {
    show: (next: ImageRef | null) => {
      image = next;
      view.rerender(<Probe />);
    },
  });
}

/** One `await` for the microtasks a fetch chain queues, inside React's act(). */
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  getAccessToken.mockReturnValue('ACCESS-0');
  refreshSession.mockResolvedValue(true);
});

// ------------------------------------------------------- the narrowing helper --

describe('reading the HTTP status off a React Native image error', () => {
  /*
    `responseCode` is emitted by the native code and declared by NEITHER the Flow
    nor the TypeScript type of the event (authedImage.native.ts § `responseCode`
    IS REAL AT RUNTIME). So the helper has to survive every shape the field could
    take if RN ever changed it — including the shapes it takes TODAY on a
    platform that does not send it.
  */
  it('reads it from the event iOS actually sends', () => {
    expect(httpStatusOfImageError({ nativeEvent: { responseCode: 401 } })).toBe(401);
    expect(httpStatusOfImageError({ nativeEvent: { responseCode: 404 } })).toBe(404);
  });

  it('answers null rather than throwing for every shape that does not carry one', () => {
    expect(httpStatusOfImageError(undefined)).toBeNull();
    expect(httpStatusOfImageError(null)).toBeNull();
    expect(httpStatusOfImageError('Failed to load http://…')).toBeNull();
    expect(httpStatusOfImageError({})).toBeNull();
    expect(httpStatusOfImageError({ nativeEvent: null })).toBeNull();
    // The shape RN's own d.ts promises, and Android's, neither of which has one.
    expect(httpStatusOfImageError({ nativeEvent: { error: 'Failed to load' } })).toBeNull();
    // `[NSNull null]` crosses the bridge as null, not as a number.
    expect(httpStatusOfImageError({ nativeEvent: { responseCode: null } })).toBeNull();
  });
});

// ------------------------------------------------- why there are two files --

describe('react-native-web IGNORES `headers` on an image source', () => {
  /*
    ═══════════════════════════════════════════════════════════════════════════
    THE FINDING THIS WHOLE SPLIT RESTS ON, ASSERTED RATHER THAN ASSUMED.

    Lane A's stated pattern for an authenticated image is
    `<Image source={{ uri, headers: { authorization } }} />`, and on iOS it is
    correct — `RCTConvert.mm` puts the dictionary on the NSURLRequest. On web the
    prop is accepted, dropped, and NOTHING WARNS. The request goes out
    unauthenticated, `GET /v1/images/{id}` answers 401, and the tile is blank —
    which reads as "this product has no photograph", the exact confusion this
    slice was sent to prevent.

    So this test drives the mechanism rather than quoting the source: react-native-web
    loads an image by assigning `src` on an `HTMLImageElement`. An `<img>` HAS NO
    HEADER MECHANISM — there is no API on the element, and the browser will not
    accept one — so the drop is structural and not a missing feature that a newer
    version might add without changing this observation.

    IT IS ALSO A GUARD IN THE USEFUL DIRECTION. If react-native-web ever loaded
    images through `fetch`, headers would become possible on web, `authedImage.ts`
    could collapse into `authedImage.native.ts`, and this test would fail and say
    so. Until then the two files stay.
    ═══════════════════════════════════════════════════════════════════════════
  */
  it('loads through an <img> element, which cannot carry an Authorization header', async () => {
    const RealImage = globalThis.Image;
    const created: HTMLImageElement[] = [];
    vi.stubGlobal('Image', function ImageSpy(this: unknown, ...args: unknown[]) {
      const el = new (RealImage as unknown as new (...a: unknown[]) => HTMLImageElement)(...args);
      created.push(el);
      return el;
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const xhrMock = vi.fn();
    vi.stubGlobal('XMLHttpRequest', xhrMock);

    render(
      <RNImage
        source={{ uri: IMAGE.url, headers: { authorization: 'Bearer ACCESS-0' } }}
        style={{ width: 52, height: 52 }}
      />,
    );
    await settle();

    // It DID try to load, and it tried with an <img>.
    expect(created.length).toBeGreaterThan(0);
    expect(created[0]!.src).toBe(IMAGE.url);

    // And through nothing that could have carried the header.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(xhrMock).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------- native --

describe('native: the URL and a header, handed straight to <Image>', () => {
  it('puts the session on the source, because the read is authenticated', () => {
    const hook = drive(useNative, IMAGE);
    expect(hook.current.source).toEqual({
      uri: IMAGE.url,
      headers: { authorization: 'Bearer ACCESS-0' },
    });
  });

  it('offers no source at all when there is no session to authorise with', () => {
    getAccessToken.mockReturnValue(null);
    expect(drive(useNative, IMAGE).current.source).toBeNull();
  });

  it('offers no source for a product with no image — the common case', () => {
    const hook = drive(useNative, null);
    expect(hook.current.source).toBeNull();
    expect(hook.current.failed).toBe(false);
  });

  it('takes an already-rotated token WITHOUT spending a refresh', async () => {
    /*
      The ordinary 401. `client.ts` refreshed for some JSON call while this tile
      was holding the token it mounted with — so the app already has a good
      token and rotating again would burn a refresh token to be handed one we
      have. Refresh tokens ROTATE and the API cannot tell a replay from a theft,
      so a spare rotation is not free.
    */
    getAccessToken.mockReturnValueOnce('ACCESS-0').mockReturnValue('ACCESS-1');
    const hook = drive(useNative, IMAGE);
    expect(hook.current.source?.headers).toEqual({ authorization: 'Bearer ACCESS-0' });

    await act(async () => {
      hook.current.onError({ nativeEvent: { responseCode: 401 } });
      await Promise.resolve();
    });

    expect(refreshSession).not.toHaveBeenCalled();
    expect(hook.current.source?.headers).toEqual({ authorization: 'Bearer ACCESS-1' });
    // NOT failed — the tile is being tried again, not given up on.
    expect(hook.current.failed).toBe(false);
  });

  it('refreshes ONCE when the token on screen IS the current one and was still refused', async () => {
    // Nobody else has rotated: the app's token and the tile's token agree, and
    // the server said no to it. That is the case `refreshSession` is for.
    getAccessToken.mockReturnValue('ACCESS-0');
    const hook = drive(useNative, IMAGE);

    refreshSession.mockImplementation(async () => {
      getAccessToken.mockReturnValue('ACCESS-1');
      return true;
    });

    await act(async () => {
      hook.current.onError({ nativeEvent: { responseCode: 401 } });
      await Promise.resolve();
    });

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(hook.current.source?.headers).toEqual({ authorization: 'Bearer ACCESS-1' });
    expect(hook.current.failed).toBe(false);
  });

  it('gives up after the second 401 rather than retrying for ever', async () => {
    getAccessToken.mockReturnValue('ACCESS-0');
    const hook = drive(useNative, IMAGE);
    await act(async () => {
      hook.current.onError({ nativeEvent: { responseCode: 401 } });
      await Promise.resolve();
    });
    await act(async () => {
      hook.current.onError({ nativeEvent: { responseCode: 401 } });
      await Promise.resolve();
    });
    /*
      One rotation, not two. A second 401 after a successful refresh is the server
      refusing this principal for this image, and a tile that kept asking would
      hit /v1/images/{id} once per render for ever — per tile, on a list.
    */
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(hook.current.failed).toBe(true);
  });

  it('does not refresh for a failure that is not about the token', async () => {
    const hook = drive(useNative, IMAGE);
    await act(async () => {
      hook.current.onError({ nativeEvent: { responseCode: 404 } });
      await Promise.resolve();
    });
    expect(refreshSession).not.toHaveBeenCalled();
    expect(hook.current.failed).toBe(true);
  });

  it('does not refresh for an error carrying no status — a decode or a dropped connection', async () => {
    const hook = drive(useNative, IMAGE);
    await act(async () => {
      hook.current.onError({ nativeEvent: { error: 'Failed to load http://…' } });
      await Promise.resolve();
    });
    expect(refreshSession).not.toHaveBeenCalled();
    expect(hook.current.failed).toBe(true);
  });

  it('forgets a failure when the row starts pointing at a different image', async () => {
    /*
      Bytes are immutable under an id — `db/schema/image.ts` § BYTES ARE IMMUTABLE
      — so a merchant replacing a photograph mints a NEW id and the product row
      points somewhere else. The tile is keyed by PRODUCT id, so the same mounted
      component is asked about a different picture, and carrying the old verdict
      across would show a swatch for an image that was never tried.
    */
    getAccessToken.mockReturnValue('ACCESS-0');
    const hook = drive(useNative, IMAGE);
    await act(async () => {
      hook.current.onError({ nativeEvent: { responseCode: 404 } });
      await Promise.resolve();
    });
    expect(hook.current.failed).toBe(true);

    const replacement: ImageRef = { ...IMAGE, id: 'IM-REPLACED', url: 'http://localhost:4600/v1/images/IM-REPLACED' };
    await act(async () => { hook.show(replacement); });

    expect(hook.current.failed).toBe(false);
    expect(hook.current.source?.uri).toBe(replacement.url);

    // And the one retry is available again — it is per image, not per mount.
    await act(async () => {
      hook.current.onError({ nativeEvent: { responseCode: 401 } });
      await Promise.resolve();
    });
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('fails the tile when the refresh itself does not produce a session', async () => {
    getAccessToken.mockReturnValue('ACCESS-0');
    refreshSession.mockResolvedValue(false);
    const hook = drive(useNative, IMAGE);
    await act(async () => {
      hook.current.onError({ nativeEvent: { responseCode: 401 } });
      await Promise.resolve();
    });
    expect(hook.current.failed).toBe(true);
  });
});

// ----------------------------------------------------------------------- web --

describe('web: the bytes are fetched, because react-native-web drops headers', () => {
  const objectUrls: string[] = [];

  beforeEach(() => {
    objectUrls.length = 0;
    // jsdom implements neither, and RNW's loader would use them for real.
    globalThis.URL.createObjectURL = vi.fn((_blob: Blob) => {
      const url = `blob:avo/${objectUrls.length}`;
      objectUrls.push(url);
      return url;
    }) as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  const ok = () => new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 });

  it('sends the session as a header and renders the blob it gets back', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    const hook = drive(useWeb, IMAGE);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(IMAGE.url, {
      headers: { authorization: 'Bearer ACCESS-0' },
    });
    expect(hook.current.source).toEqual({ uri: 'blob:avo/0' });
    expect(hook.current.failed).toBe(false);
  });

  it('takes an already-rotated token WITHOUT spending a refresh — same rule as native', async () => {
    getAccessToken.mockReturnValueOnce('ACCESS-0').mockReturnValue('ACCESS-1');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    const hook = drive(useWeb, IMAGE);
    await settle();

    expect(refreshSession).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual([
      IMAGE.url,
      { headers: { authorization: 'Bearer ACCESS-1' } },
    ]);
    expect(hook.current.source).toEqual({ uri: 'blob:avo/0' });
  });

  it('refreshes ONCE when the token it sent IS the current one and was still refused', async () => {
    getAccessToken.mockReturnValue('ACCESS-0');
    refreshSession.mockImplementation(async () => {
      getAccessToken.mockReturnValue('ACCESS-1');
      return true;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', fetchMock);

    const hook = drive(useWeb, IMAGE);
    await settle();

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[1]).toEqual([
      IMAGE.url,
      { headers: { authorization: 'Bearer ACCESS-1' } },
    ]);
    expect(hook.current.source).toEqual({ uri: 'blob:avo/0' });
  });

  it('gives up when the 401 survives the refresh — one retry, never a loop', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const hook = drive(useWeb, IMAGE);
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(hook.current.failed).toBe(true);
    expect(hook.current.source).toBeNull();
  });

  it('OFFLINE: a rejected fetch is a failed tile and nothing else', async () => {
    // What `fetch` does with no route to the host. It must not throw out of the
    // effect and take the Shop screen down with it.
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const hook = drive(useWeb, IMAGE);
    await settle();

    expect(hook.current.failed).toBe(true);
    expect(hook.current.source).toBeNull();
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('never asks at all when there is no image or no session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal('fetch', fetchMock);

    drive(useWeb, null);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    cleanup();
    getAccessToken.mockReturnValue(null);
    const hook = drive(useWeb, IMAGE);
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hook.current.failed).toBe(true);
  });

  it('revokes the object URL, so a scrolled list does not pin every photograph', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok()));
    drive(useWeb, IMAGE);
    await settle();
    cleanup();
    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:avo/0');
  });
});
