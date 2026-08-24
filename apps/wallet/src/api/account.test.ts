/**
 * The Account slice's two non-negotiables, tested where they can actually fail.
 *
 *   #11  the ticket body carries `topicId` and never `route`
 *   #10  the wallet holds no legal copy of its own
 *
 * The second one is tested as a SOURCE SCAN rather than a render. A render test
 * can only show that a component given no documents draws nothing, which is
 * true of any component; the risk is that someone later adds a bundled fallback
 * set "so the screen isn't empty offline". A scan over the shipped source
 * catches that at the moment it is written, which is the only moment it is
 * cheap to undo.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { localiseDoc, submitTicket } from './account';
import type { LegalDoc } from '@avo/types';

// ------------------------------------------------------------------ #11 ----

describe('submitTicket — routing is the server’s, not the client’s', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureBody(): { read: () => Record<string, unknown> } {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'SUP-48263',
            memberId: '8842',
            member: 'Dana Al-Sabah',
            /*
              Which salon's customer wrote it. `support_ticket.salon_id` is
              `text NOT NULL REFERENCES salon (id)` in the DDL
              (api/drizzle/0019_policies_and_support.sql:103), so it is never
              absent and never null on the wire — hence a bare `IdSchema` with no
              `.nullable()`, and hence a plain string here. It is the value the
              merchant queue's tenancy predicate is built on, and it is on the
              response for that reason rather than for this screen's benefit: the
              wallet never reads it. Present so the fixture is the shape the API
              actually serves, which is the whole reason this spec caught the
              schema widening.
            */
            salonId: 'SAL-AMARA',
            topicId: 'booking',
            /*
              THESE NEXT TWO ARE NOT THE SAME KIND OF THING, and a fixture that
              lets them read as interchangeable teaches the wrong lesson.

                `topic`  is JOINED at read time. It is WORDING, so an admin
                         fixing a typo or adding the Arabic fixes it on every
                         ticket ever raised, including this one.
                `route`  is SNAPSHOTTED onto the row when the ticket is created
                         (api/src/db/schema/legal.ts — "resolved from the topic
                         ON THE SERVER, and SNAPSHOTTED rather than joined").
                         It is a DECISION, frozen, so re-routing a topic
                         tomorrow does not move disputes already sent.

              Both are derived from `topicId` by the server and neither is
              derived from the other — the label does not decide the queue.

              The wording is `booking`'s, verbatim from design/avo-promotions.js
              — the vocabulary's source, which CLAUDE.md names as the reference
              implementation of the shared platform rules. `api/src/db/legalSeed.ts`
              seeds it and `packages/mock` now serves it; all three agree on all
              six topics, ids and both languages, checked by extraction rather
              than by eye. Not retyped and not invented: a label this fixture made
              up would be a plausible-looking string no customer has ever been
              shown.

              THIS FIXTURE USED TO SAY `tp-appt` / 'My appointment' / 'موعدي',
              which existed only in `packages/mock` and which the real API would
              have refused outright — `support_ticket.topic_id` references
              `support_topic` under ON DELETE RESTRICT and no such row is ever
              seeded. Re-anchored onto the real vocabulary in the same change that
              fixed the mock, so this file can no longer be the thing that keeps a
              dead id alive.
            */
            topic: { en: 'An appointment', ar: 'موعد' },
            /*
              `avo`, AND THAT DISAGREES WITH `booking`'s REAL ROUTE ON PURPOSE.
              DO NOT "FIX" IT BACK TO `salon`.

              `booking` is configured salon-routed, and in all three authorities
              at once: design/avo-promotions.js, the `supportTopic` seed in
              api/src/db/legalSeed.ts, and packages/mock. This fixture server
              answers `avo` anyway, because the spec below has to be able to tell
              the real client from a plausible wrong one — a client that resolved
              the route ITSELF from the topic instead of reading the server's
              answer. While the fixture agreed with the configuration, both
              implementations produced `salon` and the spec could not separate
              them: the correct answer and the wrong answer coincided.

              That is not hypothetical, it is this file's second instance. Lane D
              found the first in the API-side #11 spec, where a contradicting-route
              submission would have passed a handler hardcoded to `route: 'avo'`
              because `wallet` is AVO-routed. Same cause both times — a fixture
              that picked a value agreeing with the topic's real configuration.

              So the value is chosen to be one no client-side derivation can
              produce. Reconciling it with the seed would restore the coincidence
              and quietly turn the spec below back into a test of nothing.

              It costs no realism where it matters: #11 is that ROUTING IS THE
              SERVER'S, and the client's whole obligation is to report the answer
              it is given rather than to have an opinion about which answers are
              plausible. A client that only worked when the server agreed with the
              client's own table would be the defect.
            */
            route: 'avo',
            message: 'x',
            ref: '',
            // The charge this dispute is ABOUT, resolved server-side from `ref`.
            // This topic is an appointment question opened with no receipt behind
            // it, so there is no charge to resolve and `null` is what the server
            // serves. Kept null on purpose: these three specs are about routing,
            // and a real id here would read as though one of them asserted the
            // receipt link.
            transactionId: null,
            via: 'wa',
            at: '2026-08-17T10:00:00+03:00',
            status: 'open',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    return { read: () => body };
  }

  it('posts topicId, message, ref and via — and nothing else', async () => {
    const captured = captureBody();
    await submitTicket({
      topicId: 'booking',
      message: 'Can I move Saturday?',
      ref: 'AVO-77219',
      via: 'wa',
    });
    expect(Object.keys(captured.read()).sort()).toEqual(['message', 'ref', 'topicId', 'via']);
  });

  it('never sends a route, which is the whole of non-negotiable #11', async () => {
    const captured = captureBody();
    await submitTicket({ topicId: 'booking', message: 'Hello there', via: 'wa' });
    expect(captured.read()).not.toHaveProperty('route');
  });

  /**
   * The name states the property, because the property is the whole point: not
   * merely that a route comes back, but that the one that comes back is the
   * SERVER'S — provably, because it is one the client had no way to compute. See
   * the fixture's `route` above for why it contradicts the topic's configuration.
   *
   * Complementary to `e2e/support-routing.test.ts` rather than overlapping it.
   * That file drives the SERVER resolving route from `topicId` against the live
   * configuration, in both directions, moving `support_topic.route` in the
   * database to prove the stored answer follows it — so a server hardcode fails
   * there. This drives the CLIENT: it never sends a route, and it surfaces what
   * came back. After this flip a CLIENT hardcode fails here, which is the half
   * that was missing. Neither file can be satisfied by the other's defect.
   */
  it('returns the route the SERVER resolved — one the client could not have derived', async () => {
    captureBody();
    const ticket = await submitTicket({ topicId: 'booking', message: 'Hello there', via: 'wa' });
    expect(ticket.route).toBe('avo');
    expect(ticket.id).toBe('SUP-48263');
  });
});

// ------------------------------------------------------------ localiseDoc ---

function doc(overrides: Partial<LegalDoc> = {}): LegalDoc {
  return {
    id: 'terms',
    scope: 'platform',
    consent: true,
    title: { en: 'Terms & conditions', ar: 'الشروط والأحكام' },
    body: { en: ['1. Contracting parties.'], ar: ['١. أطراف التعاقد.'] },
    ...overrides,
  } as LegalDoc;
}

describe('localiseDoc — the contract’s per-field Arabic fallback', () => {
  it('renders Arabic when the document has it', () => {
    const out = localiseDoc(doc(), 'ar');
    expect(out.title).toBe('الشروط والأحكام');
    expect(out.body).toEqual(['١. أطراف التعاقد.']);
    expect(out.translated).toBe(true);
  });

  it('falls back to English per FIELD, not per document', () => {
    // api-contract.md: an empty `body.ar` is a legitimate state. A translated
    // title over an untranslated body is something the owner console can save.
    const out = localiseDoc(doc({ body: { en: ['1. Contracting parties.'], ar: [] } }), 'ar');
    expect(out.title).toBe('الشروط والأحكام'); // still Arabic
    expect(out.body).toEqual(['1. Contracting parties.']); // fell back
    // `translated: false` is what makes the sheet set the body in the Latin
    // face; Arabic type on English text is a silent substitution.
    expect(out.translated).toBe(false);
  });

  it('never invents a title when the Arabic one is blank', () => {
    const out = localiseDoc(doc({ title: { en: 'Terms & conditions', ar: '   ' } }), 'ar');
    expect(out.title).toBe('Terms & conditions');
  });
});

// ------------------------------------------------------------------ #10 ----

describe('non-negotiable #10 — the wallet holds no legal copy of its own', () => {
  /**
   * Phrases that only ever appear inside a published legal document. Each is
   * lifted from the policy set the API actually serves, so a bundled copy of
   * that set would match; none of them is plausible as UI chrome.
   */
  const CLAUSE_MARKERS = [
    'Contracting parties',
    'deposit insurance',
    'earns no interest',
    'is the controller of your customer data',
    'There is no cash refund',
    'أطراف التعاقد',
    'ضمان الودائع',
    'المتحكم بالبيانات',
  ];

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      if (!/\.(ts|tsx)$/.test(entry)) return [];
      // The scan must not flag itself: the markers are literals in this file.
      if (full.endsWith('account.test.ts')) return [];
      return [full];
    });
  }

  it('ships no clause text anywhere in src/', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(__dirname, '..'))) {
      const contents = readFileSync(file, 'utf8');
      for (const marker of CLAUSE_MARKERS) {
        if (contents.includes(marker)) offenders.push(`${file} → "${marker}"`);
      }
    }
    // If this fails, someone added a bundled fallback policy set. The fix is to
    // delete it, not to extend the allow-list: an empty policy section is the
    // designed behaviour when the API has published nothing.
    expect(offenders).toEqual([]);
  });

  it('has no default document list to fall back to', async () => {
    const module = await import('./account');
    // `getPolicies` is the only source of documents. There is deliberately no
    // exported constant holding any.
    const exported = Object.keys(module);
    expect(exported).toContain('getPolicies');
    expect(exported.some((k) => /DEFAULT_(POLICIES|DOCS)|FALLBACK/i.test(k))).toBe(false);
  });
});
