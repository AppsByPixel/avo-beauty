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
  BoostSchema,
  BranchSchema,
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
  /**
   * NULL WHEN THE PROMOTIONS READ FAILED AND THE REST OF THE LOAD DID NOT.
   *
   * Promotions are the one part of this snapshot Home can render without — see
   * `useWalletHome § loadSnapshot`. A snapshot cached before this field became
   * nullable still parses, so nothing has to be invalidated.
   */
  promotions: PromotionSet | null;
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
    // `.nullable()` and not `.optional()`: a cache entry that FORGOT the key
    // must fail to parse and be discarded, exactly as every other field here.
    promotions: PromotionSetSchema.nullable(),
  }),
  fetchedAt: z.number().int().positive(),
});

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * A SALON CACHED BEFORE MIGRATION 0063 — THE UPGRADE-DAY HAZARD.
 *
 * 0063 made `BranchSchema` require `businessHours` + `businessHoursSource`.
 * Every customer who updates the app has a snapshot on the device written by
 * the previous version, whose branches carry `{ id, salonId, name, nameAr }`
 * and nothing else. Parsed strictly, that snapshot fails — every one of them,
 * on the day they update.
 *
 * FAILING TO PARSE NEVER CRASHES HOME. `readSnapshot` returns null, Home goes
 * to its skeletons and the live read replaces it — "refetch", not an error
 * screen. That was already the contract, and it still holds for a cache this
 * function cannot read at all (pinned in `cacheUpgrade.test.tsx`).
 *
 * BUT THIS ONE SHAPE IS UPGRADED RATHER THAN DISCARDED, because discarding it
 * has a real cost on exactly that day: a customer who opens the new version
 * OFFLINE would get the cold failure screen — no balance, no code — where the
 * old version showed her last-known wallet. And the upgrade invents nothing:
 * before 0063 a branch had no hours of its own, so its RESOLVED hours were the
 * salon's (`api/src/services/branchHours.ts § resolveBranchHours` — branch
 * NULL → the salon's, `businessHoursSource: 'salon'`). The salon's
 * `businessHours` is in the same cached body and has been required all along.
 * So the filled-in value is precisely what the server would have served for
 * that snapshot. The member, the balance and the transactions are parsed as
 * strictly as ever — this relaxes the two 0063 branch fields and (below) the
 * presence of 0065's `loyalty` on a transaction, nothing else, and the "a
 * balance we cannot vouch for" rule below is untouched. 0067's boost window is
 * the third upgrade, on the promotion set (below).
 *
 * A snapshot is a cache: the live read always follows and overwrites it, so a
 * branch override set since is at most as stale as every other cached field,
 * under the same "last updated" stamp.
 * ═════════════════════════════════════════════════════════════════════════════
 */
const LegacyCachedSchema = CachedSchema.extend({
  snapshot: CachedSchema.shape.snapshot.extend({
    salon: SalonSchema.extend({
      branches: z.array(
        BranchSchema.partial({ businessHours: true, businessHoursSource: true }),
      ),
    }),
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * TRANSACTIONS CACHED BEFORE MIGRATION 0065 — THE SAME HAZARD, ONE KEY.
     *
     * 0065 put `loyalty: TransactionLoyaltySchema.nullable()` on
     * `TransactionSchema`, required on the wire. A snapshot written by the
     * previous build holds transactions with no `loyalty` key at all, so read
     * strictly it fails and Home cold-starts — offline, the failure screen.
     *
     * Upgraded to `loyalty: null`, and that invents nothing: null is precisely
     * what the server now serves for those rows — `serialiseTransactionLoyalty`
     * returns null on every non-charge and on a charge from before 0065 — and
     * "nothing recorded" is exactly what the cached body knows. It is never a
     * guessed "+1 visit" (non-negotiable #2); the activity row simply says what
     * it said before. `.partial` relaxes PRESENCE only: a `loyalty` that is
     * present and malformed still fails, and every other transaction field is
     * as strict as ever.
     * ═════════════════════════════════════════════════════════════════════════
     */
    transactions: z.array(TransactionSchema.partial({ loyalty: true })),
    /**
     * ═════════════════════════════════════════════════════════════════════════
     * BOOSTS CACHED BEFORE MIGRATION 0067 — THE SAME HAZARD, FOUR KEYS.
     *
     * 0067 put `startsAt`, `endsAt`, `stoppedAt` and `stoppedBy` on
     * `BoostSchema`, required on the wire and nullable (trunk 7646bb8). A
     * snapshot written by the previous build holds boosts of `{ visit, topup,
     * stamp }` alone, so read strictly the whole snapshot fails and Home
     * cold-starts — offline, the failure screen.
     *
     * Upgraded to `null` on each, and that invents nothing: a boost from before
     * 0067 had no window and could not be stopped, and null/null/null/null is
     * precisely what the server serves for such a row — running, unbounded,
     * never stopped. `BranchEarning` resolves it with `isBoostLive` exactly as
     * it would the live read's. `.partial` relaxes PRESENCE only: a window that
     * is present and malformed still fails, and `visit`/`topup`/`stamp` are as
     * strict as ever.
     * ═════════════════════════════════════════════════════════════════════════
     */
    promotions: PromotionSetSchema.extend({
      boosts: z.record(
        z.string(),
        BoostSchema.partial({ startsAt: true, endsAt: true, stoppedAt: true, stoppedBy: true }),
      ),
    }).nullable(),
  }),
});

function upgradeLegacy(cached: z.infer<typeof LegacyCachedSchema>): CachedSnapshot {
  const { salon, transactions, promotions } = cached.snapshot;
  return {
    ...cached,
    snapshot: {
      ...cached.snapshot,
      salon: {
        ...salon,
        branches: salon.branches.map((b) => ({
          ...b,
          businessHours: b.businessHours ?? salon.businessHours,
          businessHoursSource: b.businessHoursSource ?? 'salon',
        })),
      },
      transactions: transactions.map((t) => ({ ...t, loyalty: t.loyalty ?? null })),
      promotions:
        promotions === null
          ? null
          : {
              ...promotions,
              boosts: Object.fromEntries(
                Object.entries(promotions.boosts).map(([branchId, b]) => [
                  branchId,
                  {
                    ...b,
                    startsAt: b.startsAt ?? null,
                    endsAt: b.endsAt ?? null,
                    stoppedAt: b.stoppedAt ?? null,
                    stoppedBy: b.stoppedBy ?? null,
                  },
                ]),
              ),
            },
    },
  } as CachedSnapshot;
}

/**
 * The stored body, or null for "nothing usable — refetch". Exported so the
 * upgrade specs can hand it a pre-0063 / pre-0065 / pre-0067 body without a
 * storage double.
 */
export function parseSnapshot(raw: unknown): CachedSnapshot | null {
  const parsed = CachedSchema.safeParse(raw);
  if (parsed.success) return parsed.data as CachedSnapshot;
  // One legacy schema for every upgrade, so a snapshot from before 0063, 0065
  // AND 0067 — a device that skipped releases — upgrades in one pass.
  const legacy = LegacyCachedSchema.safeParse(raw);
  if (legacy.success) return upgradeLegacy(legacy.data);
  // A snapshot written by an older contract is discarded rather than coerced:
  // showing a customer a balance we cannot vouch for is worse than showing none.
  return null;
}

/**
 * Whose wallet, at which workspace. The session's half that is not a secret —
 * `api/session.ts § sessionOwner`.
 */
export interface SnapshotOwner {
  salonId: string;
  memberId: string;
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE KEY, AND IT IS CHECKED AGAINST THE SESSION RATHER THAN SCOPED BY SALON.
 *
 * One wallet app serves every workspace now, so a phone can hold a session at
 * Forest while `avo.wallet.home.v1` still holds her Amara wallet — a session that
 * EXPIRED does not clear it (that is what keeps the offline Home reachable), so
 * the next sign-in can be somewhere else entirely. Seeded as it was, Home would
 * paint Amara's balance, activity and tier card for the length of the first
 * read.
 *
 * Two ways out were on the table: a key per salon, or one key that is cleared on
 * a workspace change and refused when it is not hers. This is the second, on
 * purpose. A key per salon keeps every workspace's balance and activity on the
 * phone after she has left it, which is the one thing a sign-out exists to stop;
 * one wallet is on screen at a time, so one cached wallet is all that is needed.
 *
 *   - `discardSnapshotNotOwnedBy` runs at every sign-in and sign-up
 *     (`state/workspace.ts`) and drops a snapshot that is not the new session's.
 *   - `readSnapshot(owner)` refuses one anyway — the member AND the salon must be
 *     the session's — so a path that forgets the first still cannot show it.
 *
 * `owner` null means "no session to check against" and skips the check. The
 * wallet is only mounted signed in, so that is a spec with no session; it is
 * not a path the app takes.
 * ═════════════════════════════════════════════════════════════════════════════
 */
export function ownedBy(snapshot: WalletSnapshot, owner: SnapshotOwner): boolean {
  return (
    snapshot.member.id === owner.memberId &&
    snapshot.member.salonId === owner.salonId &&
    snapshot.salon.id === owner.salonId
  );
}

export async function readSnapshot(owner: SnapshotOwner | null = null): Promise<CachedSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    const cached = parseSnapshot(JSON.parse(raw));
    if (cached && owner && !ownedBy(cached.snapshot, owner)) return null;
    return cached;
  } catch {
    return null;
  }
}

/** Drop the cached wallet unless it is this session's. See `ownedBy`. */
export async function discardSnapshotNotOwnedBy(owner: SnapshotOwner): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return;
    const cached = parseSnapshot(JSON.parse(raw));
    if (cached && ownedBy(cached.snapshot, owner)) return;
    await AsyncStorage.removeItem(KEY);
  } catch {
    // `readSnapshot(owner)` still refuses it; nothing else to do.
  }
}

export async function writeSnapshot(snapshot: WalletSnapshot, fetchedAt: number): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify({ snapshot, fetchedAt }));
  } catch {
    // A cache write failing must never break a screen that already has its data.
  }
}
