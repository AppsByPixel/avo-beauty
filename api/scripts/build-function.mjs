/**
 * Bundles the serverless handler into ONE file, and it exists because Vercel's
 * Node runtime does not bundle — it TRANSPILES.
 *
 * =========================================================================
 * WHAT WENT WRONG, WITH THE EVIDENCE RATHER THAN THE INFERENCE
 * =========================================================================
 * The first deploy of this function built green and then died on every request:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/var/task/api/src/serverless'
 *       imported from /var/task/api/api/index.js
 *
 * `vercel build` reproduces it locally and shows exactly why. `@vercel/node`
 * (5.7.15) compiles the entrypoint's TypeScript import graph file by file with
 * tsc — one `.js` and one `.js.map` per `.ts`, no bundling step anywhere — and it
 * compiles with ITS OWN compiler options, not this package's. Its options say
 * `moduleResolution: node16`, so the build printed a TS2835 for every relative
 * import in `api/src`:
 *
 *     src/images/index.ts(19,32): error TS2835: Relative import paths need
 *     explicit file extensions ... Did you mean './disk.js'?
 *
 * TS2835 is a diagnostic, not a build failure — the build still reported
 * `"status": "ok"` — and tsc never rewrites a specifier on emit. So the emitted
 * `api/api/index.js` still said `from '../src/serverless'` and the emitted
 * `api/src/serverless.js` still said `from './app'`, while the function's
 * `package.json` carries `"type": "module"`. Real Node ESM requires the
 * extension. Every one of them is unresolvable, which is why fixing the
 * entrypoint's import alone would only have moved the error one file deeper.
 *
 * =========================================================================
 * WHY BUNDLE RATHER THAN REWRITE 836 SPECIFIERS
 * =========================================================================
 * The other honest fix is to move `api/src` to explicit `.js` specifiers under
 * NodeNext, which is what `packages/types` and `packages/tokens` already do —
 * their `dist/` emits `from './money.js'`, because they are consumed as real Node
 * ESM and always have been. That fix is correct and it is not the one taken here:
 * it is 836 specifiers across 154 of this package's 186 source files, and its
 * blast radius is `tsx`, `vitest` and `drizzle-kit` — every tool the lane
 * develops and tests with — in exchange for a property only the deployed artifact
 * needs. `api/src` has never run as compiled ESM anywhere else and does not now.
 *
 * So the deployment-shaped problem is fixed in the deployment path. esbuild
 * collapses the relative graph into one file, and a file with no relative imports
 * has nothing left to resolve. The `.js`-specifier migration stays available and
 * this forecloses none of it.
 *
 * =========================================================================
 * THE THREE THINGS THAT MAKE THIS SAFE
 * =========================================================================
 * `packages: 'external'` — only OUR relative modules are inlined. `fastify`,
 * `drizzle-orm`, `postgres`, `@node-rs/argon2` (which loads a native `.node`
 * binding) and the two workspace packages stay bare specifiers that Node resolves
 * and that Vercel's dependency tracer already finds and ships. Inlining a native
 * module is how bundled Node functions usually break; this never tries.
 *
 * `import.meta.url` IS PRESERVED BY THE OUTPUT PATH, not by luck. `src/env.ts`
 * resolves `imageStorePath` against `new URL('..', import.meta.url)`. From
 * `api/src/env.ts` that is `api/`. From the bundle at `api/api/_serverless.js` it
 * is also `api/` — both files sit one level below `api/`. The bundle must
 * therefore stay in a directory that is a direct child of `api/`; moving it to
 * `api/dist/serverless.js` would keep the same property, but moving it deeper
 * would silently relocate the image store. `src/db/migrate.ts` has the other
 * `import.meta.url` in this package and is not in this graph — it is a script.
 *
 * NOTHING DYNAMIC. `api/src` contains no `import()`, no `__dirname`, no
 * `createRequire`, so there is no runtime-resolved edge for the bundler to miss.
 *
 * =========================================================================
 * WHY HERE AND NOT IN `turbo run build`
 * =========================================================================
 * This is deliberately NOT the package's `build` task. turbo.json declares
 * `build.outputs` as `dist/**` and `build/**`, and turbo restores exactly the
 * declared outputs on a cache hit — a `build` task writing to `api/api/` would
 * produce the bundle on a cold run and silently produce NOTHING on a warm one,
 * which on Vercel (TURBO_REMOTE_ONLY is set in this project's environment) means
 * a green build that ships the previous, handler-less function. turbo.json is
 * trunk-owned, so declaring the output there is not this lane's edit to make.
 * `vercel.json`'s build command runs this after `pnpm build` instead, where it is
 * unconditional and uncached.
 */

import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(apiRoot, 'api', '_serverless.js');

await rm(outfile, { force: true });
/** A leftover from an earlier build of this script, which emitted a sibling map. */
await rm(`${outfile}.map`, { force: true });

const result = await build({
  entryPoints: [join(apiRoot, 'src', 'serverless.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  /**
   * The floor, not the deployed runtime. The project runs nodejs24.x today; the
   * workspace's `engines` says `>=20`, and output for 20 runs unchanged on 24.
   * Pinning the higher one would make a runtime downgrade a silent syntax error.
   */
  target: 'node20',
  /**
   * Every bare specifier stays bare. See "THE THREE THINGS" above — this is the
   * line that keeps `@node-rs/argon2`'s native binding out of the bundle.
   */
  packages: 'external',
  /**
   * INLINE, and not a sibling `.js.map`. The runtime sets
   * `shouldAddSourcemapSupport`, so a map that reaches the function makes a 500's
   * stack point at `src/routes/charges.ts` instead of at a line number in a 737kb
   * bundle — and the platform log is the only place anyone reads it. A sibling map
   * does NOT reach the function: Vercel's tracer does not follow
   * `sourceMappingURL`, and `functions[].includeFiles` was tried at both
   * `api/_serverless.js.map` and `api/api/_serverless.js.map` and shipped neither
   * (verified against `.vercel/output` on a local `vercel build`). Inlining is the
   * one form that cannot be dropped in transit. It costs ~2.3mb of trailing
   * comment that V8 never parses.
   */
  sourcemap: 'inline',
  /**
   * A stack trace from a 500 is the only thing anyone reads when this breaks, and
   * minified frames in a platform log are worth less than the bytes saved.
   */
  minify: false,
  logLevel: 'info',
  metafile: true,
});

const inputs = Object.keys(result.metafile.outputs[
  Object.keys(result.metafile.outputs).find((k) => k.endsWith('_serverless.js'))
].inputs).length;

console.log(`build-function: ${outfile} <- ${inputs} modules`);
