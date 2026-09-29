/**
 * EVERY WORKSPACE HAS TWO BRANCHES, AND EVERY ARTIST WORKS AT ONE.
 *
 * Aftab, 2026-09-29: "I want multiple branches in each workspaces and artists
 * assigned to them."
 *
 * WHY IT MATTERS: the wallet's Book flow asks for the branch first, and it SKIPS
 * that step unless the salon has at least two open branches AND at least one
 * artist assigned to one (`apps/wallet/src/domain/branchPicker.ts`
 * `branchChoices`). On the live database SAL-AMARA had two branches and four
 * artists with `branch_id` NULL, SAL-FOREST had one branch and no artists, and
 * SAL-LUMIERE had two branches and no artists — so no customer anywhere saw
 * the step.
 *
 * THE LAYOUT, trunk's decision:
 *
 *   SAL-AMARA    BR-KWC Kuwait City   AR-001 Rana Al-Sabah, AR-002 Dana Yousef
 *                BR-SAL Salmiya       AR-003 Hessa M. (ST-002, the Salmiya
 *                                     till), AR-004 Shaikha B.
 *   SAL-FOREST   BR-FOR-KWC Kuwait City   AR-FOR-01, AR-FOR-02
 *                BR-FOR-SAL Salmiya       AR-FOR-03, AR-FOR-04   (new branch)
 *   SAL-LUMIERE  BR-LUM-HAW Hawally       AR-LUM-01, AR-LUM-02
 *                BR-LUM-JAB Jabriya       AR-LUM-03, AR-LUM-04
 *
 * Every new artist has a week of manual hours and does every one of her
 * salon's roster services (`artist_service`, migration 0061) — without the
 * pairs, "only staff who do a service" leaves her unbookable. Lumière had no
 * services, so it gets two; and booking is switched ON at Forest and Lumière,
 * because `assertSalonTakesBookings` refuses the roster read and the grid
 * otherwise, and an artist nobody can book is not what was asked for.
 *
 * ONE DEFINITION, TWO CALLERS, for the reason db/forestFixture.ts gives: two
 * copies of a fixture drift, and the one that drifts is the one on the demo.
 *
 *   db/seed.ts        `upsertRosterFixture` — the local fixture world. Upserts
 *                     that REASSERT: a warm database converges on this layout,
 *                     `branch_id` included, whatever a spec or a click moved.
 *                     Amara's four are written by seed.ts's own artist insert,
 *                     which reads `AMARA_ARTIST_BRANCH` from here.
 *   db/demoRoster.ts  `applyHostedRoster` — a database that must not be seeded.
 *                     ADDS AND ASSIGNS ONLY. It never deletes, never rewrites
 *                     an existing artist's hours or an existing service, and
 *                     never reads or writes a member, a balance, a booking or a
 *                     transaction except to COUNT them and to refuse a move.
 *
 * ============================================================================
 * MOVING AN ARTIST WHO HAS APPOINTMENTS — WHY A MOVE CAN BE REFUSED
 * ============================================================================
 * A booking carries its OWN `branch_id` (NOT NULL, migration 0013), resolved
 * once at creation from the artist's branch — or, for an unassigned artist at
 * a multi-branch salon, `ORDER BY id LIMIT 1` with `branch_assumed = true`
 * (services/branch.ts `resolveBranch`). Assigning an artist rewrites NOTHING
 * on her bookings: every existing booking keeps the branch it was written
 * with.
 *
 * That is exactly the hazard. `reassignArtist` in services/booking.ts states
 * the rule — "leaving `branch_id` pointing at Kuwait City would put it in a
 * reporting bucket where nobody is performing it" — and moves the booking's
 * branch WITH the artist. A script that moved the artist and not her live
 * bookings would leave precisely that: an appointment at a branch she no
 * longer works at. Rewriting the bookings instead is off the table here (this
 * script does not touch bookings). So the hosted path REFUSES that artist,
 * with a line naming the bookings, and assigns the rest.
 *
 * "Live" is `status = 'deposit_held' AND ends_at > now()` — the only
 * non-terminal status, and not yet over. A settled or past booking is history
 * and keeps its branch as history should.
 *
 * WHAT THIS MEANS FOR AMARA ON LIVE, which trunk believed was safe: her
 * artists are unassigned, so every booking they hold was written at `BR-KWC`
 * — "BR-KWC" sorts before "BR-SAL" — with `branch_assumed = true`. Rana and
 * Dana go TO BR-KWC, so their bookings already agree and they are always safe.
 * Hessa and Shaikha go to BR-SAL, so ANY live future booking either of them
 * holds is at BR-KWC and she is refused until it is moved, reassigned or over.
 * An assumed branch is still the branch the customer's booking names.
 *
 * The check runs in the same transaction as the update, with the artist row
 * locked. A booking committed in the sub-second between the two could still
 * carry the old branch — the same exposure `PUT /artists/{id}/branch` has, and
 * that route checks nothing at all.
 */

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { fils, type Fils } from '@avo/types';
import { artist, type ArtistWindows } from './schema/artist';
import { branch } from './schema/salon';
import { service } from './schema/service';
import { FOREST } from './forestFixture';

type ScriptDb = PostgresJsDatabase<Record<string, never>>;
/** The script connection, or a transaction on it. */
export type RosterExecutor = ScriptDb | Parameters<Parameters<ScriptDb['transaction']>[0]>[0];

/**
 * A week of availability windows, keyed '0'..'6' JS `getDay()` order.
 *
 * The design fixture (`artistSched` in AVO Merchant Dashboard.dc.html) stores
 * minutes past midnight — 600, 1260 — because its steppers do arithmetic on
 * them. The contract stores "HH:mm". Converting here rather than storing minutes
 * keeps the database holding the contract's shape, and keeps the two
 * representations from both being half-true.
 *
 * Days not named are CLOSED, and still carry a from/to. A closed day with no
 * times cannot be reopened by ticking one box — the dashboard's steppers need
 * something to start from, which is why the schema keeps the values and only the
 * `open` flag decides anything. Friday is closed everywhere in the fixture; it
 * is the Kuwaiti weekend day, not an oversight.
 */
export function week(
  open: Partial<Record<'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat', [number, number]>>,
): ArtistWindows {
  const order = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  const out: ArtistWindows = {};
  order.forEach((name, index) => {
    const span = open[name];
    out[String(index)] = span
      ? { open: true, from: hhmm(span[0]), to: hhmm(span[1]) }
      : { open: false, from: '10:00', to: '21:00' };
  });
  return out;
}

// ------------------------------------------------------------------ amara --

/**
 * Where Amara's four seeded artists work. Name included so the hosted path can
 * refuse an id that names somebody else rather than moving a stranger.
 */
export const AMARA_ARTIST_BRANCH = [
  { id: 'AR-001', name: 'Rana Al-Sabah', branchId: 'BR-KWC' },
  { id: 'AR-002', name: 'Dana Yousef', branchId: 'BR-KWC' },
  { id: 'AR-003', name: 'Hessa M.', branchId: 'BR-SAL' },
  { id: 'AR-004', name: 'Shaikha B.', branchId: 'BR-SAL' },
] as const;

export function amaraBranchOf(artistId: string): string {
  const row = AMARA_ARTIST_BRANCH.find((a) => a.id === artistId);
  if (!row) throw new Error(`rosterFixture: ${artistId} is not one of Amara's seeded artists`);
  return row.branchId;
}

// ------------------------------------------------------- forest, lumière --

interface RosterBranch {
  id: string;
  name: string;
  nameAr: string | null;
}

interface RosterService {
  id: string;
  name: string;
  nameAr: string | null;
  priceFils: Fils;
}

interface RosterArtist {
  id: string;
  branchId: string;
  name: string;
  nameAr: string | null;
  slotMinutes: 15 | 20 | 30 | 45 | 60;
  windows: ArtistWindows;
}

interface RosterWorkspace {
  salonId: string;
  label: string;
  /** Branches this roster ensures exist. Existing ones are not rewritten on the hosted path. */
  branches: RosterBranch[];
  /** Services this roster ensures exist, and that its artists are linked to. */
  services: RosterService[];
  artists: RosterArtist[];
}

/**
 * SAL-FOREST. `BR-FOR-KWC` and the two services come from db/forestFixture.ts;
 * this adds the second branch and the four people. Salmiya's Arabic is the
 * string Amara's branch already carries. No `business_hours` override on
 * either branch, so both follow the salon's hours and zone (Asia/Kuwait), which
 * is what the first one does.
 */
const FOREST_ROSTER: RosterWorkspace = {
  salonId: FOREST.salonId,
  label: 'Forest',
  branches: [{ id: 'BR-FOR-SAL', name: 'Salmiya', nameAr: 'السالمية' }],
  services: [],
  artists: [
    {
      id: 'AR-FOR-01',
      branchId: FOREST.branchId,
      name: 'Noor Al-Mutairi',
      nameAr: 'نور المطيري',
      slotMinutes: 30,
      windows: week({ sun: [600, 1260], mon: [600, 1260], tue: [600, 1260], wed: [600, 1260], thu: [600, 1260], sat: [960, 1260] }),
    },
    {
      id: 'AR-FOR-02',
      branchId: FOREST.branchId,
      name: 'Latifa K.',
      nameAr: 'لطيفة ك.',
      slotMinutes: 45,
      windows: week({ sun: [660, 1200], mon: [660, 1200], wed: [660, 1200], thu: [660, 1200] }),
    },
    {
      id: 'AR-FOR-03',
      branchId: 'BR-FOR-SAL',
      name: 'Mariam Al-Ajmi',
      nameAr: 'مريم العجمي',
      slotMinutes: 30,
      windows: week({ sun: [600, 1260], mon: [600, 1260], tue: [600, 1260], wed: [600, 1260], thu: [600, 1260] }),
    },
    {
      id: 'AR-FOR-04',
      branchId: 'BR-FOR-SAL',
      name: 'Reem S.',
      nameAr: 'ريم س.',
      slotMinutes: 60,
      windows: week({ sun: [960, 1260], mon: [960, 1260], thu: [960, 1260], sat: [960, 1260] }),
    },
  ],
};

/**
 * SAL-LUMIERE. Every Arabic column here is NULL, deliberately: Lumière is the
 * salon that holds real NULLs so the `nameAr ?? name` fallback has a genuine
 * null path (seed.ts § the salon that has none). Its roster does not "complete"
 * that; the wallet renders these in English in both languages.
 */
const LUMIERE_ROSTER: RosterWorkspace = {
  salonId: 'SAL-LUMIERE',
  label: 'Lumière',
  branches: [
    { id: 'BR-LUM-HAW', name: 'Hawally', nameAr: null },
    { id: 'BR-LUM-JAB', name: 'Jabriya', nameAr: null },
  ],
  services: [
    { id: 'SV-LUM-01', name: 'Blow-dry', nameAr: null, priceFils: fils(9000) },
    { id: 'SV-LUM-02', name: 'Cut & style', nameAr: null, priceFils: fils(14000) },
  ],
  artists: [
    {
      id: 'AR-LUM-01',
      branchId: 'BR-LUM-HAW',
      name: 'Yasmin Haddad',
      nameAr: null,
      slotMinutes: 30,
      windows: week({ sun: [600, 1260], mon: [600, 1260], tue: [600, 1260], wed: [600, 1260], thu: [600, 1260] }),
    },
    {
      id: 'AR-LUM-02',
      branchId: 'BR-LUM-HAW',
      name: 'Farah N.',
      nameAr: null,
      slotMinutes: 45,
      windows: week({ sun: [960, 1260], tue: [960, 1260], thu: [960, 1260], sat: [960, 1260] }),
    },
    {
      id: 'AR-LUM-03',
      branchId: 'BR-LUM-JAB',
      name: 'Joud Al-Kandari',
      nameAr: null,
      slotMinutes: 30,
      windows: week({ sun: [600, 1260], mon: [600, 1260], wed: [600, 1260], thu: [600, 1260], sat: [960, 1260] }),
    },
    {
      id: 'AR-LUM-04',
      branchId: 'BR-LUM-JAB',
      name: 'Sara T.',
      nameAr: null,
      slotMinutes: 60,
      windows: week({ sun: [600, 1200], mon: [600, 1200], tue: [600, 1200], thu: [600, 1200] }),
    },
  ],
};

export const ROSTER_WORKSPACES: readonly RosterWorkspace[] = [FOREST_ROSTER, LUMIERE_ROSTER];

/** A parameterised `IN (...)` list. */
function idList(ids: readonly string[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/** The services a workspace's roster artists are linked to. */
function linkedServiceIds(ws: RosterWorkspace): string[] {
  if (ws.salonId === FOREST.salonId) return ['SV-FOR-01', 'SV-FOR-02'];
  return ws.services.map((s) => s.id);
}

// ================================================================= seed ====

/**
 * THE LOCAL FIXTURE WORLD. Called by seed.ts after the salons, Amara's
 * artists and the forest workspace exist. Every write REASSERTS, so a warm
 * database converges: the branch reopens, the artist goes back to her branch
 * and her hours, the pairs that are missing come back. Nothing is deleted.
 */
export async function upsertRosterFixture(db: RosterExecutor): Promise<void> {
  for (const ws of ROSTER_WORKSPACES) {
    await db.execute(sql`UPDATE salon SET module_booking = true WHERE id = ${ws.salonId}`);

    if (ws.branches.length > 0) {
      await db
        .insert(branch)
        .values(ws.branches.map((b) => ({ ...b, salonId: ws.salonId })))
        .onConflictDoUpdate({
          target: branch.id,
          set: { nameAr: sql`excluded.name_ar`, closedAt: null },
        });
    }

    if (ws.services.length > 0) {
      await db
        .insert(service)
        .values(ws.services.map((s) => ({ ...s, salonId: ws.salonId })))
        .onConflictDoUpdate({
          target: service.id,
          set: {
            name: sql`excluded.name`,
            nameAr: sql`excluded.name_ar`,
            priceFils: sql`excluded.price_fils`,
            active: true,
          },
        });
    }

    await db
      .insert(artist)
      .values(
        ws.artists.map((a) => ({
          ...a,
          salonId: ws.salonId,
          availabilitySource: 'manual' as const,
          googleConnected: false,
        })),
      )
      .onConflictDoUpdate({
        target: artist.id,
        set: {
          branchId: sql`excluded.branch_id`,
          name: sql`excluded.name`,
          nameAr: sql`excluded.name_ar`,
          availabilitySource: sql`excluded.availability_source`,
          googleConnected: sql`excluded.google_connected`,
          slotMinutes: sql`excluded.slot_minutes`,
          windows: sql`excluded.windows`,
          active: true,
        },
      });

    // Scoped to the roster's own ids, for the reason seed.ts gives at Amara's
    // pairs: a spec that deliberately leaves a pair unassigned must not find it
    // put back by somebody else's fixture.
    const artistIds = ws.artists.map((a) => a.id);
    const serviceIds = linkedServiceIds(ws);
    await db.execute(sql`
      INSERT INTO artist_service (artist_id, service_id, salon_id)
      SELECT a.id, s.id, a.salon_id
        FROM artist a
        JOIN service s ON s.salon_id = a.salon_id
       WHERE a.id IN (${idList(artistIds)})
         AND s.id IN (${idList(serviceIds)})
      ON CONFLICT DO NOTHING`);
  }
}

// =============================================================== hosted ====

/** A live booking that would be left at a branch its artist no longer works at. */
export interface StrandedBooking {
  id: string;
  branchId: string;
  branchAssumed: boolean;
  startsAt: Date;
}

/**
 * Is it safe to move this artist to `target`? The whole rule, pure, so it can
 * be tested without a database.
 *
 * `liveBookings` is every live booking she holds (deposit_held, not yet over).
 * Any of them at a branch other than `target` is one the move would strand.
 */
export function decideAssignment(input: {
  currentBranchId: string | null;
  targetBranchId: string;
  liveBookings: readonly StrandedBooking[];
}):
  | { kind: 'unchanged' }
  | { kind: 'assign' }
  | { kind: 'refuse'; stranded: StrandedBooking[] } {
  if (input.currentBranchId === input.targetBranchId) return { kind: 'unchanged' };
  const stranded = input.liveBookings.filter((b) => b.branchId !== input.targetBranchId);
  if (stranded.length > 0) return { kind: 'refuse', stranded };
  return { kind: 'assign' };
}

export interface HostedRosterReport {
  lines: string[];
  created: number;
  assigned: number;
  refused: number;
  skipped: number;
}

type Row = Record<string, unknown>;

async function rows(db: RosterExecutor, q: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(q)) as unknown as Row[];
}

/**
 * ADDS AND ASSIGNS ONLY. Run inside one transaction by db/demoRoster.ts.
 *
 * A refusal is not an error: it skips that artist (or that branch's artists)
 * with a line and the rest proceed. Anything unexpected throws, and the
 * caller's transaction takes every write with it.
 */
export async function applyHostedRoster(db: RosterExecutor): Promise<HostedRosterReport> {
  const report: HostedRosterReport = { lines: [], created: 0, assigned: 0, refused: 0, skipped: 0 };
  const say = (line: string) => report.lines.push(line);

  const salonExists = async (id: string) =>
    (await rows(db, sql`SELECT 1 FROM salon WHERE id = ${id}`)).length > 0;

  const ensureBookingOn = async (salonId: string) => {
    const flipped = await rows(
      db,
      sql`UPDATE salon SET module_booking = true, updated_at = now()
           WHERE id = ${salonId} AND NOT module_booking
       RETURNING id`,
    );
    say(flipped.length > 0 ? `  booking module  switched ON (was off)` : `  booking module  already on`);
  };

  /**
   * Put one artist at one branch, or say why not. `insert` is the row to
   * create when she does not exist yet; Amara's four are never created here.
   */
  const placeArtist = async (
    salonId: string,
    want: { id: string; name: string; branchId: string },
    openBranches: ReadonlySet<string>,
    insert: (() => Promise<void>) | null,
  ): Promise<'created' | 'assigned' | 'unchanged' | 'refused' | 'skipped'> => {
    if (!openBranches.has(want.branchId)) {
      say(`  REFUSED   ${want.id} ${want.name}: ${want.branchId} is not an open branch of ${salonId}`);
      return 'refused';
    }

    const [cur] = await rows(
      db,
      sql`SELECT id, salon_id, name, branch_id FROM artist WHERE id = ${want.id} FOR UPDATE`,
    );

    if (!cur) {
      if (!insert) {
        say(`  skipped   ${want.id} ${want.name}: no such artist here`);
        return 'skipped';
      }
      await insert();
      say(`  created   ${want.id} ${want.name} → ${want.branchId}`);
      return 'created';
    }

    if (cur.salon_id !== salonId) {
      say(`  REFUSED   ${want.id}: that id belongs to ${String(cur.salon_id)}, not ${salonId}`);
      return 'refused';
    }
    if (cur.name !== want.name) {
      say(`  REFUSED   ${want.id}: that id is "${String(cur.name)}" here, not "${want.name}" — not moving a stranger`);
      return 'refused';
    }

    const live = (
      await rows(
        db,
        sql`SELECT id, branch_id, branch_assumed, starts_at FROM booking
             WHERE artist_id = ${want.id} AND status = 'deposit_held' AND ends_at > now()
             ORDER BY starts_at`,
      )
    ).map((b) => ({
      id: String(b.id),
      branchId: String(b.branch_id),
      branchAssumed: b.branch_assumed === true,
      startsAt: new Date(String(b.starts_at)),
    }));

    const current = (cur.branch_id as string | null) ?? null;
    const decision = decideAssignment({ currentBranchId: current, targetBranchId: want.branchId, liveBookings: live });

    if (decision.kind === 'unchanged') {
      say(`  unchanged ${want.id} ${want.name} already at ${want.branchId}`);
      return 'unchanged';
    }
    if (decision.kind === 'refuse') {
      say(
        `  REFUSED   ${want.id} ${want.name} → ${want.branchId}: ${decision.stranded.length} live booking(s) ` +
          `would be left at another branch. Move or reassign them first, then re-run.`,
      );
      for (const b of decision.stranded) {
        say(
          `              ${b.id} at ${b.branchId}${b.branchAssumed ? ' (assumed)' : ''}, ${b.startsAt.toISOString()}`,
        );
      }
      return 'refused';
    }

    await db.execute(
      sql`UPDATE artist SET branch_id = ${want.branchId}, updated_at = now() WHERE id = ${want.id}`,
    );
    say(
      `  assigned  ${want.id} ${want.name} → ${want.branchId} (was ${current ?? 'unassigned'}` +
        `${live.length > 0 ? `; ${live.length} live booking(s) already there` : ''})`,
    );
    return 'assigned';
  };

  const tally = (outcome: Awaited<ReturnType<typeof placeArtist>>) => {
    if (outcome === 'created') report.created += 1;
    else if (outcome === 'assigned') report.assigned += 1;
    else if (outcome === 'refused') report.refused += 1;
    else if (outcome === 'skipped') report.skipped += 1;
  };

  const openBranchesOf = async (salonId: string) =>
    new Set(
      (await rows(db, sql`SELECT id FROM branch WHERE salon_id = ${salonId} AND closed_at IS NULL`)).map((r) =>
        String(r.id),
      ),
    );

  // ------------------------------------------------------------- amara --
  say('SAL-AMARA');
  if (!(await salonExists('SAL-AMARA'))) {
    say('  skipped: SAL-AMARA does not exist on this database');
    report.skipped += 1;
  } else {
    await ensureBookingOn('SAL-AMARA');
    const open = await openBranchesOf('SAL-AMARA');
    for (const a of AMARA_ARTIST_BRANCH) tally(await placeArtist('SAL-AMARA', a, open, null));
  }

  // ------------------------------------------------- forest, lumière --
  for (const ws of ROSTER_WORKSPACES) {
    say(ws.salonId);
    if (!(await salonExists(ws.salonId))) {
      say(
        ws.salonId === FOREST.salonId
          ? `  skipped: ${ws.salonId} does not exist. Run db:demo-forest first, then this again.`
          : `  skipped: ${ws.salonId} does not exist on this database`,
      );
      report.skipped += 1;
      continue;
    }

    await ensureBookingOn(ws.salonId);

    for (const b of ws.branches) {
      const [byId] = await rows(db, sql`SELECT salon_id, closed_at FROM branch WHERE id = ${b.id}`);
      if (byId) {
        if (byId.salon_id !== ws.salonId) {
          say(`  REFUSED   branch ${b.id}: that id belongs to ${String(byId.salon_id)}`);
        } else if (byId.closed_at !== null) {
          say(`  branch    ${b.id} exists but is CLOSED — left closed; reopening is the merchant's call`);
        } else {
          say(`  branch    ${b.id} ${b.name} already open`);
        }
        continue;
      }
      // `branch_salon_name_uq`: a branch of this name under another id is the
      // merchant's own, and a second "Salmiya" would not commit anyway.
      const [byName] = await rows(
        db,
        sql`SELECT id FROM branch WHERE salon_id = ${ws.salonId} AND name = ${b.name}`,
      );
      if (byName) {
        say(`  REFUSED   branch ${b.id}: ${ws.salonId} already has a "${b.name}" as ${String(byName.id)}`);
        continue;
      }
      await db.insert(branch).values({ ...b, salonId: ws.salonId });
      say(`  created   branch ${b.id} ${b.name}${b.nameAr ? ` / ${b.nameAr}` : ''}`);
      report.created += 1;
    }

    for (const s of ws.services) {
      const made = await db
        .insert(service)
        .values({ ...s, salonId: ws.salonId })
        .onConflictDoNothing({ target: service.id })
        .returning({ id: service.id });
      if (made.length > 0) {
        say(`  created   service ${s.id} ${s.name}`);
        report.created += 1;
      } else {
        say(`  service   ${s.id} already exists — left as it is`);
      }
    }

    const serviceIds = linkedServiceIds(ws);
    const present = new Set(
      (
        await rows(
          db,
          sql`SELECT id FROM service WHERE salon_id = ${ws.salonId}
                AND id IN (${idList(serviceIds)})`,
        )
      ).map((r) => String(r.id)),
    );

    const open = await openBranchesOf(ws.salonId);
    for (const a of ws.artists) {
      const outcome = await placeArtist(ws.salonId, a, open, async () => {
        await db.insert(artist).values({
          ...a,
          salonId: ws.salonId,
          availabilitySource: 'manual',
          googleConnected: false,
        });
        // Her services, written WITH her and only then: a pair a merchant
        // removes later is her decision, and a re-run must not put it back.
        for (const serviceId of serviceIds) {
          if (!present.has(serviceId)) continue;
          await db.execute(sql`
            INSERT INTO artist_service (artist_id, service_id, salon_id)
            VALUES (${a.id}, ${serviceId}, ${ws.salonId})
            ON CONFLICT DO NOTHING`);
        }
      });
      tally(outcome);
    }
  }

  return report;
}
