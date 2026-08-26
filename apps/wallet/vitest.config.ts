/**
 * The wallet's unit tests.
 *
 * `__DEV__` is a React Native global that `src/api/scenario.ts` and
 * `src/i18n/initialLanguage.ts` read. Defining it here keeps a test from failing
 * on a global that only exists inside the Metro bundle.
 *
 * WHAT THIS FILE USED TO SAY, AND WHY IT IS WORTH RECORDING THAT IT WAS WRONG.
 * Until now the header read: "the only tests here are for the copy modules and
 * the digit rule ... this config deliberately does not reach for a renderer."
 * The first clause stopped being true a long time ago — there are 33 test files
 * here, covering domain rules, the API client, activity, receipts and the Pay
 * tab. The second described a deliberate choice that had quietly become a
 * limitation: there was no renderer to reach for anywhere in this project
 * (DECISIONS.md #38), so "deliberately does not" was indistinguishable from
 * "cannot".
 *
 * TWO ENVIRONMENTS, ON PURPOSE. `environment: 'node'` stays the default because
 * the overwhelming majority of these tests are plain TypeScript and have no
 * reason to pay for a DOM. A test that needs to render opts in per file with a
 * `// @vitest-environment jsdom` docblock.
 *
 * WHAT STILL CANNOT BE RENDERED, SO NOBODY REDISCOVERS IT. Anything importing
 * `react-native-qrcode-svg` — `QrOverlay`, `PaymentCode` — does not load here.
 * That package ships JSX inside `.js`, which vite refuses; transforming it gets
 * one step further and then hits untranspiled Flow in React Native's own source,
 * reached through `react-native-svg`. Plain `react-native-web` components render
 * fine, which is how we know the wall is that dependency chain and not the
 * approach. The §4 "no stale code on screen" property therefore still rests on
 * `payTabWiring.test.ts` reading the source. Left for lane D with a real budget.
 *
 * THE ALIAS IS WHAT MAKES RENDERING POSSIBLE AT ALL. React Native's own source
 * ships untranspiled Flow, which vitest cannot parse; `react-native-web` is the
 * same component surface in DOM terms and is already a dependency here, because
 * it is what Expo web runs. No test imported `react-native` before this change,
 * so the alias cannot affect any existing one.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DEV__: 'false' },
  resolve: {
    alias: { 'react-native': 'react-native-web' },
  },
  test: {
    environment: 'node',
    // `.tsx` was absent, so a render test would not merely have failed — it
    // would not have been COLLECTED, and the run would have reported success.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
