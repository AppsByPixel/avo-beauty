import {
  createContext,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { onlineManager } from '@tanstack/react-query';
import { IconButton, IconDownload, InlineError } from '@avo/ui';
import { ApiError } from '../api/client.js';
import { downloadAnalyticsCsv, type AnalyticsSectionKey } from '../api/analytics.js';
import { useSalonId } from '../auth/AuthProvider.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MERCHANT → OVERVIEW → EXPORT. Aftab, 2026-10-02: "want export option to get
 * the valuable widget info they are giving on the dashboard".
 * ═══════════════════════════════════════════════════════════════════════════
 * One mechanism, the Reports mint (`api/download.ts`), behind three kinds of
 * control:
 *
 *   THE ANALYTICS HEAD'S "Export"  every section, `section` absent. The server
 *       writes the sections she may see and a row naming the reason for each she
 *       may not.
 *   EACH CARD'S "Export"  that card's `section` only. Quiet (`IconButton quiet`)
 *       because it repeats on every card, and NOT DRAWN on a withheld card or
 *       before the card's figures have arrived.
 *   GROSS BY DAY  the same quiet control, outside the grid, through
 *       `useCardExport` and the Overview-wide `OverviewExportProvider`.
 *
 * THE SCOPE IS THE SERVER'S ECHO, NOT THE REQUEST — the branch and window each
 * panel is DRAWN against, for `Overview.tsx § appliedBranchOf`'s reason: if the
 * workspace answered for a different branch than was asked, the file must match
 * the card, not the selector.
 *
 * PERMISSION: the mint is `perms.dashboard`, the Overview's gate, and the
 * per-section gates are applied by the server inside the file. The client hides
 * nothing on a guess; a refusal is the server's sentence, inline and verbatim.
 */

export type ExportTarget = AnalyticsSectionKey | 'all';

export interface ExportScope {
  /** A branch id or 'all'. */
  branch: string;
  period: string;
}

export interface AnalyticsExporter {
  run: (target: ExportTarget, scope: ExportScope) => Promise<void>;
  /** The browser says it is offline. A connectivity failure on a read is added by the panel. */
  offline: boolean;
}

/**
 * THE WIRING, as a function so the export tests drive exactly what the host
 * mounts.
 */
export function analyticsExporter(salonId: string, offline: boolean): AnalyticsExporter {
  return {
    offline,
    run: (target, scope) =>
      downloadAnalyticsCsv(salonId, {
        ...scope,
        ...(target === 'all' ? {} : { section: target }),
      }),
  };
}

/**
 * THE OVERVIEW'S EXPORTER, for the panels outside the analytics grid.
 *
 * Null wherever no provider is mounted — every render test that drives a card
 * directly — and a card with no exporter draws no control, so those tests see
 * the card exactly as it was.
 */
export const OverviewExporterContext = createContext<AnalyticsExporter | null>(null);

/**
 * Mounted once by `Overview`. The salon comes from the session, and offline is
 * the browser's own signal — the one TanStack already listens to. A failed read
 * is the other half, and each panel adds its own (`AnalyticsGrid` § offline):
 * the browser can be "online" on a network that does not reach the workspace.
 */
export function OverviewExportProvider({ children }: { children: ReactNode }) {
  const salonId = useSalonId();
  const online = useSyncExternalStore(
    (notify) => onlineManager.subscribe(notify),
    () => onlineManager.isOnline(),
    () => true,
  );
  return (
    <OverviewExporterContext.Provider value={analyticsExporter(salonId, !online)}>
      {children}
    </OverviewExporterContext.Provider>
  );
}

/** The on-control copy. "No connection" is the house's offline title, reused. */
export const EXPORT_LABEL = { idle: 'Export', pending: 'Preparing…', offline: 'No connection' } as const;

/**
 * ONE EXPORT'S STATE: pending, and the last refusal. Per control, so two cards
 * do not share a spinner or an error. A second press while pending is dropped
 * here as well as by `disabled`, because the link is single-use and a double
 * click would mint two.
 */
export function useExportAction(run: (() => Promise<void>) | null) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inFlight = useRef(false);
  async function start() {
    if (run === null || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return { pending, error, start };
}

/**
 * THE SERVER'S SENTENCE, VERBATIM — or nothing for a 401, which the shell is
 * already turning into the sign-in screen. That includes the redemption's own
 * "That download link has expired. Export again from Reports.", which is shared
 * server copy and printed as served.
 */
export function exportErrorMessage(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  if (error instanceof ApiError && error.isUnauthenticated) return null;
  if (error instanceof Error && error.message) return error.message;
  return "Couldn't export the file. Try again.";
}

export function exportLabel(pending: boolean, offline: boolean): string {
  if (pending) return EXPORT_LABEL.pending;
  if (offline) return EXPORT_LABEL.offline;
  return EXPORT_LABEL.idle;
}

/**
 * A CARD'S QUIET EXPORT: the control for its head, and the refusal for under it.
 * Two pieces because they go in two places — the control shares the title's
 * line, the sentence sits under the head — and the card decides where.
 *
 * `start` null draws neither: pending, failed, withheld, or no exporter.
 */
export function useExportUi(
  start: (() => Promise<void>) | null,
  offline: boolean,
  title: string,
): { control: ReactNode; error: ReactNode } {
  const action = useExportAction(start);
  if (start === null) return { control: null, error: null };
  const label = exportLabel(action.pending, offline);
  const message = exportErrorMessage(action.error);
  return {
    control: (
      <IconButton
        quiet
        className="ovw__export"
        icon={<IconDownload />}
        label={label}
        aria-label={`${label} ${title}`}
        disabled={action.pending || offline}
        onClick={() => void action.start()}
      />
    ),
    error:
      message === null ? null : (
        <div className="ovw__export-error">
          <InlineError message={message} />
        </div>
      ),
  };
}

/**
 * The same, for a panel OUTSIDE the analytics grid — it reads the Overview's
 * exporter from context rather than the grid's. `scope` null (nothing drawn
 * yet) draws no control.
 */
export function useCardExport(
  target: AnalyticsSectionKey,
  scope: ExportScope | null,
  title: string,
  readOffline = false,
): { control: ReactNode; error: ReactNode } {
  const exporter = useContext(OverviewExporterContext);
  const start = exporter === null || scope === null ? null : () => exporter.run(target, scope);
  return useExportUi(start, (exporter?.offline ?? false) || readOffline, title);
}
