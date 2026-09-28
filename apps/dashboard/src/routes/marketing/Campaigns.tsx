import { useState } from 'react';
import type { Branch, Campaign, CampaignReward, RewardKey } from '@avo/types';
import {
  Button,
  Card,
  FilterBar,
  FilterChips,
  FilterEmpty,
  Pill,
  Segmented,
  Skeleton,
  TextField,
  type PillTone,
} from '@avo/ui';
import {
  AUDIENCES,
  CAMPAIGN_ADD_CUSTOM_LABEL,
  CAMPAIGN_REWARD_LABEL_MAX,
  CAMPAIGN_REWARDS,
  CAMPAIGN_STATUS_LABEL,
  CHANNELS,
  campaignRewardLabel,
  useAddCampaignReward,
  useCampaignRewards,
  useCampaigns,
  useRemoveCampaignReward,
  useSubmitCampaign,
  type CampaignDraft,
} from '../../api/promotions.js';
import { ApiError } from '../../api/client.js';
import { instantFromSalonLocal, salonLocalFields } from '../appointmentsWeekRules.js';
import { isForbidden, isUnauthenticated, SectionError, WriteError } from '../sectionState.js';
import { enumParam, useUrlFilters } from '../listFilters.js';

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
  /**
   * The salon's IANA zone. "Scheduled for" is a wall clock in it, and the queue
   * reads a scheduled instant back in it. `null` until the salon read lands.
   */
  timezone: string | null;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "SCHEDULED FOR" IS THE SALON'S WALL CLOCK, AND THE API TAKES AN INSTANT
 * ═══════════════════════════════════════════════════════════════════════════
 * A `datetime-local` value has no zone ("2026-09-30T10:00"), and it used to be
 * posted as it came. `POST /campaigns` does `new Date(raw)`, which reads a
 * zone-less string in the API PROCESS's zone — whatever the host happens to run.
 * On a UTC host a Kuwait merchant's 10:00 was scheduled for 13:00 Kuwait time,
 * and the queue row, which sliced the ISO instant (the UTC wall clock), read
 * "10:00" straight back to her: wrong at both ends and invisible from either.
 *
 * `appointmentsWeekRules.ts § instantFromSalonLocal` is the bridge
 * `AppointmentForm` already crosses for the same reason; this crosses it too.
 * A value it cannot convert — only an unusable zone does that to a well-formed
 * control value — goes as `''`, which the server refuses with its own sentence,
 * rather than as the zone-less string it would silently accept.
 */
export function scheduledInstant(value: string, timezone: string | null): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (!m || timezone === null) return '';
  return instantFromSalonLocal(m[1] ?? '', m[2] ?? '', timezone) ?? '';
}

/**
 * The queue row's "2026-09-30 10:00", in the salon's clock. It printed
 * `scheduledAt.replace('T', ' ').slice(0, 16)` — the UTC wall clock out of the
 * ISO string. Same shape now, read through `salonLocalFields`; an unusable zone
 * keeps the UTC reading and names it, per `salonTime.ts § clockFrame`.
 */
export function scheduledLabel(iso: string, timezone: string | null): string {
  const local = timezone === null ? null : salonLocalFields(iso, timezone);
  if (local) return `${local.date} ${local.time}`;
  return `${iso.replace('T', ' ').slice(0, 16)} UTC`;
}

const STATUS_TONE: Record<Campaign['status'], PillTone> = {
  pending: 'warn',
  approved: 'brand',
  sent: 'brand',
  rejected: 'danger',
};

const BODY_MAX = 140;
const TITLE_MAX = 42;

/**
 * What the reward `<select>` holds. A preset key or `none` as itself; one of her
 * saved rewards as `saved:<id>`; and the add option as a sentinel that is never a
 * reward. RewardKeys have no colon, so the three cannot collide.
 */
type RewardChoice = RewardKey | 'none' | `saved:${string}`;
const ADD_CUSTOM = '__add_custom';
const SAVED = 'saved:';

const savedId = (choice: RewardChoice): string | null =>
  choice.startsWith(SAVED) ? choice.slice(SAVED.length) : null;

/**
 * The submit body's reward, from the choice. A saved reward goes as
 * `reward: 'custom'` and its ID — never its words; the server resolves those.
 */
function rewardFields(choice: RewardChoice): Pick<CampaignDraft, 'reward' | 'customRewardId'> {
  const id = savedId(choice);
  return id === null ? { reward: choice as RewardKey | 'none' } : { reward: 'custom', customRewardId: id };
}

export function Campaigns({ branches, loading, timezone }: CampaignsProps) {
  const submit = useSubmitCampaign();
  const [audience, setAudience] = useState<Campaign['audience']>('all');
  const [branchId, setBranchId] = useState('all');
  const [channel, setChannel] = useState<Campaign['channel']>('push');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [chosenReward, setReward] = useState<RewardChoice>('none');
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [scheduledAt, setScheduledAt] = useState('');

  const savedRewards = useCampaignRewards();
  /*
   * A saved reward that has left her list (removed here, or by a colleague and
   * picked up on refetch) is no longer a choice, so the select falls back to "no
   * reward" rather than pointing at an option that is not drawn. Only once the
   * list has LOADED: while it is loading or failed, nothing saved is offered.
   */
  const chosenId = savedId(chosenReward);
  const reward: RewardChoice =
    chosenId !== null && !savedRewards.data?.some((r) => r.id === chosenId) ? 'none' : chosenReward;

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

        <RewardPicker value={reward} onChange={setReward} saved={savedRewards} />

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
                  ...rewardFields(reward),
                  when,
                  scheduledAt: when === 'later' ? scheduledInstant(scheduledAt, timezone) : '',
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
          {/*
            VERBATIM from AVO Merchant Dashboard.dc.html:1929, and it states two numbers
            that the owner console treats as CONFIGURABLE. Left exactly as written, with the
            conflict recorded rather than quietly resolved.

            api-contract.md § PlatformMessagingPolicy makes `quietFrom`/`quietTo` and
            `weeklyCapPerCustomer` (1..7) owner-settable, and the design's own console reads
            them as `policy.quietFrom || '22:00'` and `policy.weeklyCapPerCustomer || 2` — so
            22:00, 09:00 and "two" are DEFAULTS there and fixed facts here. The moment an
            owner moves either, this sentence becomes a false promise to a merchant about a
            promise she is in turn making to her customers.

            It cannot be fixed by fetching: the same contract says "a merchant can never read
            or raise these values", so no endpoint would make this truthful and inventing one
            would hand the merchant the platform throttle. Softening the wording would
            paraphrase settled copy, which CLAUDE.md forbids. So it needs Aftab.

            Worth knowing while reading it: NOTHING in api/src enforces any of these values
            today — `requireApproval`, `weeklyCapPerCustomer`, `monthlyCapPerSalon`,
            `quietFrom` and `quietTo` have zero occurrences there — so at present the
            sentence describes a rule no code applies, on top of naming numbers that are not
            fixed. Tracked in design/go-live-checklist.md under "caps and quiet hours
            enforced at send".
          */}
          <p className="mk__quiet">
            Quiet hours are respected — nothing leaves between 22:00 and 09:00. A person gets at
            most two marketing messages a week.
          </p>
        </Card>

        <Queue loading={loading} timezone={timezone} />
      </div>
    </div>
  );
}

/**
 * "Attach a reward": no reward, the presets, HER OWN saved rewards, and a last
 * option that writes a new one.
 *
 * Aftab: "the merchant should be able to add a custom option in the dropdown."
 * So the add lives IN the dropdown, as its last option, and choosing it opens a
 * field under the select rather than a dialog. Cancel puts the select back on
 * what it held before; Save stores the reward on the server and selects the row
 * the server returned.
 *
 * A saved reward is a LABEL. It moves no money and applies no earning effect —
 * the salon honours it at the counter — which is why happy hours, whose rewards
 * ARE applied to a charge, keep their closed list and never see this one.
 *
 * STATES. Loading: the presets are drawn and usable, and her own appear when they
 * arrive. Failed: the presets still work, with a quiet line and a retry under the
 * select. Empty: no "Your rewards" group at all.
 */
function RewardPicker({
  value,
  onChange,
  saved,
}: {
  value: RewardChoice;
  onChange: (next: RewardChoice) => void;
  saved: ReturnType<typeof useCampaignRewards>;
}) {
  const add = useAddCampaignReward();
  const remove = useRemoveCampaignReward();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');

  const items: CampaignReward[] = saved.data ?? [];
  const selectedId = savedId(value);
  const trimmed = label.trim();

  const cancel = () => {
    setAdding(false);
    setLabel('');
    add.reset();
  };

  return (
    <div className="mk__field">
      <label className="mk__rewardfield">
        <span className="avo-label">
          Attach a reward <span className="mk__optional">— optional</span>
        </span>
        <select
          className="avo-input"
          value={adding ? ADD_CUSTOM : value}
          onChange={(e) => {
            if (e.target.value === ADD_CUSTOM) {
              remove.reset();
              setAdding(true);
              return;
            }
            // Picking anything else closes the field, the same as Cancel would.
            if (adding) cancel();
            remove.reset();
            onChange(e.target.value as RewardChoice);
          }}
        >
          {CAMPAIGN_REWARDS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
          {items.length > 0 ? (
            <optgroup label="Your rewards">
              {items.map((r) => (
                <option key={r.id} value={`${SAVED}${r.id}`}>
                  {r.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          <option value={ADD_CUSTOM}>{CAMPAIGN_ADD_CUSTOM_LABEL}</option>
        </select>
      </label>

      {selectedId !== null && !adding ? (
        <div className="mk__rewardactions">
          <Button
            variant="quiet"
            disabled={remove.isPending}
            onClick={() => remove.mutate(selectedId, { onSuccess: () => onChange('none') })}
          >
            Remove from your list
          </Button>
        </div>
      ) : null}
      {remove.isError ? (
        <WriteError error={remove.error} reassurance="That reward is still on your list." />
      ) : null}

      {saved.isError ? <SavedRewardsError saved={saved} /> : null}

      {adding ? (
        <div className="mk__customreward">
          <TextField
            label="Your reward"
            placeholder="e.g. Free hair mask with any blow-dry"
            value={label}
            maxLength={CAMPAIGN_REWARD_LABEL_MAX}
            autoFocus
            onChange={(e) => setLabel(e.target.value)}
          />
          <span className="mk__count" aria-live="polite">
            {label.length} / {CAMPAIGN_REWARD_LABEL_MAX}
          </span>
          <div className="mk__rewardactions">
            <Button
              disabled={add.isPending || trimmed === ''}
              onClick={() =>
                add.mutate(trimmed, {
                  onSuccess: (row) => {
                    onChange(`${SAVED}${row.id}`);
                    setAdding(false);
                    setLabel('');
                  },
                })
              }
            >
              Save
            </Button>
            <Button variant="secondary" disabled={add.isPending} onClick={cancel}>
              Cancel
            </Button>
          </div>
          {/*
            THE SERVER'S SENTENCE, VERBATIM — "You already have a reward with that
            name.", "You can save up to 20 rewards. Remove one to add another." —
            because each names the fix, and a paraphrase would drop it.
          */}
          {add.isError ? <WriteError error={add.error} reassurance="No reward was added." /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Her saved rewards did not load. QUIET, because the select still works: every
 * preset is drawn and a campaign can be submitted with one. So this is one line
 * and a retry under the field, not a section error replacing it.
 *
 * A 403 is "you can't", not "we failed", and gets the server's own sentence and
 * no retry — interaction-spec.md §4. It should be unreachable (the same
 * permission gates the whole screen), and rendering it honestly costs nothing.
 */
function SavedRewardsError({ saved }: { saved: ReturnType<typeof useCampaignRewards> }) {
  if (isUnauthenticated(saved.error)) return null;
  if (isForbidden(saved.error)) {
    return (
      <p className="mk__rewardnote" role="alert">
        {(saved.error as ApiError).message}
      </p>
    );
  }
  return (
    <p className="mk__rewardnote" role="alert">
      Couldn&rsquo;t load your saved rewards.{' '}
      <Button variant="quiet" disabled={saved.isFetching} onClick={() => void saved.refetch()}>
        Try again
      </Button>
    </p>
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
const QUEUE_STATUSES = ['pending', 'approved', 'sent', 'rejected'] as const;
const QUEUE_FILTERS = { status: enumParam(QUEUE_STATUSES) } as const;
const QUEUE_CHIPS = [
  { value: '', label: 'All' },
  ...QUEUE_STATUSES.map((value) => ({ value, label: CAMPAIGN_STATUS_LABEL[value] })),
];

function Queue({ loading, timezone }: { loading: boolean; timezone: string | null }) {
  const url = useUrlFilters(QUEUE_FILTERS);
  const status = (url.values.status || null) as Campaign['status'] | null;
  const campaigns = useCampaigns(status);
  const missing = campaigns.error instanceof ApiError && campaigns.error.status === 404;
  const items = campaigns.data?.items ?? [];

  return (
    <Card>
      <h2 className="mk__cardtitle">Queue &amp; sends</h2>
      <p className="mk__cardsub">
        Every campaign is reviewed by AVO before it reaches a phone.
      </p>

      {/*
        The status goes to the server — see `useCampaigns`. No search: a queue
        of a salon's own few campaigns is read by status, and the brief asks for
        status alone here.
      */}
      <FilterBar
        label="Filter campaigns"
        className="avo-filterbar--inset"
        count={
          loading || campaigns.isPending || campaigns.isError || status === null
            ? null
            : `${items.length} ${items.length === 1 ? 'campaign' : 'campaigns'}`
        }
        onClear={status !== null ? () => url.clear() : undefined}
      >
        <FilterChips
          label="Status"
          options={QUEUE_CHIPS}
          value={status ?? ''}
          onChange={(next) => url.set({ status: next })}
        />
      </FilterBar>

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
      ) : items.length === 0 && status !== null ? (
        <FilterEmpty things="campaigns" onClear={() => url.clear()} />
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
        items.map((c) => <QueueRow key={c.id} campaign={c} timezone={timezone} />)
      )}
    </Card>
  );
}

function QueueRow({ campaign: c, timezone }: { campaign: Campaign; timezone: string | null }) {
  /*
   * THE REWARD, AS SHE ATTACHED IT. A custom one is the server's snapshot of her
   * words at submission, verbatim — so removing it from her list later does not
   * rewrite what this row says AVO was asked to approve.
   */
  const reward = campaignRewardLabel(c);
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
              ? scheduledLabel(c.scheduledAt, timezone)
              : 'On approval',
          { push: 'push', wa: 'WhatsApp', both: 'push + WhatsApp' }[c.channel],
          c.result ?? `${c.reach.toLocaleString('en-US')} people`,
          ...(reward !== null ? [reward] : []),
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
