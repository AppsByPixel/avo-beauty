# Running four lanes — the daily operating manual

You are no longer the person writing most of the code. You are the person who decides what
gets built, whether it is actually done, and how four branches become one. That is a real
job and it is the one that fails if nobody does it.

---

## Two ways to run a lane, and when to use which

**Persistent sessions — the daily model.** You open a Claude Code session in each worktree
and keep it alive across days. Context accumulates: the wallet session remembers why the
balance is read the way it is. This is right for sustained work on one surface.

**Dispatched bursts.** One session hands four well-scoped, independent tasks to four
subagents at once, then integrates the results. The subagents do not persist — each starts
fresh and returns a summary. This is right for a defined chunk of parallel work, not for
multi-day work on a surface.

Use bursts to open a phase. Use persistent sessions to carry it.

---

## The daily rhythm

### Morning — dispatch (about 20 minutes)

```bash
cd ~/dev/avo && pnpm mock          # tab 1, leave it running
```

Then a session in each worktree:

```bash
cd ~/dev/avo-api      # Lane A
cd ~/dev/avo-wallet   # Lane B
cd ~/dev/avo-web      # Lane C
cd ~/dev/avo-qa       # Lane D
```

Give each lane **one day-sized slice**, not an hour-sized one. A lane that finishes in
forty minutes and sits idle is worse than one you scoped properly, because you are not
there to re-task it.

A good brief has four parts:

1. What to build, concretely
2. Which files it may touch — restate the one-writer rule
3. What "done" means, in terms you can check
4. **How to prove it** — run the thing, paste the output

That fourth part is the one that matters. See "Evidence" below.

### During the day — resist watching

You cannot review four streams at once. That is the actual constraint, not tokens.

- Review **one lane at a time**, when it reports back.
- Do not poll the others. They will tell you.
- When a lane asks a question about shared code, answer it yourself — that is a trunk
  decision and it belongs to you.

### Evening — the integration hour (30–45 minutes)

This is the ritual that makes the whole structure work. Skip it twice and you have four
branches nobody can merge.

```bash
cd ~/dev/avo
git checkout dev

# Merge one at a time, checking after each. Lane A first — the others
# may have built against a shape it changed.
git merge --no-ff feat/api -m "merge: lane A"
pnpm install && pnpm check          # STOP here if this fails
```

Repeat for `feat/qa`, `feat/wallet`, `feat/web`. **Check after every merge, not at the
end** — otherwise you know something broke but not which lane broke it.

Then run the guards on what landed:

```
/money-check         # on any diff touching api/
/perms-check         # when an endpoint or permission changed
/states-check        # naming the screen a lane just finished
```

Finally, push `dev` back out so tomorrow starts level:

```bash
for l in api wallet web qa; do
  git -C ~/dev/avo-$l rebase dev
done
```

---

## Evidence — the rule that keeps this honest

A lane reporting "done" is a claim, not a fact. Four parallel streams generate more claims
than you can personally verify, so build verification into the ask rather than doing it
afterwards.

Require, in the brief:

- **API work:** the actual command run and its real output. For a constraint, the SQL
  error text when it is violated.
- **UI work:** the screen loaded and seen — a screenshot, not a description.
- **Tests:** the pass/fail output, and evidence the test *can* fail. A test asserting
  nothing passes beautifully.

Then spot-check one claim per lane per day. Not all of them — one. Lanes that know you
check stay honest; checking everything makes you the bottleneck you were trying to avoid.

---

## Conflicts you will actually hit

### `pnpm-lock.yaml` — expect this on the first merge

Three lanes adding dependencies to the same lockfile. Do not hand-edit it. Take either
side and regenerate:

```bash
git checkout --theirs pnpm-lock.yaml
pnpm install
git add pnpm-lock.yaml
```

### Two lanes touched a shared package

This should not happen — the one-writer rule exists to prevent it. If it did, the lane
that broke the rule is wrong regardless of whose code is better. Revert that side, land
the change on `dev` yourself, and rebase both lanes.

### A lane needs a contract change

`packages/types` is trunk-owned. The correct sequence:

1. The lane **stops and reports** instead of editing.
2. You make the change on `dev`.
3. Every lane rebases.

A contract edit made inside one lane silently breaks three others, and you find out at the
merge — which is exactly when you have least time.

---

## When a lane finishes early or gets stuck

**Finished early:** give it the next slice from `LANES.md`, or have it write tests for what
it just built. Do not let it wander into another lane's column to stay busy.

**Stuck on another lane:** this is normal and it is what the mock is for. Lane B does not
wait for Lane A — it builds against `packages/mock`, which serves the same shapes. If a
lane is genuinely blocked on something the mock cannot fake, that is a signal the mock
needs extending, and that is trunk work.

**Wrong direction:** stop it early. Sunk cost on a branch is cheap — it is one `git reset`.
Sunk cost after a merge is not.

---

## The 30-day shape

Lane A is the long pole at roughly 18–20 days. Lanes B and C are shorter and will finish
their first passes sooner; when they do, they pick up the next surface rather than idling.

The lanes converge when Lane A's real API replaces the mock. That is the single biggest
integration moment in the build, and it is not a merge — it is a day. Plan for it, and do
it while there is still room to be wrong.

Lane D runs the whole way and gets more valuable as more lands.

---

## What not to do

- **Do not let lanes diverge for a week.** Daily merges are the cost of parallelism. Weekly
  merges are a rewrite.
- **Do not accept "done" without evidence.** See above.
- **Do not review four diffs at once.** One at a time, or you are rubber-stamping.
- **Do not fix another lane's bug from inside your lane.** Report it.
- **Do not add a fifth lane** because things feel fast. Four is already more than one
  person can review well.
