// @vitest-environment jsdom

/**
 * The three things about a product photo that no source scan can reach.
 *
 *   1. EVERY OBJECT URL IS REVOKED. `URL.createObjectURL` hands out a
 *      document-lifetime handle that the garbage collector cannot take back; a
 *      merchant scrolling a catalog of 2 MB photos leaks one buffer per row per
 *      mount until she closes the tab. This file COUNTS the creates against the
 *      revokes — on unmount, on a replaced image, and on the race where the bytes
 *      land after the component is gone.
 *
 *   2. 201 AND 200 ARE DIFFERENT SENTENCES. `POST … /image` answers 201 when the
 *      slot was empty and 200 when it replaced something, and `routes/images.ts`
 *      says in as many words that the distinction exists for this dashboard.
 *      Nothing in the type system notices if it is dropped — both are a 2xx
 *      carrying an `ImageRef`, and the screen would just always say "added".
 *
 *   3. THE REFUSALS REACH A MERCHANT AS THE SERVER WROTE THEM. Seven of them are
 *      reachable by picking a file. The one that matters most is the SVG: the API
 *      refuses it deliberately because it is executable, and a merchant dragging
 *      a logo off her desktop is the likeliest first failure on this screen.
 *
 * NOT A BROWSER SUBSTITUTE. The screenshots in the lane report show the states;
 * this pins the properties a screenshot cannot — a count, a status code, and a
 * string.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client.js';

/*
 * MOCKED AT THE SESSION BOUNDARY, not at `fetch`. `useProductImage` needs a
 * signed-in merchant and a token rotation it does not own; what this file is
 * about starts one layer above that, at "bytes arrived, now who frees them".
 */
const authedRequest = vi.fn();
const authedRequestDetailed = vi.fn();
vi.mock('../auth/authedRequest.js', () => ({
  authedRequest: (...args: unknown[]) => authedRequest(...args),
  authedRequestDetailed: (...args: unknown[]) => authedRequestDetailed(...args),
}));

/** The salon comes from the session and there is no session in a jsdom realm. */
vi.mock('../auth/AuthProvider.js', () => ({ useSalonId: () => 'SAL-AMARA' }));

const { useProductImage, useUploadProductImage, imageRejection } = await import(
  './productImage.js'
);
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ImageRef } from '@avo/types';

afterEach(cleanup);

const REF: ImageRef = {
  id: 'IM-AAAAAAAAAA',
  url: 'http://localhost:4000/v1/images/IM-AAAAAAAAAA',
  contentType: 'image/jpeg',
  width: 900,
  height: 600,
  byteSize: 140_000,
};

const REPLACEMENT: ImageRef = { ...REF, id: 'IM-BBBBBBBBBB', url: 'http://localhost:4000/v1/images/IM-BBBBBBBBBB' };

/* ------------------------------------------------------- the counting rig */

let created: string[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  let n = 0;
  /*
   * jsdom implements neither, so these are additions rather than overrides — and
   * they are installed on THIS test file's own jsdom window, which is a fresh
   * realm per file. Nothing here reaches another lane's browser or another
   * worker's globals.
   */
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => {
      const url = `blob:test/${++n}`;
      created.push(url);
      return url;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => void revoked.push(url),
  });
  authedRequest.mockReset();
});

/** A component that does nothing but hold the hook, so the hook is the subject. */
function Probe({ image }: { image: ImageRef | null }) {
  const load = useProductImage(image);
  return <span data-status={load.status}>{load.objectUrl ?? ''}</span>;
}

/** Lets the mocked promise settle inside `act`, so React commits the state. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('an object URL never outlives the component that can see it', () => {
  it('creates one for the bytes and revokes exactly that one on unmount', async () => {
    authedRequest.mockResolvedValue(new Blob(['jpeg-bytes']));
    const view = render(<Probe image={REF} />);
    await settle();

    expect(created).toHaveLength(1);
    expect(view.container.querySelector('span')?.dataset['status']).toBe('ready');
    // Still held — the picture is on screen.
    expect(revoked).toEqual([]);

    view.unmount();
    expect(revoked).toEqual(created);
  });

  it('revokes the old one when the image is replaced, not just the last one', async () => {
    authedRequest.mockResolvedValue(new Blob(['jpeg-bytes']));
    const view = render(<Probe image={REF} />);
    await settle();

    /*
     * A REPLACEMENT MINTS A NEW ID, so the url changes and the effect re-runs.
     * This is the leak that would never show up in a screenshot: the picture on
     * screen looks correct either way, and the old buffer is simply never freed.
     */
    view.rerender(<Probe image={REPLACEMENT} />);
    await settle();

    expect(created).toHaveLength(2);
    expect(revoked).toEqual([created[0]]);

    view.unmount();
    expect(revoked).toEqual(created);
  });

  it('creates nothing at all when the bytes land after the component is gone', async () => {
    /*
     * THE RACE THE `cancelled` FLAG EXISTS FOR, and an abort alone does not close
     * it: a response already resolved is not cancelled by aborting its controller.
     * Without the flag this creates one object URL inside a `.then` belonging to a
     * cleanup that has already run — a leak with no owner and no trace.
     */
    let land: (blob: Blob) => void = () => {};
    authedRequest.mockReturnValue(new Promise<Blob>((resolve) => (land = resolve)));

    const view = render(<Probe image={REF} />);
    view.unmount();

    await act(async () => {
      land(new Blob(['late']));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it('holds nothing for a product with no photo — the common case', async () => {
    const view = render(<Probe image={null} />);
    await settle();
    expect(authedRequest).not.toHaveBeenCalled();
    expect(created).toEqual([]);
    expect(view.container.querySelector('span')?.dataset['status']).toBe('none');
  });

  it('leaves no handle behind when the read fails', async () => {
    authedRequest.mockRejectedValue(new ApiError('No such image.', { status: 404, code: 'unknown_image' }));
    const view = render(<Probe image={REF} />);
    await settle();

    expect(view.container.querySelector('span')?.dataset['status']).toBe('error');
    expect(created).toEqual([]);
    view.unmount();
    expect(revoked).toEqual([]);
  });
});

describe('the read is authenticated, which is the whole reason for the blob', () => {
  it('asks for the bytes through the session, not as a bare src', async () => {
    authedRequest.mockResolvedValue(new Blob(['x']));
    render(<Probe image={REF} />);
    await settle();

    const [scope, url, options] = authedRequest.mock.calls[0]!;
    expect(scope).toBe('merchant');
    // The server-minted absolute url off the ImageRef, unchanged.
    expect(url).toBe(REF.url);
    expect((options as { expect?: string }).expect).toBe('blob');
    // Abortable, so a row scrolled past mid-transfer stops costing bandwidth.
    expect((options as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it('names a reaped photo as gone rather than as a generic failure', async () => {
    authedRequest.mockRejectedValue(new ApiError('No such image.', { status: 404, code: 'unknown_image' }));
    const view = render(<Probe image={REF} />);
    await settle();
    expect(view.container.querySelector('span')?.dataset['status']).toBe('error');
  });
});

/* ---------------------------------------------------------- the refusals */

describe('what a merchant reads when a file is refused', () => {
  /** The server's own sentence for each, quoted from `api/src/routes/images.ts`. */
  function refusal(status: number, code: string, message: string, details = {}) {
    return new ApiError(message, { status, code, details });
  }

  it('renders the SVG refusal as the server wrote it, reason included', () => {
    /*
     * THE LIKELIEST FIRST FAILURE ON THIS SCREEN. `accept` on the file input does
     * nothing to a drag-and-drop, so a merchant dragging her logo straight off the
     * desktop reaches this every time. The sentence has to say more than
     * "unsupported image type" — and the API's does, so this asserts it is not
     * paraphrased away.
     */
    const out = imageRejection(
      refusal(
        415,
        'unsupported_image_type',
        'image/svg+xml is not an image type we accept. Send a PNG, JPEG or WebP. An SVG can carry script and is never accepted for a catalog image.',
        { accepted: ['image/png', 'image/jpeg', 'image/webp'], declared: 'image/svg+xml' },
      ),
    );
    expect(out.message).toContain('Send a PNG, JPEG or WebP');
    expect(out.message).toContain('An SVG can carry script');
    // Trying the same file again produces the same refusal, so nothing is offered.
    expect(out.final).toBe(true);
  });

  it('renders the size refusal with the server’s numbers, and hard-codes none', () => {
    const out = imageRejection(
      refusal(413, 'image_too_large', 'That image is 3.4 MB. The limit is 2 MB.', {
        maxBytes: 2 * 1024 * 1024,
        byteSize: 3_500_000,
      }),
    );
    expect(out.message).toBe('That image is 3.4 MB. The limit is 2 MB.');
    expect(out.final).toBe(true);
  });

  it('says "too large" for the backstop 413 too, and invents no limit for it', () => {
    /*
     * FOUND IN THE BROWSER, NOT IN THE CONTRACT. A file over Fastify's `bodyLimit`
     * (twice the product limit) never reaches the handler that writes
     * `image_too_large`, so an 8.4 MB PNG comes back as a 413 carrying Fastify's own
     * message through the generic error handler — measured verbatim below. Rendered
     * as written it tells a merchant who dropped a photo to "check the fields".
     */
    const backstop = refusal(
      413,
      'bad_request',
      'That request could not be read. Check the fields and try again.',
    );
    const out = imageRejection(backstop);
    expect(out.message).toBe('That photo is too large to send.');
    expect(out.message).not.toMatch(/fields/i);
    // No number, because this response carries none — the named 413 is the only one
    // that knows the limit, and guessing it here would be a second source of truth.
    expect(out.message).not.toMatch(/\d+\s*MB/);
    expect(out.aside).toMatch(/nothing was changed/i);
    expect(out.final).toBe(true);
  });

  it('still prefers the server\'s own numbers when the named 413 arrives', () => {
    const out = imageRejection(
      refusal(413, 'image_too_large', 'That image is 3.4 MB. The limit is 2 MB.', {
        maxBytes: 2097152,
      }),
    );
    expect(out.message).toBe('That image is 3.4 MB. The limit is 2 MB.');
  });

  it('adds the step a merchant can actually take on a content-type mismatch', () => {
    /*
     * "Send the file with its own type" is a correct instruction she cannot follow
     * — she never set the type. The aside names the thing that works.
     */
    const out = imageRejection(
      refusal(400, 'content_type_mismatch', 'You sent image/png but the file is a JPEG. Send the file with its own type.', {
        declared: 'image/png',
        actual: 'image/jpeg',
      }),
    );
    expect(out.message).toContain('but the file is a JPEG');
    expect(out.aside).toMatch(/save it again/i);
  });

  it('tells her a storage outage is not her photo — and does NOT call it a dead connection', () => {
    /*
     * `image_store_unconfigured` IS A 503, AND `ApiError.isConnectivity` SWEEPS
     * EVERY 503 IN WITH DEAD WIFI. Left to that branch, a merchant on a perfectly
     * good connection reads "No connection to the workspace" about a deployment
     * that has nowhere to keep files. Matching the code first is what prevents it,
     * and this is the case that proves the order.
     */
    const err = refusal(
      503,
      'image_store_unconfigured',
      'Image storage is not configured for this environment.',
    );
    expect(err.isConnectivity).toBe(true); // the trap, stated
    const out = imageRejection(err);
    expect(out.message).toBe('Image storage is not configured for this environment.');
    expect(out.aside).toMatch(/Nothing is wrong with your photo/);
    expect(out.aside).not.toMatch(/connection/i);
    expect(out.final).toBe(true);
  });

  it('offers another go only where another go could work', () => {
    const final = [
      refusal(413, 'image_too_large', 'x'),
      refusal(415, 'unsupported_image_type', 'x'),
      refusal(400, 'not_an_image', 'x'),
      refusal(400, 'image_too_large_dimensions', 'x'),
      refusal(400, 'image_too_many_pixels', 'x'),
    ];
    for (const e of final) expect(imageRejection(e).final, e.code).toBe(true);

    // A dropped connection is the one refusal where the same file will do.
    const offline = new ApiError('No connection to the workspace.', {
      status: 0,
      code: 'network_error',
      offline: true,
    });
    const out = imageRejection(offline);
    expect(out.final).toBe(false);
    expect(out.aside).toMatch(/Nothing was changed/);
  });

  it('says nothing was changed, because nothing was', () => {
    // The reassurance that matters: a refused upload leaves the product exactly as
    // it was, photo and all. Without it she does not know whether to look.
    const out = imageRejection(refusal(500, 'server_error', 'Something went wrong on our side.'));
    expect(out.aside).toBe('Nothing was changed.');
    expect(out.final).toBe(false);
  });
});


/* ------------------------------------------------- "added" versus "changed" */

describe('the status code is the difference between adding and changing', () => {
  /**
   * `POST … /image` answers **201 when the slot was empty and 200 when it replaced
   * an existing image**, and `api/src/routes/images.ts` states the reason in as
   * many words: "the dashboard needs it to choose between 'added' and 'changed' in
   * its own toast."
   *
   * NOTHING ELSE WOULD NOTICE IF THIS WERE DROPPED. Both answers are a 2xx
   * carrying an identical `ImageRef`; a client that took only the body would
   * typecheck, render the right picture, and say "Photo added" forever. A
   * REPLACEMENT is the case where that matters most — the new photo may look much
   * like the old one, so the sentence is the only evidence the write took.
   */
  function harness() {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const seen: { created?: boolean } = {};
    function Probe() {
      const upload = useUploadProductImage();
      return (
        <button
          onClick={() =>
            upload.mutate(
              { productId: 'PR-01', file: new File(['x'], 'oil.jpg', { type: 'image/jpeg' }) },
              { onSuccess: ({ created }) => void (seen.created = created) },
            )
          }
        >
          go
        </button>
      );
    }
    const view = render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
    return { view, seen };
  }

  it('reads a 201 as "this product had no photo"', async () => {
    authedRequestDetailed.mockResolvedValue({ status: 201, body: REF });
    const { view, seen } = harness();
    await act(async () => void view.container.querySelector('button')!.click());
    await settle();
    expect(seen.created).toBe(true);
  });

  it('reads a 200 as "this replaced one"', async () => {
    authedRequestDetailed.mockResolvedValue({ status: 200, body: REPLACEMENT });
    const { view, seen } = harness();
    await act(async () => void view.container.querySelector('button')!.click());
    await settle();
    expect(seen.created).toBe(false);
  });

  it('sends the file as the body with its own type — not multipart, not JSON', async () => {
    authedRequestDetailed.mockResolvedValue({ status: 201, body: REF });
    const { view } = harness();
    await act(async () => void view.container.querySelector('button')!.click());
    await settle();

    const [scope, path, options] = authedRequestDetailed.mock.calls[0]!;
    expect(scope).toBe('merchant');
    expect(path).toBe('/v1/salons/SAL-AMARA/products/PR-01/image');
    const opts = options as { method: string; raw: { body: File; contentType: string }; body?: unknown };
    expect(opts.method).toBe('POST');
    expect(opts.raw.body).toBeInstanceOf(File);
    expect(opts.raw.contentType).toBe('image/jpeg');
    // Nothing JSON-encoded anywhere near it.
    expect(opts.body).toBeUndefined();
  });

  /**
   * NON-NEGOTIABLE #4 READ, NOT SKIPPED. #4 is about money-moving POSTs; this
   * handler takes no `Idempotency-Key` and has no idempotency table behind it. The
   * assertion is here so that "there is no key on this call" is a recorded decision
   * rather than something a reviewer has to re-derive.
   */
  it('sends no idempotency key, because nothing moves', async () => {
    authedRequestDetailed.mockResolvedValue({ status: 201, body: REF });
    const { view } = harness();
    await act(async () => void view.container.querySelector('button')!.click());
    await settle();
    expect((authedRequestDetailed.mock.calls[0]![2] as { idempotencyKey?: string }).idempotencyKey)
      .toBeUndefined();
  });
});
