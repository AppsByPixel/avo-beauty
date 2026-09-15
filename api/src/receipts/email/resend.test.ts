/**
 * The transport adapter, driven with a stubbed `fetch`.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT. It proves this file's behaviour GIVEN a
 * response: the request it builds, the two id shapes it accepts, and every arm
 * of the transient/permanent map. It does NOT prove that Resend sends those
 * responses — reaching a live account needs an API key, and an API key must not
 * exist in this tree in any form. `resend.ts` says the same thing at the same
 * point in its own header; `images/supabase.ts` had to say it first.
 *
 * The status map is the part that carries weight. `receipts/types.ts`: a worker
 * that cannot tell the two apart "eventually treats every failure as transient,
 * which is the same as having no retry policy". Here the cost is specific — a
 * permanent failure parks the row AND writes a `risk` audit, so mis-classifying
 * an outage as permanent abandons real receipts, and mis-classifying a bad
 * address as transient burns six attempts to reach the same answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReceiptPermanentError, ReceiptTransientError } from '../types';
import { formatAddress, ResendEmailTransport } from './resend';

const KEY = 'test-key-never-a-real-one';

function transport(): ResendEmailTransport {
  return new ResendEmailTransport({
    apiKey: KEY,
    baseUrl: 'https://api.example.test',
    timeoutMs: 1_000,
  });
}

const MESSAGE = {
  from: { name: 'Amara', address: 'receipts@avo.beauty' },
  to: { name: 'Dana A.', address: 'dana@example.com' },
  subject: 'Your receipt from Amara',
  text: 'Amara — receipt',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function reply(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('the request', () => {
  it('is one POST to /emails with the bearer token and a JSON body', async () => {
    fetchMock.mockResolvedValue(reply(200, JSON.stringify({ id: 'msg-1' })));

    await transport().send(MESSAGE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.test/emails');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      from: '"Amara" <receipts@avo.beauty>',
      to: ['dana@example.com'],
      subject: 'Your receipt from Amara',
      text: 'Amara — receipt',
    });
    /** No HTML part exists to send — compose.ts carries why. */
    expect(body).not.toHaveProperty('html');
  });

  it('trims a trailing slash off the configured base rather than sending //emails', async () => {
    fetchMock.mockResolvedValue(reply(200, '{"id":"x"}'));
    await new ResendEmailTransport({
      apiKey: KEY,
      baseUrl: 'https://api.example.test/',
      timeoutMs: 1_000,
    }).send(MESSAGE);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.test/emails');
  });

  it('aborts rather than leaving a socket open behind a caller that gave up', async () => {
    fetchMock.mockResolvedValue(reply(200, '{"id":"x"}'));
    await transport().send(MESSAGE);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('the display name, which is merchant-supplied free text', () => {
  /**
   * A salon called "Amara, Salmiya" interpolated raw makes `Amara, Salmiya
   * <addr>` parse as TWO addresses, the second of which is a bare word. Every
   * receipt for that salon would then be refused — permanently, per the status
   * map below — by a comma in a name the merchant typed herself.
   */
  it('quotes a name containing a comma', () => {
    expect(formatAddress('Amara, Salmiya', 'r@avo.beauty')).toBe(
      '"Amara, Salmiya" <r@avo.beauty>',
    );
  });

  it('escapes a quote and a backslash rather than closing the quoted string early', () => {
    expect(formatAddress('The "Best" Salon', 'r@avo.beauty')).toBe(
      '"The \\"Best\\" Salon" <r@avo.beauty>',
    );
    expect(formatAddress('A\\B', 'r@avo.beauty')).toBe('"A\\\\B" <r@avo.beauty>');
  });

  /** A newline in a header value is header injection. There is no correct rendering of one. */
  it('strips control characters instead of escaping them', () => {
    expect(formatAddress('Amara\r\nBcc: someone@else.test', 'r@avo.beauty')).toBe(
      '"Amara  Bcc: someone@else.test" <r@avo.beauty>',
    );
  });

  it('falls back to the bare address when the name reduces to nothing', () => {
    expect(formatAddress('   ', 'r@avo.beauty')).toBe('r@avo.beauty');
  });
});

describe('the response', () => {
  it('takes the id from the documented top-level shape', async () => {
    fetchMock.mockResolvedValue(reply(200, JSON.stringify({ id: 'msg-42' })));
    await expect(transport().send(MESSAGE)).resolves.toEqual({ providerReference: 'msg-42' });
  });

  /**
   * The older nested shape. A transport that insisted on one of the two would
   * turn a SUCCESSFUL send into a throw, and the worker would then retry a
   * message the customer has already received — the one failure worse than not
   * sending, because it cannot be undone.
   */
  it('takes the id from the older nested shape too', async () => {
    fetchMock.mockResolvedValue(reply(200, JSON.stringify({ data: { id: 'msg-43' } })));
    await expect(transport().send(MESSAGE)).resolves.toEqual({ providerReference: 'msg-43' });
  });

  it('accepts a success with no id at all rather than retrying a delivered message', async () => {
    fetchMock.mockResolvedValue(reply(202, ''));
    await expect(transport().send(MESSAGE)).resolves.toEqual({ providerReference: 'accepted' });
  });
});

describe('the status map, which is what the queue actually runs on', () => {
  const transient = [408, 429, 500, 502, 503, 504];
  for (const status of transient) {
    it(`${status} is TRANSIENT — the queue's backoff is what this is for`, async () => {
      fetchMock.mockResolvedValue(reply(status, 'busy'));
      await expect(transport().send(MESSAGE)).rejects.toBeInstanceOf(ReceiptTransientError);
    });
  }

  const permanent = [400, 401, 403, 404, 422];
  for (const status of permanent) {
    it(`${status} is PERMANENT — retrying reaches the same answer six times`, async () => {
      fetchMock.mockResolvedValue(reply(status, 'nope'));
      await expect(transport().send(MESSAGE)).rejects.toBeInstanceOf(ReceiptPermanentError);
    });
  }

  /**
   * A DNS failure, a reset connection and an `AbortSignal.timeout` all land in
   * the same catch, and none is evidence that this message can never send.
   */
  it('a network failure is TRANSIENT and keeps the cause', async () => {
    const cause = new TypeError('fetch failed');
    fetchMock.mockRejectedValue(cause);
    const err = await transport().send(MESSAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReceiptTransientError);
    expect((err as Error).cause).toBe(cause);
  });

  it('a timeout is TRANSIENT', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted.', 'TimeoutError'));
    await expect(transport().send(MESSAGE)).rejects.toBeInstanceOf(ReceiptTransientError);
  });
});

describe('the key', () => {
  /**
   * `last_error` is written to `receipt_job` and read out of it by whoever
   * investigates a parked receipt, so an error message is a place a credential
   * can be persisted. `gateway/myfatoorah.ts`: "the whole thing in a log line is
   * how an API key ends up in a log line."
   */
  it('is never in an error message, for any status or any body', async () => {
    for (const status of [400, 401, 500]) {
      fetchMock.mockResolvedValue(
        reply(status, JSON.stringify({ message: 'failed', echoed: KEY })),
      );
      const err = await transport().send(MESSAGE).catch((e: unknown) => e);
      expect((err as Error).message).not.toContain(KEY);
    }
  });

  it('is never in the message of a network failure either', async () => {
    fetchMock.mockRejectedValue(new Error(`connect failed using ${KEY}`));
    const err = await transport().send(MESSAGE).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(KEY);
  });

  /**
   * The body is truncated, so a provider that echoes a long request — and some
   * do, on a 400 — cannot put the whole message, addresses included, into a
   * column that is read by support.
   */
  it('cannot put an unbounded provider body into last_error', async () => {
    fetchMock.mockResolvedValue(reply(400, 'x'.repeat(5_000)));
    const err = await transport().send(MESSAGE).catch((e: unknown) => e);
    expect((err as Error).message.length).toBeLessThan(400);
  });
});
