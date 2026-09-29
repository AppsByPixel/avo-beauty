/**
 * One salon read, adopted: its name for the headings and its hex for the
 * palette, both at once.
 *
 * Called after every staff sign-in's `GET /salons/{id}` (`ScannerFlow`). The
 * name was always live — `config/brand.ts` reads it at render time. The colour
 * used to wait for the next launch, because every stylesheet had copied the
 * palette at import and `theme/sealed.ts` refused a late write; so a till's
 * whole first session after enrolment ran in the default green. It is live now
 * too: `applyBrandColor` repaints every brand stylesheet in place
 * (`theme/live.ts`), without re-mounting whatever the till has open.
 *
 * Its own module rather than a function in `config/brand.ts`, because `Boot`
 * imports that file eagerly and `theme/brandBootOrder.test.ts` holds it free of
 * anything colour-shaped.
 */

import { adoptSalonName } from '../config/brand';
import { applyBrandColor, type BrandOutcome } from '../theme/brand';

export function adoptSalonIdentity(identity: {
  name?: string | null;
  brandColor?: string | null;
}): BrandOutcome {
  adoptSalonName(identity.name);
  return applyBrandColor(identity.brandColor);
}
