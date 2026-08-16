import type { ReactNode } from 'react';
import { Button } from './Button.js';

export interface EmptyStateProps {
  /** interaction-spec.md §4: name the thing. */
  title: string;
  /** …and offer the one action that fills it. No illustrations. */
  body: string;
  action?: { label: string; onClick: () => void };
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <div className="avo-state">
      <div className="avo-state__title">{title}</div>
      <p className="avo-state__body">{body}</p>
      {action ? (
        <div className="avo-state__actions">
          <Button onClick={action.onClick}>{action.label}</Button>
        </div>
      ) : null}
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  body: string;
  /**
   * Present only for "we failed". A "you can't do that" error explains and
   * offers nothing to retry — interaction-spec.md §4.
   */
  onRetry?: () => void;
  retrying?: boolean;
}

export function ErrorState({ title, body, onRetry, retrying = false }: ErrorStateProps) {
  return (
    <div className="avo-state" role="alert">
      <div className="avo-state__title">{title}</div>
      <p className="avo-state__body">{body}</p>
      {onRetry ? (
        <div className="avo-state__actions">
          <Button onClick={onRetry} disabled={retrying}>
            {retrying ? 'Trying…' : 'Try again'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface StaleBannerProps {
  /** When the figures on screen were last successfully fetched. */
  updatedAt: number;
  onRetry?: () => void;
  retrying?: boolean;
  children?: ReactNode;
}

/**
 * Stale-not-blank. interaction-spec.md §4: "Network failure keeps the last-known
 * data visible with a stale banner rather than blanking." A merchant who sees
 * the figures vanish assumes the money did too.
 */
export function StaleBanner({ updatedAt, onRetry, retrying = false }: StaleBannerProps) {
  const stamp = new Date(updatedAt).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <div className="avo-stale" role="status">
      <span className="avo-stale__dot" aria-hidden="true" />
      <span className="avo-stale__text">
        Couldn&rsquo;t refresh. Showing figures from {stamp}.
      </span>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Trying…' : 'Retry'}
        </Button>
      ) : null}
    </div>
  );
}
