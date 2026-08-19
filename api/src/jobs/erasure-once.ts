/**
 * Run the account-erasure job exactly once, and print what it did.
 *
 *   pnpm --dir=/abs/path/to/api run job:erasure
 *
 * The same two reasons `no-show-once.ts` gives, and a third particular to this
 * job:
 *
 * OPERATIONAL. Whatever loop eventually wraps this stops when the API stops,
 * and the thing it executes is a published legal deadline. After an outage
 * somebody has to be able to drain the backlog deliberately and SEE the number
 * — "erased: 3, deferredEscrow: 1" is a sentence an operator can act on.
 *
 * EVIDENTIAL. "Running it twice erases nobody twice" is a claim about a
 * background loop, and untestable through a timer. This makes it two commands
 * and a diff.
 *
 * ACCOUNTABLE. The deferred counts are members whose 30-day promise is
 * currently blocked on a money state the job refuses to resolve (see
 * services/erasure.ts — escrowed deposits, in-flight top-ups, a residual
 * balance). A nonzero deferred count that persists across runs is a member the
 * platform is quietly failing, and this printout is where that becomes visible.
 *
 * Safe to run while the API is up: every decision is re-made under the member
 * row's FOR UPDATE lock, so a manual pass, a future worker's pass, and the
 * top-up settle path serialise rather than race.
 */

import { db } from '../db/client';
import { runErasureOnce } from '../services/erasure';

const result = await runErasureOnce(db);

console.log(JSON.stringify(result, null, 2));

process.exit(0);
