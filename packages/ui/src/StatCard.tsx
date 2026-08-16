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
  loading?: boolean;
}

/** The Overview KPI tile from AVO Merchant Dashboard.dc.html. */
export function StatCard({ label, value, unit, delta, loading = false }: StatCardProps) {
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
      <div className="avo-stat__delta">
        {loading ? <Skeleton width={110} height={11} /> : (delta ?? '')}
      </div>
    </Card>
  );
}
