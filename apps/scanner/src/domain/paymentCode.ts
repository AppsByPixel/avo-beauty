/**
 * The QR payload, parsed.
 *
 * The wallet mints `avo://pay?m={memberId}&t={token}` through
 * `walletTokenUri()` in @avo/types. This is the other half of that function and
 * it is deliberately strict: a camera pointed at a counter reads receipts,
 * loyalty cards, product barcodes and other salons' codes, and every one of
 * those must be refused rather than sent to `POST /scans` to find out.
 *
 * The member id in the URI is NOT trusted as the thing to charge. It is only
 * used to notice a mismatch. The member charged is the one the server returns
 * from resolving the token, because the token is the credential and the `m`
 * parameter is a convenience a forger could set to anything.
 */

export interface PaymentCode {
  memberId: string;
  token: string;
}

const SCHEME = 'avo://pay';

/**
 * Parse a scanned string. Returns null for anything that is not an AVO payment
 * code — the caller shows "That isn't an AVO wallet code" and keeps scanning.
 */
export function parsePaymentCode(raw: string): PaymentCode | null {
  const value = raw.trim();
  if (!value.toLowerCase().startsWith(SCHEME)) return null;

  const queryStart = value.indexOf('?');
  if (queryStart === -1) return null;

  // Hand-parsed rather than via URL: React Native's URL polyfill does not
  // reliably expose searchParams for a custom scheme, and a QR payload is a
  // flat query string anyway.
  const params = new Map<string, string>();
  for (const pair of value.slice(queryStart + 1).split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    const val = pair.slice(eq + 1);
    try {
      params.set(decodeURIComponent(key), decodeURIComponent(val));
    } catch {
      // A malformed percent-escape is a code we cannot read, not a crash.
      return null;
    }
  }

  const memberId = params.get('m');
  const token = params.get('t');
  if (!memberId || !token) return null;

  return { memberId, token };
}
