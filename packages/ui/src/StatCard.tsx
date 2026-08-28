import type { ReactNode } from 'react';
import { Card } from './Card.js';
import { Skeleton } from './Skeleton.js';

export interface StatCardProps {
  label: string;
  /** Already-formatted value, or a <Money> element. Never a raw fils integer. */
  value: ReactNode;
  unit?: string;
  /** Secondary line under the figure. Omitted when the API carries no delta. */
  delta?: string;
  /**
   * THE SAME SLOT AS `delta`, IN THE MUTED TONE INSTEAD OF THE POSITIVE ONE.
   *
   * `.avo-stat__delta` is coloured `--avo-positive`, because everything that has
   * ever gone in it — "+48 this week", "62% via KNET", "next at 4:30 PM" — is
   * good news about a figure that is present. A tile that has NO figure needs
   * the same line for the opposite job: saying why the value slot is a dash.
   * Rendering that in the positive green would read as a boast about an absence.
   *
   * So `note` is not a second `delta` with different words, it is the neutral
   * register of the same line, and the two are mutually exclusive by
   * construction: a tile either has a value with something to add about it, or
   * has no value and owes an explanation. `delta` wins if both are passed, which
   * is a caller bug rather than a layout to design for.
   *
   * Merchant → Overview's "Loaded today" under a branch filter is the case this
   * was added for; `GET /salons/{id}/metrics` answers `loadedTodayFils: null`
   * there on purpose, and the tile must not invent a zero.
   */
  note?: string;
  loading?: boolean;
}

/** The Overview KPI tile from AVO Merchant Dashboard.dc.html. */
export function StatCard({ label, value, unit, delta, note, loading = false }: StatCardProps) {
  const muted = delta === undefined && note !== undefined;
  return (
    <Card>
      <div className="avo-label">{label}</div>
      <div className="avo-stat__value">
        {loading ? (
          <Skeleton width={92} height={30} />
        ) : (
          <>
            <span className="avo-stat__number">{value}</span>
            {unit ? <span className="avo-stat__unit">{unit}</span> : null}
          </>
        )}
      </div>
      <div className={muted ? 'avo-stat__delta avo-stat__delta--note' : 'avo-stat__delta'}>
        {loading ? <Skeleton width={110} height={11} /> : (delta ?? note ?? '')}
      </div>
    </Card>
  );
}
