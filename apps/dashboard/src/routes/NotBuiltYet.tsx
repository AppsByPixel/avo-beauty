import { EmptyState } from '@avo/ui';

/**
 * The shell design ships ten sections; lane C builds them in the order set in
 * LANES.md (Overview, Settings, Loyalty, Accounts, Audit log). The nav items are
 * present because the sidebar is part of the shell design — this is what sits
 * behind the ones that have not landed yet, so a click never dead-ends.
 */
export function NotBuiltYet({ section }: { section: string }) {
  return (
    <EmptyState
      title={`${section} isn't built yet`}
      body="This section is in a later phase of the build plan. Overview is live and reads from the API."
    />
  );
}
