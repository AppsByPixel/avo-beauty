/**
 * THE RESPONSE-BEFORE-COMMIT SCAN — find handlers that dispatch a reply from
 * inside a `db.transaction()` callback.
 *
 * WHAT THE DEFECT IS. Fastify writes the response the moment `reply.send()` is
 * called. Drizzle issues `COMMIT` when the transaction callback's promise
 * resolves. So a `reply.send()` *inside* the callback puts the response bytes on
 * the wire before the commit round trip has even been sent — and a client that
 * writes and immediately re-reads through a different connection can see the OLD
 * value. Nothing is corrupted; the write lands. What breaks is the promise the
 * 200 made about ordering.
 *
 * WHERE THIS CAME FROM. Lane A's item 6 shipped it on
 * `PUT /artists/{id}/branch` and it was caught on the THIRD consecutive int run
 * (decision 75) — runs 1 and 2 were green. Lane A then fixed that route and
 * wrote the reason into `api/src/routes/artists.ts` above the transaction. This
 * scan's first run found a SECOND instance in the same file, twelve lines below
 * that paragraph: `DELETE /artists/:id/calendar` still calls `reply.send()`
 * inside its transaction. The fix was understood and not generalised, which is
 * the argument for a structural check rather than for more runs.
 *
 * ============================================================================
 * WHAT THIS IS NOT — read this before trusting a green run
 * ============================================================================
 *
 * This matches ONE MEMBER of the class, LITERALLY: the token `reply` reaching
 * `.send(` or `.hijack(` inside a brace-matched transaction body. The class is
 * "an externally observable effect ordered before its commit". Those are not the
 * same thing, and the gap is not hypothetical — it is the same gap that has now
 * defeated two Lane D scans (`merchantScopeGates`'s path literals,
 * `perm-census`'s guard tokens), arriving a third time.
 *
 * MEASURED on five hand-written spellings of the identical defect. The
 * fixtures are not described here and trusted — they are RUN, in
 * `commit-order.test.ts`, against this same function through its `root`
 * argument, so the four sentences below are assertions rather than claims and a
 * pattern change reports which of them stopped being true. THREE OF THE FIVE
 * WALK STRAIGHT PAST:
 *
 *   M1  `reply.send(row)` directly inside the callback          → CAUGHT
 *   M2  `respondWith(reply, row)`, the helper does the send     → MISSED
 *   M3  the handler names its second parameter `res`, not       → MISSED
 *       `reply`, and calls `res.send(row)`
 *   M4  the transaction is opened in `api/src/services/`, with  → CAUGHT
 *       `reply` passed in, and the send is inside it there
 *   M5  no reply at all — an out-of-transaction queue publish   → MISSED
 *       ordered before the commit. Same class, different effect.
 *
 * HOW LIVE EACH DEFEAT IS, also measured, because "a regex can be defeated" is
 * true of every regex and says nothing about whether it will be:
 *
 *   M2 is the one to worry about. `api/src/routes/images.ts:275` and `:430`
 *      already define two functions that take `reply: FastifyReply` and dispatch
 *      it (`performUpload`, `performDetach`). Neither is inside a transaction
 *      TODAY — `images.ts` opens none — but `performDetach` does its detach and
 *      its audit write as two separate statements on `db`, so wrapping it in a
 *      transaction is a correct and likely change, and the day it happens this
 *      scan goes quiet on it. `images.ts` is also the file whose curried handler
 *      factory already defeated the permission census once.
 *
 *   M3 has zero live exposure: all 133 route handlers in `api/src/routes/` name
 *      the parameter `reply`. That is a convention, not a constraint, and this
 *      scan's silence under a rename would be indistinguishable from success.
 *
 *   M5 has zero live instances: no transaction body in `api/src` awaits a call
 *      on a receiver other than `tx`. It is listed because naming this scan
 *      after the class while matching one member is exactly the overclaim the
 *      permission census's header warns about.
 *
 * M4 IS CAUGHT ONLY BECAUSE THE ROOT IS `api/src` AND NOT `api/src/routes`.
 * That is deliberate and it is where most of this scan's value sits: the scan
 * does not need to know that a function is a route handler, only that `reply` is
 * in scope wherever the transaction is. Narrowing the root to `routes/` would
 * make every service-held transaction invisible, and services are where this
 * codebase keeps its transactions.
 *
 * ============================================================================
 * WHY THE GUARD IS STATIC AND NOT BEHAVIOURAL
 * ============================================================================
 *
 * A behavioural probe — write, then immediately re-read through a second
 * persistent connection — does detect this, and it is what found the first
 * instance. It was measured against the live `DELETE /artists/:id/calendar` with
 * a warm in-process second connection reading the row the instant the client had
 * its 200:
 *
 *   40 attempts → 4 saw the pre-commit value.        ~10% per attempt
 *   the same probe against the FIXED `PUT /artists/:id/branch`, 40 attempts → 0
 *
 * The control is what makes the 4 mean something: same file, same shape, one
 * fixed and one not, and the probe separates them.
 *
 * But 10% per attempt is what "int run 3 caught it" actually was. Three
 * single-shot runs is 1 − 0.9³ ≈ 27% — a lottery this project won once, not a
 * detector. Looping fixes that (40 attempts is ≈98.5%), so a behavioural probe
 * CAN be made reliable per endpoint.
 *
 * What it cannot be made is GENERATED. To re-read after a write the probe must
 * know which column that endpoint changed, and no source scan can supply that.
 * So it scales as one hand-written spec per write endpoint — and a
 * hand-maintained list of what has been covered is the failure mode
 * `perm-census.ts` exists to reject. Hence: the static scan is the sweep, and
 * the behavioural probe stays a one-off instrument for confirming a hit.
 *
 * SO THE HONEST SUMMARY OF THIS FILE: it catches the literal spelling, in every
 * file where `reply` and a transaction meet, cheaply and deterministically. It
 * is not proof the class is absent. The pinned ledger in
 * `commit-order.test.ts` is what makes it useful — a new hit and a fixed hit
 * both fail by name.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Borrowed rather than reimplemented. `stripComments` is string- and
 * template-literal aware and preserves byte offsets so line numbers survive;
 * `bodyOf` brace-matches a callback body through strings and `${}`. Copying
 * either would mean two subtly different answers to "what is a comment" in one
 * directory, which is the disagreement `perm-census.ts` records having had with
 * itself over what a route registration is.
 */
import { bodyOf, stripComments } from './perm-census.js';
import { repoRoot } from './tenancy-harness.js';

export const API_SRC = join(repoRoot, 'api', 'src');

/**
 * Any `<identifier>.transaction(` — `db.transaction`, and a nested
 * `tx.transaction` (a savepoint) just as much, because a send inside a
 * savepoint is a send inside the outer transaction too.
 *
 * The receiver is any identifier for the reason `perm-census.ts`'s
 * `REGISTRATION` gave up its `app.` anchor: an allowlist of receiver names
 * leaves the next alias invisible, and there is no cost to being general here.
 * `.transaction(` has no non-transaction meaning anywhere in `api/src`.
 */
const TRANSACTION = /\b[A-Za-z_$][\w$]*\.transaction\s*\(/g;

/**
 * `reply` reaching `.send(` or `.hijack(` within one statement.
 *
 * `[^;]*?` rather than a chain of `\.\w+\([^)]*\)` groups, and the difference is
 * a real miss: `routes/images.ts:425` is
 * `reply.code(result.created ? 201 : 200).send(result.ref)`, and a
 * `\([^)]*\)` group cannot cross a nested paren — so `reply.code(foo(1)).send()`
 * would have been read as no dispatch at all. Bounding on `;` keeps it inside
 * one statement, which is what stops it pairing a `reply` on one line with a
 * `.send(` three statements later.
 *
 * `.hijack(` is included because it also takes the response away from fastify's
 * post-handler dispatch, which is the ordering this scan is about.
 */
const DISPATCH = /\breply\b[^;]*?\.(send|hijack)\s*\(/g;

export interface CommitOrderHit {
  /** Repo-relative, from `api/src/`. */
  file: string;
  /** The line the dispatch is on — the line a developer has to go fix. */
  line: number;
  /** The line the enclosing transaction was opened on. */
  transactionLine: number;
  /** `send` or `hijack`. */
  dispatch: string;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    /**
     * `.test.ts` and `.int.test.ts` are excluded. A test may legitimately open a
     * transaction and hold a fake reply, and a hit there would be noise in the
     * one ledger that has to stay signal.
     */
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

const lineOf = (src: string, index: number): number => src.slice(0, index).split('\n').length;

/** Every transaction body under `root`, so the spec can pin how many were read. */
export function transactionCount(root: string = API_SRC): number {
  let n = 0;
  for (const file of walk(root)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const _ of src.matchAll(TRANSACTION)) n++;
  }
  return n;
}

/**
 * Every place a reply is dispatched from inside a transaction body.
 *
 * Sorted by file then line so the ledger is a stable text block and a diff of it
 * reads — the same reason `censusLedger` sorts.
 *
 * `root` DEFAULTS TO `api/src` AND IS OVERRIDDEN ONLY BY THE FIXTURE SPEC. It is
 * a parameter so that the five spellings in the header can be executed against
 * this exact function rather than against a second copy of the regexes written
 * to agree with it — a self-agreeing copy is the tautology this project keeps
 * catching itself in.
 */
export function commitOrderHits(root: string = API_SRC): CommitOrderHit[] {
  const hits: CommitOrderHit[] = [];

  for (const full of walk(root)) {
    const src = stripComments(readFileSync(full, 'utf8'));
    /**
     * REPO-RELATIVE for a real file — `api/src/routes/artists.ts`, the name the
     * pinned ledger uses and the name a developer can paste into an editor. A
     * fixture written to a temp directory is not under the repo, so it falls back
     * to root-relative (`routes/m1.ts`) rather than leaking an absolute tmp path
     * that changes every run and could never be asserted on.
     */
    const rel = full.startsWith(repoRoot)
      ? full.slice(repoRoot.length + 1)
      : full.startsWith(root)
        ? full.slice(root.length + 1)
        : full;

    for (const tx of src.matchAll(TRANSACTION)) {
      /**
       * `m.index + m[0].length - 1` is the `(` of `.transaction(`, so `bodyOf`
       * finds the callback's own `{` rather than some earlier brace. An arrow
       * body that is an expression rather than a block has no `{` and yields
       * null — it also cannot contain a statement, so there is nothing to miss.
       */
      const span = bodyOf(src, tx.index! + tx[0].length - 1);
      if (!span) continue;
      const body = src.slice(span.start, span.end);

      for (const d of body.matchAll(new RegExp(DISPATCH.source, 'g'))) {
        hits.push({
          file: rel,
          line: lineOf(src, span.start + d.index!),
          transactionLine: lineOf(src, tx.index!),
          dispatch: d[1]!,
        });
      }
    }
  }

  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** `api/src/routes/artists.ts:1029 reply.send inside transaction opened at 980`. */
export const hitLine = (h: CommitOrderHit): string =>
  `${h.file}:${h.line} reply.${h.dispatch} inside transaction opened at ${h.transactionLine}`;
