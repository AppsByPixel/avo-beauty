import { authedRequest } from '../auth/authedRequest.js';
import { API_BASE_URL } from '../config.js';
import { ApiError } from './client.js';

/**
 * THE DASHBOARD'S FILE DOWNLOADS, IN ONE PLACE.
 *
 * Two ways a file leaves this API, and both end in the same two steps:
 *
 *   MINT-AND-FOLLOW  `POST …/download-url` answers `{ url }`, a one-time path
 *       carrying only a token (`api/src/routes/reports.ts` § the mint). The
 *       browser then FOLLOWS it with a plain anchor and the server's
 *       `content-disposition` names and saves the file. This is the shape the
 *       Overview's analytics export uses.
 *
 *   FETCH-AND-SAVE   `downloadReportCsv` in `reports.ts` still fetches the
 *       `.csv` with the bearer and hands the bytes to an object URL. Its
 *       docblock says why it has not moved yet.
 *
 * A DIRECT ANCHOR TO A `.csv` ROUTE CANNOT WORK, and that is why both shapes
 * exist: `resolvePrincipal` reads `authorization` and nothing else, a navigation
 * cannot carry a header, and a bare `<a href=".../sales.csv">` saves a JSON 401
 * named `sales.csv`. Either the request carries the bearer (fetch) or the URL
 * carries a capability the server minted for one use (mint).
 *
 * What the two share is factored here rather than copied:
 *   - `offlineExportError` — the one sentence for "the request never arrived"
 *   - `exportErrorFrom`    — a refusal body read into an `ApiError`, the
 *                            server's `message` kept verbatim
 *   - `clickDownload`      — the anchor, appended, clicked and removed
 */

/** "The request never arrived." Same shape `client.ts` throws, so `isConnectivity` reads it. */
export function offlineExportError(): ApiError {
  return new ApiError("We can't reach the workspace.", {
    status: 0,
    code: 'offline',
    offline: true,
  });
}

/**
 * A NON-2XX FILE RESPONSE, READ INTO THE SAME ERROR EVERY OTHER CALL THROWS.
 *
 * The server's sentence is the message, verbatim — it is written for a merchant
 * and names the fix. A body that is not JSON keeps the generic sentence rather
 * than printing a stack or an HTML page onto a card.
 */
export async function exportErrorFrom(response: Response): Promise<ApiError> {
  let code = 'export_failed';
  let message = "Couldn't export the file. Try again.";
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // A non-JSON error body keeps the generic sentence.
  }
  return new ApiError(message, { status: response.status, code });
}

/**
 * Hand an href to the browser's download manager.
 *
 * `download` with no value keeps the SERVER'S filename on a same-origin link;
 * cross-origin the attribute is ignored and `content-disposition: attachment`
 * does the same job. A `filename` is passed only by the fetch-and-save path,
 * whose object URL has no header to name it.
 */
export function clickDownload(href: string, filename?: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename ?? '';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * THE MINTED PATH, RESOLVED AGAINST THE API AND NOWHERE ELSE.
 *
 * The mint answers a RELATIVE path (`/report-downloads/{token}`), and the
 * dashboard prefixes its own API origin. An absolute URL is accepted only when
 * it is that same origin: a response body is data, and following a link to
 * wherever a payload pointed would be `client.ts § resolveUrl`'s foreign-origin
 * door opened from the other side. Refused with a sentence rather than
 * followed.
 */
export function resolveMintedUrl(url: unknown): string {
  if (typeof url !== 'string' || url === '') {
    throw new ApiError("Couldn't export the file. Try again.", { status: 0, code: 'bad_download_url' });
  }
  if (url.startsWith('/') && !url.startsWith('//')) return `${API_BASE_URL}${url}`;
  let target: URL;
  let base: URL;
  try {
    target = new URL(url);
    base = new URL(API_BASE_URL, globalThis.location?.href ?? 'http://localhost');
  } catch {
    throw new ApiError("Couldn't export the file. Try again.", { status: 0, code: 'bad_download_url' });
  }
  if (target.origin !== base.origin) {
    throw new ApiError("Couldn't export the file. Try again.", { status: 0, code: 'foreign_origin' });
  }
  return target.toString();
}

/**
 * MINT, THEN FOLLOW. The whole of the click handler's network half.
 *
 * The mint goes through `authedRequest`, so a fifteen-minute access token that
 * expired over lunch rotates once and the export still works; a refusal (403,
 * 400) arrives as an `ApiError` carrying the server's own sentence, which the
 * control prints inline and verbatim.
 *
 * The link lives sixty seconds and is spent on first use, so it is minted
 * IMMEDIATELY before the anchor follows it and never stored.
 */
export async function mintAndFollow(
  mintPath: string,
  body?: Record<string, unknown>,
): Promise<void> {
  const minted = await authedRequest<{ url?: unknown }>('merchant', mintPath, {
    method: 'POST',
    ...(body ? { body } : {}),
  });
  clickDownload(resolveMintedUrl(minted?.url));
}
