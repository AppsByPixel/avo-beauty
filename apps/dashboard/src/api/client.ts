import { API_BASE_URL } from '../config.js';

/**
 * A failure that carries enough for the UI to tell "we failed" (retry) apart
 * from "you can't do that" (explain) — interaction-spec.md §4.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** No response at all: DNS, CORS, the laptop's wifi. Distinct from a 5xx. */
  readonly offline: boolean;
  /**
   * WHATEVER ELSE THE ERROR BODY CARRIED, kept rather than thrown away.
   *
   * Most refusals in this API are a `{ error, message }` pair and the message is
   * the whole of what a user needs. The image endpoints are the first that
   * attach machine-readable facts to a refusal — `image_too_large` carries
   * `maxBytes`, `unsupported_image_type` carries `accepted`,
   * `content_type_mismatch` carries `declared` and `actual` — and
   * `api/src/routes/images.ts` puts them there so a client can act on the limit
   * "with a number it did not hard-code". Dropping them here made that
   * impossible and nothing noticed, because nothing had asked yet.
   *
   * READ IT, NEVER RENDER IT RAW. The sentence a merchant sees is still
   * `message`, server-authored. These are for decisions.
   */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    opts: {
      status: number;
      code: string;
      offline?: boolean;
      details?: Record<string, unknown>;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.offline = opts.offline ?? false;
    this.details = opts.details ?? {};
  }

  /**
   * 401 — WHO is calling is the problem. The credential is missing, expired
   * past refresh, or revoked. `authedRequest` has already tried to rotate and
   * has already dropped the session by the time this reaches a component, so
   * the screen's job is to get out of the way and let the shell redirect to
   * sign-in. There is nothing to explain and nothing to retry.
   */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /**
   * 403 — WHAT was asked for is the problem. The session is perfectly valid;
   * this staff member lacks the permission, or the thing belongs to another
   * salon ("That salon is not yours."). This is the *explain, no retry* case of
   * interaction-spec.md §4: an identical request produces an identical refusal,
   * so offering a retry button is a lie about what the user can do. The
   * `message` is server-authored copy naming who can grant the permission —
   * render it rather than inventing one.
   */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** The connection-style failures the wallet and dashboard both treat as offline. */
  get isConnectivity(): boolean {
    return this.offline || this.status === 503 || this.status === 0;
  }
}

/**
 * `x-avo-scenario` passthrough. The mock serves loading/empty/error/offline
 * behind this header; putting `?scenario=empty` in the dashboard URL drives the
 * whole app through that state so the four states get built and *reviewed*
 * alongside the happy path rather than after it.
 *
 * Pinned once seen: the router drops search params it does not know about, and
 * a scenario that evaporated on the first client-side navigation would be worse
 * than useless for reviewing a state. Clearing it is a reload.
 */
let pinnedScenario: string | null = null;

function scenarioHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const fromUrl = new URLSearchParams(window.location.search).get('scenario');
  if (fromUrl) pinnedScenario = fromUrl;
  return pinnedScenario ? { 'x-avo-scenario': pinnedScenario } : {};
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Bearer token for the active session. */
  token?: string | null;
  /**
   * Non-negotiable #4. Required on every money-moving POST. Typed here so a
   * future charge/top-up/void call cannot be written without one.
   */
  idempotencyKey?: string;
  /**
   * A FILE, SENT AS ITSELF. `POST /v1/salons/{id}/products/{pid}/image` takes the
   * raw bytes as the body with the file's own media type in `Content-Type` —
   * not multipart, not base64. `api/src/routes/images.ts` states the reasons; the
   * one that lands here is that the dashboard sends the `File` straight from the
   * input and builds no form.
   *
   * MUTUALLY EXCLUSIVE WITH `body`, which JSON-encodes. Passing both is a
   * programming error and the two branches below cannot both apply.
   */
  raw?: { body: BodyInit; contentType: string };
  /**
   * What the SUCCESS body is. `json` (the default) parses; `blob` hands back the
   * bytes, which is how an authenticated image is read — see `productImage.ts`.
   * An ERROR body is always read as JSON regardless: this API's refusals are
   * `{ error, message }` on every route including the byte ones.
   */
  expect?: 'json' | 'blob';
}

/**
 * A response with the status still attached.
 *
 * `POST … /image` answers **201 when the slot was empty and 200 when it replaced
 * an existing image**, and `api/src/routes/images.ts` says why in as many words:
 * "the dashboard needs it to choose between 'added' and 'changed' in its own
 * toast." `request` returns only the parsed body, so that distinction died at
 * this boundary until there was something here to carry it.
 */
export interface Detailed<T> {
  status: number;
  body: T;
}

/**
 * ABSOLUTE URLS, AND THE BEARER IS NOT SENT TO STRANGERS.
 *
 * Every other call in this client is a path against `API_BASE_URL`. `ImageRef.url`
 * is different: it is absolute, minted server-side from `PUBLIC_BASE_URL`
 * (`api/src/services/imageAttachment.ts` § imageUrl), and it is what the product
 * row holds. So this function accepts either.
 *
 * That opens a door and it is closed here rather than trusted shut. A URL that
 * arrives in a response body is data, and attaching the session's bearer to an
 * arbitrary origin because a server asked us to would hand the token to whoever
 * that origin belongs to. So a cross-origin absolute URL is REFUSED before the
 * fetch — not silently downgraded to an anonymous request, which would answer 401
 * and read as an expired session.
 */
function resolveUrl(path: string, token: string | null | undefined): string {
  if (!/^https?:\/\//i.test(path)) return `${API_BASE_URL}${path}`;
  if (!token) return path;

  let target: URL;
  let base: URL;
  try {
    target = new URL(path);
    base = new URL(API_BASE_URL, globalThis.location?.href ?? 'http://localhost');
  } catch {
    throw new ApiError('That link could not be read.', { status: 0, code: 'bad_url' });
  }
  if (target.origin !== base.origin) {
    throw new ApiError('That link points somewhere we will not send your session.', {
      status: 0,
      code: 'foreign_origin',
    });
  }
  return target.toString();
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await requestDetailed<T>(path, options)).body;
}

export async function requestDetailed<T>(
  path: string,
  options: RequestOptions = {},
): Promise<Detailed<T>> {
  const { method = 'GET', body, raw, signal, token, idempotencyKey, expect = 'json' } = options;

  const headers: Record<string, string> = {
    Accept: expect === 'blob' ? 'image/*' : 'application/json',
    ...scenarioHeader(),
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (raw) headers['Content-Type'] = raw.contentType;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const url = resolveUrl(path, token);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      ...(raw ? { body: raw.body } : body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('No connection to the workspace.', {
      status: 0,
      code: 'network_error',
      offline: true,
    });
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
      [key: string]: unknown;
    } | null;
    const { error, message, ...details } = payload ?? {};
    throw new ApiError(message ?? response.statusText, {
      status: response.status,
      code: error ?? 'http_error',
      details,
    });
  }

  if (response.status === 204) return { status: response.status, body: undefined as T };
  if (expect === 'blob') return { status: response.status, body: (await response.blob()) as T };
  return { status: response.status, body: (await response.json()) as T };
}
