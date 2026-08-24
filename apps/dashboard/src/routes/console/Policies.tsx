import { useState } from 'react';
import { Button, Card, InfoBanner, Pill, Skeleton, TextField } from '@avo/ui';
import {
  useDiscardDraft,
  usePolicyDraft,
  usePublishPolicies,
  usePublishedPolicies,
} from '../../api/platform.js';
import { SectionError, WriteError } from '../sectionState.js';
import { SupportPanel } from './SupportPanel.js';

/**
 * Policies — non-negotiable #10's other half.
 *
 *   "The customer app holds no legal copy. It renders the published policy set
 *    from the API and stamps the version. Store the accepted version against the
 *    member."
 *
 * The wallet stamps a version already. What was missing until now is a way to
 * MOVE that version from the product rather than from psql: publishing bumps
 * `version`, stamps `publishedBy/At`, writes the platform audit row, and the
 * wallet re-prompts on next fetch because `GET /members/me/policy-acceptance`
 * compares against the newest published set.
 *
 * DRAFT AND PUBLISHED ARE SHOWN SIDE BY SIDE, and that is the screen's whole job.
 * api-contract.md is explicit that "nothing reaches a phone until publish", so the
 * question an admin actually has is "what is live, and what am I about to make
 * live" — a single editor showing one document set cannot answer it.
 *
 * THE 30-DAY DATE IS OFFERED, NOT ENFORCED. The contract asks for `effectiveFrom`
 * "at least 30 days out for a material change" and the terms themselves promise
 * that notice — but whether a change is *material* is a judgement about legal text
 * that this console cannot make for the admin. So the 30-day date is one click
 * away and today is allowed, because a typo fix should not wait a month. The API
 * refuses only a date in the past.
 */
export function Policies() {
  const published = usePublishedPolicies();
  const draft = usePolicyDraft();
  const publish = usePublishPolicies();
  const discard = useDiscardDraft();

  const [effectiveFrom, setEffectiveFrom] = useState(() => isoDaysFromNow(30));
  const [confirming, setConfirming] = useState(false);

  /*
   * A FAILED DRAFT READ NO LONGER EMPTIES THE WHOLE SCREEN, and the reason
   * arrived with the Support panel below.
   *
   * This was an early `return` of the refusal alone. Correct while the legal set
   * was all this route rendered; wrong the moment a second, independently guarded
   * read joined it. `GET /v1/platform/policies/draft` is `policies`-gated and
   * `GET /v1/platform/support` is `requirePrincipal` with no section, so one
   * failing says nothing about the other — and an admin whose draft read broke
   * would have lost a support configuration that was answering perfectly.
   *
   * The refusal now replaces the policy columns and nothing else, which is what
   * the InfoBanner above it already assumed by describing only the legal set.
   */
  const draftDocs = draft.data?.docs ?? [];
  const hasDraft = draftDocs.length > 0;

  if (draft.isError) {
    return (
      <div className="policies">
        <SectionError
          error={draft.error}
          forbiddenTitle="You don't have access to policies"
          failedTitle="Couldn't load the policy draft"
          onRetry={() => void draft.refetch()}
          retrying={draft.isFetching}
        />
        <SupportPanel />
      </div>
    );
  }

  return (
    <div className="policies">
      <InfoBanner icon={<DocGlyph />}>
        Every wallet renders the published set and stamps its version against the customer who
        accepted it. Editing writes to the draft — nothing reaches a phone until you publish.
      </InfoBanner>

      <div className="policies__grid">
        <Card className="policies__col">
          <div className="policies__colhead">
            <h2 className="policies__h2 avo-display">Published</h2>
            {published.data ? <Pill tone="brand">v{published.data.version}</Pill> : null}
          </div>

          {published.isError ? (
            /*
             * `policies_not_published` is a REAL answer and not a failure to hide:
             * the deployment has no legal set at all, and every wallet is currently
             * unable to show terms. Rendering the server's own sentence is the only
             * honest option — an empty list would read as "there are no policies",
             * which is a different and much calmer claim.
             *
             * THIS COMMENT SAID "A 503" AND CLAIMED THE SENTENCE WAS RENDERED.
             * Both were wrong, which is what `stateTitle` is doing here now.
             *
             * The status is 409: lane A moved it deliberately
             * (api/src/services/policy.ts — "a configuration state is not a
             * transient unavailability") after the wallet told a customer "No
             * connection" about a working network. And a 409 fell through to
             * `SectionError`'s last branch, so what actually painted was
             * "Something went wrong on our side. Nothing has changed in your
             * salon." — a generic failure, in the merchant's vocabulary, on the
             * platform console, discarding the one sentence that explains the
             * state. `namedStateAnswer` renders it now, and drops the retry button,
             * because publishing is the only thing that changes this answer.
             */
            <SectionError
              error={published.error}
              forbiddenTitle="You don't have access to the published set"
              failedTitle="Couldn't load the published set"
              stateTitle="Nothing is published"
              onRetry={() => void published.refetch()}
              retrying={published.isFetching}
            />
          ) : published.isPending ? (
            <>
              <Skeleton width="60%" height={15} />
              <Skeleton width="90%" height={13} />
            </>
          ) : (
            <>
              <p className="policies__meta">
                Effective {published.data.effectiveFrom} · published by{' '}
                {published.data.publishedBy}
              </p>
              <ul className="policies__docs">
                {published.data.docs.map((d) => (
                  <li key={d.id} className="policies__doc">
                    <span className="policies__doctitle">{d.title.en}</span>
                    <span className="policies__docmeta">
                      {d.scope}
                      {d.consent ? ' · consent' : ''}
                      {d.body.ar.length === 0 ? ' · no Arabic' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card className="policies__col">
          <div className="policies__colhead">
            <h2 className="policies__h2 avo-display">Draft</h2>
            {hasDraft ? <Pill tone="warn">unpublished</Pill> : null}
          </div>

          {draft.isPending ? (
            <Skeleton width="70%" height={15} />
          ) : !hasDraft ? (
            <p className="policies__empty">
              No draft. The published set above is what every wallet shows.
            </p>
          ) : (
            <>
              <p className="policies__meta">
                {draft.data?.updatedBy ? `Last edited by ${draft.data.updatedBy}` : 'Edited'}
              </p>
              <ul className="policies__docs">
                {draftDocs.map((d) => (
                  <li key={d.id} className="policies__doc">
                    <span className="policies__doctitle">{d.title.en}</span>
                    <span className="policies__docmeta">
                      {d.scope}
                      {d.consent ? ' · consent' : ''}
                      {/*
                        An empty `body.ar` is a legitimate state — api-contract.md
                        says the client falls back to `en` — but it also says "do
                        not ship a consent document that way", so a consent
                        document with no Arabic is called out rather than listed.
                      */}
                      {d.body.ar.length === 0 ? (
                        d.consent ? (
                          <b> · consent doc with no Arabic</b>
                        ) : (
                          ' · no Arabic'
                        )
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>

              <div className="policies__publish">
                <TextField
                  label="Effective from"
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
                <div className="policies__publishrow">
                  <Button variant="quiet" onClick={() => setEffectiveFrom(isoDaysFromNow(30))}>
                    30 days out
                  </Button>
                  <Button variant="quiet" onClick={() => setEffectiveFrom(isoDaysFromNow(0))}>
                    Today
                  </Button>
                </div>

                {confirming ? (
                  <div className="policies__confirm">
                    {/*
                      A confirm step, because publish is not reversible from here:
                      there is no unpublish endpoint and every wallet re-prompts on
                      the version bump. The sentence names the consequence rather
                      than asking "are you sure".
                    */}
                    <p className="policies__confirmtext">
                      Publishing makes this the set every wallet shows, bumps the version, and
                      re-prompts every customer whose acceptance is now out of date.
                    </p>
                    <div className="policies__publishrow">
                      <Button
                        onClick={() => {
                          publish.mutate({ effectiveFrom });
                          setConfirming(false);
                        }}
                        disabled={publish.isPending}
                      >
                        {publish.isPending ? 'Publishing…' : `Publish, effective ${effectiveFrom}`}
                      </Button>
                      <Button variant="quiet" onClick={() => setConfirming(false)}>
                        Back
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="policies__publishrow">
                    <Button onClick={() => setConfirming(true)} disabled={publish.isPending}>
                      Publish changes
                    </Button>
                    <Button
                      variant="quiet"
                      onClick={() => discard.mutate()}
                      disabled={discard.isPending}
                    >
                      Discard draft
                    </Button>
                  </div>
                )}

                {publish.isError ? (
                  <WriteError error={publish.error} reassurance="Nothing was published." />
                ) : null}
                {discard.isError ? (
                  <WriteError error={discard.error} reassurance="The draft is unchanged." />
                ) : null}
              </div>
            </>
          )}
        </Card>
      </div>

      {/*
        Below the two policy columns, where the design draws it, and NOT gated on
        the draft above it.

        `SupportPanel` owns its own fetch and its own four states because it is a
        different endpoint with a different guard: `GET /v1/platform/support` is
        `requirePrincipal` and no section, where the draft is `policies`. Folding
        it into this component's early return would tie a working support read to
        an unrelated failure, and the two most likely failures are exactly the ones
        that would do it — a deployment with no published legal set, and an admin
        holding `policies` on a deployment whose support row was never seeded.

        The panel renders no editor and no ticket queue: six of the eight support
        endpoints api-contract.md declares do not exist. Its own header carries the
        computed list and the reasoning.
      */}
      <SupportPanel />
    </div>
  );
}

/** `YYYY-MM-DD`, which is what `POST /policies/publish` validates against. */
function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function DocGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path d="M5 2.5h7l3 3v12H5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.5 8.5h5M7.5 11.5h5M7.5 14.5h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
