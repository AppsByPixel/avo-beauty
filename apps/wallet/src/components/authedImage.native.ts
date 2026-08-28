/**
 * Turning an `ImageRef` into something `<Image>` can render — iOS and ANDROID.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE ARE TWO OF THESE FILES AND METRO PICKS ONE. READ BOTH BEFORE EDITING.
 *
 *   authedImage.ts          web, and any target without a platform variant.
 *                           Fetches the bytes and hands over a blob URL.
 *   authedImage.native.ts   this file. iOS and Android. Hands the URL straight
 *                           to `<Image>` with an `authorization` header on it.
 *
 * The split is NOT a style choice and NOT symmetry for its own sake. It is the
 * single most important thing this slice found:
 *
 *   `<Image source={{ uri, headers }} />` WORKS ON NATIVE AND IS IGNORED ON WEB.
 *
 * On iOS the dictionary becomes an `NSURLRequest` and the headers are set on it
 * — `react-native/React/Base/RCTConvert.mm:189`, `request.allHTTPHeaderFields =
 * headers`, reached because a GET carrying headers is excluded from the
 * bare-`requestWithURL:` fast path three lines above. Driven on a simulator as
 * well as read; see the header of `ProductImage.tsx`.
 *
 * On web the same prop reaches `react-native-web`, whose loader is
 * `dist/modules/ImageLoader/index.js` — `var image = new window.Image(); …
 * image.src = uri`. The string `headers` does not appear ANYWHERE in
 * `react-native-web/dist/exports/Image`. It is not deprecated and it does not
 * warn: the prop is accepted, dropped, and the request goes out unauthenticated.
 * `GET /v1/images/{id}` answers 401 and the tile is blank.
 *
 * That is exactly the failure this slice was told to look for — "a silently
 * blank product tile looks like *no image* instead of *auth failed*" — and the
 * wallet's web target is not hypothetical: `pnpm --dir … run web` is how this app
 * is demoed, and `i18n/language.tsx` calls web "the pilot target". So a single
 * `<Image source={{ uri, headers }} />` would have shipped a shop that works on
 * the phone and shows no photographs at all in the demo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE 401 RETRY IS HERE AND NOT IN THE SCREEN
 *
 * `<Image>` does not go through `api/client.ts`. It has its own loader, its own
 * cache and its own error path, so NONE of the refresh-and-retry-once machinery
 * that makes every JSON call survive an expired access token applies to it. An
 * access token lives fifteen minutes; a customer who leaves the Shop tab open
 * past that and scrolls comes back to tiles that 401 forever.
 *
 * So this hook re-implements exactly one step of it — refresh once, retry once —
 * and deliberately re-uses `refreshSession()` rather than rolling its own. That
 * matters at more than one tile: `refreshSession` holds the in-flight latch that
 * exists because refresh tokens ROTATE, so forty tiles that 401 together produce
 * ONE rotation. A hand-written refresh here would produce forty, thirty-nine of
 * which present a token that was just invalidated — which is the exact bug that
 * latch was written for, arriving through a component instead of through a
 * screen.
 *
 * ONE retry, guarded by a ref and not by state. A second 401 after a successful
 * rotation is not an expiry — it is the server refusing this principal for this
 * image — and a component that kept retrying would hammer `/v1/images/{id}` once
 * per tile per render forever. `api/client.ts` § `send` makes the same call for
 * the same reason.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `responseCode` IS REAL AT RUNTIME AND ABSENT FROM THE TYPE, so it is read
 * defensively.
 *
 * React Native declares the error payload as `{ error: string }` — Flow at
 * `Libraries/Image/ImageProps.js:44`, TypeScript at `Libraries/Image/Image.d.ts:125`.
 * Both are behind the native code. iOS puts the HTTP status in the event on both
 * architectures:
 *
 *   old  `Libraries/Image/RCTImageView.mm:382`
 *        `@"responseCode" : (error.userInfo[@"httpStatusCode"] ?: [NSNull null])`
 *   new  `React/Fabric/.../RCTImageComponentView.mm:195` → `info.responseCode`
 *        → `ImageEventEmitter.cpp:52` → `payload.setProperty(… "responseCode")`
 *
 * and the status gets into `userInfo` at `RCTImageLoader.mm:37`
 * (`addResponseHeadersToError`), for any non-200 — `RCTImageLoader.mm:750`.
 *
 * WITHOUT IT THIS HOOK COULD NOT EXIST, because the message RN builds is
 * `"Failed to load <url>"` (RCTImageLoader.mm:751) with no status in it: a 401,
 * a 404 and a truncated PNG are one indistinguishable string. Reading it through
 * a narrowing helper rather than a cast, because it is a field the compiler has
 * been told does not exist and a cast would make that invisible the day RN
 * changes it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ImageRef } from '@avo/types';
import { refreshSession } from '../api/client';
import { getAccessToken } from '../api/session';
import { type AuthedImage, httpStatusOfImageError } from './authedImageShared';

export function useAuthedImage(image: ImageRef | null): AuthedImage {
  /**
   * The token this attempt is going out with. STATE, not a read inside the memo,
   * so that the one thing allowed to change it — a rotation forced by a 401 — is
   * the one thing that rebuilds the source.
   *
   * It is a capture, and unlike `client.ts` § `sendOnce` ("read at SEND time")
   * there is no way for it not to be: RN reads the dictionary when the prop is
   * set, not when the request goes out. The retry below is what covers the gap.
   */
  const [token, setToken] = useState<string | null>(() => getAccessToken());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const retried = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /*
    A NEW IMAGE ID IS A NEW SUBJECT. Product rows are keyed by product id and a
    merchant replacing a photo mints a NEW image id (db/schema/image.ts § BYTES
    ARE IMMUTABLE), so the same mounted tile can be asked about a different
    picture. Carrying `failed` across that would show the swatch for an image
    that was never tried.
  */
  const id = image?.id ?? null;
  const seen = useRef(id);
  useEffect(() => {
    /*
      AND NOT ON MOUNT. Every value below is already its initial value on the
      first run, so the reset would be a no-op — except `setToken`, which would
      re-read the token and, if the two reads ever disagreed, throw away the one
      the source was just built from. A guard rather than a harmless duplicate:
      "it happens to be equal" is not a property this can rely on.
    */
    if (seen.current === id) return;
    seen.current = id;
    retried.current = false;
    setReady(false);
    setFailed(false);
    setToken(getAccessToken());
  }, [id]);

  /*
    KEYED ON THE URL STRING, NOT ON THE `ImageRef` OBJECT. `useShop` hands the
    catalogue down as an array of objects; a refetch that returns the identical
    catalogue still produces new object identities for every row. Depending on
    the object would rebuild forty source dictionaries on every refresh for a
    payload that did not change — and the web half already depends on `url` for
    exactly this reason, so keeping them the same is also what stops the two
    halves quietly acquiring different re-request behaviour.
  */
  const url = image?.url ?? null;
  const source = useMemo<AuthedImage['source']>(() => {
    if (url === null || token === null) return null;
    return { uri: url, headers: { authorization: `Bearer ${token}` } };
  }, [url, token]);

  const onLoad = useCallback(() => {
    if (alive.current) setReady(true);
  }, []);

  const onError = useCallback(
    (event: unknown) => {
      const status = httpStatusOfImageError(event);
      if (status !== 401 || retried.current) {
        if (alive.current) setFailed(true);
        return;
      }
      retried.current = true;

      /*
        THE CHEAP CASE FIRST: SOMEONE ELSE ALREADY ROTATED.

        A tile holds the token it was built with, and `client.ts` refreshes on
        its own schedule for every JSON call the app makes. So the ordinary way
        a tile meets a 401 is not "the session is dead" — it is "Home refreshed
        two seconds ago and this square did not hear about it". Rotating again
        for that would burn a perfectly good refresh token to obtain a token we
        are already holding, once per stale tile.

        Comparing first turns that into a re-render. `refreshSession` is kept for
        the case it is actually for: the token on screen IS the current one and
        the server still refused it.
      */
      const current = getAccessToken();
      if (current !== null && current !== token) {
        setToken(current);
        return;
      }

      void refreshSession().then((ok) => {
        if (!alive.current) return;
        // A refusal is not something to retry — `refreshSession` has already
        // cleared the session if the server repudiated the token, and the app
        // is on its way to sign-in. Anything else keeps the tile on its swatch.
        if (ok) setToken(getAccessToken());
        else setFailed(true);
      });
    },
    [token],
  );

  return { source, ready, failed, onLoad, onError };
}
