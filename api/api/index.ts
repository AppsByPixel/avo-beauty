/**
 * Vercel's function file, and it exists only because Vercel discovers functions
 * by PATH: with the project's Root Directory set to `api/`, the one directory it
 * scans is `api/api/`. The handler itself lives in `src/serverless.ts` with the
 * rest of the API, so nothing about the port is hidden in a magic directory.
 *
 * `vercel.json` rewrites every path here, so this single function is the whole
 * API surface and Fastify keeps doing the routing.
 *
 * WHY THIS IMPORTS A GENERATED FILE AND NOT `../src/serverless`.
 * It used to import the source directly, and that is what broke the first deploy:
 * Vercel's Node runtime transpiles this file rather than bundling it, so the
 * emitted `index.js` kept the extensionless specifier `'../src/serverless'`, which
 * real Node ESM cannot resolve. `scripts/build-function.mjs` carries the evidence
 * and the argument; the short version is that it esbuilds the same
 * `src/serverless.ts` into `./_serverless.js` — one file, no relative imports left
 * to resolve — and this shim is what Vercel compiles. The specifier below keeps
 * its `.js` for the same reason the failure happened.
 *
 * The leading underscore is load-bearing: Vercel does not turn `api/_*` into its
 * own function, so the bundle ships as a plain file beside this one rather than
 * as a second, unrouted endpoint. `_serverless.d.ts` gives it the real handler's
 * type by re-exporting `src/serverless.ts`, so `tsc` checks this file against the
 * source and not against whatever the last build happened to leave on disk.
 */
export { default } from './_serverless.js';
