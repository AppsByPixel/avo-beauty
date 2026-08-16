/**
 * The scanner's unit tests.
 *
 * Node environment, not jsdom. The tests here cover the pure logic the money
 * path depends on — the payment-code parser, the charge totals, and the
 * loyalty sentence — none of which import React Native. Component and
 * end-to-end testing is lane D's column (LANES.md).
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __DEV__: 'false' },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
