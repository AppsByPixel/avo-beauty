/**
 * The type of the generated bundle, and deliberately not a hand-written one.
 *
 * `api/_serverless.js` is produced by `scripts/build-function.mjs` and is
 * gitignored, so `index.ts` would otherwise be either untypeable or suppressed
 * with a `@ts-ignore`. Re-exporting the real source instead means this file
 * cannot drift: the bundle IS `src/serverless.ts`, so its type is
 * `src/serverless.ts`'s type, and a change to the handler's signature is a
 * typecheck failure here rather than a runtime surprise on Vercel.
 *
 * `tsc` resolves `./_serverless.js` to this declaration whether or not a build has
 * run, because with `allowJs` off a `.js` specifier only ever resolves to `.ts`,
 * `.tsx` or `.d.ts`. So `pnpm typecheck` behaves identically on a clean checkout
 * and on one that has just built.
 */
export { default } from '../src/serverless.js';
