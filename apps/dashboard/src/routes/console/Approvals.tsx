import { useState } from 'react';
import type { Campaign } from '@avo/types';
import { Button, Card, EmptyState, InfoBanner, Pill, Skeleton, Stepper, Toggle } from '@avo/ui';
import {
  isCampaignHeld,
  useDecideCampaign,
  useMessagingPolicy,
  usePlatformCampaigns,
  useUpdateMessagingPolicy,
} from '../../api/platform.js';
import { SectionError, WriteError } from '../sectionState.js';

/**
 * Approvals — where non-negotiable #8 is satisfied or broken.
 *
 *   "A merchant cannot send a customer message. POST /campaigns only creates
 *    pending. Delivery happens on the platform decision endpoint, and caps and
 *    quiet hours are enforced again at send time."
 *
 * This screen is the second sentence. Nothing here can send: it posts a DECISION,
 * and the server queues, holds or skips from there.
 *
 * THE THREE OUTCOMES ARE DIFFERENT AND THE SCREEN SAYS WHICH. Lane A's report is
 * precise about it and the distinction is not cosmetic:
 *
 *   quiet hours      HOLD the whole campaign until the window opens
 *   monthly cap      HOLD the whole campaign
 *   weekly per-customer cap   SKIP those recipients, send to the rest
 *
 * So "held" is a fact about a campaign and "skipped" is a fact about people. A
 * single "not sent" badge would merge them and leave a merchant unable to tell
 * "nothing went out" from "most of it did".
 *
 * `heldReason` AND `heldAt` RATHER THAN A BOOLEAN, and status stays `approved`.
 * Trunk's reasoning, kept here because this is the screen that depends on it: the
 * platform's release decision is a fact, a later cap does not retract it, and the
 * merchant is owed the sentence rather than a bell — "held until 09:00" and
 * "held — this customer has had two messages this week" are different things to
 * do next.
 */
export function Approvals() {
  const campaigns = usePlatformCampaigns();
  const policy = useMessagingPolicy();
  const decide = useDecideCampaign();

  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  if (campaigns.isError) {
    return (
      <SectionError
        error={campaigns.error}
        forbiddenTitle="You don't have access to approvals"
        failedTitle="Couldn't load the approval queue"
        onRetry={() => void campaigns.refetch()}
        retrying={campaigns.isFetching}
      />
    );
  }

  const items = campaigns.data ?? [];
  const pending = items.filter((c) => c.status === 'pending');
  const decided = items.filter((c) => c.status !== 'pending');

  return (
    <div className="approvals">
      <InfoBanner icon={<ShieldGlyph />}>
        Nothing a salon writes reaches a customer&rsquo;s phone until AVO releases it. Review the
        message, the audience and the send time — approve and it goes out on schedule; reject and
        the salon sees your reason.
      </InfoBanner>

      <div className="approvals__grid">
        <div className="approvals__queue">
          <div className="approvals__queuehead">
            <h2 className="approvals__h2 avo-display">Waiting on you</h2>
            <span className="approvals__note">
              {campaigns.isPending
                ? ''
                : pending.length === 0
                  ? 'nothing queued'
                  : `${pending.length} waiting`}
            </span>
          </div>

          {campaigns.isPending ? (
            <Card className="approvals__card">
              <Skeleton width="38%" height={13} />
              <Skeleton width="70%" height={17} />
              <Skeleton width="90%" height={13} />
            </Card>
          ) : pending.length === 0 ? (
            <EmptyState
              title="Queue is clear"
              body="New submissions land here the moment a salon presses submit."
            />
          ) : (
            pending.map((c) => (
              <PendingCard
                key={c.id}
                campaign={c}
                quietFrom={policy.data?.quietFrom ?? null}
                quietTo={policy.data?.quietTo ?? null}
                rejecting={rejectingId === c.id}
                reason={rejectingId === c.id ? reason : ''}
                busy={decide.isPending}
                onReason={setReason}
                onApprove={() => {
                  setRejectingId(null);
                  decide.mutate({ campaignId: c.id, status: 'approved' });
                }}
                onStartReject={() => {
                  setRejectingId(c.id);
                  setReason('');
                }}
                onCancelReject={() => setRejectingId(null)}
                onConfirmReject={() => {
                  /*
                   * No default reason. The design's prototype substituted "Does
                   * not meet AVO messaging rules." when the box was empty; the API
                   * refuses an empty note by name and the database refuses it
                   * again. A canned sentence would satisfy both checks and tell
                   * the merchant nothing, which is what the constraint exists to
                   * prevent — so the button stays disabled until she writes one.
                   */
                  decide.mutate({
                    campaignId: c.id,
                    status: 'rejected',
                    note: reason.trim(),
                  });
                  setRejectingId(null);
                }}
              />
            ))
          )}

          {decide.isError ? (
            <WriteError error={decide.error} reassurance="Nothing was released." />
          ) : null}

          {/*
            WHAT THE DECISION ACTUALLY DID, on the press. The API builds `delivery`
            for exactly this — "The console needs it to say 'released · 612 reached'
            or 'approved but held until 09:00' on the row it just acted on" — and
            nothing read it.

            It matters most in the case that looks like success: Approve on a
            campaign inside quiet hours returns 200, and without this the row simply
            moves to Decided wearing a chip. The reviewer's question is "did that
            send", and this answers it in the server's own sentence before she has to
            go looking.

            `delivery` is null on a rejection and on a `later`/`recurring` approval —
            nothing was delivered in either case, so there is nothing to report and
            this renders nothing.
          */}
          {decide.isSuccess && decide.data.delivery ? (
            <p
              className={
                decide.data.delivery.status === 'held' ? 'approvals__held' : 'approvals__result'
              }
              role="status"
            >
              {decide.data.delivery.status === 'held' ? (
                <>
                  <b>Held — nothing was sent.</b> {decide.data.delivery.heldReason}
                </>
              ) : (
                <>
                  <b>Released.</b> {decide.data.delivery.result}
                </>
              )}
            </p>
          ) : null}

          <h2 className="approvals__h2 approvals__h2--decided avo-display">Decided</h2>
          {decided.length === 0 ? (
            <p className="approvals__none">Nothing decided yet.</p>
          ) : (
            <ul className="approvals__decided">
              {decided.map((c) => (
                <DecidedRow key={c.id} campaign={c} />
              ))}
            </ul>
          )}
        </div>

        <ThrottlePanel policy={policy} items={items} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pending -- */

const AUDIENCE_LABELS: Record<Campaign['audience'], string> = {
  all: 'Everyone',
  lapsed: 'Lapsed customers',
  lowbal: 'Low balance',
  gold: 'Gold tier',
  new: 'New customers',
};

const CHANNEL_LABELS: Record<Campaign['channel'], string> = {
  push: 'App push',
  wa: 'WhatsApp',
  both: 'Push + WhatsApp',
};

function PendingCard({
  campaign: c,
  quietFrom,
  quietTo,
  rejecting,
  reason,
  busy,
  onReason,
  onApprove,
  onStartReject,
  onCancelReject,
  onConfirmReject,
}: {
  campaign: Campaign;
  quietFrom: string | null;
  quietTo: string | null;
  rejecting: boolean;
  reason: string;
  busy: boolean;
  onReason: (v: string) => void;
  onApprove: () => void;
  onStartReject: () => void;
  onCancelReject: () => void;
  onConfirmReject: () => void;
}) {
  const scheduled =
    c.when === 'later'
      ? c.scheduledAt
        ? new Date(c.scheduledAt).toLocaleString('en-GB', {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })
        : 'Scheduled'
      : c.when === 'recurring'
        ? 'Recurring trigger'
        : 'On approval';

  /*
   * NO PER-CAMPAIGN QUIET-HOURS PREDICTION. This card used to draw one and it was
   * wrong twice over; both halves were found by driving the real endpoint, and the
   * comment that stood here asserted the opposite.
   *
   *   1. WRONG ZONE. It read `c.scheduledAt.slice(11, 16)` — the UTC wall clock
   *      out of an ISO string — and compared it against `quietFrom`/`quietTo`,
   *      which the server resolves IN THE SALON'S ZONE via `offsetFor(salon, now)`
   *      (api/src/services/campaign.ts § quiet hours). At Kuwait's +03:00 and a
   *      22:00–09:00 window that is a three-hour band where the server holds and
   *      the card said nothing, and another three-hour band where the card
   *      promised a hold that never came.
   *
   *   2. WRONG PREDICATE. `at >= from || at < to` is the OVERNIGHT branch only.
   *      The shared `isInQuietHours` is `from <= to ? (m >= from && m < to) : (m >=
   *      from || m < to)`, and `PATCH /v1/platform/messaging-policy` accepts each
   *      bound independently as any HH:mm — the throttle panel on this very screen
   *      can set 09:00–10:00, which was driven and did hold a campaign. Against a
   *      same-day window the old formula flags almost everything.
   *
   * IT CANNOT BE FIXED IN THIS COLUMN, and that is the reported part rather than
   * the excuse. A correct answer needs the salon's IANA zone at the scheduled
   * instant. `GET /v1/platform/campaigns` carries `salonId` and `salon` (the name)
   * and no zone, and `GET /v1/salons/:id` — which does serialise `timezone` — is
   * `requireSalonScoped`, so a platform principal cannot read it at all. So the
   * console has no route to a salon's clock. Asked of lane A in the lane report:
   * add `salonTimezone` to the campaign wire and this becomes
   * `isInQuietHours(new Date(c.scheduledAt), quietFrom, quietTo, offset)` — the
   * shared predicate, not a fourth copy of it.
   *
   * Until then the card states the POLICY, which is true of every campaign, and
   * leaves the per-campaign answer to the server — which composes it as a sentence
   * and puts it on `heldReason`, where `DecidedRow` renders it verbatim. A guess
   * that contradicts that sentence is worse than no guess: it teaches a reviewer to
   * distrust the one field that is authoritative.
   */
  const quietWindow = quietFrom !== null && quietTo !== null ? `${quietFrom}–${quietTo}` : null;

  return (
    <Card className="approvals__card">
      <div className="approvals__cardtop">
        <span className="approvals__salon">{c.salon}</span>
        <Pill tone="neutral">{CHANNEL_LABELS[c.channel]}</Pill>
        <span className="approvals__submitted">
          submitted by {c.submittedBy || 'Salon manager'}
        </span>
      </div>

      <div className="approvals__message">
        <div className="approvals__msgtitle">{c.title}</div>
        <div className="approvals__msgbody">{c.body}</div>
      </div>

      <div className="approvals__facts">
        <span>{AUDIENCE_LABELS[c.audience]}</span>
        <span>{c.reach.toLocaleString('en-US')} people</span>
        <span>{c.branchId === 'all' ? 'All branches' : c.branchId}</span>
        <span>{scheduled}</span>
      </div>

      {quietWindow ? (
        <p className="approvals__flag" role="note">
          Quiet hours {quietWindow} in the salon&rsquo;s own time zone, and the monthly cap, are
          checked again at send. If either stops this one, AVO holds it and tells you why here.
        </p>
      ) : null}

      <div className="approvals__actions">
        {rejecting ? (
          <div className="approvals__reject">
            <label className="avo-label" htmlFor={`reject-${c.id}`}>
              Reason
            </label>
            <textarea
              id={`reject-${c.id}`}
              className="approvals__textarea"
              rows={3}
              value={reason}
              placeholder="Why is this being rejected? The salon sees this."
              onChange={(e) => onReason(e.currentTarget.value)}
            />
            <div className="approvals__rejectrow">
              <Button onClick={onConfirmReject} disabled={busy || reason.trim() === ''}>
                Send rejection
              </Button>
              <Button variant="quiet" onClick={onCancelReject} disabled={busy}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Button onClick={onApprove} disabled={busy}>
              Approve &amp; release
            </Button>
            <Button variant="quiet" onClick={onStartReject} disabled={busy}>
              Reject with a reason
            </Button>
            <p className="approvals__release">
              {c.when === 'later'
                ? `Releases automatically at ${scheduled}.`
                : 'Queued for delivery within a minute of approval.'}
            </p>
          </>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ decided -- */

function DecidedRow({ campaign: c }: { campaign: Campaign }) {
  /*
   * `isCampaignHeld`, not `status === 'approved'`. A held campaign's status stays
   * `approved`, so the chip that rendered `{c.status}` verbatim said "approved"
   * over a campaign that reached nobody. The predicate lives in api/platform.ts
   * beside the wire shape — see its header.
   */
  const held = isCampaignHeld(c);
  return (
    <li className="approvals__decidedrow">
      <span className="approvals__decidedtitle">
        <b>{c.title}</b>
        <span className="approvals__decidedsalon">{c.salon}</span>
      </span>
      <span className="approvals__decidedmeta">
        {c.decidedBy ? `${c.status === 'rejected' ? 'Rejected' : 'Approved'} by ${c.decidedBy}` : ''}
      </span>
      <span className="approvals__decidedstatus">
        {/*
          "held", not "approved". `warn`, not `neutral` — the row needs to read as
          unfinished at a glance, because it IS: quiet hours end and the scheduler
          releases it. `danger` would be wrong; nothing failed.
        */}
        <Pill
          tone={
            c.status === 'rejected'
              ? 'danger'
              : held
                ? 'warn'
                : c.status === 'sent'
                  ? 'brand'
                  : 'neutral'
          }
        >
          {held ? 'held' : c.status}
        </Pill>
      </span>
      {/*
        THE HELD SENTENCE. `heldReason` is why this exists rather than a bell:
        a campaign can be `approved` and still not have gone out, and #8 requires
        that be REPORTED rather than silently dropped. Rendered verbatim, because
        only the server knows which rule stopped it — all four sentences were driven
        against the real endpoint and they are genuinely different next actions:

          "Quiet hours 09:00–10:00. Held until 10:00."                  wait
          "This salon has reached the platform limit of 8 campaigns
           this month (8 already released). Held."                      raise the cap
          "Every one of the 1 customers in this audience has already
           had 2 message(s) this week. Held."                           widen the audience
          "Nobody is in this audience right now. Held rather than
           sent to nobody."                                            fix the segment
      */}
      {held ? (
        <p className="approvals__held" role="note">
          <b>Held — nothing was sent.</b> {c.heldReason}
        </p>
      ) : null}
      {c.note ? <p className="approvals__reason">{c.note}</p> : null}
      {/*
        THE SKIP SENTENCE, AND IT IS NOT THE HOLD. `result` is written only on a
        send, and the weekly per-customer cap lives here rather than in `heldReason`
        because it skips PEOPLE and lets the campaign go: "1 reached · 1 over the
        weekly cap" was driven. Labelled "Sent" so the two paragraphs cannot be
        misread as the same kind of fact — a merchant told "held" when most of it
        went out, or "sent" when none of it did, has the wrong next move either way.
      */}
      {c.result ? (
        <p className="approvals__result">
          <b>Sent.</b> {c.result}
        </p>
      ) : null}
    </li>
  );
}

/* ----------------------------------------------------------------- throttle -- */

function ThrottlePanel({
  policy,
  items,
}: {
  policy: ReturnType<typeof useMessagingPolicy>;
  items: Campaign[];
}) {
  const update = useUpdateMessagingPolicy();

  if (policy.isError) {
    return (
      <SectionError
        error={policy.error}
        forbiddenTitle="You don't have access to the platform throttle"
        failedTitle="Couldn't load the platform throttle"
        onRetry={() => void policy.refetch()}
        retrying={policy.isFetching}
      />
    );
  }

  const p = policy.data;

  return (
    <aside className="approvals__side">
      <Card className="approvals__throttle">
        <h2 className="approvals__h2 avo-display">Platform throttle</h2>
        <p className="approvals__lede">
          Applies to every salon on AVO. A merchant cannot raise its own limits.
        </p>

        {p === undefined ? (
          <>
            <Skeleton width="100%" height={38} />
            <Skeleton width="100%" height={38} />
          </>
        ) : (
          <>
            <div className="approvals__rowitem">
              <span>
                <span className="approvals__rowlabel">Require AVO approval</span>
                <span className="approvals__rowsub">Off means salons send unreviewed</span>
              </span>
              <Toggle
                checked={p.requireApproval}
                label="Require AVO approval"
                onChange={(next) => update.mutate({ requireApproval: next })}
              />
            </div>

            <div className="approvals__rowitem">
              <span>
                <span className="approvals__rowlabel">Per customer, per week</span>
                <span className="approvals__rowsub">Hard cap across all salons</span>
              </span>
              <Stepper
                label="Per customer, per week"
                value={p.weeklyCapPerCustomer}
                min={1}
                max={7}
                step={1}
                // A count, not money. `format` is required because the Stepper's
                // other caller is the deposit and 3-decimal fils formatting there
                // is not optional — see @avo/ui Stepper.
                format={(v) => String(v)}
                onChange={(v) => update.mutate({ weeklyCapPerCustomer: v })}
              />
            </div>

            <div className="approvals__rowitem">
              <span>
                <span className="approvals__rowlabel">Campaigns per salon, per month</span>
                <span className="approvals__rowsub">Counts approved and sent</span>
              </span>
              <Stepper
                label="Campaigns per salon, per month"
                value={p.monthlyCapPerSalon}
                min={1}
                max={30}
                step={1}
                format={(v) => String(v)}
                onChange={(v) => update.mutate({ monthlyCapPerSalon: v })}
              />
            </div>

            <p className="approvals__quiet">
              Quiet hours {p.quietFrom}&ndash;{p.quietTo} — nothing sends, approved or not.
            </p>

            {update.isError ? (
              <WriteError error={update.error} reassurance="The throttle is unchanged." />
            ) : null}
          </>
        )}
      </Card>

      {/*
        HELD IS ITS OWN ROW, AND IT IS SUBTRACTED FROM THE ONE ABOVE IT.
        `status === 'approved'` was counting held campaigns as approved-and-away,
        so the only number on the screen that could have told an admin "four
        releases are stuck behind quiet hours" instead folded them into a column
        that reads as done. `Sent` is added for the same reason: "approved" and
        "delivered" were one number, and #8's whole subject is the gap between them.
      */}
      <Card className="approvals__stats">
        <h2 className="approvals__h2 avo-display">This month</h2>
        <StatRow label="Submitted" value={items.length} />
        <StatRow label="Awaiting review" value={items.filter((c) => c.status === 'pending').length} />
        <StatRow label="Sent" value={items.filter((c) => c.status === 'sent').length} />
        <StatRow
          label="Approved, not yet sent"
          value={items.filter((c) => c.status === 'approved' && !isCampaignHeld(c)).length}
        />
        <StatRow label="Held" value={items.filter(isCampaignHeld).length} />
        <StatRow label="Rejected" value={items.filter((c) => c.status === 'rejected').length} />
      </Card>
    </aside>
  );
}

function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="approvals__stat">
      <span className="approvals__statlabel">{label}</span>
      <span className="approvals__statvalue">{value}</span>
    </div>
  );
}

function ShieldGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" fill="none">
      <path
        d="M10 2.5 3.5 5v5c0 3.4 2.7 6.2 6.5 7.5 3.8-1.3 6.5-4.1 6.5-7.5V5L10 2.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M7 10l2.2 2.2L13 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
