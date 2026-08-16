/**
 * `POST /scans` — a scanned code resolved to the member card the scanner shows.
 *
 * It does NOT consume the token. Consumption happens inside the charge
 * transaction (api/src/routes/staff.ts:236, api/src/services/charge.ts), which
 * is what lets an artist re-read a code while she confirms the services without
 * burning it.
 */

import { z } from 'zod';
import { FilsSchema, IdSchema, MemberSchema } from '@avo/types';
import { postJson } from './client';

export const ScanServiceSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  priceFils: FilsSchema.nonnegative(),
});

export const ScanResultSchema = z.object({
  member: MemberSchema,
  /**
   * A deposit already held against a booking. It is applied automatically as a
   * credit line on the charge — design/AVO Staff Scanner.dc.html:354, and
   * §Charging in api-contract.md.
   */
  heldDepositFils: FilsSchema.nonnegative(),
  services: z.array(ScanServiceSchema),
});

export type ScanService = z.infer<typeof ScanServiceSchema>;
export type ScanResult = z.infer<typeof ScanResultSchema>;

export function resolveScan(
  token: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ScanResult> {
  return postJson('/scans', { token }, ScanResultSchema, accessToken, signal);
}
