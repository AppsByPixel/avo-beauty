/**
 * Turning an `ImageRef` into something `<Image>` can render — the WEB and
 * default implementation.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE ARE TWO OF THESE FILES AND METRO PICKS ONE. READ BOTH BEFORE EDITING.
 * `authedImage.native.ts` carries the long argument for the split; the short
 * version is that `<Image source={{ uri, headers }} />` works on iOS and is
 * SILENTLY IGNORED by `react-native-web`, which sets `image.src = uri` on a bare
 * `new window.Image()` and never looks at `headers`. `GET /v1/images/{id}` is
 * authenticated, so on web that prop produces a 401 and a blank tile.
 *
 * So web does what `api/src/routes/images.ts` says the dashboard does: fetch the
 * bytes with the header, `URL.createObjectURL` the blob, render that. The route's
 * own comment anticipates this — "for an image neither cost exists: it IS a blob,
 * and it has no filename to lose."
 * ─────────────────────────────────────────────────────────────────────────────
 * IT DOES NOT GO THROUGH `api/client.ts`, AND THAT IS DELIBERATE RATHER THAN
 * LAZY. Every helper there ends in `schema.safeParse(await response.json())`.
 * These bytes are a PNG. Adding a "give me the raw response" door to the module
 * whose entire job is "nothing reaches a screen unvalidated" would weaken the one
 * guarantee that file exists to make, for one caller that has no schema to check
 * against anyway.
 *
 * What it re-uses instead is the part that matters and cannot be duplicated
 * safely: `refreshSession()`, with its in-flight latch. See
 * `authedImage.native.ts` § WHY THE 401 RETRY IS HERE.
 *
 * WHAT IS GIVEN UP BY NOT USING `client.ts`: the 15-second timeout, the request
 * reference in the log, and the `ApiError` classification. None of them has a
 * consumer here — a product photograph that does not arrive shows the swatch,
 * which is the same thing it shows when there is no photograph, so there is no
 * failure to classify and nothing to put a reference on. Stated rather than
 * assumed, because "it does not use the client" is exactly the sentence that
 * hides a screen quietly talking to the API on its own terms.
 *
 * THE OBJECT URL IS REVOKED. A blob URL pins its bytes in the tab until it is
 * revoked; a shop list scrolled for a minute would otherwise hold every
 * full-size photograph it ever painted, and the route serves originals — no
 * thumbnails, no resizing, by that file's own documented decision.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImageRef } from '@avo/types';
import { refreshSession } from '../api/client';
import { getAccessToken } from '../api/session';
import type { AuthedImage } from './authedImageShared';

/** One fetch, with a named token, so the caller can tell which one was refused. */
async function fetchImage(url: string, token: string): Promise<Response | null> {
  try {
    return await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    // Transport. On web that is the offline case, and it is not distinguishable
    // from a blocked request — neither needs to be, because both render a swatch.
    return null;
  }
}

/**
 * A token to try after a 401, or null if there is nothing left to try.
 *
 * THE CHEAP CASE FIRST, and `authedImage.native.ts` carries the argument in
 * full: the ordinary 401 is not a dead session, it is a tile still holding the
 * token it started with while `client.ts` rotated for some JSON call. Refresh
 * tokens ROTATE and the API cannot tell a replay from a theft, so spending one
 * to be handed a token the app already has is not free.
 *
 * KEPT IDENTICAL TO THE NATIVE HALF ON PURPOSE. Two files that answer a 401
 * differently is how a platform split turns into two products.
 */
async function tokenAfter401(refused: string): Promise<string | null> {
  const current = getAccessToken();
  if (current !== null && current !== refused) return current;
  return (await refreshSession()) ? getAccessToken() : null;
}

export function useAuthedImage(image: ImageRef | null): AuthedImage {
  const [source, setSource] = useState<AuthedImage['source']>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const objectUrl = useRef<string | null>(null);

  const url = image?.url ?? null;

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setReady(false);
    setFailed(false);

    if (url === null) return undefined;

    void (async () => {
      const sent = getAccessToken();
      if (sent === null) {
        // No session to authorise with. Not an error worth a request.
        setFailed(true);
        return;
      }

      let response = await fetchImage(url, sent);

      /*
        ONE retry, and only on a 401. See `authedImage.native.ts` — a second
        refusal after a fresh token is the server refusing this principal for
        this image, not an expiry, and retrying it is a loop.
      */
      if (response?.status === 401) {
        const next = await tokenAfter401(sent);
        if (cancelled) return;
        response = next === null ? null : await fetchImage(url, next);
      }

      if (cancelled) return;
      if (!response || !response.ok) {
        setFailed(true);
        return;
      }

      const blob = await response.blob();
      if (cancelled) {
        // The await above can outlive the effect. Nothing was created yet, so
        // there is nothing to revoke — but there is also nothing to publish.
        return;
      }
      const next = URL.createObjectURL(blob);
      objectUrl.current = next;
      setSource({ uri: next });
    })();

    return () => {
      cancelled = true;
      if (objectUrl.current !== null) {
        URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = null;
      }
    };
  }, [url]);

  const onLoad = useCallback(() => setReady(true), []);
  /*
    Reached only after the blob URL is already in hand, so it means the browser
    could not DECODE what the API served. `failed`, with nothing to retry —
    re-fetching identical bytes would decode identically.
  */
  const onError = useCallback(() => setFailed(true), []);

  return { source, ready, failed, onLoad, onError };
}
