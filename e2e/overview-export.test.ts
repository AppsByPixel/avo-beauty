/**
 * THE OVERVIEW EXPORT — `GET /v1/salons/{id}/overview/analytics.csv` and the one-time
 * link, `POST /v1/salons/{id}/overview/analytics/download-url` redeemed at
 * `GET /report-downloads/:token`. Lane A's `53cbbc1`..`b4fc7fa`, merged on dev `3c8453f`.
 *
 * HOW TO RUN
 *
 *   cd e2e && AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run overview-export.test.ts
 *
 * WHAT THE THREE LEDGERS SAY AND WHAT THEY CANNOT
 * -----------------------------------------------
 * `permission-census.test.ts` pins both doors `→ dashboard`, `tenancy.test.ts` has both
 * in `SALON_ROUTES`, and `contract.test.ts` classifies the file as unmodelled and probes
 * the mint's `{url, expiresAt}`. None of the three can ask the five questions below,
 * because each is about the CONTENT of a 200 or the SEQUENCE of two requests:
 *
 *   1. mint → redeem once → the second redeem is refused, and the audit trail records
 *      exactly one export.
 *   2. with `appointments` off, the upcoming customers' NAMES are not in the file — on
 *      the `.csv` door, and on the link whose permission is re-read at redemption.
 *   3. salon B's manager cannot export salon A, and her refusal writes no link row and
 *      no audit row for salon A.
 *   4. a scanner PIN session is refused at both doors — the SURFACE half of
 *      `requireDashboardPerm`, for a principal who holds `dashboard`.
 *   5. every money row in the file reconciles, fils for fils, with the JSON analytics
 *      for the same query — the "one answer, two renderings" claim
 *      (`services/overviewExport.ts` header), asked of the served routes.
 *
 * Every claim about what was WRITTEN is read back from Postgres — `report_download`,
 * `audit_log` — never from the API's own reply.
 *
 * THE PRINCIPAL IS NOURA, ST-001, who holds all nine, so a withheld block is withheld
 * for exactly the one permission a spec revoked. `appointments` is restored in a
 * `finally` and again in `afterAll`.
 *
 * THE UPCOMING FIXTURE IS THIS FILE'S OWN: one merchant guest booking forty-one minutes
 * out on Salmiya, named `QA Export Guest <run>`, so spec 2 is about a name this file
 * KNOWS is first in `upcoming.next` rather than one the seed happens to hold. A guest
 * booking is zero-deposit by constraint, so it moves no money and the wallet census has
 * nothing to forgive. Deleted in `afterAll`.
 *
 * NOT YET SPECCED, BY INSTRUCTION: lane A is adding `kpis`, `salesTrend` and
 * `revenueByBranch` sections. The reconciliation below is scoped to the TWELVE section
 * titles on dev today, so those three arriving will not turn it red; trunk sends them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  A_BRANCH,
  A_SERVICE,
  A_STAFF_FULL,
  B_STAFF,
  B_STAFF_HANDLE,
  SALON_A,
  SALON_B,
  psql,
  scalar,
  signInDashboard,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  tenancyBaseUrl,
  treq,
} from './support/tenancy-harness.js';

/** Noura, ST-001. `api/src/db/seed.ts`. */
const A_STAFF_HANDLE = 'noura';
/** Salon A's seeded scanner device. `api/src/db/seed.ts`. */
const A_SCANNER_DEVICE = 'DEV-SCANNER-01';

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.toUpperCase();
const GUEST_BOOKING = `BK-QAOX-${RUN}`;
const GUEST_NAME = `QA Export Guest ${RUN}`;

/** The window every request in this file asks for, so the JSON and the file agree on it. */
const PERIOD = '30d';

/** The twelve section titles on dev today — `services/overviewExport.ts § sectionTitle`. */
const KNOWN_SECTIONS = new Set([
  'Top services',
  'Artist performance',
  'Busiest times',
  'Upcoming',
  'No-shows and deposits',
  'New members',
  'First visit vs returning',
  'Stamp progress',
  'Members by tier',
  'Wallet loaded vs spent',
  'Payment mix',
  'Shop orders',
  'Campaigns',
]);

const SURFACE_REFUSAL =
  'A scanner PIN cannot reach the dashboard. Sign in on the web with a username and password.';

let noura = '';
let layla = '';

// ------------------------------------------------------------------ the file --

interface Row {
  section: string;
  item: string;
  metric: string;
  value: string;
  unit: string;
}

interface Download {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  /** Decoded with the BOM KEPT, so a spec can assert it is there. */
  text: string;
}

/**
 * Plain `fetch`, not `treq`: `Response.text()` strips a UTF-8 BOM by spec, and the
 * BOM is part of what this file asserts. `treq` would also hand back a CSV body as a
 * string with no headers.
 */
async function download(path: string, token: string | null): Promise<Download> {
  const res = await fetch(`${tenancyBaseUrl()}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(12_000),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return {
    status: res.status,
    headers: res.headers,
    bytes,
    text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
  };
}

/**
 * RFC 4180, enough of it for a file whose every field is quoted: `""` is a quote,
 * commas and CRLF inside quotes are data. Refuses anything else rather than guessing,
 * so a change in quoting is a red here and not a silently mis-split row.
 */
function parseCsv(text: string): Row[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let i = 0;
  let quoted = false;
  while (i < body.length) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (c === '"') {
        quoted = false;
        i += 1;
      } else {
        field += c;
        i += 1;
      }
    } else if (c === '"') {
      quoted = true;
      i += 1;
    } else if (c === ',') {
      record.push(field);
      field = '';
      i += 1;
    } else if (c === '\r' && body[i + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      i += 2;
    } else {
      throw new Error(`unquoted byte ${JSON.stringify(c)} at ${i} — the file is not all-quoted RFC 4180`);
    }
  }
  record.push(field);
  records.push(record);

  const [header, ...rest] = records;
  expect(header, 'the CSV header').toEqual(['section', 'item', 'metric', 'value', 'unit']);
  return rest.map((r, n) => {
    expect(r.length, `record ${n + 1} has ${r.length} fields: ${JSON.stringify(r)}`).toBe(5);
    return { section: r[0]!, item: r[1]!, metric: r[2]!, value: r[3]!, unit: r[4]! };
  });
}

/**
 * `59.250` → 59250 by string arithmetic. No float touches it (non-negotiable #1), and
 * anything that is not digits-dot-three-digits — a thousands comma, two decimals, a
 * minus — is refused, because the file's money cell is defined as exactly that.
 */
function kdToFils(value: string, where: string): number {
  const m = /^(\d+)\.(\d{3})$/.exec(value);
  if (!m) throw new Error(`${where}: money cell ${JSON.stringify(value)} is not KD to three decimals`);
  return Number(m[1]) * 1000 + Number(m[2]);
}

async function analyticsJson(query: string, token = noura): Promise<any> {
  const res = await treq<any>('GET', `/v1/salons/${SALON_A}/overview/analytics${query}`, { token });
  expect(res.status, `the JSON analytics${query}: ${res.raw.slice(0, 400)}`).toBe(200);
  return res.body;
}

async function analyticsCsv(query: string, token = noura): Promise<Row[]> {
  const res = await download(`/v1/salons/${SALON_A}/overview/analytics.csv${query}`, token);
  expect(res.status, `the CSV${query}: ${res.text.slice(0, 400)}`).toBe(200);
  return parseCsv(res.text);
}

async function mint(body: Record<string, unknown>, token = noura) {
  return treq<{ url: string; expiresAt: string }>(
    'POST',
    `/v1/salons/${SALON_A}/overview/analytics/download-url`,
    { token, body },
  );
}

async function mintToken(body: Record<string, unknown>): Promise<string> {
  const res = await mint(body);
  expect(res.status, `the mint: ${res.raw}`).toBe(200);
  const token = res.body.url.replace('/report-downloads/', '');
  expect(token, `the mint did not return a token url: ${res.raw}`).toMatch(/^tok_[A-Za-z0-9_-]+$/);
  return token;
}

/** Redeem with NO session — the whole point of the route. */
const redeem = (token: string) => download(`/report-downloads/${token}`, null);

// ------------------------------------------------------------- the database --

const count = (sql: string): number => Number(scalar(sql).trim());

const exportAudits = (actor: string, salon: string, via: string): number =>
  count(`select count(*) from audit_log
          where actor_id = '${actor}' and salon_id = '${salon}'
            and action = 'Report exported' and subject_id = 'overview'
            and metadata->>'via' = '${via}'`);

const overviewLinks = (staff: string, salon: string): number =>
  count(`select count(*) from report_download
          where staff_id = '${staff}' and salon_id = '${salon}' and kind like 'overview%'`);

function setAppointments(on: boolean): void {
  psql(`UPDATE staff_user SET perm_appointments = ${on} WHERE id = '${A_STAFF_FULL}';`);
  precondition(
    scalar(`select perm_appointments from staff_user where id = '${A_STAFF_FULL}'`).trim() ===
      (on ? 't' : 'f'),
    `perm_appointments did not go ${on ? 'on' : 'off'} for ${A_STAFF_FULL}`,
  );
}

/**
 * One merchant guest booking, `deposit_held` with no deposit — the shape
 * `booking_merchant_is_zero_deposit` allows — on the first artist free at that minute.
 * `booking_artist_slot_no_overlap` refuses a collision, so each artist is tried in turn.
 */
function insertGuestBooking(): void {
  psql(`DELETE FROM booking WHERE id = '${GUEST_BOOKING}';`);
  const errors: string[] = [];
  for (const artist of ['AR-004', 'AR-003', 'AR-002', 'AR-001']) {
    try {
      psql(`
        INSERT INTO booking (id, salon_id, branch_id, member_id, guest_name, artist_id, service_id,
                             starts_at, ends_at, duration_min, deposit_fils, status, source,
                             no_show_return_due_at)
        VALUES ('${GUEST_BOOKING}', '${SALON_A}', '${A_BRANCH}', NULL, '${GUEST_NAME}', '${artist}',
                '${A_SERVICE}',
                date_trunc('minute', now()) + interval '41 minutes',
                date_trunc('minute', now()) + interval '71 minutes',
                30, 0, 'deposit_held', 'merchant',
                date_trunc('minute', now()) + interval '131 minutes');
      `);
      return;
    } catch (err) {
      errors.push(`${artist}: ${String((err as Error).message).slice(0, 200)}`);
    }
  }
  throw new Error(`no salon A artist was free for the guest fixture:\n${errors.join('\n')}`);
}

beforeAll(async () => {
  await startTenancyApi();
  setAppointments(true);
  noura = await signInDashboard(SALON_A, A_STAFF_HANDLE);
  layla = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  insertGuestBooking();
  precondition(
    scalar(
      `select concat_ws(',', perm_dashboard, perm_appointments, perm_team, perm_shop, perm_marketing)
         from staff_user where id = '${A_STAFF_FULL}'`,
    ).trim() === 't,t,t,t,t',
    `${A_STAFF_FULL} does not hold dashboard and the four second permissions this file assumes`,
  );
}, 180_000);

afterAll(async () => {
  setAppointments(true);
  psql(`DELETE FROM booking WHERE id = '${GUEST_BOOKING}';`);
  await stopTenancyApi();
});

// ===========================================================================

describe('the one-time link is spent by its first redemption', () => {
  it('mint → redeem once (the file, with the headers a browser saves) → the second redeem is refused', async () => {
    const auditsBefore = exportAudits(A_STAFF_FULL, SALON_A, 'download-link');
    const token = await mintToken({ period: PERIOD });

    const row = scalar(
      `select concat_ws('|', kind, salon_id, staff_id, coalesce(branch_id, '-'), period, (used_at is null))
         from report_download where token_hash = encode(sha256('${token}'::bytea), 'hex')`,
    ).trim();
    expect(row, 'the mint wrote no report_download row for its token').toBe(
      `overview|${SALON_A}|${A_STAFF_FULL}|-|${PERIOD}|t`,
    );

    const first = await redeem(token);
    expect(first.status, `the first redemption: ${first.text.slice(0, 300)}`).toBe(200);
    expect(first.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(first.headers.get('content-disposition')).toBe(
      `attachment; filename="overview_all-branches_${PERIOD}.csv"`,
    );
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect([...first.bytes.slice(0, 3)], 'the file opens with a UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
    const rows = parseCsv(first.text);
    expect(rows.length, 'every section yields at least one row').toBeGreaterThanOrEqual(12);

    expect(
      scalar(
        `select (used_at is not null) from report_download
          where token_hash = encode(sha256('${token}'::bytea), 'hex')`,
      ).trim(),
      'the redemption did not spend the token',
    ).toBe('t');
    expect(
      exportAudits(A_STAFF_FULL, SALON_A, 'download-link'),
      'a served link writes exactly one audit row',
    ).toBe(auditsBefore + 1);

    const second = await redeem(token);
    expect(second.status, `the second redemption: ${second.text}`).toBe(401);
    expect(JSON.parse(second.text).error).toBe('invalid_download');
    expect(second.text, 'the refusal carries no part of the file').not.toContain('section');
    expect(
      exportAudits(A_STAFF_FULL, SALON_A, 'download-link'),
      'a refused redemption wrote an export audit row',
    ).toBe(auditsBefore + 1);
  });

  it('a link minted for one section redeems as that section only, under its own kind', async () => {
    const token = await mintToken({ period: PERIOD, section: 'wallet' });
    expect(
      scalar(`select kind from report_download where token_hash = encode(sha256('${token}'::bytea), 'hex')`).trim(),
    ).toBe('overview:wallet');

    const served = await redeem(token);
    expect(served.status, served.text.slice(0, 300)).toBe(200);
    expect(served.headers.get('content-disposition')).toBe(
      `attachment; filename="overview_all-branches_${PERIOD}_wallet.csv"`,
    );
    const sections = new Set(parseCsv(served.text).map((r) => r.section));
    expect([...sections]).toEqual(['Wallet loaded vs spent']);
  });
});

// ===========================================================================

describe('with appointments off, the upcoming customers are not in the file', () => {
  it('the .csv door: names present with it on, absent with it off, and the block says why', async () => {
    const json = await analyticsJson(`?period=${PERIOD}`);
    expect(json.upcoming?.next?.status, 'upcoming.next with appointments held').toBe('ok');
    const names: string[] = json.upcoming.next.items.map((x: { customerName: string }) => x.customerName);
    expect(names, `the guest fixture is not in upcoming.next: ${JSON.stringify(names)}`).toContain(GUEST_NAME);

    const on = await download(`/v1/salons/${SALON_A}/overview/analytics.csv?period=${PERIOD}`, noura);
    expect(on.status).toBe(200);
    for (const n of names) expect(on.text, `the control file does not name ${n}`).toContain(n);

    setAppointments(false);
    try {
      const off = await download(`/v1/salons/${SALON_A}/overview/analytics.csv?period=${PERIOD}`, noura);
      expect(off.status, off.text.slice(0, 300)).toBe(200);
      for (const n of names) {
        expect(off.text, `appointments is off and the file still names ${n}`).not.toContain(n);
      }
      const rows = parseCsv(off.text);
      expect(rows).toContainEqual({
        section: 'Upcoming',
        item: 'Next appointments',
        metric: 'withheld',
        value: 'permission: appointments',
        unit: '',
      });
      // The other block `appointments` gates, withheld by the same revoke.
      expect(rows).toContainEqual({
        section: 'Top services',
        item: '',
        metric: 'withheld',
        value: 'permission: appointments',
        unit: '',
      });
      // And the two counts the Overview still serves without it are still in the file.
      expect(rows.some((r) => r.section === 'Upcoming' && r.metric === 'next 7 days')).toBe(true);
    } finally {
      setAppointments(true);
    }
  });

  it('the link: minted with appointments ON, revoked before the click, redeemed WITHOUT the names', async () => {
    const token = await mintToken({ period: PERIOD, section: 'upcoming' });
    setAppointments(false);
    try {
      const served = await redeem(token);
      expect(served.status, served.text.slice(0, 300)).toBe(200);
      expect(served.text, 'the redemption served names the staff row no longer may see').not.toContain(GUEST_NAME);
      expect(parseCsv(served.text)).toContainEqual({
        section: 'Upcoming',
        item: 'Next appointments',
        metric: 'withheld',
        value: 'permission: appointments',
        unit: '',
      });
    } finally {
      setAppointments(true);
    }
  });
});

// ===========================================================================

describe("salon B cannot export salon A's data", () => {
  it('her own salon exports, so the refusals below are tenancy and not a broken session', async () => {
    const own = await download(`/v1/salons/${SALON_B}/overview/analytics.csv?period=${PERIOD}`, layla);
    expect(own.status, own.text.slice(0, 300)).toBe(200);
    expect(own.text).not.toContain(GUEST_NAME);
  });

  it('the .csv door and the mint both refuse her, and neither writes a link or an audit row for salon A', async () => {
    const linksBefore = overviewLinks(B_STAFF, SALON_A);
    const csvAuditsBefore = exportAudits(B_STAFF, SALON_A, 'csv');

    const file = await download(`/v1/salons/${SALON_A}/overview/analytics.csv?period=${PERIOD}`, layla);
    expect(file.status, file.text.slice(0, 300)).toBe(403);
    expect(JSON.parse(file.text)).toMatchObject({ error: 'forbidden', message: 'That salon is not yours.' });
    expect(file.text).not.toContain(GUEST_NAME);
    expect(file.text).not.toContain('Amara');

    const link = await mint({ period: PERIOD }, layla);
    expect(link.status, link.raw).toBe(403);
    expect(link.body).toMatchObject({ error: 'forbidden', message: 'That salon is not yours.' });
    expect(link.raw).not.toContain('report-downloads');

    expect(overviewLinks(B_STAFF, SALON_A), 'a refused cross-salon mint wrote a link row').toBe(linksBefore);
    expect(exportAudits(B_STAFF, SALON_A, 'csv'), 'a refused cross-salon export was audited as served').toBe(
      csvAuditsBefore,
    );
  });

  it("salon A's branch named in HER OWN salon's mint is 404 unknown_branch, and no link is written", async () => {
    const before = count(`select count(*) from report_download where staff_id = '${B_STAFF}' and branch_id = '${A_BRANCH}'`);
    const res = await treq<any>('POST', `/v1/salons/${SALON_B}/overview/analytics/download-url`, {
      token: layla,
      body: { period: PERIOD, branch: A_BRANCH },
    });
    expect(res.status, res.raw).toBe(404);
    expect(res.body.error).toBe('unknown_branch');
    expect(
      count(`select count(*) from report_download where staff_id = '${B_STAFF}' and branch_id = '${A_BRANCH}'`),
    ).toBe(before);
  });
});

// ===========================================================================

describe('a scanner PIN session is refused at both doors', () => {
  it('Noura on the tablet holds dashboard and still cannot export — the surface gate, not the permission', async () => {
    const pin = await signInScanner(SALON_A, A_STAFF_HANDLE, A_SCANNER_DEVICE);
    const me = await treq<any>('GET', '/staff/me', { token: pin });
    expect(me.status, `the PIN session is not live: ${me.raw}`).toBe(200);
    expect(me.body.id).toBe(A_STAFF_FULL);

    const linksBefore = overviewLinks(A_STAFF_FULL, SALON_A);
    const auditsBefore = exportAudits(A_STAFF_FULL, SALON_A, 'csv');

    const file = await download(`/v1/salons/${SALON_A}/overview/analytics.csv?period=${PERIOD}`, pin);
    expect(file.status, file.text.slice(0, 300)).toBe(403);
    expect(JSON.parse(file.text)).toMatchObject({ error: 'forbidden', message: SURFACE_REFUSAL });

    const link = await mint({ period: PERIOD }, pin);
    expect(link.status, link.raw).toBe(403);
    expect(link.body).toMatchObject({ error: 'forbidden', message: SURFACE_REFUSAL });

    expect(overviewLinks(A_STAFF_FULL, SALON_A), 'a PIN session minted a link').toBe(linksBefore);
    expect(exportAudits(A_STAFF_FULL, SALON_A, 'csv'), 'a PIN session export was audited').toBe(auditsBefore);
  });
});

// ===========================================================================

/**
 * The money rows the file MUST carry for a given JSON answer: one per fils figure the
 * JSON serves in an `ok` block. Keyed `section|item|metric|fils`, so the comparison is
 * of multisets and a duplicated or dropped row is a red, not a coincidence.
 */
function moneyRowsOf(a: any): string[] {
  const out: string[] = [];
  const push = (section: string, item: string, metric: string, f: unknown) => {
    expect(Number.isSafeInteger(f), `${section} · ${item} · ${metric} is not integer fils: ${f}`).toBe(true);
    out.push(`${section}|${item}|${metric}|${f}`);
  };

  if (a.topServices.status === 'ok') {
    // One item per service across both rankings, as the file renders them.
    const seen = new Map<string, { name: string; revenueFils: number }>();
    for (const s of [...a.topServices.byBookings, ...a.topServices.byRevenue]) {
      if (!seen.has(s.serviceId)) seen.set(s.serviceId, { name: s.name, revenueFils: s.revenueFils });
    }
    for (const s of seen.values()) push('Top services', s.name, 'revenue', s.revenueFils);
  }
  if (a.artists.status === 'ok') {
    for (const r of a.artists.items) push('Artist performance', r.name, 'revenue', r.revenueFils);
  }
  if (a.noShows.status === 'ok') {
    push('No-shows and deposits', '', 'deposits held now', a.noShows.depositsHeld.fils);
  }
  if (a.wallet.status === 'ok') {
    push('Wallet loaded vs spent', '', 'loaded', a.wallet.loadedFils);
    push('Wallet loaded vs spent', '', 'bonus', a.wallet.bonusFils);
    push('Wallet loaded vs spent', '', 'spent', a.wallet.spentFils);
    push('Wallet loaded vs spent', '', 'outstanding balance', a.wallet.liabilityFils);
  }
  if (a.paymentMix.status === 'ok') {
    const label = { knet: 'KNET', card: 'Card', applepay: 'Apple Pay' } as const;
    for (const m of ['knet', 'card', 'applepay'] as const) {
      push('Payment mix', label[m], 'top-up value', a.paymentMix.topups[m].fils);
    }
    push('Payment mix', 'Wallet', 'spent', a.paymentMix.walletSpend.fils);
  }
  if (a.shop.status === 'ok') {
    for (const p of a.shop.topProducts) push('Shop orders', p.name, 'revenue', p.revenueFils);
    push('Shop orders', '', 'revenue', a.shop.revenueFils);
  }
  return out.sort();
}

function moneyRowsIn(rows: Row[]): string[] {
  return rows
    .filter((r) => KNOWN_SECTIONS.has(r.section) && r.unit === 'KD')
    .map((r) => `${r.section}|${r.item}|${r.metric}|${kdToFils(r.value, `${r.section} · ${r.item} · ${r.metric}`)}`)
    .sort();
}

describe("the file's money rows reconcile with the JSON analytics for the same query", () => {
  for (const [what, query] of [
    ['all branches', `?period=${PERIOD}`],
    [`branch ${A_BRANCH}`, `?period=${PERIOD}&branch=${A_BRANCH}`],
  ] as const) {
    it(`${what}: every KD row is a JSON fils figure and every JSON fils figure is a KD row`, async () => {
      const json = await analyticsJson(query);
      const rows = await analyticsCsv(query);

      const expected = moneyRowsOf(json);
      const served = moneyRowsIn(rows);

      // Worth reconciling at all: zeros against zeros would prove nothing. The seed
      // tops up and spends at salon A inside the window; shop and artist revenue are
      // filled by earlier files and are not required here.
      if (json.wallet.status === 'ok') {
        precondition(
          json.wallet.loadedFils > 0 && json.wallet.spentFils > 0,
          `salon A's wallet block is all zeros for ${query}, so a reconciliation would compare nothing`,
        );
      } else {
        precondition(
          expected.some((k) => !k.endsWith('|0')),
          `every money figure for ${query} is zero, so a reconciliation would compare nothing`,
        );
      }

      expect(
        served,
        `the file's money rows for ${query} are not the JSON's fils figures.\n` +
          `JSON only: ${expected.filter((k) => !served.includes(k)).join(', ') || '—'}\n` +
          `file only: ${served.filter((k) => !expected.includes(k)).join(', ') || '—'}`,
      ).toEqual(expected);
    });
  }

  it("the file states the same window the JSON says it aggregated", async () => {
    const json = await analyticsJson(`?period=${PERIOD}`);
    expect(json.window?.token, 'the JSON window').toBe(PERIOD);
    const res = await download(`/v1/salons/${SALON_A}/overview/analytics.csv?period=${PERIOD}`, noura);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="overview_all-branches_${json.window.token}.csv"`,
    );
  });
});
