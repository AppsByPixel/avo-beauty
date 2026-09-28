import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/**
 * ===========================================================================
 * LIST FILTERS THAT LIVE IN THE URL — so Back undoes a filter and a link shares a view
 * ===========================================================================
 * Aftab, 2026-09-29: "Search and filters on shop and all other screens of the
 * merchant dashboard." Every list's filter state is a query parameter, read
 * back through this one hook, for two reasons a `useState` cannot meet:
 *
 *   BACK WORKS. A merchant who narrows the orders board to Ready and presses
 *   Back expects the whole board again, not the previous section.
 *   A VIEW CAN BE SHARED. "Open this" in the salon's group chat lands a manager
 *   on the same filtered board.
 *
 * WHY `window.history` AND NOT THE ROUTER'S `useSearch`. The section routes are
 * declared without `validateSearch`, TanStack's default search parser turns
 * `?q=123` into the NUMBER 123, and every screen spec in this app mounts its
 * screen bare, without a router. Reading `location.search` as strings avoids
 * all three. It does NOT desynchronise the router: `@tanstack/history` wraps
 * `history.pushState`/`replaceState` and re-reads the location on every call
 * (`createBrowserHistory` § "win.history.pushState = function"), and the push
 * below carries the `__TSR_index` it uses to tell Back from Forward.
 *
 * EVERY VALUE IS VALIDATED ON THE WAY IN. A hand-edited `?status=shipped` reads
 * as "no filter", never as a filter the server will refuse by name — and never
 * as a value this client sends. A URL is input.
 *
 * WHAT DOES NOT GO IN THE URL: a free-text search for a PERSON. A customer's
 * name or phone typed into the customer book (or the console's accounts, or an
 * audit log that matches customer names) would sit in browser history, in the
 * address bar of a shared screen and in any link copied from it. Those screens
 * keep their search in component state and put only their chips in the URL.
 */

export type ParamSpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'text'; max?: number }
  | { kind: 'date' };

export const enumParam = (values: readonly string[]): ParamSpec => ({ kind: 'enum', values });
export const TEXT_PARAM: ParamSpec = { kind: 'text', max: 100 };
export const DATE_PARAM: ParamSpec = { kind: 'date' };

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const QUERY_EVENT = 'avo:query';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener(QUERY_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(QUERY_EVENT, onChange);
  };
}

const readSearch = () => (typeof window === 'undefined' ? '' : window.location.search);

/** `''` means "not set". Anything the spec does not accept reads as `''`. */
export function readParam(params: URLSearchParams, spec: ParamSpec, key: string): string {
  const raw = params.get(key);
  if (raw === null) return '';
  switch (spec.kind) {
    case 'enum':
      return spec.values.includes(raw) ? raw : '';
    case 'date':
      return YMD.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? raw : '';
    case 'text':
      return raw.slice(0, spec.max ?? 100);
  }
}

type Patch = Record<string, string | null>;

/**
 * Writes a patch to the query string. `''`/`null` removes the key, so a cleared
 * filter leaves no `?status=` behind to be shared. Keys the patch does not name
 * are kept — the appointment board's `?booking=` survives a status change.
 */
export function writeQuery(patch: Patch, mode: 'push' | 'replace'): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  const state = (window.history.state ?? {}) as Record<string, unknown>;
  if (mode === 'push') {
    const index = typeof state.__TSR_index === 'number' ? state.__TSR_index : 0;
    const key = Math.random().toString(36).slice(2, 10);
    window.history.pushState({ ...state, __TSR_index: index + 1, key, __TSR_key: key }, '', next);
  } else {
    window.history.replaceState(state, '', next);
  }
  window.dispatchEvent(new Event(QUERY_EVENT));
}

export interface UrlFilters<K extends string> {
  /** Every key, validated; `''` when unset. */
  values: Record<K, string>;
  /** A new history entry — chips and selects, so Back undoes them one at a time. */
  set: (patch: Partial<Record<K, string>>) => void;
  /** The same entry — for a debounced search, which must not add one per word. */
  replace: (patch: Partial<Record<K, string>>) => void;
  /** Removes every key this screen owns, as one history entry. */
  clear: () => void;
  /** Whether any key is set. */
  active: boolean;
}

export function useUrlFilters<K extends string>(spec: Record<K, ParamSpec>): UrlFilters<K> {
  const search = useSyncExternalStore(subscribe, readSearch, () => '');
  // The spec is a literal at every call site; its keys are what matter.
  const keys = Object.keys(spec) as K[];
  const signature = keys.join('|');

  const values = useMemo(() => {
    const params = new URLSearchParams(search);
    const out = {} as Record<K, string>;
    for (const key of keys) out[key] = readParam(params, spec[key], key);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, signature]);

  const set = useCallback((patch: Partial<Record<K, string>>) => writeQuery(patch as Patch, 'push'), []);
  const replace = useCallback(
    (patch: Partial<Record<K, string>>) => writeQuery(patch as Patch, 'replace'),
    [],
  );
  const clear = useCallback(
    () => writeQuery(Object.fromEntries(signature.split('|').map((k) => [k, null])), 'push'),
    [signature],
  );

  return { values, set, replace, clear, active: keys.some((k) => values[k] !== '') };
}

export interface SearchText {
  /** What is in the box, keystroke by keystroke. */
  text: string;
  setText: (next: string) => void;
  /** Empties the box AND cancels a pending commit — Clear filters must not be undone 300ms later. */
  reset: () => void;
}

/**
 * THE SEARCH BOX, DEBOUNCED ONTO WHATEVER HOLDS THE COMMITTED VALUE.
 *
 * `committed` is the value the list is actually filtered or fetched by (the
 * URL's `?q=`, or a screen's own state for a person search). Typing changes
 * `text` at once and commits after `delay` of quiet: a search that goes to the
 * server must not send a request per keystroke — the customer book's search is
 * budgeted at 300 an hour and writes an audit row per call.
 *
 * A committed value that changes FROM OUTSIDE — Back, a shared link, Clear —
 * replaces the box's text, so the field never disagrees with the list under it.
 */
export function useSearchText(committed: string, commit: (next: string) => void, delay: number): SearchText {
  const [text, setText] = useState(committed);
  const last = useRef(committed);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (committed !== last.current) {
      last.current = committed;
      setText(committed);
    }
  }, [committed]);

  useEffect(() => {
    if (text === last.current) return undefined;
    const timer = setTimeout(() => {
      last.current = text;
      commitRef.current(text);
    }, delay);
    return () => clearTimeout(timer);
  }, [text, delay]);

  const reset = useCallback(() => {
    last.current = '';
    setText('');
  }, []);

  return { text, setText, reset };
}

/** Case- and accent-insensitive "contains", for a list that is filtered here. */
export function textMatches(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = fold(query.trim());
  if (q === '') return true;
  return fields.some((f) => f != null && fold(f).includes(q));
}

function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * ===========================================================================
 * AN EDITABLE LIST MUST NOT DROP THE ROW SHE IS TYPING IN
 * ===========================================================================
 * Shop saves as you type. Searching "oil" and renaming "Argan oil" to "Argan
 * serum" would, 700ms later, save — and the row would stop matching and unmount
 * under her cursor, taking the focus and the rest of what she was typing with
 * it. Services has the same shape on its Save button.
 *
 * So the matching set is decided WHEN THE FILTER CHANGES, not on every refetch:
 * a row that matched stays until the filter moves, and a row that arrives while
 * a filter is up (the product she just added) is shown rather than vanishing
 * the moment the server confirms it. Changing the filter re-evaluates
 * everything from scratch.
 */
export function useStableMatches<T>(
  items: readonly T[] | undefined,
  idOf: (item: T) => string,
  matches: (item: T) => boolean,
  filterKey: string,
): T[] | undefined {
  const loaded = items !== undefined;
  const snapshot = useMemo(() => {
    if (!items) return null;
    return {
      known: new Set(items.map(idOf)),
      kept: new Set(items.filter(matches).map(idOf)),
    };
    // Recomputed when the filter changes or the list first lands — deliberately
    // NOT on every refetch; that is the point of this hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, loaded]);

  if (!items) return undefined;
  if (filterKey === '' || snapshot === null) return [...items];
  return items.filter((item) => {
    const id = idOf(item);
    return matches(item) || snapshot.kept.has(id) || !snapshot.known.has(id);
  });
}

/** "12 products", or "3 of 12 products" while a filter narrows them. */
export function shownLabel(shown: number, total: number, one: string, many: string, filtered: boolean): string {
  const noun = total === 1 ? one : many;
  return filtered ? `${shown} of ${total} ${noun}` : `${total} ${noun}`;
}
