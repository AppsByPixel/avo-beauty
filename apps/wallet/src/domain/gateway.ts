/**
 * What happened when we tried to put the payment page in front of her.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS MODULE EXISTS BECAUSE THE OLD ONE SWALLOWED THE ANSWER.
 *
 * `platform/gateway.ts` used to open the gateway like this:
 *
 *     void Linking.openURL(redirectUrl).catch(() => undefined);
 *
 * — on the one path by which money enters the product. A failed open produced no
 * error, no log, no state: the sheet sat on its NOT-DISMISSIBLE redirect screen
 * with three animated dots while the poll re-read an intent that would never
 * move off `redirected`, and the customer was left holding a screen she could not
 * close over a payment page she had never seen.
 *
 * A swallowed rejection is not a small omission here. It converts a diagnosable
 * failure ("nothing on this device would open that URL") into a mystery, and the
 * mystery is what the lane was handed.
 *
 * So the open now REPORTS. This module is the vocabulary it reports in, and it is
 * pure — it imports nothing, so it can be tested in the node suite the way
 * `brightness.ts` and `loadFailure.ts` are.
 * ═════════════════════════════════════════════════════════════════════════════
 */

/**
 * Why the page would not open. Four reasons, and the split is diagnostic rather
 * than customer-facing: she sees ONE screen (see `copy.gatewayFailed*`), because
 * "the popup was blocked" and "no app can open knet://" are the same problem to
 * her and the same next action. The reason is what reaches the console and the
 * support reference, and it is the difference between a bug report that can be
 * acted on and the one this lane was given.
 */
export type GatewayOpenFailureReason =
  /** The browser refused the window — a popup blocker, on web. */
  | 'blocked'
  /** A payment page is already up. Opening a second would orphan the first. */
  | 'busy'
  /** Nothing on the device will open that URL at all. */
  | 'unavailable'
  /** Anything else. Named rather than dropped — that is the whole point. */
  | 'error';

export interface GatewayOpenFailure {
  reason: GatewayOpenFailureReason;
  /** The underlying message, for the console and for support. Never shown raw. */
  detail: string;
}

/**
 * The result of asking a platform to show the gateway.
 *
 * A discriminated union rather than a boolean plus an optional error, so that
 * "it failed" without a reason does not type-check — the same argument
 * `useTopUp`'s stage union makes about screens and their data.
 */
export type GatewayOpen =
  | { opened: true }
  | ({ opened: false } & GatewayOpenFailure);

/**
 * A live gateway visit, from the platform layer's point of view.
 *
 * Declared HERE rather than twice in the two platform files, so the web and
 * native implementations cannot drift into two different contracts for the same
 * import path. `screenBoost` shares its core the same way, through
 * `brightness.ts`; this module is the equivalent for the gateway.
 */
export interface GatewaySession {
  /**
   * Resolves the first time it looks as though the customer has come back.
   * A HINT and never a result — `useTopUp` re-reads GET /topups/{id} either way.
   * One-shot.
   */
  returned: Promise<void>;
  /** Stop watching, and take the page down if it is still up. Idempotent. */
  dispose(): void;
}

/** Either a live session to watch, or a named reason there is not one. */
export type GatewayHandoff =
  | { opened: true; session: GatewaySession }
  | Extract<GatewayOpen, { opened: false }>;

/**
 * Whether a redirect URL is one an in-app browser session can be handed at all.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THIS GUARD IS NOT DEFENSIVE PROGRAMMING. IT WAS FOUND BY CRASHING THE APP.
 *
 * `ASWebAuthenticationSession` accepts http and https and NOTHING else, and it
 * refuses in the one way JavaScript cannot survive — an Objective-C exception,
 * raised inside `-[SFSafariViewController initWithURL:configuration:]`, which
 * `expo-web-browser` does not turn into a rejected promise. Driven on an iPhone 17
 * simulator with the API's `PUBLIC_BASE_URL` pointed at a custom scheme:
 *
 *   *** Terminating app due to uncaught exception 'NSInvalidArgumentException',
 *   reason: 'The specified URL has an unsupported scheme. Only HTTP and HTTPS
 *   URLs are supported.'
 *
 * The wallet did not show a failure. It did not show the old swallowed silence
 * either. It DIED, mid top-up, with an intent open on the server — which is a
 * worse outcome than the bug this lane was sent to fix, and no `try`/`catch`
 * around the call can help because the throw never reaches JS.
 *
 * So the scheme is checked HERE, before the call, where a wrong answer is a
 * screen instead of a crash. A processor that hands back `knet://` or an
 * app-link is not hypothetical — it is how several regional gateways return to
 * a mobile client — and `redirectUrl` is a server-supplied string, so the client
 * cannot assume it.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Returns the failure to report, or `null` when the URL is safe to open.
 */
export function unsupportedScheme(url: string): (GatewayOpen & { opened: false }) | null {
  const scheme = schemeOf(url);
  if (scheme === 'http' || scheme === 'https') return null;
  return {
    opened: false,
    reason: 'unavailable',
    detail:
      `redirectUrl scheme ${scheme === null ? '(unparseable)' : `"${scheme}"`} ` +
      'cannot be opened in an in-app browser session; only http and https can.',
  };
}

/** Lower-cased scheme, or null when the string is not a URL at all. */
function schemeOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  return match?.[1]?.toLowerCase() ?? null;
}

/** The empty string is not a detail. Keeps `detail` worth printing. */
const NO_DETAIL = 'no detail given';

/**
 * Turn whatever a platform threw into a named failure.
 *
 * NEVER THROWS AND NEVER RETURNS UNDEFINED. Every input, including `undefined`,
 * `null` and a string, comes back as a `GatewayOpen` with a reason — because the
 * one behaviour this replaces is a `catch` that produced nothing at all.
 *
 * The matching is on message text, which is unlovely and is stated here rather
 * than hidden: neither `expo-web-browser` nor `Linking` exports a stable code for
 * these, so the alternative is to call every one of them `error`. Text that stops
 * matching degrades to `error`, which is still a named, shown, logged failure —
 * so the degradation is a worse diagnostic, not a lost one.
 */
export function classifyOpenFailure(err: unknown): GatewayOpen & { opened: false } {
  const detail = messageOf(err);
  const text = detail.toLowerCase();

  // expo-web-browser: a second `openAuthSessionAsync` while one is presented.
  if (
    text.includes('already') &&
    (text.includes('presented') || text.includes('open') || text.includes('progress'))
  ) {
    return { opened: false, reason: 'busy', detail };
  }
  // Linking / WebBrowser with nothing registered for the scheme.
  if (
    text.includes('no handler') ||
    text.includes('unsupported url') ||
    text.includes('could not open') ||
    text.includes('no activity found') ||
    text.includes('activitynotfound')
  ) {
    return { opened: false, reason: 'unavailable', detail };
  }
  if (text.includes('blocked') || text.includes('popup')) {
    return { opened: false, reason: 'blocked', detail };
  }
  return { opened: false, reason: 'error', detail };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message || NO_DETAIL;
  if (typeof err === 'string') return err || NO_DETAIL;
  if (err === null || err === undefined) return NO_DETAIL;
  try {
    const text = JSON.stringify(err);
    return text === undefined || text === '{}' ? NO_DETAIL : text;
  } catch {
    return NO_DETAIL;
  }
}

/**
 * The line that goes to the console when an open fails.
 *
 * It carries the intent id, because the failure leaves a real `TI-…` row on the
 * server that the customer never saw a page for, and the first question anyone
 * asks about a stuck top-up is which intent it was.
 */
export function gatewayOpenLog(intentId: string, failure: GatewayOpenFailure): string {
  return (
    `[avo] the payment page would not open for ${intentId} ` +
    `(${failure.reason}: ${failure.detail}). ` +
    'The intent exists server-side and was NOT charged; retrying re-opens the same one. ' +
    'See platform/gateway.ts.'
  );
}
