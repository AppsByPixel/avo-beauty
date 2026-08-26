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
 * told to go and look at something that is not in her sidebar, on what were then
 * all three of her unbuilt sections at once (`/console/activity`,
 * `/console/accounts`, `/console/billing`).
 *
 * ONLY `/console/billing` REACHES THIS COMPONENT ANYWHERE NOW. The other two
 * console sections were built once it was established that their endpoints already
 * existed. The `owner` sentence below is unaffected and still has to be right:
 * Billing is the section a platform owner is most likely to go looking for on day
 * one.
 *
 * AND THE MERCHANT SENTENCE IS NOW UNREACHABLE, WHICH IS WORTH SAYING RATHER THAN
 * LEAVING TO BE DISCOVERED. Shop was the last `built: false` row in
 * `shell/navItems.tsx`; with it built, `router.tsx`'s merchant `placeholderRoutes`
 * derives an EMPTY list and no merchant path mounts this component. The `merchant`
 * entry below stays because `LANDMARK` is a `Record<AuthScope, string>` and the
 * exhaustiveness is the point — a third surface must not inherit a sentence by
 * default — and because `navLandmarks.test.ts` still holds it to naming a section
 * that exists and is built. It is a live invariant over dead copy, not dead code.
 * If the merchant sidebar ever grows an unbuilt section again, the sentence is
 * already correct.
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
 * plan; it does not say why. The reason it does not is worth keeping, because it
 * is what the last slice acted on: the three console sections behind this screen
 * did NOT share a reason, and a single sentence would have been wrong about two
 * of them. Activity and Accounts were unbuilt SCREENS whose endpoints already
 * existed (`GET /v1/platform/activity`, `GET /v1/platform/accounts`) — unblocked
 * work, and now built. Billing is genuinely blocked: no trial, subscription or
 * invoice column exists anywhere in the schema and the design's figures are
 * prototype fixtures, so the product question is queued as `DECISIONS.md` #15.
 *
 * That distinction is the reason this component stays vague rather than growing a
 * per-section explanation: "later in the build plan" was true of all three and
 * survived two of them shipping, where anything more specific would have gone
 * stale on the same commit.
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
