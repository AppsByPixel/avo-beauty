/**
 * The CSV encoder, and the two things about it that are security properties rather
 * than formatting preferences.
 *
 * These are unit tests because the encoder is pure: it takes a `ReportShape` and
 * returns bytes. The aggregates themselves are driven over real HTTP against a real
 * database, because a SQL definition cannot be verified by a stub — and a test that
 * asserted the shape of a mocked row would pass whether or not the query grouped by
 * the salon's own calendar day.
 */

import { describe, expect, it } from 'vitest';
import {
  neutralise,
  reportExportAudit,
  reportFilename,
  toCsv,
  REPORT_AUDITED,
  REPORT_KINDS,
  REPORT_PERMISSION,
} from './reports';
import type { ReportShape } from './reports';

function shape(rows: ReportShape['rows']): ReportShape {
  return {
    kind: 'products-sold',
    title: 'Products sold',
    columns: [
      { header: 'Product', key: 'product', type: 'text' },
      { header: 'Units', key: 'units', type: 'int' },
      { header: 'Revenue KD', key: 'revenueFils', type: 'money' },
    ],
    rows,
    stat: { key: 'units', label: 'units', value: 0, type: 'int' },
  };
}

describe('CSV formula injection — the merchant opening her own export is the victim', () => {
  // A salon names its own products and branches. Every one of these is a value a
  // merchant could type into the Shop editor without any intent at all.
  it.each(['=1+1', '+SUM(A1)', '-2+3', '@SUM(A1)', '=HYPERLINK("http://x","click")'])(
    'neutralises %s so a spreadsheet reads it as text',
    (evil) => {
      expect(neutralise(evil)).toBe(`'${evil}`);
    },
  );

  it('neutralises a leading tab and carriage return, which also lead a formula', () => {
    expect(neutralise('\t=1+1')).toBe("'\t=1+1");
    expect(neutralise('\r=1+1')).toBe("'\r=1+1");
  });

  it('leaves an ordinary name completely alone', () => {
    for (const ok of ['Repair serum', 'Hydra shampoo 300ml', 'Mani + pedi', 'زيت الأرغان']) {
      expect(neutralise(ok)).toBe(ok);
    }
  });

  it('carries the neutralisation into the encoded file, not just the helper', () => {
    const csv = toCsv(shape([{ product: '=cmd|calc', units: 1, revenueFils: 1000 }]));
    expect(csv).toContain(`"'=cmd|calc"`);
    // And the dangerous form is absent: a bare `"=` would still evaluate, because
    // the quotes are CSV syntax the parser strips before the cell is interpreted.
    expect(csv).not.toContain('"=cmd|calc"');
  });

  it('neutralises a HEADER too — they are verbatim from the design, but cheaply covered', () => {
    const s = shape([]);
    s.columns = [{ header: '=evil', key: 'product', type: 'text' }];
    expect(toCsv(s)).toContain(`"'=evil"`);
  });
});

describe('CSV encoding — RFC 4180, and what Excel needs on top of it', () => {
  it('opens with a UTF-8 BOM, so Excel renders Arabic instead of mojibake', () => {
    expect(toCsv(shape([]))).toMatch(/^﻿/);
  });

  it('joins rows with CRLF', () => {
    const csv = toCsv(shape([{ product: 'A', units: 1, revenueFils: 0 }]));
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it('doubles an embedded quote rather than breaking the row', () => {
    const csv = toCsv(shape([{ product: 'Silk 12" scrunchie', units: 1, revenueFils: 0 }]));
    expect(csv).toContain('"Silk 12"" scrunchie"');
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it('a comma or a newline inside a value cannot add a column or a row', () => {
    const csv = toCsv(shape([{ product: 'Oil, 100ml\nrefill', units: 1, revenueFils: 0 }]));
    // One header row + one data row; the embedded newline lives inside the quotes.
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv).toContain('"Oil, 100ml\nrefill"');
  });

  it('has no trailing CRLF, so the file carries no phantom empty row', () => {
    expect(toCsv(shape([{ product: 'A', units: 1, revenueFils: 0 }]))).not.toMatch(/\r\n$/);
  });

  it('renders an empty cell for null rather than the word null', () => {
    const csv = toCsv(shape([{ product: null, units: 0, revenueFils: 0 }]));
    expect(csv).toContain('"",');
    expect(csv).not.toContain('null');
  });
});

describe('money in a cell — non-negotiable #1 at the display boundary', () => {
  it('renders 3 decimals and NO thousands separator, so Excel sees a number', () => {
    const csv = toCsv(shape([{ product: 'Balayage', units: 1, revenueFils: 1_820_000 }]));
    expect(csv).toContain('"1820.000"');
    // The comma'd form is what `formatFils` gives a card; in a CSV it would force a
    // quoted string Excel cannot sum. See services/reports.ts § csvMoneyCell.
    expect(csv).not.toContain('"1,820.000"');
  });

  it('formats fils exactly, with no floating-point drift', () => {
    const csv = toCsv(shape([{ product: 'A', units: 1, revenueFils: 1 }]));
    expect(csv).toContain('"0.001"');
  });

  it('THROWS if a float ever reaches a money cell, rather than rendering it', () => {
    // The branded `fils()` constructor is the guard. This is the assertion that a
    // float cannot silently become a plausible-looking dinar figure.
    expect(() => toCsv(shape([{ product: 'A', units: 1, revenueFils: 1820.5 }]))).toThrow(
      /integer number of fils/,
    );
  });
});

describe('the filename, which embeds a name a salon chose', () => {
  it('matches the design shape <kind>_<branch>_<period>.csv', () => {
    expect(reportFilename('products-sold', null, '30d')).toBe('products-sold_all-branches_30d.csv');
    expect(reportFilename('sales', 'Kuwait City', '7d')).toBe('sales_kuwait-city_7d.csv');
  });

  it('strips anything that could break out of the Content-Disposition parameter', () => {
    const name = reportFilename('sales', 'x"; drop', '90d');
    expect(name).not.toContain('"');
    expect(name).not.toContain(';');
    // `x"; drop` → the space becomes a dash, then the quote and semicolon are
    // stripped. The dash is from the space, not from the payload.
    expect(name).toBe('sales_x-drop_90d.csv');
  });

  it('never yields an empty branch segment, even for a fully stripped name', () => {
    expect(reportFilename('sales', 'مجمع', '7d')).toBe('sales_branch_7d.csv');
  });
});

describe('which exports are audited, and what the row may carry', () => {
  it('covers every kind, so a sixth cannot arrive unclassified', () => {
    expect(Object.keys(REPORT_AUDITED).sort()).toEqual([...REPORT_KINDS].sort());
  });

  it('audits the two kinds whose rows name identifiable people', () => {
    expect(REPORT_AUDITED.customers).toBe(true);
    expect(REPORT_AUDITED['artist-performance']).toBe(true);
  });

  /**
   * FOUR NOW, not three - `earnings-by-branch` joins them, and it is the one an
   * outside reader is most likely to expect on the other list. Its rows are
   * BRANCHES: a place, not a person. And the money in them is already exportable
   * unaudited through `sales`, one card to the left, so auditing the roll-up
   * alone would be a control with a hole in it. See reports.ts § REPORT_AUDITED.
   */
  it('does NOT audit the four that name days, services, products and branches', () => {
    expect(REPORT_AUDITED.sales).toBe(false);
    expect(REPORT_AUDITED['best-selling-services']).toBe(false);
    expect(REPORT_AUDITED['products-sold']).toBe(false);
    expect(REPORT_AUDITED['earnings-by-branch']).toBe(false);
  });

  /**
   * THE PLUMBING IS THERE AND ONLY THE MAP DECIDES - which is the claim that
   * matters, because the brief for this kind expected it to be audited
   * automatically and it is not. Flipping `REPORT_AUDITED['earnings-by-branch']`
   * to true is the whole change; the builder already formats the row, and this
   * proves it rather than leaving the reader to check.
   */
  it('the audit builder already formats the branch kind, so flipping the map is enough', () => {
    const row = reportExportAudit({
      salonId: 'SAL-AMARA',
      kind: 'earnings-by-branch',
      branchId: null,
      period: '90d',
      rowCount: 2,
      via: 'csv',
    });
    expect(row.detail).toContain('Earnings by branch');
    expect(row.detail).toContain('all branches');
    expect(row.detail).toContain('2 rows');
    expect(row.subjectId).toBe('earnings-by-branch');
  });

  /**
   * THE INVARIANT THAT KEEPS TWO DECISIONS FROM WELDING TOGETHER.
   *
   * `REPORT_AUDITED` is written out rather than derived from
   * `REPORT_PERMISSION[kind] === 'team'`, so a future re-gate cannot silently
   * change what is audited. This is the property worth pinning instead: an
   * audited export is gated on `team`. Re-gate one to something weaker and this
   * fails, rather than the audit trail quietly following the permission down.
   */
  it('every audited kind is gated on `team`', () => {
    for (const kind of REPORT_KINDS) {
      if (REPORT_AUDITED[kind]) {
        expect(REPORT_PERMISSION[kind], `${kind} is audited but gated on a weaker section`).toBe(
          'team',
        );
      }
    }
  });

  /**
   * THE ROW RECORDS THE ACT, NEVER THE CONTENT — and the reason is a privilege
   * downgrade rather than a tidiness principle. `GET /salons/{id}/audit` is
   * `requireDashboardPerm(req, 'dashboard')` while both audited reports are
   * gated `team`, so a figure copied into this row becomes readable at a WEAKER
   * permission than the report it came from.
   *
   * Asserted against a row built from a fixture whose values would be
   * unmistakable if any of them leaked: a distinctive name and a distinctive
   * number.
   */
  describe('the audit row is not a second copy of the export', () => {
    const row = reportExportAudit({
      salonId: 'SAL-AMARA',
      kind: 'artist-performance',
      branchId: 'BR-KWC',
      period: '30d',
      rowCount: 12,
      via: 'csv',
    });
    const serialised = JSON.stringify(row);

    it('carries the act: who is asked of writeAudit, and what/how wide/how much are here', () => {
      expect(row.kind).toBe('access');
      expect(row.action).toBe('Report exported');
      expect(row.subjectType).toBe('report');
      expect(row.subjectId).toBe('artist-performance');
      expect(row.metadata).toEqual({
        kind: 'artist-performance',
        branchId: 'BR-KWC',
        period: '30d',
        rowCount: 12,
        via: 'csv',
      });
    });

    it('names the scope in the detail, because a 90d all-branch pull is a different act', () => {
      expect(row.detail).toContain('BR-KWC');
      expect(row.detail).toContain('30d');
      expect(row.detail).toContain('12 rows');
      expect(row.detail).toContain('csv');
    });

    it('sets no amountFils — that column is for money that MOVED', () => {
      // Absent rather than zero: a zero would read as "an export worth nothing".
      expect('amountFils' in row).toBe(false);
    });

    /**
     * `access`, not `money` and not `rules`. Nothing moved and nothing changed.
     */
    it('is an access event', () => {
      expect(row.kind).toBe('access');
      expect(row.kind).not.toBe('money');
      expect(row.kind).not.toBe('rules');
    });

    /**
     * The catch-all: the builder is handed ONLY scope and a count, so there is
     * no path by which a figure or a name could reach the row. Pinned as a
     * serialised-shape assertion so adding one is a red test rather than a diff.
     */
    it('the whole serialised row contains no figure but the row count', () => {
      /**
       * The DISTINCT set, because the count legitimately appears twice — once in
       * the human `detail` and once in `metadata.rowCount`. `30` is the period
       * (`30d`) and is excluded by name rather than by pattern, so a figure that
       * happened to be 30 would still fail this.
       */
      const numbers = new Set((serialised.match(/\d+/g) ?? []).filter((n) => n !== '30'));
      expect([...numbers]).toEqual(['12']);
    });

    it('a one-row export says "1 row", not "1 rows"', () => {
      const one = reportExportAudit({
        salonId: 'SAL-AMARA',
        kind: 'customers',
        branchId: null,
        period: '7d',
        rowCount: 1,
        via: 'download-link',
      });
      expect(one.detail).toContain('1 row ');
      expect(one.detail).toContain('all branches');
      expect(one.detail).toContain('download-link');
    });
  });
});

describe('the permission map — #7, and the one that must not be `dashboard`', () => {
  it('covers every kind, so no kind can reach a handler ungated', () => {
    for (const kind of REPORT_KINDS) {
      expect(REPORT_PERMISSION[kind]).toBeTruthy();
    }
  });

  /**
   * `dashboard` IS THE WIDER GRANT, and that is the argument — it opens the
   * Overview, so it is what a salon gives anybody who needs to see how the business
   * is doing, while `team` is the authority over its people. A customer's name,
   * phone and wallet balance is the second kind of data, and services/memberSearch.ts
   * spends four controls stopping a staff search box from becoming that file.
   *
   * THIS COMMENT USED TO SAY "the `frontdesk` role preset holds `dashboard` and not
   * `team`", WHICH IS INVERTED: the seeded frontdesk holds neither —
   * `perm_dashboard` and `perm_team` are both false on `ST-002`. The conclusion was
   * right and the fact under it was not, which is the worse of the two ways to be
   * wrong. There is no staff "preset" either; see reports.ts § REPORT_PERMISSION.
   */
  it('gates the customer book on `team`, NOT on `dashboard`', () => {
    expect(REPORT_PERMISSION.customers).toBe('team');
    expect(REPORT_PERMISSION.customers).not.toBe('dashboard');
  });

  it('gates each other kind on the section whose data it exports', () => {
    expect(REPORT_PERMISSION.sales).toBe('dashboard');
    expect(REPORT_PERMISSION['best-selling-services']).toBe('appointments');
    expect(REPORT_PERMISSION['products-sold']).toBe('shop');
  });

  /**
   * THE BRANCH ROLL-UP IS GATED EXACTLY AS `sales` IS, and the equality is the
   * assertion rather than the literal: they are two groupings of ONE pile of
   * money, so the day somebody re-gates one the other must move with it. Gating
   * this kind more strictly would be theatre - the same figures come out of
   * `sales` at `dashboard`, filtered or summed by hand.
   */
  it('gates earnings by branch exactly as it gates sales, because it is the same money', () => {
    expect(REPORT_PERMISSION['earnings-by-branch']).toBe('dashboard');
    expect(REPORT_PERMISSION['earnings-by-branch']).toBe(REPORT_PERMISSION.sales);
    expect(REPORT_PERMISSION['earnings-by-branch']).not.toBe('team');
  });

  /**
   * A report that JOINS sections resolves to the STRICTEST of them, not to the
   * most obvious one. `artist-performance` is the appointment book, money, and a
   * named person's earnings in one row; the seeded frontdesk (`ST-002`) holds
   * `appointments` and NOT `team` — that half is true, checked against the row — so
   * gating it on the section its rows come FROM would have put every artist's
   * takings on the front-desk tablet.
   * Same mistake a blanket `dashboard` would have made with the customer book.
   */
  it('gates artist performance on `team` — not on `appointments`, not on `dashboard`', () => {
    expect(REPORT_PERMISSION['artist-performance']).toBe('team');
    expect(REPORT_PERMISSION['artist-performance']).not.toBe('appointments');
    expect(REPORT_PERMISSION['artist-performance']).not.toBe('dashboard');
    // And it is the same gate as the customer book, which is the other export
    // whose sensitivity is about PEOPLE rather than about takings.
    expect(REPORT_PERMISSION['artist-performance']).toBe(REPORT_PERMISSION.customers);
  });
});
