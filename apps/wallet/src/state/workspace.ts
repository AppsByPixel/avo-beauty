/**
 * Entering a workspace — what a sign-in or a sign-up does to the device before
 * the wallet mounts.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * ONE APP, AND THE SIGNED-IN ACCOUNT DECIDES THE WORKSPACE AND THE THEME.
 *
 * Aftab, 2026-09-29: "different wallet themes for different workspaces … If I
 * logged in, it has the forest green themed wallet … not a separate app." The
 * salon used to be the build's (`config/salon.ts`); it is now the session's,
 * which the server names. So when a session starts, two things on the device
 * may belong to a DIFFERENT workspace from the one she just entered:
 *
 *   1. THE CACHED WALLET. `avo.wallet.home.v1` survives an expired session on
 *      purpose (the offline Home), so it can be Amara's while she signs in to
 *      Forest. It is dropped here unless it is hers at this workspace, and
 *      `readSnapshot(owner)` refuses it anyway — `cache.ts § ownedBy`.
 *   2. THE PALETTE. Boot applied the LAST workspace's hex before the first
 *      frame, which is right for the sign-in screen and wrong the moment she
 *      signs in somewhere else. If the wallet mounted in it, Home's skeleton
 *      would be Amara green until Forest's salon read landed. So the palette is
 *      switched HERE, before `onSignedIn` swaps the screen:
 *        - she picked from `choose_workspace` → that row carries the hex, so it
 *          is applied with no round trip;
 *        - one match, same workspace as last time → nothing to change;
 *        - one match, a different workspace → `GET /salons/{id}` (she has a
 *          session now, so it answers) and its hex is applied;
 *        - and if THAT read fails, the token file's default palette — never
 *          the previous workspace's. Home's own salon read corrects it.
 *
 * NOT a place that decides anything about money or the workspace itself (#2):
 * the workspace is whatever `salonId` the server put on the session, and every
 * figure still comes from the reads the wallet makes after this.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { getSalon } from '../api/wallet';
import { applyBrandColor } from '../theme/brand';
import { cacheBrandColor } from './brandCache';
import { discardSnapshotNotOwnedBy, type SnapshotOwner } from './cache';
import { lastWorkspace, rememberWorkspace, type WorkspaceIdentity } from './lastWorkspace';

export async function enterWorkspace(
  owner: SnapshotOwner,
  /** The `choose_workspace` row she picked, when she picked one. */
  picked: WorkspaceIdentity | null = null,
  signal?: AbortSignal,
): Promise<void> {
  await discardSnapshotNotOwnedBy(owner);

  if (picked !== null && picked.salonId === owner.salonId) {
    await adopt(picked);
    return;
  }

  if (lastWorkspace()?.salonId === owner.salonId) return;

  try {
    const salon = await getSalon(owner.salonId, signal);
    await adopt({
      salonId: salon.id,
      name: salon.name,
      nameAr: salon.nameAr,
      brandColor: salon.brandColor,
    });
  } catch {
    // The default palette, not the workspace she just left. See the header.
    applyBrandColor(null);
  }
}

async function adopt(ws: WorkspaceIdentity): Promise<void> {
  applyBrandColor(ws.brandColor);
  await Promise.all([cacheBrandColor(ws.brandColor), rememberWorkspace(ws)]);
}
