/**
 * Last-known wallet snapshot.
 *
 * interaction-spec.md §4: offline keeps the wallet card visible with the
 * last-known balance and a clear "last updated" stamp. That only works if the
 * snapshot outlives the process, so it is written to storage on every good load.
 *
 * This is a CACHE, not a ledger. Nothing here is ever used to compute a new
 * balance, and nothing writes to it except a successful server read —
 * non-negotiable #2, the server owns the balance.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';
import {
  MemberSchema,
  PromotionSetSchema,
  SalonSchema,
  TransactionSchema,
} from '@avo/types';
import type { Member, PromotionSet, Salon, Transaction } from '@avo/types';

/** Exported so log-out can drop it without restating the string. */
export const SNAPSHOT_KEY = 'avo.wallet.home.v1';
const KEY = SNAPSHOT_KEY;

export interface WalletSnapshot {
  member: Member;
  salon: Salon;
  transactions: Transaction[];
  promotions: PromotionSet;
}

export interface CachedSnapshot {
  snapshot: WalletSnapshot;
  /** Epoch ms of the server read this came from. Drives "Last updated …". */
  fetchedAt: number;
}

const CachedSchema = z.object({
  snapshot: z.object({
    member: MemberSchema,
    salon: SalonSchema,
    transactions: z.array(TransactionSchema),
    promotions: PromotionSetSchema,
  }),
  fetchedAt: z.number().int().positive(),
});

export async function readSnapshot(): Promise<CachedSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = CachedSchema.safeParse(JSON.parse(raw));
    // A snapshot written by an older contract is discarded rather than coerced:
    // showing a customer a balance we cannot vouch for is worse than showing none.
    return parsed.success ? (parsed.data as CachedSnapshot) : null;
  } catch {
    return null;
  }
}

export async function writeSnapshot(snapshot: WalletSnapshot, fetchedAt: number): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ snapshot, fetchedAt }));
  } catch {
    // A cache write failing must never break a screen that already has its data.
  }
}
