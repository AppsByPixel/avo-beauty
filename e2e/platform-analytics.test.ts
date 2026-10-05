/**
 * THE OWNER CONSOLE ANALYTICS — `GET /v1/platform/analytics`, `GET /v1/platform/analytics.csv`
 * and the one-time link, `POST /v1/platform/analytics/download-url` redeemed at
 * `GET /report-downloads/:token`. Lane A's `22b32ad` (migrations 0071, 0072), the wire
 * shape landed by trunk as `PlatformAnalyticsSchema` (`cbd06c7`).
 *
 * HOW TO RUN
 *
 *   cd e2e && AVO_QA_DB=avo_lane_d ../node_modules/.bin/vitest run platform-analytics.test.ts
 *
 * WHAT THE LEDGERS SAY, AND WHAT THEY CANNOT
 * ------------------------------------------
 * `permission-census.test.ts` pins all three doors `→ analytics` and drives each with the
 * section off and restored. `contract.test.ts` probes the JSON through
 * `PlatformAnalyticsSchema` in three arms and classifies the file. `tenancy.test.ts` drives
 * `?salon=` (unknown 404, repeated 400, a filtered answer is that salon's alone, in SQL).
 * `console.test.ts` sweeps a merchant credential and a forged token across all three.
 *
 * None of them can ask the questions below, because each is about the CONTENT of a 200,
 * the COPY of a refusal, or a SEQUENCE of requests:
 *
 *   1. a merchant manager's dashboard session and a scanner PIN session are refused at all
 *      three doors with the owner-console copy — the surface half, before any section;
 *   2. `campaigns` is withheld without `approvals` and `support` without `policies`, inside
 *      the 200 — on the JSON, on the `.csv` door, and on a link minted with both bits ON
 *      and redeemed after they were revoked (the admin row is re-read at redemption);
 *   3. mint → the row is a CONSOLE row (`platform_admin_id` set, `staff_id` NULL) → redeem
 *      once → the second redeem is refused → exactly one `download-link` audit row, in the
 *      platform log, naming the admin;
 *   4. migration 0071's `report_download_one_principal` refuses a row with BOTH principals
 *      and a row with NEITHER, attempted in SQL;
 *   5. every KD cell in the file is integer fils at three decimals, and each one is a fils
 *      figure the JSON serves for the same query.
 *
 * Every claim about what was WRITTEN is read back from Postgres, never from the reply.
 *
 * NOT RE-ASSERTED HERE, BY INSTRUCTION: "a refused export writes no audit row and no
 * link". Lane A's `api/src/routes/platformAnalytics.int.test.ts` owns it —
 * `the support preset holds no analytics: 403 on all three routes, called directly, and
 * nothing written` (`863bb7d`) and `a refused mint writes no row` (staff and support
 * principals). The two refusals THIS lane adds a row count to are the ones those do not
 * reach — an unknown and a repeated `?salon=` — and they are in `tenancy.test.ts`.
 *
 * THE PRINCIPALS. Salem (PLT-003) holds all nine and is not the owner, so one bit at a time
 * can be revoked; every revoke is restored in `afterEach`. Mariam (PLT-002) is the seeded
 * analyst — `analytics` without `approvals` or `policies` — and is never edited, so her
 * refusals are the product's state, not this file's SQL. Yousef (PLT-001) mints the links
 * whose rows are inspected.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { precondition } from './support/known-bug.js';
import {
  B_STAFF_HANDLE,
  PLATFORM_ADMIN2,
  PLATFORM_ADMIN2_HANDLE,
  PLATFORM_ANALYST,
  PLATFORM_ANALYST_HANDLE,
  PLATFORM_OWNER,
  PLATFORM_OWNER_HANDLE,
  SALON_A,
  SALON_B,
  psql,
  scalar,
  signInDashboard,
  signInPlatform,
  signInScanner,
  startTenancyApi,
  stopTenancyApi,
  tenancyBaseUrl,
  treq,
} from './support/tenancy-harness.js';

/** Noura, ST-001, salon A's manager. `api/src/db/seed.ts`. */
const A_STAFF_HANDLE = 'noura';
/** Salon A's seeded scanner device. `api/src/db/seed.ts`. */
const A_SCANNER_DEVICE = 'DEV-SCANNER-01';

/** `auth/principal.ts § requirePlatformScope`. */
const CONSOLE_ONLY = 'This endpoint is the AVO owner console, not the salon dashboard.';

const ROUTES = [
  { method: 'GET', path: '/v1/platform/analytics' },
  { method: 'GET', path: '/v1/platform/analytics.csv' },
  { method: 'POST', path: '/v1/platform/analytics/download-url', body: {} },
] as const;

let owner = '';
let salem = '';
let analyst = '';
let noura = '';
let layla = '';
let pin = '';

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
  /** Decoded with the BOM KEPT. */
  text: string;
}

/** Plain `fetch`: `Response.text()` strips the BOM, and `treq` drops the headers. */
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
 * RFC 4180 for an all-quoted file. A copy of `overview-export.test.ts § parseCsv` and
 * deliberately so: `platformCsv` IS `overviewCsv`, and if the two files ever stop
 * agreeing on quoting, both parsers refusing is the signal. Refuses an unquoted byte.
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

/** `59.250` → 59250 by string arithmetic — no float touches it (non-negotiable #1). */
function kdToFils(value: string, where: string): number {
  const m = /^(\d+)\.(\d{3})$/.exec(value);
  if (!m) throw new Error(`${where}: money cell ${JSON.stringify(value)} is not KD to three decimals`);
  return Number(m[1]) * 1000 + Number(m[2]);
}

async function json(query: string, token: string): Promise<any> {
  const res = await treq<any>('GET', `/v1/platform/analytics${query}`, { token });
  expect(res.status, `the JSON${query}: ${res.raw.slice(0, 400)}`).toBe(200);
  return res.body;
}

async function csv(query: string, token: string): Promise<Row[]> {
  const res = await download(`/v1/platform/analytics.csv${query}`, token);
  expect(res.status, `the CSV${query}: ${res.text.slice(0, 400)}`).toBe(200);
  return parseCsv(res.text);
}

async function mintToken(body: Record<string, unknown>, token = owner): Promise<string> {
  const res = await treq<{ url: string; expiresAt: string }>(
    'POST',
    '/v1/platform/analytics/download-url',
    { token, body },
  );
  expect(res.status, `the console mint: ${res.raw}`).toBe(200);
  const t = res.body.url.replace('/report-downloads/', '');
  expect(t, `the mint did not return a token url: ${res.raw}`).toMatch(/^tok_[A-Za-z0-9_-]+$/);
  return t;
}

/** Redeem with NO session — the whole point of the route. */
const redeem = (token: string) => download(`/report-downloads/${token}`, null);

const withheldRow = (section: string, permission: string): Row => ({
  section,
  item: '',
  metric: 'withheld',
  value: `permission: ${permission}`,
  unit: '',
});

// ------------------------------------------------------------- the database --

const count = (sql: string): number => Number(scalar(sql).trim());

const linkAudits = (actor: string): number =>
  count(`select count(*) from audit_log
          where actor_id = '${actor}' and actor_kind = 'platform_admin' and salon_id is null
            and action = 'Report exported' and subject_id = 'platform-analytics'
            and metadata->>'via' = 'download-link'`);

const rowOf = (token: string): string =>
  scalar(
    `select concat_ws('|', kind, coalesce(platform_admin_id, '-'), coalesce(staff_id, '-'),
                      coalesce(salon_id, '-'), coalesce(branch_id, '-'), period, (used_at is null))
       from report_download where token_hash = encode(sha256('${token}'::bytea), 'hex')`,
  ).trim();

const SECTION_COLUMN = { approvals: 'perm_approvals', policies: 'perm_policies' } as const;

function setSection(section: keyof typeof SECTION_COLUMN, on: boolean): void {
  psql(`UPDATE platform_admin SET ${SECTION_COLUMN[section]} = ${on} WHERE id = '${PLATFORM_ADMIN2}';`);
  precondition(
    scalar(`select ${SECTION_COLUMN[section]} from platform_admin where id = '${PLATFORM_ADMIN2}'`).trim() ===
      (on ? 't' : 'f'),
    `${section} did not go ${on ? 'on' : 'off'} for ${PLATFORM_ADMIN2}`,
  );
}

function restoreSalem(): void {
  psql(`
    UPDATE platform_admin
       SET perm_analytics = true, perm_activity = true, perm_salons = true,
           perm_accounts = true, perm_admins = true, perm_controls = true,
           perm_approvals = true, perm_policies = true, perm_audit = true,
           active = true
     WHERE id = '${PLATFORM_ADMIN2}';
  `);
}

beforeAll(async () => {
  await startTenancyApi();
  restoreSalem();
  owner = await signInPlatform(PLATFORM_OWNER_HANDLE);
  salem = await signInPlatform(PLATFORM_ADMIN2_HANDLE);
  analyst = await signInPlatform(PLATFORM_ANALYST_HANDLE);
  noura = await signInDashboard(SALON_A, A_STAFF_HANDLE);
  layla = await signInDashboard(SALON_B, B_STAFF_HANDLE);
  pin = await signInScanner(SALON_A, A_STAFF_HANDLE, A_SCANNER_DEVICE);

  precondition(
    scalar(`select concat_ws(',', perm_analytics, perm_approvals, perm_policies, owner)
              from platform_admin where id = '${PLATFORM_ANALYST}'`).trim() === 't,f,f,f',
    `${PLATFORM_ANALYST} is not the seeded analyst (analytics, no approvals, no policies)`,
  );
}, 180_000);

afterEach(() => {
  restoreSalem();
});

afterAll(async () => {
  restoreSalem();
  await stopTenancyApi();
});

// ===========================================================================

describe('a merchant credential is refused at all three doors, by the surface, with the console copy', () => {
  /**
   * `requirePlatformScope` refuses on `kind`, one line before any section is read. Noura
   * holds every merchant permission her salon can grant, so a leak would show for her
   * first; Layla is the other salon's manager; the PIN session is Noura on the scanner.
   * The copy is the assertion that says WHICH guard answered — a section refusal is also
   * 403 `forbidden`.
   */
  for (const [who, token] of [
    ['salon A\'s manager (dashboard)', () => noura],
    ['salon B\'s manager (dashboard)', () => layla],
    ['a scanner PIN session', () => pin],
  ] as const) {
    for (const route of ROUTES) {
      it(`${route.method} ${route.path} — ${who} → 403, the owner-console copy`, async () => {
        const res = await treq<any>(route.method, route.path, {
          token: token(),
          body: 'body' in route ? route.body : undefined,
        });
        expect(res.status, `${route.method} ${route.path} answered ${res.status} to ${who}: ${res.raw}`).toBe(403);
        expect(res.body.error).toBe('forbidden');
        expect(res.body.message, `refused, but not by the surface wall`).toBe(CONSOLE_ONLY);
      }, 60_000);
    }
  }
});

// ===========================================================================

describe('campaigns needs approvals and support needs policies — inside the 200', () => {
  it('Salem with approvals off: campaigns withheld naming approvals, support still served — JSON and file', async () => {
    setSection('approvals', false);
    const body = await json('', salem);
    expect(body.campaigns).toEqual({ status: 'withheld', reason: 'permission', permission: 'approvals' });
    expect(body.support?.status, `support with policies held: ${JSON.stringify(body.support)}`).toBe('ok');

    const rows = await csv('', salem);
    expect(rows).toContainEqual(withheldRow('Campaigns', 'approvals'));
    expect(rows.filter((r) => r.section === 'Campaigns'), 'the file carries campaign figures beside the withheld row').toHaveLength(1);
    expect(rows.some((r) => r.section === 'Support' && r.metric !== 'withheld'), 'support left the file too').toBe(true);
  });

  it('Salem with policies off: support withheld naming policies, campaigns still served — JSON and file', async () => {
    setSection('policies', false);
    const body = await json('', salem);
    expect(body.support).toEqual({ status: 'withheld', reason: 'permission', permission: 'policies' });
    expect(body.campaigns?.status, `campaigns with approvals held: ${JSON.stringify(body.campaigns)}`).toBe('ok');

    const rows = await csv('', salem);
    expect(rows).toContainEqual(withheldRow('Support', 'policies'));
    expect(rows.filter((r) => r.section === 'Support'), 'the file carries support figures beside the withheld row').toHaveLength(1);
    expect(rows.some((r) => r.section === 'Campaigns' && r.metric !== 'withheld'), 'campaigns left the file too').toBe(true);
  });

  it('the pair: with both held, Salem is served both blocks in the JSON and the file', async () => {
    const body = await json('', salem);
    expect(body.campaigns?.status).toBe('ok');
    expect(body.support?.status).toBe('ok');
    const rows = await csv('', salem);
    expect(rows.some((r) => r.metric === 'withheld'), JSON.stringify(rows.filter((r) => r.metric === 'withheld'))).toBe(false);
  });

  it('the seeded analyst, untouched by this file: both withheld, on the JSON and in the file', async () => {
    const body = await json('', analyst);
    expect(body.campaigns).toEqual({ status: 'withheld', reason: 'permission', permission: 'approvals' });
    expect(body.support).toEqual({ status: 'withheld', reason: 'permission', permission: 'policies' });
    const rows = await csv('', analyst);
    expect(rows).toContainEqual(withheldRow('Campaigns', 'approvals'));
    expect(rows).toContainEqual(withheldRow('Support', 'policies'));
  });

  it('the link: minted with both ON, both revoked before the click, redeemed with both withheld', async () => {
    const token = await mintToken({}, salem);
    setSection('approvals', false);
    setSection('policies', false);
    const served = await redeem(token);
    expect(served.status, served.text.slice(0, 300)).toBe(200);
    const rows = parseCsv(served.text);
    expect(rows, 'the redemption served campaigns the admin row no longer may see').toContainEqual(
      withheldRow('Campaigns', 'approvals'),
    );
    expect(rows, 'the redemption served support the admin row no longer may see').toContainEqual(
      withheldRow('Support', 'policies'),
    );
  });
});

// ===========================================================================

describe('the console one-time link is a console row, spent by its first redemption, audited once', () => {
  it('mint → platform_admin_id set, staff_id NULL → redeem once → the second redeem is refused', async () => {
    const scope = await json('', owner);
    const period = `${scope.month}_${scope.months.length}m`;
    const auditsBefore = linkAudits(PLATFORM_OWNER);

    const token = await mintToken({});
    expect(rowOf(token), 'the mint wrote no console row, or the wrong one').toBe(
      `platform-analytics|${PLATFORM_OWNER}|-|-|-|${period}|t`,
    );

    const first = await redeem(token);
    expect(first.status, `the first redemption: ${first.text.slice(0, 300)}`).toBe(200);
    expect(first.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(first.headers.get('content-disposition')).toBe(
      `attachment; filename="platform-analytics_all-salons_${period}.csv"`,
    );
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect([...first.bytes.slice(0, 3)], 'the file opens with a UTF-8 BOM').toEqual([0xef, 0xbb, 0xbf]);
    const rows = parseCsv(first.text);
    expect(rows).toContainEqual({ section: 'Scope', item: '', metric: 'salon', value: 'All salons', unit: '' });

    expect(rowOf(token).endsWith('|f'), 'the redemption did not spend the token').toBe(true);
    expect(linkAudits(PLATFORM_OWNER), 'a served console link writes exactly one audit row').toBe(auditsBefore + 1);
    // The act, never the content: no figure on the row, and the platform log, not a salon's.
    expect(
      scalar(`select concat_ws('|', coalesce(amount_fils::text, '-'), source,
                              coalesce(metadata->>'section', 'null'), coalesce(metadata->>'salonId', 'null'))
                from audit_log
               where actor_id = '${PLATFORM_OWNER}' and subject_id = 'platform-analytics'
                 and metadata->>'via' = 'download-link'
               order by seq desc limit 1`).trim(),
    ).toBe('-|owner_console|null|null');

    const second = await redeem(token);
    expect(second.status, `the second redemption: ${second.text}`).toBe(401);
    expect(JSON.parse(second.text).error).toBe('invalid_download');
    expect(second.text, 'the refusal carries no part of the file').not.toContain('Scope');
    expect(linkAudits(PLATFORM_OWNER), 'a refused redemption wrote an export audit row').toBe(auditsBefore + 1);
  });

  it(`a link scoped to ${SALON_A} and one section stores both, and redeems as exactly that`, async () => {
    const token = await mintToken({ salon: SALON_A, section: 'leaderboard' });
    const [kind, admin, staff, salonId] = rowOf(token).split('|');
    expect([kind, admin, staff, salonId]).toEqual([
      'platform-analytics:leaderboard',
      PLATFORM_OWNER,
      '-',
      SALON_A,
    ]);

    const served = await redeem(token);
    expect(served.status, served.text.slice(0, 300)).toBe(200);
    const rows = parseCsv(served.text);
    expect([...new Set(rows.map((r) => r.section))]).toEqual(['Scope', 'Salon leaderboard']);
    const name = scalar(`select name from salon where id = '${SALON_A}'`).trim();
    expect(rows).toContainEqual({ section: 'Scope', item: '', metric: 'salon', value: `${name} (${SALON_A})`, unit: '' });
    const board = rows.filter((r) => r.section === 'Salon leaderboard');
    // The block's one item-less row is its salon count, and it must say one.
    expect(board.filter((r) => r.item === '')).toEqual([
      { section: 'Salon leaderboard', item: '', metric: 'salons', value: '1', unit: 'count' },
    ]);
    const items = new Set(board.filter((r) => r.item !== '').map((r) => r.item));
    expect([...items], 'a salon A link served another salon\'s leaderboard row').toEqual([name]);
    expect(board).toContainEqual({ section: 'Salon leaderboard', item: name, metric: 'salon id', value: SALON_A, unit: '' });
  });
});

// ===========================================================================

describe("migration 0071's report_download_one_principal, attempted in SQL", () => {
  /**
   * Lane A's int spec attempts the same four shapes against its own database; this is
   * the two the brief names, against the database this suite's API is serving, so the
   * constraint is known to be on the schema `lane-db.sh` migrated — not only on the one
   * a unit run built. Each attempt carries a unique token hash so a refusal is the CHECK
   * and nothing else.
   */
  const attempt = (staff: string | null, admin: string | null, salon: string | null, kind: string): string => {
    const lit = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);
    try {
      psql(`
        INSERT INTO report_download (staff_id, platform_admin_id, salon_id, kind, period, token_hash, expires_at)
        VALUES (${lit(staff)}, ${lit(admin)}, ${lit(salon)}, '${kind}', '2026-10_12m',
                'qa-one-principal-${Date.now()}-${Math.random().toString(36).slice(2)}',
                now() + interval '1 minute');
      `);
      return '';
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const leftovers = () => count(`select count(*) from report_download where token_hash like 'qa-one-principal-%'`);

  it('refuses a row holding BOTH a staff member and a platform admin', () => {
    const before = leftovers();
    expect(attempt('ST-001', PLATFORM_OWNER, SALON_A, 'platform-analytics')).toMatch(/report_download_one_principal/);
    expect(attempt('ST-001', PLATFORM_OWNER, SALON_A, 'sales')).toMatch(/report_download_one_principal/);
    expect(leftovers()).toBe(before);
  });

  it('refuses a row holding NEITHER', () => {
    const before = leftovers();
    expect(attempt(null, null, null, 'platform-analytics')).toMatch(/report_download_one_principal/);
    expect(attempt(null, null, SALON_A, 'sales')).toMatch(/report_download_one_principal/);
    expect(leftovers()).toBe(before);
  });
});

// ===========================================================================

describe('the file is the JSON — every KD cell is integer fils the JSON serves for the same query', () => {
  /**
   * Lane A's int spec reconciles the two byte for byte on its own fixture. This asks the
   * SERVED routes on the seeded platform, as `overview-export.test.ts` does for the
   * Overview: every `KD` cell is digits-dot-three-digits (so no float was rendered), and
   * the multiset of those fils values is contained in the multiset of every `*Fils` (and
   * bare `fils`) number in the JSON for the same query. A file figure the JSON does not serve is a
   * second computation, which is what "one answer, two renderings" rules out.
   */
  for (const query of ['', `?salon=${SALON_A}`]) {
    it(`?${query.slice(1) || 'every salon'}: every KD row is a JSON fils figure`, async () => {
      const body = await json(query, owner);
      const rows = await csv(query, owner);

      const pool = new Map<number, number>();
      const walk = (v: unknown, key = ''): void => {
        if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
        if (v !== null && typeof v === 'object') {
          for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k);
          return;
        }
        // `fils` bare too: the payment mix's `methods.<m>.fils` and `depositsHeld.fils`.
        if ((/Fils$/.test(key) || key === 'fils') && typeof v === 'number') pool.set(v, (pool.get(v) ?? 0) + 1);
      };
      walk(body);

      const money = rows.filter((r) => r.unit === 'KD');
      expect(money.length, 'the file carries no KD row, so this proved nothing').toBeGreaterThan(0);
      const unmatched: string[] = [];
      for (const r of money) {
        const f = kdToFils(r.value, `${r.section} / ${r.item} / ${r.metric}`);
        const left = pool.get(f) ?? 0;
        if (left === 0) unmatched.push(`${r.section} / ${r.item} / ${r.metric} = ${r.value}`);
        else pool.set(f, left - 1);
      }
      expect(unmatched, 'KD rows with no matching fils figure in the JSON for the same query').toEqual([]);
    });
  }
});
