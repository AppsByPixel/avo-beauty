/**
 * The mock's DATA, checked against the design bundle it claims to imitate.
 *
 * WHY THIS FILE EXISTS. `server.ts`'s header promises that "a contract change
 * breaks the mock's own typecheck — the mock cannot silently drift from what the
 * real API will return." That is true of SHAPES and false of DATA. Ids and copy
 * are strings; no type will ever notice them diverging.
 *
 * It had already happened, unnoticed, for the whole build: the mock served the
 * support topics as `tp-appt` / `tp-visit` / `tp-wallet` / `tp-charge` /
 * `tp-account` — five invented ids, none of which exist in the real database,
 * with different wording and no `other` at all. `support_ticket.topic_id`
 * references `support_topic` under `ON DELETE RESTRICT`, so the wallet's
 * Contact-us form worked against this mock and **would have been refused by the
 * real API on every topic**. A mock that teaches a client ids the server has
 * never heard of is worse than no mock, because the failure surfaces only after
 * the client is finished.
 *
 * Nothing could have caught it. `e2e` drives the real seed and the design file,
 * which agree with each other, so the drift was invisible to the one suite that
 * spans both surfaces. The mock was the only disagreeing party and nothing
 * asserted the mock against anything. Lane B found it by going to the design
 * file to check whether a comment it was writing was true rather than plausible.
 *
 * So this asserts the claim rather than trusting the habit — the lesson this
 * build keeps re-learning: make it executable and it fails by name when it stops
 * being true.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { artists, products, services, support } from './fixtures.js';

/**
 * `design/avo-promotions.js` is the vocabulary's source. `api/src/db/seed.ts`
 * seeds from the same list, and this fixture is the third party that must
 * follow it — read as TEXT rather than imported, because it is a design
 * artefact outside this package and importing it would make the mock depend on
 * the bundle at runtime.
 */
const DESIGN = fileURLToPath(new URL('../../../design/avo-promotions.js', import.meta.url));

type Topic = { id: string; route: string; en: string; ar: string };

function topicsFromDesign(): Topic[] {
  const src = readFileSync(DESIGN, 'utf8');
  const block = /topics\s*:\s*\[(.*?)\]/s.exec(src);
  if (!block) throw new Error(`no topics array in ${DESIGN} — has the design bundle changed shape?`);
  const body = block[1] ?? '';
  return [...body.matchAll(/\{[^}]*\}/g)].map((m) => {
    const entry = m[0];
    const pick = (k: string): string => {
      const found = new RegExp(`${k}:\\s*'([^']*)'`).exec(entry)?.[1];
      // Throwing rather than defaulting: a topic missing a field means the
      // design's shape changed, and a silent '' would let this suite compare
      // two sets of empty strings and call them equal.
      if (found === undefined) throw new Error(`topic entry has no ${k}: ${entry}`);
      return found;
    };
    return { id: pick('id'), route: pick('route'), en: pick('en'), ar: pick('ar') };
  });
}

describe('the mock serves the design bundle’s support topics', () => {
  /**
   * THE KNOWN-POSITIVE, and it is not ceremony. A regex that silently matched
   * nothing would "prove" agreement by finding no disagreement — the exact
   * failure mode that makes a check theatre, and one this build has been caught
   * by four times (a `LIKE` wildcard, a zsh-eaten glob, `git diff` skipping
   * untracked files, a greedy `sed`). Assert the extractor found something
   * before believing what it did not find.
   */
  it('extracts a non-empty topic list from the design file', () => {
    const design = topicsFromDesign();
    expect(design.length, 'the design parser matched nothing — fix the parser, not the fixture').toBeGreaterThan(0);
    expect(support.topics.length, 'the fixture has no topics').toBeGreaterThan(0);
  });

  it('agrees on every id, route and both languages', () => {
    const design = topicsFromDesign();
    const key = (t: Topic) => `${t.id} | ${t.route} | ${t.en} | ${t.ar}`;
    // Sorted, because order is `position` in the database and is not this
    // file's claim to make — the SET must match, not the sequence.
    expect(support.topics.map((t) => key(t as Topic)).sort()).toEqual(design.map(key).sort());
  });

  /**
   * Stated separately from the equality above so a failure says WHICH property
   * broke. A route is what non-negotiable #11 resolves a ticket by, so a mock
   * that disagrees on one teaches a client the wrong queue.
   */
  it('agrees on the route of every topic, which is what #11 resolves by', () => {
    const byId = new Map(topicsFromDesign().map((t) => [t.id, t.route]));
    for (const t of support.topics as Topic[]) {
      expect(byId.get(t.id), `topic "${t.id}" is not in the design bundle at all`).toBeDefined();
      expect(t.route, `topic "${t.id}" routes to the wrong queue in the mock`).toBe(byId.get(t.id));
    }
  });
});

/**
 * ROUND-TRIPPING IDS, CHECKED AGAINST THE REAL SEED.
 *
 * The topics above are checked against the DESIGN bundle, because the design
 * names them. Artists, services and products it does not — `grep -ohE "AR-[0-9]+"
 * design/` is empty — so for these the operative authority is the database the
 * client will actually meet. The mock imitates the real API; where the design is
 * silent, the seed is what "correct" means.
 *
 * WHY THESE THREE AND NOT EVERY FIXTURE. An id matters here when the client sends
 * it BACK. `artistId` and `serviceId` go to `POST /bookings` (routes/bookings.ts:96)
 * and `GET /artists/{id}/availability`; a product id goes to `POST /orders`. A
 * transaction id is only ever read, so an invented `TX-8511` misleads nobody.
 * That is the same test the support topics failed: `support_ticket.topic_id` is a
 * foreign key under ON DELETE RESTRICT, so an invented id was refused on arrival.
 *
 * This found a live one on 2026-08-25: artists were `AR-01`/`AR-02` against the
 * seed's `AR-001`-`AR-004`. The wallet's whole booking flow — the one that takes a
 * deposit — would have worked against this mock and been refused by the real API
 * on every booking. Same defect as the topics, one flow further in.
 */
const SEED = fileURLToPath(new URL('../../../api/src/db/seed.ts', import.meta.url));

function seedIds(prefix: string): Set<string> {
  const src = readFileSync(SEED, 'utf8');
  const found = [...src.matchAll(new RegExp(`'(${prefix}-[0-9A-Za-z]+)'`, 'g'))].map((m) => m[1]!);
  // Throwing rather than returning empty: a prefix that matches nothing means the
  // seed changed shape, and an empty set would make every `has()` below vacuously
  // pass — a guard that reports success precisely when it has stopped working.
  if (found.length === 0) {
    throw new Error(`no ${prefix}-* ids in ${SEED} — has the seed changed shape?`);
  }
  return new Set(found);
}

describe('every id the client sends back exists in the real seed', () => {
  it('reads a non-empty id set for each prefix (the positive control)', () => {
    expect(seedIds('AR').size).toBeGreaterThan(0);
    expect(seedIds('SV').size).toBeGreaterThan(0);
    expect(seedIds('PR').size).toBeGreaterThan(0);
  });

  it.each([
    ['artist', 'AR', () => artists.map((a) => a.id)],
    ['service', 'SV', () => services.map((s) => s.id)],
    ['product', 'PR', () => products.map((p) => p.id)],
  ])('serves %s ids the API would accept', (label, prefix, get) => {
    const seeded = seedIds(prefix);
    const invented = get().filter((id) => !seeded.has(id));
    expect(
      invented,
      `the mock serves ${label} id(s) ${invented.join(', ')}, which api/src/db/seed.ts ` +
        `does not seed (it has ${[...seeded].sort().join(', ')}). The client sends this id ` +
        `back to the API, so the real server would refuse it. Align the mock to the seed.`,
    ).toEqual([]);
  });
});
