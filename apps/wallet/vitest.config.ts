/**
 * The wallet's unit tests.
 *
 * Node environment, not jsdom: the only tests here are for the copy modules and
 * the digit rule, which are plain TypeScript with no React Native imports.
 * Component and end-to-end testing is lane D's column (see LANES.md) and this
 * config deliberately does not reach for a renderer.
 *
 * `__DEV__` is a React Native global that `src/api/scenario.ts` and
 * `src/i18n/initialLanguage.ts` read. Neither is imported by these tests, but
 * defining it keeps a future test from failing on a global that only exists
 * inside the Metro bundle.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DEV__: 'false' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
