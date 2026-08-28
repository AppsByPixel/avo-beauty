import { useEffect, useState } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { ImageRef, Product } from '@avo/types';
import { authedRequest, authedRequestDetailed } from '../auth/authedRequest.js';
import { useSalonId } from '../auth/AuthProvider.js';
import { ApiError } from './client.js';
import { productKeys } from './products.js';
import type { Paginated } from './salon.js';

/**
 * A picture on a product. `api/src/routes/images.ts`, merged as `b4e5cf3`.
 *
 *   POST   /v1/salons/{id}/products/{pid}/image   perms.shop, raw bytes
 *   DELETE /v1/salons/{id}/products/{pid}/image   perms.shop
 *   GET    /v1/images/{imageId}                   any principal of that salon
 *
 * PRODUCTS ONLY. The same API carries `…/services/{sid}/image` behind
 * `perms.appointments` and there is nothing here for it, because there is nowhere
 * to put it: `design/AVO Merchant Dashboard.dc.html` draws no Services section and
 * this dashboard has no service editor. Lane A found the same absence from the
 * other side and wrote the permission choice down as an escalation rather than a
 * ruling. Building an editor to hang one upload off would be inventing a screen.
 *
 * ============================================================================
 * THE READ IS AUTHENTICATED, SO `<img src={url}>` IS A 401
 * ============================================================================
 * `GET /v1/images/{id}` requires a salon-scoped principal, and a browser sends no
 * `Authorization` header when it paints an `<img>`. That is not an oversight in
 * the API — the catalog those pictures hang on is not public either, and Lane A's
 * comment spends a page on why a signed public URL was refused. The cost lands
 * here and is paid, not wished away:
 *
 *     fetch(url, { headers }) → URL.createObjectURL(blob) → <img src={objectUrl}>
 *
 * WHICH MAKES US THE OWNER OF A RESOURCE THE GARBAGE COLLECTOR CANNOT REACH.
 * An object URL is a document-lifetime entry in a browser-held table; the Blob
 * behind it stays alive until `revokeObjectURL`, whatever React does with the
 * component. A merchant scrolling a long catalog would leak one 2 MB buffer per
 * row per mount until she closed the tab. `useProductImage` below revokes in the
 * effect's cleanup, which is the only path that runs on unmount, on a replaced
 * image and on a StrictMode double-invoke alike. `productImage.test.ts` counts
 * the creates against the revokes rather than trusting this paragraph.
 *
 * ============================================================================
 * WHY NOT REACT QUERY FOR THE BYTES
 * ============================================================================
 * Every other read on this surface is a `useQuery`. This one is a plain effect,
 * deliberately: a query cache holds its entry until a gc timer says otherwise, so
 * the blob's lifetime would stop being tied to the component that can see it and
 * the revoke above would have nothing safe to hang on. The HTTP cache does the
 * job a query cache would have done anyway — Lane A serves these with
 * `cache-control: private, max-age=31536000, immutable`, which is honest because
 * bytes are never rewritten under an id.
 */

/* ------------------------------------------------------------------ the read */

export type ImageLoad =
  /** No image on this product. The common case, and not a failure. */
  | { status: 'none'; objectUrl: null }
  | { status: 'loading'; objectUrl: null }
  | { status: 'ready'; objectUrl: string }
  /** The bytes did not arrive, or arrived and would not decode. */
  | { status: 'error'; objectUrl: null; message: string };

/**
 * Fetch an `ImageRef`'s bytes with the session and hand back an object URL that
 * is revoked when this component stops needing it.
 *
 * KEYED ON `url`, NOT ON THE `ImageRef` OBJECT. The row is re-serialised on every
 * refetch, so an identity check would refetch the same bytes on every poll. The
 * url is stable for the life of an image id and a replacement mints a new id
 * (`api/src/db/schema/image.ts` § BYTES ARE IMMUTABLE), so a changed url is
 * exactly and only a changed picture.
 */
export function useProductImage(image: ImageRef | null | undefined): ImageLoad {
  const url = image?.url ?? null;
  const [load, setLoad] = useState<ImageLoad>(url ? NONE : NONE);

  useEffect(() => {
    if (!url) {
      setLoad(NONE);
      return;
    }

    /*
     * `cancelled` AND the abort, and they are not the same guard. The abort stops
     * the transfer; `cancelled` stops a response that had already resolved from
     * creating an object URL after this effect stopped being the one that could
     * revoke it. Without it, an unmount landing between the `await` and the
     * `createObjectURL` leaks exactly one blob and leaves no trace.
     */
    let cancelled = false;
    let objectUrl: string | null = null;
    const controller = new AbortController();

    setLoad(LOADING);

    authedRequest<Blob>('merchant', url, { expect: 'blob', signal: controller.signal })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setLoad({ status: 'ready', objectUrl });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoad({ status: 'error', objectUrl: null, message: readFailureMessage(error) });
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return load;
}

const NONE: ImageLoad = { status: 'none', objectUrl: null };
const LOADING: ImageLoad = { status: 'loading', objectUrl: null };

/**
 * Why a picture would not load, said in the row rather than in the console.
 *
 * A 404 here is its own fact and worth naming: Lane A serves ONE uniform
 * `unknown_image` for unknown, another salon's, and detached-then-reaped, and the
 * third of those is the one a merchant can actually hit — a photo removed on
 * another device and a list this tab has not refetched.
 */
function readFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'That photo is no longer stored. Refresh, or upload it again.';
    if (error.isConnectivity) return 'The photo could not be loaded — check your connection.';
  }
  return 'The photo could not be loaded.';
}

/* --------------------------------------------------------------- the uploads */

export interface UploadResult {
  ref: ImageRef;
  /** 201 — the slot was empty. `false` is a 200: something was replaced. */
  created: boolean;
}

/**
 * `POST /v1/salons/{id}/products/{pid}/image` — the file as the body.
 *
 * NO `Idempotency-Key`, and that is non-negotiable #4 read rather than skipped:
 * #4 is about money-moving POSTs, and the handler takes no such header and has no
 * idempotency table behind it. A double-submitted upload replaces an image with
 * itself; `attachImage` even deduplicates on checksum. Nothing moves.
 *
 * THE STATUS IS THE POINT OF THE `Detailed` CALL. 201 means she added a photo to
 * a product that had none; 200 means she changed one. Collapsing them into "Saved"
 * would lose the only confirmation that a replacement actually took — which is the
 * case where the picture on screen may be indistinguishable from the one before it.
 */
export function useUploadProductImage(): UseMutationResult<
  UploadResult,
  unknown,
  { productId: string; file: File }
> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    /*
     * `raw` IS THE `File` ITSELF, with the type the browser read off it. A file
     * the OS could not type at all arrives as `''`, and the server answers 415
     * naming what it accepts — a better sentence than any guess made here, and
     * `application/octet-stream` would be a guess dressed as a fact.
     *
     * THE COMMENT IS OUT HERE RATHER THAN ON THE `raw:` LINE, which looks like
     * fussiness and is not. `merchantScopeGates.test.ts` reads this call site to
     * decide which route it hits, and its options-object window is 240 characters
     * — a comment inside the braces pushes `method: 'POST'` out of reach, the
     * method silently defaults to GET, and the call resolves to no route. It
     * fails loudly there rather than passing in silence, which is the only reason
     * this is a comment placement and not a parser change.
     */
    mutationFn: async ({ productId, file }) => {
      const { status, body } = await authedRequestDetailed<ImageRef>(
        'merchant',
        `/v1/salons/${salonId}/products/${productId}/image`,
        { method: 'POST', raw: { body: file, contentType: file.type } },
      );
      return { ref: body, created: status === 201 };
    },
    /*
     * Patched in place, never invalidated — `useCreateProduct`'s reason. The 201
     * body IS the new `ImageRef`, so a refetch would blank the row for a beat
     * right after an action whose whole point was that a picture appeared.
     */
    onSuccess: ({ ref }, { productId }) => patchImage(queryClient, salonId, productId, ref),
  });
}

/**
 * `DELETE /v1/salons/{id}/products/{pid}/image` → 204.
 *
 * NO CONFIRMATION STEP, and that is a deliberate difference from the ✕ that
 * retires the product beside it. Retiring is one-way and takes a product off sale;
 * this detaches a picture from a row that carries on selling, the bytes survive a
 * grace window server-side, and the remedy is to drop the file on the square
 * again. A modal for it would be the same weight as a modal for a price edit on a
 * screen whose contract is "changes save as you type".
 */
export function useRemoveProductImage(): UseMutationResult<void, unknown, { productId: string }> {
  const salonId = useSalonId();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ productId }) =>
      authedRequest<void>('merchant', `/v1/salons/${salonId}/products/${productId}/image`, {
        method: 'DELETE',
      }),
    onSuccess: (_void, { productId }) => patchImage(queryClient, salonId, productId, null),
  });
}

function patchImage(
  queryClient: ReturnType<typeof useQueryClient>,
  salonId: string,
  productId: string,
  image: ImageRef | null,
): void {
  queryClient.setQueryData<Paginated<Product>>(productKeys.list(salonId), (current) =>
    current
      ? {
          ...current,
          items: current.items.map((p) => (p.id === productId ? { ...p, image } : p)),
        }
      : current,
  );
}

/* ------------------------------------------------------------ the refusals */

export interface ImageRejection {
  /** The sentence. Server-authored wherever the server wrote one. */
  message: string;
  /** A second line only where the first one leaves a merchant wondering. */
  aside: string | null;
  /** True when trying the same file again is pointless. */
  final: boolean;
}

/**
 * WHAT A MERCHANT READS WHEN A FILE IS REFUSED, and every one of these is
 * reachable by picking a file rather than by breaking something.
 *
 *   413 image_too_large              carries maxBytes
 *   415 unsupported_image_type       carries accepted — THE SVG CASE
 *   400 not_an_image                 bytes are not a readable PNG/JPEG/WebP
 *   400 content_type_mismatch        carries declared + actual
 *   400 image_too_large_dimensions   longest side over the ceiling
 *   400 image_too_many_pixels        the decompression-bomb ceiling
 *   503 image_store_unconfigured     no store in this environment
 *
 * THE SERVER'S SENTENCE IS THE SENTENCE. Lane A wrote complete, specific copy for
 * all seven — "That image is 3.4 MB. The limit is 2 MB.", "image/svg+xml is not an
 * image type we accept. Send a PNG, JPEG or WebP. An SVG can carry script and is
 * never accepted for a catalog image." Paraphrasing them here would be a second
 * copy of a rule that lives in the API, and a worse one. This function decides
 * WHICH state to render and what to add, not what the refusal says.
 *
 * TWO PLACES IT ADDS A LINE, both where the server's sentence is complete about
 * the file and silent about the merchant:
 *
 *   image_store_unconfigured  is not about her file at all. Without a second line
 *                             she reads an accurate sentence about storage
 *                             configuration and concludes she picked a bad photo.
 *   content_type_mismatch     "Send the file with its own type" is an instruction
 *                             a merchant cannot follow — she did not set the
 *                             type, the file's extension did. The thing that
 *                             actually works is to open and re-save it.
 *
 * ============================================================================
 * `image_store_unconfigured` IS A 503, AND A 503 IS `isConnectivity` HERE
 * ============================================================================
 * `ApiError.isConnectivity` sweeps every 503 in with dead wifi, which is right for
 * a load-shedding API and wrong for this one refusal: it would tell a merchant
 * "No connection to the workspace" while her connection is fine and the actual
 * problem is that nobody has chosen where this deployment keeps files. So the code
 * is matched BEFORE the connectivity branch, here and in the slot. Reported rather
 * than fixed in `client.ts`: widening that getter would change the branch every
 * other screen takes on a 503.
 */
export function imageRejection(error: unknown): ImageRejection {
  if (!(error instanceof ApiError)) {
    return { message: 'That photo could not be uploaded.', aside: null, final: false };
  }

  /**
   * ============================================================================
   * A 413 THE SERVER DID NOT WRITE COPY FOR, FOUND BY DROPPING AN 8 MB FILE
   * ============================================================================
   * `routes/images.ts` sets TWO ceilings and says so: `IMAGE_MAX_BYTES` is the
   * product rule and produces `image_too_large` with the limit in the body, and
   * Fastify's `bodyLimit` — twice that — is the DoS backstop that "produces a
   * blunt 413". A file over the backstop never reaches the handler, so it never
   * reaches the sentence written for it. Measured, not reasoned about: an 8.4 MB
   * PNG comes back
   *
   *     413  {"error":"bad_request",
   *           "message":"That request could not be read. Check the fields and try again."}
   *
   * which is Fastify's message through this API's generic error handler. Rendering
   * it verbatim tells a merchant who dropped a photo to check FIELDS — there are no
   * fields — and says nothing about size, which is the one fact she needs.
   *
   * So the STATUS is trusted here where the code is not. Any 413 is "too big to
   * send"; only the named one carries a limit, and no number is invented for the
   * other. Reported to trunk as an API copy gap rather than papered over as if the
   * dashboard had authored it: the honest fix is a `bodyLimit` error handler on
   * that route saying the same thing `image_too_large` says.
   */
  if (error.status === 413 && error.code !== 'image_too_large') {
    return {
      message: 'That photo is too large to send.',
      aside: 'It did not reach us at all — nothing was changed. Crop it or save it smaller, then drop it here again.',
      final: true,
    };
  }

  if (error.code === 'image_store_unconfigured') {
    return {
      message: error.message,
      aside: 'Nothing is wrong with your photo — this workspace has nowhere to keep it yet. Tell AVO support.',
      final: true,
    };
  }

  if (error.code === 'content_type_mismatch') {
    return {
      message: error.message,
      aside: 'Open it and save it again as a PNG or JPEG, then drop the new file here.',
      final: true,
    };
  }

  /*
   * The four that arrive fully explained: too big, wrong type, not an image,
   * too many pixels. Nothing to add — and `final`, because the same file will be
   * refused the same way for the same reason. A Try again button on any of these
   * would be a lie about what pressing it does.
   */
  if (FINAL_CODES.has(error.code)) {
    return { message: error.message, aside: null, final: true };
  }

  if (error.isForbidden) {
    // Server-authored, and it names who can grant the permission.
    return { message: error.message, aside: null, final: true };
  }

  if (error.isConnectivity) {
    return {
      message: 'The photo did not reach us.',
      aside: 'Check your connection and drop it on the square again. Nothing was changed.',
      final: false,
    };
  }

  return {
    message: error.message || 'That photo could not be uploaded.',
    aside: 'Nothing was changed.',
    final: false,
  };
}

const FINAL_CODES = new Set([
  'image_too_large',
  'unsupported_image_type',
  'not_an_image',
  'image_too_large_dimensions',
  'image_too_many_pixels',
  'empty_body',
]);
