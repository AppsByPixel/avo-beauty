import { useState } from 'react';
import type { Branch, Campaign, RewardKey } from '@avo/types';
import { Button, Card, Pill, Segmented, Skeleton, TextField, type PillTone } from '@avo/ui';
import {
  AUDIENCES,
  CAMPAIGN_REWARDS,
  CAMPAIGN_STATUS_LABEL,
  CHANNELS,
  useCampaigns,
  useSubmitCampaign,
} from '../../api/promotions.js';
import { ApiError } from '../../api/client.js';
import { SectionError, WriteError } from '../sectionState.js';

/**
 * Marketing → Campaigns. NON-NEGOTIABLE #8 LIVES ON THIS SCREEN.
 *
 * "A merchant cannot send a customer message. `POST /campaigns` only creates
 * `pending`. Delivery happens on the platform decision endpoint, and caps and
 * quiet hours are enforced again at send time."
 *
 * So the button says SUBMIT. Not "Send", not "Send now", not "Schedule" — a
 * scheduled campaign is still submitted for approval and the schedule is a
 * request, not a guarantee. The design file's `sendLabel` has a second branch
 * that reads "Send to N people" when `policy.requireApproval` is false; that
 * branch is NOT implemented, because the API has no path that honours it —
 * `status: 'pending'` is hardcoded in the handler — and a button promising a
 * send that cannot happen is the exact failure #8 exists to prevent.
 *
 * The confirmation copy is written the same way: it says AVO has it, never that
 * anything went out.
 */

export interface CampaignsProps {
  branches: Branch[];
  loading: boolean;
}

const STATUS_TONE: Record<Campaign['status'], PillTone> = {
  pending: 'warn',
  approved: 'brand',
  sent: 'brand',
  rejected: 'danger',
};

const BODY_MAX = 140;
const TITLE_MAX = 42;

export function Campaigns({ branches, loading }: CampaignsProps) {
  const submit = useSubmitCampaign();
  const [audience, setAudience] = useState<Campaign['audience']>('all');
  const [branchId, setBranchId] = useState('all');
  const [channel, setChannel] = useState<Campaign['channel']>('push');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [reward, setReward] = useState<RewardKey | 'none'>('none');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');

  const ready = title.trim() !== '' && body.trim() !== '';

  return (
    <div className="mk__campaigns">
      <Card>
        <h2 className="mk__cardtitle">New campaign</h2>

        <div className="mk__two">
          <label className="mk__field">
            <span className="avo-label">Who gets it</span>
            <select
              className="avo-input"
              value={audience}
              onChange={(e) => setAudience(e.target.value as Campaign['audience'])}
            >
              {AUDIENCES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mk__field">
            <span className="avo-label">Branch</span>
            <select
              className="avo-input"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="all">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mk__field">
          <span className="avo-label">Channel</span>
          <Segmented options={CHANNELS} value={channel} onChange={setChannel} label="Channel" />
        </div>

        <TextField
          label="Headline"
          value={title}
          maxLength={TITLE_MAX}
          onChange={(e) => setTitle(e.target.value)}
        />

        <label className="mk__field">
          <span className="avo-label">Message</span>
          <textarea
            className="avo-input mk__textarea"
            value={body}
            maxLength={BODY_MAX}
            rows={3}
            onChange={(e) => setBody(e.target.value)}
          />
          <span className="mk__count" aria-live="polite">
            {body.length} / {BODY_MAX}
          </span>
        </label>

        <label className="mk__field">
          <span className="avo-label">
            Attach a reward <span className="mk__optional">— optional</span>
          </span>
          <select
            className="avo-input"
            value={reward}
            onChange={(e) => setReward(e.target.value as RewardKey | 'none')}
          >
            {CAMPAIGN_REWARDS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        <div className="mk__submitrow">
          <Segmented
            options={[
              { value: 'now', label: 'Immediately' },
              { value: 'later', label: 'Schedule' },
            ]}
            value={when}
            onChange={setWhen}
            label="When to run it"
          />
          {when === 'later' ? (
            <input
              className="avo-input mk__when"
              type="datetime-local"
              value={scheduledAt}
              aria-label="Scheduled for"
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          ) : null}
          {/*
            SUBMIT. The one control that could be mistaken for a send, and it is
            not one — it creates a `pending` row and nothing else.
          */}
          <Button
            className="mk__submit"
            disabled={!ready || submit.isPending}
            onClick={() =>
              submit.mutate(
                {
                  title: title.trim(),
                  body: body.trim(),
                  channel,
                  audience,
                  branchId,
                  reward,
                  when,
                  scheduledAt: when === 'later' ? scheduledAt : '',
                },
                {
                  onSuccess: () => {
                    setTitle('');
                    setBody('');
                  },
                },
              )
            }
          >
            {submit.isPending ? 'Submitting…' : 'Submit to AVO'}
          </Button>
        </div>

        {submit.isSuccess ? (
          <div className="mk__submitted" role="status">
            <span className="mk__submitteddot" aria-hidden="true" />
            <span>
              Sent to AVO for approval. Approvals usually come back within a working day; you will
              see the decision here.
            </span>
          </div>
        ) : null}
        {submit.isError ? (
          <WriteError error={submit.error} reassurance="Nothing was submitted." />
        ) : null}
      </Card>

      <div className="mk__side">
        <Card>
          <h2 className="mk__cardtitle">Preview</h2>
          {/*
            The push as it lands. No reach count beside it: `reach` is
            server-computed and "never trusted from the client"
            (api-contract.md § Campaign), and there is no endpoint that returns
            an audience size. A number invented here would be a merchant's basis
            for choosing a channel. Reported rather than guessed.
          */}
          <div className="mk__phone">
            <div className="mk__push">
              <div className="mk__pushhead">
                <span className="mk__pushmark" aria-hidden="true">
                  A
                </span>
                <span className="mk__pushapp">AVO</span>
                <span className="mk__pushwhen">now</span>
              </div>
              <div className="mk__pushtitle">{title || 'Your headline'}</div>
              <div className="mk__pushbody">{body || 'Your message appears here.'}</div>
            </div>
          </div>
          <p className="mk__quiet">
            Quiet hours are respected — nothing leaves between 22:00 and 09:00. A person gets at
            most two marketing messages a week.
          </p>
        </Card>

        <Queue loading={loading} />
      </div>
    </div>
  );
}

/**
 * The queue.
 *
 * `GET /v1/salons/{id}/campaigns` does not exist yet — see `useCampaigns`. A 404
 * is not "we failed" and not "you can't"; it is "this list has no source", so it
 * gets its own plain sentence rather than a retry button that will 404 again or
 * a fabricated row. Withdraw and the monthly cap sit behind the same gap and are
 * omitted for the same reason.
 */
function Queue({ loading }: { loading: boolean }) {
  const campaigns = useCampaigns();
  const missing = campaigns.error instanceof ApiError && campaigns.error.status === 404;
  const items = campaigns.data?.items ?? [];

  return (
    <Card>
      <h2 className="mk__cardtitle">Queue &amp; sends</h2>
      <p className="mk__cardsub">
        Every campaign is reviewed by AVO before it reaches a phone.
      </p>

      {loading || campaigns.isPending ? (
        <div className="mk__skeletons">
          {[0, 1].map((n) => (
            <Skeleton key={n} width="100%" height={40} />
          ))}
        </div>
      ) : missing ? (
        <p className="mk__none">
          Submitted campaigns aren&rsquo;t listed here yet. AVO still has everything you submit —
          you&rsquo;ll be told the decision.
        </p>
      ) : campaigns.isError ? (
        /*
         * THIS WAS THE ONE READ ERROR IN THE DASHBOARD NOT GOING THROUGH
         * `SectionError`, and it collapsed three different situations into one
         * sentence — "Couldn't load the queue just now" — with no retry.
         *
         * interaction-spec.md §4 asks for the opposite: distinguish *we failed*
         * (retry) from *you can't do that* (explain). The queue is gated on
         * `perms.marketing`, so a merchant without it was told to wait for
         * something that will never load, on a screen whose whole subject is
         * "did AVO get my campaign". Offline said the same thing, so a dropped
         * connection was indistinguishable from a permission she does not hold.
         *
         * `sectionState.tsx` already encodes all three and every other read in
         * the dashboard uses it. The 404 branch above still comes first: the
         * endpoint genuinely does not exist yet, which is neither of the two.
         */
        <SectionError
          error={campaigns.error}
          forbiddenTitle="You don't have access to campaigns"
          failedTitle="Couldn't load the queue"
          onRetry={() => void campaigns.refetch()}
          retrying={campaigns.isFetching}
        />
      ) : items.length === 0 ? (
        /*
         * "Nothing submitted yet." named neither the thing nor the action —
         * `AVO States.dc.html` states the rule as "Name the thing, offer the one
         * action that fills it", and the Happy hours card two files over already
         * does. No spatial direction: `.mk__campaigns` is two columns at base and
         * one at tablet, so "on the left" is wrong at the width where the form
         * sits above this card.
         */
        <p className="mk__none">
          No campaigns yet. Build one in <b>New campaign</b> and submit it — AVO reviews every
          campaign before it reaches a phone, and you&rsquo;ll be told the decision.
        </p>
      ) : (
        items.map((c) => <QueueRow key={c.id} campaign={c} />)
      )}
    </Card>
  );
}

function QueueRow({ campaign: c }: { campaign: Campaign }) {
  return (
    <div className="mk__queuerow">
      <div className="mk__queuetop">
        <span className="mk__queuetitle">{c.title}</span>
        <Pill tone={STATUS_TONE[c.status]}>{CAMPAIGN_STATUS_LABEL[c.status]}</Pill>
      </div>
      <div className="mk__queuemeta">
        {[
          c.when === 'recurring'
            ? 'Auto'
            : c.scheduledAt
              ? c.scheduledAt.replace('T', ' ').slice(0, 16)
              : 'On approval',
          { push: 'push', wa: 'WhatsApp', both: 'push + WhatsApp' }[c.channel],
          c.result ?? `${c.reach.toLocaleString('en-US')} people`,
        ].join(' · ')}
      </div>
      {/*
        AVO'S NOTE, VERBATIM. A rejection must carry one, and it is the only
        thing that tells the merchant what to change. Paraphrasing it here would
        turn a specific instruction into a shrug.
      */}
      {c.note ? <div className="mk__queuenote">AVO: {c.note}</div> : null}
    </div>
  );
}
