/**
 * Vercel's function file, and it exists only because Vercel discovers functions
 * by PATH: with the project's Root Directory set to `api/`, the one directory it
 * scans is `api/api/`. The handler itself lives in `src/serverless.ts` with the
 * rest of the API, so nothing about the port is hidden in a magic directory.
 *
 * `vercel.json` rewrites every path here, so this single function is the whole
 * API surface and Fastify keeps doing the routing.
 */
export { default } from '../src/serverless';
