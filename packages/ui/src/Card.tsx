import type { HTMLAttributes } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Drop the padding when the card owns its own internal rhythm (lists, tables). */
  flush?: boolean;
}

export function Card({ flush = false, className, ...rest }: CardProps) {
  return (
    <div
      className={['avo-card', flush ? 'avo-card--flush' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
}
