/**
 * The last workspace this phone was signed in to — its id, its name in both
 * languages, and its brand hex.
 *
 * ONE WALLET APP, MANY WORKSPACES (Aftab, 2026-09-29): "If I logged in, it has
 * the forest green themed wallet … not a separate app." So the salon is no
 * longer the build's. It is the session's, and before there is a session the
 * best honest answer to "whose sign-in screen is this?" is the workspace she
 * was last in. That is what this remembers:
 *
 *   - the sign-in screen's title (`salonName(lastWorkspace(), lang)`), and the
 *     palette Boot applies before the first frame;
 *   - the `salonId` a password-reset request carries when she cannot sign in —
 *     with nothing remembered the request goes WITHOUT one, and the server
 *     resolves the phone itself;
 *   - whether a sign-in has just CHANGED workspace, which is when the previous
 *     workspace's cached wallet and palette must go (`state/workspace.ts`).
 *
 * NOT CLEARED ON SIGN-OUT, for `brandCache.ts`'s reason: it is the phone's
 * last-used door, not her data. It holds a salon's public name and colour and
 * nothing about her.
 *
 * READ ONCE AT BOOT AND HELD IN MEMORY, so the sign-in screen can read it
 * synchronously on its first render — the same shape as `languagePreference`.
 * Imports AsyncStorage and zod only, so it does not reach `src/theme` and the
 * first-frame order `theme/brandBootOrder.test.ts` holds is unaffected.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';

export const LAST_WORKSPACE_KEY = 'avo.wallet.workspace.v1';

/** api-contract.md § Salon — `brandColor` is a six-digit hex. */
const HEX = /^#[0-9A-Fa-f]{6}$/;

const WorkspaceIdentitySchema = z.object({
  salonId: z.string().min(1),
  name: z.string().min(1),
  nameAr: z.string().min(1).nullable(),
  brandColor: z.string().regex(HEX),
});

export type WorkspaceIdentity = z.infer<typeof WorkspaceIdentitySchema>;

let remembered: WorkspaceIdentity | null = null;

/** Synchronous — whatever Boot read, or the last sign-in wrote. */
export function lastWorkspace(): WorkspaceIdentity | null {
  return remembered;
}

/** Boot's read. Storage is not a trusted channel, so it is re-parsed. */
export async function readLastWorkspace(): Promise<WorkspaceIdentity | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_WORKSPACE_KEY);
    const parsed = raw ? WorkspaceIdentitySchema.safeParse(JSON.parse(raw)) : null;
    remembered = parsed?.success ? parsed.data : null;
  } catch {
    remembered = null;
  }
  return remembered;
}

/**
 * Called with every workspace the server names: the salon read, and the
 * `choose_workspace` row she picked. A value that fails the schema is ignored
 * rather than coerced, and the one already held stands.
 */
export async function rememberWorkspace(ws: {
  salonId: string;
  name: string;
  nameAr?: string | null | undefined;
  brandColor: string;
}): Promise<void> {
  const parsed = WorkspaceIdentitySchema.safeParse({
    salonId: ws.salonId,
    name: ws.name,
    // An empty Arabic name is no Arabic name — `salonName` then falls back.
    nameAr: ws.nameAr ? ws.nameAr : null,
    brandColor: ws.brandColor,
  });
  if (!parsed.success) return;
  remembered = parsed.data;
  try {
    await AsyncStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify(parsed.data));
  } catch {
    // A cache write failing must never break a screen that already has its data.
  }
}

/** Test seam. Never called by the app. */
export function __resetLastWorkspaceForTest(): void {
  remembered = null;
}
