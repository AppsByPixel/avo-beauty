/**
 * The HTTP boundary.
 *
 * Two jobs beyond fetching:
 *
 * 1. Every response is parsed through the zod schema from @avo/types before it
 *    reaches a screen. A float where fils are expected is a contract violation,
 *    and the place to catch it is here, not in a component reading `.toFixed()`.
 *
 * 2. Failures are classified into the three kinds interaction-spec.md §4 asks a
 *    screen to tell apart: we failed (retry), you can't (explain, no retry), and
 *    no connection (keep the last-known data, stamp it).
 */

import type { z } from 'zod';
import { scenarioHeader } from './scenario';

export const API_BASE_URL = 'http://localhost:4000';

/** Timeout past which we treat the request as a connection failure, not a 500. */
const REQUEST_TIMEOUT_MS = 15_000;

export type FailureKind =
  /** 5xx or a malformed payload. Our fault, so the screen offers Try again. */
  | 'server'
  /** 401/403. The customer retrying will not help — explain instead. */
  | 'forbidden'
  /** 503, DNS failure, timeout, the device being on a plane. */
  | 'offline';

export class ApiError extends Error {
  readonly kind: FailureKind;
  /** Shown on the error screen so support can find the request. */
  readonly reference: string;
  readonly status: number | null;

  constructor(kind: FailureKind, message: string, reference: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.reference = reference;
    this.status = status;
  }
}

/** "WLT-5502-9917" — the format the error state in AVO States.dc.html shows. */
function newReference(): string {
  const block = () => String(Math.floor(Math.random() * 9000) + 1000);
  return `WLT-${block()}-${block()}`;
}

function classify(status: number): FailureKind {
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 503 || status === 504) return 'offline';
  return 'server';
}

interface ErrorBody {
  error?: string;
  message?: string;
}

/**
 * GET a resource and validate it. `schema` is the contract; if the body does not
 * satisfy it, that is a server failure and not something to render around.
 */
export async function getJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  signal?: AbortSignal,
): Promise<z.infer<S>> {
  const reference = newReference();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'x-avo-request-id': reference,
        ...scenarioHeader(),
      },
      signal: controller.signal,
    });
  } catch {
    // fetch only rejects for transport-level problems: no route to host, DNS,
    // TLS, or our own abort. All of them mean "no connection" to a customer.
    throw new ApiError(
      'offline',
      'No connection. Showing your last update.',
      reference,
      null,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }

  if (!response.ok) {
    let body: ErrorBody = {};
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      /* a non-JSON error body is still an error; the status carries the meaning */
    }
    throw new ApiError(
      classify(response.status),
      body.message ?? 'Something went wrong.',
      reference,
      response.status,
    );
  }

  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ApiError(
      'server',
      'That response did not match the contract.',
      reference,
      response.status,
    );
  }
  return parsed.data as z.infer<S>;
}
