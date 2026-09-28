/**
 * The bell's state: the badge, the open panel, paging, and marking read.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * MARK-READ SENDS `{ ids }` FOR THE ROWS THE PANEL DREW, AND NOTHING ELSE.
 *
 * This hook does not decide what was drawn — the sheet does. `BellSheet`
 * computes its rows, and once they are on screen it calls `markDrawn` with
 * `idsToMark(rows)` (domain/bell.ts): unread, markable, and actually in the
 * panel. So the ids on the wire are a statement about what she was SHOWN, not
 * about what the server holds. `{ all: true }` is reachable from exactly one
 * place — `markAll`, behind its own labelled control — and never on open. The
 * merchant bell made the same call for the same reason: a badge larger than
 * the rows (a day-one member's whole receipt history is unread) must not be
 * cleared by glancing at the first page.
 *
 * AN ID IS SENT ONCE PER SESSION OF THE HOOK. `sent` remembers what has gone,
 * so re-rendering the same rows does not re-post them; an id whose POST FAILED
 * is taken back out, so the next open tries again. The server is idempotent
 * either way (`marked: 0` on a repeat) — this is about not spamming it, not
 * about correctness.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BADGE IS THE SERVER'S `unreadCount`, NEVER A COUNT OF ROWS HERE.
 *
 * `unreadCount` is over her whole visible set, not the page. Counting unread
 * rows client-side would under-report a history longer than a page and would be
 * a second opinion about a number the server owns. It is null until the first
 * read lands and after a read FAILS with nothing kept — no badge, rather than a
 * "0" that claims she has read everything.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE FOUR STATES (interaction-spec.md §4), INSIDE THE SHEET:
 *
 *   loading   first open with nothing kept — skeleton rows, never a blank.
 *   ready     rows; or EMPTY, which is a good outcome with its own words.
 *   failed    a read that failed — including a body that failed the CONTRACT,
 *             which `client.ts` classifies `server`. NEVER the empty state:
 *             "You're all caught up" over an unreadable body would be false.
 *   offline   no connection. With rows kept: the rows plus the offline banner,
 *             never blanked. With none: the cold offline words.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getBellFeed,
  markBellAllRead,
  markBellRead,
  MARK_READ_MAX_IDS,
  type BellItem,
} from '../api/bell';
import { toLoadFailure, type LoadFailure } from '../domain/loadFailure';

export type BellStatus = 'loading' | 'ready' | 'failed' | 'offline';

export interface BellState {
  open: boolean;
  status: BellStatus;
  /** Null until a read lands. Never an empty array standing in for "unknown". */
  items: BellItem[] | null;
  nextCursor: string | null;
  /** The server's badge figure. Null = unknown, and no badge is drawn. */
  unreadCount: number | null;
  visibleKinds: string[];
  failure: LoadFailure | null;
  loadingMore: boolean;
  /** "Show more" failed. The rows already drawn stay. */
  moreFailed: boolean;
}

export interface BellController extends BellState {
  openPanel: () => void;
  close: () => void;
  retry: () => void;
  loadMore: () => void;
  /** Called BY THE SHEET with the ids of the rows it drew. */
  markDrawn: (ids: string[]) => void;
  /** The explicit "Mark all as read" control. The only `{ all: true }`. */
  markAll: () => void;
}

const INITIAL: BellState = {
  open: false,
  status: 'loading',
  items: null,
  nextCursor: null,
  unreadCount: null,
  visibleKinds: [],
  failure: null,
  loadingMore: false,
  moreFailed: false,
};

/**
 * @param refreshKey  Re-reads the badge when it changes — Home passes its own
 *                    `fetchedAt`, so a top-up or a charge that re-read the
 *                    wallet also re-reads the bell.
 */
export function useBell(options: { enabled: boolean; refreshKey?: unknown }): BellController {
  const { enabled, refreshKey } = options;
  const [state, setState] = useState<BellState>(INITIAL);
  const alive = useRef(true);
  const abort = useRef<AbortController | null>(null);
  const sent = useRef(new Set<string>());
  const readSeq = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);

  /** Page one — for the badge on mount, and fresh on every open. */
  const readFirstPage = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const seq = (readSeq.current += 1);
    setState((s) => ({ ...s, status: s.items === null ? 'loading' : s.status, failure: null }));
    try {
      const feed = await getBellFeed(null, controller.signal);
      if (!alive.current || seq !== readSeq.current) return;
      setState((s) => ({
        ...s,
        status: 'ready',
        items: feed.items,
        nextCursor: feed.nextCursor,
        unreadCount: feed.unreadCount,
        visibleKinds: feed.visibleKinds,
        failure: null,
        moreFailed: false,
      }));
    } catch (err) {
      if (!alive.current || seq !== readSeq.current || controller.signal.aborted) return;
      const failure = toLoadFailure(err);
      setState((s) => ({
        ...s,
        status: failure.kind === 'offline' ? 'offline' : 'failed',
        failure,
        // Kept rows keep their badge; with nothing kept, the badge is unknown.
        unreadCount: s.items === null ? null : s.unreadCount,
      }));
    }
  }, []);

  useEffect(() => {
    if (enabled) void readFirstPage();
  }, [enabled, refreshKey, readFirstPage]);

  const openPanel = useCallback(() => {
    setState((s) => ({ ...s, open: true }));
    void readFirstPage();
  }, [readFirstPage]);

  const close = useCallback(() => setState((s) => ({ ...s, open: false })), []);

  /*
    Read through a ref, not inside a `setState` updater: an updater must be pure
    (React may run it twice), and a network call inside one is two requests.
  */
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    if (s.loadingMore || s.nextCursor === null) return;
    const cursor = s.nextCursor;
    setState((cur) => ({ ...cur, loadingMore: true, moreFailed: false }));
    getBellFeed(cursor)
      .then((feed) => {
        if (!alive.current) return;
        setState((cur) => ({
          ...cur,
          loadingMore: false,
          items: [...(cur.items ?? []), ...feed.items],
          nextCursor: feed.nextCursor,
          unreadCount: feed.unreadCount,
          visibleKinds: feed.visibleKinds,
        }));
      })
      .catch(() => {
        if (!alive.current) return;
        setState((cur) => ({ ...cur, loadingMore: false, moreFailed: true }));
      });
  }, []);

  const markDrawn = useCallback((ids: string[]) => {
    const fresh = ids.filter((id) => !sent.current.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => sent.current.add(id));
    // The server caps one call at 100 ids; a panel holding more is paged.
    for (let i = 0; i < fresh.length; i += MARK_READ_MAX_IDS) {
      const chunk = fresh.slice(i, i + MARK_READ_MAX_IDS);
      markBellRead(chunk)
        .then((r) => {
          if (alive.current) setState((s) => ({ ...s, unreadCount: r.unreadCount }));
        })
        .catch(() => {
          // Not shown — the badge simply stays — and retried on the next open.
          chunk.forEach((id) => sent.current.delete(id));
        });
    }
  }, []);

  const markAll = useCallback(() => {
    markBellAllRead()
      .then((r) => {
        if (!alive.current) return;
        const at = new Date().toISOString();
        setState((s) => ({
          ...s,
          unreadCount: r.unreadCount,
          // The dots follow the server's answer for rows she can see. An unknown
          // kind the server just marked is marked here too: she asked for ALL.
          items: s.items?.map((i) => (i.readAt === null ? { ...i, readAt: at } : i)) ?? null,
        }));
      })
      .catch(() => undefined);
  }, []);

  return {
    ...state,
    openPanel,
    close,
    retry: useCallback(() => void readFirstPage(), [readFirstPage]),
    loadMore,
    markDrawn,
    markAll,
  };
}
