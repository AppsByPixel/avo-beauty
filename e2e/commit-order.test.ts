/**
 * A RESPONSE MUST NOT BE DISPATCHED BEFORE ITS COMMIT.
 *
 * The defect, the measurement behind it, and — importantly — the three spellings
 * that walk past this check are all in `support/commit-order.ts`'s header. Read
 * that before reading a green run here as "the class is absent". It is not; this
 * file catches the literal spelling.
 *
 * WHY A PINNED LEDGER RATHER THAN `expect(hits).toEqual([])`.
 *
 * There is a live instance today (`DELETE /artists/:id/calendar`) and it is
 * lane A's to fix, not lane D's. An empty-set assertion would go red and stay
 * red, and a permanently red spec is a spec people learn to ignore.
 *
 * `knownBug()` was the obvious alternative and it would have worked — the STATIC
 * assertion fails deterministically today, unlike the behavioural one at ~10% —
 * but it is one-directional in the wrong direction: it reports "still broken" as
 * a pass, so a THIRD instance added tomorrow would be swallowed by the same
 * green tick.
 *
 * So the shape is `PINNED_COMMIT_ORDER`, borrowed wholesale from
 * `permission-census.test.ts`'s `PINNED_COVERAGE`, because it fails in BOTH
 * directions and that is the property that matters here:
 *
 *   - a NEW send-before-commit fails by name, with its file and line
 *   - the LIVE one being FIXED also fails, by name, asking for its line to be
 *     deleted — so the ledger cannot quietly accumulate accepted defects
 *
 * The pin is a defect register with an expiry date, not an exemption list.
 *
 * ==========================================================================
 * THE LEDGER IS EMPTY NOW, AND THAT IS THE EXPIRY DATE ARRIVING
 * ==========================================================================
 * `DELETE /artists/:id/calendar` was the single pinned instance. Lane A fixed it
 * in dev `e4b411a` — the send is outside the transaction, the row is returned
 * from the callback, and the paragraph at `artists.ts:980` now carries lane A's
 * own account of it. The scan reads zero hits, so the line is gone rather than
 * MOVED, and the ledger is empty.
 *
 * DO NOT READ THE EMPTY ARRAY AS THE SHAPE COLLAPSING BACK TO
 * `expect(hits).toEqual([])`, WHICH THE PARAGRAPH ABOVE ARGUED AGAINST. It
 * argued against that assertion *while a live instance existed*, because it would
 * have gone red and stayed red on a defect lane D cannot fix. With no live
 * instance there is nothing for it to be permanently red about, and both halves
 * still do their jobs: `appeared` fails on a new instance by name, `fixed`
 * iterates nothing. An empty register is the state this file was built to reach,
 * not evidence it has stopped working. The `transactionCount()` floor above is
 * what keeps the emptiness meaningful — see its own note.
 *
 * ==========================================================================
 * WHO DELETES A LINE FROM THE LEDGER — AND IT IS NOT THE LANE THAT FIXED IT
 * ==========================================================================
 * This message used to end "in the same commit as the fix", which told lane A to
 * edit this file. `e2e/` is lane D's column (LANES.md § "Lane D — QA"), so the
 * message was instructing another lane to breach the one rule that keeps four
 * worktrees mergeable. Lane A read the brief instead of the test and flagged the
 * conflict, correctly noting that the next person will read the TEST rather than
 * the brief — which is why the message is what changed.
 *
 * THREE REASONS THE COLUMN RULE WINS HERE, and none of them is deference:
 *
 *   1. LANES.md's own resolution test already carves this out. Its clarification
 *      — "could the other lane land its change without touching this file?" —
 *      was written for a test COLOCATED with the code it covers, and ends "if
 *      the suite spans packages or lives in `e2e/`, it is Lane D's". This suite
 *      lives in `e2e/` and reads all of `api/src`. Lane A landed `e4b411a`
 *      without touching this file, which is the test answering itself.
 *
 *   2. A LANE RETIRING ITS OWN PIN ENTRY IS A SELF-CERTIFICATION, and the
 *      both-directions property is what it destroys. The `fixed` half exists to
 *      make somebody who did not write the fix confirm the instance is gone. If
 *      the owning lane deletes the line in the same commit, the confirmation and
 *      the claim are the same act, and the reviewer sees a deletion that reads as
 *      a consequence of the diff rather than a finding about it. That is the
 *      precise mechanism by which a defect register becomes an exemption list —
 *      the thing the paragraph above says this shape exists to prevent.
 *
 *   3. GONE VERSUS MOVED IS NOT A MECHANICAL CALL. The message below distinguishes
 *      them and the distinction needs the scan's output, not the diff's: a hit
 *      whose line number shifted is a line to REPLACE, and a lane reading its own
 *      change is the worst-placed reader to tell the two apart. Lane D ran the
 *      scan against the merged tree and read zero hits before deleting this one.
 *
 * AND THE RED WINDOW IS THE FEATURE, NOT THE COST. The obvious objection to
 * non-atomic is that `dev` carries a red suite between the fix landing and lane D
 * updating the ledger. It does — for one integration cycle — and that red is how
 * lane D LEARNED the fix had landed. Deleting the line atomically would remove the
 * only signal that reaches the QA lane through the suite rather than through
 * somebody remembering to mention it. A ledger that goes quiet when a defect is
 * fixed is a ledger nobody has to read.
 *
 * SO THE PROTOCOL, and the message below now says it: the fixing lane REPORTS to
 * trunk and leaves this file alone. Trunk dispatches lane D, which re-runs the
 * scan and deletes or replaces the line. If a slice ever genuinely needs the
 * coupling atomic, that is trunk carving an explicit exception — not a lane
 * reading a failure message as authority over another lane's column.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitOrderHits,
  hitLine,
  transactionCount,
  type CommitOrderHit,
} from './support/commit-order.js';

/**
 * EVERY response-before-commit in `api/src` TODAY, with the reason it is still
 * here. One line per hit, in the scan's own sorted output format.
 *
 * EMPTY, as of dev `e4b411a`. See the header's § "THE LEDGER IS EMPTY NOW".
 *
 * WHAT WAS HERE, kept as the record rather than as an entry — because the next
 * person to add a line needs the format and the standard of evidence, and both
 * are easier to copy than to reconstruct:
 *
 *   'api/src/routes/artists.ts:1029 reply.send inside transaction opened at 980'
 *
 * `DELETE /artists/:id/calendar`. Lane A shipped the shape on
 * `PUT /artists/{id}/branch` in item 6, caught it on the third int run, fixed
 * that route, and wrote the reason into the same file — and the transaction
 * twelve lines below that paragraph still sent inside itself. Confirmed
 * BEHAVIOURALLY, not inferred: 40 write-then-immediately-reread attempts through
 * a second connection saw the pre-commit value 4 times, and the identical probe
 * against the FIXED sibling saw it 0 times out of 40. That control is what made
 * it a defect report rather than a static-scan opinion, and a new line here is
 * owed the same.
 *
 * Fixed in `e4b411a` by the shape lane A had already applied to the sibling:
 * do the work in the transaction, RETURN the row, let fastify send once the
 * handler's promise — commit included — resolves.
 */
const PINNED_COMMIT_ORDER: string[] = [];

describe('no response is dispatched from inside a transaction', () => {
  const hits = commitOrderHits();
  const live = hits.map(hitLine);

  it('the scan still reads the transactions it is meant to read', () => {
    /**
     * The floor that makes a green run mean something. If `.transaction(`
     * stopped matching — a driver change, a wrapper, a rename — this scan would
     * report zero hits and look like success, which is failure mode four from
     * `perm-census.ts`: silent in both directions. 49 transaction bodies at the
     * time of writing; the assertion is a floor rather than an equality so
     * lane A adding one is not lane D's red.
     */
    expect(
      transactionCount(),
      'the scan found almost no transaction bodies in api/src, so its silence about ' +
        'send-before-commit says nothing. `.transaction(` has probably stopped matching — ' +
        'check for a driver change or a transaction helper in support/commit-order.ts.',
    ).toBeGreaterThanOrEqual(40);
  });

  it('the ledger of send-before-commit sites is exactly what is pinned', () => {
    const appeared = live.filter((l) => !PINNED_COMMIT_ORDER.includes(l));
    const fixed = PINNED_COMMIT_ORDER.filter((l) => !live.includes(l));

    expect(
      appeared,
      'A NEW RESPONSE-BEFORE-COMMIT. This handler calls reply.send() from inside a ' +
        'db.transaction() callback, so fastify writes the response before drizzle sends ' +
        'COMMIT — a client that writes and immediately re-reads on another connection can ' +
        'see the OLD value:\n  ' +
        appeared.join('\n  ') +
        '\n\nTHE FIX, and api/src/routes/artists.ts:736 carries lane A\'s own account of it: ' +
        'return the value from the transaction callback and let fastify send it once the ' +
        'handler\'s promise resolves. Do not add a line to PINNED_COMMIT_ORDER to make this ' +
        'green — the pin is a register of defects being fixed, not an exemption list.\n\n' +
        'AND IF YOU BELIEVE THIS IS A FALSE POSITIVE: the receiver reaching .send() inside ' +
        'the callback is what this matches, so a reply built inside and sent outside is not ' +
        'a hit. Check support/commit-order.ts § DISPATCH before overriding it.',
    ).toEqual([]);

    expect(
      fixed,
      'A PINNED SEND-BEFORE-COMMIT IS GONE — this is good news and it still fails, because ' +
        'a defect register that keeps entries after they are fixed becomes an exemption ' +
        'list:\n  ' +
        fixed.join('\n  ') +
        '\n\nWHO EDITS THIS LEDGER. If you are LANE D: re-run the scan against the merged ' +
        'tree, then delete the line — or REPLACE it if the hit MOVED rather than went away, ' +
        'a line number that shifted, in which case the "appeared" half above named the new ' +
        'number and both edits belong in one commit.\n\n' +
        'IF YOU ARE ANY OTHER LANE: do not edit this file. `e2e/` is lane D\'s column ' +
        '(LANES.md § "Lane D — QA"), and this message told you otherwise until 2026-09-09 — ' +
        'it said "in the same commit as the fix", which is an instruction to breach the one ' +
        'rule that keeps four worktrees mergeable. Land your fix and REPORT this failure to ' +
        'trunk; the red is how lane D learns the fix arrived, and a lane retiring its own ' +
        'pin entry is a self-certification rather than the independent confirmation this ' +
        'half exists to be. The header\'s § "WHO DELETES A LINE FROM THE LEDGER" carries ' +
        'the full argument and the protocol.',
    ).toEqual([]);
  });

  it('every pinned line names a real file and line, not a stale string', () => {
    // A pin whose format drifted from the scan's output would report both halves
    // above forever, which reads as two defects rather than one typo.
    //
    // VACUOUS WHILE THE LEDGER IS EMPTY, and deliberately left that way. The
    // alternative — a floor on `PINNED_COMMIT_ORDER.length`, which is what
    // `permission-census.test.ts` puts under `PINNED_COVERAGE` — would be exactly
    // backwards here: that ledger is a COVERAGE figure and must not shrink, this
    // one is a DEFECT register and empty is the goal. A spec demanding at least
    // one pinned defect would go red the moment the API had none.
    for (const line of PINNED_COMMIT_ORDER) {
      expect(line, `"${line}" is not in the scan's own output format`).toMatch(
        /^api\/src\/[\w/.-]+\.ts:\d+ reply\.(send|hijack) inside transaction opened at \d+$/,
      );
    }
  });
});

// ===========================================================================

/**
 * THE FIVE SPELLINGS — the scan's own limits, executed rather than asserted in
 * prose.
 *
 * `support/commit-order.ts`'s header claims three of five spellings of this
 * defect walk past it. A claim like that is exactly the kind this project has
 * twice found to be false after the fact, so it is run here against the same
 * exported function, through its `root` argument. If somebody strengthens the
 * pattern, these cases say which limits closed — and the header stops being
 * true in a way that shows up red rather than quietly.
 *
 * WRITTEN TO A TEMP DIRECTORY rather than committed as fixture files, so they
 * cannot be picked up by the e2e tsconfig, by the real scan, or by anything else
 * that walks this directory looking for `.ts`.
 */
const FIXTURES: Record<string, string> = {
  // M1 — the literal shape the scan is built for.
  'routes/m1.ts': `
    export function m1(app: any, db: any) {
      app.put('/m1', async (req: any, reply: any) => {
        return db.transaction(async (tx: any) => {
          const [row] = await tx.update(x).set({}).returning();
          return reply.send(row);
        });
      });
    }`,

  // M2 — the dispatch happens in a HELPER called from inside the transaction.
  'routes/m2.ts': `
    export function m2(app: any, db: any) {
      app.put('/m2', async (req: any, reply: any) => {
        return db.transaction(async (tx: any) => {
          const [row] = await tx.update(x).set({}).returning();
          return respondWith(reply, row);
        });
      });
    }
    function respondWith(reply: any, row: any) { return reply.send(row); }`,

  // M3 — the receiver is renamed. Same dispatch, different identifier.
  'routes/m3.ts': `
    export function m3(app: any, db: any) {
      app.put('/m3', async (req: any, res: any) => {
        return db.transaction(async (tx: any) => {
          const [row] = await tx.update(x).set({}).returning();
          return res.send(row);
        });
      });
    }`,

  // M4 — the transaction is opened in a service, with `reply` passed into it.
  'services/m4.ts': `
    export async function disconnectThing(reply: any, id: string) {
      return db.transaction(async (tx: any) => {
        const [row] = await tx.update(x).set({}).where(id).returning();
        return reply.send(row);
      });
    }`,

  // M5 — no reply at all. An out-of-transaction effect ordered before commit.
  'routes/m5.ts': `
    export function m5(app: any, db: any, queue: any) {
      app.put('/m5', async (req: any, reply: any) => {
        const row = await db.transaction(async (tx: any) => {
          const [r] = await tx.update(x).set({}).returning();
          await queue.publish('receipt.ready', { id: r.id });
          return r;
        });
        return reply.send(row);
      });
    }`,
};

describe('the scan catches M1 and M4 and is defeated by M2, M3 and M5', () => {
  const root = mkdtempSync(join(tmpdir(), 'avo-commit-order-'));
  for (const [rel, body] of Object.entries(FIXTURES)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }

  const hits: CommitOrderHit[] = commitOrderHits(root);
  const files = hits.map((h) => h.file.replace(/\\/g, '/'));

  it('reads all five transaction bodies, so a miss is a miss and not an unread file', () => {
    expect(transactionCount(root)).toBe(5);
  });

  it('M1 — a literal reply.send() inside the callback is CAUGHT', () => {
    expect(files).toContain('routes/m1.ts');
  });

  it('M4 — a service-held transaction with reply passed in is CAUGHT, because the root is api/src', () => {
    expect(
      files,
      'M4 is the case that justifies scanning all of api/src rather than api/src/routes. ' +
        'If it is no longer caught, the root has been narrowed and every service-held ' +
        'transaction just went invisible — and this codebase keeps its transactions in services.',
    ).toContain('services/m4.ts');
  });

  it('M2 — a helper doing the send is MISSED, and this is the live risk', () => {
    expect(
      files,
      'M2 is now CAUGHT, which is an improvement — update support/commit-order.ts\'s header, ' +
        'which currently tells the reader it is missed, and note it against ' +
        'api/src/routes/images.ts:275 and :430.',
    ).not.toContain('routes/m2.ts');
  });

  it('M3 — a renamed receiver is MISSED', () => {
    expect(
      files,
      'M3 is now CAUGHT. Update the header: it currently says the scan is blind to a ' +
        'handler that names its reply parameter anything other than `reply`.',
    ).not.toContain('routes/m3.ts');
  });

  it('M5 — a non-reply effect ordered before commit is MISSED, so this scan is not the class', () => {
    expect(
      files,
      'M5 is now CAUGHT, so this scan has grown from one member of the class to two. ' +
        'Update the header, which currently says it matches reply-dispatch only.',
    ).not.toContain('routes/m5.ts');
  });
});
