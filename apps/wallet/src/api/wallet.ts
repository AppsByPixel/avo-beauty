/**
 * The endpoints the Home screen reads. Shapes come from @avo/types, which is
 * generated from design/api-contract.md — this file adds no shapes of its own.
 */

import {
  MemberSchema,
  PromotionSetSchema,
  SalonSchema,
  TransactionSchema,
  WalletTokenSchema,
  paginated,
} from '@avo/types';
import type { Member, PromotionSet, Salon, Transaction, WalletToken } from '@avo/types';
import { getJson } from './client';

const TransactionPageSchema = paginated(TransactionSchema);

export function getMember(signal?: AbortSignal): Promise<Member> {
  return getJson('/members/me', MemberSchema, signal);
}

export async function getTransactions(signal?: AbortSignal): Promise<Transaction[]> {
  const page = await getJson('/members/me/transactions', TransactionPageSchema, signal);
  return page.items;
}

export function getSalon(salonId: string, signal?: AbortSignal): Promise<Salon> {
  return getJson(`/salons/${encodeURIComponent(salonId)}`, SalonSchema, signal);
}

export function getPromotions(salonId: string, signal?: AbortSignal): Promise<PromotionSet> {
  return getJson(`/v1/salons/${encodeURIComponent(salonId)}/promotions`, PromotionSetSchema, signal);
}

/**
 * The QR token. Non-negotiable #2: server-minted, single-use, 45s life. The
 * client asks for one and counts down to `expiresAt` — it never mints, extends
 * or reuses a token, and the countdown is cosmetic.
 *
 * `uri` — the `avostaff://pay?m=…&t=…` string the QR encodes — is the server's too,
 * and PaymentCode renders it verbatim. This comment used to say the field was
 * ignored "so the client is not depending on a field the real API need not
 * send". That reasoning was wrong twice over: both the mock and
 * api/src/routes/members.ts have always sent it, and the contract was silently
 * stripping it, so the claim could not be checked. Re-deriving the format is
 * not independence from the server — it is a second opinion about how a bearer
 * credential is written, held by the half of the system that does not mint it.
 */
export function getWalletToken(signal?: AbortSignal): Promise<WalletToken> {
  return getJson('/members/me/wallet-token', WalletTokenSchema, signal);
}
