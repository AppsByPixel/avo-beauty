/**
 * NON-NEGOTIABLE #11, IN THE DIRECTION THE EXISTING SPEC CANNOT SEE — AND THE
 * ERASURE OF A CUSTOMER'S OWN WORDS.
 *
 * HOW TO RUN
 *
 *   pnpm install
 *   ./scripts/lane-db.sh d
 *   cd e2e && ../node_modules/.bin/vitest run support-routing.test.ts
 *
 * WHY THIS FILE EXISTS, GIVEN THAT account.test.ts ALREADY COVERS #11
 * -------------------------------------------------------------------
 * It covers half of it. `account.test.ts` submits `topicId: 'wallet'` with
 * `route: 'salon'` in the body and asserts the stored row says `avo`. That is a
 * real assertion and it stays. But ask the standing question — *what would still
 * be green if the guard were absent?* — and the answer is uncomfortable:
 *
 *     route: 'avo',            // hardcoded, ignoring the topic entirely
 *
 * That one-line defect passes `account.test.ts` completely. `wallet` routes to
 * AVO, so the only ticket the suite creates is one whose correct answer and whose
 * wrong answer happen to coincide. The rule is "resolved from `topicId`", and a
 * suite that only ever submits AVO-routed topics never once asks the topic.
 *
 * So the spec below drives EVERY topic in the live configuration, in both
 * directions, and it fails by name on a hardcode in either direction. The
 * salon-routed half is the half with the customer-visible consequence the
 * non-negotiable actually describes — a wallet dispute in the salon's inbox is
 * the AVO→salon leak, and it is `booking`/`visit` that prove the server can still
 * say `salon` at all rather than having quietly stopped reading the column.
 *
 * TWO AUTHORITIES, NOT ONE. The expected topic→route table is parsed out of
 * `design/avo-promotions.js` — the design reference CLAUDE.md names as the source
 * of the shared platform rules — and NOT read back from the API. Asserting that
 * `GET /v1/platform/support` agrees with the server's own database would be the
 * server agreeing with itself; the seed's own `onConflictDoUpdate` comment says
 * `route` is written on purpose so "a fixture drifting from
 * design/avo-promotions.js would make non-negotiable #11 untestable against the
 * real routing table". This file is what makes that drift loud.
 *
 * THE CONTRADICTION IS PROVEN, NOT ASSUMED. Every submission asserts that the
 * route it put in the body genuinely differs from the route it expects back,
 * before it believes the result. A "contradicting" request that accidentally
 * agreed with the server would pass while testing nothing — the same defect as a
 * concurrency control whose two requests never overlapped.
 *
 * PART TWO — ERASURE. The trunk ruling is that the erasure job deletes a
 * member's support tickets outright, because free text is where names and phone
 * numbers actually live and no sweep can prove a scrub of prose.
 * `services/erasure.ts` does delete them. Nothing asserted it, so the ruling was
 * one careless edit from being a comment about code that no longer did it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { precondition } from './support/known-bug.js';
import {
  A_STAFF_FULL,
  B_SCANNER_DEVICE,
  B_STAFF_HANDLE,
  PLATFORM_OWNER_HANDLE,
  SALON_A,
  SALON_B,
  pgDb,
  psql,
  repoRoot,
  runApiDbScriptResult,
  scalar,
  signInDashboard,
  signInMember,
  signInPlatform,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  treq,
} from './support/tenancy-harness.js';

/** This file's member. Nothing else reads or writes her. */
const MEMBER = 'QA-SUP-0001';
const MEMBER_NAME = 'Hessa Al-Fahad';
const MEMBER_PHONE = '+96599777451';

/**
 * The erasure fixture, and a SEPARATE member on purpose.
 *
 * The erasure specs tombstone a member irreversibly — name, phone and password
 * replaced, `erased_at` set. Doing that to the member the routing specs sign in
 * as would make this file's own pass order load-bearing, which is the
 * shared-fixture failure the suite has been bitten by repeatedly. Two members,
 * two jobs.
 */
const DOOMED = 'QA-SUP-0002';
const DOOMED_NAME = 'Munira Al-Harbi';
const DOOMED_PHONE = '+96599777452';

/**
 * A member in ANOTHER SALON, for the queue-boundary specs.
 *
 * Her own row rather than the shared `8842`: the tenancy specs need a ticket that
 * belongs to salon A, and attaching it to a member three other suites sign in as
 * would make this file's teardown their problem.
 */
const OTHER_MEMBER = 'QA-SUP-000A';
const OTHER_MEMBER_NAME = 'Shaikha Al-Ajmi';
const OTHER_MEMBER_PHONE = '+96599777454';

/** The control for the erasure spec: due LATER, so the job must leave her alone. */
const SPARED = 'QA-SUP-0003';
const SPARED_NAME = 'Wadha Al-Enezi';
const SPARED_PHONE = '+96599777453';

let member = '';
let merchant = '';
let scanner = '';
let consoleOwner = '';

// ---------------------------------------------------------------------------
// The independent authority.
// ---------------------------------------------------------------------------

export interface DesignTopic {
  id: string;
  route: 'salon' | 'avo';
}

/**
 * The topic→route table as `design/avo-promotions.js` states it.
 *
 * Scoped to the `topics:` array deliberately. The same object carries a
 * `tickets:` array whose fixtures ALSO have `route` keys, and a regex over the
 * whole file would happily read `SUP-40219`'s route as a topic's and then agree
 * with the database for the wrong reason. The slice ends at the first `]`, which
 * is the end of `topics` because the entries are one per line and contain none.
 */
function designTopics(): DesignTopic[] {
  const source = readFileSync(join(repoRoot, 'design', 'avo-promotions.js'), 'utf8');

  const marker = source.indexOf('topics: [');
  if (marker < 0) {
    throw new Error(
      'design/avo-promotions.js has no `topics: [` array. This file derives the expected ' +
        'routing table from it rather than keeping a copy, so the parse failing is a real ' +
        'signal: either the design reference moved, or it was restructured and this ' +
        'assertion has to be re-pointed rather than deleted.',
    );
  }
  const end = source.indexOf(']', marker);
  const block = source.slice(marker, end);

  const topics: DesignTopic[] = [];
  const entry = /\{\s*id:\s*'([^']+)'\s*,\s*route:\s*'(salon|avo)'/g;
  for (let m = entry.exec(block); m !== null; m = entry.exec(block)) {
    topics.push({ id: m[1]!, route: m[2]! as 'salon' | 'avo' });
  }

  if (topics.length === 0) {
    throw new Error(
      `parsed 0 topics out of design/avo-promotions.js. A zero result here is a claim about ` +
        `this regex, not about the design file. The block it read was:\n${block}`,
    );
  }
  return topics;
}

/** The opposite answer. What a client would have to send to break #11. */
const opposite = (route: 'salon' | 'avo'): 'salon' | 'avo' => (route === 'avo' ? 'salon' : 'avo');

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/**
 * A member, borrowing lane A's own password hash the way `seedSalonB()` does —
 * `hashSecret()` is one function for staff and members, so the hash is portable
 * and cannot drift out of step with the seed the way a pasted constant would.
 */
function seedMember(id: string, name: string, phone: string, salonId = SALON_B): void {
  psql(`
    INSERT INTO member (id, salon_id, name, phone, email, email_verified, password_hash,
                        balance_fils, visits, tier, stamps, policy_version)
    SELECT '${id}', '${salonId}', '${name}', '${phone}', NULL, false,
           s.password_hash, 0, 0, 'bronze', NULL, 3
    FROM staff_user s WHERE s.id = '${A_STAFF_FULL}'
    ON CONFLICT (id) DO UPDATE SET
      name                  = EXCLUDED.name,
      phone                 = EXCLUDED.phone,
      password_hash         = EXCLUDED.password_hash,
      balance_fils          = 0,
      erased_at             = NULL,
      deletion_requested_at = NULL,
      deletion_due_at       = NULL;
  `);
}

/**
 * Delete this file's tickets and members. Ordered: `support_ticket.member_id` is
 * `ON DELETE RESTRICT`, so the tickets have to go first — which is itself the FK
 * that makes the erasure job's ordering load-bearing.
 *
 * `audit_log` IS DELIBERATELY LEFT ALONE, and the first version of this function
 * did try to clear it. `audit_log_no_delete` refuses:
 *
 *     ERROR: audit_log is append-only: DELETE is not permitted on this table
 *     HINT:  Correct a wrong entry by appending a correcting one.
 *
 * Which is the table working. The rows accumulate across runs of this file and
 * that is harmless, because the audit spec below asserts what the rows must NOT
 * contain and that the member id is present — properties every run's row shares,
 * rather than a count that drifts. A teardown that could clear the trail would be
 * a teardown that could hide an erasure that named its subject.
 *
 * `subject_id` carries no foreign key (only `audit_log_subject_idx`), so leaving
 * the rows does not block the member delete.
 */
function dropFixtures(): void {
  psql(`
    DELETE FROM support_ticket
     WHERE member_id IN ('${MEMBER}', '${DOOMED}', '${SPARED}', '${OTHER_MEMBER}');
    DELETE FROM member WHERE id IN ('${MEMBER}', '${DOOMED}', '${SPARED}', '${OTHER_MEMBER}');
  `);
}

/** A ticket written straight to the table, for the specs that are not about submission. */
function insertTicket(
  id: string,
  memberId: string,
  topicId: string,
  message: string,
  salonId = SALON_B,
): void {
  const route = scalar(`select route from support_topic where id='${topicId}'`);
  precondition(
    route === 'salon' || route === 'avo',
    `support_topic '${topicId}' has route "${route}" — the fixture cannot be built`,
  );
  psql(`
    INSERT INTO support_ticket (id, member_id, salon_id, topic_id, route, message, ref, via)
    VALUES ('${id}', '${memberId}', '${salonId}', '${topicId}', '${route}',
            '${message.replace(/'/g, "''")}', '', 'email');
  `);
}

function ticketExists(id: string): boolean {
  return scalar(`select count(*) from support_ticket where id='${id}'`) === '1';
}

/**
 * Give this file's member her ticket budget back.
 *
 * RULE 5'S OTHER HALF LANDED UNDERNEATH THIS FILE, and it is the half this lane
 * reported as missing. `services/supportLimit.ts` allows 5 tickets per 15 minutes
 * and 12 per hour, and -- this is the part that matters here -- it counts
 * `support_ticket` ROWS rather than keeping a separate attempt table. So deleting
 * her tickets IS the reset, the same shape as `resetPinState`.
 *
 * THIS IS NOT DISABLING THE GUARD TO MAKE SPECS PASS. The limiter has its own
 * spec below, which drives the boundary deliberately and asserts the refusal by
 * code. What the specs around it are about is routing, authorship and linking --
 * every one of them needs to submit, and a spec that trips a rate limiter while
 * trying to prove something about routing reports the wrong failure. The reset is
 * a fixture operation; the guard is asserted where it is the subject.
 */
function resetTicketBudget(memberId = MEMBER): void {
  psql(`DELETE FROM support_ticket WHERE member_id = '${memberId}';`);
}

interface ErasureResult {
  candidates: number;
  erased: number;
  deferredBalance: number;
  deferredEscrow: number;
  deferredPendingTopup: number;
  skipped: number;
  failed: number;
}

function runErasureJob(): ErasureResult {
  const res = runApiDbScriptResult('src/jobs/erasure-once.ts', pgDb());
  if (!res.ok) {
    throw new Error(
      `the erasure job failed to run at all.\n--- stdout ---\n${res.stdout}\n` +
        `--- stderr ---\n${res.stderr}`,
    );
  }
  const start = res.stdout.indexOf('{');
  if (start < 0) throw new Error(`the erasure job printed no JSON:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(start));
}

beforeAll(async () => {
  await startTenancyApi();
  dropFixtures();
  seedMember(MEMBER, MEMBER_NAME, MEMBER_PHONE);
  member = await signInMember(SALON_B, MEMBER_PHONE);
  merchant = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  scanner = await signInScanner(SALON_B, B_STAFF_HANDLE, B_SCANNER_DEVICE);
  consoleOwner = await signInPlatform(PLATFORM_OWNER_HANDLE);
}, 120_000);

afterAll(async () => {
  dropFixtures();
  await stopTenancyApi();
});

// ===========================================================================
describe('#11 — the route is resolved from the topic, in both directions', () => {
  /**
   * The routing table itself, against the design reference rather than itself.
   *
   * A FLOOR, NOT AN EQUALITY: AVO can add a topic through the console (once
   * `POST /v1/platform/support/topics` exists) and that must not turn this spec
   * red. What must never happen is a topic the design names going missing, or one
   * changing the queue it lands in.
   */
  it('every topic the design names is served, with the route the design gives it', async () => {
    const expected = designTopics();

    const res = await treq<{ topics?: Array<{ id: string; route: string }> }>(
      'GET',
      '/v1/platform/support',
      { token: member },
    );
    expect(res.status, `GET /v1/platform/support answered ${res.status}: ${res.raw}`).toBe(200);

    const served = new Map((res.body.topics ?? []).map((t) => [t.id, t.route]));
    for (const topic of expected) {
      expect(
        served.get(topic.id),
        `design/avo-promotions.js routes topic "${topic.id}" to ${topic.route}, and the API ` +
          `serves ${served.get(topic.id) ?? '(the topic is missing entirely)'}. The seed's own ` +
          `comment says route is written on purpose so a fixture drifting from the design ` +
          `reference would make #11 untestable — this is that drift.`,
      ).toBe(topic.route);
    }
  });

  /**
   * THE SPEC THIS FILE EXISTS FOR.
   *
   * Every topic, each submitted with the WRONG route in the body, each checked in
   * SQL. Both directions are exercised because the configuration contains both,
   * which the precondition below refuses to assume.
   */
  it('a contradicting route in the body loses to the topic, for every topic and both queues', async () => {
    const expected = designTopics();

    /**
     * The control that makes the rest of the spec mean something. If every topic
     * routed to `avo`, the loop below would pass against a handler that hardcoded
     * `route: 'avo'` — which is precisely the defect this file was written to
     * catch. Both queues have to actually be in play.
     */
    const routes = new Set(expected.map((t) => t.route));
    precondition(
      routes.has('avo') && routes.has('salon'),
      `the topic table only routes to ${[...routes].join(', ')}. With one queue this spec ` +
        `cannot distinguish "resolved from the topic" from "hardcoded to the only value", ` +
        `which is the whole defect it exists to catch.`,
    );

    const observed = new Set<string>();

    for (const topic of expected) {
      const sent = opposite(topic.route);

      // The contradiction, proven rather than assumed.
      precondition(
        sent !== topic.route,
        `the body route and the expected route are both "${sent}" for topic ${topic.id} — ` +
          `this request contradicts nothing and would pass against any implementation`,
      );

      /**
       * Six topics is more than the limiter's five-per-15-minutes, so the budget
       * is returned between submissions. Without this the sixth topic answers 429
       * and the spec reports a rate limit where it means to report a route.
       */
      resetTicketBudget();

      const message = `Route probe for ${topic.id}. ${Date.now()}-${Math.random()}`;
      const res = await treq<{ id?: string; route?: string; topicId?: string }>(
        'POST',
        '/v1/support/tickets',
        {
          token: member,
          body: { topicId: topic.id, message, ref: '', via: 'email', route: sent },
        },
      );

      expect(
        res.status,
        `POST /v1/support/tickets answered ${res.status} for topic ${topic.id}: ${res.raw}`,
      ).toBe(200);
      expect(res.body.id, `no ticket id came back for topic ${topic.id}`).toBeTruthy();

      /**
       * THE ROW, not the response. A handler that answered correctly and stored
       * the client's route would satisfy an assertion on the body and still put
       * her dispute in the wrong queue — the queue is read from the table.
       */
      const stored = scalar(`select route from support_ticket where id='${res.body.id}'`);
      expect(
        stored,
        `topic "${topic.id}" is configured to route to ${topic.route}; the client asked for ` +
          `${sent}; the STORED ticket says ${stored}. ` +
          (stored === sent
            ? 'The client-supplied route won — this is a live non-negotiable #11 violation: a ' +
              'wallet dispute can be routed into a salon inbox by the client that files it.'
            : 'The server resolved neither the topic\'s route nor the client\'s, which means ' +
              'routing is coming from somewhere else entirely.'),
      ).toBe(topic.route);

      // And the response agrees with the row, so the customer is told the truth.
      expect(
        res.body.route,
        `the stored ticket routes to ${stored} but the response told the customer ${res.body.route}`,
      ).toBe(stored);

      observed.add(stored);
    }

    /**
     * Closing the hardcode door from the other side. The loop above asserts each
     * ticket individually; this asserts that the run as a whole actually saw the
     * server say both words. A hardcode of either value cannot get here.
     */
    expect(
      [...observed].sort(),
      'the server never produced both queues across every configured topic, so nothing here ' +
        'distinguishes resolution from a constant',
    ).toEqual(['avo', 'salon']);
  });

  /**
   * THE CONTROL FOR THE SPEC ABOVE, AND THE STRONGEST FORM AVAILABLE.
   *
   * Everything above passed on the first run, which is when the standing question
   * has to be asked: what would still be green if the guard were absent? The loop
   * above answers "not a hardcode of either constant, because both queues
   * appeared". It does NOT answer "the route is read from THIS topic's row" — a
   * handler with the topic→route table baked in as a literal, or one keying off
   * the topic id in a switch, satisfies every assertion so far.
   *
   * The discriminating experiment is to move the configuration and see whether
   * the answer follows. `POST /v1/platform/support/topics/{id}` does not exist
   * yet (see the footer), so the move is made in SQL — which is the same row the
   * console's PATCH will write when Lane A lands it.
   *
   * A handler that read `body.route` fails both halves. A handler with a baked-in
   * table or a hardcoded constant fails the half where the configuration no
   * longer agrees with it. Only a handler that reads `support_topic.route` for
   * the submitted `topicId` passes both.
   *
   * This is deliberately a PERMANENT spec rather than a throwaway code mutation.
   * A control that lives in the suite keeps discriminating on every future run;
   * a patch applied by hand proves it once, for whoever was watching.
   */
  it('the stored route tracks the topic configuration when the configuration moves', async () => {
    const topic = 'booking';
    const original = scalar(`select route from support_topic where id='${topic}'`);
    precondition(
      original === 'salon',
      `this control assumes topic "${topic}" starts salon-routed; it is "${original}"`,
    );

    const file = async (label: string, contradicting: 'salon' | 'avo'): Promise<string> => {
      resetTicketBudget();
      const res = await treq<{ id?: string }>('POST', '/v1/support/tickets', {
        token: member,
        body: {
          topicId: topic,
          message: `Config-tracking probe (${label}). ${Date.now()}-${Math.random()}`,
          ref: '',
          via: 'email',
          route: contradicting,
        },
      });
      expect(res.status, `${label}: POST answered ${res.status}: ${res.raw}`).toBe(200);
      expect(res.body.id, `${label}: no ticket id came back`).toBeTruthy();
      return scalar(`select route from support_ticket where id='${res.body.id}'`);
    };

    try {
      // ---- half one: as configured. salon, against a body asking for avo. ----
      expect(
        await file('as configured', 'avo'),
        `topic "${topic}" is configured salon and the ticket did not land there`,
      ).toBe('salon');

      // ---- move the configuration under the endpoint ----
      psql(`UPDATE support_topic SET route='avo' WHERE id='${topic}';`);
      precondition(
        scalar(`select route from support_topic where id='${topic}'`) === 'avo',
        'the configuration did not move, so the second half of this control is not a control',
      );

      // ---- half two: the answer must have MOVED WITH IT. ----
      expect(
        await file('after the move', 'salon'),
        `topic "${topic}" was re-routed to avo in the configuration and a new ticket still ` +
          `landed in the salon queue. The route is therefore NOT being read from ` +
          `support_topic.route — it is baked into the handler, which means the owner console's ` +
          `re-route will silently do nothing and #11's "resolved server-side from topicId" is ` +
          `true only by coincidence of the seed.`,
      ).toBe('avo');
    } finally {
      psql(`UPDATE support_topic SET route='${original}' WHERE id='${topic}';`);
    }

    // The configuration is back, and so is the behaviour.
    expect(
      scalar(`select route from support_topic where id='${topic}'`),
      'the control did not restore the topic route it moved',
    ).toBe(original);
  });

  /**
   * The dedupe rule is what makes the loop above safe to re-run, and it is worth
   * asserting rather than relying on: each probe message is unique, so rule 5
   * never fires within a run, but two RUNS of this file submit different messages
   * too. If dedupe were keyed on the topic alone the loop would silently assert
   * the same ticket six times.
   */
  it('rule 5 deduplicates an identical message, and does not collapse different ones', async () => {
    resetTicketBudget();
    const message = `Duplicate probe. ${Date.now()}-${Math.random()}`;
    const send = () =>
      treq<{ id?: string }>('POST', '/v1/support/tickets', {
        token: member,
        body: { topicId: 'wallet', message, ref: '', via: 'email' },
      });

    const first = await send();
    const second = await send();
    expect(first.status, `the first submission answered ${first.status}: ${first.raw}`).toBe(200);
    expect(second.status, `the resend answered ${second.status}: ${second.raw}`).toBe(200);
    expect(
      second.body.id,
      'a double-tapped Send opened a second ticket — two reference numbers for one question ' +
        'is a customer told two different things by two different agents',
    ).toBe(first.body.id);

    // The control: a DIFFERENT message must not be swallowed by the dedupe.
    const other = await treq<{ id?: string }>('POST', '/v1/support/tickets', {
      token: member,
      body: { topicId: 'wallet', message: `${message} — and another thing`, ref: '', via: 'email' },
    });
    expect(other.status, `the second question answered ${other.status}: ${other.raw}`).toBe(200);
    expect(
      other.body.id,
      'a different message was folded into the previous ticket, so the dedupe is keyed on ' +
        'something coarser than the message and a customer\'s second question is lost',
    ).not.toBe(first.body.id);
  });

  /**
   * RULE 5'S FIRST HALF: "Rate-limit per member."
   *
   * This lane reported it absent -- there was no limiter and no 429 anywhere in the
   * support routes -- and `services/supportLimit.ts` is the answer. So this spec
   * exists because the gap was reported, and it drives the boundary rather than
   * asserting that a limiter exists somewhere.
   *
   * THE NUMBERS ARE LANE A'S, NOT THE CONTRACT'S. api-contract.md says
   * "Rate-limit per member" and gives no figure, so 5-per-15-minutes is a chosen
   * boundary rather than a specified one. That makes this spec a pin on a decision:
   * if it goes red because the constant moved, that is a conversation about the
   * number, not an automatic defect. Written as a literal on purpose -- importing
   * `TICKET_MAX_PER_WINDOW` would make the spec agree with whatever the code says,
   * which is the tautology `support/api.ts` warns about in its header.
   *
   * DISTINCT MESSAGES, because rule 5's OTHER half would fold identical ones into
   * one ticket and the budget would never be spent. The two halves interact, and
   * this is the spec that proves the limiter is not just the deduplicator wearing
   * a different status code.
   */
  it('rule 5 rate-limits a member after five distinct messages in the window', async () => {
    resetTicketBudget();

    const send = (n: number) =>
      treq<{ id?: string; error?: string; message?: string }>('POST', '/v1/support/tickets', {
        token: member,
        body: {
          topicId: 'other',
          message: `Budget probe ${n}. ${Date.now()}-${Math.random()}`,
          ref: '',
          via: 'email',
        },
      });

    /**
     * THE CONTROL, and it is the half that makes the refusal mean something: all
     * five must be ACCEPTED. A limiter set to 0, a broken topic, or a member who
     * cannot submit at all would produce a 429 on the first call and a spec that
     * only checked the last response would call that a pass.
     */
    for (let n = 1; n <= 5; n += 1) {
      const ok = await send(n);
      expect(
        ok.status,
        `submission ${n} of 5 answered ${ok.status} -- the budget is smaller than the ` +
          `boundary this spec is about, so the refusal below would prove nothing: ${ok.raw}`,
      ).toBe(200);
    }

    const refused = await send(6);
    expect(
      refused.status,
      `the sixth distinct message in the window answered ${refused.status}. Rule 5 asks for a ` +
        `per-member rate limit and five submissions were accepted, so this one had to be ` +
        `refused: ${refused.raw}`,
    ).toBe(429);
    expect(refused.body.error, 'the refusal carries no machine-readable code').toBe(
      'ticket_rate_limited',
    );

    // Assert the system REFUSED, rather than that a count stayed put.
    expect(
      scalar(`select count(*) from support_ticket where member_id='${MEMBER}'`),
      'the refused sixth submission was written anyway',
    ).toBe('5');

    /**
     * And the refusal points at a channel that is still open. A customer disputing
     * a charge who is told only "try again later" has been closed off, which is the
     * wrong shape of refusal for this endpoint specifically.
     */
    expect(
      String(refused.body.message ?? '').toLowerCase(),
      'the rate-limit refusal names no alternative way to reach support',
    ).toContain('whatsapp');
  });

  it('an absent topicId is refused, and nothing is written', async () => {
    const before = scalar(`select count(*) from support_ticket where member_id='${MEMBER}'`);

    const res = await treq<{ error?: string; message?: string }>('POST', '/v1/support/tickets', {
      token: member,
      body: { message: 'No topic at all.', ref: '', via: 'email' },
    });

    expect(res.status, `an absent topicId answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error, 'the refusal carries no machine-readable code').toBe('invalid_request');
    expect(res.body.message, 'the refusal does not name the missing field').toContain('topicId');

    // Assert the REFUSAL, not merely that the response was 400.
    expect(
      scalar(`select count(*) from support_ticket where member_id='${MEMBER}'`),
      'a refused submission still wrote a ticket',
    ).toBe(before);
  });

  it('an inactive topic cannot be reached, even by exact id', async () => {
    /**
     * `active` is not the same door as "unknown". `GET /v1/platform/support`
     * filters on it, so a topic AVO retires disappears from the form — but the id
     * is still in the table and a client that cached the old list still has it.
     * The handler's own lookup filters on `active` too; this is the spec that
     * keeps those two filters in step, because dropping it from the POST would
     * leave a retired queue reachable by anyone who ever loaded the form.
     */
    const probe = 'qa-retired-topic';
    psql(`
      INSERT INTO support_topic (id, route, en, ar, position, active)
      VALUES ('${probe}', 'salon', 'Retired probe topic', 'موضوع متوقف', 9001, false)
      ON CONFLICT (id) DO UPDATE SET active = false, route = 'salon', position = 9001;
    `);

    try {
      precondition(
        scalar(`select active from support_topic where id='${probe}'`) === 'f',
        'the probe topic is not inactive, so this spec is not testing what it claims',
      );

      const res = await treq<{ error?: string }>('POST', '/v1/support/tickets', {
        token: member,
        body: { topicId: probe, message: 'To a retired queue.', ref: '', via: 'email' },
      });

      expect(
        res.status,
        `a retired topic accepted a ticket (${res.status}) — it would land in a queue AVO has ` +
          `stopped staffing, and the customer would be told it was received`,
      ).toBe(400);
      expect(res.body.error).toBe('unknown_topic');
      expect(
        scalar(`select count(*) from support_ticket where topic_id='${probe}'`),
        'a ticket was written against a retired topic',
      ).toBe('0');
    } finally {
      psql(`DELETE FROM support_topic WHERE id='${probe}';`);
    }
  });
});

// ===========================================================================
describe('#11 — who may file a ticket, and as whom', () => {
  /**
   * A ticket carries a member's own words, very often about the merchant. So the
   * gate is not a formality: `requireMember` answers both halves at once, and
   * both halves are asserted here because the endpoint is the one place in the
   * API where a customer's prose enters the system.
   */
  it('a dashboard session cannot file a ticket', async () => {
    const res = await treq<{ error?: string }>('POST', '/v1/support/tickets', {
      token: merchant,
      body: { topicId: 'wallet', message: 'Filed by the merchant.', ref: '', via: 'email' },
    });
    expect(
      res.status,
      `a merchant dashboard session filed a customer support ticket (${res.status}): ${res.raw}`,
    ).toBe(403);
  });

  it('a scanner PIN session cannot file a ticket', async () => {
    const res = await treq<{ error?: string }>('POST', '/v1/support/tickets', {
      token: scanner,
      body: { topicId: 'visit', message: 'Filed from the salon floor.', ref: '', via: 'email' },
    });
    expect(
      res.status,
      `a scanner PIN session filed a customer support ticket (${res.status}) — a complaint about ` +
        `a visit would then be authored on the tablet of the salon it is about: ${res.raw}`,
    ).toBe(403);
  });

  /**
   * A FORGED TOKEN, NOT A MISSING ONE — AND I WROTE IT THE WRONG WAY FIRST.
   *
   * `token: null` does NOT test anonymity here. The suite runs the API with
   * `AVO_TEST_PRINCIPALS=1`, and `auth/principal.ts` resolves a header-less
   * request to the seeded member 8842. So the missing-credential version of this
   * spec went red claiming an unauthenticated caller had filed a ticket as Dana
   * Al-Sabah — which reads exactly like an authentication bypass and is not one.
   * `env.ts` refuses to start with that flag under `NODE_ENV=production`.
   *
   * `console.test.ts` records the same trap on the platform prefix, having also
   * hit it first. Two lanes reaching for `token: null` and getting a convincing
   * false positive is why it is written out again here rather than cross-
   * referenced: the red is a claim about the harness, not about the server.
   *
   * `resolvePrincipal` consults the shim ONLY when there is no bearer at all, so
   * a syntactically-present, cryptographically-invalid token takes the real path
   * and `requirePrincipal` throws 401. That is the assertion that means something.
   */
  it('a forged bearer token cannot file a ticket', async () => {
    /**
     * Unique per run, so the "nothing was written" half is about THIS request.
     * The first draft of this spec used a fixed string, and the run where it was
     * still `token: null` had already inserted a ticket carrying it — so the
     * assertion would have gone red on residue from my own earlier failure and
     * read like a live bypass. A probe that a previous run can satisfy is not a
     * probe.
     */
    const message = `Filed by nobody. ${Date.now()}-${Math.random()}`;

    const res = await treq('POST', '/v1/support/tickets', {
      token: 'not.a.real.token',
      body: { topicId: 'wallet', message, ref: '', via: 'email' },
    });
    expect(res.status, `an invalid credential filed a ticket: ${res.raw}`).toBe(401);

    expect(
      scalar(`select count(*) from support_ticket where message='${message}'`),
      'the refused request still wrote a ticket',
    ).toBe('0');
  });

  /**
   * THE SAME SHAPE AS THE ROUTE, AND THE SAME ANSWER.
   *
   * `route` is not the client's to have an opinion about, and neither is
   * `memberId` — nor `salonId`, which is the same field one level out: a ticket
   * carries the salon whose queue a `salon`-routed message lands in, so a
   * client-supplied one is #11's leak with the topic table bypassed entirely.
   * The handler reads both from the token (`p.id`, `p.salonId`) and there is no
   * body field for either. This spec is what keeps that true, because "accept a
   * memberId so support can file on her behalf" is a plausible-sounding future
   * change that would let anyone put words in any customer's mouth.
   */
  it('memberId and salonId in the body are ignored — the ticket belongs to the token', async () => {
    resetTicketBudget();
    const message = `Authorship probe. ${Date.now()}-${Math.random()}`;
    const foreignSalon = scalar(`select min(id) from salon where id <> '${SALON_B}'`);
    precondition(
      foreignSalon !== '' && foreignSalon !== SALON_B,
      'there is no second salon to attempt the tenancy half of this probe with',
    );

    const res = await treq<{ id?: string }>('POST', '/v1/support/tickets', {
      token: member,
      body: {
        topicId: 'account',
        message,
        ref: '',
        via: 'email',
        // Both spellings of each, because the handler reads none of them and a
        // future one might reach for either convention.
        memberId: DOOMED,
        member_id: DOOMED,
        salonId: foreignSalon,
        salon_id: foreignSalon,
      },
    });
    expect(res.status, `POST /v1/support/tickets answered ${res.status}: ${res.raw}`).toBe(200);

    /**
     * The control this spec needs — "the id in the body is not the id in the
     * token" — is enforced by the COMPILER rather than asserted here. `DOOMED`
     * and `MEMBER` are string literal constants, so `precondition(DOOMED !==
     * MEMBER)` is TS2367: a comparison with no overlap. tsc refusing to compile
     * the day someone points both names at one member is a stronger guarantee
     * than a runtime check that could be deleted with the assertion it guards.
     */
    expect(
      scalar(`select member_id from support_ticket where id='${res.body.id}'`),
      'a client-supplied memberId was honoured — one customer can file a support ticket in ' +
        'another customer\'s name, and the reply goes to the wrong person',
    ).toBe(MEMBER);

    expect(
      scalar(`select salon_id from support_ticket where id='${res.body.id}'`),
      `a client-supplied salonId was honoured — the ticket was filed against ${foreignSalon} ` +
        `instead of the member's own salon, which puts a message into an unrelated merchant's ` +
        `queue without going anywhere near the topic table`,
    ).toBe(SALON_B);
  });

  /**
   * Rule 3, and the reason it is scoped. An unscoped `ref` lookup would let
   * anyone discover whether a receipt number exists by watching whether it
   * linked — an oracle over another salon's transaction ids.
   */
  it('a ref belonging to somebody else is not linked', async () => {
    resetTicketBudget();
    const foreign = scalar(
      `select coalesce(min(id), '') from transaction where member_id <> '${MEMBER}'`,
    );
    precondition(
      foreign !== '',
      'there is no transaction belonging to another member, so the scoping cannot be probed',
    );

    const res = await treq<{ id?: string }>('POST', '/v1/support/tickets', {
      token: member,
      body: {
        topicId: 'charge',
        message: `Foreign ref probe. ${Date.now()}-${Math.random()}`,
        ref: foreign,
        via: 'email',
      },
    });
    expect(res.status, `POST /v1/support/tickets answered ${res.status}: ${res.raw}`).toBe(200);

    expect(
      scalar(
        `select coalesce(transaction_id, '(null)') from support_ticket where id='${res.body.id}'`,
      ),
      `the ticket linked transaction ${foreign}, which belongs to another member — a customer ` +
        `can confirm whether an arbitrary receipt number exists by watching whether it linked`,
    ).toBe('(null)');

    // The ref is still KEPT verbatim: support needs to see what she typed.
    expect(
      scalar(`select ref from support_ticket where id='${res.body.id}'`),
      'the unmatched ref was discarded, so support cannot see the number the customer quoted',
    ).toBe(foreign);
  });
});

// ===========================================================================
/**
 * THE QUEUE READ, WHERE THE TENANCY BOUNDARY IS A PREDICATE AND NOT A PATH.
 *
 * `GET /v1/support/tickets` is shared between the owner console and the merchant
 * dashboard and carries NO salon id in its path. So `requireSameSalon` never runs,
 * and the boundary lives in `queueScope()`'s WHERE clause instead. That is exactly
 * the shape `discoverSalonScopedRoutes()` cannot see — it filters on `/\/salons\/:/`,
 * so this route can never appear in the gap ledger however complete that ledger is.
 * Hence its own assertions, here.
 *
 * THE DESIGN DECISION WORTH ASSERTING, because it is counter-intuitive: a merchant
 * asking for `?route=avo` is REFUSED, not silently narrowed to an empty page. An
 * empty page is a sentence — it says "AVO is holding no tickets about you" — and
 * that is a claim the server must not make to a merchant, because AVO-routed
 * tickets are very often complaints ABOUT her. A filter the caller supplies must
 * not be able to turn the boundary into an answer.
 *
 * A CONSOLE ADMIN GETS NO PREDICATE AT ALL, and the ABSENCE is the difference
 * between the two audiences. So the console specs here are not "the admin sees
 * more" — they are the control that proves the merchant's narrowing is imposed
 * rather than being a property of the data.
 */
describe('the ticket queue — a boundary in the query, not in the path', () => {
  const T_MINE_SALON = 'SUP-QA-91001';
  const T_MINE_AVO = 'SUP-QA-91002';
  const T_THEIRS_SALON = 'SUP-QA-91003';

  beforeAll(() => {
    seedMember(OTHER_MEMBER, OTHER_MEMBER_NAME, OTHER_MEMBER_PHONE, SALON_A);
    resetTicketBudget(OTHER_MEMBER);
    psql(`DELETE FROM support_ticket WHERE id IN ('${T_MINE_SALON}','${T_MINE_AVO}','${T_THEIRS_SALON}');`);

    // Hers, salon-routed — the one row a merchant is entitled to.
    insertTicket(T_MINE_SALON, MEMBER, 'booking', 'Can I move Saturday?', SALON_B);
    // Hers by salon, AVO-routed — a wallet dispute she must NOT see.
    insertTicket(T_MINE_AVO, MEMBER, 'wallet', 'My top-up has not arrived.', SALON_B);
    // Another salon's, salon-routed — visible to THAT merchant, not this one.
    insertTicket(T_THEIRS_SALON, OTHER_MEMBER, 'visit', 'The service was rushed.', SALON_A);
  });

  /**
   * The precondition that stops every spec below being vacuous. "The merchant sees
   * only her own" proves nothing if the only ticket in the table is her own.
   */
  it('the fixture actually contains the rows the boundary has to exclude', () => {
    expect(
      scalar(`select route || '/' || salon_id from support_ticket where id='${T_MINE_AVO}'`),
      'the AVO-routed fixture is not AVO-routed, so the route half of the boundary is untested',
    ).toBe(`avo/${SALON_B}`);
    expect(
      scalar(`select route || '/' || salon_id from support_ticket where id='${T_THEIRS_SALON}'`),
      'the other-salon fixture is not in another salon, so the tenancy half is untested',
    ).toBe(`salon/${SALON_A}`);
  });

  it('a merchant sees her own salon-routed tickets and nothing else', async () => {
    const res = await treq<{ items?: Array<{ id: string; route: string; salonId?: string }>; total?: number }>(
      'GET',
      '/v1/support/tickets',
      { token: merchant },
    );
    expect(res.status, `the queue answered ${res.status} to a merchant: ${res.raw}`).toBe(200);

    const ids = (res.body.items ?? []).map((t) => t.id);
    expect(ids, 'the merchant cannot see her own salon-routed ticket').toContain(T_MINE_SALON);
    expect(
      ids,
      'AN AVO-ROUTED TICKET IS VISIBLE TO THE MERCHANT. Rule 2: "Salon-routed tickets are ' +
        'visible to the merchant; AVO-routed ones are not." This one is a wallet dispute, ' +
        'which is very often a complaint about her.',
    ).not.toContain(T_MINE_AVO);
    expect(
      ids,
      'ANOTHER SALON\'S TICKET IS VISIBLE. The boundary is in the query rather than the path, ' +
        'so nothing in the salon-scope ledger can catch this.',
    ).not.toContain(T_THEIRS_SALON);

    // Every row that came back, not just the ones the fixture named.
    for (const t of res.body.items ?? []) {
      expect(t.route, `ticket ${t.id} reached the merchant with route "${t.route}"`).toBe('salon');
    }

    /**
     * THE COUNT IS SCOPED TOO. `total` is computed for the pager, and a total built
     * without the predicate leaks the size of queues the caller cannot read — "37
     * tickets" over one visible row tells a merchant exactly how much is being
     * withheld about her.
     */
    const visible = Number(
      scalar(
        `select count(*) from support_ticket where salon_id='${SALON_B}' and route='salon'`,
      ),
    );
    expect(
      res.body.total,
      `total is ${res.body.total} where ${visible} rows are within the merchant's scope — a ` +
        `count computed without the predicate discloses the queues she cannot read`,
    ).toBe(visible);
  });

  it('a merchant asking for the AVO queue is refused, not handed an empty page', async () => {
    const res = await treq<{ error?: string }>('GET', '/v1/support/tickets?route=avo', {
      token: merchant,
    });
    expect(
      res.status,
      `?route=avo from a merchant answered ${res.status}. 200 with an empty list would be the ` +
        `server telling her AVO holds no tickets about her, which is a claim it must not make; ` +
        `a client-supplied filter must not be able to answer the question the boundary hides: ` +
        `${res.raw}`,
    ).toBe(403);
  });

  it('a merchant asking for another salon is refused', async () => {
    const res = await treq<{ error?: string }>(
      `GET`,
      `/v1/support/tickets?salon=${SALON_A}`,
      { token: merchant },
    );
    expect(
      res.status,
      `?salon=${SALON_A} from a merchant answered ${res.status}: ${res.raw}`,
    ).toBe(403);
  });

  it('an unknown route value is refused by name rather than ignored', async () => {
    const res = await treq<{ error?: string }>('GET', '/v1/support/tickets?route=banana', {
      token: merchant,
    });
    expect(res.status, `?route=banana answered ${res.status}: ${res.raw}`).toBe(400);
    expect(res.body.error).toBe('invalid_route');
  });

  /**
   * THE CONTROL FOR ALL THREE ABOVE. The merchant's narrowing has to be something
   * the SERVER imposes, not something the data happens to look like. A console
   * admin holding `policies` gets no predicate, so all three rows are reachable —
   * which is what makes the merchant's two exclusions meaningful.
   */
  it('a console admin gets no predicate at all — both routes, both salons', async () => {
    const res = await treq<{ items?: Array<{ id: string }> }>('GET', '/v1/support/tickets', {
      token: consoleOwner,
    });
    expect(res.status, `the queue answered ${res.status} to the console owner: ${res.raw}`).toBe(200);

    const ids = (res.body.items ?? []).map((t) => t.id);
    for (const [id, what] of [
      [T_MINE_SALON, 'a salon-routed ticket'],
      [T_MINE_AVO, 'the AVO-routed ticket'],
      [T_THEIRS_SALON, "another salon's ticket"],
    ] as const) {
      expect(
        ids,
        `the console cannot see ${what} (${id}). If the console is scoped like a merchant then ` +
          `AVO support cannot read its own queue, and the merchant exclusions above prove ` +
          `nothing about the boundary.`,
      ).toContain(id);
    }
  });

  it('a member cannot read the staffed queue at all', async () => {
    const res = await treq('GET', '/v1/support/tickets', { token: member });
    expect(
      res.status,
      `a customer read the staffed support queue (${res.status}) — it holds other customers\' ` +
        `messages: ${res.raw}`,
    ).toBe(403);
  });

  /**
   * 404, NOT 403, AND THE DIFFERENCE IS THE POINT. A 403 confirms that a ticket
   * with that id exists and is being handled somewhere she cannot see. For an
   * AVO-routed complaint about her own salon, that confirmation is the fact rule 2
   * exists to withhold.
   */
  it('a merchant reaching an invisible ticket gets 404, and cannot change it', async () => {
    for (const [id, what] of [
      [T_MINE_AVO, 'an AVO-routed ticket in her own salon'],
      [T_THEIRS_SALON, "another salon's ticket"],
    ] as const) {
      const before = scalar(`select status from support_ticket where id='${id}'`);

      const res = await treq<{ error?: string }>('PATCH', `/v1/support/tickets/${id}`, {
        token: merchant,
        body: { status: 'closed' },
      });

      expect(
        res.status,
        `PATCH on ${what} (${id}) answered ${res.status}. 403 would confirm the ticket exists, ` +
          `which is exactly what a merchant must not learn about a complaint routed past her: ` +
          `${res.raw}`,
      ).toBe(404);
      expect(res.body.error).toBe('unknown_ticket');

      // The refusal, asserted as a refusal.
      expect(
        scalar(`select status from support_ticket where id='${id}'`),
        `the merchant could not read ${id} but still changed its status`,
      ).toBe(before);
    }
  });

  it('and she CAN close the one that is hers — or the 404s above prove nothing', async () => {
    const res = await treq<{ status?: string }>('PATCH', `/v1/support/tickets/${T_MINE_SALON}`, {
      token: merchant,
      body: { status: 'closed' },
    });
    expect(
      res.status,
      `the merchant could not close her OWN salon-routed ticket (${res.status}), so every 404 ` +
        `above may simply be a broken endpoint rather than a boundary: ${res.raw}`,
    ).toBe(200);
    expect(
      scalar(`select status from support_ticket where id='${T_MINE_SALON}'`),
      'the close was answered but not stored',
    ).toBe('closed');
  });
});

// ===========================================================================
describe('erasure takes the customer\'s own words with her', () => {
  /**
   * THE TRUNK RULING, ASSERTED.
   *
   * `support_ticket.message` is free text a customer wrote. Names, phone numbers
   * and "my sister Noura booked for me" live in prose, and no column sweep can
   * prove a scrub of prose — so the ruling is deletion, not redaction.
   * `services/erasure.ts` deletes them. Nothing asserted it until now, which left
   * the ruling one careless edit away from being a comment about code that no
   * longer did it.
   */
  it('the erasure job deletes her tickets, and spares a member who is not due', async () => {
    seedMember(DOOMED, DOOMED_NAME, DOOMED_PHONE);
    seedMember(SPARED, SPARED_NAME, SPARED_PHONE);

    const doomedTicket = 'SUP-QA-90001';
    const doomedSecond = 'SUP-QA-90002';
    const sparedTicket = 'SUP-QA-90003';
    insertTicket(doomedTicket, DOOMED, 'account', `My name is ${DOOMED_NAME}, please delete me.`);
    insertTicket(doomedSecond, DOOMED, 'booking', `Call me on ${DOOMED_PHONE} about Saturday.`);
    insertTicket(sparedTicket, SPARED, 'wallet', 'My top-up has not arrived.');

    // Due yesterday for one, next month for the other.
    psql(`
      UPDATE member SET deletion_requested_at = now() - interval '31 days',
                        deletion_due_at       = now() - interval '1 day'
       WHERE id = '${DOOMED}';
      UPDATE member SET deletion_requested_at = now(),
                        deletion_due_at       = now() + interval '30 days'
       WHERE id = '${SPARED}';
    `);

    // The preconditions. Every one of these would make the spec vacuous.
    precondition(ticketExists(doomedTicket), 'the erasure fixture has no ticket to delete');
    precondition(ticketExists(doomedSecond), 'the erasure fixture has only one ticket');
    precondition(ticketExists(sparedTicket), 'the control member has no ticket to keep');
    precondition(
      scalar(`select balance_fils from member where id='${DOOMED}'`) === '0',
      'the doomed member has a balance, so the job will defer her and delete nothing',
    );
    precondition(
      scalar(`select coalesce(erased_at::text,'') from member where id='${DOOMED}'`) === '',
      'the doomed member is already erased, so this run proves nothing',
    );

    const result = runErasureJob();

    // A FLOOR, NOT AN EQUALITY: other suites' members may also be due.
    expect(
      result.erased,
      `the erasure job erased ${result.erased} members with a due candidate present. ` +
        `Full result: ${JSON.stringify(result)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(
      result.failed,
      `the erasure job reported ${result.failed} failures: ${JSON.stringify(result)}`,
    ).toBe(0);

    // She was erased at all.
    expect(
      scalar(`select name from member where id='${DOOMED}'`),
      'the member was not tombstoned, so the rest of this spec is about a run that skipped her',
    ).toBe('Deleted account');

    // ---- the ruling ----
    expect(
      ticketExists(doomedTicket),
      'the erased member\'s support ticket survived her. `support_ticket.message` is her own ' +
        'prose — the trunk ruling is deletion precisely because no sweep can prove a scrub of ' +
        'free text, so a surviving row is the erasure failing at the one table where redaction ' +
        'is not an option.',
    ).toBe(false);
    expect(ticketExists(doomedSecond), 'a second ticket survived the erasure').toBe(false);
    expect(
      scalar(`select count(*) from support_ticket where member_id='${DOOMED}'`),
      'tickets remain against the erased member by any route',
    ).toBe('0');

    /**
     * WHO DELETED THEM, established rather than inferred.
     *
     * "The rows are gone" and "the erasure job deleted them" are different
     * claims, and the specs above only support the first. The job counts what it
     * deletes from `returning().length` and writes the tally into its audit
     * detail, so the tally is the job's own signed statement about its own
     * work — and `supportTickets: 2` can only have been produced by the delete
     * that removed exactly these two rows.
     *
     * An EQUALITY is right here, unusually: these are this file's own disposable
     * member's tickets, created three statements ago, and no other suite can add
     * to her. The floors-not-equalities rule is about fixtures that accumulate.
     */
    const detail = scalar(`
      select coalesce(string_agg(detail, ' ||| '), '')
        from audit_log
       where subject_type='member' and subject_id='${DOOMED}' and action='Account erased'
    `);
    expect(
      detail,
      `the erasure's audit detail does not report the support tickets it deleted. Detail: ` +
        `${detail || '(no "Account erased" row at all)'}`,
    ).toMatch(/supportTickets: 2\b/);

    /**
     * THE CONTROL. Without it, "the tickets are gone" is equally consistent with
     * a job that empties the table, a teardown that ran early, or a fixture that
     * never inserted. The spared member's ticket proves the deletion was
     * SELECTED rather than general.
     */
    expect(
      ticketExists(sparedTicket),
      'a member whose 30 days have not elapsed lost her support ticket — the erasure job is ' +
        'deleting tickets it was not asked to delete',
    ).toBe(true);
    expect(
      scalar(`select name from member where id='${SPARED}'`),
      'a member who is not due was tombstoned',
    ).toBe(SPARED_NAME);
  });

  /**
   * The other half of the brief's question: nothing downstream resurrects her
   * name or breaks on the missing reference.
   *
   * The erasure writes an audit row on purpose and its header is explicit that it
   * must carry NO name and NO phone — "an append-only row naming her would
   * outlive the erasure and defeat it". The ticket counts go in that row, which
   * is the one place a careless edit would put her words back.
   */
  it('the audit trail records the deletion without reprinting her name, phone, or words', () => {
    const rows = scalar(`
      select coalesce(string_agg(detail || ' :: ' || coalesce(metadata::text,''), ' ||| '), '')
        from audit_log
       where subject_type='member' and subject_id='${DOOMED}'
    `);

    precondition(
      rows !== '',
      'the erasure wrote no audit row for the member it erased, so there is no trail to check ' +
        '— an erasure with no record of having happened is its own defect',
    );

    expect(
      rows.includes(DOOMED_NAME),
      `the erasure's audit row names the member it erased (${DOOMED_NAME}). audit_log is ` +
        `append-only, so a row naming her outlives the erasure and defeats it.`,
    ).toBe(false);
    expect(
      rows.includes(DOOMED_PHONE),
      'the erasure\'s audit row carries the phone number it just scrubbed',
    ).toBe(false);
    expect(
      rows.toLowerCase().includes('please delete me'),
      'the erasure\'s audit row quotes the support message it just deleted',
    ).toBe(false);

    // The member id IS expected — the ledger keeps it for seven years anyway.
    expect(
      rows.includes(DOOMED),
      'the audit row does not identify which member was erased, so the trail cannot be followed',
    ).toBe(true);
  });

  /**
   * The missing reference, from the merchant's side.
   *
   * The tickets are gone and the member row survives as a tombstone. Anything
   * that reads tickets must not break on either. There is no queue endpoint yet
   * (`GET /v1/support/tickets` is unimplemented — see the file footer), so the
   * reachable assertion is the join the queue will do: it must resolve, and it
   * must not produce her name.
   */
  it('the join a ticket queue will make still resolves after an erasure', () => {
    const joined = scalar(`
      select coalesce(string_agg(t.id || '=' || m.name, ', '), '(no rows)')
        from support_ticket t
        join member m on m.id = t.member_id
       where t.member_id in ('${DOOMED}', '${SPARED}')
    `);

    // Her rows are gone, so only the spared member's ticket can appear.
    expect(
      joined.includes(DOOMED_NAME),
      'the ticket→member join reproduces the erased member\'s name',
    ).toBe(false);
    expect(
      joined,
      'the surviving control ticket does not resolve through the join, so a queue reading ' +
        'tickets would drop or fail on it',
    ).toContain(SPARED_NAME);
  });
});

// ===========================================================================
/**
 * WHAT THE CONTRACT SPECIFIES AND THE ROUTES DO NOT SERVE — computed, not listed.
 *
 * This suite's brief was wrong about which support endpoints exist, because it
 * was read from `api-contract.md` instead of from the route registrations. Trunk
 * recorded that as the fifth instance of one mistake in a single session and
 * named the preventing habit: *grep the route registrations before believing an
 * endpoint exists.* One command.
 *
 * A habit nobody runs is a comment. So this is that command, as a spec — and it
 * derives BOTH sides from source rather than holding a list of six paths that
 * would itself go stale the moment one landed. The contract says what should
 * exist; the routes say what does; the spec asserts the difference is empty.
 *
 * IT WAS A `knownBug()` AND IT IS NOT ANY MORE, WHICH IS THE MECHANISM WORKING.
 * When this file was written the difference was six endpoints, so the spec was
 * written as a self-expiring one: the assertion the contract demands, failing
 * today, reported green, and going RED the hour it started passing. Lane A landed
 * all six (in a new `routes/support.ts`) and it went red on the next run with
 * "This bug appears to be FIXED" — so it is a plain `it()` now, holding the
 * property permanently rather than announcing a gap.
 *
 * A gap that announces its own closing is the only kind that does not rot into a
 * false footnote, which is precisely how this file's brief came to be wrong in the
 * first place.
 */
describe('support endpoints — the contract against the routes', () => {
  /** `{id}` in the contract, `:id` in Fastify. Compared shape-wise, not verbatim. */
  const normalisePath = (p: string): string =>
    p.replace(/\{[^}]+\}/g, ':p').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p');

  /** Every `METHOD /v1/…` line in the contract's Support section. */
  function specifiedSupportEndpoints(): string[] {
    const md = readFileSync(join(repoRoot, 'design', 'api-contract.md'), 'utf8');
    const start = md.indexOf('### SupportConfig + SupportTicket');
    if (start < 0) {
      throw new Error(
        'api-contract.md has no "### SupportConfig + SupportTicket" heading. This spec derives ' +
          'the expected endpoint set from that section rather than keeping a copy, so a failed ' +
          'parse means the contract was restructured and this must be re-pointed, not deleted.',
      );
    }
    const section = md.slice(start, md.indexOf('\n### ', start + 1));

    const found = new Set<string>();
    // `DELETE/v1/…` appears with no space in the contract, hence `\s*`.
    for (const m of section.matchAll(/^(GET|POST|PUT|PATCH|DELETE)\s*(\/v1\/[^\s?]+)/gm)) {
      found.add(`${m[1]} ${normalisePath(m[2]!)}`);
    }
    if (found.size === 0) {
      throw new Error(
        `parsed 0 endpoints out of the contract's Support section. A zero result is a claim ` +
          `about this regex, not about the contract. The section read:\n${section}`,
      );
    }
    return [...found].sort();
  }

  /** Every route lane A actually registers. The same mechanism as the gap ledger. */
  function registeredEndpoints(): Set<string> {
    const dir = join(repoRoot, 'api', 'src', 'routes');
    const re = /app\.(get|post|put|patch|delete)[^(]*\(\s*'([^']+)'/g;
    const found = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const m of source.matchAll(re)) {
        found.add(`${m[1]!.toUpperCase()} ${normalisePath(m[2]!)}`);
      }
    }
    if (found.size === 0) {
      throw new Error(
        'parsed 0 registered routes out of api/src/routes. A zero result is a claim about this ' +
          'regex — the same class of mistake as a zsh-eaten --include making a grep look clean.',
      );
    }
    return found;
  }

  it('every support endpoint api-contract.md specifies is actually registered', () => {
    const specified = specifiedSupportEndpoints();
    const registered = registeredEndpoints();

    // The control: the two endpoints that DO exist must be found by this
    // mechanism, or an empty/mis-parsed `registered` set would report all eight
    // missing, which would read as a catastrophic regression rather than a broken
    // regex. This is the check that tells those two apart.
    precondition(
      registered.has('GET /v1/platform/support') && registered.has('POST /v1/support/tickets'),
      'the route parser cannot even find the two support endpoints that exist, so its verdict ' +
        'on the others is worthless',
    );
    precondition(
      specified.length >= 8,
      `the contract parser found only ${specified.length} support endpoints; it found 8 when ` +
        `this spec was written, so something has been missed`,
    );

    const missing = specified.filter((e) => !registered.has(e));

    expect(
      missing,
      `${missing.length} endpoint(s) specified in api-contract.md §§ 555–586 are registered ` +
        `nowhere in api/src/routes:\n  ${missing.join('\n  ')}\n\n` +
        `A specified endpoint that is registered nowhere is a console control with no server ` +
        `behind it, which is how a screen full of dead buttons gets built.`,
    ).toEqual([]);
  });
});

/**
 * WHEN THOSE SIX LAND, TWO NEED MORE THAN A GATE PROBE. The reasoning is recorded
 * now so it is not re-derived later:
 *
 * `GET /v1/support/tickets?route=` IS SHARED BETWEEN OWNER AND MERCHANT AND IS
 * NOT SALON-SCOPED IN ITS PATH. So its tenancy boundary lives in the query
 * string, not in `requireSameSalon`, and `discoverSalonScopedRoutes()` cannot see
 * it — that census derives from `/salons/{id}/…` path shapes. It needs its own
 * assertion rather than an entry in that ledger: a merchant must see their own
 * salon's `salon`-routed tickets and NOTHING else — never an AVO-routed ticket
 * (rule 2: "AVO-routed ones are not" visible to the merchant), never another
 * salon's. The interesting failure is not a missing filter but a filter the
 * CLIENT supplies: `?route=avo` from a merchant token must not widen what they
 * can see, which is non-negotiable #11's shape a second time — the client naming
 * the queue it wants.
 *
 * TOPIC REORDER IS THE DOUBLE-SUBMIT SHAPE. `support_topic_position_uq` is a
 * unique index on `position`, so two admins dragging topics collide in the
 * database whatever the handler does. When that spec is written, the two requests
 * must be proven to have OVERLAPPED rather than assumed to have raced —
 * `runApiDbScriptAsync`'s header makes the same point about the no-show job, and
 * the standing counter-example is a "concurrency" control that measured
 * −0.003 ms between two requests that were actually sequential.
 *
 * ALSO UNIMPLEMENTED, AND NOT AN ENDPOINT: rule 5's first half. The contract says
 * "Rate-limit per member. Deduplicate an identical message inside 5 minutes." The
 * dedupe is built and asserted above. There is no rate limit — no `429` and no
 * limiter anywhere in `routes/platform.ts` — so a member can open unlimited
 * distinct tickets as fast as she can post them. Reported to trunk rather than
 * left as a red spec, because it is a production gap and this lane's column is
 * tests.
 */
