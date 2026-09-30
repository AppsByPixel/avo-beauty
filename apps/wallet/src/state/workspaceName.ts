/**
 * The salon's name every customer-facing sentence interpolates — the SIGNED-IN
 * workspace's, never a literal.
 *
 * Trunk's demo, 2026-09-30: Maha, a SAL-FOREST member, signed in and landed in
 * Forest green — and her Account said "Your wallet holds prepaid credit for
 * Amara Salon only." Five sentences in each copy file had the default salon's
 * name written into them, from the days each salon was to ship its own build.
 * With one app serving every workspace, a literal name is another salon's name
 * to everyone but Amara's customers.
 *
 * The order, first answer wins:
 *
 *   1. the salon on screen — the session's `GET /salons/{id}`, which is what
 *      decided the palette too;
 *   2. before sign-in, or with no salon read yet: the workspace this phone was
 *      last signed in to (`state/lastWorkspace.ts`);
 *   3. the build's default workspace (`config/salon.ts § DEFAULT_SALON_NAME`).
 *
 * Every rung goes through `salonName()`, so Arabic reads `nameAr` and falls back
 * to the Latin `name` when `nameAr` is null or empty.
 *
 * SIGN-UP IS THE EXCEPTION and uses `defaultWorkspaceName` directly: sign-up
 * registers at the default workspace (`SignUpScreen`, an open product question
 * for trunk), so the name it shows must be the one it registers her at — not the
 * workspace somebody else last signed in to on this phone.
 */

import type { Language } from '@avo/types';
import { DEFAULT_SALON_NAME } from '../config/salon';
import { salonName, type Named } from '../domain/names';
import { lastWorkspace } from './lastWorkspace';

export function workspaceName(salon: Named | null | undefined, lang: Language): string {
  return salonName(salon ?? lastWorkspace() ?? DEFAULT_SALON_NAME, lang);
}

/** The default workspace's name — the one sign-up registers her at. */
export function defaultWorkspaceName(lang: Language): string {
  return salonName(DEFAULT_SALON_NAME, lang);
}
