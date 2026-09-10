/**
 * WHERE A BRANCH MAY COME FROM — the rule `services/branch.ts` states and
 * nothing has ever asserted.  (DECISIONS.md #82)
 *
 * `branch.ts` § THE FIX THAT MUST NOT BE TAKEN:
 *
 *     "letting the client name its branch. A client choosing its branch is a
 *      client choosing its own multiplier — non-negotiable #2 with extra steps.
 *      `supplied` below exists for a branch the SERVER established from an
 *      enrolled device… no route reads a branch from a request body, and none
 *      may start."
 *
 * That last clause was true and unenforced for the life of the file, and device
 * enrolment is precisely the change that makes breaking it look reasonable: the
 * branch is now a real, server-held fact, so passing one along "just for this
 * charge" stops feeling like a violation. It is the same violation. A charge
 * that took a branch from its body would earn whatever multiplier the caller
 * asked for.
 *
 * `money/ledger.test.ts` established this technique in this codebase — grep the
 * source, fail on a re-inlined literal — and `money/revenue.test.ts` reuses it
 * for the revenue expression. This is the same shape for the branch.
 *
 * COMMENTS ARE STRIPPED FIRST, for the reason revenue.test.ts gives at length:
 * the files that matter here discuss the forbidden pattern in prose repeatedly,
 * including the paragraph above, and a guard that a comment can trip is a guard
 * somebody turns off.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('..', import.meta.url).pathname;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** Block and line comments out, string literals left alone. */
function code(file: string): string {
  const src = readFileSync(file, 'utf8');
  let out = '';
  let mode: 'code' | 'block' | 'line' = 'code';
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; } else i += 1;
      continue;
    }
    if (c === '\n') { mode = 'code'; out += '\n'; }
    i += 1;
  }
  return out;
}

const rel = (f: string) => f.slice(SRC.length);
const ROUTES = sources(join(SRC, 'routes'));
const SERVICES = sources(join(SRC, 'services'));

describe('a branch is never read from a request body', () => {
  it('the stripper works, or every assertion here is vacuous', () => {
    expect(ROUTES.length).toBeGreaterThan(20);
    const branchSvc = SERVICES.find((f) => rel(f) === 'services/branch.ts') as string;
    // A sentinel that lives in branch.ts's header comment and nowhere in its
    // code, so a stripper that stopped stripping fails here rather than turning
    // every grep below into a pass.
    expect(readFileSync(branchSvc, 'utf8')).toContain('THE FIX THAT MUST NOT BE TAKEN');
    expect(code(branchSvc)).not.toContain('THE FIX THAT MUST NOT BE TAKEN');
    expect(code(branchSvc)).toContain('export async function resolveBranch');
  });

  /**
   * THREE ROUTES READ A BRANCH FROM A BODY, and all three are CONFIGURATION
   * SCOPE rather than "where this charge happened":
   *
   *   campaigns.ts  which branch a campaign TARGETS
   *   platform.ts   which branch a boost or happy hour APPLIES TO
   *   devices.ts    which branch a till STANDS IN
   *   artists.ts    which branch an ARTIST WORKS AT (migration 0044)
   *
   * Each verifies the id against the caller's own salon, and none of them
   * reaches `resolveBranch` — which is the assertion that actually matters and
   * is the next test. Spelled out as a list rather than pattern-matched so a
   * fourth reader is a failing test and a decision, not a diff nobody notices.
   *
   * `branch.ts` used to claim "no route reads a branch from a request body".
   * Two of these three predate that sentence, so it was false when written; it
   * now states the rule this file enforces instead.
   */
  it('only the four configuration endpoints read a branchId from a body', () => {
    const readers = ROUTES.filter((f) => {
      const c = code(f);
      return c.includes('body.branchId') || c.includes("body['branchId']");
    });
    expect(readers.map(rel).sort()).toEqual([
      'routes/artists.ts',
      'routes/campaigns.ts',
      'routes/devices.ts',
      'routes/platform.ts',
    ]);
  });

  /**
   * THE RULE THAT DECIDES MONEY: no route calls `resolveBranch` at all, so no
   * body-derived value can reach its `supplied` parameter. The branch a charge
   * happened at is settled inside the service layer, from the principal.
   */
  it('no route calls resolveBranch', () => {
    const callers = ROUTES.filter((f) => code(f).includes('resolveBranch('));
    expect(callers.map(rel)).toEqual([]);
  });

  /**
   * EVERY `supplied` BRANCH COMES FROM A ROW THE SERVER HOLDS. Three sources are
   * allowed and each is a different question:
   *
   *   ctx.principal.enrolledBranchId   where the TILL stands — a `device_enrolment`
   *                                    row, keyed on the session's device id. The
   *                                    branch a CHARGE happened at (DECISIONS #82).
   *   a.branchId                       where the ARTIST works — the `artist` row
   *                                    `createBooking` already loaded and checked
   *                                    against the salon. The branch an
   *                                    APPOINTMENT is at (migration 0044).
   *   undefined                        nothing to establish. `services/order.ts`
   *                                    runs under a MEMBER principal — a customer
   *                                    on her own phone, no till.
   *
   * THE TWO NON-UNDEFINED SOURCES ARE NOT INTERCHANGEABLE and are deliberately
   * never reconciled: a customer books at Salmiya and pays at Kuwait City, and
   * both rows are right. The money's branch is the transaction's, which is why
   * `services/reports.ts` filters every money figure on `transaction.branch_id`.
   *
   * What is NOT allowed is anything derived from a request body. The list is
   * short and explicit so a fifth source is a failing test and a decision.
   */
  it('every resolveBranch call site passes nothing or a server-held row', () => {
    const allowed = new Set(['undefined', 'ctx.principal.enrolledBranchId', 'a.branchId']);
    const sites: string[] = [];
    for (const f of SERVICES) {
      // `await resolveBranch(` — the CALL sites. A bare `resolveBranch\(` also
      // matches the function's own declaration in branch.ts, whose third
      // parameter is `supplied?: string | null` and would fail this as though a
      // caller had passed it.
      for (const m of code(f).matchAll(/await resolveBranch\(([^)]*)\)/g)) {
        /**
         * The group is not optional in the pattern, so it always participates -
         * but `RegExpMatchArray` is indexed access and the compiler cannot know
         * that. Read it once and fail on the impossible case rather than assert
         * it away: if this ever throws, the pattern above changed.
         */
        const captured = m[1];
        if (captured === undefined) throw new Error(`no argument list captured in ${rel(f)}`);
        const args = captured.split(',').map((a) => a.trim());
        const supplied = args.length < 3 ? undefined : args[2];
        sites.push(`${rel(f)}: ${supplied ?? '<none>'}`);
        expect(
          supplied === undefined || allowed.has(supplied),
          `${rel(f)} passes ${supplied} as resolveBranch's supplied branch`,
        ).toBe(true);
      }
    }
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * And the field is gone from the charge's own input type, not merely unset by
   * every caller. It was `branchId?: string | undefined` and no caller had ever
   * set it — a door held shut by habit, on the value that decides an earning
   * multiplier.
   */
  it('ChargeInput has no branch field at all', () => {
    const charge = code(SERVICES.find((f) => rel(f) === 'services/charge.ts') as string);
    const iface = charge.slice(charge.indexOf('export interface ChargeInput'));
    expect(iface.slice(0, iface.indexOf('}'))).not.toContain('branchId');
  });

  /**
   * `POST /bookings` already refuses a `branchId` by name rather than ignoring
   * it, which is the stronger shape — a client that sends one is told it was
   * wrong instead of silently getting a different branch. Pinned so the refusal
   * cannot be dropped as redundant.
   */
  it('POST /bookings still refuses a client-supplied branch by name', () => {
    const bookings = code(ROUTES.find((f) => rel(f) === 'routes/bookings.ts') as string);
    expect(bookings).toContain('branch_not_client_supplied');
  });

  /**
   * The charge's branch comes from the principal — a server-held fact — and this
   * is the line that says so. If somebody re-routed it through `input`, the two
   * assertions above could both still pass.
   */
  it('the charge resolves its branch from the principal, not from its input', () => {
    const charge = code(SERVICES.find((f) => rel(f) === 'services/charge.ts') as string);
    expect(charge).toContain('resolveBranch(tx, ctx.principal.salonId, ctx.principal.enrolledBranchId)');
  });
});
