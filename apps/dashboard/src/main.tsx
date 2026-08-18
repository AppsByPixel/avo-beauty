import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { retryPolicy } from './api/retryPolicy.js';
import { AuthProvider, useAuth } from './auth/AuthProvider.js';
import { router } from './router.js';

// Token custom properties first — @avo/ui and app.css both resolve through them.
import '@avo/tokens/css';
import '@avo/ui/css';
import './app.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      /*
       * The dashboard owns its own offline presentation, so the query layer
       * must not quietly hold requests back.
       *
       * TanStack's default `networkMode: 'online'` *pauses* a failing query
       * whenever the browser reports itself offline: the query stays
       * `status: 'pending'` with `fetchStatus: 'paused'` and never resolves to
       * an error. Every state in interaction-spec.md §4 is reached from the
       * error status — the "No connection" explain state, the retry state, and
       * stale-not-blank — so pausing makes all three unreachable and leaves the
       * Overview on loading skeletons indefinitely. A merchant watching a
       * skeleton that never resolves has no way to tell a slow network from a
       * dead one.
       *
       * 'always' makes the fetch run and reject. `ApiError.isConnectivity`
       * classifies the failure and the screen renders the designed state.
       */
      networkMode: 'always',
      /*
       * Stale-not-blank (interaction-spec.md §4). TanStack keeps the cached
       * value alongside the error, which is what lets the Overview render the
       * last-known figures behind a timestamped banner instead of blanking.
       *
       * THE ONLY `retry` IN THE DASHBOARD. The reasoning is in
       * api/retryPolicy.ts; the short version is that a bare `retry: 1` cannot
       * express both halves of what this needs — a small budget AND no retry on
       * a refusal — and seven hooks proved it by overriding this policy to buy
       * the budget and losing the 403 short-circuit with it. If a hook ever
       * genuinely needs different behaviour it passes a NAMED policy, never a
       * number, so the next reader can tell intent from copy-paste.
       */
      retry: retryPolicy,
    },
    /*
     * Mutations inherit NOTHING from the block above — TanStack keys defaults by
     * `queries` and `mutations` separately, and a mutation's default is no retry
     * at all. That is correct here and is stated rather than left to be
     * rediscovered: the money-moving posts carry an `Idempotency-Key`
     * (non-negotiable #4), so a retry would be *safe* — but "safe to retry" is
     * not "retry automatically", and a charge that silently repeats itself is a
     * decision for the call site, not a global default.
     */
  },
});

/** The router reads auth from context, so it has to sit inside the provider. */
function RoutedApp() {
  const auth = useAuth();
  return <RouterProvider router={router} context={{ auth }} />;
}

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root is missing from index.html');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RoutedApp />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
