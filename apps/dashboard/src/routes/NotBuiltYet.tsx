import { EmptyState } from '@avo/ui';
import type { AuthScope } from '../auth/scopes.js';

/**
 * What sits behind a nav item that has not landed, so a click never dead-ends.
 *
 * THE REASSURANCE POINTED AT A SECTION THE CONSOLE DOES NOT HAVE. One sentence
 * was shared by both surfaces:
 *
 *   "This section is in a later phase of the build plan. Overview is live and
 *    reads from the API."
 *
 * True on the merchant dashboard, which has an Overview. The owner console does
 * not — its sections are Analytics, Activity, Salons, Accounts, Admins,
 * Approvals, Policies, Billing, Audit log, Controls. So the platform owner was
 * told to go and look at something that is not in her sidebar, on all three of
 * her unbuilt sections at once (`/console/activity`, `/console/accounts`,
 * `/console/billing`).
 *
 * THE SURFACE IS A REQUIRED PROP, NOT A ROUTE SNIFF. Two reasons, and the second
 * is the one that matters. Reading the current path inside this component would
 * put a `startsWith('/console')` here that silently picks the merchant sentence
 * for anything it does not recognise — a third surface would inherit the wrong
 * copy by DEFAULT, which is how this defect happened the first time. As a
 * required prop over `AuthScope`, `LANDMARK` below is an exhaustive record: a new
 * scope does not compile until someone writes its sentence.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED HERE. This says a section is later in the
 * plan; it does not say why, because the three console sections do not share a
 * reason and a single sentence would have to be wrong about two of them.
 * Activity and Accounts are unbuilt SCREENS whose endpoints already exist
 * (`GET /v1/platform/activity`, `GET /v1/platform/accounts`) — unblocked work.
 * Billing is genuinely blocked: no trial, subscription or invoice column exists
 * anywhere, and the product question is queued as `DECISIONS.md` #15. Saying
 * "later in the build plan" is true of all three; saying anything more specific
 * from one shared component would not be.
 */
const LANDMARK: Record<AuthScope, string> = {
  /** The merchant's landing section, and live. */
  merchant: 'Overview is live and reads from the API.',
  /**
   * Analytics, and not the console's `home`. `auth/scopes.ts` routes a fresh
   * admin to Approvals, but the sentence wants the section that best answers
   * "is any of this real yet" — Analytics is the console's Overview equivalent,
   * it is `built: true` in `consoleNavItems.tsx`, and it reads
   * `GET /v1/platform/metrics`. `navLandmarks.test.ts` checks that claim against
   * the sidebar rather than trusting this comment.
   */
  owner: 'Analytics is live and reads from the API.',
};

export function NotBuiltYet({ section, scope }: { section: string; scope: AuthScope }) {
  return (
    <EmptyState
      title={`${section} isn't built yet`}
      body={`This section is in a later phase of the build plan. ${LANDMARK[scope]}`}
    />
  );
}
