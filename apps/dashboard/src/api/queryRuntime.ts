import { focusManager } from '@tanstack/react-query';

/**
 * WHY THE DASHBOARD TELLS TANSTACK IT IS ALWAYS FOCUSED.
 *
 * `networkMode: 'always'` in main.tsx is necessary and NOT sufficient to make
 * interaction-spec.md §4's error states reachable. The two halves are gated
 * differently, and the asymmetry is in the installed source
 * (@tanstack/query-core 5.101.4, build/modern/retryer.js:42-43):
 *
 *   const canStart    = () => canFetch(config.networkMode) && config.canRun();
 *   const canContinue = () => focusManager.isFocused()
 *                          && (config.networkMode === "always" || onlineManager.isOnline())
 *                          && config.canRun();
 *
 * `canStart` — the FIRST fetch — honours `networkMode: 'always'` and runs
 * whatever the focus state. `canContinue` — every RETRY after a failure — is
 * gated on `focusManager.isFocused()` FIRST, and `'always'` does not bypass it.
 * So with a retry budget of one (api/retryPolicy.ts), an unfocused document
 * behaves like this on a refused connection:
 *
 *   fetch runs -> fails -> a retry is owed -> canContinue() is false
 *   -> retryer.js:97 pauses -> fetchStatus 'paused', status 'pending',
 *      state.error null, failureCount 0
 *
 * The failure is never recorded, so `isError` never becomes true, so
 * `SectionError` never renders and the section sits on loading skeletons with
 * no explanation. Every §4 state is reached from the error status — the "No
 * connection" explain, the retry affordance, and stale-not-blank — so all three
 * are unreachable in that window. For a tool a merchant reconciles money in, a
 * screen that is silently stuck is worse than one that says it failed.
 *
 * `focusManager.isFocused()` reads `document.visibilityState`, NOT window focus
 * (focusManager.js:57-62), so this is narrower than it first sounds: a dashboard
 * on a second monitor, or behind another application, still reports 'visible'
 * and was never affected. The window it covers is a backgrounded TAB — and the
 * honest note is that such a merchant is not looking, and returning fires
 * `visibilitychange`, which resumes the paused query. So this is a small real
 * window and a large *testability* one, which is the other reason it is fixed
 * here: with the retry gated on focus there is no way to demonstrate the
 * connectivity state in an automated browser at all, and a state nobody can
 * demonstrate is a state nobody is maintaining.
 *
 * ----------------------------------------------------------------------------
 * WHAT THIS COSTS, NAMED RATHER THAN DISCOVERED LATER.
 *
 * `focusManager` has three consumers in query-core, and forcing it touches all
 * three. Checked, not assumed:
 *
 * 1. retryer.js:42 `canContinue` — the reason for this call. Retries now
 *    proceed while the document is hidden. The budget is still ONE, so this is
 *    at most one extra request per failed query, not a loop.
 *
 * 2. queryObserver.js:215 `refetchIntervalInBackground || isFocused()` — this
 *    gates POLLING, and `api/salon.ts` polls on `refetchInterval: 60_000`.
 *    Until now that poll paused when the tab went hidden; it no longer does.
 *    ACCEPTED, deliberately: it is one lightweight `GET /salons/{id}` per
 *    minute per hidden tab, and the merchant returning to a tab whose brand
 *    kit and module flags are already current is a better outcome than one that
 *    has to load them again. This is the trade — it is not free and it is not
 *    hidden.
 *
 * 3. queryClient.js:36 `focusManager.subscribe(...)` — resumes paused
 *    mutations and refetches on regaining focus. With focus pinned true this
 *    subscriber simply stops firing on visibilitychange, because `setFocused`
 *    only notifies when the value CHANGES (focusManager.js:41-47) and it never
 *    changes again. Nothing is lost: its whole job was to resume work that was
 *    paused for lack of focus, and nothing pauses for lack of focus any more.
 *
 * A LIVE TRAP FOR THE NEXT PERSON: `refetchOnWindowFocus` is `false` globally
 * in main.tsx, which is why forcing focus is safe today. A hook that turns it
 * back on would refetch on every `visibilitychange` — including the transition
 * to hidden — because `isFocused()` would always answer true. If that is ever
 * wanted, this call is the thing to reconsider first.
 *
 * `setFocused(true)` is durable rather than a value the library re-derives: the
 * default event listener calls `onFocus()`, which notifies listeners and does
 * NOT reset `#focused` (focusManager.js:26-38). So one call at bootstrap holds
 * for the life of the page.
 */
export function configureQueryFocus(): void {
  focusManager.setFocused(true);
}
