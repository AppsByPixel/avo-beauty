/**
 * Runs before every wallet test file. It exists for one setting.
 *
 * TESTING LIBRARY'S ASYNC CEILING, RAISED FROM 1000ms TO 5000ms.
 * `findBy*` and `waitFor` give up after `asyncUtilTimeout`, which defaults to
 * one second of WALL-CLOCK time. A render test here is jsdom plus
 * react-native-web plus the screen's own async loads, and React commits them in
 * scheduler tasks that compete for the CPU with everything else on the box.
 * One second is a quiet-machine number; trunk's full gate
 * (`pnpm check --force`, every package and e2e at once) is not a quiet machine.
 *
 * WHAT THIS DID NOT FIX, SO NOBODY RAISES IT AGAIN FOR THE SAME REASON. The two
 * gate failures that prompted this (2026-09-29, bookBranchRowsRender and
 * bookEntryRender) looked like this ceiling and were not. Reproduced in lane B
 * under 36 `yes` processes, they failed just the same at 5000ms — the test ran
 * 7.5-10.7s and the DOM at failure still showed step 1 with Continue ENABLED.
 * The tap on Continue had been dropped, not delayed: react-native-web arms a
 * Pressable's new `disabled` in a passive effect, after the DOM already says
 * enabled. That is fixed where it happens, in the tests' taps —
 * `src/testing/tapAndSettle.ts` has the mechanism. This setting is the margin
 * for waits that are merely slow; it cannot rescue a tap that went nowhere.
 *
 * WHY 5000, AND WHY IT STAYS BELOW `testTimeout`. The slowest passing Book test
 * seen under that load was 5478ms for a whole multi-step walk of several
 * waits, so no single wait came near 5s. `testTimeout` in vitest.config.ts is
 * 20s, four times this: a wait that genuinely never resolves still fails as
 * ITSELF — "Unable to find … <the DOM>", naming the element — rather than as a
 * bare vitest timeout that names nothing, and a test with several sequential
 * waits keeps room for them. Raising this to meet `testTimeout` would throw
 * that diagnosis away.
 *
 * It retries nothing and changes no assertion. A wait still returns the moment
 * its condition holds, so a quiet run is exactly as fast as before; only a
 * FAILING wait takes longer to say so.
 *
 * ONLY WHERE THERE IS A DOM. Most wallet tests run in `environment: 'node'`
 * and never touch Testing Library; importing it there would load react-dom
 * into sixty-odd files for nothing. The jsdom files opt in by docblock, and
 * `document` is how this file tells which it is running in.
 */

if (typeof document !== 'undefined') {
  const { configure } = await import('@testing-library/react');
  configure({ asyncUtilTimeout: 5_000 });
}

export {};
