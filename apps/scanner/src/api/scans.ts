/**
 * `POST /scans` — a scanned code resolved to the member card the scanner shows.
 *
 * It does NOT consume the token. Consumption happens inside the charge
 * transaction (api/src/routes/staff.ts:236, api/src/services/charge.ts), which
 * is what lets an artist re-read a code while she confirms the services without
 * burning it.
 *
 * THE BODY IS DEFINED IN `counter.ts`, NOT HERE.
 * `GET /members/{id}` — the manual path's last step — returns the same body from
 * the same server-side builder. One schema for both, for the reason that file's
 * header gives: two parses of one body is how the held deposit came to be right
 * on one path and stale on the other.
 */

import { CounterEnvelopeSchema, type CounterEnvelope } from './counter';
import { postJson } from './client';

/**
 * The old names, kept as aliases so the screens and their tests read unchanged.
 * `ScanResult` is now literally the same type the lookup path produces, which is
 * the point rather than a coincidence.
 */
export {
  CounterEnvelopeSchema as ScanResultSchema,
  CounterServiceSchema as ScanServiceSchema,
} from './counter';
export type { CounterEnvelope as ScanResult, CounterService as ScanService } from './counter';

export function resolveScan(
  token: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<CounterEnvelope> {
  return postJson('/scans', { token }, CounterEnvelopeSchema, accessToken, signal);
}
