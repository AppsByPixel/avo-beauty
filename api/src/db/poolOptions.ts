/**
 * How the application's postgres.js client is pooled — and it is a knob rather
 * than a constant because the two shapes are answers to different questions.
 *
 * =========================================================================
 * WHY THIS IS NOT SIMPLY `max: 1, prepare: false` EVERYWHERE
 * =========================================================================
 * A serverless deployment needs both of those and a long-running process needs
 * neither. Making the serverless pair the default would change, silently, what
 * the int suite proves:
 *
 *   `db/counterPrivileges.int.test.ts` and the limiter suites assert things about
 *   ROWS written by the `avo_app` role under REVOKEs. They are indifferent to the
 *   pool size, but they are not indifferent to a CHANGE in it — the burst probes
 *   in `services/scannerLimit.int.test.ts` and `e2e/connection-pool.test.ts` are
 *   literally about `max`, and were written against ten. A repository-wide flip
 *   to `max: 1` would leave those specs green while measuring a different system.
 *
 * So: `default` is today's behaviour, byte for byte, and nothing selects
 * `serverless` unless a deployment asks for it by name (`DB_POOL_MODE=serverless`).
 * Local dev, CI, the unit suite and the int suite all keep `{ max: 10 }` and
 * postgres.js's own default for `prepare`.
 *
 * =========================================================================
 * WHAT THE SERVERLESS SHAPE IS FOR, ONE REASON EACH
 * =========================================================================
 * `max: 1` — A serverless platform runs N warm instances and each one holds its
 * own pool, so the connection count the database sees is `max × instances`, not
 * `max`. Ten per instance exhausts a free Postgres's ceiling within a handful of
 * concurrent invocations, and the symptom is a connection error inside a handler
 * rather than anything that looks like capacity. One per instance makes the
 * ceiling a function of concurrency alone, which is the thing the platform is
 * already bounding.
 *
 *   AND IT IS SAFE ONLY BECAUSE OF A PROPERTY THIS CODEBASE ALREADY ENFORCES.
 *   `services/charge.ts` § "ON `tx`, NOT ON `db`" and `services/scannerLimit.ts`
 *   § "WHERE THE CHECK SITS" both exist because a `db.transaction()` RESERVES a
 *   connection for its whole life, so asking the same pool for a SECOND one while
 *   holding the first deadlocks at `max` concurrent requests. With `max: 1` that
 *   cliff is not at ten, it is at ONE: a single request that nested a `db` call
 *   inside a `tx` would hang for ever, by itself, on the first try. Those two
 *   files removed every such nesting; `max: 1` is what makes a regression of that
 *   bug instant and obvious instead of a load-dependent mystery. It does not
 *   introduce the hazard — it lowers its detection threshold to one request.
 *
 * `prepare: false` — Serverless needs a TRANSACTION-mode pooler (Supabase's port
 * 6543), because a session-mode pooler (5432) pins a server connection per client
 * connection and the multiplication above defeats it. Transaction pooling gives a
 * connection back to the pool at COMMIT, and therefore cannot honour anything that
 * outlives a transaction — including the named prepared statements postgres.js
 * creates by default.
 *
 *   AND IT DOES NOT FAIL THE WAY EVERY WRITE-UP SAYS IT DOES. The documented
 *   symptom is `26000 prepared statement "…" does not exist`. MEASURED against the
 *   demo project's 6543 pooler, twelve concurrent queries at a time:
 *
 *     prepare OFF, max 1   5/5 rounds, 60/60 queries and 60/60 transactions
 *     prepare ON,  max 1   round 1 never returned — abandoned at 40s
 *     prepare ON,  max 10  round 1 fine (1978ms), round 2 never returned
 *
 *   No error code, no rollback, no timeout: it HANGS. Round one Parses the
 *   statement and round two Binds it by name on a backend that never saw the
 *   Parse. A money endpoint that hangs is worse than one that raises, because
 *   nothing retries and nothing alerts — so `prepare: false` is not a performance
 *   preference here, it is the difference between an API and a wedged one.
 *
 * =========================================================================
 * WHAT `serverless` DOES NOT CHANGE
 * =========================================================================
 * Not the URL, not the role, not SSL, not the int8-as-string parsing that keeps
 * `Fils` exact. This function returns POOLING options only. Everything that makes
 * `db/client.ts`'s guarantees true — connecting as `avo_app` and never as the
 * owner above all — is outside it and stays outside it.
 */

/** The two shapes. Spelled out, because a boolean called `serverless` reads as a fact about the world rather than a choice about pooling. */
export type DbPoolMode = 'default' | 'serverless';

/**
 * `max` and `prepare` are postgres.js's own option names. `prepare` is OMITTED
 * rather than set to `true` in the default mode, deliberately: passing it would
 * pin postgres.js's default, and the point of `default` is that it is today's
 * behaviour including whatever the library chooses.
 */
export type DbPoolOptions = { max: number } | { max: number; prepare: false };

export function poolOptionsFor(mode: DbPoolMode): DbPoolOptions {
  if (mode === 'serverless') {
    return { max: 1, prepare: false };
  }
  return { max: 10 };
}
